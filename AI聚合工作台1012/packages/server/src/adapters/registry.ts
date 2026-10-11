/**
 * 适配器注册中心 —— 通道选择的唯一入口。
 *
 * 三种模式：
 *   mock   ：离线假回复（P1 默认）
 *   web    ：路线 A，Playwright 驱动三家 C 端网页版（P3 实现）
 *   api    ：路线 B，三家官方 API（P4 实现）
 *   hybrid ：优先 api，失败自动落到 web（P4 实现）
 *
 * 关键约定：**新增 AI 只需要动这里 + PROVIDER_META**，其余代码与前端都不用改。
 */
import { PROVIDER_ORDER, PROVIDER_META, type AdapterKind, type Provider } from '../../../shared/src/index';
import type { AppConfig } from '../config';
import type { Logger } from '../util/logger';
import { MockAdapter } from './mock';
import type { ChatAdapter } from './types';

export interface AdapterRegistry {
  readonly mode: AdapterKind;
  get(provider: Provider): ChatAdapter;
  list(): ChatAdapter[];
  /** 每个通道的状态说明（会透传到前端 provider.status.note） */
  notes(): Record<Provider, string | undefined>;
  disposeAll(): Promise<void>;
}

export async function createRegistry(cfg: AppConfig, log: Logger): Promise<AdapterRegistry> {
  const mockAdapters = new Map<Provider, MockAdapter>();
  for (const p of PROVIDER_ORDER) {
    const a = new MockAdapter(p, cfg.mock);
    await a.ensureReady();
    mockAdapters.set(p, a);
  }

  let mode: AdapterKind = cfg.adapterMode;

  if (cfg.adapterMode !== 'mock') {
    // P3/P4 会在这里装配 BrowserAdapter / ApiAdapter。
    // 现在明确告知并回退到 mock，而不是假装可用。
    log.warn(
      `ADAPTER_MODE=${cfg.adapterMode} 对应的通道尚未实现（网页版通道计划 P3、API 通道计划 P4），` +
        `当前自动回退到模拟通道。`,
    );
    mode = 'mock';
    for (const [p, a] of mockAdapters) {
      a.note = `${PROVIDER_META[p].label} · 模拟通道（${cfg.adapterMode} 通道尚未实现，已回退）`;
    }
  }

  return {
    mode,
    get(provider: Provider): ChatAdapter {
      const a = mockAdapters.get(provider);
      if (!a) throw new Error(`未知的 Provider: ${provider}`);
      return a;
    },
    list(): ChatAdapter[] {
      return PROVIDER_ORDER.map((p) => mockAdapters.get(p)!).filter(Boolean);
    },
    notes(): Record<Provider, string | undefined> {
      const out = {} as Record<Provider, string | undefined>;
      for (const p of PROVIDER_ORDER) out[p] = mockAdapters.get(p)?.note;
      return out;
    },
    async disposeAll(): Promise<void> {
      for (const a of mockAdapters.values()) await a.dispose();
    },
  };
}
