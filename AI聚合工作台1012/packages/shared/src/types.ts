/**
 * 多 AI 聚合工作台 —— 前后端共享的数据模型
 *
 * 说明：Message / Reply 与需求文档给出的定义保持一致，
 *      仅追加了可选的统计字段（首字延迟、token 估算）与错误分类字段。
 */

/** 支持的 AI 提供方。新增 AI 时：这里加一个 id + 在 PROVIDER_META 补元信息 + 写一个 Adapter */
export type Provider = 'deepseek' | 'doubao' | 'kimi';

/** 回复状态机：pending(已投递待首字) → streaming(输出中) → done | error */
export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'error';

export type MessageRole = 'user' | 'assistant';

/** 登录态（浏览器通道专有；API 通道恒为 loggedIn） */
export type LoginState = 'unknown' | 'loggedIn' | 'needLogin' | 'needManual' | 'error';

/** 这条回复实际走的是哪条通道 */
export type AdapterKind = 'web' | 'api' | 'mock';

/** 错误分类：前端据此决定是提示"重新登录"还是给"重试" */
export type ErrorCode =
  | 'needLogin'   // 未登录 / 登录态失效
  | 'risk'        // 命中风控或人机验证，需要人工处理
  | 'selector'    // 站点改版导致选择器失效
  | 'timeout'     // 等待回答超时
  | 'network'     // 网络异常
  | 'aborted'     // 用户主动停止
  | 'unknown';

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  /** base64 dataURL 或可访问的 URL（P2 起由服务端落盘并返回 URL） */
  images?: string[];
  createdAt: number;
}

export interface Reply {
  id: string;
  /** 关联的用户消息 id */
  userMessageId: string;
  provider: Provider;
  content: string;
  status: ReplyStatus;
  /** 总耗时（毫秒）：从投递成功到回答结束 */
  latencyMs?: number;
  /** 首字延迟（毫秒）：从投递成功到第一个字符到达 */
  firstTokenMs?: number;
  /** token 估算值（网页版拿不到真实 usage，UI 上标注"估算"） */
  tokenEst?: number;
  /** 被用户主动停止 */
  stopped?: boolean;
  /** 站点渲染出来的思考过程（可选，前端折叠展示） */
  reasoning?: string;
  error?: string;
  errorCode?: ErrorCode;
  adapter?: AdapterKind;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Vote {
  replyId: string;
  kind: 'like' | 'best';
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* HTTP / WS 契约                                                      */
/* ------------------------------------------------------------------ */

export interface ImageRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  /** P2 起：服务端落盘后的绝对/相对路径（浏览器通道塞文件用） */
  path?: string;
  /** 前端预览用的 dataURL（P2 起可选，避免大体积） */
  dataUrl?: string;
}

export interface SendRequest {
  sessionId: string;
  /**
   * ★ 前端生成的消息批次 id。
   * 为什么需要它：WS 的 reply.* 事件可能比 POST /api/send 的响应先到，
   * 后端在每个事件里带上 clientMsgId，前端就能在拿到 replyId 之前完成关联。
   */
  clientMsgId: string;
  text: string;
  /** P1 直接传 dataURL；P2 起传服务端 uploads 返回的 imageId */
  images?: string[];
  providers: Provider[];
}

export interface SendResponse {
  messageId: string;
  replies: Array<{ replyId: string; provider: Provider; clientMsgId: string }>;
}

export interface ProviderStatus {
  provider: Provider;
  label: string;
  adapter: AdapterKind;
  login: LoginState;
  /** 该站点当前是否有正在生成的回答 */
  generating: boolean;
  /** 页面/通道是否就绪 */
  ready: boolean;
  /** 人工介入提示（如"出现滑块验证，请点击『召回到屏幕』后处理"） */
  note?: string;
}

/** 选择器命中诊断（站点改版排查用，P3 实现） */
export interface DiagReport {
  provider: Provider;
  mode: AdapterKind;
  checkedAt: number;
  hits: Array<{ field: string; selector: string; matched: boolean; count: number }>;
  note?: string;
}
