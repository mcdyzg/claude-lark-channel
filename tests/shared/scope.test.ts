import { describe, it, expect } from 'vitest';
import { resolveScopeKey, safeScopeKey } from '../../src/shared/scope.js';

describe('resolveScopeKey', () => {
  it('returns chat:<chatId> in chat mode regardless of threadId', () => {
    expect(resolveScopeKey({ chatId: 'oc_abc', threadId: 't_1' }, 'chat')).toBe('chat:oc_abc');
    expect(resolveScopeKey({ chatId: 'oc_abc' }, 'chat')).toBe('chat:oc_abc');
  });

  it('returns thread:<chatId>:<threadId> in thread mode with threadId', () => {
    expect(resolveScopeKey({ chatId: 'oc_abc', threadId: 't_1' }, 'thread')).toBe('thread:oc_abc:t_1');
  });

  it('falls back to chat:<chatId> in thread mode without threadId', () => {
    expect(resolveScopeKey({ chatId: 'oc_abc' }, 'thread')).toBe('chat:oc_abc');
    expect(resolveScopeKey({ chatId: 'oc_abc', threadId: '' }, 'thread')).toBe('chat:oc_abc');
  });
});

describe('safeScopeKey', () => {
  it('replaces unsafe chars with underscores', () => {
    expect(safeScopeKey('thread:oc_abc:t_1')).toBe('thread_oc_abc_t_1');
    expect(safeScopeKey('chat:oc.abc')).toBe('chat_oc_abc');
  });

  it('preserves alphanumeric and hyphen', () => {
    expect(safeScopeKey('abc-XYZ_123')).toBe('abc-XYZ_123');
  });
});
