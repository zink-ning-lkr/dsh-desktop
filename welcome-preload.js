// 首启欢迎页 IPC 桥(P1-6):选择工作目录 / 退出;最小暴露面,无其他能力
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__welcome', {
  choose: () => ipcRenderer.send('wl:choose'),
  quit: () => ipcRenderer.send('wl:quit'),
  // 布局稳定后回报一次(阶段 3 S2):主进程据此把窗口高度回填成真实内容高度。
  // 只传"已渲染"信号,不传高度 —— 测量式留在主进程,宽度/上限的 clamp 口径只有一处
  rendered: () => ipcRenderer.send('wl:rendered'),
});

// 文案表同步拉取(渲染层 i18n,X-2 第二批):sandbox 读不了 fs,经主进程一次性下发静态快照
let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }
// 渲染层 t():与主进程 i18n.js 同一取值/占位符约定,表缺失回退 key(同 status-preload)
contextBridge.exposeInMainWorld('__i18n', {
  t: (key, params) => {
    let s = i18nTable[key] || key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  },
});
