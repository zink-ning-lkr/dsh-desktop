// 对话框 IPC 桥:接收载荷,回传所选按钮下标
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__dialog', {
  onShow: (cb) => ipcRenderer.on('dl:show', (_e, v) => cb(v)),
  choose: (i) => ipcRenderer.send('dl:choose', i),
});