// shortcuts.js —— 快捷键单一数据源(P2-2):主菜单弹层的 accel 文案、应用菜单(buildMenu)的
// accelerator、速查浮层(菜单「键盘快捷键…」)三方共同消费,杜绝多处手写漂移。
// id 与 main.js 的 m:action / buildMenu click 分发键一致;menu 为 Electron accelerator 原文。
'use strict';

const list = [
  { id: 'open-workspace', label: '打开工作目录…', menu: 'CmdOrCtrl+O' },
  { id: 'restart-dsh', label: '重启 dsh 服务', menu: 'CmdOrCtrl+Shift+R' },
  { id: 'fullscreen', label: '全屏', menu: 'F11' },
  { id: 'toggle-bar', label: '显示/隐藏标题栏', menu: 'CmdOrCtrl+Shift+B' },
  { id: 'reload', label: '重新加载页面', menu: 'F5' },
  { id: 'devtools', label: '开发者工具', menu: 'F12' },
];

// 菜单弹层展示用:CmdOrCtrl 渲染为平台前缀(Windows/Linux=Ctrl, macOS=Cmd)
function display(menu) {
  return String(menu || '').replace('CmdOrCtrl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl');
}

module.exports = { list, display };
