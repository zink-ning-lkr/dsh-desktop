// 通知宿主 IPC 桥(阶段 1 X1):接收条目渲染载荷,回传悬停 / 动作 / 关闭 / 内容高度。
// 与 status-preload 同构:sandbox 渲染层读不了 fs,文案表经主进程一次性下发静态快照;
// 表缺失时回退 key(渲染层 i18n 的既有约定)。
// 信道前缀 nt:(notification toast),与 st:(status)/m:(menu)并列。
const { contextBridge, ipcRenderer } = require('electron');

// 文案表同步拉取(渲染层 i18n,与其余 preload 同一约定):表缺失回退 key;
// t() 实现收敛在 ui-i18n.js(页面 <head> 引用),preload 只拉数据
let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }

contextBridge.exposeInMainWorld('__toast', {
  onRender: (cb) => ipcRenderer.on('nt:render', (_e, v) => cb(v)),
  // 悬停即暂停计时(主进程侧执行):鼠标划过不该把正在读的提示划没了
  hover: (id, over) => ipcRenderer.send('nt:hover', { id: String(id), over: !!over }),
  action: (id) => ipcRenderer.send('nt:action', String(id)),
  close: (id) => ipcRenderer.send('nt:close', String(id)),
  // 条目增删后回报真实内容高度:透明窗不做阴影留白,高度必须像素级贴合,
  // 否则"穿透区"会变成不透明的死区(带动作的条目会解除穿透,见 main.js applyToastMousePolicy)
  height: (h) => ipcRenderer.send('nt:height', Number(h) || 0),
});

contextBridge.exposeInMainWorld('__i18nTable', i18nTable);
