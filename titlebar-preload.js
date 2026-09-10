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
  // 命令栏状态簇(阶段 1 S1):四个动作与主菜单同名条目同源,不另开一套实现
  openTasks: () => ipcRenderer.send('tb:tasks'),
  checkUpdate: () => ipcRenderer.send('tb:update'),
  cycleTheme: () => ipcRenderer.send('tb:cycle-theme'),
  copyWorkspace: () => ipcRenderer.send('tb:copy-ws'),
  onTheme: (cb) => ipcRenderer.on('tb:theme', (_e, v) => cb(v)),
  onMaximized: (cb) => ipcRenderer.on('tb:maximized', (_e, v) => cb(v)),
  onWorkspace: (cb) => ipcRenderer.on('tb:workspace', (_e, v) => cb(v)),
  onMenuState: (cb) => ipcRenderer.on('tb:menu-state', (_e, v) => cb(v)),
  onCloseTip: (cb) => ipcRenderer.on('tb:close-tip', (_e, v) => cb(v)),
  // 首次收起的把手演示(S3):主进程在 3s 驻留期间置 true,结束或还原时置 false。
  // 只切换一个视觉状态 —— 把手的显隐始终由主进程的 bounds 决定,渲染层不持有可见性真相
  onHandleHint: (cb) => ipcRenderer.on('tb:handle-hint', (_e, v) => cb(v)),
  // 状态簇载荷(tb:status):主进程在托盘态/任务数/更新可用性/主题变化时整体推送一次,
  // 渲染层不做增量合并——载荷小(5 个字段),整推更容易保证与主进程一致
  onStatus: (cb) => ipcRenderer.on('tb:status', (_e, v) => cb(v)),
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
