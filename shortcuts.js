// shortcuts.js —— 快捷键单一数据源(P2-2):主菜单弹层的 accel 文案、应用菜单(buildMenu)的
// accelerator、速查浮层(菜单「键盘快捷键…」)三方共同消费,杜绝多处手写漂移。
// id 与 main.js 的 m:action / buildMenu click 分发键一致;menu 为 Electron accelerator 原文。
// 展示文案不入本文件(阶段 0 修 X5):labelKey 指向 i18n 文案表,由消费方 t() 取词,
// 避免同一句话在 shortcuts.js 与 i18n/zh-CN.json 各写一份、改一处漏一处。
'use strict';

const list = [
  { id: 'open-workspace', labelKey: 'menu.openWorkspace', menu: 'CmdOrCtrl+O' },
  { id: 'restart-dsh', labelKey: 'menu.restartDsh', menu: 'CmdOrCtrl+Shift+R' },
  { id: 'fullscreen', labelKey: 'menu.fullscreen', menu: 'F11' },
  { id: 'toggle-bar', labelKey: 'menu.toggleBar', menu: 'CmdOrCtrl+Shift+B' },
  { id: 'reload', labelKey: 'menu.reload', menu: 'F5' },
  { id: 'devtools', labelKey: 'menu.devtools', menu: 'F12' },
];

// 菜单弹层展示用:CmdOrCtrl 渲染为平台前缀(Windows/Linux=Ctrl, macOS=Cmd)
function display(menu) {
  return String(menu || '').replace('CmdOrCtrl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl');
}

module.exports = { list, display };
