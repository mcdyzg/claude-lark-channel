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

export interface ThreadRoot {
  messageId: string;
  text: string;
  imageKeys: string[];
  createTime: number;
}

/** Fetch the first message of a thread (the root). */
export async function fetchThreadRoot(
  client: Lark.Client,
  threadId: string,
): Promise<ThreadRoot | null> {
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
    const { extractPlainText, extractImageKeys } = await import('./message-parser.js');
    const text = extractPlainText(msgType, raw);
    const imageKeys = extractImageKeys(msgType, raw);
    const createTime = root.create_time ? parseInt(String(root.create_time), 10) : Date.now();
    return {
      messageId: root.message_id ?? '',
      text,
      imageKeys,
      createTime: Number.isFinite(createTime) ? createTime : Date.now(),
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
    return items.reverse().map((m: any) => {
      const sid = m.sender?.id ?? '';
      return {
        senderId: sid,
        senderName: displayAlias(sid),
        text: extractPlainText(m.msg_type ?? 'text', m.body?.content ?? ''),
        createTime: m.create_time ? parseInt(String(m.create_time), 10) : 0,
      };
    });
  } catch (err) {
    console.error('[feishu] fetchChatHistory failed:', err);
    return [];
  }
}

/** 将 open_id 转换为可读的短别名，与 claude-lark-plugin 保持一致 */
function displayAlias(id: string): string {
  if (!id) return 'unknown';
  return `user_${id.slice(-7)}`;
}

/**
 * 拉单条消息（用于处理 parent_id 引用回复）。
 * 失败统一返回 null，调用方做降级。
 */
export interface FetchedMessage {
  messageId: string;
  text: string;
  imageKeys: string[];
  createTime: number;
}

export async function fetchMessage(
  client: Lark.Client,
  messageId: string,
): Promise<FetchedMessage | null> {
  if (!messageId) return null;
  try {
    const resp: any = await client.im.v1.message.get({
      path: { message_id: messageId },
    } as any);
    const item = resp?.data?.items?.[0];
    if (!item) return null;
    const msgType = item.msg_type ?? 'text';
    const raw = item.body?.content ?? '';
    const { extractPlainText, extractImageKeys } = await import('./message-parser.js');
    const text = extractPlainText(msgType, raw);
    const imageKeys = extractImageKeys(msgType, raw);
    const createTime = item.create_time
      ? parseInt(String(item.create_time), 10)
      : Date.now();
    return {
      messageId: item.message_id ?? messageId,
      text,
      imageKeys,
      createTime: Number.isFinite(createTime) ? createTime : Date.now(),
    };
  } catch (err) {
    console.error('[feishu] fetchMessage failed:', err);
    return null;
  }
}
