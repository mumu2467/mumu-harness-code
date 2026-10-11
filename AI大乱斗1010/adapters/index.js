/**
 * ============================================================================
 *  adapters/index.js —— 适配器注册中心
 * ----------------------------------------------------------------------------
 *  渲染进程只需要：
 *      const adapter = ArenaAdapters.create('doubao', hooks);
 *  就能拿到带完整能力的适配器对象。
 *
 *  新增站点：写一个 adapters/xxx.js + site-config.js 里加配置，然后注册到这里。
 * ============================================================================
 */

'use strict';

const { SITE_CONFIGS, getSiteConfig } = require('./site-config');
const { createAdapter } = require('./base');
const { createDoubaoAdapter } = require('./doubao');
const { createDeepseekAdapter } = require('./deepseek');
const { createKimiAdapter } = require('./kimi');

/** id -> 工厂函数 */
const FACTORIES = {
  doubao: createDoubaoAdapter,
  deepseek: createDeepseekAdapter,
  kimi: createKimiAdapter
};

/**
 * 创建某个站点的适配器
 * @param {string} id
 * @param {object} hooks
 */
function create(id, hooks) {
  const factory = FACTORIES[id];
  if (!factory) {
    // 未注册的站点：退回通用适配器（只要有配置就能跑）
    const site = getSiteConfig(id);
    if (!site) throw new Error('未知站点: ' + id);
    return createAdapter(site, hooks);
  }
  return factory(hooks);
}

module.exports = {
  create,
  SITE_CONFIGS,
  getSiteConfig,
  FACTORIES
};
