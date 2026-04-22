import net from 'node:net';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  type Envelope,
  type RpcMethod,
  LineBuffer,
  parseEnvelope,
  serializeEnvelope,
  PROTOCOL_VERSION,
} from '../shared/protocol.js';

export interface ChildConn {
  scopeKey: string;
  scopeId: string;
  pid: number;
  send(env: Envelope): void;
  close(): void;
}

export type RpcHandler = (
  method: RpcMethod,
  params: unknown,
  scopeKey: string,
) => Promise<unknown>;

export class BridgeServer {
  private server: net.Server | null = null;
  private readonly conns = new Map<string, ChildConn>(); // scopeKey → conn

  constructor(
    private readonly socketPath: string,
    private readonly rpcHandler: RpcHandler,
    private readonly onChildConnected?: (conn: ChildConn) => void,
    private readonly onChildDisconnected?: (scopeKey: string) => void,
  ) {}

  async start(): Promise<void> {
    try { fs.unlinkSync(this.socketPath); } catch { /* absent */ }

    this.server = net.createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  private handleSocket(socket: net.Socket): void {
    const buf = new LineBuffer();
    let established: ChildConn | null = null;
    let scopeKeyBound = '';

    const write = (env: Envelope) => {
      if (!socket.destroyed) socket.write(serializeEnvelope(env));
    };

    // 写入拒绝消息后优雅关闭：socket.end(data) 保证数据刷出后再发 FIN，
    // 避免 socket.destroy() 直接截断导致子进程收不到 hello_reject 而循环重连
    const rejectAndClose = (reason: string) => {
      if (!socket.destroyed) {
        socket.end(serializeEnvelope({ t: 'hello_reject', reason }));
      }
    };

    const handleLine = (line: string): void => {
      const env = parseEnvelope(line);
      if (!env) {
        console.error('[bridge] dropped malformed line');
        return;
      }

      if (!established) {
        if (env.t !== 'hello') {
          console.error(`[bridge] expected hello, got ${env.t}; closing`);
          rejectAndClose('expected_hello_first');
          return;
        }
        const hello = env as Extract<Envelope, { t: 'hello' }>;
        if (hello.version !== PROTOCOL_VERSION) {
          rejectAndClose(`version_mismatch:need_${PROTOCOL_VERSION}`);
          return;
        }
        scopeKeyBound = hello.scopeKey;
        // 踢出同 scopeKey 的旧连接
        const prior = this.conns.get(scopeKeyBound);
        if (prior) {
          console.error(`[bridge] replacing existing child for scope ${scopeKeyBound}`);
          prior.close();
        }
        established = {
          scopeKey: hello.scopeKey,
          scopeId: hello.scopeId,
          pid: hello.pid,
          send: write,
          close: () => socket.destroy(),
        };
        this.conns.set(scopeKeyBound, established);
        write({ t: 'hello_ack', ok: true });
        this.onChildConnected?.(established);
        return;
      }

      if (env.t === 'rpc_call') {
        const call = env as Extract<Envelope, { t: 'rpc_call' }>;
        this.rpcHandler(call.method as RpcMethod, call.params, scopeKeyBound)
          .then((data) => write({ t: 'rpc_result', id: call.id, ok: true, data }))
          .catch((err: any) => write({
            t: 'rpc_error', id: call.id, ok: false,
            code: err?.code ?? 'rpc_error',
            message: err?.message ?? String(err),
          }));
        return;
      }

      if (env.t === 'ping') {
        write({ t: 'pong' });
        return;
      }

      // 未知类型静默忽略，保持前向兼容
    };

    socket.on('data', (chunk) => {
      buf.push(chunk.toString('utf-8'));
      for (const line of buf.drain()) handleLine(line);
    });

    socket.on('close', () => {
      if (scopeKeyBound && this.conns.get(scopeKeyBound) === established) {
        this.conns.delete(scopeKeyBound);
        this.onChildDisconnected?.(scopeKeyBound);
      }
    });

    socket.on('error', (err) => {
      console.error('[bridge] socket error:', err);
    });
  }

  push(scopeKey: string, content: string, meta: Record<string, unknown>): boolean {
    const c = this.conns.get(scopeKey);
    if (!c) return false;
    c.send({ t: 'channel_push', pushId: randomUUID(), content, meta });
    return true;
  }

  getConn(scopeKey: string): ChildConn | undefined {
    return this.conns.get(scopeKey);
  }

  async stop(): Promise<void> {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
  }
}
