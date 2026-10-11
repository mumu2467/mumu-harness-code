// 探针3：寻找体积足够大的国内测速文件
const CANDIDATES = [
  ['npmmirror-electron', 'https://cdn.npmmirror.com/binaries/electron/v28.3.3/electron-v28.3.3-win32-x64.zip'],
  ['huawei-electron', 'https://mirrors.huaweicloud.com/electron/v28.3.3/electron-v28.3.3-win32-x64.zip'],
  ['npmmirror-node-full', 'https://cdn.npmmirror.com/binaries/node/v18.20.4/node-v18.20.4-win-x64.7z'],
  ['aliyun-node', 'https://mirrors.aliyun.com/nodejs-release/v20.11.0/node-v20.11.0-win-x64.zip'],
  ['tuna-ubuntu', 'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/22.04/ubuntu-22.04.5-desktop-amd64.iso'],
  ['npmmirror-chromium', 'https://cdn.npmmirror.com/binaries/chromium-browser-snapshots/Win_x64/1000027/chrome-win.zip'],
];

for (const [name, url] of CANDIDATES) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-1' } });
    const len = Number(res.headers.get('content-range')?.split('/')[1] || res.headers.get('content-length') || 0);
    console.log(`${name.padEnd(22)} HTTP ${res.status}  size=${(len / 1048576).toFixed(1)}MB  ${Date.now() - t0}ms`);
    try { await res.body?.cancel(); } catch {}
  } catch (e) {
    console.log(`${name.padEnd(22)} FAIL ${Date.now() - t0}ms ${e.cause?.code || e.name}`);
  } finally { clearTimeout(timer); }
}
