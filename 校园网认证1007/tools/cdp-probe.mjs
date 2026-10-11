// 探针：验证零依赖 CDP 控制 Edge 是否可行
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'cdpprobe-'));

const child = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--headless=new',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getVersion() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP endpoint not reachable');
}

const ver = await getVersion();
console.log('BROWSER:', ver.Browser);
console.log('WS:', ver.webSocketDebuggerUrl);

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}, sessionId) {
  const mid = ++id;
  return new Promise((resolve) => {
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const t = await send('Target.createTarget', { url: 'http://172.19.1.1/' });
const targetId = t.result.targetId;
const att = await send('Target.attachToTarget', { targetId, flatten: true });
const sid = att.result.sessionId;
await send('Runtime.enable', {}, sid);
await sleep(2500);

const out = await send('Runtime.evaluate', {
  expression: `JSON.stringify({title: document.title, url: location.href, hasUser: !!document.querySelector('#user'), hasPass: !!document.querySelector('#pass'), bodyLen: document.body.innerHTML.length})`,
  returnByValue: true,
}, sid);
console.log('PAGE:', out.result?.result?.value);

const ipinfo = await send('Runtime.evaluate', {
  expression: `fetch('api/ip.php',{method:'POST'}).then(r=>r.text())`,
  awaitPromise: true, returnByValue: true,
}, sid);
console.log('API ip.php:', ipinfo.result?.result?.value);

ws.close();
child.kill();
console.log('PROBE OK');
