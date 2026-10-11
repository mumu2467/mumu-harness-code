/**
 * ============================================================================
 *  adapters/deepseek.js —— DeepSeek 适配器
 * ----------------------------------------------------------------------------
 *  差异全部在 adapters/site-config.js 的 deepseek 配置里。
 *  注意：DeepSeek 的发送按钮是 <div role="button">，不是 <button>，
 *  所以 site-config 里给的候选包含 role="button" 与 class 含 send 的元素；
 *  base.js 的 clickSend() 还有"就近猜测"兜底策略。
 * ============================================================================
 */

'use strict';

const { createAdapter } = require('./base');
const { getSiteConfig } = require('./site-config');

const SITE_ID = 'deepseek';

function createDeepseekAdapter(hooks) {
  const site = getSiteConfig(SITE_ID);
  const adapter = createAdapter(site, hooks);
  adapter.adapterFile = 'adapters/deepseek.js';
  return adapter;
}

module.exports = { createDeepseekAdapter, SITE_ID };
