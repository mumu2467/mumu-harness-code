/**
 * ============================================================================
 *  adapters/kimi.js —— Kimi 适配器
 * ----------------------------------------------------------------------------
 *  差异全部在 adapters/site-config.js 的 kimi 配置里。
 *  Kimi 域名迁移过：kimi.moonshot.cn → www.kimi.com，
 *  配置里保留了 fallbackUrls，加载失败时界面会提供"换个域名重试"。
 * ============================================================================
 */

'use strict';

const { createAdapter } = require('./base');
const { getSiteConfig } = require('./site-config');

const SITE_ID = 'kimi';

function createKimiAdapter(hooks) {
  const site = getSiteConfig(SITE_ID);
  const adapter = createAdapter(site, hooks);
  adapter.adapterFile = 'adapters/kimi.js';
  return adapter;
}

module.exports = { createKimiAdapter, SITE_ID };
