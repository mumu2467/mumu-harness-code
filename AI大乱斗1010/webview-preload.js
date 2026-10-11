/**
 * ============================================================================
 *  webview-preload.js —— 注入到【每个站点网页】里的 preload 脚本
 * ----------------------------------------------------------------------------
 *  它跑在网页的隔离世界（isolated world）里，和站点自身的 JS 互不干扰，
 *  主要用于：
 *    1. 给网页提供 window.arena.syncScroll(ratio)，让"同步滚动"能把
 *       滚动比例回传给宿主界面（通过 ipcRenderer.sendToHost）。
 *    2. 兜底暴露一个极小的 window.arena 占位对象，防止某些站点页面
 *       因为访问 window.arena 报未定义错误。
 *
 *  注意：这里【不做任何自动化】——文本/图片注入与点击全部由宿主渲染进程通过
 *  webview.executeJavaScript() 发起，逻辑集中在 adapters/ 里，便于统一维护。
 * ============================================================================
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 把滚动比例发给宿主（宿主渲染进程监听 webview 的 'ipc-message' 事件） */
function sendScroll(ratio) {
  try {
    const value = Number.isFinite(Number(ratio)) ? Number(ratio) : 0;
    ipcRenderer.sendToHost('arena-scroll', value);
  } catch (err) {
    // 宿主已经关闭该栏时忽略
  }
}

/** 网页可见的小工具对象 */
contextBridge.exposeInMainWorld('arena', {
  /** 同步滚动用：把当前滚动比例发回宿主 */
  syncScroll: sendScroll,
  /** 版本标记，方便排查注入的是哪一版脚本 */
  version: '1.0.0',
  /** 让页面知道这是本地辅助工具注入的，不是站点自身代码 */
  injected: true
});
