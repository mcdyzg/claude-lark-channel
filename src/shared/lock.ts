import fs from 'node:fs';

/**
 * PID-based lock. Returns true if acquired, false if another live process
 * already holds the lock. Stale locks (dead PID) are stolen.
 */
export async function tryAcquireLock(lockPath: string): Promise<boolean> {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    registerCleanup(lockPath);
    return true;
  } catch {
    // File exists — check liveness of the owner
    let pid: number = NaN;
    try {
      pid = parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
    } catch {/* unreadable */}
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
        return false; // still alive
      } catch {/* dead, steal */}
    }
    try {
      fs.writeFileSync(lockPath, String(process.pid));
      registerCleanup(lockPath);
      return true;
    } catch {
      return false;
    }
  }
}

function registerCleanup(lockPath: string): void {
  const cleanup = () => { try { fs.unlinkSync(lockPath); } catch {/* ignore */} };
  process.once('exit', cleanup);
  process.once('SIGINT', () => { cleanup(); process.exit(0); });
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
}
