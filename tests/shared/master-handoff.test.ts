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
      // process dies anyway (e.g. another actor killed it)
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
