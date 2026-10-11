/**
 * ============================================================================
 *  adapters/site-config.js
 * ----------------------------------------------------------------------------
 *  三个站点的静态配置：地址、partition、登录提示、以及【选择器配置】。
 *
 *  ★★★ 这份文件就是"选择器集中配置区" ★★★
 *  站点改版导致选择器失效时，只需要改这个文件里的数组，
 *  每个字段都是"多候选数组"，适配器会从左到右依次尝试，命中即用。
 *
 *  调试方法：
 *    1. 应用里按 Ctrl+Shift+D 打开"选择器调试模式"，再点"调试探测"，
 *       日志区会打印实际命中的选择器；
 *    2. 或者在某一栏里按 F12 打开 DevTools，手动 copy selector。
 * ============================================================================
 */

'use strict';

/**
 * 三个站点的 User-Agent 伪装。
 * 目的：让网页认为自己是普通 Chrome，而不是 Electron（很多站点对 Electron 降级/拦截）。
 * 这里用的是"去掉 Electron 标记"的 Chrome UA，Chrome 版本号跟随内核。
 */
const CHROME_MAJOR = process.versions.chrome ? process.versions.chrome.split('.')[0] : '128';

const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

function userAgentFor(site) {
  // 个别站点需要特殊 UA 时在这里覆盖
  if (site && site.userAgent) return site.userAgent;
  return CHROME_UA;
}

/* -------------------------------------------------------------------------- */
/* 站点 1：豆包                                                                */
/* -------------------------------------------------------------------------- */
const doubao = {
  id: 'doubao',
  name: '豆包',
  color: '#3b82f6',
  url: 'https://www.doubao.com/chat/',
  /** 登录态持久化分区（persist: 前缀 = 落盘，重启仍在） */
  partition: 'persist:doubao',
  loginHint: '请用抖音/手机号扫码登录豆包；若出现滑块验证码，请手动处理。',

  /**
   * 输入框候选：
   *  - 豆包是 ProseMirror/Tiptap 系 contenteditable
   *  - 老版本可能是 textarea
   */
  inputSelector: [
    'div[contenteditable="true"][data-testid="chat_input_input"]',
    'div[contenteditable="true"][data-testid*="chat_input"]',
    'textarea[data-testid="chat_input_input"]',
    '.semi-input-textarea textarea',
    'div[contenteditable="true"]',
    'textarea'
  ],

  /** 发送按钮候选 */
  sendButtonSelector: [
    'button[data-testid="chat_input_send_button"]',
    '#flow-end-msg-send',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    '[data-testid*="send_button"]',
    '.send-btn',
    'button[type="submit"]'
  ],

  /** file input（CDP 塞图用） */
  fileInputSelector: [
    'input[type="file"][accept*="image"]',
    'input[type="file"]'
  ],

  /** 登录成功标志：输入框出现 = 可以打字了 */
  readySelector: [
    'div[contenteditable="true"][data-testid*="chat_input"]',
    'textarea[data-testid*="chat_input"]',
    '.semi-input-textarea textarea',
    'div[contenteditable="true"]'
  ],

  /** 需要登录的标志：登录弹窗 / 二维码容器 */
  loginDetectSelector: [
    '[class*="login-modal"]',
    '[class*="login_container"]',
    '[class*="loginContainer"]',
    '[data-testid*="login"]',
    '[class*="qrcode"]',
    '[class*="qr-code"]',
    'img[src*="qrcode"]',
    'iframe[src*="login"]'
  ],

  /** 二维码本体（用于判断"扫码区已渲染出来"） */
  qrcodeSelector: [
    '[class*="qrcode"] img',
    '[class*="qr-code"] img',
    'img[src*="qrcode"]',
    'canvas[class*="qr"]'
  ],

  /** 登录后的特征元素：头像 / 侧边栏用户区 */
  loggedInSelector: [
    '[data-testid="chat_header_avatar"]',
    '[class*="avatar"] img',
    '[class*="user-info"]',
    '[class*="userInfo"]'
  ],

  /** 出现这些词就认为命中风控/验证码，只提示不处理 */
  riskWords: ['请完成安全验证', '滑块验证', '拖动滑块', '人机验证', '验证码'],
  riskSelector: ['[class*="captcha"]', '[class*="verify"]', '[id*="captcha"]']
};

/* -------------------------------------------------------------------------- */
/* 站点 2：DeepSeek                                                            */
/* -------------------------------------------------------------------------- */
const deepseek = {
  id: 'deepseek',
  name: 'DeepSeek',
  color: '#6366f1',
  url: 'https://chat.deepseek.com/',
  partition: 'persist:deepseek',
  loginHint: '请用手机号+验证码或第三方账号登录 DeepSeek。',

  inputSelector: [
    'textarea#chat-input',
    'textarea[placeholder*="DeepSeek"]',
    'textarea[placeholder*="给 DeepSeek"]',
    'div[contenteditable="true"]',
    'textarea'
  ],

  sendButtonSelector: [
    'div[role="button"][aria-disabled="false"][class*="send"]',
    'div[role="button"][class*="send"]',
    'button[aria-label*="发送"]',
    'button[type="submit"]',
    '[class*="send-btn"]',
    '[class*="_sendButton"]'
  ],

  fileInputSelector: [
    'input[type="file"][accept*="image"]',
    'input[type="file"]'
  ],

  readySelector: [
    'textarea#chat-input',
    'textarea[placeholder*="DeepSeek"]',
    'div[contenteditable="true"]',
    'textarea'
  ],

  loginDetectSelector: [
    '[class*="login"]',
    '[class*="Login"]',
    '[class*="qrcode"]',
    'img[src*="qrcode"]',
    '[class*="ds-modal"]'
  ],

  qrcodeSelector: [
    '[class*="qrcode"] img',
    'img[src*="qrcode"]',
    'canvas[class*="qr"]'
  ],

  loggedInSelector: [
    '[class*="avatar"]',
    '[class*="userInfo"]',
    '[class*="user-info"]',
    'textarea#chat-input'
  ],

  riskWords: ['请完成安全验证', '滑块', '人机验证', '验证码'],
  riskSelector: ['[class*="captcha"]', '[class*="verify"]']
};

/* -------------------------------------------------------------------------- */
/* 站点 3：Kimi                                                                */
/* -------------------------------------------------------------------------- */
const kimi = {
  id: 'kimi',
  name: 'Kimi',
  color: '#10b981',
  // kimi.moonshot.cn 会 302 到 www.kimi.com，两个都保留方便切换
  url: 'https://www.kimi.com/',
  fallbackUrls: ['https://kimi.moonshot.cn/', 'https://kimi.com/'],
  partition: 'persist:kimi',
  loginHint: '请用手机号+短信验证码登录 Kimi（国内版可直接用手机号）。',

  inputSelector: [
    'div[contenteditable="true"][data-testid="msh-chatinput-editor"]',
    '.chat-input-editor[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea'
  ],

  sendButtonSelector: [
    'div[data-testid="msh-chatinput-send-button"]',
    '.send-button',
    'button[aria-label*="发送"]',
    'button[type="submit"]',
    '[class*="send"]'
  ],

  fileInputSelector: [
    'input[type="file"][accept*="image"]',
    'input[type="file"]'
  ],

  readySelector: [
    'div[contenteditable="true"][data-testid="msh-chatinput-editor"]',
    '.chat-input-editor[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea'
  ],

  loginDetectSelector: [
    '[class*="login-modal"]',
    '[class*="loginModal"]',
    '[class*="login-container"]',
    '[class*="qrcode"]',
    'img[src*="qrcode"]',
    'iframe[src*="login"]'
  ],

  qrcodeSelector: [
    '[class*="qrcode"] img',
    'img[src*="qrcode"]',
    'canvas[class*="qr"]'
  ],

  loggedInSelector: [
    '[class*="avatar"]',
    '[data-testid*="avatar"]',
    '[class*="user-info"]',
    '[class*="userInfo"]'
  ],

  riskWords: ['请完成安全验证', '滑块', '人机验证', '验证码'],
  riskSelector: ['[class*="captcha"]', '[class*="verify"]']
};

const SITE_CONFIGS = [doubao, deepseek, kimi];

/** 按 id 取配置 */
function getSiteConfig(id) {
  return SITE_CONFIGS.find((s) => s.id === id) || null;
}

module.exports = {
  SITE_CONFIGS,
  getSiteConfig,
  userAgentFor,
  CHROME_UA
};
