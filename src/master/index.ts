import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as Lark from '@larksuiteoapi/node-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig, validateMasterConfig } from '../shared/config.js';
import { SessionStore } from '../shared/session-store.js';
import { tryAcquireLock } from '../shared/lock.js';
import { resolveScopeKey } from '../shared/scope.js';
import {
  createFeishuClient,
  createFeishuWSClient,
  fetchBotOpenId,
  fetchThreadRoot,
  fetchChatHistory,
  fetchMessage,
} from './feishu-client.js';
import { extractPlainText, extractAttachments, extractImageKeys } from './message-parser.js';
import { Dedup } from './dedup.js';
import { passesWhitelist } from './whitelist.js';
import { doReply, sendAckReaction, revokeReaction, type ReplyParams } from './reply.js';
import { downloadAttachment } from './attachment.js';
import { BridgeServer, type ChildConn } from './bridge-server.js';
import { TmuxPool } from './pool.js';
import {
  resolveThreadBackground,
  resolveChatHistoryBackground,
} from './bootstrap.js';
import { createRootLogger } from '../shared/logger.js';

const CHAT_HISTORY_LIMIT = 20;

export async function startMaster(): Promise<void> {
  const cfg = loadConfig();
  const errors = validateMasterConfig(cfg);
  if (errors.length > 0) {
    console.error('[master] config errors:\n  - ' + errors.join('\n  - '));
    console.error('[master] run /lark-channel:configure setup to configure');
    process.exit(1);
  }

  // 预检工具依赖
  assertToolExists('tmux', '-V');
  assertToolExists('jq', '--version');
  assertToolExists('claude', '--version');
  fs.mkdirSync(cfg.storeDir, { recursive: true });
  fs.mkdirSync(cfg.inboxDir, { recursive: true });
  fs.mkdirSync(cfg.logsDir, { recursive: true });

  // 单 master 进程锁
  const lockPath = path.join(cfg.storeDir, `master-${cfg.appId}.lock`);
  const got = await tryAcquireLock(lockPath);
  if (!got) {
    console.error('[master] another master is running; exiting');
    process.exit(0);
  }

  // 根 logger：debug=false 时完全静默；debug=true 时写 <logsDir>/debug.log
  const rootLogger = createRootLogger('master', cfg.logsDir, cfg.debug);
  rootLogger.info(`startMaster pid=${process.pid} storeDir=${cfg.storeDir} scopeMode=${cfg.scopeMode} debug=${cfg.debug}`);

  // MCP transport 对接宿主 Claude（不暴露任何工具，仅保持 stdio 连通）
  const mcpServer = new McpServer(
    { name: 'claude-lark-channel-master', version: '0.1.0' },
    {
      capabilities: { logging: {} },
      instructions: 'claude-lark-channel master: inbound Feishu messages are forwarded to per-scope Claude sessions via tmux. This instance exposes no tools.',
    },
  );
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  rootLogger.info('MCP stdio connected to host Claude');

  // 核心服务
  const store = new SessionStore(cfg.sessionsDir);
  const client = createFeishuClient(cfg);
  const dedup = new Dedup(cfg.dedupTtlMs);
  const ackReactions = new Map<string, string>();       // messageId → reactionId
  const latestMessageByChatThread = new Map<string, { messageId: string; ts: number }>();

  const bridge = new BridgeServer(
    cfg.socketPath,
    async (method, params, _scopeKey) => {
      if (method === 'reply') {
        const p = params as ReplyParams;
        // 自动从最新消息追踪器填充 reply_to（如未指定）
        if (!p.reply_to) {
          const key = `${p.chat_id}::${p.thread_id ?? '_'}`;
          const latest = latestMessageByChatThread.get(key);
          if (latest) p.reply_to = latest.messageId;
        }
        const result = await doReply(client, p);
        // 尽力撤销原始入站消息的 ack 反应
        if (p.reply_to) {
          const rid = ackReactions.get(p.reply_to);
          if (rid) {
            void revokeReaction(client, p.reply_to, rid);
            ackReactions.delete(p.reply_to);
          }
        }
        return result;
      }
      if (method === 'download_attachment') {
        const p = params as { message_id: string; file_key: string; kind: 'image' | 'file' | 'audio' | 'video' };
        return downloadAttachment(client, p.message_id, p.file_key, p.kind, cfg.inboxDir);
      }
      throw new Error(`unknown rpc method: ${method}`);
    },
    rootLogger.child('bridge'),
    (conn: ChildConn) => pool.markChildConnected(conn),
    (scopeKey: string) => pool.markChildDisconnected(scopeKey),
  );
  await bridge.start();

  const pool = new TmuxPool({
    config: cfg,
    store,
    bridge,
    pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? '',
    logger: rootLogger.child('pool'),
  });
  pool.start();

  // Feishu WS 连接
  const wsClient = createFeishuWSClient(cfg);
  const botOpenId = await fetchBotOpenId(client);
  rootLogger.info(`Feishu bot open_id=${botOpenId || '(unknown)'}`);

  const inboundLog = rootLogger.child('inbound');

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      try {
        await handleInbound(data);
      } catch (err: any) {
        inboundLog.error(`handler error: ${err?.message ?? err}`);
      }
    },
  });

  async function handleInbound(data: any): Promise<void> {
    const { message, sender } = data;
    if (!message) {
      inboundLog.warn(`event has no message field; ignoring`);
      return;
    }
    const messageId: string = message.message_id ?? '';
    const chatId: string = message.chat_id ?? '';
    const chatType: string = message.chat_type ?? '';
    const rawContent: string = message.content ?? '';
    const messageType: string = message.message_type ?? message.msg_type ?? 'text';
    const threadId: string | undefined = message.root_id || undefined;
    const parentId: string | undefined = message.parent_id || undefined;
    const mentions: any[] = message.mentions ?? [];
    const senderId: string = sender?.sender_id?.open_id ?? '';

    inboundLog.info(`event messageId=${messageId} chat=${chatId} chatType=${chatType} type=${messageType} sender=${senderId} threadId=${threadId ?? '-'} mentions=${mentions.length} contentLen=${rawContent.length}`);

    if (!messageId || !chatId || !senderId) {
      inboundLog.warn(`drop: missing required id(s) messageId=${messageId} chat=${chatId} sender=${senderId}`);
      return;
    }
    if (senderId === botOpenId) {
      inboundLog.debug(`drop: bot's own message`);
      return;
    }
    if (dedup.seen(messageId)) {
      inboundLog.debug(`drop: duplicate messageId=${messageId}`);
      return;
    }

    if (!passesWhitelist(senderId, chatId, cfg.allowedUserIds, cfg.allowedChatIds)) {
      inboundLog.info(`drop: whitelist user=${senderId} chat=${chatId}`);
      return;
    }
    // 群聊：要求 @bot 提及
    if (chatType === 'group') {
      if (!botOpenId) {
        inboundLog.warn(`group message accepted despite no botOpenId (cannot verify @mention)`);
      } else {
        const botMentioned = mentions.some(
          (m: any) => (m.id?.open_id ?? m.id?.union_id) === botOpenId,
        );
        if (!botMentioned) {
          inboundLog.debug(`drop: group message without @bot mentions=${mentions.length}`);
          return;
        }
      }
    }

    // 记录最新消息追踪器
    const trackerKey = `${chatId}::${threadId ?? '_'}`;
    latestMessageByChatThread.set(trackerKey, { messageId, ts: Date.now() });

    // Ack 反应（fire and forget）
    const ackEmoji = chatType === 'p2p' ? 'Typing' : cfg.ackEmoji;
    if (ackEmoji) {
      sendAckReaction(client, messageId, ackEmoji).then((rid) => {
        if (rid) ackReactions.set(messageId, rid);
      }).catch(() => {});
    }

    // 解析文本
    const text = extractPlainText(messageType, rawContent);
    const attachments = extractAttachments({ message_type: messageType, content: rawContent });

    // 同步下载本消息的图片到 inbox
    let imagePath: string | undefined;
    let imagePaths: string[] | undefined;
    {
      const ownImageKeys = extractImageKeys(messageType, rawContent);
      const downloaded: string[] = [];
      for (const key of ownImageKeys) {
        try {
          const d = await downloadAttachment(client, messageId, key, 'image', cfg.inboxDir);
          downloaded.push(d.path);
        } catch (err: any) {
          inboundLog.warn(`own image download failed key=${key} err=${err?.message ?? err}`);
        }
      }
      if (downloaded.length === 1) imagePath = downloaded[0];
      else if (downloaded.length > 1) imagePaths = downloaded;
    }

    // 解析 scope
    const scopeKey = resolveScopeKey({ chatId, threadId }, cfg.scopeMode);
    inboundLog.info(`scope resolved scopeKey=${scopeKey} mode=${cfg.scopeMode}`);

    // 确保 tmux + child 就绪
    const entry = await pool.ensure(scopeKey);
    if (!entry) {
      inboundLog.error(`pool.ensure failed scope=${scopeKey} — channel cannot deliver`);
      return;
    }
    pool.incMsg(scopeKey);
    inboundLog.debug(`pool.ensure OK tmux=${entry.tmuxSession}`);

    // 加载（并可能初始化背景信息的）会话
    const session = store.getByScopeKey(scopeKey);
    if (!session) {
      inboundLog.error(`missing session after ensure scope=${scopeKey}`);
      return;
    }

    if (!session.rootInjected) {
      inboundLog.info(`first message for scope=${scopeKey}; fetching background...`);
      let threadBg: Awaited<ReturnType<typeof resolveThreadBackground>> = null;
      let chatBgText: string | null = null;
      let rootMessageId: string | null = null;

      if (cfg.scopeMode === 'thread' && threadId) {
        // 记下 root 的 messageId 供后续下载图片使用
        threadBg = await resolveThreadBackground(
          { chatId, threadId, messageId },
          cfg.scopeMode,
          async (tid) => {
            const root = await fetchThreadRoot(client, tid);
            if (root) rootMessageId = root.messageId;
            return root;
          },
        );
      } else {
        chatBgText = await resolveChatHistoryBackground(
          chatId,
          (cid, limit) => fetchChatHistory(client, cid, limit),
          { limit: CHAT_HISTORY_LIMIT, selfOpenId: botOpenId },
        );
      }
      session.rootInjected = true;
      store.save(session);

      if (threadBg) {
        // 下载 root 里附带的图片
        const rootImagePaths: string[] = [];
        if (rootMessageId && threadBg.imageKeys.length > 0) {
          for (const key of threadBg.imageKeys) {
            try {
              const d = await downloadAttachment(client, rootMessageId, key, 'image', cfg.inboxDir);
              rootImagePaths.push(d.path);
            } catch (err: any) {
              inboundLog.warn(`root image download failed key=${key} err=${err?.message ?? err}`);
            }
          }
        }
        const bgMeta: Record<string, unknown> = {
          kind: 'background',
          scope_key: scopeKey,
        };
        if (rootImagePaths.length === 1) bgMeta.image_path = rootImagePaths[0];
        else if (rootImagePaths.length > 1) bgMeta.image_paths = rootImagePaths.join(',');
        inboundLog.info(`pushing thread background len=${threadBg.text.length} rootImages=${rootImagePaths.length} scope=${scopeKey}`);
        bridge.push(scopeKey, threadBg.text, bgMeta);
      } else if (chatBgText) {
        inboundLog.info(`pushing chat history background len=${chatBgText.length} scope=${scopeKey}`);
        bridge.push(scopeKey, chatBgText, { kind: 'background', scope_key: scopeKey });
      } else {
        inboundLog.info(`no background available scope=${scopeKey}`);
      }
    }

    // 若事件带 parent_id（引用回复），拉 parent 消息的文本 + 图片，
    // 作为 meta 里的 parent_* 字段传给 Claude
    let parentContent: string | null = null;
    let parentImagePath: string | undefined;
    let parentImagePaths: string[] | undefined;
    let parentMessageIdResolved: string | undefined;
    if (parentId) {
      inboundLog.info(`fetching parent messageId=${parentId}`);
      const parent = await fetchMessage(client, parentId);
      if (parent) {
        parentMessageIdResolved = parent.messageId;
        parentContent = parent.text;
        if (parent.imageKeys.length > 0) {
          const downloaded: string[] = [];
          for (const key of parent.imageKeys) {
            try {
              const d = await downloadAttachment(client, parent.messageId, key, 'image', cfg.inboxDir);
              downloaded.push(d.path);
            } catch (err: any) {
              inboundLog.warn(`parent image download failed key=${key} err=${err?.message ?? err}`);
            }
          }
          if (downloaded.length === 1) parentImagePath = downloaded[0];
          else if (downloaded.length > 1) parentImagePaths = downloaded;
        }
        inboundLog.info(`parent resolved textLen=${parentContent.length} imageCount=${parent.imageKeys.length} downloaded=${(parentImagePaths?.length ?? (parentImagePath ? 1 : 0))}`);
      } else {
        inboundLog.warn(`fetchMessage returned null for parent messageId=${parentId}`);
      }
    }

    // 构建 meta 并推送
    const meta: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      user_id: senderId,
      chat_type: chatType,
      scope_key: scopeKey,
      ts: new Date().toISOString(),
    };
    if (threadId) meta.thread_id = threadId;
    if (imagePath) meta.image_path = imagePath;
    if (imagePaths?.length) meta.image_paths = imagePaths.join(',');
    if (attachments.length === 1 && attachments[0].fileType !== 'image') {
      meta.attachment_kind = attachments[0].fileType;
      meta.attachment_file_id = attachments[0].fileKey;
      meta.attachment_name = attachments[0].fileName;
    }
    if (parentMessageIdResolved) {
      meta.parent_message_id = parentMessageIdResolved;
      meta.parent_content = parentContent ?? '';
      if (parentImagePath) meta.parent_image_path = parentImagePath;
      if (parentImagePaths?.length) meta.parent_image_paths = parentImagePaths.join(',');
    }

    session.lastUserInput = text;
    store.save(session);

    const pushed = bridge.push(scopeKey, text, meta);
    inboundLog.info(`push result=${pushed ? 'OK' : 'FAILED'} scope=${scopeKey} textLen=${text.length} imagePath=${imagePath ?? '-'} imagePaths=${imagePaths?.length ?? 0} parentImages=${(parentImagePaths?.length ?? (parentImagePath ? 1 : 0))} attachments=${attachments.length}`);
  }

  wsClient.start({ eventDispatcher: dispatcher });
  rootLogger.info(`Feishu WS started`);

  // 生命周期管理
  const shutdown = async () => {
    rootLogger.info('shutdown begin');
    await pool.stop();
    await bridge.stop();
    try { (wsClient as any).close?.(); } catch {/* ignore */}
    rootLogger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('close', shutdown as any);
  process.stdin.on('end', shutdown as any);
}

function assertToolExists(tool: string, ...probeArgs: string[]): void {
  // ESM 模块无 require；用 createRequire 保持 helper 自闭合，同时不在顶层 spawn
  const req = createRequire(import.meta.url);
  const { spawnSync } = req('node:child_process') as typeof import('node:child_process');
  const res = spawnSync(tool, probeArgs, { stdio: 'ignore' });
  if (res.status !== 0) {
    console.error(`[master] required tool not found or not runnable: ${tool}`);
    if (tool === 'tmux') console.error('  install: brew install tmux (need >=3.2)');
    if (tool === 'jq') console.error('  install: brew install jq');
    if (tool === 'claude') console.error('  install: https://docs.claude.com/en/docs/claude-code/install');
    process.exit(1);
  }
}
