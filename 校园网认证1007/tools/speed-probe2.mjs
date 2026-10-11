// 探针2：广谱测速源候选评估（Node 原生 fetch）
const CANDIDATES = [
  ['npmmirror-registry', 'https://registry.npmmirror.com/react/-/react-18.3.1.tgz'],
  ['npmmirror-cdn', 'https://cdn.npmmirror.com/binaries/node/v20.11.0/node-v20.11.0-win-x64.zip'],
  ['huawei-mirror', 'https://mirrors.huaweicloud.com/nodejs/v20.11.0/node-v20.11.0-win-x64.zip'],
  ['ustc-mirror', 'https://mirrors.ustc.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.3-desktop-amd64.iso'],
  ['cloudflare-50m', 'https://speed.cloudflare.com/__down?bytes=50000000'],
  ['jsdelivr', 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'],
  ['aliyun-root', 'https://mirrors.aliyun.com/'],
  ['baidu-204', 'https://www.baidu.com/'],
];

const CAP = 6 * 1024 * 1024;
const MAX_MS = 5000;

for (const [name, url] of CANDIDATES) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MAX_MS + 3000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    if (!res.ok) { console.log(`${name.padEnd(20)} HTTP ${res.status}  ${Date.now() - t0}ms`); continue; }
    const total = Number(res.headers.get('content-length') || 0);
    let got = 0, ttfb = null;
    const reader = res.body.getReader();
    while (got < CAP) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfb === null) ttfb = Date.now() - t0;
      got += value.byteLength;
      if (Date.now() - t0 > MAX_MS) break;
    }
    try { await reader.cancel(); } catch {}
    const dt = (Date.now() - t0) / 1000;
    console.log(`${name.padEnd(20)} ok  ${(got / 1048576).toFixed(2)}MB/${dt.toFixed(2)}s  ttfb=${ttfb}ms  ${((got * 8) / dt / 1e6).toFixed(1)}Mbps  len=${total}`);
  } catch (e) {
    console.log(`${name.padEnd(20)} FAIL ${((Date.now() - t0) / 1000).toFixed(2)}s ${e.cause?.code || e.name}: ${e.cause?.message || e.message}`);
  } finally { clearTimeout(timer); }
}
