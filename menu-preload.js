// 菜单 IPC 桥:接收条目数据,回传动作与关闭
// 菜单弹层与主进程之间的桥:接收条目数据,回传动作/关闭。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__menu', {
  onShow: (cb) => ipcRenderer.on('m:show', (_e, v) => cb(v)),
  action: (id) => ipcRenderer.send('m:action', id),
  close: () => ipcRenderer.send('m:close'),
});
