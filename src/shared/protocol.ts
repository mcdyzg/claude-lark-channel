export type RpcMethod = 'reply' | 'download_attachment';

export type Envelope =
  | { t: 'hello'; scopeKey: string; scopeId: string; pid: number; version: string }
  | { t: 'hello_ack'; ok: true }
  | { t: 'hello_reject'; reason: string }
  | { t: 'channel_push'; pushId: string; content: string; meta: Record<string, unknown> }
  | { t: 'rpc_call'; id: string; method: RpcMethod; params: unknown }
  | { t: 'rpc_result'; id: string; ok: true; data: unknown }
  | { t: 'rpc_error'; id: string; ok: false; code: string; message: string }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: string; [k: string]: unknown };  // unknown forward-compat

export const PROTOCOL_VERSION = '0.1.1';

export function serializeEnvelope(env: Envelope): string {
  return JSON.stringify(env) + '\n';
}

export function parseEnvelope(line: string): Envelope | null {
  if (!line) return null;
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object' || typeof obj.t !== 'string') return null;
    return obj as Envelope;
  } catch {
    return null;
  }
}

/**
 * Line-oriented frame buffer for socket streams.
 * Feed chunks via push(); consume complete lines via drain().
 */
export class LineBuffer {
  private buf = '';

  push(chunk: string): void {
    this.buf += chunk;
  }

  *drain(): Generator<string> {
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) yield line;
    }
  }
}
