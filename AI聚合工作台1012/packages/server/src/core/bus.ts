/**
 * ProviderBus —— 调度策略：**跨站点并行、同一站点串行**。
 *
 * 为什么同一站点必须串行（这是正确性问题，不是性能优化）：
 * 浏览器通道是靠"发送前/后各取一次页面快照做差分"来抓取回答的。
 * 如果同一站点上同时跑两条消息，两轮的差分结果会互相污染，抓到串台的文本。
 *
 * 为什么跨站点必须并行：这是产品的核心体验——一条消息同时问三家。
 */
import type { Provider } from '../../../shared/src/index';

export class ProviderBus {
  /** 每个 provider 一条串行链 */
  private readonly chains = new Map<Provider, Promise<void>>();

  /** 同一站点两次请求之间的最小间隔（毫秒），用于降低触发风控的概率 */
  constructor(private readonly minGapMs = 300) {}

  /**
   * 把任务排到该 provider 的串行链上。
   * 前一个任务失败不会阻塞后面的任务。
   */
  run<T>(provider: Provider, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(provider) ?? Promise.resolve();

    const next = prev.then(task, task);
    // 链上只保留"已完成"信号，且吞掉异常，避免未处理的 rejection
    this.chains.set(
      provider,
      next.then(
        () => this.gap(),
        () => this.gap(),
      ),
    );
    return next;
  }

  private gap(): Promise<void> {
    if (this.minGapMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.minGapMs));
  }

  /** 该 provider 当前是否有排队或执行中的任务 */
  isBusy(provider: Provider): boolean {
    return this.chains.has(provider);
  }
}
