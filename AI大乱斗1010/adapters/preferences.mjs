/**
 * ============================================================================
 *  adapters/preferences.mjs —— 各站点"最佳模型 / 最佳推理强度"的偏好配置
 * ----------------------------------------------------------------------------
 *  本文件是标准 ES Module（.mjs），只被渲染进程（Chromium）使用：
 *      import { getPreferences, pickBest } from './preferences.mjs'
 *  属于浏览器侧配置数据，主进程用不到，所以没有像 page-utils / base 那样
 *  额外做 CommonJS 桥接。
 *  ⚠ 别改回 .js 纯 CommonJS：Chromium 不认 CommonJS 的默认导出，界面会直接白屏。
 *
 *  在"开战"发送之前，应用会先按这里的配置把每个站点切到最好的模型与推理档位
 *  （工具栏的「最佳模型」开关控制，默认开启）。
 *
 *  每一项都写成"多候选 + 关键词匹配"，站点改版时只要改这里的文字即可：
 *    model：模型 / 模式选择
 *      - trigger       : 打开模型下拉的元素（多候选）
 *      - currentText   : 用来读"当前选中的是哪个"（多候选）
 *      - prefer        : 关心的目标选项，按 order 决定优先级
 *      - avoid         : 明确不要的选项（比如"快速"这种降级档）
 *    effort：推理强度（有的站点是独立档位，比如 Kimi 的 标准/进阶/极致）
 *      - trigger / currentText / prefer
 *    toggle：开关式（DeepSeek 的"深度思考"就是这种）
 *      - selector      : 开关元素
 *      - selectedClass : 什么类名代表"已开启"
 *
 *  ⚠ 只做"展示层设置"，不涉及任何绕过风控的行为。
 * ============================================================================
 */

'use strict';

/** 三个站点的偏好 */
const SITE_PREFERENCES = {
  /* ------------------------------------------------------------------ 豆包 */
  doubao: {
    // 实测菜单项：豆包 / 快速 / 豆包 2.1 Turbo 专家  —— 带"专家"的最强
    model: {
      trigger: [
        '[data-testid="chat_input_action_model"]',
        '[data-testid*="action_model"]',
        'button[aria-haspopup="menu"][class*="model" i]'
      ],
      currentText: [
        '[data-testid="chat_input_action_model"]',
        '[data-testid*="action_model"]'
      ],
      // 从上到下就是优先级：专家 > 2.1 > 不挑选
      prefer: [
        { order: 1, match: (t) => /专家/.test(t), label: '带「专家」的档位' },
        { order: 2, match: (t) => /2\.1/.test(t) && !/快速/.test(t), label: '2.1 系列' }
      ],
      avoid: [/快速/, /立即/]
    }
  },

  /* -------------------------------------------------------------- DeepSeek */
  deepseek: {
    // 实测："深度思考"是一个 toggle（类名带 --selected 表示已开启，aria-pressed 同步）
    toggle: {
      selector: [
        '[class*="ds-toggle-button"]',
        'div[aria-pressed][class*="toggle-button"]'
      ],
      selectedClass: 'selected',
      label: '深度思考'
    },
    // DeepSeek 目前没有公开的"模型档位"可选，只有深度思考开关
    model: null,
    effort: null
  },

  /* ------------------------------------------------------------------ Kimi */
  kimi: {
    // 实测菜单：K3（旗舰，默认已选）/ K2.8 Preview / 快速
    model: {
      trigger: [
        '[data-testid="model-select-trigger"]',
        '[data-testid*="model-select"]'
      ],
      currentText: [
        '[data-testid="model-select-trigger"] .model-name',
        '[data-testid="model-select-trigger"]'
      ],
      prefer: [
        { order: 1, match: (t) => /\bK3\b/.test(t), label: 'K3 旗舰' },
        { order: 2, match: (t) => /K2\.8/.test(t), label: 'K2.8 Preview' }
      ],
      avoid: [/快速/]
    },
    // 实测子菜单：标准 / 进阶 / 极致   —— 要最好的就选"极致"
    // insideModelMenu: 这个入口在"模型菜单"里面，必须先打开模型菜单才能点到
    effort: {
      insideModelMenu: true,
      trigger: ['[data-testid="model-effort-item"]'],
      currentText: ['[data-testid="model-effort-item"] .effort-value'],
      optionSelector: '[data-testid="model-effort-option"]',
      prefer: [
        { order: 1, match: (t) => /极致/.test(t), label: '极致' },
        { order: 2, match: (t) => /进阶/.test(t), label: '进阶' }
      ],
      avoid: [/标准/]
    }
  }
};

/** 取某站点的偏好（没有就返回 null） */
function getPreferences(siteId) {
  return SITE_PREFERENCES[siteId] || null;
}

/**
 * 按偏好挑选最好的选项。
 * @param {string[]} options 页面上读到的选项文字
 * @param {object} pref      { prefer, avoid }
 * @returns {{index:number, text:string, label:string}|null}
 */
function pickBest(options, pref) {
  if (!options || !options.length || !pref) return null;
  const avoid = pref.avoid || [];
  const list = options.map((text, index) => ({ text: String(text || ''), index }))
    .filter((o) => !avoid.some((re) => re.test(o.text)));
  if (!list.length) return null;

  const rules = (pref.prefer || []).slice().sort((a, b) => a.order - b.order);
  for (const rule of rules) {
    const hit = list.find((o) => {
      try { return rule.match(o.text); } catch (e) { return false; }
    });
    if (hit) return { ...hit, label: rule.label };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 导出（标准 ESM —— 只给渲染进程用）                                          */
/* -------------------------------------------------------------------------- */

export { SITE_PREFERENCES, getPreferences, pickBest };
