/**
 * nettest.mjs —— 网络质量检测
 *   1) ICMP ping（调用系统 ping.exe，解析中英文输出）
 *   2) TCP 握手延时（ICMP 被禁时兜底）
 *   3) 互联网连通性探测
 *   4) 下载测速（多源，取实测吞吐）
 */
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { lookup } from 'node:dns/promises';
import { C, human, info, warn, sleep } from './util.mjs';

const NOOP = () => {};
const silent = { log: NOOP, info: NOOP, warn: NOOP };

// ───────────────────────── 连通性 ─────────────────────────

/** 探测外网是否真的通（返回 {ok, results[]}） */
export async function checkInternet({ timeout = 6000 } = {}) {
  const targets = [
    { name: '百度', url: 'http://www.baidu.com/' },
    { name: 'Android 204', url: 'http://connect.rom.miui.com/generate_204' },
  ];
  const results = [];
  for (const t of targets) {
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(t.url, { signal: ac.signal, redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
      results.push({ ...t, ok: true, status: res.status, ms: Date.now() - t0 });
      try { await res.body?.cancel(); } catch {}
    } catch (e) {
      results.push({ ...t, ok: false, error: e.cause?.code || e.message, ms: Date.now() - t0 });
    } finally { clearTimeout(timer); }
  }
  return { ok: results.some((r) => r.ok), results };
}

// ───────────────────────── ping ─────────────────────────

/**
 * 解码控制台程序输出。
 * 中文 Windows 的 ping.exe 输出为 GBK(CP936)，直接按 UTF-8 解码会变乱码，
 * 这里先用 UTF-8 试解，出现替换字符则回退 GBK。
 */
export function decodeConsole(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  for (const enc of ['gbk', 'gb18030', 'big5']) {
    try { return new TextDecoder(enc).decode(buf); } catch { /* 继续尝试 */ }
  }
  return buf.toString('latin1');
}

/** 系统 ICMP ping；解析中文/英文输出 */
export function icmpPing(host, count = 5, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const spawnFailed = (err) => done({
      available: false,
      error: err?.code === 'EPERM'
        ? 'ICMP 被当前运行环境禁止（spawn EPERM，无法调用系统 ping.exe）'
        : `无法启动 ping.exe：${err?.code || err?.message || 'unknown'}`,
      raw: '',
    });

    const handle = (err, stdout, stderr) => {
      const buf = Buffer.concat([
        Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''),
        Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || ''),
      ]);
      const text = decodeConsole(buf);
      if (!text.trim()) return spawnFailed(err || { message: 'ping 无任何输出' });

      // 1) 逐行取应答时间：带 TTL 的行必然是一次成功应答（与语言无关）
      const lineTimes = [];
      for (const line of text.split(/\r?\n/)) {
        if (!/TTL\s*=/i.test(line)) continue;
        const m = line.match(/[=<]\s*(\d+)\s*ms/i) || line.match(/(\d+)\s*ms/i);
        if (m) lineTimes.push(Number(m[1]));
      }
      // 2) 语言相关兜底
      const times = [...lineTimes];
      if (!times.length) {
        const re = /(?:time|时间)\s*[=<]\s*(\d+)\s*ms/gi;
        let m;
        while ((m = re.exec(text))) times.push(Number(m[1]));
      }

      const pick = (re) => { const m = text.match(re); return m ? Number(m[1]) : null; };
      const numFrom = (re) => { const m = text.match(re); return m ? Number(m[1].trim()) : null; };

      const min = numFrom(/(?:Minimum|最短)\s*=\s*(\d+)\s*ms/i) ?? (times.length ? Math.min(...times) : null);
      const max = numFrom(/(?:Maximum|最长)\s*=\s*(\d+)\s*ms/i) ?? (times.length ? Math.max(...times) : null);
      const avgRaw = numFrom(/(?:Average|平均)\s*=\s*(\d+)\s*ms/i)
        ?? (times.length ? times.reduce((a, b) => a + b, 0) / times.length : null);

      const loss = pick(/\((\d+(?:\.\d+)?)\s*%/) ?? pick(/(\d+(?:\.\d+)?)\s*%\s*(?:loss|丢失)/i)
        ?? ((count - times.length) / count) * 100;
      const ttl = pick(/TTL\s*=\s*(\d+)/i);
      const resolvedIp = (text.match(/\[([\d.]+)\]/) || [])[1];

      const available = times.length > 0;
      const unreachable = /100\s*%|无法访问|unreachable|timed out|超时|transmit failed|常规故障|一般故障/i.test(text);
      done({
        available,
        error: available ? null : (unreachable ? '目标无应答（ICMP 被拦截或超时）' : (err?.message || '未能解析 ping 输出')),
        host, ip: resolvedIp, sent: count, received: times.length,
        loss: Math.round(loss * 100) / 100,
        ttl,
        times,
        min, max,
        avg: avgRaw === null ? null : Math.round(avgRaw * 10) / 10,
        raw: text.trim(),
      });
    };

    try {
      const child = execFile('ping', ['-n', String(count), '-w', '2000', host],
        { timeout: timeoutMs, windowsHide: true, encoding: 'buffer' },
        handle);
      child.on('error', spawnFailed);
    } catch (e) {
      spawnFailed(e);
    }
  });
}

/** TCP 握手延时（ICMP 不可用时的替代测量） */
export async function tcpPing(host, port = 443, count = 5, timeoutMs = 4000) {
  let ip = host;
  try { ip = (await lookup(host)).address; } catch {}
  const times = [];
  for (let i = 0; i < count; i++) {
    const t0 = process.hrtime.bigint();
    const okOne = await new Promise((resolve) => {
      const sock = createConnection({ host: ip, port, timeout: timeoutMs });
      const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
    if (okOne) times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await sleep(120);
  }
  if (!times.length) return { available: false, ip, error: `无法与 ${ip}:${port} 建立 TCP 连接` };
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const jitter = times.length > 1
    ? Math.sqrt(times.reduce((s, t) => s + (t - avg) ** 2, 0) / times.length)
    : 0;
  return {
    available: true, ip, port, sent: count, received: times.length,
    loss: Math.round((1 - times.length / count) * 10000) / 100,
    min: Math.round(Math.min(...times) * 10) / 10,
    max: Math.round(Math.max(...times) * 10) / 10,
    avg: Math.round(avg * 10) / 10,
    jitter: Math.round(jitter * 10) / 10,
    times: times.map((t) => Math.round(t * 10) / 10),
  };
}

// ───────────────────────── 测速 ─────────────────────────

/**
 * 从单个源下载并测量吞吐。
 * 返回：
 *   mbps        —— 全程平均（含 TCP 慢启动，偏低）
 *   steadyMbps  —— 稳态吞吐（丢弃前 warmupMs 的慢启动阶段，最接近真实带宽）
 *   peakMbps    —— 单个采样窗口的峰值
 */
export async function measureSource(src, {
  maxBytes = 200 * 1024 * 1024, maxMs = 8000, warmupMs = 1000,
} = {}) {
  const ac = new AbortController();
  const hardStop = setTimeout(() => ac.abort(), maxMs + 6000);
  const t0 = Date.now();
  let ttfb = null, got = 0;
  const samples = []; // { at: 距开始毫秒, cum: 累计字节, mbps: 本窗口速率 }
  try {
    const res = await fetch(src.url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) campus-login/1.0',
        'Accept-Encoding': 'identity',
      },
    });
    if (!res.ok) return { name: src.name, ok: false, error: `HTTP ${res.status}` };

    const total = Number(
      (res.headers.get('content-range') || '').split('/')[1]
      || res.headers.get('content-length') || 0,
    );

    const reader = res.body.getReader();
    let winStart = t0, winBytes = 0;
    while (got < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = Date.now();
      if (ttfb === null) ttfb = now - t0;
      got += value.byteLength;
      winBytes += value.byteLength;
      const elapsed = now - t0;
      if (now - winStart >= 200) {
        samples.push({ at: elapsed, cum: got, mbps: (winBytes * 8) / ((now - winStart) / 1000) / 1e6 });
        winStart = now;
        winBytes = 0;
      }
      if (elapsed > maxMs) break;
    }
    try { await reader.cancel(); } catch {}

    const dt = (Date.now() - t0) / 1000;
    if (got === 0) return { name: src.name, ok: false, error: '未收到数据' };

    // 稳态：丢弃慢启动阶段，用首尾采样点的累计字节差算平均
    let steady = samples.filter((s) => s.at >= warmupMs);
    if (steady.length < 2) steady = samples.length > 2 ? samples.slice(1) : samples;
    const first = steady[0], last = steady[steady.length - 1];
    const steadyMbps = (last && first && last.at > first.at)
      ? ((last.cum - first.cum) * 8) / ((last.at - first.at) / 1000) / 1e6
      : (got * 8) / dt / 1e6;

    return {
      name: src.name, ok: true,
      bytes: got, serverSize: total, ttfb,
      seconds: Math.round(dt * 100) / 100,
      mbps: Math.round(((got * 8) / dt / 1e6) * 10) / 10,
      steadyMbps: Math.round(steadyMbps * 10) / 10,
      peakMbps: Math.round(Math.max(...samples.map((s) => s.mbps)) * 10) / 10,
      mBps: Math.round((got / dt / 1048576) * 100) / 100,
      windows: samples.length,
      samples: samples.map((s) => Math.round(s.mbps * 10) / 10),
    };
  } catch (e) {
    return { name: src.name, ok: false, error: e.cause?.code || e.name || e.message };
  } finally { clearTimeout(hardStop); }
}

/** 依次对多个源测速，返回全部结果 */
export async function speedTest(sources, opts = {}) {
  const out = [];
  for (const src of sources) {
    const r = await measureSource(src, opts);
    out.push(r);
    if (r.ok && r.mbps > 5) { /* 继续测下一个源，便于交叉验证 */ }
  }
  return out;
}
