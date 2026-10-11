/**
 * 安装后的环境自检（postinstall 钩子）
 * 只做提示，不阻断安装。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function main() {
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);

  lines.push(`Node 版本: ${process.versions.node}`);

  // ★ 常见坑：如果当前环境设置了 ELECTRON_RUN_AS_NODE，electron.exe 会退化成纯 Node，
  //   表现为"npm start 一闪而过、没有任何窗口和输出"。这里主动提醒并给出解决办法。
  if (process.env.ELECTRON_RUN_AS_NODE) {
    lines.push('⚠ 检测到环境变量 ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE);
    lines.push('  它会阻止 Electron 以 GUI 模式启动（npm start 会一闪而过）。');
    lines.push('  解决办法：在启动前清除它，例如 PowerShell 里执行：');
    lines.push('      Remove-Item Env:\\ELECTRON_RUN_AS_NODE; npm start');
  }

  // webview 需要 Electron 运行时，Node 版本过新时 electron 预编译包一般也 OK，这里只提示。
  if (major >= 26) {
    lines.push('提示: 当前 Node 版本较新，若 electron 安装出现异常，可改用 Node 20 LTS。');
  }

  const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
  if (fs.existsSync(electronDir)) {
    lines.push('Electron 已安装 ✅');
  } else {
    lines.push('警告: 未检测到 node_modules/electron，请确认 npm install 成功。');
  }

  console.log('\n===== AI大乱斗 环境自检 =====');
  lines.forEach((l) => console.log(' ' + l));
  console.log(' 启动方式: npm start');
  console.log('=============================\n');
}

main();
