import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionStore, Session } from '../shared/session-store.js';
import type { BridgeServer, ChildConn } from './bridge-server.js';
import type { AppConfig } from '../shared/config.js';

export interface PoolEntry {
  scopeKey: string;
  scopeId: string;
  tmuxSession: string;
  childConn: ChildConn | null;
  lastActiveAt: number;
  spawnedAt: number;
  msgCount: number;
}

export interface PoolDeps {
  config: AppConfig;
  store: SessionStore;
  bridge: BridgeServer;
  pluginRoot: string;
}

export class TmuxPool {
  private entries = new Map<string, PoolEntry>();
  private sweeperHandle: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private readonly waitingHello = new Map<string, Array<(ok: boolean) => void>>();

  constructor(private readonly deps: PoolDeps) {}

  start(): void {
    // 清理上次运行残留的 lark-* tmux 会话
    try {
      const raw = execSync('tmux ls 2>/dev/null || true', { encoding: 'utf-8' });
      for (const line of raw.split('\n')) {
        const name = line.split(':')[0];
        if (name && name.startsWith('lark-')) {
          try { execSync(`tmux kill-session -t ${shellQuote(name)}`); } catch {/* ignore */}
          console.error(`[pool] killed residual tmux ${name}`);
        }
      }
    } catch {/* ignore */}

    this.sweeperHandle = setInterval(() => this.sweep(), this.deps.config.sweepMs);
  }

  /** 由 master 在子进程 socket 连接成功时调用 */
  markChildConnected(conn: ChildConn): void {
    const entry = this.entries.get(conn.scopeKey);
    if (entry) {
      entry.childConn = conn;
    }
    const waiters = this.waitingHello.get(conn.scopeKey);
    if (waiters) {
      for (const w of waiters) w(true);
      this.waitingHello.delete(conn.scopeKey);
    }
  }

  /** 由 master 在子进程 socket 断开时调用 */
  markChildDisconnected(scopeKey: string): void {
    const entry = this.entries.get(scopeKey);
    if (entry) entry.childConn = null;
  }

  /**
   * 确保该 scope 有对应的 tmux 会话；等待子进程 hello 握手。
   * 返回就绪的 entry，超时或启动失败时返回 null。
   */
  async ensure(scopeKey: string): Promise<PoolEntry | null> {
    if (this.shuttingDown) return null;

    const hit = this.entries.get(scopeKey);
    if (hit?.childConn) {
      hit.lastActiveAt = Date.now();
      return hit;
    }
    if (hit && !hit.childConn) {
      const ok = await this.waitForHello(scopeKey);
      if (!ok) {
        // 超时：销毁后重建
        this.killEntry(scopeKey);
      } else {
        hit.lastActiveAt = Date.now();
        return hit;
      }
    }

    // 容量检查
    if (this.entries.size >= this.deps.config.maxScopes) {
      this.evictLRU();
    }

    return this.attemptSpawn(scopeKey, /*allowResumeRetry*/ true);
  }

  /**
   * 拉起一次 tmux + claude，并等子进程 hello。失败时：
   * - 如果本次用的是 --resume（claudeSessionId 非空），可能是 session id 已损坏
   *   （claude 尚未持久化就退了 / 用户删了 projects/.jsonl）。清空该 id 并
   *   按"全新 session"再试一次。spec §6.4 行为。
   * - 否则直接返回 null。
   */
  private async attemptSpawn(scopeKey: string, allowResumeRetry: boolean): Promise<PoolEntry | null> {
    const session = this.deps.store.getOrCreate(scopeKey, this.deps.config.defaultWorkDir);
    const hadResumeId = !!session.claudeSessionId;
    const tmuxSession = `lark-${session.id}`;
    const entry: PoolEntry = {
      scopeKey,
      scopeId: session.id,
      tmuxSession,
      childConn: null,
      lastActiveAt: Date.now(),
      spawnedAt: Date.now(),
      msgCount: 0,
    };
    this.entries.set(scopeKey, entry);

    const ok = this.spawnTmux(session, tmuxSession);
    if (!ok) {
      this.entries.delete(scopeKey);
      return null;
    }

    const ready = await this.waitForHello(scopeKey);
    if (ready) return entry;

    // hello 超时。如果之前尝试了 --resume，大概率是 session id 损坏（比如
    // claude 上次根本没把 jsonl 写盘就退了）。清掉 claudeSessionId + 重置
    // rootInjected，然后按全新 session 再拉一次。
    this.killEntry(scopeKey);
    if (allowResumeRetry && hadResumeId) {
      console.error(`[pool] hello timeout with --resume=${session.claudeSessionId}; clearing and retrying fresh for scope=${scopeKey}`);
      const fresh = this.deps.store.getByScopeKey(scopeKey);
      if (fresh) {
        fresh.claudeSessionId = '';
        fresh.rootInjected = false;
        this.deps.store.save(fresh);
      }
      return this.attemptSpawn(scopeKey, /*allowResumeRetry*/ false);
    }
    return null;
  }

  private waitForHello(scopeKey: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const arr = this.waitingHello.get(scopeKey);
        if (arr) {
          const idx = arr.indexOf(settle);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this.waitingHello.delete(scopeKey);
        }
        resolve(false);
      }, this.deps.config.helloTimeoutMs);
      const settle = (ok: boolean) => { clearTimeout(timer); resolve(ok); };
      let arr = this.waitingHello.get(scopeKey);
      if (!arr) { arr = []; this.waitingHello.set(scopeKey, arr); }
      arr.push(settle);

      // 已经连接则立即 settle
      const entry = this.entries.get(scopeKey);
      if (entry?.childConn) settle(true);
    });
  }

  private spawnTmux(session: Session, tmuxSession: string): boolean {
    const resumeArg = session.claudeSessionId ? `--resume ${shellQuote(session.claudeSessionId)}` : '';
    const cmd = `claude ${resumeArg}`.trim();

    // 使用 spawnSync 避免继承 TTY；环境变量通过独立 -e 参数传入
    const args = [
      'new-session', '-d',
      '-s', tmuxSession,
      '-c', session.workDir,
      '-e', `LARK_CHANNEL_SCOPE_ID=${session.id}`,
      '-e', `LARK_CHANNEL_SCOPE_KEY=${session.scopeKey}`,
      '-e', `LARK_CHANNEL_SOCK=${this.deps.config.socketPath}`,
      '-e', `LARK_CHANNEL_STORE=${this.deps.config.storeDir}`,
      cmd,
    ];
    const res = spawnSync('tmux', args, { stdio: 'pipe', encoding: 'utf-8' });
    if (res.status !== 0) {
      console.error(`[pool] tmux new-session failed: ${res.stderr}`);
      return false;
    }
    console.error(`[pool] spawned tmux=${tmuxSession} scope=${session.scopeKey}`);
    return true;
  }

  private killEntry(scopeKey: string): void {
    const entry = this.entries.get(scopeKey);
    if (!entry) return;
    try { entry.childConn?.close(); } catch {/* ignore */}
    try { execSync(`tmux kill-session -t ${shellQuote(entry.tmuxSession)}`); } catch {/* ignore */}
    this.entries.delete(scopeKey);
    console.error(`[pool] killed ${entry.tmuxSession} scope=${scopeKey}`);
  }

  private evictLRU(): void {
    let oldest: PoolEntry | null = null;
    for (const e of this.entries.values()) {
      if (!oldest || e.lastActiveAt < oldest.lastActiveAt) oldest = e;
    }
    if (oldest) {
      console.error(`[pool] evicting LRU scope=${oldest.scopeKey}`);
      this.killEntry(oldest.scopeKey);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const e of [...this.entries.values()]) {
      if (now - e.lastActiveAt > this.deps.config.idleTtlMs) {
        console.error(`[pool] reaping idle scope=${e.scopeKey}`);
        this.killEntry(e.scopeKey);
      }
    }
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweeperHandle) clearInterval(this.sweeperHandle);
    for (const key of [...this.entries.keys()]) this.killEntry(key);
  }

  touch(scopeKey: string): void {
    const e = this.entries.get(scopeKey);
    if (e) e.lastActiveAt = Date.now();
  }

  incMsg(scopeKey: string): void {
    const e = this.entries.get(scopeKey);
    if (e) e.msgCount++;
  }

  list(): PoolEntry[] {
    return [...this.entries.values()];
  }
}

function shellQuote(s: string): string {
  // 单引号转义；仅用于 tmux 命令字符串参数中的 "claude --resume X"
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
