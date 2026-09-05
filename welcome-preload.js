// 首启欢迎页 IPC 桥(P1-6):选择工作目录 / 退出;最小暴露面,无其他能力
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__welcome', {
  choose: () => ipcRenderer.send('wl:choose'),
  quit: () => ipcRenderer.send('wl:quit'),
});
