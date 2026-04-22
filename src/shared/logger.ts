import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * 单一开关的日志器：
 * - debug=false → 所有级别全部 no-op（不写 stderr、不写文件）
 * - debug=true  → 所有级别写入 debug.log，同时在 stderr 输出（方便 MCP 宿主捕获）
 *
 * master/child 共享同一个 debug.log，便于跨进程按时间轴对齐。
 */
export class Logger {
  constructor(
    private readonly tag: string,
    private readonly logFile: string | null,
    private readonly enabled: boolean,
  ) {}

  child(subTag: string): Logger {
    return new Logger(`${this.tag}:${subTag}`, this.logFile, this.enabled);
  }

  private format(level: LogLevel, args: unknown[]): string {
    const ts = new Date().toISOString();
    const pid = process.pid;
    const parts = args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.message}${a.stack ? '\n' + a.stack : ''}`;
      try { return JSON.stringify(a); } catch { return String(a); }
    });
    return `[${ts}] [${level.toUpperCase().padEnd(5)}] [pid=${pid}] [${this.tag}] ${parts.join(' ')}`;
  }

  private write(level: LogLevel, args: unknown[]): void {
    if (!this.enabled) return;
    const line = this.format(level, args);
    console.error(line);
    if (this.logFile) {
      try { fs.appendFileSync(this.logFile, line + '\n'); } catch {/* disk full / perms; ignore */}
    }
  }

  error(...args: unknown[]): void { this.write('error', args); }
  warn(...args: unknown[]): void { this.write('warn', args); }
  info(...args: unknown[]): void { this.write('info', args); }
  debug(...args: unknown[]): void { this.write('debug', args); }
}

/**
 * 创建根 logger：
 * - debug=false → 返回 no-op logger（不碰文件系统）
 * - debug=true  → 确保 logsDir 存在，写入 <logsDir>/debug.log
 */
export function createRootLogger(tag: string, logsDir: string, debug: boolean): Logger {
  if (!debug) {
    return new Logger(tag, null, false);
  }
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {/* ignore */}
  const logFile = path.join(logsDir, 'debug.log');
  const lg = new Logger(tag, logFile, true);
  lg.info(`logger initialized file=${logFile} debug=on`);
  return lg;
}
