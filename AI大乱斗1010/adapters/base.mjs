/**
 * ============================================================================
 *  adapters/base.mjs —— 适配器内核（所有站点共用）
 * ----------------------------------------------------------------------------
 *  一个 Adapter = 站点静态配置（site-config.js） + 通用注入逻辑（本文件）
 *
 *  加载方式：本文件是标准 ES Module，渲染进程（Chromium）直接 import；
 *  Node 侧（主进程 / 测试）请 require 旁边的桥接文件 adapters/base.js。
 *
 *  对外提供（renderer 只依赖这些）：
 *    probe()                     页面状态探测（登录/就绪/风控）
 *    waitReady(timeout)          轮询等输入框出现（默认 10s）
 *    injectText(text)            文本注入：CDP → execCommand → 原生 setter 三级降级
 *    injectImages(images)        图片注入：按站点情况选择 A/B/C 并逐级降级
 *    clearInput()                清空输入框（发送前/发送后校验用）
 *    readInput()                 读取输入框文本
 *    clickSend()                 点发送按钮（多策略找按钮）
 *    pressEnter()                模拟真实 Enter
 *    send()                      ★ 完整发送流程：等就绪 → 注入文本 → 注入图片 → 发送 → 校验
 *    diag()                      逐字段诊断选择器命中情况（调试/自检用）
 *    applyBest(opts)             ★ 发送前把该站点切到"最好的模型 + 最强推理"
 *    debugHighlight(on)          选择器调试模式高亮
 *    fileInputPlan()             反推聊天区 file input（方案 C 用）
 *    openDebugger()              打开该 webview 的 DevTools
 *
 *  所有对外方法都不会 throw，统一返回 { ok, ... } 或 null —— 保证
 *  Promise.allSettled 时三个站点互不影响。
 * ============================================================================
 */

'use strict';

import { buildPageUtils } from './page-utils.mjs';
import { getPreferences, pickBest } from './preferences.mjs';

/** 把注入脚本缓存起来（只生成一次字符串） */
let PAGE_UTILS_SOURCE = null;
function pageUtilsSource() {
  if (!PAGE_UTILS_SOURCE) PAGE_UTILS_SOURCE = buildPageUtils();
  return PAGE_UTILS_SOURCE;
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 dataURL 猜扩展名，纯日志用 */
function dataUrlKind(dataUrl) {
  const m = /^data:image\/([a-z0-9.+-]+)/i.exec(String(dataUrl || ''));
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'unknown';
}

/**
 * 创建适配器
 * @param {object} siteConfig  site-config.js 里的一个站点配置
 * @param {object} hooks       { log(level, msg, detail), onState(patch) }
 */
function createAdapter(siteConfig, hooks = {}) {
  const site = siteConfig;
  const log = (level, message, detail) => {
    try {
      hooks.log && hooks.log(level, `[${site.name}] ${message}`, detail);
    } catch (e) { /* 日志失败绝不能影响主流程 */ }
  };

  /** webview 元素引用（由 renderer 注入） */
  let webview = null;
  /** page-utils 注入完成后的 Promise（缓存，避免重复注入） */
  let utilsPromise = null;

  /* ---------------------------------------------------------------- */
  /* 基础：拿 webContentsId / 在页面里求值                             */
  /* ---------------------------------------------------------------- */

  function attach(el) {
    if (webview === el) return;
    webview = el;
    utilsPromise = null; // 换了 webview，注入脚本要重新塞
  }

  /**
   * 该 webview 的 webContents id —— 主进程侧模拟按键必须用它。
   * 注意：<webview> 元素【没有】isDestroyed() 方法（那是 webContents 的），
   * 所以存活判断只能用 getWebContentsId()/getURL() 这类元素上真实存在的方法。
   */
  function wcId() {
    try {
      if (!webview || typeof webview.getWebContentsId !== 'function') return null;
      const id = webview.getWebContentsId();
      return Number.isFinite(id) && id > 0 ? id : null;
    } catch (e) {
      return null;
    }
  }

  /** webview 元素是否还活着（拿得到 webContents 就说明还活着） */
  function isAlive() {
    return wcId() !== null;
  }

  /** 当前页面地址（取不到就返回空串，绝不抛错） */
  function currentUrl() {
    try {
      return webview && typeof webview.getURL === 'function' ? webview.getURL() : '';
    } catch (e) {
      return '';
    }
  }

  /** 当前页面标题（取不到就返回空串，绝不抛错） */
  function currentTitle() {
    try {
      return webview && typeof webview.getTitle === 'function' ? webview.getTitle() : '';
    } catch (e) {
      return '';
    }
  }

  /** 把 page-utils 注入页面（幂等） */
  function ensureUtils(force) {
    if (force) utilsPromise = null;
    if (utilsPromise) return utilsPromise;
    utilsPromise = (async () => {
      if (!isAlive()) throw new Error('webview 未就绪');

      /**
       * 检查是否已经注入过。
       * ⚠ 这里只返回布尔值：executeJavaScript 的返回值要跨进程克隆，
       *   返回带函数的对象会直接报 "An object could not be cloned."。
       */
      const probeCode = '!!(window.__ARENA__ && window.__ARENA__.version === 3)';
      const injectCode = pageUtilsSource();

      try {
        if (await webview.executeJavaScript(probeCode, true)) {
          return { injected: true, cached: true, version: 3 };
        }
      } catch (e) { /* 页面还没加载完，继续注入 */ }

      const res = await webview.executeJavaScript(injectCode, true);
      if (!res || !res.injected) throw new Error('注入脚本没有生效（返回值=' + JSON.stringify(res) + '）');
      return res;
    })().catch((err) => {
      utilsPromise = null; // 失败后允许重试
      throw err;
    });
    return utilsPromise;
  }

  /**
   * 页面导航/崩溃后，之前注入的脚本（挂在旧页面的 window 上）就没了，
   * 必须清掉缓存，否则后续探测会一直用失效的旧对象。
   */
  function resetUtils() {
    utilsPromise = null;
  }

  /**
   * 在页面里执行自定义逻辑，并把 __ARENA__ 工具对象传进去。
   * body 是一段字符串，形如 "const el = A.findFirst(CFG.inputSelector); return 1;"
   *
   * ⚠ 不要在页面里做 "new Function(code)" 这类语法自检：
   *   这三个站点都有 CSP（script-src 'self'），页面内 eval 会被直接拒绝，
   *   结果把语法正确的代码也误报成错误。语法问题请在 Node 侧（离线）用
   *   test/ 里的用例或 `node --check` 排查。
   */
  async function evalWithUtils(body, cfg) {
    await ensureUtils();
    const code =
      '(async () => {\n' +
      '  const A = window.__ARENA__;\n' +
      '  if (!A) return { ok: false, error: "page-utils 未注入" };\n' +
      '  const CFG = ' + JSON.stringify(cfg || {}) + ';\n' +
      '  try {\n' + body + '\n  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }\n' +
      '})()';
    try {
      return await webview.executeJavaScript(code, true);
    } catch (err) {
      const msg = String(err && err.message || err);
      // 把真正执行的脚本落盘，方便离线核对语法（页面 CSP 不允许在页面内 eval 自检）
      try { await window.arena.dumpText(`${site.id}-failed-script`, code); } catch (e) { /* 忽略 */ }
      // 兜底通道：CDP Runtime.evaluate 能带回真实异常文本，也能绕过
      // webview.executeJavaScript 自身的一些限制。
      const id = wcId();
      if (id) {
        const viaCdp = await window.arena.evaluateCDP(id, code);
        if (viaCdp && viaCdp.ok) return viaCdp.value;
        const cdpMsg = viaCdp && viaCdp.error ? ` ｜ CDP 通道报错：${viaCdp.error}` : '';
        log('error', `注入脚本执行失败：${msg}${cdpMsg}`);
        return { ok: false, error: (viaCdp && viaCdp.error) || msg };
      }
      log('error', `注入脚本执行失败：${msg}`);
      return { ok: false, error: msg };
    }
  }

  /* ---------------------------------------------------------------- */
  /* 探测                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 页面状态探测：
   *   ready       输入框在不在（= 可以发消息）
   *   needLogin   是否出现登录/二维码元素
   *   blocked     是否被全屏弹窗（登录/验证码）挡住
   *   qrcode      二维码是否已渲染（能扫）
   *   risk        是否命中风控关键词
   */
  async function probe() {
    if (!isAlive()) {
      return { ok: false, ready: false, needLogin: false, error: 'webview 未就绪' };
    }
    const result = await evalWithUtils(String.raw`
      const inputInfo = A.findFirstInfo(CFG.inputSelector);
      const loginInfo = A.findFirstInfo(CFG.loginDetectSelector);
      const qrInfo    = A.findFirstInfo(CFG.qrcodeSelector);
      const readyInfo = A.findFirstInfo(CFG.readySelector);
      const block     = A.blockingModalInfo(CFG.loginDetectSelector, CFG.riskSelector);
      const text      = A.visibleText(6000);
      const riskWord  = (CFG.riskWords || []).find((w) => text.indexOf(w) >= 0) || null;

      const input = inputInfo.el;
      const inputVisible = input ? A.isVisible(input) : false;
      const ready = !!(readyInfo.el && A.isVisible(readyInfo.el)) || inputVisible;

      return {
        ok: true,
        url: location.href,
        title: document.title,
        ready,
        inputVisible,
        // 输入框可见 = 已经能用了，就不再认为"需要登录"
        needLogin: !inputVisible && !!(loginInfo.el && A.isVisible(loginInfo.el)),
        qrcode: !!(qrInfo.el && A.isVisible(qrInfo.el)),
        blocked: block.blocking,
        blockedKind: block.kind,
        riskWord,
        hasRisk: !!riskWord,
        loginSelector: loginInfo.selector,
        inputSelector: inputInfo.selector,
        qrcodeSelector: qrInfo.selector,
        lastReply: text.slice(-300)
      };
    `, site);
    return result || { ok: false, ready: false, error: '探测返回空' };
  }

  /**
   * 轮询等输入框出现（默认 10s，250ms 一次）。
   * - 一旦发现"输入框就绪"立刻返回；
   * - 一旦发现"需要登录"也立刻返回（没必要白等 10 秒），并把探测结果摊平到返回值上，
   *   这样调用方可以直接读 ready.needLogin / ready.qrcode。
   */
  async function waitReady(timeout = 10000) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      if (!isAlive()) return { ok: false, error: 'webview 未就绪' };
      last = await probe();
      if (last && last.ready) return last;
      // 需要登录 / 被登录弹窗挡住：提前结束，交给界面去引导扫码
      if (last && (last.needLogin || (last.blocked && last.blockedKind === 'login'))) {
        return { ...last, ok: false, error: '需要登录', needLogin: true };
      }
      await sleep(250);
    }
    return {
      ok: false,
      error: `等待输入框超时（${timeout}ms）`,
      // 把最后一次探测结果摊平，调用方不用再 .last 一层
      ...(last || {}),
      needLogin: !!(last && last.needLogin),
      ready: false
    };
  }

  /* ---------------------------------------------------------------- */
  /* 文本注入（三级降级）                                              */
  /* ---------------------------------------------------------------- */

  async function currentInputInfo() {
    return evalWithUtils(String.raw`
      const info = A.findFirstInfo(CFG.inputSelector);
      return { ok: true, found: !!info.el, selector: info.selector, desc: info.el ? A.describe(info.el) : null, tried: info.tried };
    `, site);
  }

  /**
   * 文本注入的候选方案。
   *
   * 顺序说明（都是在真实站点上踩出来的）：
   *   1. 中文/全角标点用 document.execCommand('insertText') 经常"看着成功、其实没进去"，
   *      所以中文优先走 CDP 的真实输入（Input.insertText），并且【分块】发送
   *      —— 整段太长时内核会截断（实测豆包会静默截断）。
   *   2. Lexical(Kimi)/ProseMirror(豆包) 这类编辑器有内部模型，
   *      直接改 innerHTML 会"DOM 上有字、模型里没字"，所以最后才用它兜底。
   *   3. CDP 是"追加"语义，发送前必须先清空输入框，否则会和残留内容拼在一起。
   */
  function injectTextStrategies(text) {
    const want = String(text);

    /** 通用动作：全选 + insertText 覆盖（对 Lexical 有效，对中文标点不一定） */
    async function replaceWith() {
      await forceFocus();
      return evalWithUtils(String.raw`
        const info = A.findFirstInfo(CFG.inputSelector);
        if (!info.el) return { ok: false, error: '找不到输入框' };
        const r = A.replaceAllText(info.el, CFG.text);
        return { ok: !!r.ok, selector: info.selector, len: (r.now || '').length, sample: (r.now || '').slice(0, 60), error: r.error };
      `, { ...site, text: want });
    }

    /**
     * 强制把焦点真正落到该 webview 的输入框上。
     *
     * ★ 实测（聊天助手窗口）：webview 如果是 0 尺寸 / 被 display:none 藏起来，
     *   浏览器不会给它焦点，注入脚本里的 focusInput() 静默失效，
     *   表现就是"内容写不进输入框"。所以这里先聚焦 webview 再校验，
     *   失败时给出明确原因，便于定位。
     */
    async function forceFocus() {
      const id = wcId();
      if (!id) return { ok: false, error: '拿不到 webContentsId' };
      try { await window.arena.focusWebview(id); } catch (e) { /* 忽略 */ }
      await sleep(90);
      const res = await evalWithUtils(String.raw`
        const info = A.findFirstInfo(CFG.inputSelector);
        if (!info.el) return { ok: false, error: '找不到输入框' };
        A.focusInput(info.el);
        const active = A.deepActive();
        const rect = info.el.getBoundingClientRect();
        const focused = !!(active && (active === info.el || info.el.contains(active)));
        return {
          ok: focused,
          focused,
          visible: A.isVisible(info.el),
          size: Math.round(rect.width) + 'x' + Math.round(rect.height),
          activeDesc: active ? A.describe(active) : null
        };
      `, site);
      if (!res || !res.ok) {
        log('warn', `输入框没拿到焦点（可见=${res && res.visible} 尺寸=${res && res.size} 当前焦点=${res && res.activeDesc}）`);
      }
      return res || { ok: false };
    }

    /** 通用动作：清空输入框（contenteditable 清空后只剩一个换行是正常的，所以允许 2 个字符以内的空白残留） */
    async function clearOnly() {
      return evalWithUtils(String.raw`
        const info = A.findFirstInfo(CFG.inputSelector);
        if (!info.el) return { ok: false, error: '找不到输入框' };
        A.clearInput(info.el);
        const left = A.readText(info.el);
        return { ok: left.trim().length === 0, left: left.length, leftText: left.slice(0, 20) };
      `, site);
    }

    /**
     * 清空 + 聚焦。
     *
     * ★ 实测（Kimi/Lexical）：页面没有键盘焦点时，document.execCommand 会静默失败，
     *   所以这里必须先用主进程 focusWebview() 把焦点真正给到该 webview，
     *   再清空；DOM 手段仍失败就用【真实按键】Ctrl+A + Backspace 兜底。
     */
    async function prepareForCdp() {
      const id = wcId();
      if (!id) return { ok: false, error: '拿不到 webContentsId' };
      await window.arena.focusWebview(id);
      await sleep(150);

      await evalWithUtils(String.raw`const i = A.findFirstInfo(CFG.inputSelector); if (i.el) A.focusInput(i.el); return 1;`, site);
      let cleared = await clearOnly();
      if (!cleared || !cleared.ok) {
        // 兜底 1：真实按键全选 + 删除（浏览器层面触发编辑器的删除流程）
        await window.arena.sendCtrlA(id);
        await sleep(120);
        await window.arena.sendKey(id, 'Backspace');
        await sleep(250);
        cleared = await clearOnly();
      }
      if (!cleared || !cleared.ok) {
        return { ok: false, error: '输入框清不掉（剩余 ' + ((cleared && cleared.leftText) || '?') + '）' };
      }
      await evalWithUtils(String.raw`const i = A.findFirstInfo(CFG.inputSelector); if (i.el) A.focusInput(i.el); return 1;`, site);
      return { ok: true, id };
    }

    /** 读回校验 */
    async function verify() {
      const check = await evalWithUtils(String.raw`
        const i = A.findFirstInfo(CFG.inputSelector);
        if (!i.el) return { ok: false, error: '输入框消失了' };
        const norm = (s) => String(s).replace(/\s+$/, '');
        const now = A.readText(i.el);
        return { ok: norm(now) === norm(String(CFG.text)), len: now.length, matched: norm(now) === norm(String(CFG.text)) };
      `, { ...site, text: want });
      return check;
    }

    return [
      {
        name: '清空 + CDP 分块输入',
        async run() {
          const prep = await prepareForCdp();
          if (!prep.ok) return { ok: false, error: prep.error };

          // 分块：每块 20 个字符（实测长文本一次性插入会被内核静默截断）
          const CHUNK = 20;
          for (let i = 0; i < want.length; i += CHUNK) {
            const piece = want.slice(i, i + CHUNK);
            const r = await window.arena.insertTextCDP(prep.id, piece);
            if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'CDP 输入失败' };
            await sleep(60);
          }
          await sleep(200);
          const check = await verify();
          if (!check || !check.ok) return { ok: false, error: 'CDP 输入后内容不匹配（len=' + (check && check.len) + '）' };
          return { ok: true, selector: null, len: check.len };
        }
      },
      {
        name: '清空 + 原生 setter + input 事件',
        async run() {
          return evalWithUtils(String.raw`
            const info = A.findFirstInfo(CFG.inputSelector);
            if (!info.el) return { ok: false, error: '找不到输入框' };
            A.clearInput(info.el);
            A.focusInput(info.el);
            const done = A.setNativeValue(info.el, CFG.text);
            const norm = (s) => String(s).replace(/\s+$/, '');
            const now = A.readText(info.el);
            return { ok: done && norm(now) === norm(String(CFG.text)), selector: info.selector, len: now.length, sample: now.slice(0, 60) };
          `, { ...site, text: want });
        }
      },
      {
        name: '全选 + execCommand(insertText)',
        async run() {
          const res = await replaceWith();
          if (!res || !res.ok) return { ok: false, error: (res && res.error) || '内容不匹配' };
          return { ok: true, selector: res.selector, len: res.len, sample: res.sample };
        }
      }
    ];
  }

  /**
   * 注入文本：按顺序尝试，第一个"输入框里真的读回目标文本"的方案胜出。
   * 返回 { ok, strategy, selector, len }
   */
  async function injectText(text) {
    const strategies = injectTextStrategies(String(text));
    const failures = [];
    for (const s of strategies) {
      try {
        const res = await s.run();
        if (res && res.ok) {
          log('ok', `文本注入成功（方式：${s.name}${res.selector ? '，命中：' + res.selector : ''}）`);
          return { ok: true, strategy: s.name, ...res };
        }
        failures.push(`${s.name}: ${(res && res.error) || '内容不匹配'}`);
      } catch (err) {
        failures.push(`${s.name}: ${err && err.message}`);
      }
    }
    log('error', `文本注入全部失败 → ${failures.join(' ｜ ')}`);
    return { ok: false, error: failures.join(' ｜ ') };
  }

  /* ---------------------------------------------------------------- */
  /* 图片注入（方案 A → B → C）                                        */
  /* ---------------------------------------------------------------- */

  /** 记录注入前后输入区图片数量，用于判断「到底有没有粘进去」 */
  async function imageSignature() {
    return evalWithUtils(String.raw`
      const info = A.findFirstInfo(CFG.inputSelector);
      if (!info.el) return { ok: false, count: 0 };
      return { ok: true, count: A.countImages(info.el) };
    `, site);
  }

  function imageStrategies(images) {
    return [
      {
        /* ================= 方案 A：系统剪贴板 + 真实 Ctrl+V ================= */
        name: 'A 系统剪贴板 + Ctrl+V',
        async run() {
          const id = wcId();
          if (!id) return { ok: false, error: '拿不到 webContentsId' };
          const before = await imageSignature();
          await evalWithUtils(String.raw`
            const info = A.findFirstInfo(CFG.inputSelector);
            if (info.el) A.focusInput(info.el);
            return 1;
          `, site);
          await window.arena.focusWebview(id);
          await sleep(120);

          let pasted = 0;
          for (let i = 0; i < images.length; i++) {
            const w = await window.arena.clipboardWriteImage(images[i].dataUrl);
            if (!w || !w.ok) return { ok: false, error: `写剪贴板失败：${(w && w.error) || '未知'}` };
            await sleep(120);
            await window.arena.sendPaste(id);
            await sleep(650); // 等站点把图片上传/插入
            pasted++;
          }

          await sleep(400);
          const after = await imageSignature();
          const grew = (after.count || 0) > (before.count || 0);
          return {
            ok: true,
            pasted,
            grew,
            note: grew
              ? `已粘贴 ${pasted} 张（输入区图片 ${before.count}→${after.count}）`
              : `已发 Ctrl+V ${pasted} 次（图片计数未变化，可能站点用 canvas 缩略图）`
          };
        }
      },
      {
        /* ============ 方案 B：页面内 DataTransfer + ClipboardEvent ============ */
        name: 'B DataTransfer 合成 paste 事件',
        async run() {
          const res = await evalWithUtils(String.raw`
            const info = A.findFirstInfo(CFG.inputSelector);
            if (!info.el) return { ok: false, error: '找不到输入框' };
            const r = await A.pasteFilesFromDataUrls(CFG.dataUrls, info.el);
            return r;
          `, { ...site, dataUrls: images.map((i) => i.dataUrl) });
          if (res && res.ok) await sleep(700);
          return res;
        }
      },
      {
        /* ================= 方案 C：CDP 塞进 input[type=file] ================= */
        name: 'C CDP DOM.setFileInputFiles',
        async run() {
          const id = wcId();
          if (!id) return { ok: false, error: '拿不到 webContentsId' };

          // 1) 让页面反推聊天区的 file input 并打标记
          const plan = await evalWithUtils(String.raw`
            const info = A.findFirstInfo(CFG.inputSelector);
            return { ok: true, plan: A.buildFileInputSelectors(info.el, CFG.fileInputSelector) };
          `, site);
          if (!plan || !plan.ok || !plan.plan) return { ok: false, error: '无法定位 file input' };
          const selectors = plan.plan.selectors;
          log('info', `方案 C 候选 file input 选择器：${selectors.slice(0, 3).join(' , ')}（共 ${plan.plan.count} 个）`);

          // 2) 图片落盘成真实文件路径（CDP 只吃磁盘路径）
          const files = [];
          for (let i = 0; i < images.length; i++) {
            const w = await window.arena.writeTempImage(site.id, i, images[i].dataUrl);
            if (!w || !w.ok) return { ok: false, error: `写临时文件失败：${(w && w.error) || '未知'}` };
            files.push(w.file);
          }

          // 3) 逐个塞进去
          const results = [];
          for (let i = 0; i < files.length; i++) {
            const r = await window.arena.setFileInputFiles(id, selectors, files[i]);
            results.push(r);
            if (!r || !r.ok) return { ok: false, error: `第 ${i + 1} 张失败：${(r && r.error) || '未知'}`, selectors };
            await sleep(450);
          }
          await sleep(500);
          return { ok: true, count: files.length, selector: results[0] && results[0].selector, selectors };
        }
      }
    ];
  }

  /**
   * 注入图片：dataUrls -> 依次尝试各方案
   *
   * ★ 顺序不是死的：先问一次页面"有没有 input[type=file]"，
   *   有的话说明方案 C（CDP 直接塞文件）最稳、最不容易触发上传失败，就把它提到最前；
   *   没有 file input 的站点（纯粘贴上传）才走 A（系统剪贴板 + Ctrl+V）→ B（DataTransfer）。
   */
  async function injectImages(images) {
    if (!images || images.length === 0) return { ok: true, skipped: true, strategy: '无图片' };

    // 先探测聊天区的上传控件
    let hasFileInput = false;
    try {
      const plan = await fileInputPlan();
      hasFileInput = !!(plan && plan.ok && plan.plan && plan.plan.count > 0);
      if (hasFileInput) log('info', `检测到 ${plan.plan.count} 个 input[type=file]，方案 C 可用`);
    } catch (e) { /* 探测失败就当作没有 */ }

    const strategies = imageStrategies(images);
    const ordered = hasFileInput
      ? [...strategies].sort((a, b) => (a.name.startsWith('C') ? -1 : b.name.startsWith('C') ? 1 : 0))
      : strategies;

    const failures = [];
    for (const s of ordered) {
      try {
        const res = await s.run();
        if (res && res.ok) {
          log('ok', `图片注入完成（使用方案 ${s.name}）${res.note ? '：' + res.note : ''}`);
          return { ok: true, strategy: s.name, ...res };
        }
        failures.push(`${s.name}: ${(res && res.error) || '未生效'}`);
        log('warn', `方案 ${s.name} 未成功，尝试下一种降级方案`);
      } catch (err) {
        failures.push(`${s.name}: ${err && err.message}`);
      }
    }
    log('error', `图片注入全部失败 → ${failures.join(' ｜ ')}`);
    return { ok: false, error: failures.join(' ｜ '), imageKinds: images.map((i) => dataUrlKind(i.dataUrl)) };
  }

  /* ---------------------------------------------------------------- */
  /* 发送                                                              */
  /* ---------------------------------------------------------------- */

  async function readInput() {
    const res = await evalWithUtils(String.raw`
      const info = A.findFirstInfo(CFG.inputSelector);
      if (!info.el) return { ok: false, text: '', found: false };
      return { ok: true, found: true, text: A.readText(info.el), selector: info.selector };
    `, site);
    return res || { ok: false, text: '' };
  }

  async function clearInput() {
    return evalWithUtils(String.raw`
      const info = A.findFirstInfo(CFG.inputSelector);
      if (!info.el) return { ok: false, error: '找不到输入框' };
      A.clearInput(info.el);
      return { ok: true, text: A.readText(info.el) };
    `, site);
  }

  /** 页面上的消息条数（用于判断"点了发送之后是不是真的发出了"） */
  async function messageCount() {
    const res = await evalWithUtils(String.raw`
      const c = A.countMessages();
      return { ok: true, count: c.count, textLen: c.textLen };
    `, site);
    return (res && res.count) || 0;
  }

  /* ---------------------------------------------------------------- */
  /* 抓取 AI 回答（聊天页用）                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 取当前页面上的"回答候选"快照（发送前/后各取一次做差分）。
   * 结构：{ ok, items: [{ key, text, len, top, nodeDesc }] }
   */
  async function snapshotAnswers() {
    const res = await evalWithUtils(String.raw`
      const A = window.__ARENA__;
      const items = A.snapshotMessages();
      return { ok: true, items };
    `, site);
    return (res && res.items) || [];
  }

  /** 从两次快照里挑出"这次新出现的回答" */
  async function diffAnswer(before, after) {
    const res = await evalWithUtils(String.raw`
      const A = window.__ARENA__;
      const hit = A.diffNewMessages(CFG.before, CFG.after);
      return hit ? { ok: true, text: hit.text, length: hit.len, nodeDesc: hit.nodeDesc } : { ok: false, text: '', length: 0 };
    `, { before, after });
    return res || { ok: false, text: '' };
  }

  /**
   * 兼容用的"取最后一条回答"：
   * 先试 DOM 差分（需要先有快照），拿不到再退回整页启发式。
   */
  async function readLastAnswer() {
    const res = await evalWithUtils(String.raw`
      const A = window.__ARENA__;
      const r = A.extractLastAnswer();
      return { ok: !!r.ok, text: r.text || '', length: r.length || 0, via: 'extractAnswer', nodeDesc: r.nodeDesc || null };
    `, site);
    return res || { ok: false, text: '' };
  }

  /** 页面是否还在生成（有"停止生成"按钮就认为在生成） */
  async function isGenerating() {
    const res = await evalWithUtils(String.raw`
      const g = A.isGenerating(CFG.stopSelectors);
      return { ok: true, generating: !!g.generating, via: g.via };
    `, { stopSelectors: (site.stopButtonSelector || []) });
    return !!(res && res.generating);
  }

  /**
   * ★ 提问并等待回答（给"聊天页"用）★
   *
   * 判定"回答结束"的策略：
   *   主判据 = **文本稳定**：连续 quietMs 毫秒文本没再变化就认为答完了。
   *   辅助    = 见过"停止生成"按钮且它消失了 → 可以更早收工。
   *   兜底    = 超过 timeout → 返回当前文本并标记超时。
   *
   * ⚠ 不要把"停止按钮存在"当成硬性阻塞条件：早期版本要求"按钮消失"才结束，
   *   结果三个站点都永远停在"提问中"（按钮选择器匹配到了常驻元素）。
   *
   * @param {string} question
   * @param {object} opts { timeout, quietMs, applyBest, onProgress }
   */
  async function ask(question, opts = {}) {
    const timeout = opts.timeout || 180000;
    const quietMs = opts.quietMs || 4500;
    const steps = [];
    const mark = (step) => { steps.push({ ...step, at: Date.now() }); return step; };

    if (!isAlive()) return { ok: false, steps, error: 'webview 未就绪' };

    try {
      /* 先取"发送前"的回答快照（DOM 差分用） */
      const beforeSnap = await snapshotAnswers();

      /* 发送（复用完整发送流程） */
      const sent = await send(question, [], {
        applyBest: opts.applyBest !== false,
        timeout: opts.sendTimeout || 15000
      });
      steps.push(...(sent.steps || []).map((s) => ({ ...s, from: 'send' })));
      const clicked = (sent.steps || []).some((s) => s.step === 'clickSend' && s.ok);
      if (!clicked) {
        return { ok: false, steps, error: sent.error || '发送失败', needLogin: !!sent.needLogin, answer: '' };
      }
      mark({ step: 'sent', ok: true });
      // 告诉界面"问题已经发出去了，正在等回答"，不要一直显示"提问中"
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress({ phase: 'sent', length: 0, generating: true }); } catch (e) { /* 忽略 */ }
      }

      /* 等回答：DOM 差分找"新出现的回答"，文本稳定 quietMs 就收工 */
      const deadline = Date.now() + timeout;
      let lastText = '';
      let stableSince = 0;
      let sawStopButton = false;
      let done = false;
      let diffDesc = null;

      while (Date.now() < deadline) {
        await sleep(900);
        const gen = await isGenerating();
        if (gen) sawStopButton = true;

        const afterSnap = await snapshotAnswers();
        const hit = await diffAnswer(beforeSnap, afterSnap);
        const text = (hit && hit.text) || '';
        if (hit && hit.nodeDesc) diffDesc = hit.nodeDesc;

        if (text && text !== lastText) {
          lastText = text;
          stableSince = Date.now();
          if (typeof opts.onProgress === 'function') {
            try { opts.onProgress({ phase: 'answering', length: text.length, generating: gen }); } catch (e) { /* 忽略 */ }
          }
        } else if (lastText && stableSince && Date.now() - stableSince >= quietMs) {
          done = true;
          break;
        }
      }

      // 差分没拿到时，退回整页启发式，尽量给点东西
      let finalText = lastText;
      if (!finalText) {
        const fb = await readLastAnswer();
        finalText = (fb && fb.text) || '';
      }

      mark({ step: 'answer', ok: !!finalText, length: finalText.length, sawStopButton, timedOut: !done, viaDiff: !!lastText, nodeDesc: diffDesc });
      log(finalText ? 'ok' : 'warn',
        finalText ? `已取到回答（${finalText.length} 字${done ? '' : '，等待超时，可能还没答完'}${diffDesc ? '，节点 ' + diffDesc : ''}）`
                  : '没有取到回答文本');
      return {
        ok: !!finalText,
        steps,
        answer: finalText,
        timedOut: !done,
        error: finalText ? null : '等待回答超时'
      };
    } catch (err) {
      const msg = String(err && err.message || err);
      mark({ step: 'exception', ok: false, error: msg });
      log('error', `提问流程异常：${msg}`);
      return { ok: false, steps, error: msg, answer: '' };
    }
  }

  /**
   * 找发送按钮并点击：
   *   策略 1 —— 配置里的 sendButtonSelector 多候选
   *   策略 2 —— 从输入框往上找 composer 容器，再在里面找带 send / 发送 语义的按钮
   */
  async function clickSend() {
    const res = await evalWithUtils(String.raw`
      const disabledOf = (el) => {
        if (!el) return true;
        if (el.disabled === true) return true;
        if (el.getAttribute('aria-disabled') === 'true') return true;
        if (el.getAttribute('disabled') !== null) return true;
        const cls = typeof el.className === 'string' ? el.className : '';
        // 很多站点用 class 表示禁用态（send-button--disabled / is-disabled / disabled）
        if (/disabled/i.test(cls)) return true;
        const cs = getComputedStyle(el);
        if (cs.pointerEvents === 'none' || cs.cursor === 'not-allowed') return true;
        return false;
      };

      // ---- 策略 1：配置的候选 ----
      const info = A.findFirstInfo(CFG.sendButtonSelector);
      let target = null;
      let how = null;
      if (info.el && !disabledOf(info.el)) {
        target = info.el;
        how = '配置选择器:' + info.selector;
      }

      // ---- 策略 2：从输入框附近猜按钮 ----
      if (!target) {
        const inputInfo = A.findFirstInfo(CFG.inputSelector);
        const scopes = [];
        let s2 = inputInfo.el;
        for (let i = 0; i < 6 && s2; i++) { scopes.push(s2); s2 = s2.parentElement; }
        for (const sc of scopes) {
          if (!sc || !sc.querySelectorAll) continue;
          const cands = Array.from(sc.querySelectorAll('button, [role="button"], div[class*="send"], div[class*="Send"], [data-testid*="send"], svg[class*="send"]'));
          const hit = cands.find((el) => {
            const txt = (el.textContent || '').trim();   // 用 textContent，避免只认自己那一层文字
            const aria = el.getAttribute('aria-label') || '';
            const cls = typeof el.className === 'string' ? el.className : '';
            const tid = el.getAttribute('data-testid') || '';
            const like = /send|发送/i.test(aria + ' ' + cls + ' ' + tid) || txt === '发送' || txt === 'Send';
            return like && !disabledOf(el) && A.isVisible(el);
          });
          if (hit) { target = hit; how = '就近猜测:' + A.describe(hit); break; }
        }
      }

      // ---- 策略 3：页面上任何"可点的 submit 按钮"（不少站点就是这么实现的） ----
      if (!target) {
        const subs = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'));
        const hit = subs.find((el) => !disabledOf(el) && A.isVisible(el));
        if (hit) { target = hit; how = 'submit 按钮:' + A.describe(hit); }
      }

      // ---- 策略 4：输入框容器内的最后一个可点 icon 按钮（很多"发送"是个纯图标） ----
      if (!target) {
        const inputInfo = A.findFirstInfo(CFG.inputSelector);
        let box = inputInfo.el;
        for (let i = 0; i < 4 && box && box.parentElement; i++) box = box.parentElement;
        if (box && box.querySelectorAll) {
          const icons = Array.from(box.querySelectorAll('button, [role="button"], svg'))
            .filter((el) => !disabledOf(el) && A.isVisible(el))
            .filter((el) => {
              // 排除上传/附件之类的按钮
              const s = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-testid') || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
              return !/upload|file|attach|image|plus|add|toolkit|tool|技能|上传|附件/i.test(s);
            });
          if (icons.length) {
            // 取最靠右/最靠下的那个（一般是发送）
            const pick = icons[icons.length - 1];
            const r = pick.getBoundingClientRect();
            if (r.width > 2) { target = pick; how = '容器内最后一个图标按钮:' + A.describe(pick); }
          }
        }
      }

      if (!target) return { ok: false, error: '没有可点击的发送按钮（可能被禁用，或文本/图片尚未被识别）' };

      try { target.scrollIntoView({ block: 'center' }); } catch (e) {}
      try { target.focus(); } catch (e) {}
      let clicked = false;
      try { target.click(); clicked = true; } catch (e) {
        try {
          const r = target.getBoundingClientRect();
          const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
          target.dispatchEvent(new MouseEvent('mousedown', opts));
          target.dispatchEvent(new MouseEvent('mouseup', opts));
          target.dispatchEvent(new MouseEvent('click', opts));
          clicked = true;
        } catch (e2) { clicked = false; }
      }
      const center = A.centerOf(target);
      return { ok: clicked, how, desc: A.describe(target), center };
    `, site);
    if (res && res.ok) log('info', `已点击发送按钮（${res.how}）`);

    /*
     * ★ 兜底：有些站点（实测豆包）对 JS 合成 click 不买账 ——
     *   点击事件收到了，但消息并没有真发出去（输入框内容还在、页面没新增消息）。
     *   这种情况再补一次【真实鼠标点击】（CDP Input.dispatchMouseEvent）。
     */
    if (res && res.ok && res.center) {
      const id = wcId();
      if (id) {
        try {
          await window.arena.focusWebview(id);
          await sleep(100);
          const real = await window.arena.clickAt(id, res.center.x, res.center.y);
          if (real && real.ok) {
            log('info', '已补一次真实鼠标点击（应对只认真实交互的发送按钮）');
            return { ...res, viaRealMouse: true };
          }
        } catch (e) { /* 忽略，保持原结果 */ }
      }
    }
    return res;
  }

  /** 模拟真实 Enter（主进程 sendInputEvent + CDP insertText） */
  async function pressEnter() {
    const id = wcId();
    if (!id) return { ok: false, error: '拿不到 webContentsId' };
    await evalWithUtils(String.raw`const i = A.findFirstInfo(CFG.inputSelector); if (i.el) A.focusInput(i.el); return 1;`, site);
    await window.arena.focusWebview(id);
    await sleep(100);
    const res = await window.arena.sendEnter(id);
    if (res && res.ok) log('info', '已降级模拟 Enter 键');
    return res;
  }

  /* ---------------------------------------------------------------- */
  /* ★ 自动选择最佳模型 / 最强推理                                     */
  /* ---------------------------------------------------------------- */

  /** 读一组候选选择器命中的元素的文字 */
  async function readText(selectors) {
    return evalWithUtils(String.raw`
      const info = A.findFirstInfo(CFG.sel);
      return { ok: true, found: !!info.el, text: info.el ? String(info.el.textContent || '').trim().replace(/\s+/g, ' ') : '', selector: info.selector };
    `, { sel: selectors });
  }

  /**
   * 打开一个下拉触发器。
   *
   * ★ 实测结论（豆包）：Radix 的模型菜单【只认真实指针交互】，
   *   页面内 element.click() 合成的 MouseEvent 打开不了它
   *   （点了以后 role="menu" 存在但不可见、也没有菜单项）。
   *   所以这里**真实鼠标事件优先**，失败再退回页面内点击。
   */
  async function openTrigger(selectors) {
    const id = wcId();

    /** 等可见浮层出现 */
    async function waitOverlay() {
      for (let i = 0; i < 7; i++) {
        await sleep(200);
        const opened = await evalWithUtils(String.raw`
          const overlay = A.openOverlay();
          return { ok: !!overlay, desc: overlay ? A.describe(overlay) : null };
        `, site);
        if (opened && opened.ok) return { ok: true, overlay: opened.desc };
      }
      return { ok: false, error: '点了但可见菜单没出现' };
    }

    // ① 真实鼠标点击（最可靠）
    if (id) {
      const box = await evalWithUtils(String.raw`
        const info = A.findFirstInfo(CFG.sel);
        const c = info.el ? A.centerOf(info.el) : null;
        return { ok: !!c, center: c, selector: info.selector };
      `, { sel: selectors });
      if (box && box.ok) {
        await window.arena.focusWebview(id);
        await sleep(120);
        await window.arena.clickAt(id, box.center.x, box.center.y);
        const got = await waitOverlay();
        if (got.ok) return { ok: true, viaRealMouse: true, selector: box.selector, overlay: got.overlay };
      }
    }

    // ② 退回页面内点击
    const res = await evalWithUtils(String.raw`
      const info = A.findFirstInfo(CFG.sel);
      if (!info.el) return { ok: false, error: '找不到触发元素' };
      const clicked = A.clickElement(info.el);
      return { ok: clicked, selector: info.selector, text: String(info.el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) };
    `, { sel: selectors });
    if (res && res.ok) {
      const got = await waitOverlay();
      if (got.ok) return { ...res, overlay: got.overlay };
    }
    return res && res.ok ? { ...res, ok: false, error: '点了但可见菜单没出现' } : (res || { ok: false, error: '打开菜单失败' });
  }

  /**
   * 列出当前浮层里的可选项。
   *
   * ★ 踩坑记录：不能"先取最后一个浮层再在它里面找"——
   *   Kimi 的"思考强度"子菜单和主菜单的浮层类名/选择器是同一套，
   *   这样会取错浮层，拿到的其实是"模型列表"而不是"档位列表"，
   *   结果就去点了错误的项（表现为"想切极致，结果切了进阶"）。
   *   正确做法：直接在文档范围内按选择器找，只保留"可见 + 在浮层里"的元素，
   *   并排除掉父级有 aria-hidden / 被隐藏的旧菜单。
   */
  async function listOptions(optionSelectorExtra) {
    return evalWithUtils(String.raw`
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const inHiddenAncestor = (el) => {
        let n = el;
        while (n && n !== document.body) {
          if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return true;
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden') return true;
          n = n.parentElement;
        }
        return false;
      };
      const usable = (el) => A.isVisible(el) && !inHiddenAncestor(el) && norm(el.textContent).length > 0 && norm(el.textContent).length < 120;

      let nodes = [];
      if (CFG.optionSelector) {
        try { nodes = Array.from(document.querySelectorAll(CFG.optionSelector)); } catch (e) { nodes = []; }
      }
      // 没有配置选择器（或没找到）时，退化为"所有可见的菜单项"
      if (!nodes.length) {
        const overlay = A.openOverlay();
        nodes = overlay ? Array.from(overlay.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], button')) : [];
      }
      nodes = nodes.filter((el, i, arr) => arr.indexOf(el) === i && usable(el));

      const options = nodes.map((el) => {
        const cls = typeof el.className === 'string' ? el.className : '';
        /*
         * ★ 选项名取"最后一行文字"：很多站点的选项项里同时含标题与值
         *   （例如 Kimi 的档位项文字是"思考强度 进阶"），
         *   直接拿整个 textContent 去匹配"进阶"会把"极致"也一起命中，
         *   导致永远只切到较低那档。
         * ⚠ 切分用 String.fromCharCode(10)，别在这里写"斜杠 n"的分隔正则：
         *   模板字符串会把反斜杠 n 变成真实换行，正则被劈成两行 → 语法错误。
         */
        const lines = String(el.textContent || '').split(String.fromCharCode(10)).map((s) => norm(s)).filter(Boolean);
        const label = lines.length ? lines[lines.length - 1] : norm(el.textContent);
        return {
          text: norm(el.textContent).slice(0, 60),
          label: label.slice(0, 40),
          checked: el.getAttribute('aria-checked') === 'true' || cls.indexOf('checked') >= 0 || cls.indexOf('selected') >= 0,
          desc: A.describe(el)
        };
      });
      return { ok: options.length > 0, options, nodes: options.length, selectorUsed: CFG.optionSelector || null,
               error: options.length ? null : '没找到可见的可选项' };
    `, { optionSelector: optionSelectorExtra || null });
  }

  /** 在浮层里点某个选项（按文字精确优先，其次包含匹配） */
  async function clickOption(optionText, optionSelectorExtra) {
    const res = await evalWithUtils(String.raw`
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      // 注意：这里用 String.fromCharCode(10) 来按换行切分，
      // 千万不要在注入脚本（模板字符串）里写"斜杠 n"形式的分隔正则 ——
      // 模板字符串会把反斜杠 n 变成真实换行，正则字面量会被劈成两行，
      // 报 SyntaxError: Invalid regular expression: missing /（这个坑连注释里
      // 出现同样的字符组合都会中招）。
      const labelOf = (el) => {
        const lines = String(el.textContent || '').split(String.fromCharCode(10)).map((s) => norm(s)).filter(Boolean);
        return lines.length ? lines[lines.length - 1] : norm(el.textContent);
      };
      const inHiddenAncestor = (el) => {
        let n = el;
        while (n && n !== document.body) {
          if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return true;
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden') return true;
          n = n.parentElement;
        }
        return false;
      };
      const want = norm(CFG.text);
      let nodes = [];
      if (CFG.optionSelector) {
        try { nodes = Array.from(document.querySelectorAll(CFG.optionSelector)); } catch (e) { nodes = []; }
      }
      if (!nodes.length) {
        const overlay = A.openOverlay();
        nodes = overlay ? Array.from(overlay.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], button')) : [];
      }
      nodes = nodes.filter((el, i, arr) => arr.indexOf(el) === i && A.isVisible(el) && !inHiddenAncestor(el));
      // 优先级：① 选项名与目标完全相同 ② 选项名包含目标 ③ 整行文字包含目标
      let hit = nodes.find((el) => labelOf(el) === want);
      if (!hit) hit = nodes.find((el) => labelOf(el).indexOf(want) >= 0);
      if (!hit) hit = nodes.find((el) => norm(el.textContent).indexOf(want) >= 0);
      if (!hit) {
        return { ok: false, error: '没找到「' + want + '」，候选：' + nodes.map((el) => labelOf(el).slice(0, 16)).join(' / ') };
      }
      A.clickElement(hit);
      return { ok: true, clicked: labelOf(hit).slice(0, 40), desc: A.describe(hit) };
    `, { text: optionText, optionSelector: optionSelectorExtra || null });
    return res;
  }

  /**
   * 把该站点切到"最好的模型 + 最强的推理"。
   * @param {object} options { enabled:boolean } —— false 时直接跳过
   * @returns {{ok:boolean, changes:string[], notes:string[]}}
   */
  async function applyBest(options = {}) {
    const result = { ok: true, changes: [], notes: [] };
    if (options.enabled === false) {
      result.notes.push('未启用（工具栏「最佳模型」未勾选）');
      return result;
    }
    const pref = getPreferences(site.id);
    if (!pref) {
      result.notes.push('该站点没有配置偏好');
      return result;
    }
    if (!isAlive()) {
      result.ok = false;
      result.notes.push('webview 未就绪');
      return result;
    }

    try {
      /* ---------- ① 开关型（DeepSeek 的"深度思考"） ---------- */
      if (pref.toggle) {
        const state = await evalWithUtils(String.raw`
          const info = A.findFirstInfo(CFG.sel);
          if (!info.el) return { ok: false, found: false };
          const cls = typeof info.el.className === 'string' ? info.el.className : '';
          const on = cls.indexOf(CFG.selectedClass) >= 0 || info.el.getAttribute('aria-pressed') === 'true' || info.el.getAttribute('aria-checked') === 'true';
          return { ok: true, found: true, on, label: String(info.el.textContent || '').trim().slice(0, 20), selector: info.selector };
        `, { sel: pref.toggle.selector, selectedClass: pref.toggle.selectedClass });
        if (!state || !state.found) {
          result.notes.push(`没找到「${pref.toggle.label}」开关`);
        } else if (state.on) {
          result.notes.push(`「${pref.toggle.label}」已经是开启状态`);
        } else {
          const clicked = await evalWithUtils(String.raw`
            const info = A.findFirstInfo(CFG.sel);
            if (!info.el) return { ok: false };
            A.clickElement(info.el);
            return { ok: true };
          `, { sel: pref.toggle.selector });
          if (clicked && clicked.ok) result.changes.push(`已开启「${pref.toggle.label}」`);
          else result.notes.push(`点击「${pref.toggle.label}」失败`);
        }
      }

      /* ---------- ② 模型档位 ---------- */
      // 注意：有的站点（Kimi）"推理强度"入口就长在模型菜单里，
      // 所以模型菜单必须保持打开，直到推理强度也设置完。
      const effortNeedsModelMenu = !!(pref.effort && pref.effort.insideModelMenu);
      let modelMenuHandled = false;

      if (pref.model) {
        const cur = await readText(pref.model.currentText || pref.model.trigger);
        const nowText = (cur && cur.text) || '';
        const wanted = pickBest([nowText], { prefer: pref.model.prefer, avoid: pref.model.avoid });
        if (wanted && !effortNeedsModelMenu) {
          result.notes.push(`模型已是较优档位：${nowText}`);
        } else {
          if (wanted) result.notes.push(`模型已是较优档位：${nowText}`);
          const opened = await openTrigger(pref.model.trigger);
          if (!opened || !opened.ok) {
            result.notes.push('打开模型菜单失败：' + ((opened && opened.error) || '未知'));
          } else {
            modelMenuHandled = true;
            if (!wanted) {
              const listed = await listOptions(null);
              if (!listed || !listed.ok) {
                result.notes.push('模型菜单没有弹出：' + ((listed && listed.error) || '未知'));
              } else {
                // 用"选项名"(label) 匹配偏好，而不是整行文字（整行里往往含标题）
                const texts = listed.options.map((o) => o.label || o.text);
                const best = pickBest(texts, pref.model);
                if (!best) {
                  result.notes.push('模型菜单里没有符合偏好的选项：' + texts.slice(0, 5).join(' / '));
                } else if (listed.options[best.index] && listed.options[best.index].checked) {
                  result.notes.push(`模型已经是最佳档位：${texts[best.index]}`);
                } else {
                  const clicked = await clickOption(texts[best.index], null);
                  if (clicked && clicked.ok) {
                    result.changes.push(`模型切换为「${texts[best.index]}」`);
                    await sleep(400);
                    // 有些站点选完模型会关掉菜单，后面要用推理强度就再开一次
                    const stillOpen = await evalWithUtils(String.raw`return { ok: !!A.openOverlay() };`, site);
                    modelMenuHandled = !!(stillOpen && stillOpen.ok);
                  } else {
                    result.notes.push('切换模型失败：' + ((clicked && clicked.error) || '未知'));
                  }
                }
              }
            }
          }
        }
      }

      /* ---------- ③ 推理强度档位（Kimi 的 标准/进阶/极致） ---------- */
      if (pref.effort) {
        // 需要先确保菜单是打开的（Kimi 的推理强度项就在模型菜单里面）
        let menuReady = true;
        if (effortNeedsModelMenu) {
          const opened = await evalWithUtils(String.raw`return { ok: !!A.openOverlay() };`, site);
          menuReady = !!(opened && opened.ok);
          if (!menuReady && pref.model) {
            const reopened = await openTrigger(pref.model.trigger);
            menuReady = !!(reopened && reopened.ok);
          }
        }
        if (!menuReady) {
          result.notes.push('推理强度入口所在菜单打不开，已跳过');
        } else {
          /*
           * ⚠ 这里【不能】因为"当前值看起来已经是目标档位"就跳过：
           *   1) currentText 可能读到整行文字（例如"思考强度 进阶"），包含关系会误判；
           *   2) 目标若是更高档位（极致），本来也必须点开才能换。
           *   所以统一打开菜单，再看选项列表里有没有"值得切换"的档位。
           */
          const cur = await readText(pref.effort.currentText || pref.effort.trigger);
          const nowText = (cur && cur.text) || '';
          const opened = await openTrigger(pref.effort.trigger);
          if (!opened || !opened.ok) {
            result.notes.push('打开推理强度菜单失败：' + ((opened && opened.error) || '未知'));
          } else {
            await sleep(500);
            const listed = await listOptions(pref.effort.optionSelector);
            if (!listed || !listed.ok) {
              result.notes.push('推理强度菜单没有弹出：' + ((listed && listed.error) || '未知'));
            } else {
              const texts = listed.options.map((o) => o.label || o.text);
              const best = pickBest(texts, pref.effort);
              if (!best) {
                result.notes.push('推理强度菜单里没有符合偏好的选项：' + texts.slice(0, 5).join(' / ') +
                  (nowText ? `（当前：${nowText}）` : ''));
              } else if (listed.options[best.index] && listed.options[best.index].checked) {
                result.notes.push(`推理强度已经是最佳档位：${texts[best.index]}`);
              } else {
                const clicked = await clickOption(texts[best.index], pref.effort.optionSelector);
                if (clicked && clicked.ok) result.changes.push(`推理强度切换为「${texts[best.index]}」`);
                else result.notes.push('切换推理强度失败：' + ((clicked && clicked.error) || '未知'));
              }
            }
          }
        }
      }

      // 收尾：关掉还开着的菜单（避免挡住输入框）
      const stillOpen = await evalWithUtils(String.raw`return { ok: !!A.openOverlay() };`, site);
      if (stillOpen && stillOpen.ok) await evalWithUtils(String.raw`A.closeOverlay(); return 1;`, site);
    } catch (err) {
      result.ok = false;
      result.notes.push('应用偏好时异常：' + String(err && err.message || err));
    }

    if (result.changes.length) log('ok', `已套用最佳配置：${result.changes.join('；')}`);
    else if (result.notes.length) log('info', `最佳配置：${result.notes.join('；')}`);
    return result;
  }

  /* ---------------------------------------------------------------- */
  /* 调试与辅助                                                        */
  /* ---------------------------------------------------------------- */

  async function debugHighlight(on) {
    return evalWithUtils(String.raw`
      const map = [
        { label: '输入框 inputSelector', selectors: CFG.inputSelector, color: '#f0abfc' },
        { label: '发送按钮 sendButtonSelector', selectors: CFG.sendButtonSelector, color: '#4ade80' },
        { label: '就绪 readySelector', selectors: CFG.readySelector, color: '#60a5fa' },
        { label: '登录 loginDetectSelector', selectors: CFG.loginDetectSelector, color: '#fbbf24' },
        { label: '二维码 qrcodeSelector', selectors: CFG.qrcodeSelector, color: '#f87171' }
      ];
      const out = A.debugHighlight(map, CFG.on);
      // 顺便把候选命中情况一并返回，日志区可以直接复制
      const detail = map.map((m) => ({ label: m.label, info: A.findFirstInfo(m.selectors) }))
        .map((m) => ({ label: m.label, selector: m.info.selector, hit: !!m.info.el }));
      return { ok: true, report: out.report || [], detail };
    `, { ...site, on: !!on });
  }

  /**
   * 逐字段诊断每个选择器的命中情况（不改 DOM、不点击）。
   * 这是"选择器失效排查"最直接的数据来源，调试模式与自检都用它。
   */
  async function diag() {
    const fields = [
      'inputSelector',
      'sendButtonSelector',
      'readySelector',
      'loginDetectSelector',
      'qrcodeSelector',
      'loggedInSelector',
      'fileInputSelector'
    ];
    const out = await evalWithUtils(String.raw`
      const result = {};
      for (const f of CFG.fields) {
        const info = A.findFirstInfo(CFG.site[f]);
        result[f] = {
          hit: !!info.el,
          selector: info.selector,                    // 实际命中的那个候选
          desc: info.el ? A.describe(info.el) : null,
          visible: info.el ? A.isVisible(info.el) : false,
          // 未命中时把"试过哪些候选"带回来，方便直接改配置
          tried: info.tried
        };
      }
      return { ok: true, fields: result };
    `, { fields, site });
    return (out && out.fields) || {};
  }

  /**
   * 只读探测：页面上有多少 file input、聊天区范围内有几个（不改 DOM）
   * 用于"探测上传框"按钮与自检。
   */
  async function fileInputPlan() {
    const res = await evalWithUtils(String.raw`
      const inputInfo = A.findFirstInfo(CFG.inputSelector);
      const scan = A.scanFileInputs(inputInfo.el);
      return { ok: true, plan: scan, inputSelector: inputInfo.selector };
    `, site);
    if (res && res.plan) {
      // 统一字段名：count = 聊天区范围内的数量（够用来判断方案 C 是否可用）
      res.plan.count = res.plan.scopedCount;
    }
    return res;
  }

  function openDebugger() {
    try {
      if (webview && typeof webview.openDevTools === 'function') {
        webview.openDevTools();
        return { ok: true };
      }
      return { ok: false, error: 'webview 不支持 openDevTools' };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  }

  /* ---------------------------------------------------------------- */
  /* ★ 完整发送流程 ★                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * @param {string} text            要发送的文本
   * @param {Array}  images          [{ dataUrl, name }]
   * @param {object} options         { timeout, keepText }
   * @returns {{ok:boolean, steps:Array, error?:string}}
   */
  async function send(text, images = [], options = {}) {
    const timeout = options.timeout || 10000;
    const steps = [];
    const mark = (step) => {
      steps.push({ ...step, at: Date.now() });
      return step;
    };

    if (!isAlive()) {
      const e = mark({ step: 'attach', ok: false, error: 'webview 未就绪' });
      return { ok: false, steps, error: e.error };
    }

    try {
      /* ---- ⓪ 先把模型/推理切到最好（可关闭） ---- */
      if (options.applyBest !== false) {
        const t = Date.now();
        const best = await applyBest({ enabled: true });
        mark({ step: 'applyBest', ok: !!(best && best.ok), changes: (best && best.changes) || [], notes: (best && best.notes) || [], ms: Date.now() - t });
        // 切换模型/档位后页面会重绘，等一拍再动输入框
        if (best && best.changes && best.changes.length) await sleep(500);
      } else {
        mark({ step: 'applyBest', ok: true, skipped: true, notes: ['未启用自动最佳配置'] });
      }

      /* ---- ① 等输入框出现 ---- */
      log('info', '等待输入框就绪…');
      const ready = await waitReady(timeout);
      if (!ready || !ready.ready) {
        if (ready && ready.needLogin) {
          mark({ step: 'waitReady', ok: false, error: '需要登录', qrcode: !!ready.qrcode });
          log('warn', `检测到未登录状态${ready.qrcode ? '（二维码已出现）' : ''}，请先扫码登录（可点栏目上的"扫码登录 📱"）`);
          return { ok: false, steps, error: '需要登录', needLogin: true };
        }
        mark({ step: 'waitReady', ok: false, error: (ready && ready.error) || '输入框未出现' });
        log('error', '输入框未出现，发送中止');
        return { ok: false, steps, error: (ready && ready.error) || '输入框未出现' };
      }
      mark({ step: 'waitReady', ok: true, selector: ready.inputSelector });
      log('ok', `输入框就绪（命中：${ready.inputSelector || '未知'}）`);

      /* ---- ② 文本注入 ---- */
      const t0 = Date.now();
      const textRes = await injectText(text);
      mark({ step: 'injectText', ok: !!textRes.ok, strategy: textRes.strategy, selector: textRes.selector, error: textRes.error, ms: Date.now() - t0 });
      if (!textRes.ok) {
        return { ok: false, steps, error: '文本注入失败：' + textRes.error };
      }

      /* ---- ③ 图片注入 ---- */
      if (images && images.length) {
        const t1 = Date.now();
        log('info', `开始注入 ${images.length} 张图片…`);
        const imgRes = await injectImages(images);
        mark({ step: 'injectImages', ok: !!imgRes.ok, strategy: imgRes.strategy, count: images.length, error: imgRes.error, ms: Date.now() - t1 });
        if (!imgRes.ok) {
          log('warn', '图片全部方案失败，仍尝试发送文字部分');
        }

        /*
         * ★ 图片注入之后必须再过一遍文字 ★
         *   很多站点处理"粘贴图片"时会重建编辑器内容（把输入框切成"图片 + 说明"模式），
         *   或者方案 A 的 Ctrl+V 把焦点/选区搞乱 —— 表现就是"图片进去了，文字却没了"。
         *   所以这里校验一次，发现文字丢了就补回来。
         */
        const afterImg = await readInput();
        const lost = !afterImg || !afterImg.text || afterImg.text.trim().length === 0;
        if (lost && String(text || '').trim().length > 0) {
          log('warn', '图片注入后输入框里没有文字了（被站点清空/重建），正在补回文字…');
          const redo = await injectText(text);
          mark({ step: 'reInjectText', ok: !!redo.ok, strategy: redo.strategy, error: redo.error });
          if (redo.ok) log('ok', `文字已补回（方式：${redo.strategy}）`);
          else log('warn', '文字补回失败：' + (redo.error || '未知'));
        } else {
          mark({ step: 'reInjectText', ok: true, skipped: true });
        }
      } else {
        mark({ step: 'injectImages', ok: true, skipped: true, strategy: '无图片' });
      }

      /* ---- ④ 点发送 ---- */
      // 等一会儿让编辑器把内容真正同步进自己的模型（ProseMirror / Lexical 有微任务之外的渲染节拍），
      // 否则会出现"输入框里明明有字，但发送按钮仍是禁用/点了没反应"。
      await sleep(450);
      const beforeText = await readInput();
      const beforeCount = await messageCount();
      const clickRes = await clickSend();
      mark({ step: 'clickSend', ok: !!(clickRes && clickRes.ok), how: clickRes && clickRes.how, error: clickRes && clickRes.error });
      if (!clickRes || !clickRes.ok) {
        log('warn', `点发送失败（${(clickRes && clickRes.error) || '未知'}），改用 Enter`);
      }

      /* ---- ⑤ 校验：输入框清空 或 页面消息数增加，二者满足其一即视为已发出 ---- */
      await sleep(700);
      let afterText = await readInput();
      let afterCount = await messageCount();
      let usedEnter = false;
      const stillHasText = !!(afterText && afterText.found && afterText.text && afterText.text.trim().length > 0);
      const grew = afterCount > beforeCount;

      if (stillHasText && !grew) {
        log('warn', '发送后输入框仍有内容且页面没有新增消息，降级模拟 Enter');
        await pressEnter();
        usedEnter = true;
        await sleep(900);
        afterText = await readInput();
        afterCount = await messageCount();
      }

      const stillHasText2 = !!(afterText && afterText.text && afterText.text.trim().length > 0);
      const grew2 = afterCount > beforeCount;
      // ★ 成功判据：① 页面确实多了一条消息（最硬）；② 或者输入框被清空了
      const delivered = grew2 || !stillHasText2;
      mark({
        step: 'verify',
        ok: delivered,
        remaining: afterText && afterText.text ? afterText.text.length : 0,
        messageDelta: afterCount - beforeCount,
        usedEnter
      });

      /* ---- ⑥ 检测风控（只提示，不绕过） ---- */
      const post = await probe();
      if (post && (post.hasRisk || (post.blocked && post.blockedKind === 'risk'))) {
        log('warn', `检测到可能的验证码/风控提示（${post.riskWord || post.blockedKind}），请手动在该栏处理，程序不会自动绕过`);
        mark({ step: 'risk', ok: false, note: post.riskWord || 'risk' });
      }

      if (delivered) {
        log('ok', `已发送${usedEnter ? '（Enter 降级）' : ''}｜原文本长度 ${String(text || '').length}` +
          (grew2 ? `｜页面消息数 +${afterCount - beforeCount}` : '｜输入框已清空'));
      } else {
        log('warn', '发送状态不确定：输入框里仍有残留内容，页面也没看到新增消息，请人工看一下该栏');
      }
      return { ok: delivered, steps, usedEnter, beforeLen: (beforeText && beforeText.text || '').length, messageDelta: afterCount - beforeCount };
    } catch (err) {
      const msg = String(err && err.message || err);
      mark({ step: 'exception', ok: false, error: msg });
      log('error', '发送流程异常：' + msg);
      return { ok: false, steps, error: msg };
    }
  }

  return {
    // 元信息
    id: site.id,
    name: site.name,
    color: site.color,
    url: site.url,
    config: site,
    loadUrl: site.url,
    fallbackUrls: site.fallbackUrls || [],
    // 生命周期
    attach,
    isAlive,
    wcId,
    currentUrl,
    currentTitle,
    ensureUtils,
    resetUtils,
    evalWithUtils,
    // 能力
    probe,
    waitReady,
    injectText,
    injectImages,
    readInput,
    clearInput,
    clickSend,
    pressEnter,
    send,
    ask,
    readLastAnswer,
    isGenerating,
    diag,
    applyBest,
    debugHighlight,
    fileInputPlan,
    openDebugger
  };
}

/* -------------------------------------------------------------------------- */
/* 导出                                                                        */
/* -------------------------------------------------------------------------- */
/*  本文件是标准 ES Module（.mjs）：
 *    - 渲染进程 renderer/arena.mjs 直接 import { createAdapter } from '../adapters/base.mjs'
 *    - Node 侧（主进程 / 测试）require 旁边的桥接文件 adapters/base.js
 *  理由同 page-utils.mjs：Chromium 的 ESM 加载器不兼容 CommonJS 默认导出，
 *  而 Node 又无法 require 含 `export` 的文件，所以实现走 ESM、Node 侧加一层包装。
 * -------------------------------------------------------------------------- */

export { createAdapter, pageUtilsSource, sleep };


