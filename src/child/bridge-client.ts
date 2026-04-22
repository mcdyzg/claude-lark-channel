import net from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  type Envelope,
  type RpcMethod,
  LineBuffer,
  parseEnvelope,
  serializeEnvelope,
  PROTOCOL_VERSION,
} from '../shared/protocol.js';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const LOG_EVERY_N_FAILURES = 10;

export type ChannelPushHandler = (content: string, meta: Record<string, unknown>) => void;

export interface BridgeClientOpts {
  socketPath: string;
  scopeKey: string;
  scopeId: string;
  rpcTimeoutMs: number;
}

interface PendingRpc {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class BridgeClient {
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingRpc>();
  private ready = false;
  private buf = new LineBuffer();
  private pushHandler: ChannelPushHandler | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private failures = 0;

  constructor(private readonly opts: BridgeClientOpts) {}

  setPushHandler(h: ChannelPushHandler): void {
    this.pushHandler = h;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    const socket = net.createConnection(this.opts.socketPath);
    this.socket = socket;
    this.ready = false;

    socket.once('connect', () => {
      this.failures = 0;
      this.backoff = INITIAL_BACKOFF_MS;
      this.send({
        t: 'hello',
        scopeKey: this.opts.scopeKey,
        scopeId: this.opts.scopeId,
        pid: process.pid,
        version: PROTOCOL_VERSION,
      });
    });

    socket.on('data', (chunk) => {
      this.buf.push(chunk.toString('utf-8'));
      for (const line of this.buf.drain()) this.handleLine(line);
    });

    socket.on('close', () => {
      this.ready = false;
      // 拒绝所有待定的 RPC 调用
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('socket closed'));
      }
      this.pending.clear();
      this.scheduleReconnect();
    });

    socket.on('error', () => {
      this.failures++;
      if (this.failures % LOG_EVERY_N_FAILURES === 0) {
        console.error(`[bridge-client] connection failures=${this.failures}`);
      }
    });
  }

  private handleLine(line: string): void {
    const env = parseEnvelope(line);
    if (!env) return;
    if (env.t === 'hello_ack') {
      this.ready = true;
      console.error(`[bridge-client] ready scope=${this.opts.scopeKey}`);
      return;
    }
    if (env.t === 'hello_reject') {
      const r = env as Extract<Envelope, { t: 'hello_reject' }>;
      console.error(`[bridge-client] hello rejected: ${r.reason}`);
      process.exit(1);
    }
    if (env.t === 'channel_push') {
      const p = env as Extract<Envelope, { t: 'channel_push' }>;
      this.pushHandler?.(p.content, p.meta);
      return;
    }
    if (env.t === 'rpc_result' || env.t === 'rpc_error') {
      const anyEnv = env as any;
      const pending = this.pending.get(anyEnv.id);
      if (!pending) return;
      this.pending.delete(anyEnv.id);
      clearTimeout(pending.timer);
      if (env.t === 'rpc_result') {
        pending.resolve(anyEnv.data);
      } else {
        const err = new Error(anyEnv.message ?? 'rpc error');
        (err as any).code = anyEnv.code;
        pending.reject(err);
      }
      return;
    }
    if (env.t === 'ping') {
      this.send({ t: 'pong' });
    }
  }

  private scheduleReconnect(): void {
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private send(env: Envelope): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(serializeEnvelope(env));
    }
  }

  async rpc<T = unknown>(method: RpcMethod, params: unknown): Promise<T> {
    if (!this.ready) throw new Error('bridge not ready');
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc ${method} timeout after ${this.opts.rpcTimeoutMs}ms`));
      }, this.opts.rpcTimeoutMs);
      this.pending.set(id, {
        resolve: (d) => resolve(d as T),
        reject,
        timer,
      });
      this.send({ t: 'rpc_call', id, method, params });
    });
  }
}
