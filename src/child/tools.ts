import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BridgeClient } from './bridge-client.js';

export interface ReplyResultData {
  messageIds: string[];
  durationMs: number;
}

export interface DownloadResultData {
  path: string;
  size: number;
  filename: string;
}

export function registerChildTools(server: McpServer, bridge: BridgeClient): void {
  server.registerTool(
    'reply',
    {
      description:
        'Reply to the Feishu chat that sent the current channel message. Text auto-rendered as card when long or markdown-heavy.',
      inputSchema: z.object({
        chat_id: z.string().describe('chat_id from the channel meta'),
        text: z.string().describe('Reply text (markdown allowed)'),
        card: z.string().optional().describe('Pre-built Schema 2.0 card JSON; overrides text if provided'),
        reply_to: z.string().optional().describe('Message id to quote-reply; auto-filled by master if omitted'),
        thread_id: z.string().optional().describe('Thread id from channel meta, when applicable'),
        format: z.enum(['text', 'card']).optional(),
        footer: z.string().optional().describe('Small footnote at the bottom of the card'),
      }),
    },
    async (params) => {
      try {
        const data = await bridge.rpc<ReplyResultData>('reply', params);
        return {
          content: [{
            type: 'text' as const,
            text: `Reply sent: message_ids=${data.messageIds.join(',')} in ${data.durationMs}ms`,
          }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `reply failed: ${err?.message ?? String(err)}` }],
        };
      }
    },
  );

  server.registerTool(
    'download_attachment',
    {
      description:
        'Download a Feishu file/audio/video/image attachment to the local inbox and return the absolute path.',
      inputSchema: z.object({
        message_id: z.string().describe('message_id from channel meta'),
        file_key: z.string().describe('attachment_file_id from channel meta'),
        kind: z.enum(['file', 'audio', 'video', 'image']),
      }),
    },
    async (params) => {
      try {
        const data = await bridge.rpc<DownloadResultData>('download_attachment', params);
        return {
          content: [{
            type: 'text' as const,
            text: `Downloaded to ${data.path} (${data.size} bytes, filename=${data.filename})`,
          }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `download failed: ${err?.message ?? String(err)}` }],
        };
      }
    },
  );
}
