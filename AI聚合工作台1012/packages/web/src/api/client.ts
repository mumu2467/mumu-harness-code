/**
 * HTTP 客户端：统一的错误处理（网络异常 / 非 2xx / 业务错误都收敛成 Error.message）。
 * 前端只关心 message 与可选 code，措辞统一在这里兜底。
 */
import type { DiagReport, Provider, ProviderStatus, SendRequest, SendResponse } from '@shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 只有真的带载荷时才声明 Content-Type：
  // 否则 Fastify 会因为"声明了 JSON 却没有 body"直接 400
  const hasBody = init?.body !== undefined && init.body !== null;
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (hasBody) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new Error('无法连接后端服务，请确认 `npm run dev` 的后端已启动');
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : null) ?? `请求失败（HTTP ${res.status}）`;
    throw new Error(msg);
  }
  return data as T;
}

export interface HealthResponse {
  ok: boolean;
  /** 实际生效的通道 */
  mode: 'mock' | 'web' | 'api';
  /** .env 里配置的通道 */
  configuredMode: string;
  uptimeMs: number;
  activeRuns: number;
  providers: ProviderStatus[];
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  send: (body: SendRequest) =>
    request<SendResponse>('/api/send', { method: 'POST', body: JSON.stringify(body) }),

  stopReply: (replyId: string) =>
    request<{ ok: boolean }>(`/api/replies/${encodeURIComponent(replyId)}/stop`, {
      method: 'POST',
      body: '{}',
    }),

  retryReply: (replyId: string) =>
    request<{ ok: boolean }>(`/api/replies/${encodeURIComponent(replyId)}/retry`, {
      method: 'POST',
      body: '{}',
    }),

  providersStatus: (refresh = false) =>
    request<{ providers: ProviderStatus[] }>(`/api/providers/status${refresh ? '?refresh=1' : ''}`),

  newProviderSession: (provider: Provider) =>
    request<{ ok: boolean }>(`/api/providers/${provider}/new-session`, { method: 'POST', body: '{}' }),

  diag: (provider?: Provider) =>
    request<{ mode: string; reports: DiagReport[] }>(
      `/api/diag/selectors${provider ? `?provider=${provider}` : ''}`,
    ),
};
