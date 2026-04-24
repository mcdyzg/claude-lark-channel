import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeClient } from './bridge-client.js';
import { registerChildTools } from './tools.js';
import { createRootLogger } from '../shared/logger.js';

export async function startChild(): Promise<void> {
  const scopeKey = process.env.LARK_CHANNEL_SCOPE_KEY ?? '';
  const scopeId = process.env.LARK_CHANNEL_SCOPE_ID ?? '';
  const sock = process.env.LARK_CHANNEL_SOCK ?? '';
  const store = process.env.LARK_CHANNEL_STORE
    ?? path.join(os.homedir(), '.claude', 'channels', 'lark-channel');
  const rpcTimeoutMs = parseInt(process.env.LARK_CHANNEL_RPC_TIMEOUT_MS ?? '60000', 10);
  const debug = process.env.LARK_CHANNEL_DEBUG === '1';

  const logsDir = path.join(store, 'logs');
  const logger = createRootLogger(`child[${scopeKey}]`, logsDir, debug);

  if (!scopeKey || !scopeId || !sock) {
    logger.error(`missing env: SCOPE_KEY=${scopeKey} SCOPE_ID=${scopeId} SOCK=${sock}`);
    // 关键路径错误：即使 debug=off 也写 stderr（容器外可能被 MCP 宿主捕获）
    if (!debug) console.error(`[child] missing env: SCOPE_KEY=${scopeKey} SCOPE_ID=${scopeId} SOCK=${sock}`);
    process.exit(1);
  }
  logger.info(`starting scope=${scopeKey} scopeId=${scopeId} sock=${sock} debug=${debug}`);

  const server = new McpServer(
    { name: 'claude-lark-channel', version: '0.1.2' },
    {
      capabilities: {
        logging: {},
        experimental: { 'claude/channel': {} },
      },
      instructions:
        'This plugin bridges Feishu/Lark messages into this Claude session. ' +
        'Inbound user messages arrive as `notifications/claude/channel`. ' +
        'Use the `reply` tool to send responses back to Feishu. ' +
        'Use `download_attachment` for files/audio/video referenced by `attachment_file_id` in the channel meta. ' +
        'Images arrive already downloaded — their path is in `image_path` / `image_paths` meta.',
    },
  );

  const bridge = new BridgeClient({
    socketPath: sock,
    scopeKey,
    scopeId,
    rpcTimeoutMs,
    logger: logger.child('bridge'),
  });

  bridge.setPushHandler((content, meta) => {
    logger.info(`pushHandler invoked contentLen=${content.length} metaKeys=[${Object.keys(meta).join(',')}]`);
    server.server.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    }).then(() => {
      logger.info(`notification emitted to MCP client OK`);
    }).catch((err) => {
      logger.error(`notification emit FAILED: ${err?.message ?? err}`);
    });
  });

  registerChildTools(server, bridge);
  logger.debug(`MCP tools registered: reply, download_attachment`);

  // 关键时序：延迟 bridge.start() 到 MCP `initialized` 完成。否则若 master 在
  // 握手结束前就推送 channel_push，server.notification(...) 会被 MCP SDK 按
  // 协议静默丢弃。
  let bridgeStarted = false;
  server.server.oninitialized = () => {
    if (bridgeStarted) return;
    bridgeStarted = true;
    logger.info(`MCP client sent 'initialized' → starting bridge to master`);
    bridge.start();
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`MCP stdio transport connected; awaiting MCP client 'initialized' handshake...`);

  // 兜底：若 30s 后 oninitialized 仍未触发，强行启动 bridge 并告警（至少
  // 保留 RPC 能力；channel 可能无法工作）。目的只是避免完全静默。
  setTimeout(() => {
    if (!bridgeStarted) {
      bridgeStarted = true;
      logger.error(`oninitialized NOT fired within 30s; starting bridge anyway. channel_push notifications may be dropped by MCP client.`);
      bridge.start();
    }
  }, 30_000);
}
