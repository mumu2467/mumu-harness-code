/**
 * 一键自检：构建前端 → 起后端 → 后端端到端烟测 → 驱动真实浏览器截图两个页面并做布局断言。
 *
 * 为什么把这些步骤合到一个脚本：
 *   vite / tsx 都依赖 esbuild，而 esbuild 必须用管道启动自己的服务进程；
 *   在受限沙箱里"管道 spawn"会被拒绝（EPERM）。把整条链路收进一个脚本，
 *   就能一次性授权完成全部验证，而不是零散地反复申请。
 *
 * 用法：node scripts/verify.mjs
 * 产物：.tmp/shots/*.png 与终端里的断言报告
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.join(root, '.tmp', 'shots');
const profileDir = path.join(root, '.tmp', 'msedge-profile');
const logFile = path.join(root, '.tmp', 'server.log');
fs.mkdirSync(shotsDir, { recursive: true });

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const PORT = process.env.PORT ?? '8787';
const BASE = `http://127.0.0.1:${PORT}`;
const NODE = process.execPath;

// 子进程统一清掉指向已关闭代理的环境变量，否则 npm / 网络请求会 ECONNREFUSED
const cleanEnv = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' };

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` (${detail})` : ''}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      shell: opts.shell ?? false,
      env: cleanEnv,
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`  ⚠ 无法启动 ${cmd}：${err.message}`);
      resolve(1);
    });
  });
}

/** 跑一次截图脚本，返回退出码；步骤通过 --do 传入 */
function shot(outName, steps = [], size) {
  const args = ['scripts/shot.mjs', BASE, path.join(shotsDir, outName)];
  if (size) args.push('--w', String(size[0]), '--h', String(size[1]));
  for (const s of steps) args.push('--do', s);
  return run(NODE, args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 端口预检。
 *
 * 为什么要做：实测踩过一次坑 —— 上一轮自检残留的后端还占着 8787，
 * 新起的后端 EADDRINUSE 直接死掉，而 Vite 代理连到了那个**陈旧实例**上，
 * 于是"页面正常、三列都在、就是消息发不出去"，很难定位。
 * 与其相信环境干净，不如开机先检查。
 */
async function portInUse(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(Number(port), '127.0.0.1');
  });
}

/** 结束整棵进程树（同步等待，确保不会留下占端口的孤儿进程） */
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

/** 轮询后端健康检查 */
async function waitHealth(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  return null;
}

/** 三个窗口在桌面端应全部可见；移动端只显示一个 */
const COLUMN_PROBE = `(() => {
  const ids = ['deepseek','doubao','kimi'];
  const out = {};
  for (const id of ids) {
    const el = document.querySelector('[data-testid="column-' + id + '"]');
    out[id] = !!el && el.getBoundingClientRect().width > 4 && getComputedStyle(el).display !== 'none';
  }
  return out;
})()`;

/**
 * 聚合页非空白断言：
 * 只看截图无法区分"渲染正常"和"React 崩了之后的白屏"，所以直接数 DOM。
 */
const AGG_PROBE = `(() => {
  const tabs = document.querySelectorAll('[data-testid^="tab-"]').length;
  const best = document.querySelectorAll('[data-testid="vote-best"]').length;
  const mdBlocks = document.querySelectorAll('.md').length;
  const text = document.body.innerText.trim().length;
  return { tabs, best, mdBlocks, text };
})()`;

/** 从一个 eval 步骤的 stdout 里抠出 JSON 对象 */
function parseEvalLog(text) {
  const m = text.match(/eval → (.*)/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

let server = null;
try {
  // 每次自检都从干净的截图目录开始，避免旧的 *-error.png 混淆结论
  fs.rmSync(shotsDir, { recursive: true, force: true });
  fs.mkdirSync(shotsDir, { recursive: true });

  console.log('\n=== [1/5] 类型检查 + 构建前端 ===');
  const typeCode = await run(npm, ['run', 'typecheck'], { shell: isWin });
  check('前后端类型检查通过', typeCode === 0, `exit=${typeCode}`);

  const buildCode = await run(npm, ['run', 'build', '-w', '@aiwb/web'], { shell: isWin });
  check('前端构建成功', buildCode === 0, `exit=${buildCode}`);
  check('产物存在', fs.existsSync(path.join(root, 'packages/web/dist/index.html')));
  if (buildCode !== 0) throw new Error('构建失败，后续步骤无法进行');

  console.log('\n=== [2/5] 启动后端（tsx）===');
  // 端口预检：占着端口会让测试连到陈旧实例上，必须直接中止
  if (await portInUse(PORT)) {
    check(
      `端口 ${PORT} 空闲`,
      false,
      `已被占用；先结束占用进程：Get-NetTCPConnection -LocalPort ${PORT} | ForEach-Object { taskkill /PID $_.OwningProcess /T /F }`,
    );
    throw new Error(`端口 ${PORT} 被占用，已中止（避免测到陈旧实例）`);
  }
  // 浏览器 profile 清掉，保证首页是"空态"，截图可重复
  fs.rmSync(profileDir, { recursive: true, force: true });
  const logFd = fs.openSync(logFile, 'w');
  server = spawn(NODE, ['--import', 'tsx', path.join(root, 'packages/server/src/index.ts')], {
    cwd: root,
    // 用文件描述符而不是管道，受限环境下也能拿到日志
    stdio: ['ignore', logFd, logFd],
    env: { ...cleanEnv, PORT, HOST: '127.0.0.1' },
  });
  const health = await waitHealth();
  check('后端健康检查通过', !!health, health ? `mode=${health.mode}` : `详见 ${logFile}`);
  if (!health) throw new Error('后端未能启动');

  console.log('\n=== [3/5] 后端端到端烟测 ===');
  const smokeCode = await run(NODE, ['scripts/smoke.mjs', BASE]);
  check('后端烟测全部通过', smokeCode === 0, `exit=${smokeCode}`);

  console.log('\n=== [4/5] 页面截图与布局断言 ===');
  const MSG = '请用三点说明：为什么需要把同一个问题同时问多个 AI？';
  // 视图偏好（三窗并发 / 聚合对话）会被持久化在 localStorage 里，
  // 所以每个场景都要先把视图点回自己需要的那个，保证可重复
  const OPEN_CONCURRENT = 'click:[data-testid="view-concurrent"]';
  const OPEN_AGGREGATE = 'click:[data-testid="view-aggregate"]';

  // ① 三窗并发 · 空态（profile 已清空，默认就是并发页）
  await shot('01-concurrent-empty.png', ['wait:600', `eval:${COLUMN_PROBE}`]);
  console.log('   （空态截图完成：01-concurrent-empty.png）');

  // ② 三窗并发 · 流式中
  const code2 = await shot('02-concurrent-streaming.png', [
    OPEN_CONCURRENT,
    `fill:[data-testid="composer-input"]=>${MSG}`,
    'click:[data-testid="composer-send"]',
    'wait:2600',
  ]);
  check('三窗并发页可发送并进入流式', code2 === 0);

  // ③ 三窗并发 · 全部完成
  const code3 = await shot('03-concurrent-done.png', [
    OPEN_CONCURRENT,
    `fill:[data-testid="composer-input"]=>${MSG}`,
    'click:[data-testid="composer-send"]',
    'wait:12000',
  ]);
  check('三窗并发页完成态截图成功', code3 === 0);

  // ④ 聚合对话页（再发一轮，保证有完整的三家回复可切换/并排）
  const code4 = await shot('04-aggregate.png', [
    OPEN_CONCURRENT,
    `fill:[data-testid="composer-input"]=>${MSG}`,
    'click:[data-testid="composer-send"]',
    'wait:12000',
    OPEN_AGGREGATE,
    'wait:900',
  ]);
  check('聚合对话页截图成功', code4 === 0);

  // ④b 聚合页真的渲染了内容吗（防止 React 崩掉后的白屏被当成"截图成功"）
  const aggProbe = spawn(
    NODE,
    ['scripts/shot.mjs', BASE, path.join(shotsDir, '10-aggregate-probe.png'), '--do', OPEN_AGGREGATE, '--do', 'wait:900', '--do', `eval:${AGG_PROBE}`],
    { cwd: root, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let aggOut = '';
  aggProbe.stdout.on('data', (d) => (aggOut += String(d)));
  await new Promise((r) => aggProbe.on('exit', r));
  const agg = parseEvalLog(aggOut);
  check(
    '聚合页渲染出切换控件/投票/正文（非白屏）',
    !!agg && agg.tabs >= 3 && agg.best >= 1 && agg.mdBlocks >= 1 && agg.text > 300,
    JSON.stringify(agg),
  );

  // ⑤ 气泡内切换 provider（淡入替换 + 保留滚动位置）
  const code5 = await shot('05-aggregate-tab-doubao.png', [
    OPEN_AGGREGATE,
    'wait:500',
    'click:[data-testid="tab-doubao"]',
    'wait:700',
  ]);
  check('聚合页 provider 切换可用', code5 === 0);

  // ⑥ 并排对比模式
  const code6 = await shot('06-aggregate-parallel.png', [
    OPEN_AGGREGATE,
    'wait:400',
    'click:[data-testid="parallel-toggle"]',
    'wait:900',
  ]);
  check('并排对比模式可用', code6 === 0);

  // ⑦ 投票（点赞 + 最佳答案）
  const code7 = await shot('07-aggregate-voted.png', [
    OPEN_AGGREGATE,
    'wait:400',
    'click:[data-testid="vote-like"]',
    'click:[data-testid="vote-best"]',
    'wait:500',
  ]);
  check('投票交互可用', code7 === 0);

  // ⑧ 移动端（<768px 应变 Tab 切换）
  const code8 = await shot('08-mobile-tab.png', [OPEN_CONCURRENT, 'wait:900'], [420, 900]);
  check('移动端截图成功', code8 === 0);

  // ⑨ 响应式布局断言：1440 → 三列全部可见；420 → 只显示一个窗口
  const probe = spawn(
    NODE,
    ['scripts/shot.mjs', BASE, path.join(shotsDir, '09-desktop-probe.png'), '--do', OPEN_CONCURRENT, '--do', 'wait:600', '--do', `eval:${COLUMN_PROBE}`],
    { cwd: root, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let probeOut = '';
  probe.stdout.on('data', (d) => (probeOut += String(d)));
  await new Promise((r) => probe.on('exit', r));
  const desktopCols = parseEvalLog(probeOut);
  check(
    '1440 宽三列全部显示',
    !!desktopCols && desktopCols.deepseek === true && desktopCols.doubao === true && desktopCols.kimi === true,
    JSON.stringify(desktopCols),
  );

  const probe2 = spawn(
    NODE,
    ['scripts/shot.mjs', BASE, path.join(shotsDir, '09-mobile-probe.png'), '--w', '420', '--h', '900', '--do', OPEN_CONCURRENT, '--do', 'wait:600', '--do', `eval:${COLUMN_PROBE}`],
    { cwd: root, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let probeOut2 = '';
  probe2.stdout.on('data', (d) => (probeOut2 += String(d)));
  await new Promise((r) => probe2.on('exit', r));
  const mobileCols = parseEvalLog(probeOut2);
  const visibleCount = mobileCols ? Object.values(mobileCols).filter(Boolean).length : -1;
  check('420 宽只显示一个窗口（Tab 模式）', visibleCount === 1, `可见窗口数=${visibleCount} ${JSON.stringify(mobileCols)}`);

  console.log('\n=== [5/5] 汇总 ===');
  const shots = fs.readdirSync(shotsDir).filter((f) => f.endsWith('.png')).sort();
  console.log(`截图产物（${shots.length} 张，位于 .tmp/shots/）：`);
  for (const s of shots) console.log(`  · ${s}`);
} catch (err) {
  check('自检流程完整执行', false, err instanceof Error ? err.message : String(err));
} finally {
  if (server && !server.killed) {
    // 同步回收整棵进程树（tsx 下面还挂着 esbuild 服务进程）
    killTree(server.pid);
  }
  await sleep(800);
  console.log(`\n后端日志：${logFile}`);
  if (failures.length > 0) {
    console.log(`\n❌ 自检失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  · ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ 自检全部通过');
  }
  // 显式退出，避免 taskkill 等子进程把退出码搅浑
  process.exit(failures.length > 0 ? 1 : 0);
}
