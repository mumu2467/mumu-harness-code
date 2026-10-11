/**
 * ============================================================================
 *  AI 大乱斗 —— Electron 主进程
 * ----------------------------------------------------------------------------
 *  职责：
 *   1. 创建主窗口，并开启 webviewTag（三个站点用 <webview> 内嵌，规避
 *      X-Frame-Options / CSP，绝不能用 iframe）
 *   2. 集中管理"权限/弹窗/下载/证书"等安全与体验策略
 *   3. 为渲染进程提供 webview 无法自己完成的能力：
 *        - 系统剪贴板写入图片（方案 A 粘贴图片）
 *        - sendInputEvent 模拟 Ctrl+V / Enter（真实按键，比 JS 合成事件更可靠）
 *        - CDP(webContents.debugger)：Input.insertText / DOM.setFileInputFiles
 *        - 临时文件写入（CDP 塞文件需要真实磁盘路径）
 *   4. 把三个站点的 partition 统一在 site-config 里定义，保证登录态持久化
 * ============================================================================
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, clipboard, nativeImage, shell, session, Menu } = require('electron');

const { SITE_CONFIGS, userAgentFor } = require('./adapters/site-config');

/** 是否处于自检模式：electron . --selftest （npm run selftest 会带上） */
const SELFTEST = process.argv.includes('--selftest') || process.env.ARENA_SELFTEST === '1';

/** 全局主窗口引用 */
let mainWindow = null;

/** 聊天助手窗口（菜单里打开，独立窗口） */
let chatWindow = null;

/** 每个分区只初始化一次 */
const configuredPartitions = new Set();

/** 临时图片目录（放系统 temp，避免污染项目目录） */
const TEMP_DIR = path.join(os.tmpdir(), 'ai-arena-images');

/* -------------------------------------------------------------------------- */
/* 基础工具                                                                    */
/* -------------------------------------------------------------------------- */

/** 从 dataURL 得到 Buffer */
function dataUrlToBuffer(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  try {
    if (/;base64/i.test(meta)) return Buffer.from(body, 'base64');
    return Buffer.from(decodeURIComponent(body), 'utf8');
  } catch (err) {
    console.error('[main] dataURL 解析失败:', err);
    return null;
  }
}

/** 把 Buffer 转成 nativeImage；失败返回空图 */
function bufferToNativeImage(buffer) {
  try {
    const img = nativeImage.createFromBuffer(buffer);
    return img && !img.isEmpty() ? img : null;
  } catch (err) {
    console.error('[main] 构造 nativeImage 失败:', err);
    return null;
  }
}

/** 简单 sleep */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 给某个 webContents 发送一次"真实"的 Ctrl+V / Cmd+V
 * —— webview 内部页面会收到 isTrusted 的 paste 事件，几乎所有网页都能识别。
 */
async function sendPasteShortcut(contents) {
  if (!contents || contents.isDestroyed()) return { ok: false, error: 'webContents 不存在' };
  const isMac = process.platform === 'darwin';
  const modifier = isMac ? 'meta' : 'control';
  const keyCode = 'V';
  contents.focus();
  await sleep(60);
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [modifier] });
  await sleep(30);
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [modifier] });
  return { ok: true };
}

/**
 * 发送一次 Enter。
 * 分两段：
 *   1) insertText('\r') —— 让 React/受控组件收到真实的 beforeinput/input 事件；
 *   2) 真实 keyDown/char/keyUp —— 让绑定了 keydown 的站点（Kimi 等）生效。
 * 只做其中一种都可能被某些站点忽略，所以两种一起上。
 */
async function sendEnter(contents) {
  if (!contents || contents.isDestroyed()) return { ok: false, error: 'webContents 不存在' };
  contents.focus();
  await sleep(50);

  // 第一段：真实按键（keyDown + char + keyUp）
  try {
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    contents.sendInputEvent({ type: 'char', keyCode: '\r' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  } catch (err) {
    console.warn('[main] sendInputEvent Enter 失败:', err && err.message);
  }

  // 第二段：CDP 的 Input.insertText，触发受控组件的 input 流程
  await sleep(80);
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Input.insertText', { text: '\r' });
  } catch (err) {
    // 某些站点在 insertText 时会触发换行而不是发送，这里静默失败即可，由适配器兜底
    console.warn('[main] Input.insertText(\\r) 失败:', err && err.message);
  }
  return { ok: true };
}

/**
 * 给某个 webContents 发送真实的全选快捷键（Ctrl+A / Cmd+A）。
 * 用途：有些编辑器（如 Kimi 的 Lexical）只在"真实按键"下才触发自己的删除流程，
 * 用 page 里的 document.execCommand 清不掉内容。
 */
async function sendSelectAll(contents) {
  if (!contents || contents.isDestroyed()) return { ok: false, error: 'webContents 不存在' };
  const modifier = process.platform === 'darwin' ? 'meta' : 'control';
  contents.focus();
  await sleep(60);
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [modifier] });
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [modifier] });
  return { ok: true };
}

/** 发送一个真实按键（keyDown + char + keyUp），用于 Backspace 这类删除/编辑键 */
async function sendRealKey(contents, keyCode) {
  if (!contents || contents.isDestroyed()) return { ok: false, error: 'webContents 不存在' };
  contents.focus();
  await sleep(50);
  contents.sendInputEvent({ type: 'keyDown', keyCode });
  // Backspace 的 char 用 \b，其余按需给 \r
  contents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Backspace' ? '\b' : keyCode });
  contents.sendInputEvent({ type: 'keyUp', keyCode });
  return { ok: true };
}

/**
 * 在指定坐标发一次【真实】鼠标左键点击（CDP Input.dispatchMouseEvent）。
 *
 * 为什么需要它：豆包用的是 Radix 下拉菜单，只认真实指针交互 ——
 * 页面内 element.click() 合成的 MouseEvent 不一定能把菜单弹出来。
 * 坐标由页面侧用 getBoundingClientRect() 算好后传进来。
 */
async function sendRealClick(contents, x, y) {
  if (!contents || contents.isDestroyed()) return { ok: false, error: 'webContents 不存在' };
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    const px = Math.round(Number(x) || 0);
    const py = Math.round(Number(y) || 0);
    // 先把鼠标移过去，再按下抬起 —— 有些实现依赖 mousemove 建立 hover 状态
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none' });
    await sleep(40);
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(50);
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
    return { ok: true, x: px, y: py };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

/** 把 webContentsId 解析成 webContents 对象 */
function resolveWebContents(id) {
  const { webContents } = require('electron');
  if (id === undefined || id === null) return null;
  const wc = webContents.fromId(Number(id));
  if (!wc || wc.isDestroyed()) return null;
  return wc;
}

/* -------------------------------------------------------------------------- */
/* webContents 安全护栏                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 给所有 webContents（含三个 webview）装护栏：
 *   1. window.open / target=_blank 一律不在应用内开新窗口，改用系统浏览器
 *   2. webview 的 webPreferences 强制安全：不允许渲染进程里开 Node、不允许改 preload
 *   3. 主框架禁止被站点导航到非 http(s) 协议（file:// 等）
 */
function installWebContentsGuards() {
  app.on('web-contents-created', (_event, contents) => {
    // 1) 新窗口一律外部打开
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    // 2) 拦截 webview 的创建参数，防止页面里的 <webview> 拿更高权限
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      delete webPreferences.preloadURL;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      if (!/^https?:\/\//i.test(params.src || '')) {
        event.preventDefault();
        console.warn('[main] 已拦截非 http(s) 的 webview 地址:', params.src);
      }
    });

    // 3) 只允许 http(s) 导航；其余协议（file:// / 自定义协议）直接阻断
    contents.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url) && !url.startsWith('devtools://')) {
        event.preventDefault();
        console.warn('[main] 已拦截导航:', url);
      }
    });
  });
}

/* -------------------------------------------------------------------------- */
/* 应用菜单                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 菜单栏：主要提供「聊天助手」入口（独立窗口）。
 * 用 autoHideMenuBar 的默认隐藏行为，按 Alt 就能看到。
 */
function buildAppMenu() {
  const template = [
    {
      label: '窗口',
      submenu: [
        {
          label: '聊天助手（独立窗口）',
          accelerator: 'CommandOrControl+Shift+C',
          // 菜单栏默认是隐藏的（autoHideMenuBar），隐藏状态下注册的
          // accelerator 不一定生效，所以关掉自动注册，改由下面的
          // before-input-event 手动转发同款快捷键。
          registerAccelerator: false,
          click: () => openChatWindow()
        },
        { type: 'separator' },
        {
          label: '对战三栏',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.focus();
            } else {
              createWindow();
            }
          }
        },
        {
          label: '重新加载当前窗口',
          accelerator: 'CommandOrControl+R',
          click: (_item, win) => { if (win && !win.isDestroyed()) win.reload(); }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '查看日志文件',
          click: () => {
            const logFile = path.join(os.homedir(), '.ai-arena', 'launch.log');
            if (fs.existsSync(logFile)) shell.showItemInFolder(logFile);
          }
        },
        {
          label: '打开项目说明（README）',
          click: () => shell.openPath(path.join(__dirname, 'README.md'))
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* -------------------------------------------------------------------------- */
/* 窗口                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 创建主窗口（对战三栏）。
 * @param {boolean} chatOnly 聊天助手窗口：只显示聊天问答页，且不加载三栏视图
 */
function createChatWindow() {
  console.log('[main] 正在创建「聊天助手」窗口…');
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'AI 聊天助手',
    backgroundColor: '#f7f7f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true, // 聊天窗口同样需要内嵌三个站点（在后台取回答）
      spellcheck: false
    }
  });

  // #chat 让界面只渲染聊天问答页（隐藏对战三栏）
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { hash: 'chat' });

  win.webContents.on('did-finish-load', () => {
    console.log('[main] 聊天助手界面加载完成');
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] 聊天助手界面加载失败：${desc}（code ${code}）${url || ''}`);
  });

  // 允许 F12 调试
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  chatWindow = win;
  win.on('closed', () => { chatWindow = null; });
  return win;
}

/** 打开聊天助手窗口（已开则只聚焦） */
function openChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (chatWindow.isMinimized()) chatWindow.restore();
    chatWindow.focus();
    return chatWindow;
  }
  return createChatWindow();
}

function createWindow() {
  console.log('[main] 正在创建主窗口…');
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1100,
    minHeight: 660,
    title: 'AI 大乱斗',
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // 渲染进程不能直接用 Node，全部走 preload 白名单
      nodeIntegration: false,
      sandbox: false, // preload 里需要 require('electron') 的部分能力
      webviewTag: true, // ★ 关键：必须开启，否则 <webview> 无法使用
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 启动可见性日志：出问题时光看控制台就能判断卡在哪一步
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] 界面加载完成（renderer/index.html）');
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] 界面加载失败：${desc}（code ${code}）${url || ''}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] 界面渲染进程崩溃:', details);
  });
  mainWindow.webContents.on('console-message', (...args) => {
    // Electron 32+ 传的是事件对象，旧版本传 (event, level, message, line, sourceId)，两种都兼容
    let level = 0;
    let message = '';
    let line = 0;
    let sourceId = '';
    const first = args[0];
    if (first && typeof first === 'object' && 'message' in first) {
      level = Number(first.level) || 0;
      message = String(first.message || '');
      line = Number(first.lineNumber) || 0;
      sourceId = String(first.sourceId || '');
    } else {
      level = Number(args[1]) || 0;
      message = String(args[2] || '');
      line = Number(args[3]) || 0;
      sourceId = String(args[4] || '');
    }
    if (level >= 2) {
      console.error(`[renderer] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 允许 F12 打开宿主窗口的调试器（方便看注入脚本报错）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
    // 菜单栏默认隐藏时 accelerator 不可靠，这里手动转发「聊天助手」快捷键
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'c' && input.control && input.shift) {
      openChatWindow();
      event.preventDefault();
    }
  });

  // 宿主页面本身不允许跳转到外部地址
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

/* -------------------------------------------------------------------------- */
/* session（partition）策略                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 每个站点一个独立 partition：persist:doubao / persist:deepseek / persist:kimi
 * —— cookie/localStorage/IndexedDB 完全隔离，且落盘，重启后登录态仍在。
 */
function setupAllPartitions() {
  SITE_CONFIGS.forEach((site) => {
    if (configuredPartitions.has(site.partition)) return;
    configuredPartitions.add(site.partition);

    const ses = session.fromPartition(site.partition);

    // 1) 全面伪装成普通 Chrome：很多站点会检测 Electron UA
    ses.setUserAgent(userAgentFor(site));

    // 2) 权限：只放行麦克风/摄像头/通知/剪贴板读取；地理位置、MIDI 等一律拒绝
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      const allow = [
        'media',
        'audioCapture',
        'videoCapture',
        'notifications',
        'clipboard-read',
        'clipboard-sanitized-write',
        'fullscreen'
      ].includes(permission);
      callback(allow);
    });

    // 3) 站点里 window.open 的外链交给系统浏览器处理。
    //    注意：弹窗拦截有两种 API，不同 Electron 版本支持情况不同 ——
    //      - session.setWindowOpenHandler：较新版本才有
    //      - app.on('web-contents-created') 里对每个 webContents 调用 setWindowOpenHandler：一直可用
    //    这里做能力探测，谁在就用谁，避免"某个版本没有这个方法"直接抛异常打断启动。
    if (typeof ses.setWindowOpenHandler === 'function') {
      ses.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
      });
    } else {
      console.log('[main] 当前 Electron 版本没有 session.setWindowOpenHandler，弹窗拦截改由 web-contents-created 统一处理');
    }

    // 4) 忽略证书错误（企业代理/内网环境常见），保证页面能打开
    ses.setCertificateVerifyProc((request, callback) => callback(0));

    // 5) 允许第三方 Cookie —— 这三个站点都依赖它做登录校验
    ses.cookies.on('changed', () => {});
  });
}

/* -------------------------------------------------------------------------- */
/* CDP 相关（方案 C：往 input[type=file] 塞文件）                              */
/* -------------------------------------------------------------------------- */

/**
 * 保证 debugger 已附着。attach 只允许一次，重复 attach 会抛错，这里吞掉。
 */
async function ensureDebuggerAttached(contents) {
  if (!contents.debugger.isAttached()) {
    contents.debugger.attach('1.3');
    // 主框架 + 子框架都要能取到节点
    await contents.debugger.sendCommand('DOM.enable');
    await contents.debugger.sendCommand('DOM.getDocument', { depth: 1, pierce: true });
  }
}

/**
 * 在页面里找到 <input type=file> 并把磁盘文件塞进去。
 * 这是"图片注入"里兼容性最好的一种（浏览器层面直接给文件，不依赖 AI 合成事件）。
 *
 * 实现要点：
 *   - 页面可能把 composer 放进 iframe，因此除了主框架，还要遍历各个执行上下文
 *     （Runtime.executionContextCreated）分别去找。
 *   - 命中后补发 input/change，兼顾监听 change 的自研上传组件。
 */
async function cdpSetFileInputFiles(contents, selectorList, filePath) {
  await ensureDebuggerAttached(contents);

  const candidates = Array.isArray(selectorList) && selectorList.length
    ? selectorList
    : ['input[type="file"]'];

  /* 1) 收集执行上下文（主框架 + 各 iframe） */
  const contextIds = [];
  const onContextCreated = (event, method) => {
    if (method === 'Runtime.executionContextCreated' && event && event.context) {
      const id = event.context.id;
      if (Number.isFinite(id) && !contextIds.includes(id)) contextIds.push(id);
    }
  };
  contents.debugger.on('message', onContextCreated);

  try {
    await contents.debugger.sendCommand('Runtime.enable');
    await sleep(120); // 等一会儿，让内核把已有的上下文事件发过来
  } catch (err) {
    console.warn('[main] Runtime.enable 失败（继续用主框架尝试）:', err && err.message);
  }

  if (!contextIds.length) contextIds.push(null); // null = 不指定上下文（默认主框架）

  /* 2) 逐上下文、逐选择器找 file input */
  const errors = [];
  const tried = new Set();

  /** 用 CDP 找节点 -> 塞文件 -> 补事件 */
  async function trySelector(selector, executionContextId) {
    const doc = await contents.debugger.sendCommand(
      'DOM.getDocument',
      { depth: -1, pierce: true },
      executionContextId || undefined
    );
    if (!doc || !doc.root) return null;
    const found = await contents.debugger.sendCommand(
      'DOM.querySelectorAll',
      { nodeId: doc.root.nodeId, selector },
      executionContextId || undefined
    );
    if (!found || !found.nodeIds || !found.nodeIds.length) return null;

    for (const nodeId of found.nodeIds) {
      if (tried.has(nodeId)) continue;
      tried.add(nodeId);
      try {
        await contents.debugger.sendCommand(
          'DOM.setFileInputFiles',
          { files: [filePath], nodeId },
          executionContextId || undefined
        );
        return { ok: true, selector, nodeId };
      } catch (err) {
        errors.push(`node ${nodeId} => ${err && err.message}`);
      }
    }
    return null;
  }

  try {
    for (const contextId of contextIds) {
      for (const selector of candidates) {
        try {
          const hit = await trySelector(selector, contextId);
          if (hit) {
            // 3) 补发 input/change（部分框架监听 change）
            await contents.executeJavaScript(
              `(() => { try {
                  const list = document.querySelectorAll(${JSON.stringify(selector)});
                  for (const el of list) {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                  return list.length;
                } catch (e) { return -1; } })()`,
              true
            ).catch(() => {});
            return { ...hit, contextId: contextId === null ? 'main' : contextId };
          }
        } catch (err) {
          errors.push(`${selector}@${contextId === null ? 'main' : contextId} => ${err && err.message}`);
        }
      }
    }
  } finally {
    try { contents.debugger.removeListener('message', onContextCreated); } catch (e) { /* 忽略 */ }
  }

  return { ok: false, error: errors.slice(0, 4).join(' | ') || '没有匹配的 file input' };
}

/* -------------------------------------------------------------------------- */
/* IPC —— 渲染进程能调用的全部能力（与 preload.js 一一对应）                    */
/* -------------------------------------------------------------------------- */

function registerIpcHandlers() {
  /* ---------------- 应用信息 ---------------- */
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    tempDir: TEMP_DIR,
    /** 自检模式标记：渲染进程据此在启动后自动跑一轮探测并回传报告 */
    selftest: SELFTEST,
    /** 自检报告落盘路径 */
    selftestReport: path.join(__dirname, 'selftest-report.json'),
    /** webview 的 preload 必须用 file:// URL 形式（用于同步滚动回传） */
    webviewPreload: pathToFileURL(path.join(__dirname, 'webview-preload.js')).toString(),
    sites: SITE_CONFIGS.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      partition: s.partition,
      color: s.color,
      loginHint: s.loginHint
    }))
  }));

  /* ---------------- 剪贴板：写入文本 ---------------- */
  ipcMain.handle('clipboard:writeText', (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });

  /* ---------------- 剪贴板：写入图片（dataURL） ---------------- */
  ipcMain.handle('clipboard:writeImage', (_e, dataUrl) => {
    const buf = dataUrlToBuffer(dataUrl);
    if (!buf) return { ok: false, error: '图片数据无法解析' };
    const img = bufferToNativeImage(buf);
    if (!img) return { ok: false, error: '图片格式不被 Electron 支持' };
    clipboard.writeImage(img);
    const size = img.getSize();
    return { ok: true, size, bytes: buf.length };
  });

  /* ---------------- 模拟真实按键：Ctrl+V / Cmd+V ---------------- */
  ipcMain.handle('input:paste', async (_e, webContentsId) => {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: '目标 webview 不存在' };
    return sendPasteShortcut(wc);
  });

  /* ---------------- 模拟真实按键：Enter ---------------- */
  ipcMain.handle('input:enter', async (_e, webContentsId) => {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: '目标 webview 不存在' };
    return sendEnter(wc);
  });

  /* ---------------- 模拟真实按键：Ctrl+A 全选 ---------------- */
  ipcMain.handle('input:selectAll', async (_e, webContentsId) => {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: '目标 webview 不存在' };
    return sendSelectAll(wc);
  });

  /* ---------------- 模拟真实按键：任意编辑键（如 Backspace） ---------------- */
  ipcMain.handle('input:key', async (_e, webContentsId, keyCode) => {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: '目标 webview 不存在' };
    return sendRealKey(wc, String(keyCode || 'Backspace'));
  });

  /* ---------------- 真实鼠标点击（坐标）—— Radix 弹层兜底 ---------------- */
  ipcMain.handle('input:clickAt', async (_e, webContentsId, x, y) => {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: '目标 webview 不存在' };
    return sendRealClick(wc, x, y);
  });

  /* ---------------- 让 webview 获得焦点 ---------------- */
  ipcMain.handle('input:focus', (_e, webContentsId) => {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: '目标 webview 不存在' };
    wc.focus();
    return { ok: true };
  });

  /* ---------------- CDP：Input.insertText（比 execCommand 更"真"） ---------------- */
  ipcMain.handle('cdp:insertText', async (_e, webContentsId, text) => {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: '目标 webview 不存在' };
    try {
      await ensureDebuggerAttached(wc);
      await wc.debugger.sendCommand('Input.insertText', { text: String(text) });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });

  /**
   * CDP Runtime.evaluate —— webview.executeJavaScript 的备用通道。
   *
   * 为什么需要：webview.executeJavaScript 失败时只会给一句笼统的
   * "Script failed to execute, check the renderer console"，拿不到真实异常；
   * 而 Runtime.evaluate 会把 exceptionDetails 原样带回来，便于定位。
   * 用法上先试它，失败再退回 executeJavaScript。
   */
  ipcMain.handle('cdp:evaluate', async (_e, webContentsId, expression) => {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: '目标 webview 不存在' };
    try {
      await ensureDebuggerAttached(wc);
      const res = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: String(expression),
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
      });
      if (res && res.exceptionDetails) {
        const ex = res.exceptionDetails;
        const desc = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text;
        return { ok: false, error: String(desc), line: ex.lineNumber, column: ex.columnNumber };
      }
      return { ok: true, value: res && res.result ? res.result.value : undefined };
    } catch (err) {
      return { ok: false, error: 'CDP 求值失败：' + (err && err.message) };
    }
  });

  /* ---------------- CDP：往 input[type=file] 塞文件 ---------------- */
  ipcMain.handle('cdp:setFileInputFiles', async (_e, webContentsId, selectorList, filePath) => {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: '目标 webview 不存在' };
    try {
      return await cdpSetFileInputFiles(wc, selectorList, filePath);
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });

  /* ---------------- 临时文件：把图片写到磁盘，供 CDP 使用 ---------------- */
  ipcMain.handle('fs:writeTempImage', (_e, siteId, index, dataUrl) => {
    const buf = dataUrlToBuffer(dataUrl);
    if (!buf) return { ok: false, error: '图片数据无法解析' };
    try {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
      // 从 dataURL 的 mime 推断扩展名
      const mimeMatch = /^data:(image\/[a-z0-9.+-]+)/i.exec(dataUrl || '');
      const mime = mimeMatch ? mimeMatch[1].toLowerCase() : 'image/png';
      const ext = mime.includes('jpeg') || mime.includes('jpg')
        ? '.jpg'
        : mime.includes('webp')
          ? '.webp'
          : mime.includes('gif')
            ? '.gif'
            : '.png';
      const file = path.join(TEMP_DIR, `${siteId}-${Date.now()}-${index}${ext}`);
      fs.writeFileSync(file, buf);
      return { ok: true, file, bytes: buf.length };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });

  /* ---------------- 清理临时目录 ---------------- */
  ipcMain.handle('fs:clearTempImages', () => {
    try {
      if (fs.existsSync(TEMP_DIR)) {
        for (const f of fs.readdirSync(TEMP_DIR)) {
          try {
            fs.unlinkSync(path.join(TEMP_DIR, f));
          } catch (_) { /* 忽略单个文件失败 */ }
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });

  /* ---------------- 自检模式：把报告写到磁盘并退出 ---------------- */
  ipcMain.handle('selftest:report', (_e, report) => {
    const file = path.join(__dirname, 'selftest-report.json');
    try {
      fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
      console.log('[main] 自检报告已写入:', file);
    } catch (err) {
      console.error('[main] 写自检报告失败:', err);
    }
    setTimeout(() => {
      app.quit();
    }, 800);
    return { ok: true, file };
  });

  /* ---------------- 调试：把宿主渲染进程传下来的文本落盘 ----------------
   * 用途：注入脚本在页面里报语法错误时，把"真正执行的脚本"写出来核对，
   * 因为 webview 的报错信息太笼统、也没法在页面里 eval 自检（CSP 限制）。
   */
  ipcMain.handle('debug:dumpText', (_e, name, text) => {
    try {
      const dir = path.join(os.tmpdir(), 'ai-arena-debug');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, String(name || 'dump') + '.txt');
      fs.writeFileSync(file, String(text == null ? '' : text), 'utf8');
      console.log('[main] 调试文本已写入:', file);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });

  /* ---------------- 清空某个站点的登录态（cookie + 本地存储） ---------------- */
  ipcMain.handle('session:clearPartition', async (_e, partition) => {
    // 只允许清我们配置里的那几个分区，避免误清其他分区
    const site = SITE_CONFIGS.find((s) => s.partition === partition);
    if (!site) return { ok: false, error: '未知分区: ' + partition };
    try {
      const ses = session.fromPartition(partition);
      await ses.clearStorageData({
        storages: [
          'cookies',
          'localstorage',
          'indexdb',
          'cachestorage',
          'serviceworkers',
          'websql',
          'shadercache'
        ]
      });
      await ses.clearCache();
      // 清完顺带更新一次 UA 设置，保证 session 仍处于我们期望的状态
      ses.setUserAgent(userAgentFor(site));
      return { ok: true, partition };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });

  /* ---------------- 打开聊天助手窗口（独立窗口） ---------------- */
  ipcMain.handle('window:openChat', () => {
    try {
      openChatWindow();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  });

  /* ---------------- 打开外部浏览器 ---------------- */
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:/i.test(url)) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, error: '非法 URL' };
  });

  /* ---------------- 读取 webview 的 userAgent（调试用） ---------------- */
  ipcMain.handle('debug:webContentsInfo', (_e, webContentsId) => {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return { ok: false, error: '目标 webview 不存在' };
    return {
      ok: true,
      id: wc.id,
      url: wc.getURL(),
      userAgent: wc.getUserAgent(),
      debuggerAttached: wc.debugger.isAttached()
    };
  });
}

/* -------------------------------------------------------------------------- */
/* 应用生命周期                                                                */
/* -------------------------------------------------------------------------- */

// 单实例：避免开两份导致 partition 锁冲突
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // 启动阶段任何一步失败都要能看到原因，不能静默退出
    try {
      setupAllPartitions();
    } catch (err) {
      console.error('[main] session 初始化失败（继续启动，部分站点可能异常）:', err);
    }
    registerIpcHandlers();
    buildAppMenu(); // 菜单里有「聊天助手（独立窗口）」入口
    installWebContentsGuards();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // 全局兜底：任何未捕获异常只打日志，不让进程崩掉
  process.on('uncaughtException', (err) => {
    console.error('[main] uncaughtException:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[main] unhandledRejection:', err);
  });
}
