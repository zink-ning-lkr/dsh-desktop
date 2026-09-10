// accel-preload.js —— 下载加速设置窗预加载脚本(sandbox:true 下的最小 IPC 面)
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__accel', {
  // 主进程推送最新设置(窗口打开/复用展示时)
  onShow: (cb) => ipcRenderer.on('acc:show', (_e, payload) => cb(payload)),
  // 读取当前生效设置(打开时初始化表单)
  get: () => ipcRenderer.invoke('acc:get'),
  // 保存单设置项: field = 'segments' | 'mirror';返回 {ok} 或 {ok:false,error}
  set: (field, value) => ipcRenderer.invoke('acc:set', { field, value }),
  // 复制文本到剪贴板(主进程 clipboard,file:// 页面不可用 navigator.clipboard)
  copy: (text) => ipcRenderer.send('acc:copy', String(text || '')),
  close: () => ipcRenderer.send('acc:close'),
  // 布局稳定后回报一次(阶段 3 S2):主进程据此把窗口高度回填成真实内容高度
  // (含「下载进行中」提示显形、校验文案折行等会让内容长高的情形)
  rendered: () => ipcRenderer.send('acc:rendered'),
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