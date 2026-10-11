/**
 * WebSocket 客户端：自动重连 + 会话订阅 + 事件回调。
 *
 * 为什么不需要"补发丢失事件"的复杂逻辑（P1）：
 *   前端是会话状态的持有者，且 WS 只承载"正在生成的回复"的增量。
 *   重连后，未完成的回复仍会继续推 delta（后端 run 还在跑），
 *   所以只要重连成功并重新订阅，就能自然接上。
 *   P2 服务端成为权威存储后会引入 seq 校验 + 快照补发。
 */
import type { ClientEvent, ServerEvent } from '@shared';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsClientOptions {
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: WsStatus) => void;
}

export interface WsClient {
  connect(): void;
  close(): void;
  /** 切换订阅的会话（内部会记住，重连后自动重新订阅） */
  subscribe(sessionId: string | null): void;
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export function createWsClient(opts: WsClientOptions): WsClient {
  let socket: WebSocket | null = null;
  let retry = 0;
  let closedByUser = false;
  let currentSession: string | null = null;
  let pingTimer: number | null = null;

  const send = (msg: ClientEvent): void => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };

  const clearPing = (): void => {
    if (pingTimer !== null) {
      window.clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (closedByUser) return;
    // 指数退避，上限 8s
    const delay = Math.min(8000, 500 * 2 ** retry);
    retry += 1;
    window.setTimeout(() => connect(), delay);
  };

  function connect(): void {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    opts.onStatus('connecting');
    try {
      socket = new WebSocket(wsUrl());
    } catch {
      opts.onStatus('closed');
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      retry = 0;
      opts.onStatus('open');
      if (currentSession) send({ type: 'subscribe', sessionId: currentSession });
      clearPing();
      // 心跳：既保活，也让中间代理不主动断开
      pingTimer = window.setInterval(() => send({ type: 'ping' }), 25000);
    };

    socket.onmessage = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as ServerEvent;
        opts.onEvent(data);
      } catch {
        /* 忽略非法消息 */
      }
    };

    socket.onclose = () => {
      clearPing();
      socket = null;
      opts.onStatus('closed');
      scheduleReconnect();
    };

    socket.onerror = () => {
      // onerror 之后一定会有 onclose，这里不做处理以免重复重连
    };
  }

  return {
    connect,
    close(): void {
      closedByUser = true;
      clearPing();
      const s = socket;
      socket = null;
      if (!s) return;
      // 连接还在建立中就立刻 close() 会让浏览器报
      // "WebSocket is closed before the connection is established"（StrictMode 下必现）。
      // 等它 open 之后再关，日志就干净了。
      if (s.readyState === WebSocket.OPEN) {
        s.close();
      } else if (s.readyState === WebSocket.CONNECTING) {
        s.onmessage = null;
        s.onclose = null;
        s.onerror = null;
        s.onopen = () => s.close();
      }
      opts.onStatus('closed');
    },
    subscribe(sessionId: string | null): void {
      if (currentSession && currentSession !== sessionId) {
        send({ type: 'unsubscribe', sessionId: currentSession });
      }
      currentSession = sessionId;
      if (sessionId) send({ type: 'subscribe', sessionId });
    },
  };
}
