// 状态窗 IPC 桥:接收状态载荷,回传后台化/关闭/结果动作
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__status', {
  onSet: (cb) => ipcRenderer.on('st:set', (_e, v) => cb(v)),
  background: () => ipcRenderer.send('st:bg'),
  close: () => ipcRenderer.send('st:close'),
  action: (id) => ipcRenderer.send('st:action', id),
});