// 快捷键速查浮层桥(第七轮 D-1):载荷(sc:show)与关闭(sc:close)两条通道。
// 与 palette-preload 同构:sandbox 渲染层只暴露「收载荷 + 关自己」,不开放其他能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__shortcuts', {
  onShow: (cb) => ipcRenderer.on('sc:show', (_e, v) => cb(v)),
  close: () => ipcRenderer.send('sc:close'),
  height: (h) => ipcRenderer.send('sc:height', Math.round(Number(h) || 0)),
});

// 文案表同步拉取(渲染层 i18n,与其余 preload 同一约定):表缺失回退 key
let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }
contextBridge.exposeInMainWorld('__i18n', {
  t: (key, params) => {
    let s = i18nTable[key] || key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  },
});
