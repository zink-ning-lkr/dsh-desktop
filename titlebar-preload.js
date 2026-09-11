// 标题栏 IPC 桥:窗口控制、菜单、主题/最大化状态同步。
// 下拉把手已拆独立极简桥(reveal-tab-preload.js),不再共用本桥。
// 仅暴露窗口控制与菜单事件,不开放其他能力。
const { contextBridge, ipcRenderer } = require('electron');

// 命令面板的快捷键显示名(阶段 2):sandbox 里读不到 process.platform,故由主进程按
// shortcuts.display() 的同一规则算好下发(Windows=Ctrl+K / macOS=Cmd+K)。
// 面板本身不注册 accelerator(见 main.js bindPaletteKey),这里只是给徽标取正确的前缀写法
let paletteKbd = '';
try { paletteKbd = ipcRenderer.sendSync('sc:display', 'CmdOrCtrl+K') || ''; } catch { /* 回退空串 */ }

contextBridge.exposeInMainWorld('__titlebar', {
  paletteKbd, // 静态字符串(非方法):页面加载时即已确定,无需再订阅事件
  minimize: () => ipcRenderer.send('tb:min'),
  toggleMaximize: () => ipcRenderer.send('tb:max'),
  close: () => ipcRenderer.send('tb:close'),
  openMenu: () => ipcRenderer.send('tb:menu'),
  hideTitlebar: () => ipcRenderer.send('tb:hide-bar'),
  // 命令栏状态簇(阶段 1 S1):四个动作与主菜单同名条目同源,不另开一套实现
  openTasks: () => ipcRenderer.send('tb:tasks'),
  checkUpdate: () => ipcRenderer.send('tb:update'),
  cycleTheme: () => ipcRenderer.send('tb:cycle-theme'),
  copyWorkspace: () => ipcRenderer.send('tb:copy-ws'),
  openPalette: () => ipcRenderer.send('tb:palette'), // 中段命令入口(阶段 2)
  onTheme: (cb) => ipcRenderer.on('tb:theme', (_e, v) => cb(v)),
  onMaximized: (cb) => ipcRenderer.on('tb:maximized', (_e, v) => cb(v)),
  onWorkspace: (cb) => ipcRenderer.on('tb:workspace', (_e, v) => cb(v)),
  onMenuState: (cb) => ipcRenderer.on('tb:menu-state', (_e, v) => cb(v)),
  onCloseTip: (cb) => ipcRenderer.on('tb:close-tip', (_e, v) => cb(v)),
  // 状态簇载荷(tb:status):主进程在托盘态/任务数/更新可用性/主题变化时整体推送一次,
  // 渲染层不做增量合并——载荷小(5 个字段),整推更容易保证与主进程一致
  onStatus: (cb) => ipcRenderer.on('tb:status', (_e, v) => cb(v)),
});

// 文案表同步拉取(渲染层 i18n):sandbox 读不了 fs,经主进程一次性下发静态快照;
// t() 实现收敛在 ui-i18n.js(页面 <head> 引用),preload 只拉数据
let i18nTable = {};
try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch { /* 主进程未就绪:回退 key */ }
contextBridge.exposeInMainWorld('__i18nTable', i18nTable);
