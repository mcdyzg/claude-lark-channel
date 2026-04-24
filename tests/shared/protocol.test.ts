import { describe, it, expect } from 'vitest';
import { parseEnvelope, serializeEnvelope, type Envelope } from '../../src/shared/protocol.js';

describe('protocol', () => {
  it('serializes with trailing newline', () => {
    const env: Envelope = { t: 'ping' };
    const s = serializeEnvelope(env);
    expect(s.endsWith('\n')).toBe(true);
    expect(s).toBe('{"t":"ping"}\n');
  });

  it('round-trips a hello envelope', () => {
    const env: Envelope = { t: 'hello', scopeKey: 'chat:x', scopeId: 'id', pid: 1, version: '0.1.1' };
    const parsed = parseEnvelope(serializeEnvelope(env).trim());
    expect(parsed).toEqual(env);
  });

  it('returns null on invalid JSON', () => {
    expect(parseEnvelope('not json')).toBeNull();
  });

  it('returns null on envelope without t', () => {
    expect(parseEnvelope('{"foo":"bar"}')).toBeNull();
  });

  it('returns unknown envelope (unknown t) without crashing', () => {
    const parsed = parseEnvelope('{"t":"future_type","x":1}');
    expect(parsed).not.toBeNull();
    expect(parsed?.t).toBe('future_type');
  });

  it('round-trips channel_push with meta', () => {
    const env: Envelope = {
      t: 'channel_push',
      pushId: 'p1',
      content: 'hi',
      meta: { chat_id: 'oc_x', image_path: '/tmp/a.png' },
    };
    expect(parseEnvelope(serializeEnvelope(env).trim())).toEqual(env);
  });
});

import { LineBuffer } from '../../src/shared/protocol.js';

describe('LineBuffer', () => {
  it('yields complete lines only', () => {
    const lb = new LineBuffer();
    lb.push('abc\nde');
    expect([...lb.drain()]).toEqual(['abc']);
    lb.push('f\ngh\n');
    expect([...lb.drain()]).toEqual(['def', 'gh']);
  });

  it('handles multiple lines in one chunk', () => {
    const lb = new LineBuffer();
    lb.push('a\nb\nc\n');
    expect([...lb.drain()]).toEqual(['a', 'b', 'c']);
  });
});
