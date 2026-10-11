/**
 * ============================================================================
 *  adapters/page-utils.js —— CommonJS 桥接层（Node 侧入口）
 * ----------------------------------------------------------------------------
 *  真正的实现在旁边的 page-utils.mjs（标准 ES Module）：
 *    - 渲染进程（Chromium）直接 import 那个 .mjs；
 *    - 主进程 / Node 测试用 require，需要经过这一层。
 *
 *  为什么必须这样分：
 *    1. Chromium 的 ESM 加载器【不】像 Node 那样兼容 CommonJS 的默认导出，
 *       所以实现文件必须是真正的 ESM；
 *    2. Node 无法 require 一个含 `export` 语句的文件（会报 Unexpected token 'export'）。
 *    两边各让一步的结果：实现走 ESM，Node 侧加一层 CJS 包装。
 *
 *  ⚠ 本文件只做导出，业务逻辑请写在 page-utils.mjs。
 * ============================================================================
 */

'use strict';

let cached = null;

function load() {
  if (cached) return cached;
  try {
    // Node 20.19+ / 22+ 支持 require() 直接加载 ESM
    cached = require('./page-utils.mjs');
  } catch (err) {
    throw new Error(
      '无法加载 adapters/page-utils.mjs。' +
      '若报 "Unexpected token \'export\'"，说明当前 Node 版本不支持 require(ESM)，' +
      '请升级到 Node 20.19+ / 22+。原始错误：' + (err && err.message)
    );
  }
  return cached;
}

module.exports = {
  get buildPageUtils() {
    return load().buildPageUtils;
  }
};
