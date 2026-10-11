/**
 * ============================================================================
 *  test/page-utils.test.mjs —— 注入脚本的离线测试（node --test + jsdom）
 * ----------------------------------------------------------------------------
 *  注入到网页里的脚本（adapters/page-utils.mjs）没办法靠"看代码"确认对不对，
 *  这里用 jsdom 造一个真实 DOM，把脚本真的跑起来，验证：
 *    1. 多候选选择器能正确命中（含"按顺序退到后面的候选"）
 *    2. 可见性判断能过滤掉 display:none 的干扰元素
 *    3. React 受控组件的原生 setter 写法能真的改到 value 并派发 input
 *    4. contenteditable 的赋值/读取
 *    5. DataTransfer + ClipboardEvent 注入图片（方案 B 的底层）
 *    6. 用输入框位置反推聊天区 file input（方案 C 的选点逻辑）
 *    7. 选择器调试高亮会留下可清理的覆盖层
 *
 *  运行：npm test
 * ============================================================================
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildPageUtils } from '../adapters/page-utils.mjs';

// jsdom 是 CommonJS 包，ESM 里用 createRequire 加载
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

/** 造一个 DOM，并把 __ARENA__ 注入进去，返回 { dom, window, A } */
function makeEnv(html) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
    {
      url: 'https://example.com/chat/',
      pretendToBeVisual: true,
      // 必须打开，否则 window.eval 不在页面上下文里执行（window/document 会不见）
      runScripts: 'outside-only'
    }
  );
  const { window } = dom;

  /* ------------------------------------------------------------------ *
   * jsdom 没有布局引擎：getBoundingClientRect 恒为 0，会让 isVisible()
   * 把"其实可见"的元素判成不可见。这里给一个最小几何模拟：
   *   - 被内联 display:none / visibility:hidden 隐藏的 -> 0x0
   *   - 其余元素 -> 200x40（模拟正常可见的输入框）
   * ------------------------------------------------------------------ */
  const realGetRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function patched() {
    const style = (this.getAttribute && this.getAttribute('style')) || '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    if (this.tagName === 'HTML' || this.tagName === 'BODY') return realGetRect.call(this);
    return { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 40, width: 200, height: 40 };
  };

  // jsdom 没有实现的接口，按需补最小的桩，避免脚本抛错
  if (!window.DataTransfer) {
    window.DataTransfer = class DataTransfer {
      constructor() { this.items = { add: () => {}, length: 0 }; this.files = []; }
    };
  }
  if (!window.File) {
    window.File = class File {
      constructor(parts, name, opts) {
        this.name = name;
        this.type = (opts || {}).type || '';
        this.size = (parts && parts[0] && parts[0].size) || 0;
      }
    };
  }
  if (!window.ClipboardEvent) {
    window.ClipboardEvent = class ClipboardEvent extends window.Event {
      constructor(type, init) { super(type, init); this.clipboardData = (init || {}).clipboardData || null; }
    };
  }

  // 注入脚本会返回一个"可序列化"的标记对象（不能返回带函数的 API），
  // 真正的工具对象挂在 window.__ARENA__ 上 —— 与 webview 里的行为保持一致。
  const marker = window.eval(buildPageUtils());
  assert.ok(marker && marker.injected, '注入脚本应返回 injected 标记（可序列化）');
  const A = window.__ARENA__;
  assert.ok(A, '工具对象应该挂在 window.__ARENA__ 上');
  return { dom, window, A };
}

/* ========================================================================== */

test('多候选选择器：命中第一个可用候选，并在错过后继续往后找', () => {
  const { A } = makeEnv(`
    <div class="not-this"></div>
    <textarea id="chat-input" placeholder="给 DeepSeek 发送消息"></textarea>
  `);

  const info = A.findFirstInfo([
    'textarea#does-not-exist',
    'div[contenteditable="true"]',
    'textarea#chat-input'
  ]);

  assert.ok(info.el, '应该找到元素');
  assert.strictEqual(info.selector, 'textarea#chat-input', '应该报出真正命中的那个选择器');
  assert.strictEqual(info.tried.length, 3, '应该记录尝试过的候选数量');
  assert.ok(info.hits.some((h) => h.selector === 'textarea#does-not-exist' && h.found === false),
    '未命中的候选也要记一笔，方便调试模式列出哪些没命中');
});

test('可见性判断：display:none / 尺寸为 0 的元素应被跳过，优先取可见的那个', () => {
  const { A } = makeEnv(`
    <div class="editor" style="display:none"></div>
    <div class="editor"></div>
  `);

  const info = A.findFirstInfo(['div.editor']);
  assert.ok(info.el, '应该命中可见的那个');
  assert.strictEqual(info.hits[0].visible, false, '第一个是 display:none，应标记不可见');
  const hiddenEl = A.findAll(['div.editor'])[0];
  assert.strictEqual(A.isVisible(hiddenEl), false, 'display:none 必须判为不可见');
});

test('受控 input/textarea：原生 setter 能改到 value，并派发 input + change', () => {
  const { A, window } = makeEnv('<textarea id="t"></textarea>');
  const el = window.document.querySelector('#t');

  const events = [];
  el.addEventListener('input', () => events.push('input'));
  el.addEventListener('change', () => events.push('change'));

  const ok = A.setNativeValue(el, '你好，世界');
  assert.strictEqual(ok, true);
  assert.strictEqual(el.value, '你好，世界');
  assert.strictEqual(A.readText(el), '你好，世界');
  assert.deepStrictEqual(events, ['input', 'change'], 'input 与 change 都要派发');
});

test('contenteditable：setNativeValue 写入后 readText 能读回来，clearInput 能清空', () => {
  const { A, window } = makeEnv('<div id="ed" contenteditable="true"></div>');
  const el = window.document.querySelector('#ed');

  if (!el.isContentEditable) {
    Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });
  }

  const ok = A.setNativeValue(el, '两行文本\n第二行');
  assert.strictEqual(ok, true);
  assert.ok(A.readText(el).includes('两行文本'), '内容应写入');
  assert.ok(A.readText(el).includes('第二行'), '换行后的内容也要在');

  assert.strictEqual(A.clearInput(el), true);
  assert.strictEqual(A.readText(el).trim(), '', 'clearInput 后应该是空的');
});

test('图片注入（方案 B 底层）：pasteFilesFromDataUrls 会派发 paste 事件并带上 DataTransfer', async () => {
  const { A, window } = makeEnv('<div id="ed" contenteditable="true"></div>');
  const el = window.document.querySelector('#ed');

  // jsdom 里 fetch(dataURL) 不一定可用，用最小的 blob 桩替代
  const origFetch = window.fetch;
  window.fetch = async () => ({ blob: async () => ({ type: 'image/png', size: 3 }) });

  let captured = null;
  el.addEventListener('paste', (e) => { captured = e; });

  const res = await A.pasteFilesFromDataUrls(['data:image/png;base64,AAAA'], el);
  window.fetch = origFetch;

  assert.ok(res && res.ok, '函数应该返回 ok（' + JSON.stringify(res) + '）');
  assert.ok(captured, '必须真的派发 paste 事件到目标元素');
  assert.ok(captured.clipboardData, '事件上必须能读到 clipboardData（方案 B 的关键）');
  assert.strictEqual(typeof captured.clipboardData.items.add, 'function', 'clipboardData 里要能放文件');
});

test('方案 C 选点：能从输入框位置反推出聊天区的 file input', () => {
  const { A, window } = makeEnv(`
    <div class="avatar-upload"><input type="file" accept="image/png" id="avatar-file" /></div>
    <div class="composer">
      <div id="ed" contenteditable="true"></div>
      <input type="file" accept="image/*" multiple id="chat-file" />
    </div>
  `);
  const el = window.document.querySelector('#ed');

  const plan = A.buildFileInputSelectors(el, ['input[type="file"][accept*="image"]']);

  assert.ok(plan.count >= 1, '聊天区里那个 file input 应该被识别出来');
  const chatInput = window.document.querySelector('#chat-file');
  assert.strictEqual(chatInput.getAttribute('__arena_file_input__'), '1', '聊天区的 file input 应该被打上标记');
  assert.ok(plan.selectors[0].includes('__arena_file_input__'),
    '首选选择器应该用标记锁定聊天区，避免把图传到换头像的 input 上');
  const chatDetail = plan.details.find((d) => d.css.includes('chat-file'));
  assert.ok(chatDetail, 'details 里应该包含聊天区的 file input');
  assert.strictEqual(chatDetail.multiple, true);
});

test('方案 C 选点：只读探测 scanFileInputs 不应改动页面 DOM', () => {
  const { A, window } = makeEnv(`
    <div class="composer">
      <div id="ed" contenteditable="true"></div>
      <input type="file" accept="image/*" id="chat-file" />
    </div>
  `);
  const el = window.document.querySelector('#ed');
  const before = window.document.body.innerHTML;

  const scan = A.scanFileInputs(el);

  assert.strictEqual(scan.totalOnPage, 1);
  assert.strictEqual(scan.scopedCount, 1);
  assert.strictEqual(window.document.body.innerHTML, before, '只读探测不能修改 DOM');
  assert.strictEqual(window.document.querySelector('#chat-file').hasAttribute('__arena_file_input__'), false);
});

test('调试高亮：开启后产生覆盖层，关闭后能清理干净', () => {
  const { A, window } = makeEnv(`
    <div id="ed" contenteditable="true"></div>
    <button aria-label="发送" id="send">发送</button>
  `);

  const on = A.debugHighlight([
    { label: '输入框', selectors: ['#ed'], color: '#f0abfc' },
    { label: '发送按钮', selectors: ['button[aria-label*="发送"]'], color: '#4ade80' }
  ], true);

  assert.ok(on.ok);
  assert.strictEqual(on.report.length, 2);
  assert.ok(on.report.every((r) => r.hit), '两个字段都应该命中');
  assert.ok(window.document.getElementById('__arena_debug_overlay__'), '应该出现覆盖层');
  assert.ok(window.document.querySelectorAll('.__arena_hl__').length >= 2, '应该画出高亮框和标签');

  A.debugHighlight([], false);
  assert.strictEqual(window.document.getElementById('__arena_debug_overlay__'), null, '关闭后覆盖层应被移除');
  assert.strictEqual(window.document.querySelectorAll('.__arena_hl__').length, 0, '关闭后高亮框应被移除');
});

test('登录检测：未登录（存在登录弹窗）识别为 needLogin', () => {
  const { A } = makeEnv(`
    <div class="login-modal">
      <div class="qrcode"><img src="https://example.com/qr.png" alt="qr" /></div>
    </div>
  `);

  const login = A.findFirstInfo(['[class*="login-modal"]', '[class*="login"]']);
  assert.ok(login.el, '应该识别到登录弹窗');
  const qr = A.findFirstInfo(['[class*="qrcode"] img', 'img[src*="qrcode"]']);
  assert.ok(qr.el, '应该识别到二维码图片');

  const block = A.blockingModalInfo(['[class*="login-modal"]'], ['[class*="captcha"]']);
  assert.strictEqual(block.blocking, true);
  assert.strictEqual(block.kind, 'login');
});

test('风控关键词：可见文本里出现"滑块验证"时能被检出', () => {
  const { A } = makeEnv('<div>请完成安全验证，拖动滑块</div>');
  const text = A.visibleText(4000);
  const words = ['请完成安全验证', '滑块验证', '拖动滑块'];
  assert.ok(words.some((w) => text.includes(w)), '页面文本应包含风控关键词');
});
