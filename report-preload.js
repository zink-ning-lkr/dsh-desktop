// 错误报告窗 IPC 桥:接收报告载荷,回传导出/复制/打开日志/动作
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__report', {
  onShow: (cb) => ipcRenderer.on('rp:show', (_e, v) => cb(v)),
  export: () => ipcRenderer.send('rp:export'),
  copy: () => ipcRenderer.send('rp:copy'),
  openLog: () => ipcRenderer.send('rp:open-log'),
  action: (id) => ipcRenderer.send('rp:action', id),
  onCopied: (cb) => ipcRenderer.on('rp:copied', () => cb()),
  onExported: (cb) => ipcRenderer.on('rp:exported', () => cb()),
});