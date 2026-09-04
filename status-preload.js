// 状态窗 IPC 桥:接收任务列表载荷,回传后台化/取消/关闭/结果动作/单任务取消与关闭
// P1-1 任务中心:渲染器以任务数组渲染(单任务时退化为旧单视图),动作全部携带任务 id
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__status', {
  onTasks: (cb) => ipcRenderer.on('st:tasks', (_e, v) => cb(v)),
  background: () => ipcRenderer.send('st:bg'),
  close: () => ipcRenderer.send('st:close'),
  cancel: () => ipcRenderer.send('st:cancel'),
  action: (taskId, btnId) => ipcRenderer.send('st:action', { taskId, btnId }),
  dismiss: (taskId) => ipcRenderer.send('st:dismiss', String(taskId)),   // 关闭某个已完成任务
  cancelOne: (taskId) => ipcRenderer.send('st:cancel-one', String(taskId)), // 取消某个进行中任务
});
