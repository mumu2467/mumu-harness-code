/**
 * ============================================================================
 *  adapters/doubao.js —— 豆包适配器
 * ----------------------------------------------------------------------------
 *  这个文件本身几乎没有逻辑：豆包的所有差异（选择器、地址、登录提示）
 *  都在 site-config.js 的 doubao 配置里。
 *
 *  如果豆包改版导致失效，请编辑 adapters/site-config.js 里的 doubao 对象，
 *  不要改这里。
 * ============================================================================
 */

'use strict';

const { createAdapter } = require('./base');
const { getSiteConfig } = require('./site-config');

/** 站点 id，与 site-config.js 保持一致 */
const SITE_ID = 'doubao';

/**
 * @param {object} hooks { log(level, message, detail), onState(patch) }
 */
function createDoubaoAdapter(hooks) {
  const site = getSiteConfig(SITE_ID);
  const adapter = createAdapter(site, hooks);
  // 打一个标记，方便排错时确认真实加载的是豆包适配器
  adapter.adapterFile = 'adapters/doubao.js';
  return adapter;
}

module.exports = { createDoubaoAdapter, SITE_ID };
