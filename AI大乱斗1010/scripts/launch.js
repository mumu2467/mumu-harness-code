/**
 * ============================================================================
 *  scripts/launch.js —— 跨平台启动器（npm start / npm run dev 实际调用的就是它）
 * ----------------------------------------------------------------------------
 *  为什么要多这一层？
 *    某些环境（CI、容器、Electron 工具链、以及本机的 DSH 会话）会设置
 *    环境变量 ELECTRON_RUN_AS_NODE=1，它会让 electron.exe 退化成"纯 Node 运行时"，
 *    表现为：npm start 一闪而过、没有窗口、也没有任何日志（甚至 --version 打印的是 Node 版本）。
 *
 *    这个启动器做的就是：复制一份环境变量 → 删掉 ELECTRON_RUN_AS_NODE → 再启动 Electron。
 *    顺便把 Electron 的 stdout/stderr 落到 ~/.ai-arena/launch.log，
 *    如果进程异常快速退出，会自动把日志尾部打印出来，方便定位。
 *
 *  用法：
 *    node scripts/launch.js                # 等同 npm start
 *    node scripts/launch.js --enable-logging  # 等同 npm run dev
 * ============================================================================
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** 找到 electron 可执行文件路径 */
function resolveElectron() {
  try {
    // electron 包在 Node 里导出的是可执行文件绝对路径
    return require(path.join(ROOT, 'node_modules', 'electron'));
  } catch (err) {
    console.error('[launch] 找不到 electron，请先在项目目录执行: npm install');
    process.exit(1);
  }
}

function main() {
  const electron = resolveElectron();

  // ★ 核心：清掉会破坏 GUI 模式的环境变量
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const extraArgs = process.argv.slice(2);
  const args = ['.', ...extraArgs];

  // 日志落盘（放用户目录，不污染项目）
  const logDir = path.join(os.homedir(), '.ai-arena');
  const logFile = path.join(logDir, 'launch.log');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (e) { /* 忽略 */ }

  console.log(`[launch] electron = ${electron}`);
  console.log(`[launch] 参数     = ${args.join(' ')}`);
  console.log(`[launch] 日志     = ${logFile}`);
  console.log('[launch] 正在启动 AI 大乱斗…（首次加载三个站点需要一点时间）');

  let out = null;
  try {
    out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n===== ${new Date().toISOString()} 启动 ${args.join(' ')} =====\n`);
  } catch (e) {
    out = null;
  }

  const child = spawn(electron, args, {
    cwd: ROOT,
    env,
    // 不用管道，直接写日志文件：既避免管道限制，又能留下可查的启动日志
    stdio: ['ignore', out === null ? 'ignore' : out, out === null ? 'ignore' : out],
    windowsHide: false
  });

  const startedAt = Date.now();

  child.on('error', (err) => {
    console.error('[launch] 启动失败：' + err.message);
    process.exit(3);
  });

  child.on('exit', (code, signal) => {
    const alive = Date.now() - startedAt;
    if (alive < 5000) {
      // 秒退：几乎一定是环境/依赖问题，把日志尾部打出来
      console.error(`\n[launch] ⚠ Electron 在 ${alive}ms 内就退出了（code=${code} signal=${signal}）。`);
      try {
        const text = fs.readFileSync(logFile, 'utf8');
        const tail = text.split('\n').slice(-40).join('\n');
        console.error('[launch] 启动日志尾部：\n' + tail);
      } catch (e) { /* 忽略 */ }
      console.error('\n[launch] 排查建议：');
      console.error('  1) 确认没有 ELECTRON_RUN_AS_NODE 环境变量（本启动器已自动清除）');
      console.error('  2) 执行 npm install 重新安装 electron（下载损坏时可删掉 node_modules/electron 重装）');
      console.error('  3) 用 npm run selftest 看三个站点能否正常加载');
    }
    process.exit(code === null ? 0 : code);
  });

  // 父进程收到 Ctrl+C 时，把子进程一起带走
  ['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => {
      try { child.kill(); } catch (e) { /* 忽略 */ }
    });
  });
}

main();
