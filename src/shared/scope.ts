import type { SessionScope } from './config.js';

export interface ScopeEvent {
  chatId: string;
  threadId?: string;
}

export function resolveScopeKey(event: ScopeEvent, mode: SessionScope): string {
  if (mode === 'thread' && event.threadId) {
    return `thread:${event.chatId}:${event.threadId}`;
  }
  return `chat:${event.chatId}`;
}

export function safeScopeKey(scopeKey: string): string {
  return scopeKey.replace(/[^a-zA-Z0-9_-]/g, '_');
}
