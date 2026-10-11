/**
 * 极简结构化日志：不引入 pino，避免 transport/ESM 互操作带来的启动风险。
 * 输出格式：HH:mm:ss.mmm LEVEL [scope] message {extra}
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(scope: string): Logger;
}

let threshold: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function write(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[threshold]) return;
  const line = `${stamp()} ${COLOR[level]}${level.toUpperCase().padEnd(5)}${RESET} [${scope}] ${msg}`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export function createLogger(scope = 'app'): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}
