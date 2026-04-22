import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionStore, Session } from '../shared/session-store.js';
import type { BridgeServer, ChildConn } from './bridge-server.js';
import type { AppConfig } from '../shared/config.js';
import type { Logger } from '../shared/logger.js';

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
  logger: Logger;
}

export class TmuxPool {
  private entries = new Map<string, PoolEntry>();
  private sweeperHandle: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private readonly waitingHello = new Map<string, Array<(ok: boolean) => void>>();

  constructor(private readonly deps: PoolDeps) {}

  start(): void {
    const lg = this.deps.logger;
    // 清理上次运行残留的 lark-* tmux 会话
    try {
      const raw = execSync('tmux ls 2>/dev/null || true', { encoding: 'utf-8' });
      let killed = 0;
      for (const line of raw.split('\n')) {
        const name = line.split(':')[0];
        if (name && name.startsWith('lark-')) {
          try { execSync(`tmux kill-session -t ${shellQuote(name)}`); } catch {/* ignore */}
          lg.info(`killed residual tmux=${name}`);
          killed++;
        }
      }
      lg.info(`start: cleared ${killed} residual lark-* tmux sessions; maxScopes=${this.deps.config.maxScopes} idleTtlMs=${this.deps.config.idleTtlMs} sweepMs=${this.deps.config.sweepMs}`);
    } catch (err: any) {
      lg.warn(`start: residual cleanup failed: ${err?.message ?? err}`);
    }

    this.sweeperHandle = setInterval(() => this.sweep(), this.deps.config.sweepMs);
  }

  /** 由 master 在子进程 socket 连接成功时调用 */
  markChildConnected(conn: ChildConn): void {
    const entry = this.entries.get(conn.scopeKey);
    if (entry) {
      entry.childConn = conn;
      this.deps.logger.info(`child connected → pool entry updated scope=${conn.scopeKey} tmux=${entry.tmuxSession}`);
    } else {
      this.deps.logger.warn(`child connected but no pool entry for scope=${conn.scopeKey}`);
    }
    const waiters = this.waitingHello.get(conn.scopeKey);
    if (waiters) {
      this.deps.logger.debug(`resolving ${waiters.length} hello waiter(s) for scope=${conn.scopeKey}`);
      for (const w of waiters) w(true);
      this.waitingHello.delete(conn.scopeKey);
    }
  }

  /** 由 master 在子进程 socket 断开时调用 */
  markChildDisconnected(scopeKey: string): void {
    const entry = this.entries.get(scopeKey);
    if (entry) {
      entry.childConn = null;
      this.deps.logger.warn(`child disconnected scope=${scopeKey}; entry kept for potential reconnect`);
    }
  }

  /**
   * 确保该 scope 有对应的 tmux 会话；等待子进程 hello 握手。
   * 返回就绪的 entry，超时或启动失败时返回 null。
   */
  async ensure(scopeKey: string): Promise<PoolEntry | null> {
    const lg = this.deps.logger;
    if (this.shuttingDown) {
      lg.warn(`ensure denied (shutting down) scope=${scopeKey}`);
      return null;
    }

    const hit = this.entries.get(scopeKey);
    if (hit?.childConn) {
      hit.lastActiveAt = Date.now();
      lg.debug(`ensure hit: scope=${scopeKey} tmux=${hit.tmuxSession} already connected`);
      return hit;
    }
    if (hit && !hit.childConn) {
      lg.info(`ensure: entry exists but child not yet connected scope=${scopeKey}; waiting for hello`);
      const ok = await this.waitForHello(scopeKey);
      if (!ok) {
        lg.warn(`ensure: existing entry hello timeout scope=${scopeKey}; will rebuild`);
        this.killEntry(scopeKey);
      } else {
        hit.lastActiveAt = Date.now();
        lg.info(`ensure: existing entry became ready scope=${scopeKey}`);
        return hit;
      }
    }

    // 容量检查
    if (this.entries.size >= this.deps.config.maxScopes) {
      lg.warn(`ensure: pool at capacity (${this.entries.size}/${this.deps.config.maxScopes}); evicting LRU`);
      this.evictLRU();
    }

    lg.info(`ensure: spawning fresh scope=${scopeKey}`);
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
    const lg = this.deps.logger;
    const session = this.deps.store.getOrCreate(scopeKey, this.deps.config.defaultWorkDir);
    const hadResumeId = !!session.claudeSessionId;
    const tmuxSession = `lark-${session.id}`;
    lg.info(`attemptSpawn scope=${scopeKey} scopeId=${session.id} tmux=${tmuxSession} workDir=${session.workDir} resumeId=${session.claudeSessionId || '<fresh>'} allowResumeRetry=${allowResumeRetry}`);
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
      lg.error(`spawnTmux failed scope=${scopeKey}; dropping entry`);
      this.entries.delete(scopeKey);
      return null;
    }

    lg.info(`awaiting hello scope=${scopeKey} timeoutMs=${this.deps.config.helloTimeoutMs}`);
    const ready = await this.waitForHello(scopeKey);
    if (ready) {
      lg.info(`attemptSpawn OK scope=${scopeKey} tmux=${tmuxSession}`);
      return entry;
    }

    // hello 超时。如果之前尝试了 --resume，大概率是 session id 损坏（比如
    // claude 上次根本没把 jsonl 写盘就退了）。清掉 claudeSessionId + 重置
    // rootInjected，然后按全新 session 再拉一次。
    lg.warn(`hello TIMEOUT scope=${scopeKey} (waited ${this.deps.config.helloTimeoutMs}ms)`);
    this.killEntry(scopeKey);
    if (allowResumeRetry && hadResumeId) {
      lg.warn(`resume id=${session.claudeSessionId} suspected stale; clearing & retrying fresh scope=${scopeKey}`);
      const fresh = this.deps.store.getByScopeKey(scopeKey);
      if (fresh) {
        fresh.claudeSessionId = '';
        fresh.rootInjected = false;
        this.deps.store.save(fresh);
      }
      return this.attemptSpawn(scopeKey, /*allowResumeRetry*/ false);
    }
    lg.error(`attemptSpawn gave up scope=${scopeKey}`);
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
    const lg = this.deps.logger;
    const resumeArg = session.claudeSessionId ? `--resume ${shellQuote(session.claudeSessionId)}` : '';

    // 两个关键 flag（参考 claude-lark-plugin README + 官方 channels 文档）：
    //
    // --dangerously-load-development-channels plugin:lark-channel@claude-lark-channel
    //   开启我们这个 plugin 的 channel 订阅。普通 MCP server 是不会消费
    //   `notifications/claude/channel` 的，必须通过 --channels 或这个 dev
    //   flag 激活（研究预览期间自建 plugin 不在 Anthropic 允许列表里，只能
    //   走 dev flag）。
    //
    // --dangerously-skip-permissions
    //   spawn 出来的 claude 没有人坐在键盘前审批工具调用。permission prompt
    //   会让会话死锁。该 flag 自动通过所有 prompt。
    const channelArg = `--dangerously-load-development-channels plugin:lark-channel@claude-lark-channel`;
    const permArg = `--dangerously-skip-permissions`;
    const cmd = `claude ${channelArg} ${permArg} ${resumeArg}`.trim().replace(/ +/g, ' ');

    // 使用 spawnSync 避免继承 TTY；环境变量通过独立 -e 参数传入
    const args = [
      'new-session', '-d',
      '-s', tmuxSession,
      '-c', session.workDir,
      '-e', `LARK_CHANNEL_SCOPE_ID=${session.id}`,
      '-e', `LARK_CHANNEL_SCOPE_KEY=${session.scopeKey}`,
      '-e', `LARK_CHANNEL_SOCK=${this.deps.config.socketPath}`,
      '-e', `LARK_CHANNEL_STORE=${this.deps.config.storeDir}`,
      `-e`, `LARK_CHANNEL_LOG_LEVEL=${this.deps.config.logLevel}`,
      cmd,
    ];
    lg.info(`spawnTmux cmd="tmux ${args.join(' ')}"`);
    const res = spawnSync('tmux', args, { stdio: 'pipe', encoding: 'utf-8' });
    if (res.status !== 0) {
      lg.error(`tmux new-session status=${res.status} stderr=${(res.stderr ?? '').trim()}`);
      return false;
    }
    lg.info(`spawnTmux OK tmux=${tmuxSession} scope=${session.scopeKey}`);
    // --dangerously-load-development-channels 会弹一个交互式确认，阻塞启动。
    // 异步轮询 pane，检测到 "I am using this for local development" 就自动
    // 发 Enter 确认（默认选项就是 1.）。fire-and-forget，不阻塞当前路径。
    void this.autoConfirmDevChannel(tmuxSession);
    return true;
  }

  /** 10 秒内轮询 pane，检测到 dev-channel 警告就发 Enter 自动确认 */
  private async autoConfirmDevChannel(tmuxSession: string): Promise<void> {
    const lg = this.deps.logger;
    const deadline = Date.now() + 10_000;
    const marker = 'I am using this for local development';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      let pane: string;
      try {
        pane = execSync(`tmux capture-pane -t ${shellQuote(tmuxSession)} -p`, { encoding: 'utf-8' });
      } catch {
        lg.debug(`autoConfirm: tmux ${tmuxSession} gone; stopping poll`);
        return;
      }
      if (pane.includes(marker)) {
        try {
          execSync(`tmux send-keys -t ${shellQuote(tmuxSession)} Enter`);
          lg.info(`autoConfirm: dev-channel warning dismissed via Enter; tmux=${tmuxSession}`);
        } catch (err: any) {
          lg.warn(`autoConfirm: send-keys failed tmux=${tmuxSession} err=${err?.message ?? err}`);
        }
        return;
      }
    }
    lg.warn(`autoConfirm: dev-channel warning never appeared within 10s (may already be dismissed); tmux=${tmuxSession}`);
  }

  private killEntry(scopeKey: string): void {
    const entry = this.entries.get(scopeKey);
    if (!entry) return;
    try { entry.childConn?.close(); } catch {/* ignore */}
    try { execSync(`tmux kill-session -t ${shellQuote(entry.tmuxSession)}`); } catch {/* ignore */}
    this.entries.delete(scopeKey);
    this.deps.logger.info(`killEntry tmux=${entry.tmuxSession} scope=${scopeKey}`);
  }

  private evictLRU(): void {
    let oldest: PoolEntry | null = null;
    for (const e of this.entries.values()) {
      if (!oldest || e.lastActiveAt < oldest.lastActiveAt) oldest = e;
    }
    if (oldest) {
      this.deps.logger.info(`evicting LRU scope=${oldest.scopeKey} lastActive=${new Date(oldest.lastActiveAt).toISOString()}`);
      this.killEntry(oldest.scopeKey);
    }
  }

  private sweep(): void {
    const now = Date.now();
    const reaped: string[] = [];
    for (const e of [...this.entries.values()]) {
      if (now - e.lastActiveAt > this.deps.config.idleTtlMs) {
        reaped.push(e.scopeKey);
        this.killEntry(e.scopeKey);
      }
    }
    if (reaped.length > 0) {
      this.deps.logger.info(`sweep reaped ${reaped.length} idle scope(s): ${reaped.join(',')}`);
    } else {
      this.deps.logger.debug(`sweep: 0 idle scopes`);
    }
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.deps.logger.info(`pool stop; entries=${this.entries.size}`);
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
