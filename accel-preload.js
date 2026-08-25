// accel-preload.js —— 下载加速设置窗预加载脚本(sandbox:true 下的最小 IPC 面)
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__accel', {
  // 主进程推送最新设置(窗口打开/复用展示时)
  onShow: (cb) => ipcRenderer.on('acc:show', (_e, payload) => cb(payload)),
  // 读取当前生效设置(打开时初始化表单)
  get: () => ipcRenderer.invoke('acc:get'),
  // 保存单设置项: field = 'segments' | 'mirror';返回 {ok} 或 {ok:false,error}
  set: (field, value) => ipcRenderer.invoke('acc:set', { field, value }),
  // 复制文本到剪贴板(主进程 clipboard,file:// 页面不可用 navigator.clipboard)
  copy: (text) => ipcRenderer.send('acc:copy', String(text || '')),
  close: () => ipcRenderer.send('acc:close'),
});