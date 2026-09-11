// settings-preload.js —— 设置窗预加载脚本(sandbox:true 下的最小 IPC 面)。
// 频道仍是 acc:*(阶段 3 的硬契约:acc:get / acc:set / acc:close 三条保持不变),
// 只是窗口从「下载加速设置窗」演进为三分区设置窗 —— 改文件名与载荷,不改频道名。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__accel', {
  // 主进程推送最新设置(窗口打开/复用展示时);带 section 字段 = 菜单深链要落在哪个分区
  onShow: (cb) => ipcRenderer.on('acc:show', (_e, payload) => cb(payload)),
  // 读取当前生效设置(打开时初始化表单);刷新内存读数也走它
  get: () => ipcRenderer.invoke('acc:get'),
  // 保存单设置项: field = 'segments' | 'mirror' | 'theme' | 'closeAction' | 'openBrowser';
  // 返回 {ok} 或 {ok:false,error}。后三项是阶段 3 从 ☰ 菜单收进来的散落勾选项
  set: (field, value) => ipcRenderer.invoke('acc:set', { field, value }),
  // 复制文本到剪贴板(主进程 clipboard,file:// 页面不可用 navigator.clipboard)
  copy: (text) => ipcRenderer.send('acc:copy', String(text || '')),
  close: () => ipcRenderer.send('acc:close'),
  // 布局稳定后回报一次(阶段 3 S2):主进程据此把窗口高度回填成真实内容高度
  // (含「下载进行中」提示显形、校验文案折行等会让内容长高的情形)
  rendered: () => ipcRenderer.send('acc:rendered'),
});

// 文案表同步拉取(渲染层 i18n):sandbox 读不了 fs,经主进程一次性下发静态快照;
// t() 实现收敛在 ui-i18n.js(页面 <head> 引用),preload 只拉数据
let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }
contextBridge.exposeInMainWorld('__i18nTable', i18nTable);