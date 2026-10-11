/**
 * ============================================================================
 *  adapters/page-utils.js
 * ----------------------------------------------------------------------------
 *  【注入到网页里执行的脚本】—— 注意：
 *  这个文件不是普通的 Node 模块，它被 main 进程用 fs 读成字符串，
 *  再通过 webview.executeJavaScript() 丢进目标网页的渲染上下文里执行。
 *  因此：
 *    - 不能 require / 不能用 Node API / 不能引用外部变量
 *    - 只能使用网页里存在的 DOM/BOM API
 *    - 整体是一个 IIFE，返回值就是 __ARENA__ 工具对象
 *
 *  暴露能力（适配器与它约定好名字）：
 *    ARENA.findFirst(selectors)          多候选选择器，返回首个命中
 *    ARENA.findFirstInfo(selectors)      { el, selector } 便于日志打印命中了谁
 *    ARENA.describe(el)                  元素描述
 *    ARENA.isVisible(el)                 可见性判断（含尺寸为 0 的隐藏元素）
 *    ARENA.deepActive()                  穿透 shadowRoot 拿真正的 activeElement
 *    ARENA.focusInput(el)                聚焦（contenteditable 与 textarea 通用）
 *    ARENA.readText(el)                  读取当前输入内容
 *    ARENA.setNativeValue(el, text)      受控组件安全赋值（React/Vue 都能感知）
 *    ARENA.clearInput(el)                清空输入框
 *    ARENA.execInsertText(el, text)      document.execCommand('insertText')
 *    ARENA.pasteFilesFromDataUrls(urls)  DataTransfer + ClipboardEvent 注入图片
 *    ARENA.countImages(el)               输入框区域内的图片数量（校验粘贴是否成功）
 *    ARENA.buildFileInputSelectors(...)  ★ 用输入框位置反推"聊天区的 file input"
 *    ARENA.debugHighlight(map, on)       选择器调试模式的高亮/取消
 *    ARENA.blockingModalInfo()           检测是否被"登录/验证码"弹窗挡住
 *    ARENA.visibleText()                 页面可见文本（用于风控关键词判断）
 *    ARENA.signature()                   页面状态指纹（用于判断"有没有变化"）
 * ============================================================================
 */

'use strict';

/* eslint-disable no-undef */

/**
 * 返回【要注入网页的脚本字符串】。
 * 用法：const source = require('./page-utils').buildPageUtils();
 *       webview.executeJavaScript(source, true);
 */
function buildPageUtils() {
  /*
   * ★ 这里必须用 String.raw`...`（原始字符串）★
   *   普通模板字符串会【处理转义】：
   *     \n \r \t 这类会被换成真实控制字符，页面里的正则就被劈成
   *     /g 这种非法形式 → "Invalid regular expression: missing /"。
   *   String.raw 让反斜杠原样保留，注入脚本里就可以像平时一样写 /\\s+/、/\\r/。
   *   （只对 ${...} 插值不动；本段脚本里没有插值，所以完全按原样输出。）
   */
  return String.raw`
(function () {
  if (window.__ARENA__ && window.__ARENA__.version === 3) {
    // 已经注入过：只返回一个可序列化的标记。
    // ⚠ 千万别在这里 return window.__ARENA__ 本身 —— 它带函数，
    //   webview.executeJavaScript 需要把返回值跨进程克隆，带函数的对象会报
    //   "An object could not be cloned."。
    return { injected: true, version: 3, cached: true };
  }

  const DEBUG_OVERLAY_ID = '__arena_debug_overlay__';

  /* ====================================================================== */
  /* 基础工具                                                               */
  /* ====================================================================== */

  /** 元素是否可见：必须有尺寸、display 不为 none、visibility 不为 hidden */
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  /** 元素描述，用于日志 */
  function describe(el) {
    if (!el) return '(null)';
    if (!(el instanceof Element)) return String(el);
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '';
    const ph = el.getAttribute('placeholder') ? '[placeholder="' + el.getAttribute('placeholder').slice(0, 20) + '"]' : '';
    const tid = el.getAttribute('data-testid') ? '[data-testid="' + el.getAttribute('data-testid') + '"]' : '';
    return tag + id + cls + tid + ph;
  }

  /** 生成一个 CSS 选择器（尽量稳，用于"一键复制"填回配置） */
  function cssPath(el) {
    if (!el || !(el instanceof Element)) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      let part = node.tagName.toLowerCase();
      if (node.getAttribute && node.getAttribute('data-testid')) {
        part += '[data-testid="' + node.getAttribute('data-testid') + '"]';
        parts.unshift(part);
        break;
      }
      const cls = (typeof node.className === 'string' ? node.className : '').trim().split(/\s+/).filter(Boolean)[0];
      if (cls) part += '.' + CSS.escape(cls);
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  /** 多候选选择器：返回首个"真实存在"的元素（优先可见的） */
  function findFirstInfo(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const hits = [];
    for (const sel of list) {
      if (!sel) continue;
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch (e) {
        // 非法选择器也记一笔，方便在调试模式里看出配置写错了
        hits.push({ selector: sel, el: null, visible: false, error: 'invalid selector' });
        continue;
      }
      // ★ 每个候选都记一条（未命中也记），这样调试模式/自检能列出"哪些没命中"
      hits.push({ selector: sel, el, visible: el ? isVisible(el) : false });
    }
    const visible = hits.find((h) => h.el && h.visible);
    const any = visible || hits.find((h) => h.el);
    return {
      el: any ? any.el : null,
      selector: any ? any.selector : null,
      tried: list,
      hits: hits.map((h) => ({ selector: h.selector, found: !!h.el, visible: !!h.visible, error: h.error || null }))
    };
  }

  function findFirst(selectors) {
    return findFirstInfo(selectors).el;
  }

  /**
   * 找所有候选命中的元素（去重）
   */
  function findAll(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const out = [];
    for (const sel of list) {
      if (!sel) continue;
      try {
        document.querySelectorAll(sel).forEach((el) => { if (!out.includes(el)) out.push(el); });
      } catch (e) { /* 忽略非法选择器 */ }
    }
    return out;
  }

  /* ====================================================================== */
  /* 下拉菜单 / 开关（用于"自动选择最佳模型/推理"）                            */
  /* ====================================================================== */

  /**
   * 触发一个元素（优先用 JS click）。
   * Radix 这类弹层对"合成点击"通常是接受的；若调用方发现菜单没出来，
   * 再由主进程用 CDP 发真实鼠标事件兜底（见 adapters/base.mjs 的 applyBest）。
   */
  function clickElement(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
    try {
      el.focus({ preventScroll: true });
    } catch (e) { try { el.focus(); } catch (e2) { /* 忽略 */ } }
    try {
      el.click();
      return true;
    } catch (e) {
      try {
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        el.dispatchEvent(new MouseEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  /** 当前打开的浮层（取最后一个可见的，通常就是最上层那个） */
  function openOverlay() {
    const sels = [
      '[role="menu"]',
      '[role="listbox"]',
      '[data-radix-popper-content-wrapper]',
      '[data-radix-menu-content]',
      '[class*="kimi-menu"]',
      '[class*="dropdown" i]',
      '[class*="popover" i]'
    ];
    const found = [];
    for (const sel of sels) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (!found.includes(el) && isVisible(el)) found.push(el);
        });
      } catch (e) { /* 忽略 */ }
    }
    return found.length ? found[found.length - 1] : null;
  }

  /**
   * 读某元素在页面上的中心点坐标（给 CDP 真实鼠标事件用）。
   * 找不到或不可见都返回 null。
   */
  function centerOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }

  /** 关闭当前浮层（Esc + 点空白） */
  function closeOverlay() {
    try {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    } catch (e) { /* 忽略 */ }
    const open = openOverlay();
    if (open) {
      try {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      } catch (e) { /* 忽略 */ }
    }
    return true;
  }

  /** 穿透 shadow DOM 找 activeElement */
  function deepActive(root) {
    let node = (root || document).activeElement;
    while (node && node.shadowRoot && node.shadowRoot.activeElement) {
      node = node.shadowRoot.activeElement;
    }
    return node;
  }

  /** 聚焦输入框：contenteditable 用 focus()，textarea 用 focus()+setSelectionRange */
  function focusInput(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center' });
    } catch (e) { /* 忽略 */ }
    try { el.click(); } catch (e) { /* 忽略 */ }
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { /* 忽略 */ } }
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      try {
        const len = (el.value || '').length;
        el.setSelectionRange(len, len);
      } catch (e) { /* 忽略 */ }
    } else if (el.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false); // 光标落到末尾
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* 忽略 */ }
    }
    return deepActive() === el || document.activeElement === el || el.contains(deepActive());
  }

  /** 读取输入框当前文本 */
  function readText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
    return String(el.innerText || el.textContent || '');
  }

  /**
   * ★ 受控组件安全赋值 ★
   * React 会在 input 元素上挂一个 _valueTracker，直接 el.value = x 会被 React 判定为
   * "值没变"从而不触发 onChange。标准做法是拿原型上的原生 setter 赋值，
   * 再把 tracker 的旧值改掉，最后派发 input 事件。
   */
  function setNativeValue(el, value) {
    if (!el) return false;

    // ① 输入框
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      try {
        if (setter && setter.set) setter.set.call(el, value);
        else el.value = value;
      } catch (e) {
        el.value = value;
      }
      // 欺骗 React 的 value tracker
      try {
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue('');
      } catch (e) { /* 忽略 */ }

      /*
       * ★ 事件派发要"成套" ★
       *   只发一个普通 Event('input')，React 18+ 的受控组件（豆包的 textarea 就是）
       *   不一定认，表现是"输入框里看得见文字，但发送按钮一直是禁用态"。
       *   这里按浏览器真实输入的顺序补齐：
       *     beforeinput(InputEvent) → input(InputEvent, inputType=insertText) → change
       */
      try {
        el.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: value
        }));
      } catch (e) { /* 老内核忽略 */ }
      try {
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: value
        }));
      } catch (e) {
        try { el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true })); } catch (e2) { /* 忽略 */ }
      }
      try { el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true })); } catch (e) { /* 忽略 */ }
      return true;
    }

    // ③ contenteditable：整体替换子节点，尽量保留一个 <p> 结构（ProseMirror 友好）
    if (el.isContentEditable) {
      focusInput(el);
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, value);
      } catch (e) { ok = false; }
      if (!ok || readText(el).trim() !== String(value).trim()) {
        // 降级：手工构造 HTML 文本行
      const lines = String(value).split(/\n/);
        el.innerHTML = lines.map((line) => '<p>' + (line === '' ? '<br>' : escapeHtml(line)) + '</p>').join('');
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value })); } catch (e) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return true;
    }
    return false;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 选中输入框全部内容。
   * ★ 一定要验证"选区真的建立了" —— Lexical 这类编辑器在某些状态下
   *   （比如从别处点进来、选区落在正文外）会忽略程序设置的 Range，
   *   后面所有基于选区的操作（insertText/delete）就都白做。
   */
  function selectAll(el) {
    if (!el) return -1;
    try {
      el.focus({ preventScroll: true });
    } catch (e) { try { el.focus(); } catch (e2) { /* 忽略 */ } }
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      // 有些内核要求再 setBaseAndExtent 一次才认
      if (!String(sel.toString()).length && el.firstChild) {
        try { sel.setBaseAndExtent(el, 0, el, el.childNodes.length); } catch (e) { /* 忽略 */ }
      }
      return String(sel.toString()).length;
    } catch (e) {
      return -1;
    }
  }

  /** 清空输入框（对 Lexical 这类"有内部模型"的编辑器也能生效） */
  function clearInput(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      setNativeValue(el, '');
      return true;
    }
    if (!el.isContentEditable) return false;

    const touched = readText(el).length > 0;
    focusInput(el);

    // ① 首选：选中全部 -> insertText 空串（编辑器会走自己的 input 流程，模型同步）
    const selLen = selectAll(el);
    let ok = false;
    try { ok = document.execCommand('insertText', false, ''); } catch (e) { ok = false; }
    if (readText(el).trim().length === 0) return true;

    // ② 再试：选中全部 -> delete
    if (selLen > 0 || touched) {
      selectAll(el);
      try { document.execCommand('delete', false, null); } catch (e) { /* 忽略 */ }
      if (readText(el).trim().length === 0) return true;
    }

    // ③ 兜底：直接改 DOM（Lexical 这类"有内部模型"的编辑器里，
    //    这只保证 DOM 是空的，模型可能还留着旧内容，所以放在最后）
    try { el.innerHTML = ''; } catch (e) { /* 忽略 */ }
    try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); } catch (e) {
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) { /* 忽略 */ }
    }
    return true;
  }

  /**
   * ★ 一步到位地"把输入框内容替换成 text" ★
   * 对 Lexical 这类编辑器：先确保选区真的选中了全部内容，再用 insertText 覆盖 ——
   * 直接改 innerHTML 会"看着有字、其实没字"（内部模型没更新）。
   * 返回 { ok, selLen, execOk, now }
   */
  function replaceAllText(el, text) {
    if (!el) return { ok: false, error: '没有输入框' };
    const want = String(text);
    const norm = (s) => String(s == null ? '' : s).replace(/\s+$/, '');

    // textarea / input：走受控组件安全赋值
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const ok = setNativeValue(el, want);
      return { ok: ok && norm(readText(el)) === norm(want), now: readText(el) };
    }
    if (!el.isContentEditable) return { ok: false, error: '元素不可编辑' };

    focusInput(el);
    const selLen = selectAll(el);
    // 选区没建立成功（Lexical 偶发）时，先清一次再来
    if (selLen === 0 && readText(el).length > 0) {
      clearInput(el);
      focusInput(el);
      selectAll(el);
    }

    let execOk = false;
    try { execOk = document.execCommand('insertText', false, want); } catch (e) { execOk = false; }

    let now = readText(el);
    if (norm(now) !== norm(want)) {
      // 再兜一次：清空 + 重新聚焦 + 覆盖
      clearInput(el);
      focusInput(el);
      selectAll(el);
      try { document.execCommand('insertText', false, want); } catch (e) { /* 忽略 */ }
      now = readText(el);
    }

    return { ok: norm(now) === norm(want), selLen, execOk, now };
  }

  /** execCommand 版本注入（保留原语义，作为方案之一） */
  function execInsertText(el, text) {
    if (!el) return false;
    focusInput(el);
    try {
      return document.execCommand('insertText', false, String(text));
    } catch (e) {
      return false;
    }
  }

  /** 输入区域内的图片数量（用于判断"图片是否真的粘进去了"） */
  function countImages(el) {
    if (!el || !el.closest) return 0;
    // 往上找 4 层，覆盖"输入框 -> 编辑器 -> composer 容器"这个范围
    let scope = el;
    for (let i = 0; i < 4 && scope.parentElement; i++) scope = scope.parentElement;
    try {
      return scope.querySelectorAll('img').length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * ★ 方案 B：页面内构造 DataTransfer + ClipboardEvent 注入图片 ★
   * 参数是 dataURL 数组，函数内部自己转成 File。
   */
  async function pasteFilesFromDataUrls(dataUrls, targetEl) {
    try {
      const dt = new DataTransfer();
      for (let i = 0; i < dataUrls.length; i++) {
        const url = dataUrls[i];
        const res = await fetch(url);
        const blob = await res.blob();
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const file = new File([blob], 'arena-image-' + Date.now() + '-' + i + '.' + ext, {
          type: blob.type || 'image/png'
        });
        dt.items.add(file);
      }
      const el = targetEl || deepActive() || document.body;
      focusInput(el);
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt
      };
      let evt;
      try {
        evt = new ClipboardEvent('paste', init);
      } catch (e) {
        evt = new Event('paste', { bubbles: true, cancelable: true });
      }
      // 关键：绕过只读属性，把 DataTransfer 硬塞进事件
      try {
        Object.defineProperty(evt, 'clipboardData', { value: dt, writable: false, configurable: true });
      } catch (e) { /* 某些内核已允许构造时传入 */ }
      const dispatched = el.dispatchEvent(evt);
      return { ok: true, files: dt.files.length, dispatched };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  /**
   * ★ 用输入框位置反推"聊天区的 file input" ★
   * 页面里通常有多个 input[type=file]（头像、聊天附件…），
   * 这里沿着输入框往上找，收集同一个 composer 容器内的 file input，
   * 并给它们打上标记，CDP 阶段直接按标记取，避免把图传到"换头像"的 input 上。
   *
   * ⚠ 本函数会写 DOM（加属性标记），只在"真的要注入图片"时调用；
   *    纯查看请用 scanFileInputs()。
   */
  function buildFileInputSelectors(inputEl, extraSelectors) {
    const mark = '__arena_file_input__';
    const scoped = collectFileInputs(inputEl);
    const all = Array.from(document.querySelectorAll('input[type="file"]'));
    const imageOnly = all.filter((el) => ((el.getAttribute('accept') || '').toLowerCase()).includes('image'));

    const candidates = [];
    [].concat(scoped, imageOnly, all).forEach((el) => { if (el && !candidates.includes(el)) candidates.push(el); });

    // 清掉上一轮标记后，只给"聊天区范围内"的那些打标记
    document.querySelectorAll('[' + mark + '="1"]').forEach((el) => el.removeAttribute(mark));
    scoped.forEach((el) => el.setAttribute(mark, '1'));

    const selectors = [];
    if (scoped.length) selectors.push('input[type="file"][' + mark + '="1"]');
    (extraSelectors || []).forEach((s) => selectors.push(s));
    if (imageOnly.length) selectors.push('input[type="file"][accept*="image"]');
    selectors.push('input[type="file"]');

    return {
      count: scoped.length,
      totalOnPage: all.length,
      selectors,
      // hidden 为 true 不代表不能用：CDP 对隐藏的 file input 一样有效，
      // "隐藏 input + 自定义上传按钮"才是这类站点的常见做法。
      details: candidates.map((el) => ({
        scoped: scoped.includes(el),
        accept: el.getAttribute('accept') || '',
        multiple: el.hasAttribute('multiple'),
        hidden: !isVisible(el),
        css: cssPath(el)
      }))
    };
  }

  /** 沿输入框向上收集 composer 容器内的 file input（含输入框自身的情况） */
  function collectFileInputs(inputEl) {
    const out = [];
    if (!inputEl) return out;
    let scope = inputEl;
    for (let i = 0; i < 6 && scope; i++) {
      if (scope.matches && scope.matches('input[type="file"]') && !out.includes(scope)) out.push(scope);
      if (scope.querySelectorAll) {
        scope.querySelectorAll('input[type="file"]').forEach((el) => { if (!out.includes(el)) out.push(el); });
      }
      scope = scope.parentElement;
    }
    return out;
  }

  /** 只读地看一眼页面上的 file input（不改 DOM），供"探测上传框"按钮使用 */
  function scanFileInputs(inputEl) {
    const all = Array.from(document.querySelectorAll('input[type="file"]'));
    return {
      totalOnPage: all.length,
      scopedCount: collectFileInputs(inputEl).length,
      details: all.map((el) => ({
        accept: el.getAttribute('accept') || '',
        multiple: el.hasAttribute('multiple'),
        hidden: !isVisible(el),
        css: cssPath(el)
      }))
    };
  }

  /* ====================================================================== */
  /* 选择器调试模式：在页面上画高亮框                                         */
  /* ====================================================================== */

  function removeOverlay() {
    const old = document.getElementById(DEBUG_OVERLAY_ID);
    if (old) old.remove();
    document.querySelectorAll('.__arena_hl__').forEach((el) => el.remove());
  }

  /**
   * map 形如 [{ label: '输入框', selectors: [...], color: '#f0abfc' }, ...]
   */
  function debugHighlight(map, on) {
    removeOverlay();
    if (!on) return { ok: true, cleared: true };

    const host = document.createElement('div');
    host.id = DEBUG_OVERLAY_ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    document.documentElement.appendChild(host);

    const report = [];
    for (const item of (map || [])) {
      const info = findFirstInfo(item.selectors);
      if (!info.el) {
        report.push({ label: item.label, hit: false, selector: null });
        continue;
      }
      const rect = info.el.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = '__arena_hl__';
      box.style.cssText =
        'position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid ' + (item.color || '#f0abfc') + ';' +
        'left:' + (rect.left - 2) + 'px;top:' + (rect.top - 2) + 'px;' +
        'width:' + (rect.width + 4) + 'px;height:' + (rect.height + 4) + 'px;' +
        'background:' + (item.color || '#f0abfc') + '22;border-radius:6px;';
      const tag = document.createElement('div');
      tag.className = '__arena_hl__';
      tag.textContent = item.label + ' ⇦ ' + info.selector;
      tag.style.cssText =
        'position:fixed;pointer-events:none;font:11px/1.4 monospace;color:#0b0f14;background:' + (item.color || '#f0abfc') + ';' +
        'padding:2px 6px;border-radius:4px;left:' + Math.max(2, rect.left) + 'px;' +
        'top:' + Math.max(2, rect.top - 20) + 'px;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      host.appendChild(box);
      host.appendChild(tag);
      report.push({ label: item.label, hit: true, selector: info.selector, css: cssPath(info.el), desc: describe(info.el) });
    }
    return { ok: true, report };
  }

  /* ====================================================================== */
  /* 页面状态检测                                                           */
  /* ====================================================================== */

  function visibleText(limit) {
    try {
      // innerText 更贴近"用户看到的文字"，但某些环境（含无头/无障碍模式）拿不到，
      // 这时退回 textContent，保证风控关键词检测不会漏。
      const body = document.body;
      if (!body) return '';
      let text = '';
      try { text = body.innerText || ''; } catch (e) { text = ''; }
      if (!text) text = body.textContent || '';
      return String(text).slice(0, limit || 4000);
    } catch (e) {
      return '';
    }
  }

  /** 是否被一个"挡住整个页面"的弹窗拦住了（登录框/验证码） */
  function blockingModalInfo(loginSelectors, riskSelectors) {
    const result = { blocking: false, kind: null, selector: null };
    const login = findFirstInfo(loginSelectors);
    if (login.el && isVisible(login.el)) {
      result.blocking = true;
      result.kind = 'login';
      result.selector = login.selector;
    }
    const risk = findFirstInfo(riskSelectors);
    if (risk.el && isVisible(risk.el)) {
      result.blocking = true;
      result.kind = 'risk';
      result.selector = risk.selector;
    }
    return result;
  }

  /** 轻量指纹：消息条数 + 可见文本长度 + 图片数，用于判断"页面有没有变化" */
  function signature() {
    const t = visibleText(6000);
    return {
      textLen: t.length,
      tail: t.slice(-200),
      imgCount: document.images.length,
      time: Date.now()
    };
  }

  /**
   * 估算"页面上有多少条消息"：找一个纵向可滚动、内容很长的容器，数它的直接子元素。
   * 用于给"发送到底成没成功"提供客观依据（比只看输入框是否清空可靠）。
   */
  function countMessages() {
    let best = null;
    let bestScore = 0;
    const nodes = document.querySelectorAll('div,main,section,ul');
    for (const el of nodes) {
      const score = (el.scrollHeight || 0) - (el.clientHeight || 0);
      if (score > bestScore && el.clientHeight > 200 && el.children.length > 0) {
        bestScore = score;
        best = el;
      }
    }
    if (!best) return { count: 0, textLen: 0 };
    return { count: best.children.length, textLen: (best.innerText || '').length };
  }

  /** 找到"消息列表容器"（最可能是对话正文的那个可滚动容器） */
  function findMessageContainer() {
    const explicit = document.querySelectorAll('[class*="message-list" i], [class*="chat-list" i], [class*="conversation" i], [role="log"], [data-testid*="message-list"]');
    for (const el of explicit) if (isVisible(el) && el.children.length > 0) return el;

    let best = null;
    let bestScore = 0;
    for (const el of document.querySelectorAll('div,main,section,ul')) {
      const score = (el.scrollHeight || 0) - (el.clientHeight || 0);
      if (score > bestScore && el.clientHeight > 200 && el.children.length > 0) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  /**
   * 抓取"最后一条 AI 回答"的文本。
   * 思路：在消息容器里从后往前找"文字量足够大"的后代节点，
   * 取最靠后的那一段 —— 对三个站点都够用，不需要各自写死类名。
   */
  function extractLastAnswer() {
    const container = findMessageContainer();
    if (!container) return { ok: false, text: '', error: '找不到消息容器' };

    const clean = (t) => String(t || '')
      // ⚠ 双反斜杠：本段代码在模板字符串里，单反斜杠的 \r \t 会被解释成真实控制字符，
      //   正则会变成非法的 /g（踩过两次了）。
      .replace(/\r/g, '')
      .split(String.fromCharCode(10))
      .map((s) => s.replace(/[ \t]+/g, ' ').trim())
      .filter((s) => s.length > 0)
      .join(String.fromCharCode(10))
      .trim();

    // 候选：容器里有实际文字的后代（排除按钮/输入区/太短的）
    const nodes = Array.from(container.querySelectorAll('div,article,section,li,p,td'));
    let best = null;
    let bestScore = -1;
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      if (el.querySelector('[contenteditable="true"], textarea, button, input')) continue; // 输入区/工具条不算
      const t = clean(el.innerText || el.textContent);
      if (t.length < 8) continue;
      // 越靠后、越长越可能是最后一条回答
      const rect = el.getBoundingClientRect();
      const order = rect.top + (container.scrollTop || 0);
      const score = order + Math.min(t.length, 3000) * 0.5;
      if (score > bestScore) { bestScore = score; best = { el, text: t }; }
    }
    if (!best) {
      // 兜底：整页可见文字的最后一段
      const t = clean(visibleText(20000));
      return { ok: t.length > 0, text: t.slice(-4000), fallback: true };
    }
    return {
      ok: true,
      text: best.text.slice(-8000),
      length: best.text.length,
      containerDesc: describe(container),
      nodeDesc: describe(best.el)
    };
  }

  /**
   * 页面上是否有"停止生成"按钮（用来判断 AI 还在回答）。
   * ⚠ 选择器要够精确：早期用过宽泛的 [class*="stop" i]，结果把常驻元素也匹配上，
   *   导致"永远认为在生成中"，等待回答的循环永远不结束。
   */
  function isGenerating(extraSelectors) {
    const sels = [].concat(extraSelectors || [], [
      '[class*="stop-generat" i]',
      '[class*="stopGenerat" i]',
      '[data-testid*="stop" i]',
      'button[aria-label*="停止"]',
      'button[aria-label*="Stop" i]'
    ]);
    for (const sel of sels) {
      if (!sel) continue;
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (!isVisible(el)) continue;
          if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
            return { generating: true, via: sel, desc: describe(el) };
          }
        }
      } catch (e) { /* 忽略非法选择器 */ }
    }
    return { generating: false, via: null };
  }

  /**
   * ★ DOM 差分取答案 ★
   * 发送前后各取一次"右侧主区域的文字型元素"，比较出【新出现】的那个 ——
   * 它就是这次的回答。这比"猜哪个容器是消息列表"可靠得多。
   */
  /**
   * 找"包含某节点的最外层思考块"。
   * 三个站点的思考/推理内容都有明显标记（DeepSeek 的 ds-think-content、
   * Kimi 的 thinking-container、豆包的"已思考/深度思考"），
   * 必须把这类内容排除掉，否则卡片里显示的是"内心独白"而不是回答。
   */
  function inThinkingBlock(el) {
    let n = el;
    for (let k = 0; k < 12 && n && n !== document.body; k++) {
      const cls = typeof n.className === 'string' ? n.className : '';
      const tid = n.getAttribute ? (n.getAttribute('data-testid') || '') : '';
      if (/think|reasoning|thought/i.test(cls + ' ' + tid)) return true;
      const head = String(n.innerText || '').slice(0, 24);
      // 中文思考块的典型开头 + 英文思考块（Kimi 会用英文思考）
      if (/^(已思考|思考中|思考完成|深度思考|思考过程|我们需要|我们要|用户(问|要求|想)|首先我|让我(想|分析))/.test(head)) return true;
      if (/^(We need|I need|The user|Let me|First,? I)/.test(head)) return true;
      n = n.parentElement;
    }
    return false;
  }

  /**
   * 回答快照：只取"叶子级文本块"（自身不再包含块级子元素），
   * 这样拿到的是"真正的回答段落"，而不是包住整段对话的大容器。
   * 每条都带 thinking 标记，diff 时可以优先选非思考内容。
   */
  function snapshotMessages() {
    const out = [];
    const all = document.querySelectorAll('div,article,section,li,p');
    for (const el of all) {
      if (!isVisible(el)) continue;
      // 还有块级子元素 → 不是叶子文本，跳过（避免把整个会话容器算进来）
      if (el.querySelector('div,section,article,ul,ol,table,p')) continue;
      const t = String(el.innerText || '').trim();
      if (t.length < 30) continue;
      const r = el.getBoundingClientRect();
      if (r.width > window.innerWidth * 0.92) continue;                 // 整页宽不要
      if (r.left < 220 && r.width < window.innerWidth * 0.5) continue;  // 左侧栏不要
      out.push({
        top: r.top,
        height: r.height,
        len: t.length,
        text: t.slice(0, 20000),
        nodeDesc: describe(el),
        thinking: inThinkingBlock(el)
      });
    }
    return out;
  }

  /** 从"发送前快照"里找出新增/变长的条目（即这次的回答） */
  function diffNewMessages(before, after) {
    const beforeByTop = new Map();
    for (const it of (before || [])) beforeByTop.set(Number(it.top).toFixed(0), it.len);

    const fresh = (after || []).filter((it) => {
      const key = Number(it.top).toFixed(0);
      const oldLen = beforeByTop.get(key);
      if (oldLen === undefined) return true;              // 位置全新
      return it.len > oldLen + 10;                        // 同位置但内容变长了
    });

    // ★ 优先取"非思考"的条目；都没有才退回思考内容（宁可给点东西也不要空）
    const normal = fresh.filter((it) => !it.thinking);
    const pool = (normal.length ? normal : fresh).slice().sort((a, b) => a.top - b.top);
    if (!pool.length) return null;

    /*
     * 把"同一块回答"里的多个段落合并起来。
     * 实测：DeepSeek 的回答是多段 <p>，"只取最后一段"会丢内容。
     * 做法：从最新的那条往上找最近的消息级容器，再把该容器里
     *       非思考的文本块拼起来。
     */
    const last = pool[pool.length - 1];
    const anchor = pool.find((it) => it.nodeDesc === last.nodeDesc) || last;
    const merged = mergeAnswerNear(anchor, pool);
    return { ...(merged || last), thinking: !normal.length, parts: pool.length };
  }

  /**
   * 以 anchor 为起点，向上找一个"消息级容器"，把该容器内
   * 所有非思考的文本块按顺序拼成完整回答。
   * 找不到合适容器就退回 anchor 自身。
   */
  function mergeAnswerNear(anchor, pool) {
    /*
     * 只合并"紧邻"的段落（纵向 160px 内）。
     * 踩过坑：范围放宽到 420px 时，把上方那段"思考过程"也并进来了，
     * 卡片里就出现了"我们需要回答用户中文请求……"这种内心独白。
     */
    const near = (pool || [])
      .filter((it) => !it.thinking)
      .filter((it) => Math.abs(it.top - anchor.top) < 160)
      .filter((it) => it.len >= 30 && it.len <= 8000)
      .sort((a, b) => a.top - b.top);
    if (near.length <= 1) return anchor;
    // 去掉互为子串的重复段落（父子节点文字相同的情况）
    const texts = [];
    for (const it of near) {
      const t = it.text;
      if (texts.some((x) => x === t || x.indexOf(t) >= 0)) continue;
      const idx = texts.findIndex((x) => t.indexOf(x) >= 0);
      if (idx >= 0) texts[idx] = t; else texts.push(t);
    }
    const text = texts.join(String.fromCharCode(10) + String.fromCharCode(10));
    return {
      ...anchor,
      text,
      len: text.length,
      nodeDesc: anchor.nodeDesc + (texts.length > 1 ? ' (+' + (texts.length - 1) + ' 段)' : ''),
      mergedFrom: texts.length
    };
  }

  /* ====================================================================== */

  const api = {
    version: 3,
    isVisible,
    describe,
    cssPath,
    findFirst,
    findFirstInfo,
    findAll,
    clickElement,
    openOverlay,
    closeOverlay,
    centerOf,
    deepActive,
    focusInput,
    readText,
    setNativeValue,
    clearInput,
    selectAll,
    replaceAllText,
    execInsertText,
    countImages,
    pasteFilesFromDataUrls,
    buildFileInputSelectors,
    collectFileInputs,
    scanFileInputs,
    debugHighlight,
    removeOverlay,
    visibleText,
    blockingModalInfo,
    signature,
    countMessages,
    findMessageContainer,
    extractLastAnswer,
    isGenerating,
    snapshotMessages,
    diffNewMessages,
    href: location.href,
    title: document.title
  };

  window.__ARENA__ = api;
  // ★ 返回值必须是"可序列化"的：executeJavaScript 会把返回值跨进程克隆回来，
  //   直接 return api 会带上函数 → 报 "An object could not be cloned."。
  //   真正的工具对象挂在 window.__ARENA__ 上，后续脚本从那里取。
  return { injected: true, version: 3, cached: false };
})();
`;
}

/* -------------------------------------------------------------------------- */
/* 导出                                                                        */
/* -------------------------------------------------------------------------- */
/*  ★ 加载方式说明（改文件名前先看这里）★
 *
 *  本文件是标准 ES Module（.mjs），因为要被【Chromium 的 ESM 加载器】直接
 *  import —— 渲染进程的 renderer/arena.mjs 会
 *      import { buildPageUtils } from '../adapters/page-utils.mjs'
 *  Chromium 的 ESM 加载器不像 Node 那样兼容 CommonJS 的默认导出，
 *  所以实现文件必须是真 ESM。
 *
 *  而主进程 / Node 测试走的是 CommonJS 的 require，无法 require 一个含
 *  `export` 语句的文件（Node 会直接报 Unexpected token 'export'）。
 *  因此旁边有一个同名桥接文件 adapters/page-utils.js：
 *      module.exports = { buildPageUtils }   ← 内部用同步 import() 桥接
 *
 *  Node 侧：   require('./page-utils')         （拿到桥接文件）
 *  浏览器侧：  import './page-utils.mjs'       （拿到本文件）
 *  逻辑只在这一份文件里，不存在两份实现需要同步。
 * -------------------------------------------------------------------------- */

export { buildPageUtils };

