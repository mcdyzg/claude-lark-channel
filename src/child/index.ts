import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeClient } from './bridge-client.js';
import { registerChildTools } from './tools.js';

export async function startChild(): Promise<void> {
  const scopeKey = process.env.LARK_CHANNEL_SCOPE_KEY ?? '';
  const scopeId = process.env.LARK_CHANNEL_SCOPE_ID ?? '';
  const sock = process.env.LARK_CHANNEL_SOCK ?? '';
  const rpcTimeoutMs = parseInt(process.env.LARK_CHANNEL_RPC_TIMEOUT_MS ?? '60000', 10);

  if (!scopeKey || !scopeId || !sock) {
    console.error(
      `[child] missing env: SCOPE_KEY=${scopeKey} SCOPE_ID=${scopeId} SOCK=${sock}`,
    );
    process.exit(1);
  }
  console.error(`[child] starting scope=${scopeKey} id=${scopeId}`);

  const server = new McpServer(
    { name: 'claude-lark-channel', version: '0.1.0' },
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
  });

  bridge.setPushHandler((content, meta) => {
    server.server.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    }).catch((err) => {
      console.error('[child] failed to forward channel notification:', err);
    });
  });

  registerChildTools(server, bridge);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[child] MCP connected; connecting bridge...');
  bridge.start();
}
