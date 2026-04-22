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
import type { Logger } from '../shared/logger.js';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const LOG_EVERY_N_FAILURES = 10;

export type ChannelPushHandler = (content: string, meta: Record<string, unknown>) => void;

export interface BridgeClientOpts {
  socketPath: string;
  scopeKey: string;
  scopeId: string;
  rpcTimeoutMs: number;
  logger: Logger;
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
  private readonly logger: Logger;

  constructor(private readonly opts: BridgeClientOpts) {
    this.logger = opts.logger;
  }

  setPushHandler(h: ChannelPushHandler): void {
    this.pushHandler = h;
  }

  start(): void {
    this.logger.info(`bridge-client start sock=${this.opts.socketPath} scope=${this.opts.scopeKey}`);
    this.connect();
  }

  private connect(): void {
    this.logger.debug(`connecting to ${this.opts.socketPath}...`);
    const socket = net.createConnection(this.opts.socketPath);
    this.socket = socket;
    this.ready = false;

    socket.once('connect', () => {
      this.failures = 0;
      this.backoff = INITIAL_BACKOFF_MS;
      this.logger.info(`socket connected; sending hello scope=${this.opts.scopeKey} scopeId=${this.opts.scopeId} pid=${process.pid} v=${PROTOCOL_VERSION}`);
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
      this.logger.warn(`socket closed (pendingRpcs=${this.pending.size}); scheduling reconnect`);
      // 拒绝所有待定的 RPC 调用
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('socket closed'));
      }
      this.pending.clear();
      this.scheduleReconnect();
    });

    socket.on('error', (err) => {
      this.failures++;
      if (this.failures % LOG_EVERY_N_FAILURES === 0 || this.failures === 1) {
        this.logger.warn(`connect error failures=${this.failures} err=${err?.message ?? err}`);
      }
    });
  }

  private handleLine(line: string): void {
    const env = parseEnvelope(line);
    if (!env) {
      this.logger.warn(`dropped malformed line len=${line.length}`);
      return;
    }
    if (env.t === 'hello_ack') {
      this.ready = true;
      this.logger.info(`hello_ack received; bridge ready scope=${this.opts.scopeKey}`);
      return;
    }
    if (env.t === 'hello_reject') {
      const r = env as Extract<Envelope, { t: 'hello_reject' }>;
      this.logger.error(`hello rejected by master: reason=${r.reason}; exit(1)`);
      process.exit(1);
    }
    if (env.t === 'channel_push') {
      const p = env as Extract<Envelope, { t: 'channel_push' }>;
      this.logger.info(`channel_push received pushId=${p.pushId} contentLen=${p.content.length} metaKeys=[${Object.keys(p.meta).join(',')}]`);
      if (!this.pushHandler) {
        this.logger.error(`channel_push dropped: no pushHandler set`);
        return;
      }
      try {
        this.pushHandler(p.content, p.meta);
        this.logger.debug(`channel_push forwarded to pushHandler pushId=${p.pushId}`);
      } catch (err: any) {
        this.logger.error(`pushHandler threw pushId=${p.pushId} err=${err?.message ?? err}`);
      }
      return;
    }
    if (env.t === 'rpc_result' || env.t === 'rpc_error') {
      const anyEnv = env as any;
      const pending = this.pending.get(anyEnv.id);
      if (!pending) {
        this.logger.warn(`stale rpc response id=${anyEnv.id}`);
        return;
      }
      this.pending.delete(anyEnv.id);
      clearTimeout(pending.timer);
      if (env.t === 'rpc_result') {
        pending.resolve(anyEnv.data);
        this.logger.debug(`rpc_result id=${anyEnv.id} resolved`);
      } else {
        const err = new Error(anyEnv.message ?? 'rpc error');
        (err as any).code = anyEnv.code;
        pending.reject(err);
        this.logger.warn(`rpc_error id=${anyEnv.id} msg=${anyEnv.message}`);
      }
      return;
    }
    if (env.t === 'ping') {
      this.send({ t: 'pong' });
      return;
    }
    this.logger.debug(`ignoring unknown envelope t=${env.t}`);
  }

  private scheduleReconnect(): void {
    const delay = this.backoff;
    this.logger.debug(`reconnect scheduled in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private send(env: Envelope): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(serializeEnvelope(env));
    } else {
      this.logger.warn(`send skipped t=${env.t}: socket not writable`);
    }
  }

  async rpc<T = unknown>(method: RpcMethod, params: unknown): Promise<T> {
    if (!this.ready) {
      this.logger.warn(`rpc ${method} called while bridge not ready`);
      throw new Error('bridge not ready');
    }
    const id = randomUUID();
    this.logger.info(`rpc_call send method=${method} id=${id}`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.logger.error(`rpc timeout method=${method} id=${id} after ${this.opts.rpcTimeoutMs}ms`);
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
