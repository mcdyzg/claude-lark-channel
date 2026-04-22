import type { SessionScope } from '../shared/config.js';

export interface ThreadRoot {
  messageId: string;
  text: string;
  imageKeys: string[];
  createTime: number;
}

export interface ThreadBackground {
  text: string;
  imageKeys: string[];
}

export interface BootstrapEvent {
  chatId: string;
  threadId?: string;
  messageId: string;
}

export interface HistoryMessage {
  senderId: string;
  senderName: string;
  text: string;
  createTime: number;
}

export type ThreadRootFetcher = (threadId: string) => Promise<ThreadRoot | null>;
export type ChatHistoryFetcher = (chatId: string, limit: number) => Promise<HistoryMessage[]>;

const THREAD_PREFIX = '【话题背景】\n';
const CHAT_PREFIX = '【群聊历史】\n';
const NON_TEXT_PLACEHOLDER = '[非文本消息]';

export async function resolveThreadBackground(
  event: BootstrapEvent,
  scope: SessionScope,
  fetcher: ThreadRootFetcher,
): Promise<ThreadBackground | null> {
  if (scope !== 'thread') return null;
  if (!event.threadId) return null;
  let root: ThreadRoot | null;
  try {
    root = await fetcher(event.threadId);
  } catch {
    return null;
  }
  if (!root) return null;
  if (root.messageId === event.messageId) return null;
  const bodyText = root.text.length > 0 ? root.text : NON_TEXT_PLACEHOLDER;
  return {
    text: `${THREAD_PREFIX}${bodyText}`,
    imageKeys: root.imageKeys ?? [],
  };
}

export interface ChatHistoryOptions {
  limit: number;
  selfOpenId: string;
}

export async function resolveChatHistoryBackground(
  chatId: string,
  fetcher: ChatHistoryFetcher,
  opts: ChatHistoryOptions,
): Promise<string | null> {
  if (!chatId) return null;
  let messages: HistoryMessage[];
  try {
    messages = await fetcher(chatId, opts.limit);
  } catch {
    return null;
  }
  if (messages.length === 0) return null;
  const lines = messages.map(m => `${m.senderName}: ${m.text}`);
  return `${CHAT_PREFIX}${lines.join('\n')}`;
}
