/**
 * WS Hub —— 连接管理、按会话订阅、事件广播、seq 单调序号。
 *
 * 为什么按 sessionId 订阅而不是广播给所有人：
 *   多标签页 / 多设备同时打开时，各自只关心自己正在看的会话；
 *   同时 seq 让前端能在断线重连后判断"是否漏了事件"。
 */
import type { ServerEvent, ServerEventPayload } from '../../../shared/src/index';

/** 只依赖 ws 的最小接口，避免为了类型再引入 @types/ws */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
  close(): void;
}

/** ws 里 OPEN 的常量值是 1 */
const OPEN = 1;

export class Hub {
  private readonly sockets = new Map<WsLike, Set<string>>();
  private seq = 0;

  add(socket: WsLike): void {
    this.sockets.set(socket, new Set());
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
  }

  remove(socket: WsLike): void {
    this.sockets.delete(socket);
  }

  subscribe(socket: WsLike, sessionId: string): void {
    const subs = this.sockets.get(socket);
    if (subs) subs.add(sessionId);
  }

  unsubscribe(socket: WsLike, sessionId: string): void {
    this.sockets.get(socket)?.delete(sessionId);
  }

  /** 连接建立时发一个 hello，方便前端确认通道可用 */
  hello(socket: WsLike): void {
    this.sendTo(socket, { type: 'hello', serverTime: Date.now() });
  }

  /** 广播给订阅了该会话的所有连接 */
  broadcast(sessionId: string, event: ServerEventPayload): void {
    const full = { ...event, seq: (this.seq += 1), ts: Date.now() } as ServerEvent;
    const payload = JSON.stringify(full);
    for (const [socket, subs] of this.sockets) {
      if (subs.has(sessionId) && socket.readyState === OPEN) {
        try {
          socket.send(payload);
        } catch {
          // 单个连接发送失败不影响其他人
        }
      }
    }
  }

  /**
   * 广播给**所有**连接（不区分订阅的会话）。
   * 用于 provider.status 这类全局事件：登录态/生成中状态与具体会话无关。
   */
  broadcastAll(event: ServerEventPayload): void {
    const full = { ...event, seq: (this.seq += 1), ts: Date.now() } as ServerEvent;
    const payload = JSON.stringify(full);
    for (const socket of this.sockets.keys()) {
      if (socket.readyState === OPEN) {
        try {
          socket.send(payload);
        } catch {
          /* 单个连接失败不影响其他人 */
        }
      }
    }
  }

  private sendTo(socket: WsLike, event: ServerEventPayload): void {
    if (socket.readyState !== OPEN) return;
    const full = { ...event, seq: (this.seq += 1), ts: Date.now() } as ServerEvent;
    try {
      socket.send(JSON.stringify(full));
    } catch {
      /* 忽略 */
    }
  }
}
