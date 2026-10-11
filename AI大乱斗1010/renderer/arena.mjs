/**
 * ============================================================================
 *  renderer/arena.mjs —— 渲染进程主逻辑（ES Module）
 * ----------------------------------------------------------------------------
 *  包含：
 *   1. 三栏视图构建 + 状态机（灰/黄/绿/红）
 *   2. webview 生命周期（加载、失败重试、崩溃恢复）
 *   3. 每 2 秒轮询登录状态；检测到需要扫码 -> 亮出"扫码登录 📱"
 *   4. 放大/缩小单栏（扫码辅助），登录成功后自动缩小
 *   5. 统一输入区：文本 + 多图（选择/拖拽/粘贴），Enter 发送 / Shift+Enter 换行
 *   6. "开战 🥊" —— 三站点同时发送，Promise.allSettled 互不阻塞
 *   7. 选择器调试模式（Ctrl+Shift+D）：高亮命中元素 + 日志打印命中选择器
 *   8. 同步滚动开关、只发勾选站点、页面加载失败重试、底部时序日志
 * ============================================================================
 */

import { SITE_CONFIGS } from './site-config.mjs';
// 适配器实现是 .mjs（标准 ES Module）；同名 .js 是给 Node 侧的 CommonJS 桥接，浏览器不要用
import { buildPageUtils } from '../adapters/page-utils.mjs';
import { createAdapter } from '../adapters/base.mjs';

/* ========================================================================== */
/* 全局状态                                                                    */
/* ========================================================================== */

/** 日志条数上限，避免长时间运行后 DOM 过大 */
const MAX_LOG_LINES = 400;
/** 登录状态轮询间隔（需求：每 2 秒一次） */
const POLL_INTERVAL = 2000;
/** 粘贴/复制图片大小上限 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 页面注入脚本源码（只生成一次） */
const PAGE_UTILS_SOURCE = buildPageUtils();
/** 注入到网页里的同步滚动小脚本源码 */
const SYNC_SCROLL_SOURCE = `
(() => {
  if (window.__ARENA_SYNC__) return window.__ARENA_SYNC__;
  const api = { on: false, last: 0, findScroller() {
    const all = Array.from(document.querySelectorAll('div,main,section'));
    let best = document.scrollingElement || document.documentElement;
    let bestScore = best ? best.scrollHeight - best.clientHeight : 0;
    for (const el of all) {
      const score = el.scrollHeight - el.clientHeight;
      if (score > bestScore && el.clientHeight > 200) { best = el; bestScore = score; }
    }
    return best;
  }, ratio() {
    const el = this.findScroller();
    if (!el) return 0;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return 0;
    return (el.scrollTop || window.scrollY || 0) / max;
  }, apply(r) {
    const el = this.findScroller();
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    const top = Math.max(0, Math.min(max, r * max));
    el.scrollTop = top;
    if (el === document.documentElement || el === document.body) window.scrollTo(0, top);
  }};
  const push = (force) => {
    if (!api.on) return;
    const now = Date.now();
    if (!force && now - api.last < 120) return;
    api.last = now;
    try { window.arena.syncScroll(api.ratio()); } catch (e) {}
  };
  // wheel/scroll 都会触发，加 rAF 合并
  let ticking = false;
  const onAny = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; push(false); });
  };
  window.addEventListener('scroll', onAny, { passive: true, capture: true });
  window.addEventListener('wheel', onAny, { passive: true });
  window.addEventListener('touchmove', onAny, { passive: true });
  window.__ARENA_SYNC__ = api;
  // ⚠ 必须返回可序列化的值：api 里全是函数，直接返回会触发
  //   "An object could not be cloned."（executeJavaScript 的返回值要跨进程克隆）
  return true;
})();
`;

/** 每栏的运行时状态 */
const state = {
  sites: {},          // id -> siteState
  images: [],         // [{ id, name, dataUrl, size }]
  sending: false,     // 是否正在开战（防重复发送）
  debugMode: false,   // 选择器调试模式
  syncScroll: false,  // 同步滚动
  syncLock: 0,        // 同步滚动回环保护时间戳
  layout: 'columns',  // columns | rows
  enlarged: null,      // 被放大的站点 id
  autoShrinkArmed: null, // 放大前是否是"未登录"，用于判断登录成功后自动缩小
  applyBest: true,     // 发送前是否自动切到最佳模型/最强推理（工具栏「最佳模型」）
  view: 'battle',      // battle = 对战三栏 | chat = 聊天问答
  chatOnly: false      // true = 这是"聊天助手"独立窗口（index.html#chat），只显示聊天页
};

/** id -> { config, adapter, el: {column, webview, ...}, status... } */
const registry = new Map();

/** 主进程返回的运行时信息（webview preload 路径、临时目录等） */
const RUNTIME = {
  webviewPreload: '',
  tempDir: '',
  versions: {},
  selftest: false
};

/* ========================================================================== */
/* 小工具                                                                      */
/* ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** HTML 转义，防止站点名/错误信息里的尖括号破坏 DOM */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeText(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '?';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

/* ========================================================================== */
/* 日志区                                                                      */
/* ========================================================================== */

let logSeq = 0;

/**
 * 统一的日志入口。
 * @param {'info'|'ok'|'warn'|'error'|'step'} level
 * @param {string} message
 * @param {object} [detail] 附加数据（会以折叠形式跟在后面）
 */
function addLog(level, message, detail) {
  const box = $('#logLines');
  if (!box) return;

  // 自动滚动：只有用户已经在底部时才跟随，避免打断向上翻看
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;

  const line = document.createElement('div');
  line.className = 'log-line log-' + level;
  line.dataset.seq = String(++logSeq);
  let extra = '';
  if (detail !== undefined && detail !== null) {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    if (text && text !== '{}' && text !== 'null') {
      extra = ` <span class="log-detail">${esc(text.slice(0, 400))}</span>`;
    }
  }
  line.innerHTML =
    `<span class="log-time">${timeText()}</span>` +
    `<span class="log-level">${esc(level.toUpperCase())}</span>` +
    `<span class="log-msg">${esc(message)}</span>${extra}`;
  box.appendChild(line);

  // 淘汰旧日志
  while (box.childElementCount > MAX_LOG_LINES) box.removeChild(box.firstElementChild);

  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** 构造给适配器用的 hooks */
function adapterHooks(siteId) {
  const cfg = SITE_CONFIGS.find((s) => s.id === siteId);
  return {
    log: (level, message, detail) => addLog(level, message, detail),
    onState: (patch) => {
      const st = state.sites[siteId];
      if (!st) return;
      Object.assign(st, patch);
      renderStatus(siteId);
    },
    siteName: cfg ? cfg.name : siteId
  };
}

/* ========================================================================== */
/* 三栏视图构建                                                                */
/* ========================================================================== */

function buildBoards() {
  const wrap = $('#boards');
  wrap.innerHTML = '';

  SITE_CONFIGS.forEach((cfg) => {
    /* ---------------- 单栏骨架 ---------------- */
    const column = document.createElement('section');
    column.className = 'column';
    column.dataset.site = cfg.id;
    column.style.setProperty('--site-color', cfg.color);
    column.innerHTML = `
      <header class="col-head">
        <label class="col-pick" title="勾选后才会收到消息">
          <input type="checkbox" class="site-pick" data-site="${cfg.id}" checked />
        </label>
        <span class="led led-gray" data-role="led" title="未加载"></span>
        <span class="col-name" style="color:${esc(cfg.color)}">${esc(cfg.name)}</span>
        <span class="col-state" data-role="stateText">未加载</span>
        <span class="col-spacer"></span>
        <button class="mini" data-act="scan" data-site="${cfg.id}" title="放大该栏，方便手机扫码">扫码登录 📱</button>
        <button class="mini" data-act="zoom" data-site="${cfg.id}" title="放大 / 缩小该栏">放大 ⛶</button>
        <button class="mini" data-act="reload" data-site="${cfg.id}" title="重新加载该栏">重新加载 ⟳</button>
        <button class="mini" data-act="devtools" data-site="${cfg.id}" title="打开该栏 DevTools（F12 也可）">调试</button>
        <button class="mini" data-act="signout" data-site="${cfg.id}" title="清除该站点登录态并重新打开">清登录态</button>
      </header>
      <div class="col-body" data-role="body">
        <div class="col-loading" data-role="loading">
          <div class="spinner"></div>
          <div>正在加载 ${esc(cfg.name)} …</div>
          <div class="dim">首次使用请在该栏里手动登录（右上角"扫码登录 📱"可放大二维码）</div>
        </div>
        <div class="col-error" data-role="error" hidden>
          <div class="err-title">页面加载失败或无法连接</div>
          <div class="err-msg" data-role="errorMsg"></div>
          <div class="err-actions">
            <button class="mini" data-act="reload" data-site="${cfg.id}">重试 ⟳</button>
            <button class="mini" data-act="switchUrl" data-site="${cfg.id}">换个域名试试</button>
            <button class="mini" data-act="openExternal" data-site="${cfg.id}">用系统浏览器打开</button>
          </div>
        </div>
        <div class="col-hint" data-role="hint" hidden></div>
      </div>
    `;
    wrap.appendChild(column);

    /* ---------------- webview ---------------- */
    const body = $('[data-role="body"]', column);
    const webview = document.createElement('webview');
    webview.className = 'site-view';
    webview.setAttribute('data-site', cfg.id);
    // ★ partition：persist: 前缀保证 cookie/localStorage 落盘，重启后登录态仍在
    webview.setAttribute('partition', cfg.partition);
    // 允许在同一 partition 内读取 cookie（Electron 默认行为，显式写出便于理解）
    // 注意：不要写 allowpopups —— Electron 只看"属性是否存在"，写 allowpopups="false"
    // 也会被当成 true（会打开弹窗并触发安全警告）。弹窗拦截统一交给主进程的
    // app.on('web-contents-created') 处理。
    webview.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes');
    // webview 自己的 preload（提供同步滚动回传能力），路径由主进程算好
    if (RUNTIME.webviewPreload) webview.setAttribute('preload', RUNTIME.webviewPreload);
    // 初始 src 稍后由 loadSite() 统一设置，便于"换个域名重试"
    body.appendChild(webview);

    registry.set(cfg.id, {
      config: cfg,
      adapter: createAdapter(cfg, adapterHooks(cfg.id)),
      el: {
        column,
        body,
        webview,
        led: $('[data-role="led"]', column),
        stateText: $('[data-role="stateText"]', column),
        loading: $('[data-role="loading"]', column),
        error: $('[data-role="error"]', column),
        errorMsg: $('[data-role="errorMsg"]', column),
        hint: $('[data-role="hint"]', column)
      },
      status: 'idle',
      lastProbe: null,
      probeFailStreak: 0,
      urlIndex: 0
    });

    state.sites[cfg.id] = {
      status: 'idle',
      statusText: '准备中…',
      needLogin: false,
      canType: false,
      qrcode: false,
      risk: false,
      loading: true,
      error: ''
    };

    bindWebviewEvents(cfg.id, webview);
    renderStatus(cfg.id);
  });

  addLog('info', `已创建 ${SITE_CONFIGS.length} 个站点视图（webview + 独立 persist 分区）`);
}

/* ========================================================================== */
/* webview 事件绑定                                                            */
/* ========================================================================== */

function bindWebviewEvents(siteId, webview) {
  const rec = registry.get(siteId);
  if (!rec) return;

  webview.addEventListener('did-start-loading', () => {
    const st = state.sites[siteId];
    st.loading = true;
    if (st.status === 'idle' || st.status === 'error') {
      st.status = 'loading';
      st.statusText = '加载中…';
    }
    // ★ 页面开始导航 = 旧页面里的注入脚本即将失效，清掉适配器的缓存
    rec.adapter.resetUtils();
    renderStatus(siteId);
  });

  webview.addEventListener('did-stop-loading', () => {
    const st = state.sites[siteId];
    st.loading = false;
    renderStatus(siteId);
    // 加载完成后立刻探测一次，不用等 2 秒轮询
    setTimeout(() => probeSite(siteId, 'load'), 600);
  });

  webview.addEventListener('did-finish-load', () => {
    const st = state.sites[siteId];
    st.loading = false;
    st.error = '';
    st.fatalError = false;
    renderStatus(siteId);
    // 注入工具脚本（提前注入，后续探测更快）
    rec.adapter.attach(webview);
    rec.adapter.ensureUtils().catch(() => {});
    injectSyncScroll(siteId);
    setTimeout(() => probeSite(siteId, 'finish'), 800);
  });

  webview.addEventListener('did-fail-load', (e) => {
    // -3 = 用户主动中止（比如切换 URL），忽略
    if (e && e.errorCode === -3) return;
    const st = state.sites[siteId];

    /*
     * ★ 关键：did-fail-load 对【子框架 / 子资源】失败也会触发
     *   （站点里的登录 iframe、埋点、favicon 被广告拦截等都会），
     *   那不是"页面打不开"。以前不区分主框架，结果主页面其实已经渲染出来了，
     *   却被这个全屏错误遮罩永久盖住 —— 表现就是"三栏全是黑的、什么都看不到"。
     *   只有主框架失败才算致命错误。
     */
    const isMainFrame = e && e.isMainFrame !== false;
    if (!isMainFrame) {
      if (state.debugMode) {
        addLog('info', `[${rec.config.name}] 子框架加载失败（已忽略）：${e.errorDescription || ''} ${e.validatedURL || ''}`);
      }
      return;
    }
    // 页面已经能探测到内容时，也不要因为一次导航失败就把遮罩翻出来
    if (st.interactive) {
      addLog('warn', `[${rec.config.name}] 主框架导航失败，但页面已可交互，保留当前页面：${e.errorDescription || ''}`);
      return;
    }

    st.status = 'error';
    st.fatalError = true;
    st.error = `${e.errorDescription || '加载失败'}（code ${e.errorCode}）`;
    st.statusText = '加载失败';
    st.loading = false;
    renderStatus(siteId);
    addLog('error', `[${rec.config.name}] 页面加载失败：${st.error}`, e.validatedURL || '');
  });

  webview.addEventListener('render-process-gone', () => {
    const st = state.sites[siteId];
    st.status = 'error';
    st.error = '渲染进程崩溃';
    st.statusText = '崩溃';
    rec.adapter.resetUtils();
    renderStatus(siteId);
    addLog('error', `[${rec.config.name}] 渲染进程崩溃，请点"重新加载 ⟳"`);
  });

  webview.addEventListener('console-message', (...args) => {
    if (!state.debugMode) return;
    // Electron 32+ 传事件对象，旧版本是 (event, level, message, line, sourceId)
    let level = 0;
    let message = '';
    const first = args[0];
    if (first && typeof first === 'object' && 'message' in first) {
      level = Number(first.level) || 0;
      message = String(first.message || '');
    } else {
      level = Number(args[1]) || 0;
      message = String(args[2] || '');
    }
    if (level < 2) return; // 只要警告/错误，站点自己的 INFO 日志太多会刷爆日志区
    if (/Electron Security Warning/i.test(message)) return;
    addLog(level >= 3 ? 'error' : 'warn', `[${rec.config.name}][页面console] ${message.slice(0, 300)}`);
  });

  // 页面里 window.open 的行为由主进程统一接管（app.on('web-contents-created')），
  // 这里只需要在调试模式下把导航记录下来，方便排查"被踢回登录页"。
  webview.addEventListener('did-navigate', (e) => {
    if (state.debugMode) addLog('info', `[${rec.config.name}] 导航到 ${e.url}`, '主框架');
  });

  webview.addEventListener('ipc-message', (e) => {
    if (e.channel === 'arena-scroll' && state.syncScroll) {
      applySyncScroll(siteId, Number(e.args && e.args[0]) || 0);
    }
  });

  // 页面标题变化（可用于识别"登录页"）
  webview.addEventListener('page-title-updated', (e) => {
    if (state.debugMode) addLog('info', `[${rec.config.name}] 标题：${e.title}`);
  });

  // 双击该栏头部以外的区域 = 放大
  webview.addEventListener('dblclick', () => toggleZoom(siteId));
}

/** 让网页把滚动位置发回来（只在开启同步滚动时转发） */
async function injectSyncScroll(siteId) {
  const rec = registry.get(siteId);
  if (!rec || !rec.adapter.isAlive()) return;
  try {
    await rec.el.webview.executeJavaScript(SYNC_SCROLL_SOURCE, true);
    await rec.el.webview.executeJavaScript(
      `(() => { const s = window.__ARENA_SYNC__; if (s) s.on = ${state.syncScroll ? 'true' : 'false'}; return true; })()`,
      true
    );
  } catch (e) { /* 页面可能还没准备好，忽略 */ }
}

/** 收到某一栏的滚动比例后，驱动其余栏 */
function applySyncScroll(fromSiteId, ratio) {
  const now = Date.now();
  if (now - state.syncLock < 260) return; // 避免三栏互相触发形成回环
  state.syncLock = now;
  registry.forEach(async (rec, id) => {
    if (id === fromSiteId) return;
    const pick = $(`.site-pick[data-site="${id}"]`);
    if (pick && !pick.checked) return;
    try {
      await rec.el.webview.executeJavaScript(
        `(() => { const s = window.__ARENA_SYNC__; if (s) { s.on = false; s.apply(${ratio}); } return true; })()`,
        true
      );
    } catch (e) { /* 忽略 */ }
  });
}

/* ========================================================================== */
/* 站点加载 / 重载 / 状态渲染                                                  */
/* ========================================================================== */

function loadSite(siteId, urlOverride) {
  const rec = registry.get(siteId);
  if (!rec) return;
  const cfg = rec.config;
  const url = urlOverride || cfg.url;

  const st = state.sites[siteId];
  st.status = 'loading';
  st.statusText = '加载中…';
  st.error = '';
  st.loading = true;
  st.fatalError = false;   // 手动重载时清掉上一次的致命错误
  st.interactive = false;
  renderStatus(siteId);

  $('[data-role="error"]', rec.el.column).hidden = true;
  $('[data-role="loading"]', rec.el.column).hidden = false;

  addLog('info', `[${cfg.name}] 开始加载 ${url}`);
  try {
    rec.el.webview.setAttribute('src', url); // 用 setAttribute 触发真实导航
  } catch (e) {
    try { rec.el.webview.src = url; } catch (e2) { /* 忽略 */ }
  }
}

/** 在配置的多个域名间切换重试 */
function switchUrl(siteId) {
  const rec = registry.get(siteId);
  if (!rec) return;
  const list = [rec.config.url, ...(rec.config.fallbackUrls || [])];
  rec.urlIndex = (rec.urlIndex + 1) % list.length;
  const next = list[rec.urlIndex];
  addLog('warn', `[${rec.config.name}] 切换域名重试：${next}`);
  loadSite(siteId, next);
}

/** 清空该站点的登录态（真清 cookie + 本地存储，并重新加载该栏） */
async function clearSiteLogin(siteId) {
  const rec = registry.get(siteId);
  if (!rec) return;
  const cfg = rec.config;
  const ok = window.confirm(`确定要清除「${cfg.name}」的登录态吗？\n分区：${cfg.partition}\n清除后需要重新扫码/登录。`);
  if (!ok) return;

  addLog('warn', `[${cfg.name}] 正在清除登录态（cookie + localStorage…）`);
  try {
    const res = await window.arena.clearPartition(cfg.partition);
    if (res && res.ok) {
      addLog('ok', `[${cfg.name}] 登录态已清除，正在重新加载该栏`);
    } else {
      addLog('error', `[${cfg.name}] 清除失败：${(res && res.error) || '未知错误'}`);
    }
  } catch (err) {
    addLog('error', `[${cfg.name}] 清除登录态异常：${String(err && err.message || err)}`);
  }
  loadSite(siteId);
}

/** 渲染某一栏的状态灯与文案 */
function renderStatus(siteId) {
  const rec = registry.get(siteId);
  if (!rec) return;
  const st = state.sites[siteId];
  const { led, stateText, loading, error, errorMsg, hint } = rec.el;

  const ledClass = {
    gray: 'led-gray',
    yellow: 'led-yellow',
    green: 'led-green',
    red: 'led-red'
  }[st.status] || 'led-gray';

  led.className = `led ${ledClass} ${st.loading ? 'led-blink' : ''}`;
  led.title = st.statusText;
  stateText.textContent = st.statusText;
  stateText.className = 'col-state st-' + st.status;

  /*
   * ★ 遮罩显示规则（修过 bug，别改回去）：
   *   - "加载中"遮罩：只在真的还在加载时显示
   *   - "加载失败"遮罩：只有【主框架】加载失败且页面还不可交互时才显示。
   *     站点里的 iframe/子资源失败也会触发 did-fail-load，以前不区分主框架，
   *     结果页面明明已经渲染好，却被全屏遮罩永久盖住（"三栏全黑"就是这么来的）。
   */
  loading.hidden = !(st.status === 'loading');
  const showErrorOverlay = !!st.fatalError && !st.interactive;
  error.hidden = !showErrorOverlay;
  if (showErrorOverlay) errorMsg.textContent = st.error || '未知错误';

  // 需要扫码时，把提示条亮出来，并让"扫码登录"按钮闪烁
  if (st.needLogin) {
    hint.hidden = false;
    hint.innerHTML =
      `<span class="hint-icon">📱</span> 需要登录：${esc(rec.config.loginHint)}` +
      `<button class="mini primary" data-act="scan" data-site="${siteId}">立即放大扫码</button>`;
  } else if (st.risk) {
    hint.hidden = false;
    hint.innerHTML = `<span class="hint-icon">⚠</span> 页面疑似出现验证码/风控提示，请在该栏内手动处理（程序不会自动绕过）。`;
  } else {
    hint.hidden = true;
    hint.innerHTML = '';
  }

  const scanBtn = $(`[data-act="scan"][data-site="${siteId}"]`, rec.el.column);
  if (scanBtn) {
    scanBtn.classList.toggle('blink', !!st.needLogin);
    scanBtn.textContent = st.qrcode ? '扫码登录 📱' : '放大登录 📱';
  }
  const zoomBtn = $(`[data-act="zoom"][data-site="${siteId}"]`, rec.el.column);
  if (zoomBtn) zoomBtn.textContent = state.enlarged === siteId ? '缩小 ⛶' : '放大 ⛶';
}

/* ========================================================================== */
/* 登录状态轮询                                                                */
/* ========================================================================== */

/**
 * 根据 probe 结果推导状态灯颜色：
 *   灰 = 未加载 / 还没响应
 *   红 = 加载失败 / 渲染崩溃
 *   黄 = 需要登录（出现登录框或二维码）
 *   绿 = 输入框就绪、可以发消息
 */
function deriveStatus(res) {
  if (!res) return { status: 'red', text: '探测失败', needLogin: false, risk: false, canType: false };
  const canType = !!(res.ready && res.inputVisible);
  const needLogin = !!res.needLogin || (res.blocked && res.blockedKind === 'login');
  const risk = !!(res.hasRisk || (res.blocked && res.blockedKind === 'risk'));

  if (risk) return { status: 'yellow', text: '疑似风控/验证码（请手动处理）', needLogin, risk, canType, qrcode: !!res.qrcode };
  if (canType) return { status: 'green', text: '已就绪', needLogin: false, risk: false, canType, qrcode: !!res.qrcode };
  if (needLogin) return { status: 'yellow', text: res.qrcode ? '未登录（二维码已出现）' : '未登录，请在栏内登录', needLogin: true, risk: false, canType, qrcode: !!res.qrcode };
  return { status: 'yellow', text: '页面已加载，但没找到输入框', needLogin: false, risk: false, canType: false, qrcode: !!res.qrcode };
}

/**
 * 探测单个站点
 * @param {string} siteId
 * @param {string} reason 'poll' | 'load' | 'finish' | 'manual'
 */
async function probeSite(siteId, reason = 'poll') {
  const rec = registry.get(siteId);
  if (!rec) return null;
  const st = state.sites[siteId];

  if (!rec.adapter.isAlive()) {
    st.status = 'gray';
    st.statusText = '等待加载';
    renderStatus(siteId);
    return null;
  }

  let res = null;
  try {
    res = await rec.adapter.probe();
  } catch (err) {
    res = { ok: false, error: String(err && err.message || err) };
  }

  if (!res || !res.ok) {
    rec.probeFailStreak += 1;
    // 只在连续失败 3 次后才改红灯，避免页面跳转瞬间误报
    if (rec.probeFailStreak >= 3) {
      st.status = 'red';
      st.statusText = '无法读取页面（可能需要重载）';
      st.error = (res && res.error) || '注入脚本执行失败';
    }
    renderStatus(siteId);
    if (reason !== 'poll' || rec.probeFailStreak === 3) {
      addLog('warn', `[${rec.config.name}] 状态探测失败：${(res && res.error) || '未知'}`, reason);
    }
    return res;
  }

  rec.probeFailStreak = 0;
  rec.lastProbe = res;
  const d = deriveStatus(res);
  // ★ 页面能被探测到 = 它其实已经渲染出来并且我们的脚本能跑：
  //   此时无论之前发生过什么导航错误，都必须把"加载失败"遮罩撤掉。
  st.interactive = true;
  st.fatalError = false;

  const prev = st.status;
  const prevNeed = st.needLogin;

  st.status = st.loading && prev === 'idle' ? 'gray' : d.status;
  st.statusText = st.loading && prev === 'idle' ? '加载中…' : d.text;
  st.needLogin = d.needLogin;
  st.risk = d.risk;
  st.canType = d.canType;
  st.qrcode = d.qrcode;
  if (d.status !== 'red') st.error = '';

  renderStatus(siteId);

  // 状态变化时打一条日志，方便回溯
  if (prev !== st.status && reason !== 'poll') {
    addLog(st.status === 'green' ? 'ok' : st.status === 'red' ? 'error' : 'warn',
      `[${rec.config.name}] 状态：${st.statusText}${res.inputSelector ? '（输入框命中：' + res.inputSelector + '）' : ''}`);
  }

  // 需要登录时提示一次
  if (st.needLogin && !prevNeed) {
    addLog('warn', `[${rec.config.name}] 检测到未登录状态${res.qrcode ? '，二维码已出现' : ''}，点该栏"扫码登录 📱"可放大`, { selector: res.loginSelector || null });
  }

  // ★ 登录成功后自动缩小
  if (state.enlarged === siteId && state.autoShrinkArmed && st.canType) {
    state.autoShrinkArmed = null;
    addLog('ok', `[${rec.config.name}] 检测到已登录/输入框就绪，自动缩小恢复三栏布局`);
    setEnlarged(null);
  }
  if (state.enlarged === siteId && st.needLogin && !state.autoShrinkArmed) {
    state.autoShrinkArmed = true; // 放大时仍是未登录，那么"登录成功"后自动缩回
  }

  return res;
}

/** 轮询器：每 2 秒探测所有站点 */
function startPolling() {
  setInterval(() => {
    registry.forEach((rec, id) => {
      if (!rec.adapter.isAlive()) return;
      probeSite(id, 'poll');
    });
  }, POLL_INTERVAL);
}

/* ========================================================================== */
/* 放大 / 缩小（扫码助手）                                                     */
/* ========================================================================== */

function setEnlarged(siteId) {
  state.enlarged = siteId;
  document.body.classList.toggle('enlarged', !!siteId);
  $('#enlargeBar').hidden = !siteId;

  if (siteId) {
    const rec = registry.get(siteId);
    // 记录放大时的登录状态：如果当时是"未登录"，登录成功后自动缩回
    state.autoShrinkArmed = state.sites[siteId].needLogin ? true : false;
    $('#enlargeTitle').textContent = `放大视图：${rec ? rec.config.name : siteId}`;
    const st = state.sites[siteId];
    $('#enlargeHint').textContent = st.canType
      ? '该站点已就绪；如需扫码请确认页面上有二维码'
      : (rec ? rec.config.loginHint : '');
    addLog('info', `[${rec ? rec.config.name : siteId}] 已放大该栏（按 Esc 或点"返回三栏"退出）`);
  } else {
    state.autoShrinkArmed = null;
    addLog('info', '已恢复三栏布局');
  }

  registry.forEach((rec, id) => {
    const col = rec.el.column;
    col.classList.toggle('is-enlarged', id === siteId);
    col.classList.toggle('is-dimmed', !!siteId && id !== siteId);
    const zoomBtn = $(`[data-act="zoom"][data-site="${id}"]`, col);
    if (zoomBtn) zoomBtn.textContent = state.enlarged === id ? '缩小 ⛶' : '放大 ⛶';
  });
}

function toggleZoom(siteId) {
  if (state.enlarged === siteId) setEnlarged(null);
  else setEnlarged(siteId);
}

/* ========================================================================== */
/* 布局切换                                                                    */
/* ========================================================================== */

function applyLayout() {
  const wrap = $('#boards');
  wrap.classList.toggle('layout-rows', state.layout === 'rows');
  $('#layoutBtn').textContent = state.layout === 'rows' ? '切换为左右布局 ⬍' : '切换为上下布局 ⬌';
  addLog('info', `布局切换为：${state.layout === 'rows' ? '上下' : '左右'}`);
}

/* ========================================================================== */
/* 图片：选择 / 拖拽 / 粘贴                                                     */
/* ========================================================================== */

/** 统一的图片入库（File -> dataURL -> state.images） */
function addImageFiles(files, sourceLabel = '选择') {
  const list = Array.from(files || []).filter((f) => f && /^image\//i.test(f.type));
  if (!list.length) {
    addLog('warn', `${sourceLabel}：没有可用的图片文件`);
    return;
  }
  let added = 0;
  let rejected = 0;

  list.forEach((file) => {
    if (file.size > MAX_IMAGE_BYTES) {
      rejected += 1;
      addLog('warn', `${sourceLabel}：图片 ${file.name} 超过 10MB，已跳过`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.images.push({
        id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: file.name || 'clipboard.png',
        size: file.size,
        dataUrl: String(reader.result || '')
      });
      renderThumbs();
    };
    reader.onerror = () => addLog('error', `${sourceLabel}：读取 ${file.name} 失败`);
    reader.readAsDataURL(file);
    added += 1;
  });

  addLog('info', `${sourceLabel}：加入 ${added} 张图片${rejected ? `，跳过 ${rejected} 张` : ''}`);
}

function renderThumbs() {
  const strip = $('#thumbStrip');
  const count = $('#imgCount');
  count.textContent = state.images.length ? `${state.images.length} 张` : '无';
  strip.innerHTML = '';
  state.images.forEach((img) => {
    const item = document.createElement('div');
    item.className = 'thumb';
    item.title = `${img.name}（${humanSize(img.size)}）`;
    item.innerHTML =
      `<img src="${img.dataUrl}" alt="${esc(img.name)}" />` +
      `<button class="thumb-del" data-img="${img.id}" title="删除这张图">✕</button>`;
    strip.appendChild(item);
  });
}

function removeImage(id) {
  const before = state.images.length;
  state.images = state.images.filter((i) => i.id !== id);
  if (state.images.length !== before) {
    renderThumbs();
    addLog('info', '已移除 1 张图片');
  }
}

/* ========================================================================== */
/* 开战：三站点并行发送                                                        */
/* ========================================================================== */

function selectedSites() {
  return $$('.site-pick').filter((c) => c.checked).map((c) => c.dataset.site);
}

/** 单站点发送包装：任何异常都吞掉并返回结构化结果，保证不影响其他站点 */
async function sendToOne(siteId, text, images) {
  const rec = registry.get(siteId);
  const name = rec ? rec.config.name : siteId;
  if (!rec) return { siteId, name, ok: false, error: '未注册的站点' };
  if (!rec.adapter.isAlive()) return { siteId, name, ok: false, error: 'webview 未就绪' };

  const t0 = Date.now();
  addLog('step', `[${name}] ▶ 开始发送（文本 ${text.length} 字，图片 ${images.length} 张）`);
  let result;
  try {
    // applyBest：发送前先把这个站点切到最好的模型 + 最强推理（工具栏可关）
    result = await rec.adapter.send(text, images, { applyBest: state.applyBest });
  } catch (err) {
    result = { ok: false, error: String(err && err.message || err), steps: [] };
  }
  const cost = Date.now() - t0;

  // 把适配器内部步骤逐条摊进日志（这就是需求里的"时序日志"）
  (result.steps || []).forEach((s) => {
    const label = {
      applyBest: '套用最佳模型/推理',
      waitReady: '等待输入框',
      injectText: '注入文本',
      injectImages: '注入图片',
      reInjectText: '图片后补回文字',
      clickSend: '点击发送',
      verify: '校验输入框',
      risk: '风控检测',
      exception: '异常',
      attach: '连接'
    }[s.step] || s.step;
    const okMark = s.ok ? '✓' : '✗';
    const parts = [`${label} ${okMark}`];
    if (s.changes && s.changes.length) parts.push('改动=' + s.changes.join('、'));
    if (s.notes && s.notes.length) parts.push(s.notes.join('、'));
    if (s.selector) parts.push(`命中=${s.selector}`);
    if (s.strategy) parts.push(`方式=${s.strategy}`);
    if (s.how) parts.push(s.how);
    if (s.remaining !== undefined) parts.push(`剩余字数=${s.remaining}`);
    if (s.messageDelta !== undefined && s.messageDelta !== 0) parts.push(`消息数变化=${s.messageDelta}`);
    if (s.error) parts.push(`原因=${s.error}`);
    addLog(s.ok ? 'step' : 'warn', `[${name}] ${parts.join(' ｜ ')}`);
  });

  addLog(result.ok ? 'ok' : 'error',
    `[${name}] ${result.ok ? '发送完成' : '发送未确定/失败'}（耗时 ${cost}ms）`,
    result.error || undefined);

  // 发送后立刻探测一次刷新状态灯
  probeSite(siteId, 'manual');
  return { siteId, name, ok: !!result.ok, error: result.error, cost, usedEnter: result.usedEnter };
}

/** 在给某站点发消息前，把它切到前台（有些站点要求页面可见才响应输入） */
async function focusBoard(siteId) {
  const rec = registry.get(siteId);
  if (!rec) return;
  if (state.enlarged && state.enlarged !== siteId) setEnlarged(siteId);
  setActiveBoard(siteId);
  try { rec.el.webview.focus(); } catch (e) { /* 忽略 */ }
}

/** 视觉上高亮正在操作的栏 */
function setActiveBoard(siteId) {
  registry.forEach((rec, id) => rec.el.column.classList.toggle('is-active', id === siteId));
}

async function startBattle() {
  if (state.sending) {
    addLog('warn', '正在开战中，请稍候（已防止重复发送）');
    return;
  }

  const text = $('#composeText').value;
  const images = state.images.map((i) => ({ dataUrl: i.dataUrl, name: i.name }));
  const targets = selectedSites();

  if (!text.trim() && images.length === 0) {
    addLog('warn', '内容为空：请输入文字或添加图片后再开战');
    $('#composeText').focus();
    return;
  }
  if (!targets.length) {
    addLog('warn', '没有勾选任何站点：请在上方勾选至少一个站点');
    return;
  }

  state.sending = true;
  const btn = $('#battleBtn');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.textContent = '开战中…';

  addLog('step', `🥊 开战开始 → 目标：${targets.map((t) => (registry.get(t) || {}).config ? registry.get(t).config.name : t).join(' / ')}`);

  try {
    // ★ 关键：三个站点各跑各的，用 Promise.allSettled 保证互不阻塞、互不拖垮
    const tasks = targets.map(async (siteId) => {
      await focusBoard(siteId);
      const t = Date.now();
      const res = await sendToOne(siteId, text, images);
      return { ...res, at: t };
    });
    const settled = await Promise.allSettled(tasks);

    const summary = settled.map((s, i) => {
      const id = targets[i];
      const name = (registry.get(id) || {}).config ? registry.get(id).config.name : id;
      if (s.status === 'fulfilled') return `${name}:${s.value.ok ? '已发送' : '待确认'}`;
      return `${name}:异常(${s.reason && s.reason.message})`;
    });
    addLog('step', `🥊 开战结束 → ${summary.join('　')}`);

    // 全部成功后（且用户没关掉自动清空）清掉输入区
    const allOk = settled.every((s) => s.status === 'fulfilled' && s.value.ok);
    if (allOk && $('#autoClear').checked) {
      $('#composeText').value = '';
      state.images = [];
      renderThumbs();
      $('#composeText').style.height = 'auto';
      addLog('info', '已自动清空输入区（可在工具栏关闭"自动清空"）');
    }
  } catch (err) {
    addLog('error', '开战流程异常：' + String(err && err.message || err));
  } finally {
    state.sending = false;
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.textContent = '开战 🥊';
    registry.forEach((rec, id) => probeSite(id, 'manual'));
  }
}

/* ========================================================================== */
/* 选择器调试模式（Ctrl+Shift+D）                                              */
/* ========================================================================== */

async function toggleDebugMode(force) {
  state.debugMode = typeof force === 'boolean' ? force : !state.debugMode;
  $('#debugBtn').classList.toggle('on', state.debugMode);
  addLog('info', `选择器调试模式：${state.debugMode ? '已开启' : '已关闭'}`);

  for (const [siteId, rec] of registry) {
    if (!rec.adapter.isAlive()) continue;
    try {
      const res = await rec.adapter.debugHighlight(state.debugMode);
      if (state.debugMode && res && res.detail) {
        addLog('info', `[${rec.config.name}] 命中情况：` +
          res.detail.map((d) => `${d.label}=${d.hit ? d.selector : '未命中'}`).join(' ｜ '));
      }
    } catch (err) {
      addLog('warn', `[${rec.config.name}] 高亮失败：${String(err && err.message || err)}`);
    }
  }

  if (state.debugMode) {
    addLog('info', '调试模式说明：页面内已高亮"输入框（粉）/发送按钮（绿）/就绪元素（蓝）/登录元素（黄）/二维码（红）"，' +
      '并在标签里显示实际命中的选择器；把命中的选择器粘回 renderer/site-config.mjs 与 adapters/site-config.js 即可。');
  }
}

/** 调试：探测并打印每个站点的 file input 候选（方案 C 排查用） */
async function debugFileInputs() {
  addLog('info', '===== 探测各站点 input[type=file] =====');
  for (const [siteId, rec] of registry) {
    if (!rec.adapter.isAlive()) { addLog('warn', `[${rec.config.name}] webview 未就绪`); continue; }
    try {
      const res = await rec.adapter.fileInputPlan();
      const plan = res && res.plan;
      addLog('info', `[${rec.config.name}] 找到 ${plan ? plan.count : 0} 个 file input`,
        plan ? { selectors: plan.selectors.slice(0, 4), details: plan.details } : undefined);
    } catch (err) {
      addLog('warn', `[${rec.config.name}] 探测失败：${String(err && err.message || err)}`);
    }
  }
}

/* ========================================================================== */
/* 视图切换：对战三栏 / 聊天问答                                               */
/* ========================================================================== */

function applyView(view) {
  state.view = view;
  const chat = $('#chatView');
  const boards = $('#boards');
  const isChat = view === 'chat';
  chat.hidden = !isChat;
  // ⚠ 三栏在聊天视图下【不能】用 hidden/display:none 藏起来：
  //   那样 webview 尺寸会变成 0，注入脚本里的 focusInput() 就失效
  //   （浏览器不给不可见元素焦点），问题会写不进输入框。
  //   CSS 里改为"移出可视区但保留真实尺寸"（body.chat-only #boards）。
  boards.hidden = false;
  // 聊天视图下放大条、输入区这些也不该出现
  $('#compose').hidden = isChat;
  document.body.classList.toggle('view-chat', isChat);
  // 聊天专用窗口（index.html#chat）：整个工具栏、三栏都收起来，只留聊天
  document.body.classList.toggle('chat-only', isChat && state.chatOnly);
  $$('#viewTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (isChat) {
    // 三栏 webview 被隐藏后 Chromium 仍会继续渲染，回答照样能抓
    if (!state.chatOnly) addLog('info', '已切到「聊天问答」视图：提问会同时发给 DeepSeek → Kimi → 豆包');
    $('#chatInput').focus();
  } else {
    registry.forEach((rec, id) => { if (rec.adapter.isAlive()) probeSite(id, 'manual'); });
  }
}

/* ========================================================================== */
/* 聊天问答：一次提问，三个站点并行作答                                        */
/* ========================================================================== */

/** 卡片默认顺序（需求指定）：DeepSeek → Kimi → 豆包 */
const CHAT_ORDER = ['deepseek', 'kimi', 'doubao'];

/** 聊天提问用的状态 */
const chatState = { running: false, selected: null, cards: {} };

function buildChatCards() {
  const wrap = $('#chatCards');
  wrap.innerHTML = '';
  CHAT_ORDER.forEach((siteId) => {
    const rec = registry.get(siteId);
    if (!rec) return;
    const cfg = rec.config;
    const card = document.createElement('section');
    card.className = 'card';
    card.dataset.site = siteId;
    card.style.setProperty('--site-color', cfg.color);
    card.innerHTML = `
      <header class="card-head">
        <span class="card-name">${esc(cfg.name)}</span>
        <span class="card-state" data-role="cardState">待提问</span>
        <span class="card-actions">
          <button class="mini" data-act="pick" data-site="${siteId}" disabled>选择</button>
          <button class="mini" data-act="copy" data-site="${siteId}" disabled>复制</button>
        </span>
      </header>
      <div class="card-body placeholder" data-role="cardBody">还没有回答</div>
    `;
    wrap.appendChild(card);
    chatState.cards[siteId] = {
      el: card,
      body: $('[data-role="cardBody"]', card),
      status: $('[data-role="cardState"]', card),
      pickBtn: $('[data-act="pick"]', card),
      copyBtn: $('[data-act="copy"]', card),
      answer: '',
      selected: false
    };
  });
}

/** 更新某张卡片的外观（等待中 / 成功 / 失败 / 选中） */
function setCard(siteId, patch) {
  const c = chatState.cards[siteId];
  if (!c) return;
  const rec = registry.get(siteId);
  const name = rec ? rec.config.name : siteId;

  if (patch.status) { c.status.textContent = patch.status; c.status.className = 'card-state ' + (patch.statusKind || ''); }
  if (patch.loading) {
    c.body.className = 'card-body';
    c.body.innerHTML = `
      <div class="card-loading">
        <div class="dots"><i></i><i></i><i></i></div>
        <div class="dim">${esc(patch.loadingText || '正在等待回答…')}</div>
      </div>`;
  }
  if (typeof patch.answer === 'string') {
    c.answer = patch.answer;
    c.body.className = 'card-body';
    c.body.textContent = patch.answer;
    c.pickBtn.disabled = !patch.answer;
    c.copyBtn.disabled = !patch.answer;
  }
  if (patch.error) {
    c.body.className = 'card-body';
    c.body.innerHTML = `<div class="card-error"><b>${esc(name)} 这次没成功：</b><br>${esc(patch.error)}</div>`;
    c.pickBtn.disabled = true;
    c.copyBtn.disabled = true;
  }
  if (typeof patch.selected === 'boolean') {
    c.selected = patch.selected;
    c.el.classList.toggle('selected', patch.selected);
    c.pickBtn.textContent = patch.selected ? '已选择 ✓' : '选择';
    c.pickBtn.classList.toggle('primary', patch.selected);
  }
}

/** 复制文本到系统剪贴板（优先用主进程，确保可靠） */
async function copyText(text) {
  try {
    const res = await window.arena.clipboardWriteText(text);
    if (res && res.ok) return true;
  } catch (e) { /* 忽略，走下面的兜底 */ }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

/** 选中某个站点的回答 */
function selectAnswer(siteId) {
  const c = chatState.cards[siteId];
  if (!c || !c.answer) return;

  const prev = chatState.selected;
  if (prev === siteId) {
    // 再点一次 = 取消选择
    chatState.selected = null;
    setCard(siteId, { selected: false });
    addLog('info', `已取消选择 ${registry.get(siteId).config.name} 的回答`);
    return;
  }
  if (prev && chatState.cards[prev]) setCard(prev, { selected: false });
  chatState.selected = siteId;
  setCard(siteId, { selected: true });
  const name = registry.get(siteId).config.name;
  addLog('ok', `已选中 ${name} 的回答（${c.answer.length} 字）—— 点「复制」可复制全文`);
}

/** 单站点提问：任何异常都只影响这一张卡 */
async function askOne(siteId, question, options = {}) {
  const rec = registry.get(siteId);
  const name = rec ? rec.config.name : siteId;
  if (!rec || !rec.adapter.isAlive()) {
    setCard(siteId, { status: '未就绪', statusKind: 'err', error: 'webview 未就绪，请先切换到「对战三栏」让页面加载好' });
    return { siteId, ok: false, error: 'webview 未就绪' };
  }

  setCard(siteId, { status: '提问中…', statusKind: '', loading: true, loadingText: '正在输入问题…' });
  addLog('step', `[${name}] ▶ 聊天提问开始`);
  const t0 = Date.now();

  try {
    const res = await rec.adapter.ask(question, {
      applyBest: options.applyBest !== false,
      timeout: options.timeout || 180000,
      onProgress: (p) => {
        if (p.phase === 'sent') {
          setCard(siteId, { status: '已发送，等待回答…', loading: true, loadingText: '问题已发出，正在等回答…' });
          return;
        }
        setCard(siteId, {
          status: `回答中… ${p.length || 0} 字`,
          loading: true,
          loadingText: `正在回答（已收到 ${p.length || 0} 字）…`
        });
      }
    });
    const cost = ((Date.now() - t0) / 1000).toFixed(1);

    if (res && res.answer) {
      setCard(siteId, {
        status: `完成 · ${res.answer.length} 字 · ${cost}s`,
        statusKind: 'ok',
        answer: res.answer
      });
      addLog('ok', `[${name}] 聊天回答完成（${res.answer.length} 字，耗时 ${cost}s${res.timedOut ? '，等待超时可能未答完' : ''}）`);
      return { siteId, ok: true, answer: res.answer };
    }
    const err = (res && res.error) || '没有取到回答';
    setCard(siteId, { status: '失败', statusKind: 'err', error: err });
    addLog('error', `[${name}] 聊天提问失败：${err}`);
    return { siteId, ok: false, error: err };
  } catch (err) {
    const msg = String(err && err.message || err);
    setCard(siteId, { status: '失败', statusKind: 'err', error: msg });
    addLog('error', `[${name}] 聊天提问异常：${msg}`);
    return { siteId, ok: false, error: msg };
  }
}

/** 提交提问：三个站点并行，互不阻断 */
async function submitChat() {
  if (chatState.running) {
    addLog('warn', '上一轮提问还在进行中');
    return;
  }
  const input = $('#chatInput');
  const question = input.value.trim();
  if (!question) {
    addLog('warn', '问题为空');
    input.focus();
    return;
  }

  chatState.running = true;
  chatState.selected = null;
  const btn = $('#chatSendBtn');
  btn.disabled = true;
  btn.textContent = '提问中…';
  $('#chatStatus').textContent = '正在向三家提问…';

  // 先把卡片重置成"等待"状态（按 DS → Kimi → 豆包 的固定顺序展示）
  CHAT_ORDER.forEach((siteId) => {
    setCard(siteId, {
      status: '等待中…',
      statusKind: '',
      loading: true,
      loadingText: '排队等待发送…',
      answer: '',
      selected: false
    });
    chatState.cards[siteId].answer = '';
  });

  addLog('step', `💬 聊天提问：${question.slice(0, 40)}${question.length > 40 ? '…' : ''}`);

  const options = { applyBest: $('#chatApplyBest').checked };
  try {
    // ★ 三个站点各跑各的：用 allSettled 保证一个失败不影响其他两个
    const settled = await Promise.allSettled(CHAT_ORDER.map((siteId) => askOne(siteId, question, options)));
    const summary = settled.map((s, i) => {
      const id = CHAT_ORDER[i];
      const nm = registry.get(id) ? registry.get(id).config.name : id;
      if (s.status === 'fulfilled') return `${nm}:${s.value.ok ? '成功' : '失败'}`;
      return `${nm}:异常`;
    });
    const okCount = settled.filter((s) => s.status === 'fulfilled' && s.value.ok).length;
    $('#chatStatus').textContent = `完成 ${okCount}/3（点卡片「选择」可选中并复制）`;
    addLog('step', `💬 聊天提问结束 → ${summary.join('　')}`);
  } catch (err) {
    addLog('error', '聊天提问流程异常：' + String(err && err.message || err));
    $('#chatStatus').textContent = '提问异常';
  } finally {
    chatState.running = false;
    btn.disabled = false;
    btn.textContent = '提问';
  }
}

function bindChatUi() {
  $('#viewTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) applyView(tab.dataset.view);
  });

  const input = $('#chatInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitChat();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
  });
  $('#chatSendBtn').addEventListener('click', submitChat);

  // 卡片上的「选择」「复制」
  $('#chatCards').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const siteId = btn.dataset.site;
    const act = btn.dataset.act;
    const c = chatState.cards[siteId];
    if (!c) return;

    if (act === 'pick') {
      selectAnswer(siteId);
    } else if (act === 'copy') {
      if (!c.answer) return;
      const ok = await copyText(c.answer);
      const name = registry.get(siteId).config.name;
      addLog(ok ? 'ok' : 'error', ok ? `已复制 ${name} 的回答（${c.answer.length} 字）` : `复制 ${name} 的回答失败`);
      if (ok) {
        btn.textContent = '已复制 ✓';
        setTimeout(() => { if (!c.selected) btn.textContent = '复制'; }, 1500);
      }
    }
  });
}

/* ========================================================================== */
/* 事件绑定                                                                    */
/* ========================================================================== */

function bindUi() {
  /* ---------------- 输入框：Enter 发送 / Shift+Enter 换行 ---------------- */
  const ta = $('#composeText');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      startBattle();
    }
  });
  // 自适应高度
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(220, ta.scrollHeight) + 'px';
    $('#charCount').textContent = ta.value.length + ' 字';
  });
  // 粘贴上传（截图后 Ctrl+V 直接进缩略图）
  ta.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file' && /^image\//i.test(it.type)) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault(); // 不要把图片变成一段文本粘进输入框
      addImageFiles(files, '粘贴');
    }
  });

  /* ---------------- 选择图片 ---------------- */
  $('#pickImgBtn').addEventListener('click', () => $('#filePicker').click());
  $('#filePicker').addEventListener('change', (e) => {
    addImageFiles(e.target.files, '选择');
    e.target.value = ''; // 允许重复选同一张
  });

  /* ---------------- 拖拽上传 ---------------- */
  const dropZone = $('#compose');
  ['dragenter', 'dragover'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'dragleave' && e.relatedTarget && dropZone.contains(e.relatedTarget)) return;
      dropZone.classList.remove('dragging');
    });
  });
  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addImageFiles(files, '拖拽');
  });

  /* ---------------- 缩略图删除 ---------------- */
  $('#thumbStrip').addEventListener('click', (e) => {
    const btn = e.target.closest('.thumb-del');
    if (btn) removeImage(btn.dataset.img);
  });

  /* ---------------- 开战 / 清空 ---------------- */
  $('#battleBtn').addEventListener('click', startBattle);
  $('#clearBtn').addEventListener('click', () => {
    ta.value = '';
    ta.style.height = 'auto';
    $('#charCount').textContent = '0 字';
    state.images = [];
    renderThumbs();
    addLog('info', '已清空输入区（文字 + 图片）');
    ta.focus();
  });
  $('#clearLogBtn').addEventListener('click', () => {
    $('#logLines').innerHTML = '';
    addLog('info', '日志已清空');
  });
  $('#copyLogBtn').addEventListener('click', async () => {
    const text = $$('#logLines .log-line').map((l) => l.innerText.replace(/\s+/g, ' ')).join('\n');
    const res = await window.arena.clipboardWriteText(text);
    addLog(res && res.ok ? 'ok' : 'error', res && res.ok ? `已复制 ${$$('#logLines .log-line').length} 行日志到剪贴板` : '复制日志失败');
  });

  /* ---------------- 工具栏开关 ---------------- */
  $('#layoutBtn').addEventListener('click', () => {
    state.layout = state.layout === 'columns' ? 'rows' : 'columns';
    applyLayout();
  });

  $('#syncScroll').addEventListener('change', async (e) => {
    state.syncScroll = e.target.checked;
    addLog('info', `同步滚动：${state.syncScroll ? '已开启' : '已关闭'}`);
    for (const [siteId, rec] of registry) {
      if (!rec.adapter.isAlive()) continue;
      try {
        await rec.el.webview.executeJavaScript(
          `(() => { const s = window.__ARENA_SYNC__; if (s) s.on = ${state.syncScroll ? 'true' : 'false'}; return true; })()`,
          true
        );
      } catch (err) { /* 忽略 */ }
    }
  });

  $('#debugBtn').addEventListener('click', () => toggleDebugMode());
  $('#probeBtn').addEventListener('click', debugFileInputs);

  // 打开「聊天助手」独立窗口
  $('#chatWindowBtn').addEventListener('click', async () => {
    const res = await window.arena.openChatWindow();
    addLog(res && res.ok ? 'ok' : 'error', res && res.ok ? '已打开「聊天助手」独立窗口（Ctrl+Shift+C 也可）' : '打开聊天助手窗口失败：' + (res && res.error));
  });

  $('#bestModel').addEventListener('change', (e) => {
    state.applyBest = e.target.checked;
    addLog('info', `最佳模型/推理：${state.applyBest ? '已开启（每次开战前会自动切到最好的档位）' : '已关闭（用你当前手动选的档位）'}`);
  });

  // 手动立即套用一次（不想等开战的时候用）
  // 说明：详细信息由适配器自己写日志（含"已是较优档位/已切换为xx"），这里不重复打印
  $('#applyBestBtn').addEventListener('click', async () => {
    addLog('step', '正在为三个站点套用最佳模型/最强推理…');
    for (const [siteId, rec] of registry) {
      if (!rec.adapter.isAlive()) continue;
      try {
        await rec.adapter.applyBest({ enabled: true });
      } catch (err) {
        addLog('warn', `[${rec.config.name}] 套用失败：${String(err && err.message || err)}`);
      }
    }
    addLog('step', '最佳模型/推理套用完成');
  });

  $('#checkAll').addEventListener('change', (e) => {
    $$('.site-pick').forEach((c) => { c.checked = e.target.checked; });
    addLog('info', e.target.checked ? '已勾选全部站点' : '已取消全部站点');
  });

  $('#reloadAllBtn').addEventListener('click', () => {
    addLog('info', '重新加载全部站点…');
    registry.forEach((rec, id) => loadSite(id));
  });

  /* ---------------- 栏目按钮（事件委托） ---------------- */
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const siteId = btn.dataset.site;
    const rec = registry.get(siteId);
    if (!rec) return;

    if (act === 'reload') loadSite(siteId);
    else if (act === 'switchUrl') switchUrl(siteId);
    else if (act === 'scan' || act === 'zoom') toggleZoom(siteId);
    else if (act === 'devtools') {
      rec.adapter.openDebugger();
      addLog('info', `[${rec.config.name}] 已打开 DevTools`);
    } else if (act === 'signout') clearSiteLogin(siteId);
    else if (act === 'openExternal') {
      window.arena.openExternal(rec.el.webview.getAttribute('src') || rec.config.url);
      addLog('info', `[${rec.config.name}] 已在系统浏览器中打开`);
    }
  });

  /* ---------------- 放大视图工具条 ---------------- */
  $('#exitEnlargeBtn').addEventListener('click', () => setEnlarged(null));
  $('#reloadEnlargedBtn').addEventListener('click', () => {
    if (state.enlarged) loadSite(state.enlarged);
  });

  /* ---------------- 快捷键 ---------------- */
  window.addEventListener('keydown', (e) => {
    // Ctrl+Shift+C —— 打开「聊天助手」独立窗口
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault();
      window.arena.openChatWindow && window.arena.openChatWindow();
      return;
    }
    // Ctrl+Shift+D —— 选择器调试模式
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      toggleDebugMode();
      return;
    }
    // Esc —— 退出放大视图
    if (e.key === 'Escape' && state.enlarged) {
      e.preventDefault();
      setEnlarged(null);
      return;
    }
    // Ctrl+Enter —— 任意位置开战
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      startBattle();
    }
  });

  /* ---------------- 主进程侧的全局快捷键（F12 等） ---------------- */
  window.addEventListener('beforeunload', () => {
    window.arena.clearTempImages();
  });
}

/* ========================================================================== */
/* 启动                                                                        */
/* ========================================================================== */

async function boot() {
  // 0) 打印环境信息，便于排查（Electron/Chrome 版本）
  try {
    const info = await window.arena.appInfo();
    RUNTIME.webviewPreload = info.webviewPreload || '';
    RUNTIME.tempDir = info.tempDir || '';
    RUNTIME.versions = info.versions || {};
    RUNTIME.selftest = !!info.selftest;
    addLog('info', `AI 大乱斗启动｜Electron ${info.versions.electron} / Chrome ${info.versions.chrome} / ${info.platform}`);
    addLog('info', `临时图片目录：${info.tempDir}`);
  } catch (e) {
    addLog('warn', '读取应用信息失败：' + String(e && e.message || e));
  }

  addLog('info', '使用说明：首次使用请在三栏里手动登录（可点"扫码登录 📱"放大二维码）；登录态会保存在各自的 persist 分区里，重启应用仍在。');
  addLog('info', '提示：Ctrl+Shift+D 进入选择器调试模式；Ctrl+Enter 快速开战；Esc 退出放大视图。');

  // 1) 构建界面
  //    如果地址里带 #chat（主进程为「聊天助手」打开的那个窗口），就只渲染聊天页
  state.chatOnly = location.hash.replace('#', '') === 'chat';
  renderThumbs();
  buildBoards();
  buildChatCards();
  bindUi();
  bindChatUi();
  applyLayout();
  applyView(state.chatOnly ? 'chat' : 'battle');

  // 2) 同步滚动：网页侧由 webview-preload.js 暴露 window.arena.syncScroll，
  //    宿主侧在 bindWebviewEvents 里监听 webview 的 'ipc-message' 事件接收滚动比例。
  //    （这里不再需要额外补 API）

  // 3) 开始加载三个站点（稍微错开，避免同时抢网络/磁盘）
  SITE_CONFIGS.forEach((cfg, i) => {
    setTimeout(() => loadSite(cfg.id), 200 + i * 350);
  });

  // 4) 启动登录状态轮询
  startPolling();

  // 5) 主动清理上次运行留下的临时图片
  window.arena.clearTempImages().catch(() => {});

  // 6) 自检模式（npm run selftest）：自动探测三栏并把结果写盘
  if (RUNTIME.selftest) runSelfTest().catch((err) => {
    addLog('error', '自检异常：' + String(err && err.message || err));
  });
}

/* ========================================================================== */
/* 自检模式（npm run selftest）                                                */
/* ========================================================================== */

/**
 * 自动跑一轮：等两轮探测结束后，收集每栏的
 *   - webview 是否真的拿到 webContents
 *   - 页面 URL / 标题
 *   - 注入脚本是否可用
 *   - 各字段选择器的命中情况
 * 然后把报告交给主进程写盘，并退出应用。
 */
async function runSelfTest() {
  addLog('step', '===== 自检模式启动（等待 40 秒让三个站点加载/跳转）=====');

  // 预留足够时间：站点首屏 + 跳转 + 可能的登录弹窗
  await sleep(40000);

  const report = {
    startedAt: new Date().toISOString(),
    versions: RUNTIME.versions,
    platform: navigator.platform,
    sites: []
  };

  for (const [siteId, rec] of registry) {
    const entry = {
      id: siteId,
      name: rec.config.name,
      url: rec.config.url,
      partition: rec.config.partition,
      webContentsId: null,
      alive: false,
      href: null,
      title: null,
      utilsInjected: false,
      selectors: {},
      fileInputs: null,
      error: null
    };

    try {
      entry.webContentsId = rec.adapter.wcId();
      entry.alive = rec.adapter.isAlive();
      if (entry.alive) {
        entry.href = rec.adapter.currentUrl();
        entry.title = rec.adapter.currentTitle();
        // 注入脚本是否可用（说明 webview 的执行通道正常）
        try {
          await rec.adapter.ensureUtils();
          entry.utilsInjected = !!(await rec.el.webview.executeJavaScript('!!(window.__ARENA__ && window.__ARENA__.version === 3)', true));
        } catch (e) {
          entry.error = 'utils 注入失败: ' + String(e && e.message || e);
        }
        // 探测 + 命中详情
        const res = await rec.adapter.probe();
        entry.probe = res ? {
          ok: res.ok,
          ready: res.ready,
          inputVisible: res.inputVisible,
          needLogin: res.needLogin,
          qrcode: res.qrcode,
          risk: res.hasRisk,
          blocked: res.blocked
        } : null;
        const hilite = await rec.adapter.debugHighlight(false); // 先清掉可能残留的高亮
        void hilite;
        // 逐字段统计命中情况（排查选择器失效最直接的依据）
        entry.selectors = await rec.adapter.diag();
        // 未命中的字段：把试过的候选一并带上，方便直接改配置
        entry.missed = Object.entries(entry.selectors)
          .filter(([, v]) => !v.hit)
          .map(([k, v]) => ({ field: k, tried: v.tried }));
        const fi = await rec.adapter.fileInputPlan().catch(() => null);
        entry.fileInputs = fi && fi.plan ? { count: fi.plan.count, selectors: fi.plan.selectors, details: fi.plan.details } : null;
      }
    } catch (err) {
      entry.error = String(err && err.message || err);
    }
    report.sites.push(entry);
    addLog(entry.alive ? 'ok' : 'error',
      `[自检] ${entry.name}：${entry.alive ? '通道正常' : '通道异常'}｜` +
      Object.entries(entry.selectors || {}).map(([k, v]) => `${k}=${v.hit ? '✓' : '✗'}`).join(' '),
      entry.error || undefined);
    // 未命中的字段把候选列表打出来，方便直接复制去改配置
    (entry.missed || []).forEach((m) => {
      addLog('warn', `[自检] ${entry.name} 未命中字段 ${m.field}，已尝试的候选：`, m.tried);
    });
  }

  report.finishedAt = new Date().toISOString();
  addLog('step', '===== 自检结束，写入报告 =====');
  await window.arena.submitSelftestReport(report);
}

document.addEventListener('DOMContentLoaded', boot);

// 暴露给调试用
window.__ARENA_STATE__ = state;
window.__ARENA_REGISTRY__ = registry;
