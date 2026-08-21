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
});
