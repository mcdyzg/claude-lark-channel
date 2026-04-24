# Auto-Takeover on Master Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `claude-lark-channel` master startup auto-SIGTERM any zombie master holding the lock, always emit `error`-level logs to stderr (not gated by `debug`), and print a version banner — so a plugin upgrade can never again silently fail.

**Architecture:** Four tightly-scoped changes under one theme. (T2) logger emits `error` to stderr regardless of `debug`, making failure visible out-of-the-box. (T1) a new pure module `src/shared/master-handoff.ts` exposes `attemptTakeover(ownerPid, logger, deps?)` that SIGTERMs with 10s grace then SIGKILLs, using an injected deps interface for unit-testability. `src/master/index.ts` calls it on lock conflict; if takeover fails (PID signature mismatch / killproof) exits 1 with a multi-line actionable stderr recipe. (T3) master logs its package.json version on startup and echoes one banner line to stderr. (T4) README gets a Troubleshooting bullet for the case where auto-takeover refuses.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, Vitest, existing `Logger` class in `src/shared/logger.ts`, POSIX `ps`.

**Spec:** `docs/superpowers/specs/2026-04-24-master-takeover-on-upgrade-design.md`

---

### Task 1: Logger — error always to stderr (T2) [TDD]

**Files:**
- Create: `tests/shared/logger.test.ts`
- Modify: `src/shared/logger.ts`

This must land first per the spec's implementation order: once logger never silently drops errors, Tasks 2-4 will be diagnosable if anything is off.

- [ ] **Step 1: Write failing test**

Create `tests/shared/logger.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRootLogger } from '../../src/shared/logger.js';

describe('Logger', () => {
  let tmpDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrLines: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-log-'));
    stderrLines = [];
    stderrSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      stderrLines.push(String(line));
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('debug=false', () => {
    it('writes error to stderr but not to file', () => {
      const log = createRootLogger('test', tmpDir, false);
      log.error('boom');
      expect(stderrLines.some((l) => l.includes('ERROR') && l.includes('boom'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'debug.log'))).toBe(false);
    });

    it('silences info/warn/debug entirely', () => {
      const log = createRootLogger('test', tmpDir, false);
      log.info('i');
      log.warn('w');
      log.debug('d');
      expect(stderrLines).toHaveLength(0);
      expect(fs.existsSync(path.join(tmpDir, 'debug.log'))).toBe(false);
    });

    it('error survives a child() call', () => {
      const log = createRootLogger('test', tmpDir, false).child('sub');
      log.error('child boom');
      expect(stderrLines.some((l) => l.includes('child boom'))).toBe(true);
    });
  });

  describe('debug=true', () => {
    it('writes all levels to both stderr and file', () => {
      const log = createRootLogger('test', tmpDir, true);
      stderrLines.length = 0; // discard the "logger initialized" line createRootLogger emits
      log.info('i-line');
      log.warn('w-line');
      log.error('e-line');
      log.debug('d-line');
      const content = fs.readFileSync(path.join(tmpDir, 'debug.log'), 'utf-8');
      for (const token of ['i-line', 'w-line', 'e-line', 'd-line']) {
        expect(content).toContain(token);
        expect(stderrLines.some((l) => l.includes(token))).toBe(true);
      }
    });
  });
});
```

- [ ] **Step 2: Run test — see it fail**

Run:
```bash
npx vitest run tests/shared/logger.test.ts
```

Expected: FAIL — the "writes error to stderr but not to file" test fails because the current `write()` returns early on `!this.enabled` so `error()` is silent.

- [ ] **Step 3: Update `write()` in `src/shared/logger.ts`**

Replace lines 35-42 (the `private write()` method) with:

```ts
  private write(level: LogLevel, args: unknown[]): void {
    const line = this.format(level, args);
    // error 永远走 stderr；其他级别由 debug 开关门控
    if (level === 'error' || this.enabled) {
      console.error(line);
    }
    // 文件只在 debug=true 时写
    if (this.enabled && this.logFile) {
      try { fs.appendFileSync(this.logFile, line + '\n'); } catch {/* disk full / perms; ignore */}
    }
  }
```

Also update the class doc comment at the top (lines 6-12) to reflect the new contract. Replace it with:

```ts
/**
 * 单一开关的日志器：
 * - error 级别永远输出到 stderr（无论 debug 开关），保证升级/配置错误等关键信号可见
 * - debug=false → info/warn/debug 全部 no-op，不写文件、不写 stderr
 * - debug=true  → 所有级别写入 debug.log，同时在 stderr 输出
 *
 * master/child 共享同一个 debug.log，便于跨进程按时间轴对齐。
 */
```

- [ ] **Step 4: Run test — see it pass**

Run:
```bash
npx vitest run tests/shared/logger.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Audit `.error()` call sites — sanity-confirm they are real errors**

Run:
```bash
grep -rn "\\.error(" src/ | grep -v -E "(logger\\.test\\.ts|// |/\\*)"
```

Expected: every hit is a real error condition (failed I/O, invalid config, unreachable state), not a warning-style noise message. If any hit looks like it should be a warn/info, downgrade it **in this same task** — do not change logger semantics.

Known safe sites (verified 2026-04-24): `src/master/pool.ts` `attemptSpawn` drop path, `resolveAppendSystemPromptFile` 4 branches. Others need a quick eye.

- [ ] **Step 6: Full test suite + typecheck**

Run:
```bash
npm test && npm run typecheck
```

Expected: all pass. Baseline was 69 tests; this adds 4 → total 73.

- [ ] **Step 7: Commit**

```bash
git add src/shared/logger.ts tests/shared/logger.test.ts
git commit -m "$(cat <<'EOF'
feat(logger): error level always emits to stderr

Previously 'debug: false' made the logger a complete no-op — even
fatal errors were silent. Today's incident (zombie master holding
lock, user saw no signal at all) motivated this change. info/warn/
debug remain debug-gated; file writes remain debug-gated. Only
error now bypasses the flag.

New tests/shared/logger.test.ts pins both branches.
EOF
)"
```

---

### Task 2: `master-handoff.ts` + unit tests (T1a) [TDD]

**Files:**
- Create: `tests/shared/master-handoff.test.ts`
- Create: `src/shared/master-handoff.ts`

Pure module, fully mockable via dependency injection. Does not import `child_process` at test time.

- [ ] **Step 1: Write failing test**

Create `tests/shared/master-handoff.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { attemptTakeover, type TakeoverDeps } from '../../src/shared/master-handoff.js';

function makeLogger() {
  const errors: string[] = [];
  const log = {
    error: (...a: unknown[]) => { errors.push(a.map(String).join(' ')); },
    warn: () => {}, info: () => {}, debug: () => {},
    child: () => log,
  } as any;
  return { logger: log, errors };
}

const OUR_PS = 'node /Users/x/.claude/plugins/cache/claude-lark-channel/lark-channel/0.1.0/node_modules/tsx/dist/loader.mjs src/index.ts';
const FOREIGN_PS = 'node /Users/x/some-other-project/server.js';

describe('attemptTakeover', () => {
  it('refuses when ps signature does not contain lark-channel', async () => {
    const { logger } = makeLogger();
    const signals: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const deps: TakeoverDeps = {
      runPs: () => FOREIGN_PS,
      sendSignal: (pid, sig) => { signals.push({ pid, sig }); },
      probeAlive: () => true,
      now: () => 0,
      sleep: async () => {},
    };
    const res = await attemptTakeover(12345, logger, deps);
    expect(res).toEqual({ ok: false, reason: 'not-our-master' });
    expect(signals).toEqual([]);
  });

  it("refuses when ps command itself fails", async () => {
    const { logger } = makeLogger();
    const deps: TakeoverDeps = {
      runPs: () => { throw new Error('ps: command not found'); },
      sendSignal: () => { throw new Error('should not be called'); },
      probeAlive: () => true,
      now: () => 0,
      sleep: async () => {},
    };
    const res = await attemptTakeover(12345, logger, deps);
    expect(res).toEqual({ ok: false, reason: 'ps-unavailable' });
  });

  it('succeeds via SIGTERM when old master dies within 10s', async () => {
    const { logger, errors } = makeLogger();
    let time = 0;
    let sigtermAt = -1;
    const deadAfter = 400; // ms after SIGTERM

    const deps: TakeoverDeps = {
      runPs: () => OUR_PS,
      sendSignal: (_pid, sig) => { if (sig === 'SIGTERM') sigtermAt = time; },
      probeAlive: () => sigtermAt < 0 || time - sigtermAt < deadAfter,
      now: () => time,
      sleep: async (ms) => { time += ms; },
    };
    const res = await attemptTakeover(12345, logger, deps);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.method).toBe('SIGTERM');
      expect(res.elapsedMs).toBeGreaterThanOrEqual(400);
      expect(res.elapsedMs).toBeLessThan(600); // rounded up to next 200ms poll
    }
    expect(errors.some((l) => l.includes('replacing old master pid=12345 — SIGTERM'))).toBe(true);
  });

  it('escalates to SIGKILL when SIGTERM is ignored, and returns SIGKILL', async () => {
    const { logger, errors } = makeLogger();
    let time = 0;
    let sigkillAt = -1;
    const deadAfterKill = 400;

    const deps: TakeoverDeps = {
      runPs: () => OUR_PS,
      sendSignal: (_pid, sig) => { if (sig === 'SIGKILL') sigkillAt = time; },
      probeAlive: () => sigkillAt < 0 || time - sigkillAt < deadAfterKill,
      now: () => time,
      sleep: async (ms) => { time += ms; },
    };
    const res = await attemptTakeover(12345, logger, deps);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.method).toBe('SIGKILL');
      // total elapsed: 10s SIGTERM timeout + ~400ms SIGKILL wait
      expect(res.elapsedMs).toBeGreaterThanOrEqual(10_400);
    }
    expect(errors.some((l) => l.includes('unresponsive — SIGKILL'))).toBe(true);
  });

  it('returns killproof when SIGTERM and SIGKILL both fail to kill', async () => {
    const { logger } = makeLogger();
    let time = 0;
    const deps: TakeoverDeps = {
      runPs: () => OUR_PS,
      sendSignal: () => {}, // swallow
      probeAlive: () => true, // never dies
      now: () => time,
      sleep: async (ms) => { time += ms; },
    };
    const res = await attemptTakeover(12345, logger, deps);
    expect(res).toEqual({ ok: false, reason: 'killproof' });
  });

  it('handles sendSignal throwing (EPERM etc) by continuing to wait', async () => {
    const { logger } = makeLogger();
    let time = 0;
    let sigtermAttempted = false;
    const deps: TakeoverDeps = {
      runPs: () => OUR_PS,
      sendSignal: (_pid, sig) => {
        if (sig === 'SIGTERM') { sigtermAttempted = true; throw new Error('EPERM'); }
      },
      // process dies anyway (e.g. it received the signal despite the error, or another actor killed it)
      probeAlive: () => time < 400,
      now: () => time,
      sleep: async (ms) => { time += ms; },
    };
    const res = await attemptTakeover(12345, logger, deps);
    expect(sigtermAttempted).toBe(true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.method).toBe('SIGTERM');
  });
});
```

- [ ] **Step 2: Run test — see it fail**

Run:
```bash
npx vitest run tests/shared/master-handoff.test.ts
```

Expected: FAIL — `attemptTakeover` does not exist.

- [ ] **Step 3: Create `src/shared/master-handoff.ts`**

Create new file:

```ts
import { execSync } from 'node:child_process';
import type { Logger } from './logger.js';

export type TakeoverResult =
  | { ok: true; method: 'SIGTERM' | 'SIGKILL'; elapsedMs: number }
  | { ok: false; reason: 'not-our-master' | 'ps-unavailable' | 'killproof' };

export interface TakeoverDeps {
  /** 执行 ps 查询命令行；失败时应抛错，调用方视为 ps-unavailable */
  runPs: (pid: number) => string;
  /** process.kill 的抽象；允许抛 EPERM/ESRCH（由调用方吞掉） */
  sendSignal: (pid: number, signal: NodeJS.Signals) => void;
  /** 进程是否仍然存活（典型实现：process.kill(pid, 0) 不抛即存活） */
  probeAlive: (pid: number) => boolean;
  /** 当前时间 ms；测试里可以注入假时钟 */
  now: () => number;
  /** sleep；测试里可以注入推进时钟的 fake */
  sleep: (ms: number) => Promise<void>;
}

const SIGTERM_TIMEOUT_MS = 10_000;
const SIGKILL_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 200;

/**
 * 尝试接管一个正在运行的 lark-channel master：
 *   1. verifyIsOurMaster（ps 签名检查，防 PID 复用误杀）
 *   2. SIGTERM + 最长 10s 等死
 *   3. SIGKILL + 最长 2s 等死
 *   4. 成功返回 { ok, method, elapsedMs }；失败返回 { ok: false, reason }
 *
 * 该函数不碰锁文件——调用方在 attemptTakeover 返回 ok 后应再次调用
 * tryAcquireLock 来获取锁（老 master 退出时会自清锁）。
 */
export async function attemptTakeover(
  ownerPid: number,
  logger: Logger,
  deps: TakeoverDeps = DEFAULT_DEPS,
): Promise<TakeoverResult> {
  let psOut: string;
  try {
    psOut = deps.runPs(ownerPid);
  } catch {
    return { ok: false, reason: 'ps-unavailable' };
  }
  if (!looksLikeOurMaster(psOut)) {
    return { ok: false, reason: 'not-our-master' };
  }

  const startedAt = deps.now();
  logger.error(`[lark-channel] replacing old master pid=${ownerPid} — SIGTERM`);
  try { deps.sendSignal(ownerPid, 'SIGTERM'); } catch {/* may have died already, or EPERM */}

  if (await waitForExit(ownerPid, SIGTERM_TIMEOUT_MS, deps)) {
    return { ok: true, method: 'SIGTERM', elapsedMs: deps.now() - startedAt };
  }

  logger.error(`[lark-channel] old master pid=${ownerPid} unresponsive — SIGKILL`);
  try { deps.sendSignal(ownerPid, 'SIGKILL'); } catch {/* same */}

  if (await waitForExit(ownerPid, SIGKILL_TIMEOUT_MS, deps)) {
    return { ok: true, method: 'SIGKILL', elapsedMs: deps.now() - startedAt };
  }

  return { ok: false, reason: 'killproof' };
}

function looksLikeOurMaster(psOutput: string): boolean {
  if (!psOutput) return false;
  // 签名要求：命令行里同时含 "lark-channel" + ("src/index" 或 "tsx")
  return psOutput.includes('lark-channel') &&
         (psOutput.includes('src/index') || psOutput.includes('tsx'));
}

async function waitForExit(pid: number, timeoutMs: number, deps: TakeoverDeps): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    if (!deps.probeAlive(pid)) return true;
  }
  return false;
}

export const DEFAULT_DEPS: TakeoverDeps = {
  runPs: (pid) => execSync(`ps -o command= -p ${pid}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }),
  sendSignal: (pid, signal) => { process.kill(pid, signal); },
  probeAlive: (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
```

- [ ] **Step 4: Run test — see it pass**

Run:
```bash
npx vitest run tests/shared/master-handoff.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Full test suite + typecheck**

Run:
```bash
npm test && npm run typecheck
```

Expected: all pass. Total now 73 + 6 = 79 tests across 12 files.

- [ ] **Step 6: Commit**

```bash
git add src/shared/master-handoff.ts tests/shared/master-handoff.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add master-handoff.ts for process takeover

Pure module exposing attemptTakeover(ownerPid, logger, deps?):
- ps signature check to avoid killing PID-reused processes
- SIGTERM with 10s grace, then SIGKILL with 2s
- deps-injection interface makes unit testing hermetic
- Not wired into master/index.ts yet; Task 3 does that.

6 unit tests cover: refuse-not-our-master, refuse-ps-unavailable,
SIGTERM-success, SIGKILL-escalation, killproof, send-throws-continues.
EOF
)"
```

---

### Task 3: Package version helper

**Files:**
- Create: `src/shared/version.ts`

Tiny helper so `master/index.ts` can read its own package.json version rather than hardcoding a number that drifts.

- [ ] **Step 1: Create `src/shared/version.ts`**

Create the file:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读取本插件自身的 package.json version 字段。
 * - src/shared/version.ts 在插件根下；package.json 在 ../../package.json
 * - 读取失败（路径不符合预期 / json 坏）统一返回 'unknown'，永不抛错
 */
export function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
```

- [ ] **Step 2: Verify via ad-hoc run**

Run:
```bash
npx tsx -e "import('./src/shared/version.js').then(m => console.log('version =', m.readPackageVersion()))"
```

Expected: `version = 0.1.1` (or whatever `package.json` currently says).

- [ ] **Step 3: Typecheck + full tests**

Run:
```bash
npm test && npm run typecheck
```

Expected: all pass (no new tests; this is a dependency for Task 4).

- [ ] **Step 4: Commit**

```bash
git add src/shared/version.ts
git commit -m "$(cat <<'EOF'
feat(shared): add readPackageVersion() helper

Reads the plugin's own package.json version via import.meta.url
path resolution. Returns 'unknown' on any failure. Prep for
master/index.ts to stop hardcoding the version string.
EOF
)"
```

---

### Task 4: Wire takeover + banner + MCP version into `master/index.ts` (T1b + T3)

**Files:**
- Modify: `src/master/index.ts`

The integration step. Reads the current file first because line numbers may shift during the task.

- [ ] **Step 1: Add imports**

Find the existing imports block at the top of `src/master/index.ts`. Add these two lines next to other shared imports (e.g. next to `import { tryAcquireLock } from '../shared/lock.js';` which is at line 10):

```ts
import { attemptTakeover } from '../shared/master-handoff.js';
import { readPackageVersion } from '../shared/version.js';
```

- [ ] **Step 2: Move `createRootLogger` above the lock-acquire and wire takeover**

The current file (lines 52-62, verify via `Read` before editing) looks like:

```ts
  // 单 master 进程锁
  const lockPath = path.join(cfg.storeDir, `master-${cfg.appId}.lock`);
  const got = await tryAcquireLock(lockPath);
  if (!got) {
    console.error('[master] another master is running; exiting');
    process.exit(0);
  }

  // 根 logger：debug=false 时完全静默；debug=true 时写 <logsDir>/debug.log
  const rootLogger = createRootLogger('master', cfg.logsDir, cfg.debug);
  rootLogger.info(`startMaster pid=${process.pid} storeDir=${cfg.storeDir} scopeMode=${cfg.scopeMode} debug=${cfg.debug}`);
```

Replace **the whole block above (lines 52-62)** with:

```ts
  // 根 logger 要在 lock 处理之前创建，以便 takeover 期间的 error 能落 debug.log。
  // debug=false 时它仍然能把 error 级别送到 stderr（Task 1 的保证）。
  const rootLogger = createRootLogger('master', cfg.logsDir, cfg.debug);
  const pkgVersion = readPackageVersion();

  // 单 master 进程锁；撞锁时尝试接管老 master（见 spec 2026-04-24）。
  // attemptTakeover 失败的极端情况（非 lark-channel 进程 / 打不死）→ 醒目错误后退出 1。
  const lockPath = path.join(cfg.storeDir, `master-${cfg.appId}.lock`);
  let got = await tryAcquireLock(lockPath);
  if (!got) {
    const ownerPid = readOwnerPid(lockPath);
    if (ownerPid == null) {
      console.error(`[lark-channel] ✗ cannot acquire lock at ${lockPath} and cannot read owner pid`);
      process.exit(1);
    }
    const tr = await attemptTakeover(ownerPid, rootLogger);
    if (tr.ok) {
      got = await tryAcquireLock(lockPath);
      if (!got) {
        console.error(`[lark-channel] ✗ lock re-acquisition failed after takeover (pid=${ownerPid} method=${tr.method})`);
        console.error(`[lark-channel]   likely a third master raced in; retry /reload-plugins`);
        process.exit(1);
      }
    } else {
      console.error(`[lark-channel] ✗ cannot acquire lock (held by pid=${ownerPid}, takeover refused: ${tr.reason})`);
      console.error(`[lark-channel]   manually investigate:  ps -p ${ownerPid}`);
      console.error(`[lark-channel]   if it is a lark-channel master: kill ${ownerPid} && /reload-plugins`);
      console.error(`[lark-channel]   lock file: ${lockPath}`);
      process.exit(1);
    }
  }

  rootLogger.info(`startMaster pid=${process.pid} version=${pkgVersion} storeDir=${cfg.storeDir} scopeMode=${cfg.scopeMode} debug=${cfg.debug}`);
  console.error(`[lark-channel] master v${pkgVersion} ready (pid=${process.pid})`);
```

Then, at the **top of the file** (after the import block, before `export async function startMaster(...)`), add a local helper:

```ts
function readOwnerPid(lockPath: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
```

(Do not reach into `lock.ts` internals — `readOwnerPid` is cheap to inline and keeps `lock.ts` pure.)

- [ ] **Step 3: (merged into Step 2)**

No separate step — the version banner `rootLogger.info(...)` + `console.error(...)` lines are already included at the bottom of the Step 2 replacement block.

- [ ] **Step 4: Replace hardcoded MCP server version**

Find the line that currently reads (was at ~line 66):

```ts
    { name: 'claude-lark-channel-master', version: '0.1.1' },
```

Replace with:

```ts
    { name: 'claude-lark-channel-master', version: pkgVersion },
```

- [ ] **Step 5: Typecheck**

Run:
```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Full test suite**

Run:
```bash
npm test
```

Expected: all 79 tests still PASS. This task adds no tests (the integration path is covered by smoke in Task 6).

- [ ] **Step 7: Commit**

```bash
git add src/master/index.ts
git commit -m "$(cat <<'EOF'
feat(master): auto-takeover + version banner on startup

On lock conflict, master now calls attemptTakeover() to SIGTERM
(then SIGKILL) the zombie lark-channel master holding the lock,
instead of exit(0)'ing silently. Falls back to exit(1) with a
loud multi-line stderr recipe when takeover refuses (non-our-master
signature, ps unavailable, or killproof).

Also:
- Startup now logs 'version=X' to debug.log and echoes
  '[lark-channel] master vX ready (pid=Y)' to stderr so operators
  can tell versions apart at a glance.
- MCP server no longer hardcodes '0.1.1'; reads from package.json
  via readPackageVersion().

Closes the silent-failure mode from the 2026-04-24 incident.
EOF
)"
```

---

### Task 5: README Troubleshooting

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the Troubleshooting section**

Run:
```bash
grep -n "^## Troubleshooting" README.md
```

Expected: one hit (was around line 82 pre-task-2 of the prior feature; verify current line via the grep).

- [ ] **Step 2: Append a new bullet at the END of the Troubleshooting section**

The Troubleshooting section ends right before `## Design` (or equivalent next `##` heading). Insert the following bullet as the LAST bullet of the Troubleshooting list (i.e., right before the next `## ...` heading):

```markdown
- **Bot silently not replying / no logs appearing after plugin upgrade**: usually means an old-version master is still holding the lock. From v0.1.2 onward the new master auto-takes-over on startup — you should see `[lark-channel] replacing old master pid=X — SIGTERM` followed by `[lark-channel] master vY.Z ready` in whatever terminal launched the new master. If instead you see `[lark-channel] ✗ cannot acquire lock ...`, the takeover refused (typically because the lock file points at a PID that is not a lark-channel process). Inspect manually:
  ```bash
  cat ~/.claude/channels/lark-channel/master-*.lock      # 持有者 PID
  ps -p <pid>                                            # 确认身份
  ```
  如果它是 lark-channel master 但 takeover 没生效，`kill <pid>` 后 `/reload-plugins`。如果它不是 lark-channel 进程（PID 被复用或 lock 文件损坏），删除锁文件再 `/reload-plugins`。
```

- [ ] **Step 3: Typecheck (cheap smoke that nothing else got broken)**

Run:
```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(README): add troubleshooting bullet for silent-failure case

Describes the v0.1.2 auto-takeover visible signals and the
manual fallback when takeover refuses. Aligned with the
exit-1 error text emitted by src/master/index.ts.
EOF
)"
```

---

### Task 6: Smoke-test scenarios

**Files:**
- Modify: `scripts/smoke-test.md`

- [ ] **Step 1: Append new section at the END of the file**

Add this new section after the last existing section (append to bottom):

```markdown

## Auto-takeover on master startup (spec 2026-04-24)

**Prerequisites for this section:**
- `debug: true` in config.json (ensures handoff progress lines also land in debug.log, not just stderr)
- You can start masters via `npm run start` from either the workspace or the plugin cache dir

Scenarios:

- [ ] **Happy path — automatic takeover between two v0.1.2+ masters**: start a master (terminal 1: `cd /path/to/workspace && npm run start`). Confirm stderr shows `[lark-channel] master vX ready (pid=P1)`. Now start a second master (terminal 2: same command). Expect: terminal 2 prints `[lark-channel] replacing old master pid=P1 — SIGTERM` then `[lark-channel] master vX ready (pid=P2)` within 2 seconds, and terminal 1 prints `shutdown complete` and exits 0. `tmux ls | grep lark-` children (if any) persist unharmed.
- [ ] **Non-our-master refusal**: with no master running, write a fake lock pointing at your shell (`echo $$ > ~/.claude/channels/lark-channel/master-*.lock`). Start a master: `npm run start`. Expect: stderr shows the multi-line `[lark-channel] ✗ cannot acquire lock ...` error recipe, exit code 1, and your shell's PID is **not** killed. Clean up: `rm ~/.claude/channels/lark-channel/master-*.lock`.
- [ ] **Stale-lock self-heal** (not new behavior, regression check): write a lock with a dead PID (`echo 99999 > ~/.claude/channels/lark-channel/master-*.lock` — assuming PID 99999 is not in use; verify with `ps -p 99999`). Start a master. Expect: normal startup (lock is stolen by existing `lock.ts` logic), no takeover attempt, no `[lark-channel] replacing ...` line in stderr.
- [ ] **Error visibility with debug=false**: set `"debug": false` in config.json. Trigger a known error (e.g. point `appendSystemPromptFile` at a directory like `/tmp`). Start master. Expect: terminal stderr shows the `resolveAppendSystemPromptFile ... is not a regular file` error line on first spawn (not silent); `~/.claude/channels/lark-channel/logs/debug.log` file is **NOT** created.
- [ ] **Version banner accuracy**: `cat package.json | grep version` noting the value `vX.Y.Z`. Start master. Expect: stderr shows `[lark-channel] master v<X.Y.Z> ready (pid=...)` with the exact string from package.json (not a hardcoded number).
```

- [ ] **Step 2: Commit**

```bash
git add scripts/smoke-test.md
git commit -m "$(cat <<'EOF'
docs(smoke): add auto-takeover scenarios

5 manual scenarios covering: happy-path takeover between two masters,
non-our-master refusal, stale-lock self-heal regression, error
visibility without debug flag, and version banner accuracy.
EOF
)"
```

---

## Done criteria

- All vitest tests pass (baseline 69 + 4 logger + 6 handoff = 79)
- `npm run typecheck` clean
- Six commits landed: logger, handoff module, version helper, master integration, README, smoke-test
- Manual happy-path smoke confirms the takeover dance when you start a second master

## Out of scope reminders

Not in this plan — deferred per spec §1 "不在本 spec 范围":

- Heartbeat `state.json` / `/lark-channel:status` CLI
- `fs.watch` config hot reload
- Configurable timeouts (10s SIGTERM / 2s SIGKILL are hardcoded)
