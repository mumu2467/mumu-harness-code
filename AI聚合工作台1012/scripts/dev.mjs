/**
 * 启动器：同时拉起后端（tsx watch）与前端（Vite）。
 *
 * 为什么不用 concurrently：
 *   它会用管道（pipe）捕获子进程输出以加前缀，而 DSH 的文件沙箱禁止在受限模式下
 *   通过命名管道捕获其他程序的输出（EPERM）。用 stdio: 'inherit' 直接继承终端则没有问题。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let closing = false;

function shutdown(code) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }
  // 给子进程一点时间自行退出（Windows 上 SIGTERM 行为有限）
  setTimeout(() => process.exit(code), 400);
}

function run(name, args) {
  const child = spawn(npm, args, { cwd: root, stdio: 'inherit', shell: isWin });
  children.push(child);
  child.on('exit', (code) => {
    if (!closing) {
      console.log(`\n[dev] ${name} 已退出（code=${code}），正在停止其余进程…`);
      shutdown(code ?? 0);
    }
  });
  child.on('error', (err) => {
    console.error(`[dev] 启动 ${name} 失败：`, err.message);
    shutdown(1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] 正在启动后端与前端…（Ctrl+C 全部停止）');
run('server', ['run', 'dev', '-w', '@aiwb/server']);
run('web', ['run', 'dev', '-w', '@aiwb/web']);
