#!/usr/bin/env node
/**
 * campus-login —— 校园网（阳光学院 raas 门户 172.19.1.1）实名认证 + 网络体检
 *
 *   node src/main.mjs                      # 用 config.json 里的账号密码认证，然后 ping + 测速
 *   node src/main.mjs --relogin            # 先注销再重新认证（真正跑一遍登录流程）
 *   node src/main.mjs --headless           # 无界面模式
 *   node src/main.mjs --no-speed           # 跳过测速
 *   node src/main.mjs --logoff             # 仅注销下线
 *   node src/main.mjs --skip-auth          # 不启动浏览器，只做联网校验 / ping / 测速
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  C, ROOT, log, info, ok, warn, fail, step, kv, parseArgs, loadConfig, human,
} from './util.mjs';
import { Browser, findBrowser } from './browser.mjs';
import { authenticate } from './portal-auth.mjs';
import { checkInternet, icmpPing, tcpPing, speedTest } from './nettest.mjs';

const args = parseArgs();
const cfg = loadConfig();

const portal = String(args.portal || cfg.portal).replace(/\/+$/, '');
const username = String(args.user || cfg.username || '').trim();
const password = String(args.pass || cfg.password || '');
const relogin = !!args.relogin;
const headless = !!(args.headless ?? cfg.headless);
const onlyLogoff = !!args.logoff;
const skipAuth = !!args['skip-auth'];
const doPing = !args['no-ping'];
const doSpeed = !args['no-speed'];
const keepOpen = !!(args['keep-open'] ?? cfg.keepBrowserOpen);
const pingHost = String(args.host || cfg.pingHost || 'www.baidu.com');
const pingCount = Number(args.count || cfg.pingCount || 5);
const report = { startedAt: new Date().toISOString(), portal, username, steps: {} };

const STEP_ICONS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
let stepIdx = 0;
const nextStep = (t) => step(`${STEP_ICONS[stepIdx++] || '·'} ${t}`);

/** 本地时间戳，用于报告文件名 */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function banner() {
  log('');
  log(C.bold(C.cyan('╔══════════════════════════════════════════════════════════╗')));
  log(C.bold(C.cyan('║')) + C.bold('   校园网自动认证 · 阳光学院 172.19.1.1 上网实名认证      ') + C.bold(C.cyan('║')));
  log(C.bold(C.cyan('║')) + C.gray('   浏览器控制(CDP) → 一键登录 → ping 百度 → 测速         ') + C.bold(C.cyan('║')));
  log(C.bold(C.cyan('╚══════════════════════════════════════════════════════════╝')));
}

function finish(code = 0) {
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  const f = join(ROOT, 'reports', `report-${stamp()}.json`);
  report.finishedAt = new Date().toISOString();
  try { writeFileSync(f, JSON.stringify(report, null, 2), 'utf8'); info(`报告已保存：${f}`); }
  catch (e) { warn(`报告写入失败：${e.message}`); }
  process.exit(code);
}

// ────────────────────────────────────────────────────────────────
banner();

const t0 = Date.now();

// ① 门户连通性预检
nextStep('门户连通性预检');
if (!username || !password) {
  fail('缺少账号或密码。请在 config.json 中填写，或用 --user / --pass 传入。');
  finish(2);
}
info(`账号 ${C.bold(username)}　密码 ${'*'.repeat(password.length)}　门户 ${C.cyan(portal)}`);

let preState = null;
try {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  const r = await fetch(`${portal}/api/ip.php`, { method: 'POST', signal: ac.signal });
  clearTimeout(timer);
  preState = await r.json();
  report.steps.precheck = preState;
  ok(`门户可达：${JSON.stringify(preState)}`);
  kv('本机 IP', preState.data?.ip || '未知');
  kv('门户记录', preState.data?.logined === 1 ? C.yellow('已在线（logined=1）') : '未认证');
} catch (e) {
  fail(`无法访问门户 ${portal}：${e.cause?.code || e.message}`);
  warn('请确认已连接校园网（有线/无线），且未开启会改变路由的代理/VPN。');
  report.steps.precheck = { error: String(e.message) };
  finish(3);
}

// ② 浏览器控制认证
let browser;
let authResult = { state: 'error', message: '未执行' };

if (skipAuth) {
  nextStep('跳过浏览器认证（--skip-auth）');
  info('仅执行联网校验 / ping / 测速');
  authResult = { state: 'skipped', message: '用户指定 --skip-auth，未执行登录' };
} else {
  nextStep('启动浏览器并执行认证');
  try {
    const exe = findBrowser(args.browser || cfg.browser);
    info(`浏览器：${C.gray(exe)}`);
    info(`模式：${headless ? '无界面 (headless)' : '可见窗口'}`);

    browser = new Browser({
      exe,
      port: Number(args.port || 9222),
      headless,
      profileDir: join(ROOT, '.browser-profile'),
    });
    await browser.launch();
    ok(`已连接调试协议：${browser.version?.product || 'Chromium'}（${browser.version?.protocolVersion || 'CDP'}）`);

    const page = await browser.newPage('about:blank');

    if (onlyLogoff) {
      await page.navigate(portal, { waitMs: 1500 });
      const r = await page.portalFetch(`${portal}/api/logoff.php`);
      log(`   ${C.gray('注销返回')} ${r.text}`);
      ok('已发送注销请求');
      await browser.close();
      finish(0);
    }

    authResult = await authenticate(page, { portal, username, password, relogin });
    report.steps.auth = authResult;

    if (authResult.state === 'success') ok(`认证成功：${authResult.message}`);
    else if (authResult.state === 'online') info(`跳过登录：${authResult.message}`);
    else if (authResult.state === 'failed') fail(`认证失败：${authResult.message}`);
    else fail(`认证异常：${authResult.message}`);

    if (keepOpen) info('已保留浏览器窗口（--keep-open）');
    else { await browser.close(); info('浏览器已关闭'); }
  } catch (e) {
    fail(`浏览器控制阶段出错：${e.message}`);
    report.steps.auth = { state: 'error', message: String(e.message) };
    if (browser) await browser.close().catch(() => {});
    authResult = { state: 'error', message: String(e.message) };
  }
}

// ③ 联网校验
nextStep('联网校验');
const net = await checkInternet();
report.steps.internet = net;
for (const r of net.results) {
  if (r.ok) ok(`${r.name} 可达（HTTP ${r.status}，${r.ms}ms）`);
  else fail(`${r.name} 不可达（${r.error}，${r.ms}ms）`);
}
if (!net.ok) warn('外网仍不可达：可能是账号欠费、绑定运营商未开通，或门户需要额外操作。');

// ④ ping 百度
if (doPing) {
  nextStep(`ping ${pingHost}`);
  const icmp = await icmpPing(pingHost, pingCount);
  report.steps.ping = { icmp };
  if (icmp.available) {
    kv('目标 IP', `${icmp.ip || pingHost}　TTL ${icmp.ttl ?? '-'}`);
    kv('丢包', `${icmp.loss}%`);
    kv('延时', `最短 ${icmp.min}ms / 平均 ${C.bold(icmp.avg + 'ms')} / 最长 ${icmp.max}ms`);
    kv('明细', icmp.times.map((t) => t + 'ms').join('  '));
    ok('ICMP ping 成功');
  } else {
    warn(`ICMP ping 不可用：${icmp.error || '未知原因'}`);
    if (/EPERM|禁止/.test(String(icmp.error))) {
      info('说明：当前运行环境（沙箱）禁止派生子进程抓取输出，属环境限制，并非网络故障。');
    }
    info('改用 TCP 握手延时测量（HTTPS 443 端口）…');
  }

  const tcp = await tcpPing(pingHost, 443, pingCount);
  report.steps.ping.tcp = tcp;
  if (tcp.available) {
    kv('TCP 目标', `${tcp.ip}:${tcp.port}`);
    kv('丢包', `${tcp.loss}%`);
    kv('延时', `最短 ${tcp.min}ms / 平均 ${C.bold(tcp.avg + 'ms')} / 最长 ${tcp.max}ms`);
    kv('抖动', `${tcp.jitter}ms`);
    kv('明细', tcp.times.map((t) => t + 'ms').join('  '));
    if (!icmp.available) ok('TCP 延时测量成功');
  } else {
    fail(`TCP 测量失败：${tcp.error}`);
  }
}

// ⑤ 测速
if (doSpeed) {
  nextStep('下载测速');
  const maxBytes = Number(args.bytes || cfg.speedTestBytes);
  const maxMs = Number(args['max-ms'] || cfg.speedTestMaxMs);
  info(`目标：最多 ${human(maxBytes)} 或 ${maxMs / 1000}s（取先到者）`);
  const results = await speedTest(cfg.speedTestSources, { maxBytes, maxMs });
  report.steps.speed = results;
  const good = results.filter((r) => r.ok);
  for (const r of results) {
    if (!r.ok) { warn(`${r.name.padEnd(18)} 失败：${r.error}`); continue; }
    ok(`${r.name.padEnd(18)} 稳态 ${C.bold(r.steadyMbps + ' Mbps')}  (${r.mBps} MB/s)　下载 ${human(r.bytes)}/${r.seconds}s　峰值 ${r.peakMbps} Mbps　首字节 ${r.ttfb}ms`);
  }
  if (good.length) {
    const best = good.reduce((a, b) => (a.steadyMbps > b.steadyMbps ? a : b));
    const avg = good.reduce((s, r) => s + r.steadyMbps, 0) / good.length;
    kv('最佳', `${best.name} — ${C.bold(C.green(best.steadyMbps + ' Mbps'))}（≈ ${(best.steadyMbps / 8).toFixed(1)} MB/s）`);
    kv('平均', `${avg.toFixed(1)} Mbps（≈ ${(avg / 8).toFixed(2)} MB/s）`);
    report.summary = { ...(report.summary || {}), bestMbps: best.steadyMbps, bestSource: best.name, avgMbps: Math.round(avg * 10) / 10 };
  } else {
    fail('所有测速源均不可用');
  }
}

// ⑥ 汇总
nextStep('结果汇总');
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const badge = authResult.state === 'success' ? C.green('认证成功')
  : authResult.state === 'online' ? C.yellow('已在线')
    : authResult.state === 'skipped' ? C.gray('已跳过')
      : C.red('认证未完成');

report.summary = { ...(report.summary || {}), authState: authResult.state, internet: net.ok };
log('');
log(`   ${C.bold('认证状态')}　${badge}　${C.gray(authResult.message)}`);
log(`   ${C.bold('外网连通')}　${net.ok ? C.green('正常') : C.red('不通')}`);
if (report.steps.ping?.icmp?.available) {
  log(`   ${C.bold('ping 百度')}　平均 ${report.steps.ping.icmp.avg}ms / 丢包 ${report.steps.ping.icmp.loss}%`);
} else if (report.steps.ping?.tcp?.available) {
  log(`   ${C.bold('TCP 延时')}　平均 ${report.steps.ping.tcp.avg}ms / 抖动 ${report.steps.ping.tcp.jitter}ms`);
}
if (report.summary.bestMbps) {
  log(`   ${C.bold('下载速度')}　${C.bold(C.green(report.summary.bestMbps + ' Mbps'))}（平均 ${report.summary.avgMbps} Mbps）`);
}
log(`   ${C.bold('总耗时')}　　${elapsed}s`);
log('');

finish(authResult.state === 'failed' || authResult.state === 'error' ? 1 : 0);
