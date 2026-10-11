/**
 * 截图/自检脚本：用本机已安装的 Edge（chromium 内核）驱动页面，用来验证 UI 与后续的网页通道。
 *
 * 为什么用 channel: 'msedge'：
 *   本机没有下载 Playwright 自带的 Chromium（约 170MB），但已安装 Edge 155。
 *   playwright-core + channel:'msedge' 可以直接复用，零下载。
 *
 * 为什么 userDataDir 放在项目内的 .tmp：
 *   DSH 文件沙箱只允许写工作区内的路径，Playwright 默认用系统临时目录会被拒绝。
 *
 * 用法：
 *   node scripts/shot.mjs <url> <out.png> [--w 1440] [--h 900] [--do "step"] ...
 * 步骤（可重复多次，按顺序执行）：
 *   wait:1500                  等待毫秒
 *   waitFor:.selector          等元素出现
 *   click:.selector            点击
 *   fill:.selector=>文本        填入文本（\n 会还原成换行）
 *   type:.selector=>文本        逐字输入（更接近真人，用于 contenteditable）
 *   press:.selector=>Enter     在元素上按键；选择器写 - 表示在页面上按
 *   shot:out2.png              中途再截一张
 *   eval:js表达式               在页面里求值（结果打印到控制台）
 *   scroll:.selector=>2000     把某元素滚到指定位置
 *
 * ★ 选择器与值之间的分隔符是 `=>`，不是 `=`：
 *   CSS 选择器里本身就有 `=`（如 [data-testid="x"]），用 `=` 会把选择器切坏。
 *   （这个坑是自检时真的踩到的：page.fill 收到的是 "[data-testid"）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 极简参数解析 */
function parseArgs(argv) {
  const positional = [];
  const dos = [];
  const opts = { w: 1440, h: 900 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--do') {
      dos.push(argv[++i]);
    } else if (a === '--w') {
      opts.w = Number(argv[++i]);
    } else if (a === '--h') {
      opts.h = Number(argv[++i]);
    } else if (a.startsWith('--')) {
      // 忽略未知参数
    } else {
      positional.push(a);
    }
  }
  return { positional, dos, opts };
}

const { positional, dos, opts } = parseArgs(process.argv.slice(2));
const url = positional[0];
const out = positional[1] ?? path.join(root, '.tmp', 'shot.png');

if (!url) {
  console.error('用法: node scripts/shot.mjs <url> <out.png> [--w 1440] [--h 900] [--do "click:.sel"] ...');
  process.exit(1);
}

const userDataDir = path.join(root, '.tmp', 'msedge-profile');
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(path.dirname(out), { recursive: true });

const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'msedge',
  headless: true,
  viewport: { width: opts.w, height: opts.h },
  deviceScaleFactor: 1,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebarV2'],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());

// 把页面里的报错打出来：React 渲染异常、接口 4xx/5xx、未捕获 Promise 都会出现在这里，
// 否则"截图看着是空白的"根本没法定位原因。
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    console.log(`  [page ${msg.type()}] ${msg.text()}`);
  }
});
page.on('pageerror', (err) => {
  console.log(`  [page error] ${err.message}`);
});
page.on('requestfailed', (req) => {
  console.log(`  [request failed] ${req.method()} ${req.url()} · ${req.failure()?.errorText ?? ''}`);
});
page.on('response', (res) => {
  if (res.status() >= 400) console.log(`  [http ${res.status()}] ${res.request().method()} ${res.url()}`);
});

try {
  await page.goto(url, { waitUntil: 'load', timeout: 40000 });
  // 等首屏渲染稳定（字体/玻璃拟态模糊需要一帧以上）
  await page.waitForTimeout(1200);

  for (const step of dos) {
    const sep = step.indexOf(':');
    const kind = sep >= 0 ? step.slice(0, sep) : step;
    const rest = sep >= 0 ? step.slice(sep + 1) : '';

    if (kind === 'wait') {
      await page.waitForTimeout(Number(rest));
    } else if (kind === 'waitFor') {
      await page.waitForSelector(rest, { timeout: 20000 });
    } else if (kind === 'click') {
      await page.click(rest, { timeout: 15000 });
      await page.waitForTimeout(400);
    } else if (kind === 'fill') {
      const eq = rest.indexOf('=>');
      const sel = rest.slice(0, eq);
      const text = rest.slice(eq + 2).replace(/\\n/g, '\n');
      await page.fill(sel, text);
      await page.waitForTimeout(200);
    } else if (kind === 'type') {
      const eq = rest.indexOf('=>');
      const sel = rest.slice(0, eq);
      const text = rest.slice(eq + 2).replace(/\\n/g, '\n');
      await page.click(sel);
      await page.type(sel, text, { delay: 8 });
      await page.waitForTimeout(200);
    } else if (kind === 'press') {
      const eq = rest.indexOf('=>');
      const sel = rest.slice(0, eq);
      const key = rest.slice(eq + 2);
      if (sel === '-') await page.keyboard.press(key);
      else await page.press(sel, key);
      await page.waitForTimeout(300);
    } else if (kind === 'shot') {
      await page.screenshot({ path: rest });
      console.log('saved', rest);
    } else if (kind === 'scroll') {
      const eq = rest.indexOf('=>');
      const sel = rest.slice(0, eq);
      const top = Number(rest.slice(eq + 2));
      await page.$eval(sel, (el, t) => {
        el.scrollTop = t;
      }, top);
    } else if (kind === 'eval') {
      const val = await page.evaluate(rest);
      console.log('eval →', JSON.stringify(val));
    } else {
      console.warn('未知步骤，已跳过：', step);
    }
  }

  await page.waitForTimeout(400);
  await page.screenshot({ path: out });
  console.log('saved', out);
} catch (err) {
  console.error('截图失败：', err instanceof Error ? err.message : err);
  // 失败也要留下一张现场图，便于排查
  try {
    await page.screenshot({ path: out.replace(/\.png$/, '-error.png') });
    console.error('已保存现场截图', out.replace(/\.png$/, '-error.png'));
  } catch {
    /* 忽略 */
  }
  process.exitCode = 1;
} finally {
  await ctx.close();
}
