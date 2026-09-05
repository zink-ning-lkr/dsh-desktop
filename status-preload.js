// 状态窗 IPC 桥:接收任务列表载荷,回传后台化/取消/关闭/结果动作/单任务取消与关闭/全部取消;
// 文案表同步拉取(渲染层 i18n,v0.6.0):sandbox 读不了 fs,经主进程一次性下发静态快照
// P1-1 任务中心:渲染器以任务数组渲染(单任务时退化为旧单视图),动作全部携带任务 id
const { contextBridge, ipcRenderer } = require('electron');

let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }

contextBridge.exposeInMainWorld('__status', {
  onTasks: (cb) => ipcRenderer.on('st:tasks', (_e, v) => cb(v)),
  background: () => ipcRenderer.send('st:bg'),
  close: () => ipcRenderer.send('st:close'),
  cancel: () => ipcRenderer.send('st:cancel'),
  cancelAll: () => ipcRenderer.send('st:cancel-all'), // 列表模式「全部关闭」:取消全部未完成任务再收窗(P0-1)
  rendered: () => ipcRenderer.send('st:rendered'),    // 渲染完成回报:主进程按真实内容高度微调窗口(P1-1)
  action: (taskId, btnId) => ipcRenderer.send('st:action', { taskId, btnId }),
  dismiss: (taskId) => ipcRenderer.send('st:dismiss', String(taskId)),   // 关闭某个已完成任务
  cancelOne: (taskId) => ipcRenderer.send('st:cancel-one', String(taskId)), // 取消某个进行中任务
});

// 渲染层 t():与主进程 i18n.js 同一取值/占位符约定,表缺失回退 key
contextBridge.exposeInMainWorld('__i18n', {
  t: (key, params) => {
    let s = i18nTable[key] || key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  },
});
