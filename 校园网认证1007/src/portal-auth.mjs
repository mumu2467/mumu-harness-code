/**
 * portal-auth.mjs —— 通过浏览器操作校园网（raas 门户）完成实名认证
 *
 * 走的是真实页面流程：打开 172.19.1.1 → 填入学号/密码 → 点击“登录”
 * → 等待门户返回结果。密码由门户自带 JS 加密，程序不接触加密算法。
 */
import { C, ok, info, warn, fail, kv, sleep } from './util.mjs';

const SEL = {
  user: '#user',
  pass: '#pass',
  pool: '#pool',
  loginBtn: '.account .submit .btn',
  logoffBtn: '.logged-in .loggoff',
  msgZone: '.login-footer .msg-zone',
  loginWin: '#login-win',
};

/** 用原生 setter 赋值并触发事件，保证 jQuery/页面逻辑能感知 */
function setValueExpr(selector, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not-found' };
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  })()`;
}

/**
 * 在页面内安装门户接口记录器。
 * 门户认证成功后会把浏览器跳到 www.baidu.com，届时上一文档的响应体已被回收，
 * 事后用 Network.getResponseBody 取不到；所以这里在页面内当场把报文推给 Node。
 */
const INSTALL_API_RECORDER = `(() => {
  if (window.__campusHooked) return 'already';
  window.__campusHooked = true;

  const strip = (u) => {
    const s = String(u || '');
    const i = s.indexOf('://');
    const p = i >= 0 ? s.slice(i + 3) : s;
    const j = p.indexOf('/');
    return j >= 0 ? p.slice(j) : p;
  };
  // 门户用相对地址发请求（如 'api/login.php'），必须按当前页面解析成绝对路径
  const norm = (u) => {
    try { return new URL(String(u || ''), location.href).pathname; } catch (e) { return strip(u); }
  };
  const push = (api, status, body) => {
    const path = norm(api);
    if (path.indexOf('/api/') !== 0) return;
    const item = { api: path, status, body: String(body == null ? '' : body).slice(0, 1000) };
    try { if (typeof window.__campusApiLog === 'function') window.__campusApiLog(JSON.stringify(item)); } catch (e) {}
  };

  const OX = XMLHttpRequest.prototype.open;
  const OS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__cu = u; return OX.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('loadend', () => {
      let t = '';
      try { t = this.responseText; } catch (e) { t = ''; }
      push(this.__cu, this.status, t);
    });
    return OS.apply(this, arguments);
  };

  const of = window.fetch;
  if (of) {
    window.fetch = function (...a) {
      const u = a[0];
      return of.apply(this, a).then((r) => {
        try {
          r.clone().text().then((t) => push(typeof u === 'string' ? u : (u && u.url), r.status, t)).catch(() => {});
        } catch (e) {}
        return r;
      });
    };
  }
  return 'installed';
})()`;

/**
 * @returns {Promise<{state:'online'|'skipped'|'success'|'failed'|'error', message:string, acct?:string, detail?:any}>}
 */
export async function authenticate(page, {
  portal, username, password, relogin = false, verbose = true,
} = {}) {
  const say = (...a) => { if (verbose) console.log(...a); };

  // ── 1. 打开门户首页 ──────────────────────────────────────────────
  say(`   ${C.gray('打开')} ${C.cyan(portal)}`);
  await page.navigate(portal, { waitMs: 1200 });

  const loaded = await page.waitFor(
    `!!document.querySelector(${JSON.stringify(SEL.user)}) && !!document.querySelector(${JSON.stringify(SEL.pass)})`,
    { timeout: 20000, interval: 300, label: '门户登录表单' },
  );
  if (!loaded) {
    const title = await page.title().catch(() => '?');
    return { state: 'error', message: `门户登录表单未出现（当前标题：${title}），请确认地址可达且未被其他页面占用` };
  }
  say(`   ${C.gray('门户标题')} ${await page.title()}`);

  // ── 2. 查询当前认证状态 ─────────────────────────────────────────
  let before = null;
  try {
    const r = await page.portalFetch(`${portal}/api/ip.php`);
    before = r.json?.data;
    say(`   ${C.gray('当前状态')} ${JSON.stringify(r.json)}`);
  } catch (e) {
    warn(`读取门户状态失败：${e.message}`);
  }

  const alreadyOnline = before?.logined === 1;
  if (alreadyOnline && !relogin) {
    return {
      state: 'online',
      message: '本机 IP 已处于认证在线状态，无需重复登录',
      acct: before.acct || '',
      detail: before,
    };
  }

  // ── 3. 如需重新认证，先注销 ─────────────────────────────────────
  if (alreadyOnline && relogin) {
    say(`   ${C.gray('注销')} 先下线当前会话…`);
    try {
      const r = await page.portalFetch(`${portal}/api/logoff.php`);
      say(`   ${C.gray('注销返回')} ${r.text}`);
    } catch (e) {
      warn(`注销请求失败：${e.message}`);
    }
    await sleep(1500);
  }

  // ── 4. 填入账号密码 ────────────────────────────────────────────
  const fillUser = await page.evaluate(setValueExpr(SEL.user, username));
  if (!fillUser?.ok) return { state: 'error', message: '未找到账号输入框 #user' };
  const fillPass = await page.evaluate(setValueExpr(SEL.pass, password));
  if (!fillPass?.ok) return { state: 'error', message: '未找到密码输入框 #pass' };

  // 线路下拉框（若门户提供且未选中，选第一项）
  const poolInfo = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL.pool)});
    if (!el || !el.options.length) return null;
    if (!el.value) {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      desc.set.call(el, el.options[0].value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return el.value;
  })()`);

  say(`   ${C.gray('已填入')} 账号 ${C.bold(username)} / 密码 ${'*'.repeat(password.length)}${poolInfo ? ` / 线路 ${poolInfo}` : ''}`);

  // ── 5. 点击登录，抓取门户 API 应答 ──────────────────────────────
  page.apiResponses.length = 0;
  page.apiLog.length = 0;
  // 页面内拦截器：认证成功后门户会立即跳转到百度，报文必须当场回传
  try {
    const hooked = await page.evaluate(INSTALL_API_RECORDER);
    say(`   ${C.gray('接口记录器')} ${hooked === 'installed' ? '已安装' : hooked}`);
  } catch (e) {
    warn(`接口记录器安装失败（不影响认证）：${e.message}`);
  }

  const clicked = await page.evaluate(`(() => {
    const b = document.querySelector(${JSON.stringify(SEL.loginBtn)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) return { state: 'error', message: '未找到登录按钮' };
  say(`   ${C.gray('已点击')} 登录按钮，等待门户应答…`);

  const deadline = Date.now() + 40000;
  let verdict = null;
  let lastMsg = '';
  let leftPortalAt = null;

  /** 汇总目前抓到的门户接口原始报文（页面内回传 + 网络层抓取，去重合并） */
  const collectApiLog = () => {
    const items = [
      ...page.apiLog.map((r) => ({ api: r.api, status: r.status, body: r.body })),
      ...page.apiResponses
        .filter((r) => /\/api\//.test(r.url) && typeof r.body === 'string' && !r.body.startsWith('<'))
        .map((r) => ({ api: r.url.replace(/^https?:\/\/[^/]+/, ''), status: r.status, body: r.body })),
    ];
    const seen = new Set();
    return items
      .filter((r) => {
        const k = `${r.api}|${r.body}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((r) => ({ ...r, body: String(r.body).slice(0, 800) }));
  };

  while (Date.now() < deadline) {
    await sleep(500);

    // 页面上给用户看的提示
    const msg = await page.evaluate(`(document.querySelector(${JSON.stringify(SEL.msgZone)})?.innerText || '').trim()`).catch(() => '');
    if (msg && msg !== lastMsg) { lastMsg = msg; say(`   ${C.gray('门户提示')} ${msg}`); }

    // 门户 API 应答：优先用页面内实时回传的报文，网络层抓取作为补充
    const pending = [];
    for (const r of page.apiLog) if (!r.__seen) pending.push({ url: r.api, body: r.body, key: r });
    for (const r of page.apiResponses) {
      if (typeof r.body !== 'string' || r.body.startsWith('<') || r.__seen) continue;
      pending.push({ url: r.url, body: r.body, key: r });
    }

    for (const rec of pending) {
      let j = null;
      try { j = JSON.parse(rec.body); } catch { continue; }
      if (/\/api\/login\.php/.test(rec.url)) {
        rec.key.__seen = true;
        say(`   ${C.gray('login.php')} ${rec.body.slice(0, 300)}`);
        if (j.ret === 0) { verdict = { state: 'success', message: j.msg || '认证成功', detail: j }; break; }
        if (j.ret === 3) { verdict = { state: 'success', message: (j.msg || '已经认证成功') + '（门户判定为已在线）', detail: j }; break; }
        if (j.ret === 121 || j.ret === 122) { verdict = { state: 'success', message: j.msg || '认证成功（门户兼容码）', detail: j }; break; }
        verdict = { state: 'failed', message: j.msg || `认证失败（ret=${j.ret}）`, detail: j };
      }
      if (/\/api\/stat\.php/.test(rec.url)) {
        rec.key.__seen = true;
        say(`   ${C.gray('stat.php')}  ${rec.body.slice(0, 200)}`);
        if (j.ret === 0) { verdict = { state: 'success', message: j.msg || '认证成功', detail: j }; break; }
      }
    }
    if (verdict && verdict.state !== 'failed') break;

    // 页面已被门户跳转到外网 → 视为成功；再留 2.5 秒收集接口报文
    const cur = await page.url().catch(() => '');
    if (cur && !cur.includes('172.19.1.1') && /^https?:/.test(cur)) {
      leftPortalAt = leftPortalAt || Date.now();
      if (Date.now() - leftPortalAt > 2500) {
        if (!verdict || verdict.state === 'failed') {
          verdict = { state: 'success', message: `门户已跳转至 ${cur}`, detail: { url: cur } };
        }
        break;
      }
    }
  }

  const apiLog = collectApiLog();

  // 认证成功后门户会把页面跳到外网；导航回门户再读取最终状态
  let after = null;
  try {
    const cur = await page.url().catch(() => '');
    if (!cur.includes('172.19.1.1')) {
      say(`   ${C.gray('回访门户')} 读取认证后的最终状态…`);
      await page.navigate(portal, { waitMs: 1800 });
    }
    const finalState = await page.portalFetch(`${portal}/api/ip.php`);
    after = finalState?.json?.data;
  } catch (e) {
    warn(`读取门户最终状态失败：${e.message}`);
  }

  if (!verdict) verdict = { state: 'failed', message: lastMsg || '等待门户应答超时（40 秒）' };
  if (verdict.state === 'failed' && after?.logined === 1) {
    verdict = { state: 'success', message: '门户状态显示已在线', detail: after };
  }
  verdict.acct = after?.acct || username;
  verdict.detail = { portalReply: verdict.detail, ipAfter: after, apiLog };
  const shown = apiLog.slice(-8);
  for (const r of shown) say(`   ${C.gray('接口报文')} ${r.api} → ${r.body.slice(0, 220)}`);
  return verdict;
}
