import { describe, it, expect, vi } from 'vitest';
import { resolveThreadBackground, resolveChatHistoryBackground } from '../../src/master/bootstrap.js';

describe('resolveThreadBackground', () => {
  it('returns null when scope != thread', async () => {
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm' },
      'chat',
      async () => null,
    );
    expect(r).toBeNull();
  });

  it('returns null when no threadId', async () => {
    const r = await resolveThreadBackground(
      { chatId: 'c', messageId: 'm' },
      'thread',
      async () => null,
    );
    expect(r).toBeNull();
  });

  it('returns null when current message is thread root', async () => {
    const fetcher = vi.fn(async () => ({
      messageId: 'm1',
      text: 'root text',
      imageKeys: [],
      createTime: 0,
    }));
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm1' },
      'thread',
      fetcher,
    );
    expect(r).toBeNull();
  });

  it('returns { text, imageKeys } with root text', async () => {
    const fetcher = vi.fn(async () => ({
      messageId: 'm_root',
      text: 'initial topic',
      imageKeys: [],
      createTime: 0,
    }));
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm2' },
      'thread',
      fetcher,
    );
    expect(r).toEqual({ text: '【话题背景】\ninitial topic', imageKeys: [] });
  });

  it('returns null when fetcher throws', async () => {
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm2' },
      'thread',
      async () => {
        throw new Error('boom');
      },
    );
    expect(r).toBeNull();
  });

  it('uses placeholder for empty root text', async () => {
    const fetcher = async () => ({
      messageId: 'm_root',
      text: '',
      imageKeys: [],
      createTime: 0,
    });
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm2' },
      'thread',
      fetcher,
    );
    expect(r).toEqual({ text: '【话题背景】\n[非文本消息]', imageKeys: [] });
  });

  it('passes through imageKeys from root', async () => {
    const fetcher = async () => ({
      messageId: 'm_root',
      text: '看这张图',
      imageKeys: ['img_aaa', 'img_bbb'],
      createTime: 0,
    });
    const r = await resolveThreadBackground(
      { chatId: 'c', threadId: 't', messageId: 'm_follow' },
      'thread',
      fetcher,
    );
    expect(r).toEqual({
      text: '【话题背景】\n看这张图',
      imageKeys: ['img_aaa', 'img_bbb'],
    });
  });
});

describe('resolveChatHistoryBackground', () => {
  it('returns null when chatId empty', async () => {
    const r = await resolveChatHistoryBackground('', async () => [], { limit: 20, selfOpenId: 'bot' });
    expect(r).toBeNull();
  });

  it('returns null when fetcher throws', async () => {
    const r = await resolveChatHistoryBackground('c', async () => { throw new Error('boom'); }, { limit: 20, selfOpenId: 'bot' });
    expect(r).toBeNull();
  });

  it('returns null when history empty', async () => {
    const r = await resolveChatHistoryBackground('c', async () => [], { limit: 20, selfOpenId: 'bot' });
    expect(r).toBeNull();
  });

  it('formats messages as prompt', async () => {
    const fetcher = async () => [
      { senderId: 'u1', senderName: 'Alice', text: 'hello', createTime: 0 },
      { senderId: 'bot', senderName: 'Bot', text: 'hi', createTime: 0 },
    ];
    const r = await resolveChatHistoryBackground('c', fetcher, { limit: 20, selfOpenId: 'bot' });
    expect(r).toContain('【群聊历史】');
    expect(r).toContain('Alice: hello');
    expect(r).toContain('Bot: hi');
  });
});
