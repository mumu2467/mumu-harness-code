/**
 * ============================================================================
 *  test/adapter.test.mjs —— 适配器内核的集成测试（真实执行注入代码）
 * ----------------------------------------------------------------------------
 *  这是最接近"真发消息"的离线验证：用 jsdom 造一个假的聊天页面，
 *  再伪造一个 webview 元素 + window.arena（对应 preload 暴露的能力），
 *  让 adapters/base.mjs 里的 probe / diag / injectText / clickSend / send
 *  真的跑起来，逐条验证：
 *    1. probe() 能识别"就绪 / 需要登录 / 二维码 / 风控"
 *    2. diag() 能报出每个字段命中了哪个选择器
 *    3. 文本注入三级降级：CDP 不可用时会自动退到 execCommand / 原生 setter
 *    4. clickSend() 能点掉按钮（含"配置按钮被禁用 → 就近猜测"）
 *    5. send() 完整流程：注入 → 点击 → 校验输入框已清空
 *    6. 未登录时 send() 直接中止并回报 needLogin
 *    7. 一个站点报错不会影响另一个站点（Promise.allSettled 语义）
 *
 *  运行：npm test
 * ============================================================================
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildPageUtils } from '../adapters/page-utils.mjs';
import { createAdapter } from '../adapters/base.mjs';

// 下面两个是 CommonJS，ESM 里用 createRequire 加载
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { getSiteConfig } = require('../adapters/site-config');

/* -------------------------------------------------------------------------- */
/* 造一个假的 webview：executeJavaScript 直接在当前 jsdom 里求值               */
/* -------------------------------------------------------------------------- */

function makeFakeWebview(window) {
  let wcIdSeq = 5100;
  return {
    // 注意：真实的 <webview> 元素【没有】isDestroyed() —— 这里刻意不提供，
    // 以免测试掩盖"用了 webview 上不存在的方法"这类问题。
    getWebContentsId: () => wcIdSeq++,
    getURL: () => window.location.href,
    getTitle: () => window.document.title || '',
    focus: () => {},
    openDevTools: () => {},
    /** 与 Electron 的 webview.executeJavaScript(code, userGesture) 语义一致：
     *  返回值会被"跨进程克隆"，所以这里也做一次序列化检查。 */
    async executeJavaScript(code) {
      const value = window.eval(code);
      if (value !== undefined && value !== null) {
        JSON.stringify(value); // 带函数/循环引用会抛错，模拟 Electron 的克隆限制
      }
      return value;
    }
  };
}

/** 最近一次 makeSiteEnv 建出来的 jsdom window/document，供 Node 侧的桩函数使用 */
let LAST_WINDOW = null;
let LAST_DOC = null;

/**
 * 建一个"站点环境"
 * @param {string} html         页面内容
 * @param {object} wcOverrides  覆盖 window.arena 的某些能力（模拟失败场景）
 */
function makeSiteEnv(html, wcOverrides = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    url: 'https://www.doubao.com/chat/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const { window } = dom;
  LAST_WINDOW = window;
  LAST_DOC = window.document;

  // 补几何信息：jsdom 没有布局，isVisible 需要真实尺寸
  window.Element.prototype.getBoundingClientRect = function rect() {
    const style = (this.getAttribute && this.getAttribute('style')) || '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    if (this.tagName === 'HTML' || this.tagName === 'BODY') {
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 };
    }
    return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 40, width: 300, height: 40 };
  };

  // ★ jsdom 没有实现 contenteditable，isContentEditable 永远是 undefined。
  //   注入脚本靠它区分 textarea 和 contenteditable，所以这里按属性补上。
  Object.defineProperty(window.Element.prototype, 'isContentEditable', {
    configurable: true,
    get() {
      const v = this.getAttribute && this.getAttribute('contenteditable');
      return v === '' || v === 'true' || v === 'plaintext-only';
    }
  });

  // 供 page-utils 使用（jsdom 缺失的接口）
  if (!window.DataTransfer) {
    window.DataTransfer = class DataTransfer {
      constructor() { this.items = { add: () => {}, length: 0 }; this.files = []; }
    };
  }
  if (!window.ClipboardEvent) {
    window.ClipboardEvent = class ClipboardEvent extends window.Event {
      constructor(type, init) { super(type, init); this.clipboardData = (init || {}).clipboardData || null; }
    };
  }

  // 伪造 window.arena（对应 preload.js 暴露给渲染进程的能力）
  const calls = { insertTextCDP: 0, paste: 0, enter: 0, clipboardImage: 0, setFiles: 0 };
  window.arena = {
    focusWebview: async () => ({ ok: true }),
    insertTextCDP: async (id, text) => {
      calls.insertTextCDP++;
      if (wcOverrides.insertTextCDP) return wcOverrides.insertTextCDP(id, text, LAST_WINDOW, LAST_DOC);
      // 模拟 CDP 注入：直接把文本写进当前聚焦的输入框
      const el = LAST_DOC.activeElement;
      if (!el) return { ok: false, error: '没有聚焦元素' };
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.value = text;
        el.dispatchEvent(new LAST_WINDOW.Event('input', { bubbles: true }));
        return { ok: true };
      }
      if (el.isContentEditable) {
        el.textContent = text;
        return { ok: true };
      }
      return { ok: false, error: '聚焦元素不可输入' };
    },
    clipboardWriteImage: async () => { calls.clipboardImage++; return { ok: true }; },
    clipboardWriteText: async () => ({ ok: true }),
    sendPaste: async () => { calls.paste++; return { ok: true }; },
    sendEnter: async () => { calls.enter++; return { ok: true }; },
    writeTempImage: async (siteId, i) => ({ ok: true, file: 'C:/tmp/' + siteId + '-' + i + '.png' }),
    setFileInputFiles: async () => {
      calls.setFiles++;
      if (wcOverrides.setFileInputFiles) return wcOverrides.setFileInputFiles();
      return { ok: true, selector: 'input[type=file]' };
    },
    clearTempImages: async () => ({ ok: true }),
    openExternal: async () => ({ ok: true })
  };

  // 注入页面工具脚本（等价于适配器第一次 ensureUtils）：
  // 它只返回可序列化标记，工具对象挂在 window.__ARENA__ 上。
  window.eval(buildPageUtils());
  if (!window.__ARENA__) throw new Error('page-utils 注入失败：window.__ARENA__ 不存在');

  return { dom, window, calls, webview: makeFakeWebview(window) };
}

/** 造一个适配器：站点配置换成"只认我们页面里那几个元素" */
function makeAdapter(env, configOverride = {}) {
  const base = getSiteConfig('doubao');
  const config = { ...base, ...configOverride };
  const logs = [];
  const adapter = createAdapter(config, {
    log: (level, msg) => logs.push(level + ': ' + msg)
  });
  adapter.attach(env.webview);
  return { adapter, logs, config };
}

/* -------------------------------------------------------------------------- */
/* 用例                                                                        */
/* -------------------------------------------------------------------------- */

test('ensureUtils()：注入脚本的返回值必须可序列化（跨进程克隆）', async () => {
  const env = makeSiteEnv('<div contenteditable="true" data-testid="chat_input_input"></div>');
  const { adapter } = makeAdapter(env);

  const res = await adapter.ensureUtils(true);
  assert.ok(res, '应该返回结果');
  assert.strictEqual(res.injected, true, '返回值要带 injected 标记');

  // 关键回归：返回值里不能出现任何函数（否则 Electron 会报 object could not be cloned）
  const walk = (v, path) => {
    if (typeof v === 'function') throw new Error('返回值不可序列化：' + path + ' 是函数');
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k], path + '.' + k);
    }
  };
  walk(res, 'result');

  // 真正的工具对象应该挂在页面的 window.__ARENA__ 上
  assert.ok(env.window.__ARENA__, 'window.__ARENA__ 必须存在');
  assert.strictEqual(typeof env.window.__ARENA__.findFirst, 'function');
});

test('probe()：输入框可见时应识别为"已就绪"', async () => {
  const env = makeSiteEnv(`
    <div class="composer">
      <div contenteditable="true" data-testid="chat_input_input" id="editor"></div>
      <button data-testid="chat_input_send_button">发送</button>
    </div>
  `);
  const { adapter } = makeAdapter(env);

  const res = await adapter.probe();
  assert.ok(res && res.ok, 'probe 应该成功');
  assert.strictEqual(res.ready, true, '输入框在 => ready');
  assert.strictEqual(res.inputVisible, true);
  assert.strictEqual(res.needLogin, false, '能打字就不该判为需要登录');
  assert.ok(res.inputSelector.includes('chat_input_input'), '应命中配置里的第一个候选，实际=' + res.inputSelector);
});

test('probe()：只有登录弹窗 + 二维码时，应识别为需要登录且二维码已出现', async () => {
  const env = makeSiteEnv(`
    <div class="login-modal">
      <div class="qrcode"><img src="https://example.com/qr.png" alt="qr" /></div>
    </div>
  `);
  const { adapter } = makeAdapter(env);

  const res = await adapter.probe();
  assert.strictEqual(res.ready, false);
  assert.strictEqual(res.needLogin, true, '登录弹窗可见 => needLogin');
  assert.strictEqual(res.qrcode, true, '二维码图片可见 => qrcode');
  assert.strictEqual(res.blocked, true);
});

test('probe()：命中风控文案时应报 hasRisk（只提示不绕过）', async () => {
  const env = makeSiteEnv('<div>请完成安全验证，拖动滑块完成拼图</div>');
  const { adapter } = makeAdapter(env);

  const res = await adapter.probe();
  assert.strictEqual(res.hasRisk, true);
  assert.ok(res.riskWord, '应该带上是哪个关键词：' + res.riskWord);
});

test('diag()：逐字段报出命中的选择器，未命中的字段带上试过的候选', async () => {
  const env = makeSiteEnv(`
    <div contenteditable="true" data-testid="chat_input_input"></div>
    <button aria-label="发送消息">→</button>
  `);
  const { adapter } = makeAdapter(env);

  const fields = await adapter.diag();
  assert.strictEqual(fields.inputSelector.hit, true);
  assert.ok(fields.inputSelector.selector.includes('chat_input_input'));
  assert.strictEqual(fields.sendButtonSelector.hit, true, '应该通过 aria-label 命中发送按钮');
  assert.strictEqual(fields.qrcodeSelector.hit, false, '页面里没有二维码');
  assert.ok(Array.isArray(fields.qrcodeSelector.tried), '未命中的字段要带回候选列表');
  assert.ok(fields.qrcodeSelector.tried.length > 0);
});

test('文本注入三级降级：CDP 失败时退到 execCommand / 原生 setter，内容最终必须进输入框', async () => {
  const env = makeSiteEnv('<textarea id="editor"></textarea>', {
    // 模拟 CDP 完全不可用（拿不到焦点 / debugger 附加失败）
    insertTextCDP: async () => ({ ok: false, error: '模拟：debugger 附加失败' })
  });
  const { adapter, logs } = makeAdapter(env);

  // jsdom 没有实现 execCommand，让它在第二次降级里也失败，逼出第三级
  env.window.document.execCommand = () => false;

  const res = await adapter.injectText('这是一段测试文本');
  assert.ok(res.ok, '三级降级里必须有一级成功：' + JSON.stringify(res));
  assert.strictEqual(env.window.document.querySelector('#editor').value, '这是一段测试文本');
  // 说明最终用了哪种方式（CDP 分块 / 全选 insertText / 原生 setter 都可能）
  const used = logs.find((l) => l.includes('文本注入成功'));
  assert.ok(used, '日志里应说明最终用了哪种方式：' + logs.join(' | '));
  assert.ok(/CDP|insertText|原生 setter/.test(used), '日志要能看出具体方式：' + used);
});

test('clickSend()：能点到配置里的发送按钮，并在日志里说明命中的选择器', async () => {
  const env = makeSiteEnv(`
    <div contenteditable="true" data-testid="chat_input_input"></div>
    <button data-testid="chat_input_send_button">发送</button>
  `);
  const { adapter, logs } = makeAdapter(env);

  let clicked = 0;
  env.window.document.querySelector('[data-testid="chat_input_send_button"]')
    .addEventListener('click', () => { clicked++; });

  const res = await adapter.clickSend();
  assert.ok(res.ok, '应该点击成功：' + JSON.stringify(res));
  assert.strictEqual(clicked, 1, '按钮应该被点了一次');
  assert.ok(res.how.includes('配置选择器'), '应该优先用配置：' + res.how);
  assert.ok(logs.some((l) => l.includes('已点击发送按钮')));
});

test('clickSend()：配置里的按钮被禁用时，退化为"就近猜测"可点按钮', async () => {
  const env = makeSiteEnv(`
    <div class="composer">
      <div contenteditable="true" data-testid="chat_input_input"></div>
      <button data-testid="chat_input_send_button" disabled>发送</button>
      <button class="send-btn">发送</button>
    </div>
  `);
  const { adapter } = makeAdapter(env);

  let clicked = 0;
  env.window.document.querySelector('button.send-btn').addEventListener('click', () => { clicked++; });

  const res = await adapter.clickSend();
  assert.ok(res.ok, '应该找到可点的那个：' + JSON.stringify(res));
  assert.strictEqual(clicked, 1);
  assert.ok(res.how.includes('就近猜测'), '被禁用 => 走就近猜测：' + res.how);
});

test('send()：完整流程会把文本放进输入框、点发送、并校验输入框已清空', async () => {
  const env = makeSiteEnv(`
    <div class="composer">
      <div contenteditable="true" data-testid="chat_input_input" id="editor"></div>
      <button data-testid="chat_input_send_button" id="send">发送</button>
    </div>
  `);
  const { adapter } = makeAdapter(env);

  // 让发送按钮真的"发送"：点击后清空输入框（模拟站点行为）
  env.window.document.querySelector('#send').addEventListener('click', () => {
    env.window.document.querySelector('#editor').textContent = '';
  });

  const res = await adapter.send('你好，三栏对答', [], { timeout: 3000 });

  assert.ok(res.ok, '发送应该判为成功：' + JSON.stringify(res));
  const steps = res.steps.map((s) => s.step);
  // 现在发送前会先套用"最佳模型/推理"，所以流程是 applyBest → waitReady → injectText → ...
  assert.ok(steps.includes('applyBest'), '必须先执行"套用最佳模型/推理"：' + steps.join(','));
  const core = steps.filter((s) => s !== 'applyBest');
  assert.deepStrictEqual(core.slice(0, 4), ['waitReady', 'injectText', 'injectImages', 'clickSend'],
    '核心步骤顺序应完整：' + steps.join(','));
  assert.ok(steps.includes('verify'), '必须有校验步骤');
  assert.strictEqual(env.window.document.querySelector('#editor').textContent, '', '发送后输入框应为空');
});

test('send()：未登录（只有登录弹窗）时应直接中止并给出 needLogin', async () => {
  const env = makeSiteEnv('<div class="login-modal"><div class="qrcode"><img src="qr.png" alt="qr"/></div></div>');
  const { adapter } = makeAdapter(env);

  const res = await adapter.send('这条不该发出去', [], { timeout: 800 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.needLogin, true, '应该明确告诉界面"需要登录"：' + JSON.stringify(res.steps));
  assert.ok(res.error.includes('登录'));
});

test('并发隔离：一个站点抛错不会影响另一个站点（Promise.allSettled 语义）', async () => {
  // A 站点正常
  const goodEnv = makeSiteEnv(`
    <div class="composer">
      <div contenteditable="true" data-testid="chat_input_input" id="editor"></div>
      <button data-testid="chat_input_send_button" id="send">发送</button>
    </div>
  `);
  const good = makeAdapter(goodEnv).adapter;
  goodEnv.window.document.querySelector('#send').addEventListener('click', () => {
    goodEnv.window.document.querySelector('#editor').textContent = '';
  });

  // B 站点：executeJavaScript 直接抛错（模拟页面崩溃 / 注入通道损坏）
  const badEnv = makeSiteEnv('<div contenteditable="true"></div>');
  const badWebview = {
    // 同样不提供 isDestroyed()：真实 webview 就没有这个方法
    getWebContentsId: () => 9999,
    getURL: () => 'https://www.kimi.com/',
    getTitle: () => '',
    focus: () => {},
    executeJavaScript: async () => { throw new Error('模拟：注入通道损坏'); }
  };
  const badConfig = { ...getSiteConfig('kimi') };
  const bad = createAdapter(badConfig, { log: () => {} });
  bad.attach(badWebview);

  const results = await Promise.allSettled([
    good.send('A 站点消息', [], { timeout: 2000 }),
    bad.send('B 站点消息', [], { timeout: 500 })
  ]);

  assert.strictEqual(results[0].status, 'fulfilled', 'A 站点应正常完成');
  assert.ok(results[0].value.ok, 'A 站点应发送成功');
  assert.strictEqual(results[1].status, 'fulfilled', 'B 站点的错误必须被适配器内部吞掉，不能把 Promise 打成 rejected');
  assert.strictEqual(results[1].value.ok, false, 'B 站点应返回失败而不是抛异常');
});
