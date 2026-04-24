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
