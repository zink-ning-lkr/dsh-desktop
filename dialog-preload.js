// 对话框 IPC 桥:接收载荷,回传所选按钮下标;渲染完成后回报供主进程实测校准窗口高度(P1-1)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__dialog', {
  onShow: (cb) => ipcRenderer.on('dl:show', (_e, v) => cb(v)),
  choose: (i, id) => ipcRenderer.send('dl:choose', i, id),
  rendered: () => ipcRenderer.send('dl:rendered'),
});
