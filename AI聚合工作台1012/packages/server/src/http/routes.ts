/**
 * HTTP 路由层。只做"校验入参 → 调编排器 → 返回结果"，不含业务状态。
 *
 * 入参校验手写而不引 zod：需要校验的字段很少，且错误信息可以写得更贴近中文语境。
 */
import type { FastifyInstance } from 'fastify';
import {
  PROVIDER_ORDER,
  type Provider,
  type SendRequest,
} from '../../../shared/src/index';
import type { AppConfig } from '../config';
import type { Orchestrator } from '../core/orchestrator';
import type { AdapterRegistry } from '../adapters/registry';
import type { Logger } from '../util/logger';
import type { Hub } from '../ws/hub';

export interface RouteDeps {
  cfg: AppConfig;
  orchestrator: Orchestrator;
  registry: AdapterRegistry;
  hub: Hub;
  log: Logger;
}

/** 单张图片最大 8MB（base64 后的字符串长度上限） */
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;
const MAX_IMAGES = 8;

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

function validateSend(body: unknown): ValidationResult<SendRequest> {
  if (!body || typeof body !== 'object') return { ok: false, message: '请求体必须是 JSON 对象' };
  const b = body as Record<string, unknown>;

  const sessionId = typeof b.sessionId === 'string' ? b.sessionId.trim() : '';
  if (!sessionId) return { ok: false, message: 'sessionId 必填' };

  const clientMsgId = typeof b.clientMsgId === 'string' ? b.clientMsgId.trim() : '';
  if (!clientMsgId) return { ok: false, message: 'clientMsgId 必填' };

  if (typeof b.text !== 'string') return { ok: false, message: 'text 必须是字符串' };
  const text = b.text;

  const images = Array.isArray(b.images) ? b.images : [];
  if (images.length > MAX_IMAGES) return { ok: false, message: `图片最多 ${MAX_IMAGES} 张` };
  for (const img of images) {
    if (typeof img !== 'string') return { ok: false, message: 'images 必须是字符串数组（dataURL）' };
    if (img.length > MAX_IMAGE_CHARS) return { ok: false, message: '单张图片超过 8MB 上限，请压缩后再发' };
  }

  const rawProviders = Array.isArray(b.providers) ? b.providers : [];
  const providers = rawProviders.filter(
    (p): p is Provider => typeof p === 'string' && (PROVIDER_ORDER as string[]).includes(p),
  );
  if (providers.length === 0) return { ok: false, message: 'providers 至少要勾选一个 AI' };
  if (text.trim().length === 0 && images.length === 0) {
    return { ok: false, message: '文字与图片不能同时为空' };
  }

  return {
    ok: true,
    value: { sessionId, clientMsgId, text, images: images as string[], providers },
  };
}

function isProvider(v: string): v is Provider {
  return (PROVIDER_ORDER as string[]).includes(v);
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { orchestrator, registry, cfg, log } = deps;
  const startedAt = Date.now();

  /* ---------------- 健康检查 ---------------- */
  app.get('/api/health', async () => ({
    ok: true,
    mode: registry.mode,
    configuredMode: cfg.adapterMode,
    uptimeMs: Date.now() - startedAt,
    activeRuns: orchestrator.activeRunCount(),
    providers: orchestrator.providerStatus(),
  }));

  /* ---------------- 发送 ---------------- */
  app.post('/api/send', async (req, reply) => {
    const checked = validateSend(req.body);
    if (!checked.ok) {
      reply.code(400);
      return { error: checked.message };
    }
    return orchestrator.start(checked.value);
  });

  /* ---------------- 单条回复的控制 ---------------- */
  app.post<{ Params: { id: string } }>('/api/replies/:id/stop', async (req, reply) => {
    const ok = orchestrator.stop(req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: '该回复不存在或已经结束' };
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/replies/:id/retry', async (req, reply) => {
    const ok = orchestrator.retry(req.params.id);
    if (!ok) {
      reply.code(409);
      return { error: '该回复不存在，或仍在生成中' };
    }
    return { ok: true };
  });

  /* ---------------- 提供方状态与操作 ---------------- */
  app.get('/api/providers/status', async (req) => {
    const refresh = (req.query as Record<string, string> | undefined)?.refresh === '1';
    if (refresh) return { providers: await orchestrator.refreshStatus() };
    return { providers: orchestrator.providerStatus() };
  });

  app.post<{ Params: { id: string } }>('/api/providers/:id/new-session', async (req, reply) => {
    if (!isProvider(req.params.id)) {
      reply.code(400);
      return { error: `未知的 provider: ${req.params.id}` };
    }
    await orchestrator.newSession(req.params.id);
    return { ok: true };
  });

  /** 登录态刷新（浏览器通道用；mock/api 恒为已登录） */
  app.post<{ Params: { id: string } }>('/api/providers/:id/refresh-status', async (req, reply) => {
    if (!isProvider(req.params.id)) {
      reply.code(400);
      return { error: `未知的 provider: ${req.params.id}` };
    }
    return { providers: await orchestrator.refreshStatus(req.params.id) };
  });

  /* ---------------- 选择器诊断 ---------------- */
  app.get('/api/diag/selectors', async (req, reply) => {
    const q = (req.query as Record<string, string> | undefined)?.provider;
    let targets: Provider[] = [...PROVIDER_ORDER];
    if (typeof q === 'string' && q !== '') {
      if (!isProvider(q)) {
        reply.code(400);
        return { error: `未知的 provider: ${q}` };
      }
      targets = [q];
    }
    const reports = await Promise.all(targets.map((p) => orchestrator.diagnose(p)));
    return { mode: registry.mode, reports };
  });

  log.debug(`已注册 HTTP 路由（通道模式：${registry.mode}）`);
}
