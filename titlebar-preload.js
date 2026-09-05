// 标题栏与下拉把手共用的 IPC 桥:窗口控制、菜单、主题/最大化状态同步
// 标题栏/把手页面与主进程之间的桥:仅暴露窗口控制与菜单事件,不开放其他能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__titlebar', {
  minimize: () => ipcRenderer.send('tb:min'),
  toggleMaximize: () => ipcRenderer.send('tb:max'),
  close: () => ipcRenderer.send('tb:close'),
  openMenu: () => ipcRenderer.send('tb:menu'),
  hideTitlebar: () => ipcRenderer.send('tb:hide-bar'),
  showTitlebar: () => ipcRenderer.send('tb:show-bar'),
  onTheme: (cb) => ipcRenderer.on('tb:theme', (_e, v) => cb(v)),
  onMaximized: (cb) => ipcRenderer.on('tb:maximized', (_e, v) => cb(v)),
  onWorkspace: (cb) => ipcRenderer.on('tb:workspace', (_e, v) => cb(v)),
  onMenuState: (cb) => ipcRenderer.on('tb:menu-state', (_e, v) => cb(v)),
  onCloseTip: (cb) => ipcRenderer.on('tb:close-tip', (_e, v) => cb(v)),
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
