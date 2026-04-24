import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * 单一开关的日志器：
 * - error 级别永远输出到 stderr（无论 debug 开关），保证升级/配置错误等关键信号可见
 * - debug=false → info/warn/debug 全部 no-op，不写文件、不写 stderr
 * - debug=true  → 所有级别写入 debug.log，同时在 stderr 输出
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
