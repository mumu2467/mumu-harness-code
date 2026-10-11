/**
 * 前后端共享的纯函数工具。
 * 放在 shared 里是为了"服务端算出的 tokenEst"与"前端自己估算"永远一致。
 */

/**
 * token 估算（**估算值，不是真实 usage**）。
 *
 * 网页版网页拿不到 usage，官方 API 才有。这里用启发式：
 *  - CJK（中文/日文/韩文）约 1.6 token / 字
 *  - 其余（拉丁字母/数字/标点）约 1 token / 4 字符
 * 该系数按主流 BPE 分词器的经验值取整，误差通常在 ±15% 以内。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x2e80 && code <= 0x9fff) || // 部首扩展 / 汉字
      (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
      (code >= 0xac00 && code <= 0xd7af) || // 韩文
      (code >= 0x3040 && code <= 0x30ff);   // 日文假名
    if (isCjk) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.round(cjk * 1.6 + other / 4));
}

/** 毫秒 → 人类可读：820ms / 1.2s / 12.3s / 1m05s */
export function formatMs(ms?: number | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** 时间戳 → HH:mm */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 时间戳 → YYYY-MM-DD HH:mm:ss */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 2 天前 */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 45000) return '刚刚';
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400000) return `${Math.round(diff / 86400000)} 天前`;
  return formatDateTime(ts).slice(0, 10);
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

/** 极简 id 生成：时间戳 + 随机串，够本地使用且无需依赖 */
export function makeId(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const t = Date.now().toString(36);
  return `${prefix}${prefix ? '_' : ''}${t}${rand}`;
}

/** 会阻塞类名拼接的极简实现，避免额外依赖 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
