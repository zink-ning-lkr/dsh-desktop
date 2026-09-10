// 菜单 IPC 桥:接收条目数据,回传动作与关闭
// 菜单弹层与主进程之间的桥:接收条目数据,回传动作/关闭。
// 文案表同步拉取(阶段 0 修 X5):菜单渲染层此前硬编码了勾选项提示'已启用',
// sandbox 读不了 fs,与 status/titlebar 同法经主进程一次性下发静态快照。
const { contextBridge, ipcRenderer } = require('electron');

let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }

contextBridge.exposeInMainWorld('__menu', {
  onShow: (cb) => ipcRenderer.on('m:show', (_e, v) => cb(v)),
  action: (id) => ipcRenderer.send('m:action', id),
  close: () => ipcRenderer.send('m:close'),
});

// 渲染层 t():与主进程 i18n.js 同一取值/占位符约定,表缺失回退 key
contextBridge.exposeInMainWorld('__i18n', {
  t: (key, params) => {
    let s = i18nTable[key] || key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  },
});
