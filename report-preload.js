// 错误报告窗 IPC 桥:接收报告载荷,回传导出/复制/打开日志/动作
const { contextBridge, ipcRenderer } = require('electron');

// 文案表同步拉取(渲染层 i18n):sandbox 读不了 fs,经主进程一次性下发静态快照;
// t() 实现收敛在 ui-i18n.js(页面 <head> 引用),preload 只拉数据
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

contextBridge.exposeInMainWorld('__i18nTable', i18nTable);