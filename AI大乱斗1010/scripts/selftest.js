/**
 * ============================================================================
 *  scripts/selftest.js —— 自检运行器（npm run selftest）
 * ----------------------------------------------------------------------------
 *  作用：以 --selftest 启动应用，等它在 selftest-report.json 里写完报告后，
 *        把报告以人类可读的形式打印出来，方便确认：
 *          - 三个 webview 是否都拿到了 webContents 通道
 *          - 页面是否真的加载成功（URL / 标题）
 *          - 注入脚本是否生效
 *          - 每个站点的关键选择器是否命中
 *  用法：npm run selftest
 * ============================================================================
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'selftest-report.json');

/** 找到 electron 可执行文件 */
function resolveElectron() {
  try {
    // electron 包导出的就是可执行文件路径
    return require(path.join(ROOT, 'node_modules', 'electron'));
  } catch (err) {
    console.error('找不到 electron，请先 npm install');
    process.exit(1);
  }
}

function main() {
  // 清掉上一次的报告，避免读到旧数据
  try { fs.unlinkSync(REPORT); } catch (e) { /* 不存在就忽略 */ }

  const electron = resolveElectron();
  console.log('[selftest] 启动应用（自检模式），预计 40~60 秒…');

  // ★ 关键：某些环境（CI、容器、其他 Electron 工具链）会设置 ELECTRON_RUN_AS_NODE=1，
  //   那会让 electron.exe 退化成纯 Node 运行，表现为"启动即退出、没有任何输出"。
  //   这里显式删掉该变量，确保以完整 GUI 模式启动。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (env.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electron, ['.', '--selftest'], {
    cwd: ROOT,
    env,
    stdio: 'ignore', // 不抓 stdout，避免占用管道
    windowsHide: false
  });

  child.on('exit', () => {
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
    } catch (err) {
      console.error('[selftest] 没有读到报告文件：' + REPORT);
      console.error('          常见原因：');
      console.error('          1) 环境变量 ELECTRON_RUN_AS_NODE=1 导致 Electron 退化成 Node（本脚本已自动清除）');
      console.error('          2) 三个站点都没加载出来（检查网络/代理）');
      console.error('          3) 主进程启动即崩溃（用 npm run dev 看 Chromium 日志）');
      process.exit(2);
    }

    console.log('\n================ AI大乱斗 自检报告 ================');
    console.log('Electron / Chrome：', report.versions && `${report.versions.electron} / ${report.versions.chrome}`);
    console.log('开始：', report.startedAt, ' 结束：', report.finishedAt);

    let okCount = 0;
    (report.sites || []).forEach((s) => {
      const alive = s.alive ? '✔ 通道正常' : '✘ 通道异常';
      if (s.alive) okCount++;
      console.log(`\n---- ${s.name} (${s.id}) ----`);
      console.log(`  ${alive}   webContentsId=${s.webContentsId}`);
      console.log(`  页面：${s.href || '(空)'}`);
      console.log(`  标题：${s.title || '(空)'}`);
      console.log(`  注入脚本：${s.utilsInjected ? '已生效' : '未生效'}`);
      if (s.probe) {
        console.log(`  探测：就绪=${s.probe.ready} 输入框可见=${s.probe.inputVisible} 需登录=${s.probe.needLogin} 二维码=${s.probe.qrcode} 风控=${s.probe.risk}`);
      }
      const sel = s.selectors || {};
      const parts = Object.keys(sel).map((k) => `${k}=${sel[k].hit ? '✓' : '✗'}`);
      if (parts.length) console.log('  选择器命中：' + parts.join('  '));
      const missed = Object.keys(sel).filter((k) => !sel[k].hit);
      if (missed.length) {
        console.log('  未命中字段：' + missed.join(', '));
        (s.missed || []).forEach((m) => {
          console.log(`    - ${m.field} 试过：` + (m.tried || []).join(' , '));
        });
        console.log('  （未登录时未命中属正常；已登录仍未命中请按 README 第 5 节用 Ctrl+Shift+D 调试模式更新选择器）');
      }
      if (s.fileInputs) {
        console.log(`  input[type=file]：${s.fileInputs.count} 个`);
        (s.fileInputs.details || []).slice(0, 4).forEach((d) => console.log(`    - accept="${d.accept}" multiple=${d.multiple} hidden=${d.hidden}`));
      }
      if (s.error) console.log(`  ⚠ 错误：${s.error}`);
    });

    console.log(`\n结论：${okCount}/${(report.sites || []).length} 个站点通道正常`);
    console.log('报告文件：', REPORT);
    console.log('===================================================\n');
  });
}

main();
