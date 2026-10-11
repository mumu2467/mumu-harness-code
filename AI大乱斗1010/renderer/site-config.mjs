/**
 * ============================================================================
 *  renderer/site-config.mjs —— 渲染进程侧的站点配置（含选择器）
 * ----------------------------------------------------------------------------
 *  ⚠ 这里与 adapters/site-config.js 是【同一份配置的两个副本】：
 *     - adapters/site-config.js  给主进程用（UA、partition、session 策略）
 *     - renderer/site-config.mjs 给渲染进程用（网页注入全部在渲染进程侧发起）
 *  渲染进程跑在 contextIsolation 环境里、且是 ES Module，无法 require 主进程的
 *  CommonJS 配置，所以这里保持一份等价数据。
 *
 *  ★★★ 选择器失效时，这两个文件里的对应数组都要改（顺序一致即可）★★★
 *
 *  每个字段都是多候选数组，从左到右依次尝试，命中即用。
 * ============================================================================
 */

/** 三个站点的渲染侧配置 */
export const SITE_CONFIGS = [
  /* ------------------------------------------------------------------ 豆包 */
  {
    id: 'doubao',
    name: '豆包',
    color: '#3b82f6',
    url: 'https://www.doubao.com/chat/',
    partition: 'persist:doubao',
    loginHint: '请用抖音/手机号扫码登录豆包；如出现滑块验证码请手动处理，程序不会自动绕过。',

    inputSelector: [
      'div[contenteditable="true"][data-testid="chat_input_input"]',
      'div[contenteditable="true"][data-testid*="chat_input"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea[data-testid="chat_input_input"]',
      '.semi-input-textarea textarea',
      'textarea'
    ],
    sendButtonSelector: [
      'button[data-testid="chat_input_send_button"]',
      '[data-testid*="send_button"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      'div[class*="send" i]',
      'button[class*="send" i]',
      '#flow-end-msg-send',
      'button[type="submit"]'
    ],
    // 实测：豆包的文件选择是隐藏 input（上传按钮 data-testid=upload_file_button）
    fileInputSelector: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
    readySelector: [
      'div[contenteditable="true"][data-testid="chat_input_input"]', // ★ 实测外层 composer 就是这个 testid
      'div[contenteditable="true"][data-testid*="chat_input"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    loginDetectSelector: [
      // ★ 实测：未登录时页面上有这个按钮
      'button[data-testid="to_login_button"]',
      'button[data-testid="not_login_about_us"]',
      '[data-testid*="not_login"]',
      '[class*="login-modal"]',
      '[class*="login_container"]',
      '[class*="loginContainer"]',
      'iframe[src*="login"]',
      'img[src*="qrcode"]'
    ],
    qrcodeSelector: ['[class*="qrcode"] img', '[class*="qr-code"] img', 'img[src*="qrcode"]', 'canvas[class*="qr"]'],
    // 用 id/aria-label 精确定位，避免匹配到侧栏里一堆 class 含 avatar 的图标
    loggedInSelector: [
      '[data-testid="chat_header_avatar"]',
      '[class*="avatar"][class*="header"]',
      'img[class*="avatar"]',
      'button[aria-label*="账号"]',
      'button[aria-label*="个人"]'
    ],
    riskWords: ['请完成安全验证', '滑块验证', '拖动滑块', '人机验证', '验证码'],
    riskSelector: ['[class*="captcha"]', '[class*="verify"]', '[id*="captcha"]']
  },

  /* -------------------------------------------------------------- DeepSeek */
  {
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
    fileInputSelector: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
    readySelector: ['textarea#chat-input', 'textarea[placeholder*="DeepSeek"]', 'div[contenteditable="true"]', 'textarea'],
    loginDetectSelector: [
      // ★ 实测：未登录会被重定向到 /sign_in，页面容器是 .ds-sign-in-form-wrapper
      '.ds-sign-in-form-wrapper',
      '[class*="sign-in-form"]',
      '[class*="sign_in"]',
      'input[placeholder*="手机号"]',
      'input[placeholder*="验证码"]',
      '[class*="login"]',
      '[class*="Login"]'
    ],
    qrcodeSelector: [
      '[class*="qrcode"] img',
      'img[src*="qrcode"]',
      'canvas[class*="qr"]',
      // 微信扫码登录是内嵌 iframe
      'iframe[src*="open.weixin.qq.com"]'
    ],
    loggedInSelector: [
      'textarea#chat-input',
      '[class*="avatar"]',
      '[class*="userInfo"]',
      '[class*="user-info"]'
    ],
    riskWords: ['请完成安全验证', '滑块', '人机验证', '验证码'],
    riskSelector: ['[class*="captcha"]', '[class*="verify"]']
  },

  /* ------------------------------------------------------------------ Kimi */
  {
    id: 'kimi',
    name: 'Kimi',
    color: '#10b981',
    url: 'https://www.kimi.com/',
    fallbackUrls: ['https://kimi.moonshot.cn/', 'https://kimi.com/'],
    partition: 'persist:kimi',
    loginHint: '请用手机号+短信验证码登录 Kimi（国内版手机号即可）。',

    inputSelector: [
      // ★ 实测（kimi.com）：输入框就是这个 contenteditable
      'div.chat-input-editor[contenteditable="true"]',
      'div[contenteditable="true"][data-testid="msh-chatinput-editor"]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    sendButtonSelector: [
      // ★ 实测：发送按钮是 .send-button-container，禁用时类名会多一个 disabled
      'div.send-button-container:not(.disabled)',
      'div.send-button-container',
      'div[data-testid="msh-chatinput-send-button"]',
      '.send-button',
      'button[aria-label*="发送"]',
      'button[type="submit"]'
    ],
    // 实测：整页唯一的隐藏 file input（multiple），可用于 CDP 塞图
    fileInputSelector: ['input[type="file"][accept*="image"]', 'input.hidden-input[type="file"]', 'input[type="file"]'],
    readySelector: [
      'div.chat-input-editor[contenteditable="true"]',
      '.chat-input-editor[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    loginDetectSelector: [
      // ★ 实测：未登录时侧边栏有"登录以同步历史会话"和"登录"按钮
      'button.next-sidebar-history-list__login',
      '.login-button-text',
      'button[class*="login" i]',
      '[class*="login-modal"]',
      '[class*="loginModal"]',
      'iframe[src*="login"]'
    ],
    qrcodeSelector: ['[class*="qrcode"] img', 'img[src*="qrcode"]', 'canvas[class*="qr"]'],
    loggedInSelector: [
      // ★ 实测：登录后是 button.user-info-container（侧栏用户区）
      'button.user-info-container',
      'button[class*="user-area"]',
      '[class*="user-info"]',
      '[data-testid*="avatar"]'
    ],
    riskWords: ['请完成安全验证', '滑块', '人机验证', '验证码'],
    riskSelector: ['[class*="captcha"]', '[class*="verify"]']
  }
];

/** 按 id 取配置 */
export function getSiteConfig(id) {
  return SITE_CONFIGS.find((s) => s.id === id) || null;
}
