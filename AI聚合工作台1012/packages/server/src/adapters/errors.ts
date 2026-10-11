/**
 * 适配器层的错误类型：带上 errorCode，前端据此决定提示"重新登录"还是给"重试"。
 */
import type { ErrorCode } from '../../../shared/src/index';

export class AdapterError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode = 'unknown') {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

/** 需要人工介入（登录 / 验证码）时抛这个，前端会弹出"召回到屏幕"入口 */
export class NeedManualError extends AdapterError {
  constructor(message: string, code: ErrorCode = 'needLogin') {
    super(message, code);
    this.name = 'NeedManualError';
  }
}

/** 把任意异常统一成 { message, code } */
export function normalizeError(err: unknown): { message: string; code: ErrorCode } {
  if (err instanceof AdapterError) return { message: err.message, code: err.code };
  if (err instanceof Error) {
    if (err.name === 'AbortError') return { message: '已停止生成', code: 'aborted' };
    return { message: err.message || String(err), code: 'unknown' };
  }
  return { message: String(err), code: 'unknown' };
}
