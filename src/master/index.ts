import fs from 'node:fs';
import path from 'node:path';
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
} from './feishu-client.js';
import { extractPlainText, extractAttachments } from './message-parser.js';
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
  assertToolExists('tmux', '--version');
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
  console.error('[master] MCP connected (host)');

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
    (conn: ChildConn) => pool.markChildConnected(conn),
    (scopeKey: string) => pool.markChildDisconnected(scopeKey),
  );
  await bridge.start();
  console.error(`[master] bridge listening at ${cfg.socketPath}`);

  const pool = new TmuxPool({ config: cfg, store, bridge, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? '' });
  pool.start();

  // Feishu WS 连接
  const wsClient = createFeishuWSClient(cfg);
  const botOpenId = await fetchBotOpenId(client);
  console.error(`[master] bot open_id=${botOpenId || '(unknown)'}`);

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      try {
        await handleInbound(data);
      } catch (err) {
        console.error('[master] handler error:', err);
      }
    },
  });

  async function handleInbound(data: any): Promise<void> {
    const { message, sender } = data;
    if (!message) return;
    const messageId: string = message.message_id ?? '';
    const chatId: string = message.chat_id ?? '';
    const chatType: string = message.chat_type ?? '';
    const rawContent: string = message.content ?? '';
    const messageType: string = message.message_type ?? message.msg_type ?? 'text';
    const threadId: string | undefined = message.root_id || undefined;
    const mentions: any[] = message.mentions ?? [];
    const senderId: string = sender?.sender_id?.open_id ?? '';

    if (!messageId || !chatId || !senderId) return;
    if (senderId === botOpenId) return;
    if (dedup.seen(messageId)) return;

    if (!passesWhitelist(senderId, chatId, cfg.allowedUserIds, cfg.allowedChatIds)) {
      console.error(`[master] whitelist drop user=${senderId} chat=${chatId}`);
      return;
    }
    // 群聊：要求 @bot 提及
    if (chatType === 'group') {
      if (!botOpenId) { /* without botOpenId, accept any mention */ }
      else {
        const botMentioned = mentions.some(
          (m: any) => (m.id?.open_id ?? m.id?.union_id) === botOpenId,
        );
        if (!botMentioned) return;
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

    // 同步下载图片到 inbox
    let imagePath: string | undefined;
    let imagePaths: string[] | undefined;
    if (messageType === 'image') {
      try {
        const parsed = JSON.parse(rawContent);
        if (parsed.image_key) {
          const d = await downloadAttachment(client, messageId, parsed.image_key, 'image', cfg.inboxDir);
          imagePath = d.path;
        }
      } catch {/* ignore */}
    } else if (messageType === 'post') {
      try {
        const parsed = JSON.parse(rawContent);
        const content = parsed.content ?? parsed.zh_cn?.content ?? parsed.en_us?.content ?? [];
        const downloaded: string[] = [];
        for (const line of content) {
          for (const node of line as any[]) {
            if (node.tag === 'img' && node.image_key) {
              const d = await downloadAttachment(client, messageId, node.image_key, 'image', cfg.inboxDir);
              downloaded.push(d.path);
            }
          }
        }
        if (downloaded.length === 1) imagePath = downloaded[0];
        else if (downloaded.length > 1) imagePaths = downloaded;
      } catch {/* ignore */}
    }

    // 解析 scope
    const scopeKey = resolveScopeKey({ chatId, threadId }, cfg.scopeMode);

    // 确保 tmux + child 就绪
    const entry = await pool.ensure(scopeKey);
    if (!entry) {
      console.error(`[master] pool.ensure failed for scope=${scopeKey}`);
      return;
    }
    pool.incMsg(scopeKey);

    // 加载（并可能初始化背景信息的）会话
    const session = store.getByScopeKey(scopeKey);
    if (!session) {
      console.error(`[master] missing session for scope=${scopeKey} after ensure`);
      return;
    }

    if (!session.rootInjected) {
      let background: string | null = null;
      if (cfg.scopeMode === 'thread' && threadId) {
        background = await resolveThreadBackground(
          { chatId, threadId, messageId },
          cfg.scopeMode,
          (tid) => fetchThreadRoot(client, tid),
        );
      } else {
        background = await resolveChatHistoryBackground(
          chatId,
          (cid, limit) => fetchChatHistory(client, cid, limit),
          { limit: CHAT_HISTORY_LIMIT, selfOpenId: botOpenId },
        );
      }
      session.rootInjected = true;
      store.save(session);
      if (background) {
        bridge.push(scopeKey, background, { kind: 'background', scope_key: scopeKey });
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

    session.lastUserInput = text;
    store.save(session);

    bridge.push(scopeKey, text, meta);
    console.error(`[master] pushed scope=${scopeKey} len=${text.length}`);
  }

  wsClient.start({ eventDispatcher: dispatcher });

  // 生命周期管理
  const shutdown = async () => {
    console.error('[master] shutting down');
    await pool.stop();
    await bridge.stop();
    try { (wsClient as any).close?.(); } catch {/* ignore */}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('close', shutdown as any);
  process.stdin.on('end', shutdown as any);
}

function assertToolExists(tool: string, ...probeArgs: string[]): void {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const res = spawnSync(tool, probeArgs, { stdio: 'ignore' });
  if (res.status !== 0) {
    console.error(`[master] required tool not found or not runnable: ${tool}`);
    if (tool === 'tmux') console.error('  install: brew install tmux (need >=3.2)');
    if (tool === 'jq') console.error('  install: brew install jq');
    if (tool === 'claude') console.error('  install: https://docs.claude.com/en/docs/claude-code/install');
    process.exit(1);
  }
}
