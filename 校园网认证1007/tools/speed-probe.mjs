// 探针：评估候选测速源的连通性与吞吐
const CANDIDATES = [
  { name: 'aliyun-deepin-iso', url: 'https://mirrors.aliyun.com/deepin/releases/20.9/deepin-desktop-community-20.9-amd64.iso' },
  { name: 'aliyun-ubuntu-iso', url: 'https://mirrors.aliyun.com/ubuntu-releases/24.04/ubuntu-24.04.3-desktop-amd64.iso' },
  { name: 'tuna-ubuntu-iso', url: 'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.3-desktop-amd64.iso' },
  { name: 'nju-ubuntu-iso', url: 'https://mirror.nju.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.3-desktop-amd64.iso' },
  { name: 'cloudflare-down', url: 'https://speed.cloudflare.com/__down?bytes=20000000' },
  { name: 'baidu-static', url: 'https://www.baidu.com/img/PCtm_d9c8750bed0b3c7d089fa7d55720d6cf.png' },
];

const CAP = 8 * 1024 * 1024;      // 最多读取 8MB
const MAX_MS = 6000;              // 最长 6 秒

for (const c of CANDIDATES) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MAX_MS + 2000);
  const t0 = Date.now();
  try {
    const res = await fetch(c.url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) { console.log(`${c.name.padEnd(20)} HTTP ${res.status}`); clearTimeout(timer); continue; }
    const total = Number(res.headers.get('content-length') || 0);
    let got = 0;
    const reader = res.body.getReader();
    let ttfb = null;
    while (got < CAP) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfb === null) ttfb = Date.now() - t0;
      got += value.byteLength;
      if (Date.now() - t0 > MAX_MS) break;
    }
    try { await reader.cancel(); } catch {}
    const dt = (Date.now() - t0) / 1000;
    const mbps = (got * 8) / dt / 1e6;
    console.log(`${c.name.padEnd(20)} ok  ${(got / 1048576).toFixed(2)}MB in ${dt.toFixed(2)}s  ttfb=${ttfb}ms  ${mbps.toFixed(1)} Mbps  size=${total ? (total / 1048576).toFixed(0) + 'MB' : '?'}`);
  } catch (e) {
    const dt = (Date.now() - t0) / 1000;
    console.log(`${c.name.padEnd(20)} FAIL ${dt.toFixed(2)}s  ${e.name}: ${e.message}`);
  } finally { clearTimeout(timer); }
}
