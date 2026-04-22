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
import type { Logger } from '../shared/logger.js';

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
    private readonly logger: Logger,
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
        this.logger.info(`bridge listening path=${this.socketPath} perms=0600`);
        resolve();
      });
    });
  }

  private handleSocket(socket: net.Socket): void {
    const buf = new LineBuffer();
    let established: ChildConn | null = null;
    let scopeKeyBound = '';
    this.logger.debug('new socket connection (pre-hello)');

    const write = (env: Envelope) => {
      if (!socket.destroyed) socket.write(serializeEnvelope(env));
    };

    // 写入拒绝消息后优雅关闭：socket.end(data) 保证数据刷出后再发 FIN，
    // 避免 socket.destroy() 直接截断导致子进程收不到 hello_reject 而循环重连
    const rejectAndClose = (reason: string) => {
      this.logger.warn(`reject+close reason=${reason}`);
      if (!socket.destroyed) {
        socket.end(serializeEnvelope({ t: 'hello_reject', reason }));
      }
    };

    const handleLine = (line: string): void => {
      const env = parseEnvelope(line);
      if (!env) {
        this.logger.warn(`dropped malformed line len=${line.length}`);
        return;
      }

      if (!established) {
        if (env.t !== 'hello') {
          this.logger.warn(`expected hello, got t=${env.t}; closing`);
          rejectAndClose('expected_hello_first');
          return;
        }
        const hello = env as Extract<Envelope, { t: 'hello' }>;
        if (hello.version !== PROTOCOL_VERSION) {
          this.logger.warn(`version mismatch: got=${hello.version} need=${PROTOCOL_VERSION}`);
          rejectAndClose(`version_mismatch:need_${PROTOCOL_VERSION}`);
          return;
        }
        scopeKeyBound = hello.scopeKey;
        // 踢出同 scopeKey 的旧连接
        const prior = this.conns.get(scopeKeyBound);
        if (prior) {
          this.logger.warn(`replacing existing child for scope=${scopeKeyBound}`);
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
        this.logger.info(`hello OK scope=${scopeKeyBound} scopeId=${hello.scopeId} pid=${hello.pid} v=${hello.version} → hello_ack sent`);
        this.onChildConnected?.(established);
        return;
      }

      if (env.t === 'rpc_call') {
        const call = env as Extract<Envelope, { t: 'rpc_call' }>;
        this.logger.info(`rpc_call scope=${scopeKeyBound} method=${call.method} id=${call.id}`);
        this.rpcHandler(call.method as RpcMethod, call.params, scopeKeyBound)
          .then((data) => {
            write({ t: 'rpc_result', id: call.id, ok: true, data });
            this.logger.info(`rpc_result scope=${scopeKeyBound} method=${call.method} id=${call.id} ok`);
          })
          .catch((err: any) => {
            const msg = err?.message ?? String(err);
            write({
              t: 'rpc_error', id: call.id, ok: false,
              code: err?.code ?? 'rpc_error',
              message: msg,
            });
            this.logger.error(`rpc_error scope=${scopeKeyBound} method=${call.method} id=${call.id} msg=${msg}`);
          });
        return;
      }

      if (env.t === 'ping') {
        write({ t: 'pong' });
        this.logger.debug(`ping→pong scope=${scopeKeyBound}`);
        return;
      }

      this.logger.debug(`ignoring unknown envelope t=${env.t}`);
      // 未知类型静默忽略，保持前向兼容
    };

    socket.on('data', (chunk) => {
      buf.push(chunk.toString('utf-8'));
      for (const line of buf.drain()) handleLine(line);
    });

    socket.on('close', () => {
      if (scopeKeyBound && this.conns.get(scopeKeyBound) === established) {
        this.conns.delete(scopeKeyBound);
        this.logger.info(`connection closed scope=${scopeKeyBound}`);
        this.onChildDisconnected?.(scopeKeyBound);
      } else {
        this.logger.debug('socket closed pre-hello or after kick');
      }
    });

    socket.on('error', (err) => {
      this.logger.error(`socket error scope=${scopeKeyBound || '(pre-hello)'}: ${err?.message ?? err}`);
    });
  }

  push(scopeKey: string, content: string, meta: Record<string, unknown>): boolean {
    const c = this.conns.get(scopeKey);
    if (!c) {
      this.logger.warn(`push failed: no conn for scope=${scopeKey} (conns=${[...this.conns.keys()].join(',')})`);
      return false;
    }
    const pushId = randomUUID();
    c.send({ t: 'channel_push', pushId, content, meta });
    this.logger.info(`push scope=${scopeKey} pushId=${pushId} contentLen=${content.length} metaKeys=[${Object.keys(meta).join(',')}]`);
    return true;
  }

  getConn(scopeKey: string): ChildConn | undefined {
    return this.conns.get(scopeKey);
  }

  async stop(): Promise<void> {
    this.logger.info(`bridge stop; closing ${this.conns.size} conns`);
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
  }
}
