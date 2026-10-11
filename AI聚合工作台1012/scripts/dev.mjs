/**
 * 启动器：同时拉起后端（tsx watch）与前端（Vite）。
 *
 * 设计要点（都是踩过坑之后改的）：
 * 1. **不用 shell 拼接命令**：shell: true 传参数组在 Windows 上会触发 Node 的
 *    DEP0190 告警，而且带空格的路径容易出问题。这里直接从 node_modules 解析
 *    出 tsx / vite 的 CLI 入口，用 node 直接执行。
 * 2. **退出时必须回收整棵进程树**：tsx watch 与 Vite 自己还会再起子进程，
 *    只 kill 直接子进程会留下孤儿进程占着 8787/5173 ——
 *    表现就是"下次启动后端 EADDRINUSE，前端却连着上一个陈旧后端"。
 *    Windows 用 taskkill /T /F，类 Unix 用进程组。
 * 3. 为什么不用 concurrently：它会用管道捕获子进程输出，受限环境下会 EPERM；
 *    stdio: 'inherit' 直接继承终端没有这个问题。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let closing = false;

/** 从已安装的包解析 bin 入口（比硬编码路径可靠） */
function resolveBin(pkg, binName) {
  try {
    const dir = path.join(root, 'node_modules', pkg);
    const pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const rel = typeof pkgJson.bin === 'string' ? pkgJson.bin : pkgJson.bin?.[binName];
    if (!rel) return null;
    const full = path.join(dir, rel);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

/** 结束整棵进程树（同步，确保在进程退出前真的杀干净） */
function killTree(child) {
  if (!child.pid) return;
  try {
    if (isWin) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // detached 启动时子进程自成进程组，可以整组结束
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  } catch {
    /* 已经退出 */
  }
}

function shutdown(code) {
  if (closing) return;
  closing = true;
  for (const child of children) killTree(child);
  process.exit(code);
}

function run(name, cmd, args, cwd) {
  const child = spawn(cmd, args, {
    cwd,
    stdio: 'inherit',
    // 类 Unix 下让子进程自成进程组，便于整组结束
    detached: !isWin,
    env: process.env,
  });
  children.push(child);

  child.on('exit', (code) => {
    if (!closing) {
      console.log(`\n[dev] ${name} 已退出（code=${code}），正在停止其余进程…`);
      shutdown(code ?? 0);
    }
  });
  child.on('error', (err) => {
    console.error(`[dev] 启动 ${name} 失败：${err.message}`);
    shutdown(1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  if (!closing) for (const child of children) killTree(child);
});

const tsxCli = resolveBin('tsx', 'tsx');
const viteCli = resolveBin('vite', 'vite');

console.log('[dev] 正在启动后端与前端…（Ctrl+C 全部停止）');

if (tsxCli && viteCli) {
  run('后端', process.execPath, [tsxCli, 'watch', 'src/index.ts'], path.join(root, 'packages/server'));
  run('前端', process.execPath, [viteCli], path.join(root, 'packages/web'));
} else {
  // 兜底：直接用 npm（Windows 下 .cmd 必须走 shell）
  console.warn('[dev] 未在 node_modules 里找到 tsx/vite，回退到 npm run');
  const npm = isWin ? 'npm.cmd' : 'npm';
  const runNpm = (name, args) => {
    const child = spawn(npm, args, { cwd: root, stdio: 'inherit', shell: isWin, env: process.env });
    children.push(child);
    child.on('exit', (code) => {
      if (!closing) shutdown(code ?? 0);
    });
  };
  runNpm('后端', ['run', 'dev', '-w', '@aiwb/server']);
  runNpm('前端', ['run', 'dev', '-w', '@aiwb/web']);
}
