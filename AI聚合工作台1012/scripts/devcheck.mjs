/**
 * 开发模式自检：验证 `npm run dev` 这条日常命令本身可用，
 * 以及 Vite 的 /api 与 /ws **代理**真的能把请求转到后端。
 *
 * 为什么单独测这一层：
 *   verify.mjs 跑的是生产模式（Fastify 直接托管 dist，同源、无代理），
 *   而日常开发走的是 Vite 5173 → 代理到 8787，这条链路完全没被覆盖过。
 *
 * 用法：node scripts/devcheck.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.join(root, '.tmp', 'shots');
const logFile = path.join(root, '.tmp', 'dev.log');
fs.mkdirSync(shotsDir, { recursive: true });

const isWin = process.platform === 'win32';
const NODE = process.execPath;
const DEV_BASE = 'http://127.0.0.1:5173';
const API_BASE = 'http://127.0.0.1:8787';

const cleanEnv = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' };
const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口预检：占到陈旧实例上会让结论完全失真，所以宁可提前失败 */
async function portInUse(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(Number(port), '127.0.0.1');
  });
}

/** 同步结束整棵进程树，避免留下占端口的孤儿 */
function killTree(pid) {
  if (!pid) return;
  if (isWin) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* 已退出 */
      }
    }
  }
}

/** 页面探针：同时确认前端渲染出来了、消息发出去了、WebSocket 是连上的 */
const DEV_PROBE = `(() => {
  const hasInput = !!document.querySelector('[data-testid="composer-input"]');
  const hasSend = !!document.querySelector('[data-testid="composer-send"]');
  const hasStop = !!document.querySelector('[data-testid="composer-stop"]');
  const blocks = [...document.querySelectorAll('.md')].map((e) => e.innerText.trim().length);
  const wsTitle = document.querySelector('[title*="WebSocket"]')?.getAttribute('title') ?? '';
  const columns = document.querySelectorAll('[data-testid^="column-"]').length;
  return { hasInput, hasSend, hasStop, columns, mdCount: blocks.length, mdLen: blocks.reduce((a, b) => a + b, 0), wsTitle };
})()`;

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  return false;
}

/** 跑一次截图脚本，捕获 stdout 以便解析探针结果 */
function shotProbe(outName, steps) {
  return new Promise((resolve) => {
    const args = ['scripts/shot.mjs', DEV_BASE, path.join(shotsDir, outName)];
    for (const s of steps) args.push('--do', s);
    const child = spawn(NODE, args, { cwd: root, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

let dev = null;
try {
  fs.rmSync(path.join(root, '.tmp', 'msedge-profile'), { recursive: true, force: true });

  // 预检：8787 与 5173 都不能被占，否则会测到旧实例
  for (const port of [8787, 5173]) {
    if (await portInUse(port)) {
      check(
        `端口 ${port} 空闲`,
        false,
        `已被占用；先结束占用进程：Get-NetTCPConnection -LocalPort ${port} | ForEach-Object { taskkill /PID $_.OwningProcess /T /F }`,
      );
      throw new Error(`端口 ${port} 被占用，已中止`);
    }
  }

  console.log('\n=== 启动 npm run dev（后端 8787 + Vite 5173）===');
  const logFd = fs.openSync(logFile, 'w');
  dev = spawn(NODE, ['scripts/dev.mjs'], {
    cwd: root,
    stdio: ['ignore', logFd, logFd],
    env: cleanEnv,
    detached: !isWin,
  });

  const apiUp = await waitHttp(`${API_BASE}/api/health`, 45000);
  check('后端 8787 起来（经 dev.mjs 拉起）', apiUp, apiUp ? '' : `详见 ${logFile}`);

  const webUp = await waitHttp(DEV_BASE, 60000);
  check('Vite 5173 起来', webUp, webUp ? '' : `详见 ${logFile}`);
  if (!webUp) throw new Error('Vite 没起来');

  // 经 Vite 代理访问后端接口：这是 /api 代理是否生效的直接证据
  const proxied = await fetch(`${DEV_BASE}/api/health`).then((r) => r.json()).catch(() => null);
  check('Vite 的 /api 代理转发到后端', !!proxied?.ok, proxied ? `mode=${proxied.mode}` : '拿不到响应');

  console.log('\n=== 在 5173 页面上真实发一条消息（走 /ws 代理收流）===');
  const { code, out } = await shotProbe('dev-01-send.png', [
    `fill:[data-testid="composer-input"]=>开发模式自检：请用一句话说明你是谁`,
    'click:[data-testid="composer-send"]',
    'wait:5000',
    `eval:${DEV_PROBE}`,
  ]);
  check('页面操作执行成功', code === 0, out.includes('page error') ? '页面报错见下' : '');
  if (out.includes('page error')) console.log(out);

  const m = out.match(/eval → (.*)/);
  let probe = null;
  try {
    probe = m ? JSON.parse(m[1]) : null;
  } catch {
    /* 忽略 */
  }
  // 注意：正在流式输出时，输入区显示的是「停止 N」而不是「发送」，
  // 所以这里只要求"输入框在，且发送/停止二选一在"，否则会误判成失败
  check(
    '前端渲染出三列与输入区',
    !!probe && probe.hasInput && (probe.hasSend || probe.hasStop) && probe.columns === 3,
    JSON.stringify(probe),
  );
  check('/ws 代理连通（顶部状态显示已连接）', !!probe && probe.wsTitle.includes('已连接'), probe?.wsTitle ?? '');
  check(
    '流式内容经 WS 到达页面',
    !!probe && probe.mdCount >= 3 && probe.mdLen > 100,
    probe ? `mdCount=${probe.mdCount} mdLen=${probe.mdLen}` : '',
  );
  check('页面没有 JS 报错', !out.includes('[page error]'), out.includes('[page error]') ? '见上方日志' : '');
} catch (err) {
  check('开发模式自检完整执行', false, err instanceof Error ? err.message : String(err));
} finally {
  if (dev) {
    // 同步回收整棵树：dev.mjs → tsx watch / vite → 各自的子进程
    killTree(dev.pid);
  }
  await sleep(1200);
  // 清理是否彻底，直接影响下一次能不能跑
  for (const port of [8787, 5173]) {
    if (await portInUse(port)) console.log(`  ⚠ 端口 ${port} 仍被占用，清理可能不彻底`);
  }
  console.log(`\ndev 日志：${logFile}`);
  if (failures.length > 0) {
    console.log(`\n❌ 开发模式自检失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  · ${f}`);
  } else {
    console.log('\n✅ 开发模式自检全部通过');
  }
  process.exit(failures.length > 0 ? 1 : 0);
}
