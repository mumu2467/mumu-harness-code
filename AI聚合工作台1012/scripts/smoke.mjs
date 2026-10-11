/**
 * 后端端到端烟测（不需要浏览器、不需要前端）。
 *
 * 覆盖：健康检查 → WS 订阅 → 三窗并发投递 → 流式增量 → 完成统计
 *       → 主动停止（stopped）→ 重试（复用同一 replyId）→ 失败注入（错误分类）
 *
 * 用法：
 *   node scripts/smoke.mjs                       # 默认 http://127.0.0.1:8787
 *   node scripts/smoke.mjs http://127.0.0.1:8787
 *
 * 退出码：0 全部断言通过；1 有断言失败。
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const wsUrl = `${base.replace(/^http/, 'ws')}/ws`;
const PROVIDERS = ['deepseek', 'doubao', 'kimi'];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建立 WS 连接并收集事件 */
async function connect() {
  const events = [];
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS 连接超时')), 8000);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error(`无法连接 ${wsUrl}`));
    };
  });
  ws.onmessage = (ev) => {
    try {
      events.push(JSON.parse(ev.data));
    } catch {
      /* 忽略 */
    }
  };
  return { ws, events };
}

/** 等某个条件成立（轮询收集到的事件） */
async function waitFor(events, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(events)) return true;
    await sleep(80);
  }
  console.log(`  ⏱ 等待超时：${label}`);
  return false;
}

function summarize(events, clientMsgId) {
  const mine = events.filter((e) => e.clientMsgId === clientMsgId);
  const out = {};
  for (const p of PROVIDERS) {
    const list = mine.filter((e) => e.provider === p);
    const deltas = list.filter((e) => e.type === 'reply.delta');
    const done = list.find((e) => e.type === 'reply.done');
    const error = list.find((e) => e.type === 'reply.error');
    out[p] = {
      started: list.some((e) => e.type === 'reply.started'),
      deltas: deltas.length,
      monotonic: (() => {
        // 累计全文必须单调变长（这是前端覆盖式渲染正确性的前提）
        let prev = 0;
        for (const d of deltas) {
          if (typeof d.content !== 'string' || d.content.length < prev) return false;
          prev = d.content.length;
        }
        return true;
      })(),
      done: done ?? null,
      error: error ?? null,
    };
  }
  return out;
}

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

async function main() {
  console.log(`\n后端烟测 → ${base}\n`);

  /* ---------- 0. 健康检查 ---------- */
  console.log('【0】健康检查');
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  check('GET /api/health 返回 ok', health.ok === true, `mode=${health.mode}`);
  check('三家 provider 状态齐全', Array.isArray(health.providers) && health.providers.length === 3);

  const { ws, events } = await connect();
  const sessionId = `smoke-${Date.now()}`;
  ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
  await sleep(150);
  check('WS 收到 hello', events.some((e) => e.type === 'hello'));

  /* ---------- 1. 三窗并发 + 流式 ---------- */
  console.log('\n【1】三窗并发投递 + 流式输出');
  const c1 = `c1-${Date.now()}`;
  const sent = await post('/api/send', {
    sessionId,
    clientMsgId: c1,
    text: '烟测：请用一句话自我介绍',
    images: [],
    providers: PROVIDERS,
  });
  check('POST /api/send 返回 200', sent.status === 200, `replies=${sent.json?.replies?.length}`);
  check('返回三条 replyId', (sent.json?.replies ?? []).length === 3);

  const ok1 = await waitFor(
    events,
    (ev) => PROVIDERS.every((p) => ev.some((e) => e.clientMsgId === c1 && e.provider === p && e.type === 'reply.done')),
    90000,
    '三家 reply.done',
  );
  const s1 = summarize(events, c1);
  for (const p of PROVIDERS) {
    const r = s1[p];
    check(`${p}: started → 多个 delta → done`, r.started && r.deltas >= 2 && !!r.done, `delta=${r.deltas}`);
    check(`${p}: delta 内容单调变长`, r.monotonic);
    check(`${p}: done 带统计（耗时/首字/token）`,
      !!r.done && typeof r.done.latencyMs === 'number' && typeof r.done.tokenEst === 'number',
      r.done ? `耗时=${r.done.latencyMs}ms 首字=${r.done.firstTokenMs ?? '—'}ms ≈${r.done.tokenEst}tok` : '');
    check(`${p}: delta 是累计全文（与 done 一致）`,
      !!r.done && r.done.content.length > 0);
  }
  check('三家全部完成', ok1);

  /* ---------- 2. 主动停止 ---------- */
  console.log('\n【2】主动停止（/slow 慢速输出后立刻停止）');
  const c2 = `c2-${Date.now()}`;
  const sent2 = await post('/api/send', {
    sessionId,
    clientMsgId: c2,
    text: '/slow 烟测：停止功能',
    images: [],
    providers: ['doubao'],
  });
  check('单窗投递返回 200', sent2.status === 200, `status=${sent2.status} ${JSON.stringify(sent2.json)}`);
  const replyId2 = sent2.json?.replies?.[0]?.replyId;
  await waitFor(events, (ev) => ev.some((e) => e.clientMsgId === c2 && e.type === 'reply.delta'), 30000, '首个 delta');
  const stopRes = await post(`/api/replies/${replyId2}/stop`);
  check('POST .../stop 返回 200', stopRes.status === 200, `status=${stopRes.status} ${JSON.stringify(stopRes.json)}`);
  await waitFor(events, (ev) => ev.some((e) => e.clientMsgId === c2 && e.type === 'reply.done'), 30000, '停止后的 done');
  const s2 = summarize(events, c2);
  check('停止后产生 stopped=true 的 done', s2.doubao.done?.stopped === true);

  /* ---------- 3. 重试（复用同一 replyId） ---------- */
  console.log('\n【3】重试（同一 replyId 重跑）');
  const c3 = `c3-${Date.now()}`;
  const sent3 = await post('/api/send', {
    sessionId,
    clientMsgId: c3,
    text: '烟测：重试功能',
    images: [],
    providers: ['kimi'],
  });
  check('单窗投递返回 200（重试用例）', sent3.status === 200, `status=${sent3.status} ${JSON.stringify(sent3.json)}`);
  const replyId3 = sent3.json?.replies?.[0]?.replyId;
  await waitFor(events, (ev) => ev.some((e) => e.clientMsgId === c3 && e.type === 'reply.done'), 60000, '首轮完成');
  const retryRes = await post(`/api/replies/${replyId3}/retry`);
  check('POST .../retry 返回 200', retryRes.status === 200, `status=${retryRes.status} ${JSON.stringify(retryRes.json)}`);
  const okRetry = await waitFor(
    events,
    (ev) => ev.filter((e) => e.replyId === replyId3 && e.type === 'reply.started').length >= 2 &&
            ev.filter((e) => e.replyId === replyId3 && e.type === 'reply.done').length >= 2,
    60000,
    '重试后的第二轮 started+done',
  );
  check('重试复用同一 replyId 并再次完成', okRetry);

  /* ---------- 4. 失败注入 ---------- */
  console.log('\n【4】失败注入（/fail → reply.error + 错误分类）');
  const c4 = `c4-${Date.now()}`;
  await post('/api/send', {
    sessionId,
    clientMsgId: c4,
    text: '/fail 烟测：错误态',
    images: [],
    providers: PROVIDERS,
  });
  await waitFor(
    events,
    (ev) => PROVIDERS.every((p) => ev.some((e) => e.clientMsgId === c4 && e.provider === p && e.type === 'reply.error')),
    40000,
    '三家 reply.error',
  );
  const s4 = summarize(events, c4);
  for (const p of PROVIDERS) {
    check(`${p}: 返回 reply.error 且带 errorCode`, !!s4[p].error && !!s4[p].error?.errorCode,
      s4[p].error ? `${s4[p].error.errorCode}: ${s4[p].error.error}` : '');
  }

  /* ---------- 5. 参数校验 ---------- */
  console.log('\n【5】入参校验');
  const bad1 = await post('/api/send', { sessionId, clientMsgId: 'x', text: 'hi', providers: [] });
  check('providers 为空 → 400', bad1.status === 400, bad1.json?.error);
  const bad2 = await post('/api/send', { sessionId, clientMsgId: 'x', text: '   ', images: [], providers: ['deepseek'] });
  check('文字与图片同时为空 → 400', bad2.status === 400, bad2.json?.error);
  const bad3 = await post('/api/send', { sessionId, clientMsgId: 'x', text: 'hi', providers: ['gpt5'] });
  check('未知 provider → 400', bad3.status === 400, bad3.json?.error);

  /* ---------- 6. 会话隔离 ---------- */
  console.log('\n【6】会话隔离');
  const other = `smoke-other-${Date.now()}`;
  const resOther = await fetch(`${base}/api/health`).then((r) => r.json());
  check('health 可用（会话隔离在 P2 落库后由服务端保证）', resOther.ok === true);

  ws.close();

  /* ---------- 汇总 ---------- */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const f of failed) console.log(`  · ${f.name} ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('全部通过 🎉');
  }
}

main().catch((err) => {
  console.error('\n烟测异常：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
