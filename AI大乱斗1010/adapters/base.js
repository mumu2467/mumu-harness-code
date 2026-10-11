/**
 * ============================================================================
 *  adapters/base.js —— CommonJS 桥接层（Node 侧入口）
 * ----------------------------------------------------------------------------
 *  真正的实现在旁边的 base.mjs（标准 ES Module）：
 *    - 渲染进程（Chromium）直接 import 那个 .mjs；
 *    - 主进程 / Node 测试用 require，通过这一层拿到同一份实现。
 *
 *  ⚠ 本文件只做导出，业务逻辑请写在 base.mjs。
 * ============================================================================
 */

'use strict';

let cached = null;

function load() {
  if (cached) return cached;
  try {
    // Node 20.19+ / 22+ 支持 require() 直接加载 ESM
    cached = require('./base.mjs');
  } catch (err) {
    throw new Error(
      '无法加载 adapters/base.mjs。' +
      '若报 "Unexpected token export"，说明当前 Node 版本不支持 require(ESM)，' +
      '请升级到 Node 20.19+ / 22+。原始错误：' + (err && err.message)
    );
  }
  return cached;
}

module.exports = {
  get createAdapter() { return load().createAdapter; },
  get pageUtilsSource() { return load().pageUtilsSource; },
  get sleep() { return load().sleep; }
};
