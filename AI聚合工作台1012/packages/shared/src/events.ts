/**
 * WebSocket 事件契约（前后端唯一真源）
 *
 * 设计要点：
 * 1. 每个 reply.* 事件都同时带 replyId 和 clientMsgId + provider：
 *    因为事件可能比 POST /api/send 的响应先到，前端靠 clientMsgId+provider 先关联，
 *    拿到响应后再把 replyId 补上（用于停止 / 重试）。
 * 2. reply.delta 传的是**累计全文**而不是增量片段：
 *    前端直接覆盖渲染，天然免疫丢帧与乱序导致的文本错乱。
 * 3. 所有事件带 seq 单调序号，前端断线重连后可判断是否需要重新拉取会话快照。
 */
import type { ErrorCode, LoginState, Provider, Reply, ReplyStatus } from './types';

export interface EventBase {
  seq: number;
  ts: number;
}

export interface ReplyEventBase extends EventBase {
  replyId: string;
  clientMsgId: string;
  provider: Provider;
  sessionId: string;
}

export type ServerEvent =
  /** 连接建立 */
  | ({ type: 'hello'; serverTime: number } & EventBase)
  /** 已投递，等待首字 */
  | ({ type: 'reply.started'; status: Extract<ReplyStatus, 'pending'> } & ReplyEventBase)
  /** 流式增量：content 为累计全文 */
  | ({ type: 'reply.delta'; content: string; firstTokenMs?: number } & ReplyEventBase)
  /** 回答完成 */
  | ({
      type: 'reply.done';
      content: string;
      latencyMs: number;
      firstTokenMs?: number;
      tokenEst: number;
      stopped?: boolean;
      reasoning?: string;
    } & ReplyEventBase)
  /** 回答失败 */
  | ({
      type: 'reply.error';
      error: string;
      errorCode: ErrorCode;
      content: string;
      reasoning?: string;
    } & ReplyEventBase)
  /** 提供方状态变化（登录态 / 是否在生成） */
  | ({
      type: 'provider.status';
      provider: Provider;
      login: LoginState;
      generating: boolean;
      adapter: Reply['adapter'];
      note?: string;
    } & EventBase)
  /** 观测窗画面（P5 才启用，先占位） */
  | ({ type: 'view.frame'; provider: Provider; jpeg: string; fps: number } & EventBase);

export type ClientEvent =
  /** 订阅某个会话的事件流 */
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'ping' };

/**
 * 注意：TS 内置的 Omit 作用在**联合类型**上不会分发，只会保留各分支的公共字段，
 * 因此这里手写一个分发版本，否则 hello 的 serverTime、reply.delta 的 content 都会丢。
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 服务端事件在 Hub 内部补上 seq / ts 之前的形态 */
export type ServerEventPayload = DistributiveOmit<ServerEvent, 'seq' | 'ts'>;


/** 服务端 → 客户端：请求全量快照（重连补发用） */
export interface SnapshotRequest {
  type: 'snapshot';
  sessionId: string;
}
