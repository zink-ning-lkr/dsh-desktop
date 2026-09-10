// commands.js —— 命令注册表(第五个单一事实源,阶段 2「可发现性」)。
//
// 分工:shortcuts.js 管「按键」· i18n 管「文案」· ui-icons.js 管「图形」· ui.css 管「外观」·
// 本文件管「有哪些命令、各属哪一组、是哪一类」。
// 三方消费同一份:☰ 主菜单(menuItems) / 命令面板(palette 载荷) / 托盘菜单(trayMenuItems)。
// 此前"菜单能点、命令面板没有"这类漂移无从拦截——同一份注册表之后,漏一条会直接体现在
// 面板与菜单的条目集合差异上(uitest 的 cmd-* 断言即为此设)。
//
// 只描述、不执行:执行仍是 main.js 的 runCommand(id) 单一入口。
// 若把执行函数(闭包)塞进本文件,这里就得 require electron / main 的内部状态,
// 注册表会退化成第二份 main——那正是这轮重构要消掉的东西。
'use strict';
const shortcuts = require('./shortcuts');

// 分组(渲染顺序 = 本数组顺序)。group 键同时用于三处:
// ① 菜单的分组小标题(v0.7.13)② 命令面板条目右侧的分类标签 ③ 面板排序的次级权重
const groups = ['workspace', 'service', 'update', 'appearance', 'diagnostics', 'quit'];

// kind 只服务命令面板的加权排序(方案 §5.3:动作 > 设置项 > 跳转),与菜单渲染无关:
//   action  执行一件事(切换工作目录 / 重启 dsh / 退出)
//   setting 切换一个开关或取值(命令栏显隐 / 外观循环 / 关闭行为),面板里带当前值
//   nav     跳去某处(打开浏览器 / 打开日志所在目录 / 快捷键速查)
const KINDS = ['action', 'setting', 'nav'];

// 外观模式 → 文案键。主进程侧(菜单 / 命令面板 / 切换日志)共用这一张表。
// 注:titlebar.html 因为 sandbox 渲染层读不了 CommonJS,仍自带一份同名映射——那是渲染层唯一
// 无法收编的重复,真要消掉得把键名塞进 tb:status 载荷,收益不抵改动面,先记在这里。
const THEME_KEYS = { auto: 'menu.appearanceAuto', dark: 'menu.appearanceDark', light: 'menu.appearanceLight' };

// 条目字段:
//   id        与 m:action / runCommand / buildMenu 分发键一致(唯一真名,改名必须三处同改)
//   group     groups 之一
//   kind      KINDS 之一
//   label(c)  文案。c 是主进程拼的运行时上下文(见 main.js commandCtx()),
//             多数条目直接取 c.t(文案键);带运行时值的条目(版本号/内存/外观模式)自行拼参
//   checked(c) 返回布尔 → 渲染成 menuitemcheckbox(勾选项);缺省 → 普通 menuitem
//   menu:false 只在命令面板可见,不进 ☰ 菜单(菜单是"常用入口",不是全量清单;
//              全量清单归命令面板,菜单底部留一行「所有命令…」引过去)
const list = [
  { id: 'open-workspace', group: 'workspace', kind: 'action', label: (c) => c.t('menu.openWorkspace') },
  { id: 'dsh-home', group: 'workspace', kind: 'nav', label: (c) => c.t('menu.dshHome') },
  // 复制工作目录路径此前只挂在命令栏的工作目录点击上,菜单与面板都够不着——并入注册表但不上菜单
  { id: 'copy-workspace', group: 'workspace', kind: 'action', menu: false, label: (c) => c.t('cmd.copyWorkspace') },

  { id: 'restart-dsh', group: 'service', kind: 'action', label: (c) => c.t('menu.restartDsh') },
  { id: 'open-browser', group: 'service', kind: 'nav', label: (c) => c.t('menu.openBrowser') },
  // 显示主窗:主窗收进托盘后唯一能唤起的入口,原只挂在托盘菜单上
  { id: 'show-main', group: 'service', kind: 'action', menu: false, label: (c) => c.t('menu.showMain') },
  { id: 'open-tasks', group: 'service', kind: 'nav', menu: false, label: (c) => c.t('cmd.openTasks') },

  { id: 'check-update', group: 'update', kind: 'action', label: (c) => (c.isPortable ? c.t('menu.checkUpdatePortable') : c.t('menu.checkUpdateCurrent', { v: c.version })) },
  { id: 'check-dsh-update', group: 'update', kind: 'action', label: (c) => c.t('menu.checkDshUpdate', { v: c.dshVersion }) },
  { id: 'download-accel', group: 'update', kind: 'setting', label: (c) => c.t('menu.downloadAccel') },

  { id: 'toggle-bar', group: 'appearance', kind: 'setting', label: (c) => (c.barVisible ? c.t('menu.hideBar') : c.t('menu.showBar')) },
  { id: 'fullscreen', group: 'appearance', kind: 'action', label: (c) => c.t('menu.fullscreen') },
  // 外观三态循环(auto→dark→light):扁平菜单无子菜单,单条目循环最省行数,label 即当前值
  { id: 'cycle-theme', group: 'appearance', kind: 'setting', label: (c) => c.t('menu.appearance', { mode: c.t(THEME_KEYS[c.cfg.theme || 'auto']) }) },
  { id: 'auto-open-browser', group: 'appearance', kind: 'setting', checked: (c) => !!c.cfg.openBrowser, label: (c) => c.t('menu.autoOpenBrowser') },
  { id: 'close-to-tray', group: 'appearance', kind: 'setting', checked: (c) => c.cfg.closeAction !== 'quit', label: (c) => c.t('menu.closeToTray') },

  { id: 'reload', group: 'diagnostics', kind: 'action', label: (c) => c.t('menu.reload') },
  { id: 'devtools', group: 'diagnostics', kind: 'action', label: (c) => c.t('menu.devtools') },
  { id: 'log', group: 'diagnostics', kind: 'nav', label: (c) => c.t('menu.openLog') },
  { id: 'memory-info', group: 'diagnostics', kind: 'nav', label: (c) => c.t('menu.memoryInfo', { n: c.mem }) },
  { id: 'shortcuts', group: 'diagnostics', kind: 'nav', label: (c) => c.t('menu.shortcuts') },

  // 注意:这里不显示 Alt+F4 快捷键。默认「关闭时最小化到托盘」下,Alt+F4 只隐藏窗口而非退出,
  // 提示该快捷键会误导用户;点击本项是真正的 app.quit()
  { id: 'quit', group: 'quit', kind: 'action', label: (c) => c.t('menu.quit') },
];

// 分组标题文案键(cmd 分组)。缺一个分组就会在菜单与面板里渲染成裸键,uitest cmd-groups 拦它
function groupLabelKey(group) { return `cmd.group${group.charAt(0).toUpperCase()}${group.slice(1)}`; }

function labelOf(cmd, ctx) { return String(cmd.label(ctx)); }
// 返回 undefined 表示"不是勾选项"(普通 menuitem);返回布尔才是 menuitemcheckbox
function checkedOf(cmd, ctx) { return cmd.checked ? !!cmd.checked(ctx) : undefined; }
// 加速键文案来自 shortcuts.js,本文件不存第二份;无快捷键的命令返回空串
function accelOf(id) {
  const s = shortcuts.list.find((x) => x.id === id);
  return s ? shortcuts.display(s.menu) : '';
}

module.exports = { groups, KINDS, THEME_KEYS, list, groupLabelKey, labelOf, checkedOf, accelOf };
