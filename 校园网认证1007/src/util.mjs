/**
 * util.mjs —— 终端彩色输出、命令行解析、配置加载
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));

export const C = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export const log = (...a) => console.log(...a);
export const info = (m) => console.log(`${C.blue('ℹ')} ${m}`);
export const ok = (m) => console.log(`${C.green('✔')} ${m}`);
export const warn = (m) => console.log(`${C.yellow('▲')} ${m}`);
export const fail = (m) => console.log(`${C.red('✖')} ${m}`);
export const step = (m) => console.log(`\n${C.bold(C.cyan('▌'))} ${C.bold(m)}`);
export const kv = (k, v) => console.log(`   ${C.gray(k.padEnd(14, '　'))} ${v}`);

/** 解析 --key value / --flag 形式的参数 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out[key] = true;
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** 读取 config.json，缺省字段补齐 */
export function loadConfig() {
  const p = join(ROOT, 'config.json');
  const defaults = {
    username: '',
    password: '',
    portal: 'http://172.19.1.1',
    browser: '',
    headless: false,
    keepBrowserOpen: false,
    pingHost: 'www.baidu.com',
    pingCount: 5,
    speedTestBytes: 209715200,
    speedTestMaxMs: 8000,
    speedTestSources: [
      { name: '阿里 npmmirror CDN', url: 'https://cdn.npmmirror.com/binaries/electron/v28.3.3/electron-v28.3.3-win32-x64.zip' },
      { name: '华为云镜像', url: 'https://mirrors.huaweicloud.com/electron/v28.3.3/electron-v28.3.3-win32-x64.zip' },
    ],
  };
  if (!existsSync(p)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    warn(`config.json 解析失败，使用默认配置：${e.message}`);
    return defaults;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 人类可读的字节数 */
export function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
