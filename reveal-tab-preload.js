// reveal-tab-preload.js —— 下拉把手的最小 IPC 桥。
// 把手是「收起即销毁」的常建常毁小窗(主进程 ensureRevealTab/destroyRevealTab),
// 此前复用 titlebar-preload:每次创建白做一次 sc:display 同步 IPC,还把 17 成员的
// __titlebar 桥暴露给这个无输入的小窗。本文件只暴露把手实际消费的三样:
// 展开标题栏 / 首次收起演示提示(S3)/ 退场淡出(H-1),外加文案表快照(通用约定)。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__titlebar', {
  showTitlebar: () => ipcRenderer.send('tb:show-bar'),
  // 首次收起的把手演示(S3):主进程在 3s 驻留期间置 true,结束或还原时置 false。
  // 只切换一个视觉状态 —— 把手的显隐始终由主进程的 bounds 决定,渲染层不持有可见性真相
  onHandleHint: (cb) => ipcRenderer.on('tb:handle-hint', (_e, v) => cb(v)),
  // 退场淡出(H-1):主进程在归零 bounds 前先置 true 播 opacity 过渡,结束后置 false
  onHandleFade: (cb) => ipcRenderer.on('tb:handle-fade', (_e, v) => cb(v)),
});

// 文案表同步拉取(渲染层 i18n 通用约定):t() 实现在 ui-i18n.js,preload 只拉数据
let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }
contextBridge.exposeInMainWorld('__i18nTable', i18nTable);