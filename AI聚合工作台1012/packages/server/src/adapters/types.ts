/**
 * ★ ChatAdapter —— 三家 AI（以及未来的新 AI）唯一的接入契约 ★
 *
 * 两条通道实现同一个接口，前端完全感知不到差异：
 *   - BrowserAdapter（路线 A）：Playwright 驱动三家 C 端网页版
 *   - ApiAdapter（路线 B）    ：三家官方 API
 *   - MockAdapter            ：离线假回复，用于前端联调（不装浏览器、不登录、不联网）
 *
 * 新增一个 AI 的步骤：
 *   1. shared/src/types.ts 的 Provider 联合类型里加 id
 *   2. shared/src/constants.ts 的 PROVIDER_META 里补展示元信息
 *   3. 写一个实现本接口的 Adapter，并在 adapters/registry.ts 注册
 */
import type {
  AdapterKind,
  DiagReport,
  ErrorCode,
  LoginState,
  Provider,
} from '../../../shared/src/index';

/** 一次投递的输入：文字 + 图片（P1 是 dataURL；P2 起是服务端落盘后的文件路径） */
export interface SendInput {
  text: string;
  images: string[];
}

/** 适配器把流式结果回吐给编排器的回调 */
export interface ReplySink {
  /** 增量文本：content 是**累计全文**，不是片段 */
  onDelta(content: string): void;
  /** 结束（stopped=true 表示被用户主动停止） */
  onDone(result: { content: string; reasoning?: string; stopped?: boolean }): void;
}

export interface SendContext {
  provider: Provider;
  sessionId: string;
  clientMsgId: string;
  replyId: string;
  /** 用户点"停止"时被 abort */
  signal: AbortSignal;
}

export interface ChatAdapter {
  readonly id: Provider;
  readonly kind: AdapterKind;

  /** 准备就绪（打开页面 / 建立连接 / 校验 Key），幂等 */
  ensureReady(): Promise<void>;

  /** 登录态探测（API 通道恒为 loggedIn） */
  loginState(): Promise<LoginState>;

  /**
   * 投递一条消息并等待回答。
   * 实现约定：
   *   - 至少调用一次 sink.onDelta 或 sink.onDone
   *   - 被 abort 时应尽快返回，sink.onDone({ stopped: true })
   *   - 失败时抛 AdapterError（带错误分类）
   */
  send(input: SendInput, sink: ReplySink, ctx: SendContext): Promise<void>;

  /** 停止当前生成 */
  stop(): Promise<void>;

  /** 站内开新会话（清空站点上下文） */
  newSession(): Promise<void>;

  /** 当前是否正在生成 */
  isGenerating(): boolean;

  /** 选择器 / 连通性诊断（站点改版排查） */
  diagnose(): Promise<DiagReport>;

  /** 释放资源（关闭浏览器上下文等） */
  dispose(): Promise<void>;
}

/** 便于实现的基类：默认行为 + 状态记录 */
export abstract class BaseAdapter implements ChatAdapter {
  abstract readonly id: Provider;
  abstract readonly kind: AdapterKind;

  protected generating = false;
  /** 适配器自身给前端的状态说明（如"web 通道未实现，已回退 mock"） */
  note?: string;

  abstract ensureReady(): Promise<void>;
  abstract loginState(): Promise<LoginState>;
  abstract send(input: SendInput, sink: ReplySink, ctx: SendContext): Promise<void>;

  async stop(): Promise<void> {
    this.generating = false;
  }

  async newSession(): Promise<void> {
    /* 默认无操作；网页通道会去点站点的"新建对话" */
  }

  isGenerating(): boolean {
    return this.generating;
  }

  async diagnose(): Promise<DiagReport> {
    return {
      provider: this.id,
      mode: this.kind,
      checkedAt: Date.now(),
      hits: [],
      note: '该通道未提供选择器诊断',
    };
  }

  async dispose(): Promise<void> {
    this.generating = false;
  }
}

/** 供子类使用：把错误码统一抛出 */
export type { ErrorCode };
