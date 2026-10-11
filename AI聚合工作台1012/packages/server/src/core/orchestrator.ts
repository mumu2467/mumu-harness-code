/**
 * Orchestrator —— 一次"发送"到 N 条"回复"的状态机与事件编排。
 *
 * 职责边界：
 *   - 它不认识 Playwright / HTTP / Mock，只认识 ChatAdapter 接口
 *   - 它负责：生成 id、起 AbortController、把适配器的流式结果翻译成 WS 事件
 *   - 它不负责：落库（P2 在 routes 层接 Store）、投递策略（那是 ProviderBus）
 */
import {
  PROVIDER_META,
  estimateTokens,
  makeId,
  type AdapterKind,
  type ErrorCode,
  type LoginState,
  type Provider,
  type ProviderStatus,
  type ReplyStatus,
  type SendRequest,
  type SendResponse,
  type ServerEventPayload,
} from '../../../shared/src/index';
import type { AdapterRegistry } from '../adapters/registry';
import { normalizeError } from '../adapters/errors';
import type { ReplySink, SendInput } from '../adapters/types';
import type { Logger } from '../util/logger';
import type { Hub } from '../ws/hub';
import type { ProviderBus } from './bus';

/**
 * 交给 Hub 广播的"回复类事件"载荷（不含 Hub 统一补的 seq / ts，
 * 也不含编排器统一补的 replyId / clientMsgId / provider / sessionId）。
 *
 * 说明：这里没有直接复用 shared 里的 ServerEvent 联合类型，
 * 是因为 TS 的 Omit 作用在联合类型上不会分发，会丢掉各分支的字段；
 * 单独声明一份载荷类型反而更准确、更好维护。
 */
type ReplyEmit =
  | { type: 'reply.started'; status: Extract<ReplyStatus, 'pending'> }
  | { type: 'reply.delta'; content: string; firstTokenMs?: number }
  | {
      type: 'reply.done';
      content: string;
      latencyMs: number;
      firstTokenMs?: number;
      tokenEst: number;
      stopped?: boolean;
      reasoning?: string;
    }
  | { type: 'reply.error'; error: string; errorCode: ErrorCode; content: string; reasoning?: string };

interface RunRecord {
  replyId: string;
  messageId: string;
  provider: Provider;
  sessionId: string;
  clientMsgId: string;
  input: SendInput;
  controller: AbortController;
  startedAt: number;
  firstTokenMs?: number;
  content: string;
  reasoning?: string;
  status: ReplyStatus;
  adapter: AdapterKind;
  /** 防止 done / error 重复发出 */
  finished: boolean;
}

/** 最多保留多少条运行记录（重试需要它，所以不能立刻删） */
const MAX_RUNS = 500;

export class Orchestrator {
  private readonly runs = new Map<string, RunRecord>();
  private readonly loginCache = new Map<Provider, LoginState>();

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly bus: ProviderBus,
    private readonly hub: Hub,
    private readonly log: Logger,
  ) {
    for (const a of this.registry.list()) this.loginCache.set(a.id, 'loggedIn');
  }

  /* ------------------------------------------------------------------ */
  /* 对外接口                                                            */
  /* ------------------------------------------------------------------ */

  /** 投递一条消息给 N 个 provider（并行启动；同 provider 由 Bus 串行） */
  start(req: SendRequest): SendResponse {
    const messageId = makeId('msg');
    const created: RunRecord[] = [];

    for (const provider of req.providers) {
      const run: RunRecord = {
        replyId: makeId('rep'),
        messageId,
        provider,
        sessionId: req.sessionId,
        clientMsgId: req.clientMsgId,
        input: { text: req.text, images: req.images ?? [] },
        controller: new AbortController(),
        startedAt: Date.now(),
        content: '',
        status: 'pending',
        adapter: this.registry.get(provider).kind,
        finished: false,
      };
      this.runs.set(run.replyId, run);
      created.push(run);
    }

    this.sweep();

    // 先把所有 run 都注册好，再逐个启动：避免第一个 run 的事件先于响应到达时，
    // 前端还没拿到其余回复的 replyId
    for (const run of created) void this.execute(run);

    this.log.info(
      `投递 messageId=${messageId} → ${req.providers.join(' / ')}（文字 ${req.text.length} 字` +
        `${req.images?.length ? `，图片 ${req.images.length} 张` : ''}）`,
    );

    return {
      messageId,
      replies: created.map((r) => ({ replyId: r.replyId, provider: r.provider, clientMsgId: r.clientMsgId })),
    };
  }

  /** 停止某条回复（用户点"停止生成"或按 Esc） */
  stop(replyId: string): boolean {
    const run = this.runs.get(replyId);
    if (!run) return false;
    if (run.status === 'done' || run.status === 'error') return false;
    this.log.info(`停止生成 replyId=${replyId}（${run.provider}）`);
    run.controller.abort();
    return true;
  }

  /** 重试某条回复：复用同一个 replyId，前端那一格直接复位重跑 */
  retry(replyId: string): boolean {
    const run = this.runs.get(replyId);
    if (!run) return false;
    if (run.status === 'pending' || run.status === 'streaming') return false;

    run.controller = new AbortController();
    run.startedAt = Date.now();
    run.firstTokenMs = undefined;
    run.content = '';
    run.reasoning = undefined;
    run.status = 'pending';
    run.finished = false;

    this.log.info(`重试 replyId=${replyId}（${run.provider}）`);
    void this.execute(run);
    return true;
  }

  /** 让某个站点开新会话（清空站点上下文） */
  async newSession(provider: Provider): Promise<void> {
    await this.registry.get(provider).newSession();
    this.log.info(`已请求 ${provider} 开新会话`);
  }

  /** 汇总三家状态 */
  providerStatus(): ProviderStatus[] {
    const notes = this.registry.notes();
    return this.registry.list().map((a) => ({
      provider: a.id,
      label: PROVIDER_META[a.id].label,
      adapter: a.kind,
      login: this.loginCache.get(a.id) ?? 'unknown',
      generating: this.isGenerating(a.id),
      ready: true,
      note: notes[a.id],
    }));
  }

  /** 重新探测登录态（前端点"刷新状态"或定时调用） */
  async refreshStatus(provider?: Provider): Promise<ProviderStatus[]> {
    const targets = provider ? [this.registry.get(provider)] : this.registry.list();
    for (const a of targets) {
      try {
        const login = await a.loginState();
        const changed = this.loginCache.get(a.id) !== login;
        this.loginCache.set(a.id, login);
        if (changed || provider) this.emitProviderStatus(a.id);
      } catch (err) {
        this.loginCache.set(a.id, 'error');
        this.emitProviderStatus(a.id);
        this.log.warn(`探测 ${a.id} 登录态失败：${String(err)}`);
      }
    }
    return this.providerStatus();
  }

  async diagnose(provider: Provider) {
    return this.registry.get(provider).diagnose();
  }

  activeRunCount(): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.status === 'pending' || run.status === 'streaming') n += 1;
    }
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* 内部实现                                                            */
  /* ------------------------------------------------------------------ */

  private isGenerating(provider: Provider): boolean {
    for (const run of this.runs.values()) {
      if (run.provider === provider && (run.status === 'pending' || run.status === 'streaming')) return true;
    }
    return false;
  }

  private async execute(run: RunRecord): Promise<void> {
    const adapter = this.registry.get(run.provider);
    run.adapter = adapter.kind;
    run.status = 'pending';

    this.emit(run, { type: 'reply.started', status: 'pending' });
    this.emitProviderStatus(run.provider);

    const sink: ReplySink = {
      onDelta: (content: string) => {
        if (run.finished) return;
        if (run.firstTokenMs === undefined) run.firstTokenMs = Date.now() - run.startedAt;
        run.content = content;
        run.status = 'streaming';
        this.emit(run, { type: 'reply.delta', content, firstTokenMs: run.firstTokenMs });
      },
      onDone: ({ content, reasoning, stopped }) => {
        if (run.finished) return;
        run.finished = true;
        run.content = content;
        run.reasoning = reasoning;
        run.status = 'done';
        this.emit(run, {
          type: 'reply.done',
          content,
          reasoning,
          stopped: !!stopped,
          latencyMs: Date.now() - run.startedAt,
          firstTokenMs: run.firstTokenMs,
          tokenEst: estimateTokens(content),
        });
        this.log.debug(
          `${run.provider} 完成：${content.length} 字，耗时 ${Date.now() - run.startedAt}ms` +
            `（首字 ${run.firstTokenMs ?? '—'}ms）`,
        );
      },
    };

    try {
      await this.bus.run(run.provider, () =>
        adapter.send(run.input, sink, {
          provider: run.provider,
          sessionId: run.sessionId,
          clientMsgId: run.clientMsgId,
          replyId: run.replyId,
          signal: run.controller.signal,
        }),
      );
      // 适配器正常返回但没调 onDone（实现有 bug）时的兜底
      if (!run.finished) {
        run.finished = true;
        run.status = 'done';
        this.emit(run, {
          type: 'reply.done',
          content: run.content,
          latencyMs: Date.now() - run.startedAt,
          firstTokenMs: run.firstTokenMs,
          tokenEst: estimateTokens(run.content),
        });
      }
    } catch (err) {
      const { message, code } = normalizeError(err);
      if (run.finished) {
        // 已经通过 onDone 收尾，忽略后续异常
      } else if (run.controller.signal.aborted) {
        run.finished = true;
        run.status = 'done';
        this.emit(run, {
          type: 'reply.done',
          content: run.content,
          latencyMs: Date.now() - run.startedAt,
          firstTokenMs: run.firstTokenMs,
          tokenEst: estimateTokens(run.content),
          stopped: true,
        });
      } else {
        run.finished = true;
        run.status = 'error';
        this.log.warn(`${run.provider} 回复失败：${message}（${code}）`);
        this.emit(run, { type: 'reply.error', error: message, errorCode: code, content: run.content });
      }
    } finally {
      this.emitProviderStatus(run.provider);
    }
  }

  private emit(run: RunRecord, event: ReplyEmit): void {
    // 把编排器负责的公共字段补齐；hub 再补 seq / ts
    this.hub.broadcast(run.sessionId, {
      ...event,
      replyId: run.replyId,
      clientMsgId: run.clientMsgId,
      provider: run.provider,
      sessionId: run.sessionId,
    } as unknown as ServerEventPayload);
  }

  private emitProviderStatus(provider: Provider): void {
    const note = this.registry.notes()[provider];
    // 全局事件：不区分订阅会话
    this.hub.broadcastAll({
      type: 'provider.status',
      provider,
      login: this.loginCache.get(provider) ?? 'unknown',
      generating: this.isGenerating(provider),
      adapter: this.registry.get(provider).kind,
      note,
    } as unknown as ServerEventPayload);
  }

  /** 运行记录上限保护：删掉最老的已结束记录 */
  private sweep(): void {
    if (this.runs.size <= MAX_RUNS) return;
    const finished = [...this.runs.values()]
      .filter((r) => r.finished)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const run of finished) {
      if (this.runs.size <= MAX_RUNS) break;
      this.runs.delete(run.replyId);
    }
  }
}
