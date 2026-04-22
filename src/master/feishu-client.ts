import * as Lark from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../shared/config.js';

export function createFeishuClient(cfg: AppConfig): Lark.Client {
  const sdkLogger = {
    info:  (...a: unknown[]) => console.error('[lark-sdk]', ...a),
    warn:  (...a: unknown[]) => console.error('[lark-sdk][warn]', ...a),
    error: (...a: unknown[]) => console.error('[lark-sdk][error]', ...a),
    debug: (...a: unknown[]) => console.error('[lark-sdk][debug]', ...a),
    trace: (...a: unknown[]) => console.error('[lark-sdk][trace]', ...a),
  };
  return new Lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: cfg.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    logger: sdkLogger,
  });
}

export function createFeishuWSClient(cfg: AppConfig): Lark.WSClient {
  return new Lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
    logger: {
      info:  (...a: unknown[]) => console.error('[lark-ws]', ...a),
      warn:  (...a: unknown[]) => console.error('[lark-ws][warn]', ...a),
      error: (...a: unknown[]) => console.error('[lark-ws][error]', ...a),
      debug: (...a: unknown[]) => console.error('[lark-ws][debug]', ...a),
      trace: (...a: unknown[]) => console.error('[lark-ws][trace]', ...a),
    },
  });
}

/** Fetch bot's own open_id — used to filter group @mentions. */
export async function fetchBotOpenId(client: Lark.Client): Promise<string> {
  try {
    const resp: any = await client.request({
      method: 'GET',
      url: 'https://open.feishu.cn/open-apis/bot/v3/info',
    });
    return resp?.bot?.open_id ?? resp?.data?.bot?.open_id ?? '';
  } catch (err) {
    console.error('[feishu] fetchBotOpenId failed:', err);
    return '';
  }
}

/** Fetch the first message of a thread (the root). */
export async function fetchThreadRoot(
  client: Lark.Client,
  threadId: string,
): Promise<{ messageId: string; text: string; createTime: number } | null> {
  if (!threadId) return null;
  try {
    const resp: any = await client.im.message.list({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        sort_type: 'ByCreateTimeAsc',
        page_size: 1,
      },
    });
    const items = resp?.data?.items ?? [];
    if (items.length === 0) return null;
    const root = items[0];
    const msgType = root.msg_type ?? 'text';
    const raw = root.body?.content ?? '';
    const { extractPlainText } = await import('./message-parser.js');
    const text = extractPlainText(msgType, raw);
    return {
      messageId: root.message_id ?? '',
      text,
      createTime: root.create_time ? parseInt(String(root.create_time), 10) : Date.now(),
    };
  } catch (err) {
    console.error('[feishu] fetchThreadRoot failed:', err);
    return null;
  }
}

/** Fetch recent messages in a chat, oldest first. */
export async function fetchChatHistory(
  client: Lark.Client,
  chatId: string,
  limit: number,
): Promise<Array<{ senderId: string; senderName: string; text: string; createTime: number }>> {
  if (!chatId) return [];
  try {
    const resp: any = await client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        sort_type: 'ByCreateTimeDesc',
        page_size: limit,
      },
    });
    const items: any[] = resp?.data?.items ?? [];
    const { extractPlainText } = await import('./message-parser.js');
    return items.reverse().map((m: any) => ({
      senderId: m.sender?.id ?? '',
      senderName: m.sender?.id ?? '',
      text: extractPlainText(m.msg_type ?? 'text', m.body?.content ?? ''),
      createTime: m.create_time ? parseInt(String(m.create_time), 10) : 0,
    }));
  } catch (err) {
    console.error('[feishu] fetchChatHistory failed:', err);
    return [];
  }
}
