/**
 * browser.mjs —— 零依赖 CDP（Chrome DevTools Protocol）浏览器驱动
 *
 * 不依赖 puppeteer / playwright：直接用 Node 内置 WebSocket 与 fetch
 * 连接 Edge / Chrome 的 --remote-debugging-port，实现真正的“控制浏览器”。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, sleep, warn } from './util.mjs';

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`指定的浏览器不存在：${explicit}`);
    return explicit;
  }
  if (process.env.CAMPUS_BROWSER && existsSync(process.env.CAMPUS_BROWSER)) return process.env.CAMPUS_BROWSER;
  const hit = CANDIDATES.find((p) => existsSync(p));
  if (!hit) throw new Error('未找到 Edge / Chrome，请用 --browser <可执行文件路径> 指定');
  return hit;
}

export class Browser {
  constructor({ exe, port = 9222, headless = false, profileDir }) {
    this.exe = exe;
    this.port = port;
    this.headless = headless;
    this.profileDir = profileDir || join(ROOT, '.browser-profile');
    this.proc = null;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.sessions = new Map();
    this.closed = false;
  }

  get endpoint() { return `http://127.0.0.1:${this.port}`; }

  async launch() {
    mkdirSync(this.profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-crash-reporter',
      '--disable-background-networking',
      '--disable-features=Translate,msEdgeSidebarV2',
      '--window-size=1100,780',
      'about:blank',
    ];
    if (this.headless) args.unshift('--headless=new', '--disable-gpu');

    this.proc = spawn(this.exe, args, { stdio: 'ignore', detached: false });
    this.proc.on('error', (e) => { if (!this.closed) warn(`浏览器进程错误：${e.message}`); });

    const version = await this.#waitForEndpoint();
    this.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error(`CDP WebSocket 连接失败：${e.message || 'unknown'}`));
    });
    this.ws.onmessage = (ev) => this.#onMessage(ev.data);
    this.ws.onclose = () => { this.closed = true; };

    const bv = await this.send('Browser.getVersion');
    this.version = bv;
    return this;
  }

  async #waitForEndpoint() {
    let lastErr;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${this.endpoint}/json/version`);
        if (r.ok) return await r.json();
      } catch (e) { lastErr = e; }
      await sleep(250);
    }
    throw new Error(`浏览器调试端口 ${this.port} 未就绪：${lastErr?.message || 'timeout'}`);
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ' — ' + msg.error.data : ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) for (const fn of this.listeners) fn(msg);
  }

  /** 订阅 CDP 事件（含带 sessionId 的事件） */
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { this.pending.delete(id); reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 调用超时：${method}`)); }
      }, 60000);
    });
  }

  /** 新建标签页并附加，返回 {targetId, sessionId} */
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Network.enable', {}, sessionId);
    // 页面内实时回传通道：门户跳转后上一文档的响应体会被回收，
    // 因此关键报文必须在页面内当场推给 Node，而不是事后去取。
    try { await this.send('Runtime.addBinding', { name: BINDING }, sessionId); } catch { /* 老版本忽略 */ }
    this.sessions.set(sessionId, page);
    return page;
  }

  /** 关闭浏览器（含所有子进程） */
  async close() {
    if (this.closed) return;
    try { await this.send('Browser.close'); } catch {}
    try { this.ws?.close(); } catch {}
    this.closed = true;
    await sleep(400);
    try { if (this.proc && !this.proc.killed) this.proc.kill(); } catch {}
  }
}

export const BINDING = '__campusApiLog';

export class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.apiResponses = [];   // 门户接口 / 文档级响应（含响应体）
    this.apiLog = [];         // 页面内实时回传的门户接口报文
    this.consoleLogs = [];
    this.frameNavigations = [];
    this.reqMeta = new Map(); // requestId -> {url, type, method}
    this.#hook();
  }

  #hook() {
    this.browser.onEvent(async (msg) => {
      if (msg.sessionId !== this.sessionId) return;

      // 页面内拦截器通过绑定实时推送的门户接口报文（最可靠）
      if (msg.method === 'Runtime.bindingCalled' && msg.params.name === BINDING) {
        try {
          const d = JSON.parse(msg.params.payload);
          if (!this.apiLog.some((x) => x.api === d.api && x.body === d.body && Math.abs(x.ts - Date.now()) < 1500)) {
            this.apiLog.push({ ...d, ts: Date.now() });
          }
        } catch { /* 忽略无法解析的载荷 */ }
        return;
      }

      // 记录请求元信息：loadingFinished 可能先于 responseReceived 到达，
      // 因此响应体抓取不能依赖 apiResponses 里已有的记录。
      if (msg.method === 'Network.requestWillBeSent') {
        this.reqMeta.set(msg.params.requestId, {
          url: msg.params.request.url,
          type: msg.params.type,
          method: msg.params.request.method,
        });
        return;
      }

      const wanted = (url, type) => /\/api\//.test(url || '') || type === 'Document';

      if (msg.method === 'Network.responseReceived') {
        const { requestId } = msg.params;
        const url = msg.params.response.url;
        const type = msg.params.type;
        if (wanted(url, type)) {
          const rec = this.apiResponses.find((r) => r.requestId === requestId);
          if (rec) { rec.url = url; rec.status = msg.params.response.status; }
          else this.apiResponses.push({
            url, status: msg.params.response.status, type,
            requestId, ts: Date.now(), body: undefined,
          });
        }
        return;
      }

      if (msg.method === 'Network.loadingFailed') {
        const rec = this.apiResponses.find((r) => r.requestId === msg.params.requestId);
        if (rec && rec.body === undefined) rec.body = `<failed: ${msg.params.errorText}>`;
        return;
      }

      if (msg.method === 'Network.loadingFinished') {
        const { requestId } = msg.params;
        let rec = this.apiResponses.find((r) => r.requestId === requestId);
        if (!rec) {
          const meta = this.reqMeta.get(requestId);
          if (meta && wanted(meta.url, meta.type)) {
            rec = { url: meta.url, status: null, type: meta.type, requestId, ts: Date.now(), body: undefined };
            this.apiResponses.push(rec);
          }
        }
        if (rec && rec.body === undefined) {
          try {
            const r = await this.browser.send('Network.getResponseBody', { requestId }, this.sessionId);
            rec.body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
          } catch (e) { rec.body = '<unavailable>'; }
        }
        return;
      }

      if (msg.method === 'Runtime.consoleAPICalled') {
        this.consoleLogs.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) {
        this.frameNavigations.push({ url: msg.params.frame.url, ts: Date.now() });
      }
    });
  }

  /** 在页面上下文中执行 JS，返回可序列化的值 */
  async evaluate(expression, { awaitPromise = false, timeout = 30000 } = {}) {
    const r = await this.browser.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, this.sessionId);
    if (r.exceptionDetails) {
      throw new Error(`页面 JS 异常：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }

  /** 在页面上下文中调用门户 API（自动带上同源 Cookie / Session） */
  async portalFetch(path, params = {}) {
    const body = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const expr = `(async () => {
      const r = await fetch(${JSON.stringify(path)}, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: ${JSON.stringify(body)},
        credentials: 'include'
      });
      const t = await r.text();
      return JSON.stringify({status: r.status, text: t});
    })()`;
    const raw = await this.evaluate(expr, { awaitPromise: true });
    const parsed = JSON.parse(raw);
    let json = null;
    try { json = JSON.parse(parsed.text); } catch {}
    return { ...parsed, json };
  }

  async navigate(url, { waitMs = 1500 } = {}) {
    await this.browser.send('Page.navigate', { url }, this.sessionId);
    await sleep(waitMs);
  }

  /** 轮询等待页面条件成立，返回最终结果（true/false） */
  async waitFor(expression, { timeout = 20000, interval = 250, label = '' } = {}) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try { last = await this.evaluate(expression); if (last) return true; } catch (e) { last = e.message; }
      await sleep(interval);
    }
    if (label) warn(`等待超时（${label}），最后结果：${JSON.stringify(last)}`);
    return false;
  }

  async title() { return this.evaluate('document.title'); }
  async url() { return this.evaluate('location.href'); }
  async close() { try { await this.browser.send('Target.closeTarget', { targetId: this.targetId }); } catch {} }
}
