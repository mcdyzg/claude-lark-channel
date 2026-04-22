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
  // NOTE: 信号处理由 master 负责；此处只在 exit 事件清理锁文件
  // (exit 事件在所有信号处理器及 process.exit 调用完成后才触发)
}
