import * as Lark from '@larksuiteoapi/node-sdk';

export interface ReplyParams {
  chat_id: string;
  text: string;
  card?: string;
  reply_to?: string;
  thread_id?: string;
  format?: 'text' | 'card';
  footer?: string;
}

export interface ReplyResult {
  messageIds: string[];
  durationMs: number;
}

const MAX_TEXT_LENGTH = 28_000;

/**
 * Build a minimal Schema 2.0 markdown card.
 */
function buildSimpleCard(markdown: string, footer?: string): string {
  const elements: any[] = [{ tag: 'markdown', content: markdown }];
  if (footer) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: footer }],
    });
  }
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  });
}

function shouldUseCard(text: string): boolean {
  if (text.length > 500) return true;
  return /(^|\n)#{1,6}\s|\n```|\n\|.+\|/.test(text) || /\*\*[^*]+\*\*/.test(text);
}

/**
 * Send a reply. Handles text / card auto-selection and long-text truncation.
 * Returns new message id(s) and elapsed milliseconds.
 */
export async function doReply(
  client: Lark.Client,
  params: ReplyParams,
): Promise<ReplyResult> {
  const start = Date.now();
  const messageIds: string[] = [];

  const useCard = params.format === 'card'
    || (params.format !== 'text' && (!!params.card || shouldUseCard(params.text)));

  const content = params.card
    ? params.card
    : useCard
      ? buildSimpleCard(truncate(params.text, MAX_TEXT_LENGTH), params.footer)
      : JSON.stringify({ text: truncate(params.text, MAX_TEXT_LENGTH) });

  const msgType = params.card || useCard ? 'interactive' : 'text';

  if (params.reply_to) {
    const resp: any = await client.im.message.reply({
      path: { message_id: params.reply_to },
      data: { content, msg_type: msgType },
    } as any);
    const mid = resp?.data?.message_id;
    if (mid) messageIds.push(mid);
  } else {
    const resp: any = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: params.chat_id,
        content,
        msg_type: msgType,
      },
    } as any);
    const mid = resp?.data?.message_id;
    if (mid) messageIds.push(mid);
  }

  return { messageIds, durationMs: Date.now() - start };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n... (truncated)';
}

/** Fire-and-forget ack reaction; returns the reaction id or undefined. */
export async function sendAckReaction(
  client: Lark.Client,
  messageId: string,
  emoji: string,
): Promise<string | undefined> {
  try {
    const resp: any = await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    } as any);
    return resp?.data?.reaction_id;
  } catch {
    return undefined;
  }
}

export async function revokeReaction(
  client: Lark.Client,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    } as any);
  } catch {
    /* ignore */
  }
}
