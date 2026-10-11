/**
 * ============================================================================
 *  preload.js —— 渲染进程的"能力白名单"
 * ----------------------------------------------------------------------------
 *  渲染进程（renderer/renderer.js）运行在 contextIsolation: true 的环境里，
 *  拿不到 Node / Electron 原生模块。所有"网页内做不到"的事情都通过这里
 *  转成 ipcRenderer.invoke，暴露成 window.dsh / window.arena 上的方法。
 *
 *  暴露的接口（renderer 里用 window.arena.xxx 调用）：
 *    appInfo()                              应用与站点信息
 *    clipboardWriteText(text)               写系统剪贴板（文本）
 *    clipboardWriteImage(dataUrl)           写系统剪贴板（图片）—— 方案 A 第一步
 *    sendPaste(webContentsId)               真实 Ctrl+V / Cmd+V —— 方案 A 第二步
 *    sendEnter(webContentsId)               真实 Enter（keyDown/char/keyUp + insertText）
 *    focusWebview(webContentsId)            让某个 webview 拿焦点
 *    insertTextCDP(webContentsId, text)     CDP Input.insertText
 *    setFileInputFiles(id, selectors, file) CDP 往 input[type=file] 塞文件 —— 方案 C
 *    writeTempImage(siteId, idx, dataUrl)   把图片落盘成临时文件（方案 C 需要真实路径）
 *    clearTempImages()                      清理临时图片
 *    openExternal(url)                      用系统浏览器打开链接
 *    webContentsInfo(webContentsId)         调试信息
 * ============================================================================
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const arena = {
  /* ------------------ 应用信息 ------------------ */
  appInfo: () => ipcRenderer.invoke('app:info'),

  /* ------------------ 剪贴板 ------------------ */
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  clipboardWriteImage: (dataUrl) => ipcRenderer.invoke('clipboard:writeImage', dataUrl),

  /* ------------------ 模拟真实输入 ------------------ */
  sendPaste: (webContentsId) => ipcRenderer.invoke('input:paste', webContentsId),
  sendEnter: (webContentsId) => ipcRenderer.invoke('input:enter', webContentsId),
  /** 真实全选（Ctrl+A / Cmd+A）：清空顽固编辑器时用 */
  sendCtrlA: (webContentsId) => ipcRenderer.invoke('input:selectAll', webContentsId),
  /** 真实按键（如 Backspace）：清空顽固编辑器时用 */
  sendKey: (webContentsId, keyCode) => ipcRenderer.invoke('input:key', webContentsId, keyCode),
  /** 真实鼠标点击（坐标）：用于打开只认真实交互的下拉菜单 */
  clickAt: (webContentsId, x, y) => ipcRenderer.invoke('input:clickAt', webContentsId, x, y),
  focusWebview: (webContentsId) => ipcRenderer.invoke('input:focus', webContentsId),

  /* ------------------ CDP ------------------ */
  insertTextCDP: (webContentsId, text) => ipcRenderer.invoke('cdp:insertText', webContentsId, text),
  /** 用 CDP Runtime.evaluate 执行脚本（备用通道，能带回真实异常文本） */
  evaluateCDP: (webContentsId, expression) => ipcRenderer.invoke('cdp:evaluate', webContentsId, expression),
  setFileInputFiles: (webContentsId, selectorList, filePath) =>
    ipcRenderer.invoke('cdp:setFileInputFiles', webContentsId, selectorList, filePath),

  /* ------------------ 临时文件 ------------------ */
  writeTempImage: (siteId, index, dataUrl) =>
    ipcRenderer.invoke('fs:writeTempImage', siteId, index, dataUrl),
  clearTempImages: () => ipcRenderer.invoke('fs:clearTempImages'),

  /* ------------------ 其他 ------------------ */
  /** 打开「聊天助手」独立窗口 */
  openChatWindow: () => ipcRenderer.invoke('window:openChat'),
  /** 清空某个站点的登录态（cookie + localStorage 等） */
  clearPartition: (partition) => ipcRenderer.invoke('session:clearPartition', partition),

  /** 自检模式：把报告写盘并让应用退出 */
  submitSelftestReport: (report) => ipcRenderer.invoke('selftest:report', report),

  /** 调试：把一段文本落盘（排查注入脚本问题时用） */
  dumpText: (name, text) => ipcRenderer.invoke('debug:dumpText', name, text),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  webContentsInfo: (webContentsId) => ipcRenderer.invoke('debug:webContentsInfo', webContentsId)
};

// 主入口对象
contextBridge.exposeInMainWorld('arena', arena);

// 兼容别名（部分示例代码里叫 dsh）
contextBridge.exposeInMainWorld('dsh', arena);

// 只读平台信息，方便渲染进程做快捷键文案（mac 显示 ⌘V）
contextBridge.exposeInMainWorld('arenaEnv', {
  platform: process.platform,
  isMac: process.platform === 'darwin'
});
