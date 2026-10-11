/**
 * 后端入口：装配 Fastify + WebSocket + 适配器注册中心 + 编排器，并托管前端构建产物。
 *
 * 启动形态：
 *   开发：npm run dev        → 后端 8787 + Vite 5173（/api 与 /ws 由 Vite 代理到后端）
 *   生产：npm run build && npm start → 后端直接托管 packages/web/dist，只需一个端口
 */
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { WS_PATH, type ClientEvent } from '../../shared/src/index';
import { loadConfig, type AppConfig } from './config';
import { createLogger, setLogLevel } from './util/logger';
import { createRegistry } from './adapters/registry';
import { ProviderBus } from './core/bus';
import { Orchestrator } from './core/orchestrator';
import { Hub, type WsLike } from './ws/hub';
import { registerRoutes } from './http/routes';

/** 同一站点两次投递的最小间隔，降低触发风控的概率 */
const PROVIDER_MIN_GAP_MS = 300;

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const log = createLogger('server');

  const app = Fastify({
    logger: false,
    // 图片以 dataURL 走 JSON 请求体，默认 1MB 上限不够用
    bodyLimit: 32 * 1024 * 1024,
    disableRequestLogging: true,
  });

  /**
   * 允许"空 body 的 JSON 请求"。
   *
   * 背景（实测踩到的坑）：停止 / 重试 / 开新会话这类 POST 都是"只有动作、没有载荷"的，
   * 前端如果带上了 Content-Type: application/json 却没有 body，
   * Fastify 会直接用 400 FST_ERR_CTP_EMPTY_JSON_BODY 拒掉——
   * 表现就是"停止按钮点了没反应"。
   * 这里把空 body 归一化成 {}，让服务端对任何客户端都宽容（curl 手测也不会踩）。
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  await app.register(websocket);

  const registry = await createRegistry(cfg, log);
  const hub = new Hub();
  const bus = new ProviderBus(PROVIDER_MIN_GAP_MS);
  const orchestrator = new Orchestrator(registry, bus, hub, log);

  registerRoutes(app, { cfg, orchestrator, registry, hub, log });

  /* ------------------------------ WebSocket ------------------------------ */
  app.get(WS_PATH, { websocket: true }, (socket, _req) => {
    const s = socket as unknown as WsLike;
    hub.add(s);
    hub.hello(s);

    s.on('message', (raw: unknown) => {
      let msg: ClientEvent | null = null;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as ClientEvent;
      } catch {
        return; // 非法 JSON 直接忽略
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'subscribe' && typeof msg.sessionId === 'string') {
        hub.subscribe(s, msg.sessionId);
        log.debug(`WS 订阅会话 ${msg.sessionId}`);
      } else if (msg.type === 'unsubscribe' && typeof msg.sessionId === 'string') {
        hub.unsubscribe(s, msg.sessionId);
      }
      // ping：收到即证明链路存活，无需回包
    });
  });

  /* ------------------------------ 静态托管 ------------------------------ */
  const indexHtml = path.join(cfg.webDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: cfg.webDist, index: ['index.html'] });
    // SPA 兜底：非 /api、/ws 的 GET 一律回 index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api') || req.url.startsWith(WS_PATH)) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      reply.type('text/html; charset=utf-8').send(fs.readFileSync(indexHtml));
    });
    log.info(`已托管前端构建产物：${cfg.webDist}`);
  } else {
    log.info('未找到前端构建产物（packages/web/dist）。开发模式请用 `npm run dev` 走 Vite。');
  }

  await app.listen({ port: cfg.port, host: cfg.host });
  printBanner(cfg, registry.mode, registry.notes());

  /* ------------------------------ 优雅退出 ------------------------------ */
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info(`收到 ${signal}，正在释放资源…`);
    try {
      await registry.disposeAll();
      await app.close();
    } catch (err) {
      log.warn(`退出时出错：${String(err)}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function printBanner(cfg: AppConfig, mode: string, notes: Record<string, string | undefined>): void {
  const base = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
  const line = '─'.repeat(64);
  const modeText =
    mode === 'mock'
      ? '模拟通道（离线假回复，不需要浏览器与登录）'
      : mode === 'web'
        ? '网页版通道（Playwright 驱动 C 端网页）'
        : '官方 API 通道';

  console.log(`\n${line}`);
  console.log('  多 AI 聚合工作台 · 后端已启动');
  console.log(line);
  console.log(`  接口      ${base}/api`);
  console.log(`  WebSocket ${base.replace('http', 'ws')}${WS_PATH}`);
  console.log(`  通道      ${modeText}`);
  console.log(`  前端      http://127.0.0.1:5173   （开发模式，已代理 /api 与 /ws）`);
  console.log(`  数据目录  ${cfg.dataRoot}`);
  console.log(`  登录态目录 ${cfg.profileRoot}`);
  console.log(line);
  for (const [p, note] of Object.entries(notes)) {
    if (note) console.log(`  · ${p}: ${note}`);
  }
  if (mode === 'mock') {
    console.log(line);
    console.log('  模拟通道调试指令（直接写进输入框）：');
    console.log('    /fail   强制这一轮失败      /slow   放慢输出');
    console.log('    /long   生成长文本          /reason 附带思考过程');
  }
  console.log(`${line}\n`);
}

main().catch((err: unknown) => {
  console.error('\n[致命错误] 后端启动失败：');
  console.error(err);
  process.exit(1);
});
