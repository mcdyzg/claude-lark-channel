import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * 统一日志器：所有级别都写到文件（供事后排查）；
 * stderr 只输出 >= stderrLevel 的（保持 MCP stdout 干净，减少噪音）。
 *
 * 文件追加写（同步 append，短行原子），master/child 共享一个 debug.log
 * 便于跨进程按时间轴对齐。
 */
export class Logger {
  constructor(
    private readonly tag: string,
    private readonly logFile: string | null,
    private readonly stderrLevel: LogLevel = 'info',
  ) {}

  child(subTag: string): Logger {
    return new Logger(`${this.tag}:${subTag}`, this.logFile, this.stderrLevel);
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
    if (RANK[level] <= RANK[this.stderrLevel]) {
      console.error(line);
    }
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, line + '\n');
      } catch {/* disk full etc. silently degrade */}
    }
  }

  error(...args: unknown[]): void { this.write('error', args); }
  warn(...args: unknown[]): void { this.write('warn', args); }
  info(...args: unknown[]): void { this.write('info', args); }
  debug(...args: unknown[]): void { this.write('debug', args); }
}

/**
 * 创建根 logger：日志文件位于 <logsDir>/debug.log；
 * 先确保目录存在；返回的 logger 可通过 .child(tag) 派生子 tag。
 */
export function createRootLogger(tag: string, logsDir: string, stderrLevel: LogLevel = 'info'): Logger {
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {/* ignore */}
  const logFile = path.join(logsDir, 'debug.log');
  const lg = new Logger(tag, logFile, stderrLevel);
  lg.info(`logger initialized file=${logFile} stderrLevel=${stderrLevel}`);
  return lg;
}
