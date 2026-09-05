// 错误报告窗 IPC 桥:接收报告载荷,回传导出/复制/打开日志/动作
const { contextBridge, ipcRenderer } = require('electron');

// 文案表同步拉取(渲染层 i18n,X-2 第二批):sandbox 读不了 fs,经主进程一次性下发静态快照
let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }

contextBridge.exposeInMainWorld('__report', {
  onShow: (cb) => ipcRenderer.on('rp:show', (_e, v) => cb(v)),
  export: () => ipcRenderer.send('rp:export'),
  copy: () => ipcRenderer.send('rp:copy'),
  openLog: () => ipcRenderer.send('rp:open-log'),
  action: (id) => ipcRenderer.send('rp:action', id),
  onCopied: (cb) => ipcRenderer.on('rp:copied', () => cb()),
  onExported: (cb) => ipcRenderer.on('rp:exported', () => cb()),
});

// 渲染层 t():与主进程 i18n.js 同一取值/占位符约定,表缺失回退 key(同 status-preload)
contextBridge.exposeInMainWorld('__i18n', {
  t: (key, params) => {
    let s = i18nTable[key] || key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  },
});