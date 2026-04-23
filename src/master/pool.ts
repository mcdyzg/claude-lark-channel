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
    // 启动时"认领"上次运行留下的 lark-* tmux 会话：
    //   - tmux 会话名格式 `lark-<scopeId>`，scopeId 可反查 session store
    //   - 若 scopeId 在 store 里能找到 → 注册进 pool，child 会自动重连
    //   - 若找不到（store 已清 / 非本插件生成） → 是孤儿，kill
    // 这保留了跨 master 重启的 tmux 状态，user 可以 `tmux attach -t lark-<id>`
    // 继续查看 Claude 的历史上下文。
    let adopted = 0;
    let orphans = 0;
    try {
      const raw = execSync('tmux ls 2>/dev/null || true', { encoding: 'utf-8' });
      for (const line of raw.split('\n')) {
        const name = line.split(':')[0];
        if (!name || !name.startsWith('lark-')) continue;
        const scopeId = name.slice('lark-'.length);
        const session = this.deps.store.getById(scopeId);
        if (!session) {
          try { execSync(`tmux kill-session -t ${shellQuote(name)}`); } catch {/* ignore */}
          lg.info(`start: killed orphan tmux=${name} (scopeId not in store)`);
          orphans++;
          continue;
        }
        const entry: PoolEntry = {
          scopeKey: session.scopeKey,
          scopeId: session.id,
          tmuxSession: name,
          childConn: null,  // 等 child 自己重连进来
          lastActiveAt: Date.now(),
          spawnedAt: Date.now(),
          msgCount: 0,
        };
        this.entries.set(session.scopeKey, entry);
        lg.info(`start: adopted tmux=${name} scope=${session.scopeKey} (awaiting child reconnect)`);
        adopted++;
      }
    } catch (err: any) {
      lg.warn(`start: tmux ls failed: ${err?.message ?? err}`);
    }
    lg.info(`start: ${adopted} adopted, ${orphans} orphans killed; maxScopes=${this.deps.config.maxScopes} idleTtlMs=${this.deps.config.idleTtlMs} sweepMs=${this.deps.config.sweepMs}`);

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
    const appendSystemPromptFile = this.resolveAppendSystemPromptFile();
    const cmd = buildClaudeCmd({
      resumeSessionId: session.claudeSessionId || undefined,
      appendSystemPromptFile,
    });

    // 使用 spawnSync 避免继承 TTY；环境变量通过独立 -e 参数传入
    const args = [
      'new-session', '-d',
      '-s', tmuxSession,
      '-c', session.workDir,
      '-e', `LARK_CHANNEL_SCOPE_ID=${session.id}`,
      '-e', `LARK_CHANNEL_SCOPE_KEY=${session.scopeKey}`,
      '-e', `LARK_CHANNEL_SOCK=${this.deps.config.socketPath}`,
      '-e', `LARK_CHANNEL_STORE=${this.deps.config.storeDir}`,
      '-e', `LARK_CHANNEL_DEBUG=${this.deps.config.debug ? '1' : '0'}`,
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

  /**
   * 校验 config.appendSystemPromptFile 是否能作为 --append-system-prompt-file
   * 的值传给 child claude。任何检查失败都降级为 undefined（spawn 继续、不加 flag），
   * 避免 child 启动时因为 bad 路径立即退出 → 触发 hello-timeout 重试死循环。
   *
   * 不读取文件内容，只做存在性与大小检查；内容解析由 claude 进程自己完成。
   */
  private resolveAppendSystemPromptFile(): string | undefined {
    const file = this.deps.config.appendSystemPromptFile;
    if (!file) return undefined;
    if (!path.isAbsolute(file)) {
      this.deps.logger.error(`appendSystemPromptFile must be absolute, got: ${file}; ignoring`);
      return undefined;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (err: any) {
      this.deps.logger.error(`appendSystemPromptFile stat failed path=${file} err=${err?.message ?? err}; ignoring`);
      return undefined;
    }
    if (!stat.isFile()) {
      this.deps.logger.error(`appendSystemPromptFile is not a regular file path=${file}; ignoring`);
      return undefined;
    }
    if (stat.size === 0) {
      this.deps.logger.warn(`appendSystemPromptFile is empty path=${file}; ignoring`);
      return undefined;
    }
    this.deps.logger.debug(`appendSystemPromptFile OK path=${file} bytes=${stat.size}`);
    return file;
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
    this.deps.logger.info(`pool stop (preserving tmux); entries=${this.entries.size}`);
    if (this.sweeperHandle) clearInterval(this.sweeperHandle);
    // 关 master 时只断开与 child 的 socket 连接，tmux 会话保留。
    // 下次 master 起来时 start() 会按 session store 认领这些 tmux。
    // child 看到 socket 断会按指数退避自动重连，无需我们主动通知。
    for (const entry of this.entries.values()) {
      try { entry.childConn?.close(); } catch {/* ignore */}
    }
    this.entries.clear();
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
  // 单引号转义；用于 tmux 命令字符串参数（--resume <id> / --append-system-prompt-file <path>）
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface BuildClaudeCmdOpts {
  resumeSessionId?: string;
  appendSystemPromptFile?: string;
}

/**
 * 构造 spawned child claude 的 shell 命令字符串。纯函数、可单测。
 * 生成的命令包含 base flags、可选 --append-system-prompt-file、可选 --resume。
 */
export function buildClaudeCmd(opts: BuildClaudeCmdOpts): string {
  const channelArg = '--dangerously-load-development-channels plugin:lark-channel@claude-lark-channel';
  const permArg = '--dangerously-skip-permissions';
  const parts: string[] = ['claude', channelArg, permArg];
  if (opts.appendSystemPromptFile && opts.appendSystemPromptFile.length > 0) {
    parts.push(`--append-system-prompt-file ${shellQuote(opts.appendSystemPromptFile)}`);
  }
  if (opts.resumeSessionId) {
    parts.push(`--resume ${shellQuote(opts.resumeSessionId)}`);
  }
  return parts.join(' ');
}
