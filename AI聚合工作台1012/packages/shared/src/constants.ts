/**
 * 三家 AI 的展示元信息与全局默认值。
 * 品牌色用于视觉区分：DeepSeek 蓝紫 / 豆包 蓝绿 / Kimi 深灰紫。
 */
import type { AdapterKind, Provider } from './types';

export const PROVIDER_ORDER: Provider[] = ['deepseek', 'doubao', 'kimi'];

export interface ProviderMeta {
  id: Provider;
  label: string;
  /** 头像里的短字符 */
  short: string;
  /** 主品牌色（渐变起点） */
  accent: string;
  /** 渐变终点 */
  accent2: string;
  /** 站点地址（路线 A 用） */
  url: string;
  desc: string;
}

export const PROVIDER_META: Record<Provider, ProviderMeta> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    short: 'DS',
    accent: '#4f6ef7',
    accent2: '#7c3aed',
    url: 'https://chat.deepseek.com/',
    desc: '深度推理见长',
  },
  doubao: {
    id: 'doubao',
    label: '豆包',
    short: '豆',
    accent: '#0ea5e9',
    accent2: '#14b8a6',
    url: 'https://www.doubao.com/chat/',
    desc: '响应快、多模态',
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    short: 'K',
    accent: '#64748b',
    accent2: '#8b5cf6',
    url: 'https://www.kimi.com/',
    desc: '长文本处理强',
  },
};

/** 顶部全局开关的默认勾选态 */
export const DEFAULT_ENABLED: Record<Provider, boolean> = {
  deepseek: true,
  doubao: true,
  kimi: true,
};

export const WS_PATH = '/ws';

export const ADAPTER_LABEL: Record<AdapterKind, string> = {
  mock: '模拟通道',
  web: '网页版通道',
  api: '官方 API 通道',
};

/** 回答收尾判据：连续这么久没有新内容就认为答完了（P3 浏览器通道使用） */
export const QUIET_MS = 4500;
