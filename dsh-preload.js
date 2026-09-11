// dsh-preload.js —— dshView(dsh 页面容器)的 preload。
// 安全面约束:dshView 先后承载本地 loading.html 与 dsh 服务页(http://127.0.0.1),
// 动作桥 dshBoot 只在本地 file:// 页面暴露,远程服务页零暴露、不增加其攻击面;
// 主进程侧另有双重校验(sender 必须是 dshView 且 senderFrame 协议为 file:)。
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('dshBoot', {
    // 加载页慢启动自助动作:view-log / retry / quit(见 main.js boot:action)
    action: (id) => ipcRenderer.send('boot:action', String(id)),
  });
  // 文案表同步拉取(渲染层 i18n):仅本地 loading 页可用,与 dshBoot 同受 file:// 门槛;
  // t() 实现收敛在 ui-i18n.js(页面 <head> 引用),preload 只拉数据
  let i18nTable = {};
  try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }
  contextBridge.exposeInMainWorld('__i18nTable', i18nTable);
}
