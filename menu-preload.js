// 菜单 IPC 桥:接收条目数据,回传动作与关闭
// 菜单弹层与主进程之间的桥:接收条目数据,回传动作/关闭。
// 文案表同步拉取(渲染层 i18n,阶段 0 修 X5 起):sandbox 读不了 fs,经主进程一次性下发静态快照;
// t() 实现收敛在 ui-i18n.js(页面 <head> 引用),preload 只拉数据
const { contextBridge, ipcRenderer } = require('electron');

let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }

contextBridge.exposeInMainWorld('__menu', {
  onShow: (cb) => ipcRenderer.on('m:show', (_e, v) => cb(v)),
  action: (id) => ipcRenderer.send('m:action', id),
  close: () => ipcRenderer.send('m:close'),
});

contextBridge.exposeInMainWorld('__i18nTable', i18nTable);
