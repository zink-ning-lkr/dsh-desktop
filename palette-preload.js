// 命令面板 IPC 桥(阶段 2):接收条目载荷,回传执行/关闭/高度。
// 与本项目其余 preload 同构:只用 contextBridge 暴露具名方法,sandbox 内不碰 fs。
// 文案表与 menu/titlebar/status 同法:sendSync 一次性拉取静态快照,渲染层本地 t()。
const { contextBridge, ipcRenderer } = require('electron');

let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }

contextBridge.exposeInMainWorld('__palette', {
  onShow: (cb) => ipcRenderer.on('pt:show', (_e, v) => cb(v)),
  // 执行:面板自己不做分发,只把 id 交回主进程的 runCommand 单一入口(与菜单/托盘/命令栏同源)
  run: (id) => ipcRenderer.send('pt:run', String(id)),
  close: () => ipcRenderer.send('pt:close'),
  // 高度回报:结果行数随输入变化,视图高度得跟着变。渲染层量真实盒高上报(主进程不猜 CSS),
  // 主进程加上阴影留白后再 setBounds —— 与 toast 宿主"先量后亮"同一套契约
  height: (h) => ipcRenderer.send('pt:height', Number(h) || 0),
});

// 渲染层 t():与主进程 i18n.js 同一取值/占位符约定,表缺失回退 key
contextBridge.exposeInMainWorld('__i18n', {
  t: (key, params) => {
    let s = i18nTable[key] || key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  },
});
