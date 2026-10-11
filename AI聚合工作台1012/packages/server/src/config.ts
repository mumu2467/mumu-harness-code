/**
 * 环境变量集中解析。
 *
 * 设计取舍：不引入 zod 之类的校验库——本项目要读的变量很少，
 * 手写 20 行既避免了一个依赖，也让默认值一目了然。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterKind, Provider } from '../../shared/src/index';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录：packages/server/src → 上三级 */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

/* 尽早加载 .env（Node 20.12+ 提供 process.loadEnvFile） */
try {
  const envPath = path.join(REPO_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    (process as unknown as { loadEnvFile(p: string): void }).loadEnvFile(envPath);
  }
} catch {
  // 没有 .env 或 Node 版本过低：忽略，继续用系统环境变量
}

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/** 相对路径按仓库根解析，绝对路径原样使用 */
function dir(key: string, fallback: string): string {
  const raw = str(key, fallback);
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(REPO_ROOT, raw);
}

export interface MockConfig {
  firstTokenMs: Record<Provider, number>;
  chunkMs: number;
  chunkSize: number;
  failRate: number;
  showReasoning: boolean;
}

export interface AppConfig {
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  adapterMode: AdapterKind;
  /** SQLite 库与上传图片（P2 使用） */
  dataRoot: string;
  /** 浏览器 user-data-dir（P3 使用）。★ 必须是纯英文路径 ★ */
  profileRoot: string;
  webDist: string;
  mock: MockConfig;
}

export function loadConfig(): AppConfig {
  const adapterMode = str('ADAPTER_MODE', 'mock').toLowerCase() as AdapterKind;

  return {
    port: num('PORT', 8787),
    // 默认只监听本机：这是个人对比工具，不应默认暴露到局域网
    host: str('HOST', '127.0.0.1'),
    logLevel: str('LOG_LEVEL', 'info') as AppConfig['logLevel'],
    adapterMode: (['mock', 'web', 'api', 'hybrid'] as string[]).includes(adapterMode)
      ? adapterMode
      : 'mock',
    dataRoot: dir('DATA_ROOT', './data'),
    // 默认放在工作区外的纯英文短路径，规避"Chromium 无法从含中文目录加载 profile"
    profileRoot: dir('PROFILE_ROOT', 'D:/MUMUcode/aiworkbench-data/profiles'),
    webDist: path.resolve(REPO_ROOT, 'packages/web/dist'),
    mock: {
      firstTokenMs: {
        deepseek: num('MOCK_FIRST_TOKEN_DEEPSEEK', 900),
        doubao: num('MOCK_FIRST_TOKEN_DOUBAO', 500),
        kimi: num('MOCK_FIRST_TOKEN_KIMI', 1200),
      },
      chunkMs: num('MOCK_CHUNK_MS', 35),
      chunkSize: num('MOCK_CHUNK_SIZE', 4),
      failRate: num('MOCK_FAIL_RATE', 0),
      showReasoning: bool('MOCK_SHOW_REASONING', false),
    },
  };
}
