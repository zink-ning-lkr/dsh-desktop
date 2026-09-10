/* ui-icons.js —— 全部自绘页面共享的 SVG 图标常量(单一事实源,P1-2)。
   用法:<script src="ui-icons.js"></script> 置于页面自身脚本之前(CSP script-src 'self' 已允许),
   经 window.UI_ICONS 访问:UI_ICONS.result.info / UI_ICONS.activity.download / UI_ICONS.menu['open-workspace']。
   域:result / activity(结果与活动态,viewBox 24)· menu(菜单条目,viewBox 16、固定 15×15)
      · cmdbar(命令栏状态簇,viewBox 16、固定 15×15)· toast(通知条目,viewBox 16、固定 15×15)
      · palette(命令面板,viewBox 16、固定 13×13)。
   描边规范:result/activity 族 viewBox 24(线性图标);menu/cmdbar/toast/palette 族 viewBox 16。
   原三份逐字符重复的定义(status RES / dialog ICONS / menu ICONS)已收编至此,改图标只改这一处。 */
(function () {
  const result = {
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.2" stroke-linecap="round"/></svg>',
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M8 12.2l2.7 2.7L16 9.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 4.5 22 20H2z"/><path d="M12 10v4.5M12 17.4v.2" stroke-linecap="round"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6" stroke-linecap="round"/></svg>',
  };
  const activity = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M11 8v3l2 2M16.5 16.5 21 21" stroke-linecap="round"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4v10M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    install: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="7.5"/><path d="M12 6v6l3.5 2" stroke-linecap="round"/></svg>',
    restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 3.5v3.2h-3.2" stroke-linecap="round"/></svg>',
    toast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4a5 5 0 0 0-5 5v3.2L5 15h14l-2-2.8V9a5 5 0 0 0-5-5zM10 18a2 2 0 0 0 4 0" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const menu = {
    'open-workspace': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 4.5v7.5h13V6H8.4L7 4.5z"/></svg>',
    'restart-dsh': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3"/></svg>',
    'open-browser': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c-3.5 3.8-3.5 9.2 0 13M8 1.5c3.5 3.8 3.5 9.2 0 13"/></svg>',
    'auto-open-browser': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2h6v6M14 2 7 9M13 9.5v3a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 12.5v-8A1.5 1.5 0 0 1 3.5 3h3"/></svg>',
    'fullscreen': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>',
    'toggle-bar': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 5.5h13"/></svg>',
    'reload': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9M2.5 2.5v3h3M13.5 13.5v-3h-3"/></svg>',
    'devtools': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 3l4 5-4 5M9 13h5"/></svg>',
    'dsh-home': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2.5l5 3.2v7.8H3V5.7z"/><circle cx="8" cy="9.5" r="1.4"/></svg>',
    'close-to-tray': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4.5h7.5M13 4.5h1M12.5 2.8v3.4M2 11.5h1M6.5 11.5H14M6 9.8v3.4"/></svg>',
    'show-main': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M1.5 14.5h13"/></svg>',
    'log': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 8h5M5.5 11h5"/></svg>',
    'memory-info': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="8" rx="1.5"/><path d="M4 12.5v2M8 12.5v2M12 12.5v2"/></svg>',
    'check-update': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/></svg>',
    'check-dsh-update': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 5l6-3 6 3v6l-6 3-6-3zM2 5l6 3 6-3M8 8v6"/></svg>',
    'download-accel': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 9.5a5.5 5.5 0 1 1 11 0M2.5 9.5h2.8M10.7 9.5h2.8M8 9.5l2.6-3.6"/><circle cx="8" cy="9.5" r="1"/></svg>',
    'shortcuts': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="4.5" width="13" height="7.5" rx="1.5"/><path d="M4 7h.01M6.6 7h.01M9.4 7h.01M12 7h.01M5.5 9.7h5" stroke-linecap="round"/></svg>',
    'cycle-theme': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.2"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" stroke="none"/></svg>',
    'quit': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2v5M4.5 4a5 5 0 1 0 7 0"/></svg>',
    'tray-status': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/></svg>',
  };
  // 命令栏状态簇(阶段 1 S1):24px 按钮内的 15×15 线性图标,与 menu 族同一描边规范。
  // 独立成域而不复用 menu 族:menu 族按「菜单条目 id」组织,状态簇按「状态语义」组织,
  // 二者的键空间会撞车(check-update 既是菜单条目也是状态簇按钮,但将来会分叉)。
  const cmdbar = {
    tasks: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M5.8 4h7.7M5.8 8h7.7M5.8 12h7.7"/><path d="M2.2 4l.9.9 1.6-1.8M2.2 8l.9.9 1.6-1.8M2.2 12l.9.9 1.6-1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    update: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/></svg>',
    theme: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.2"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" stroke="none"/></svg>',
  };
  // 通知宿主(阶段 1 X1):360px 宽的一行提示,图标只做级别提示,不做视觉主体。
  // 独立成域而不复用 result(24px 大圆标):通知条目塞 24px 圆标会喧宾夺主,
  // 且 result 族按「结果视图」语义组织(成功/失败大字),与「一条提示」的密度诉求不同。
  // close 一并放这里:toast.html 是它唯一的消费者(其余页面的 ✕ 走 ui.css .win-close)。
  const toast = {
    info: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.2"/><path d="M8 6.9v4.1M8 4.7v.2" stroke-linecap="round"/></svg>',
    ok: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.2"/><path d="M5.3 8.2l1.9 1.9 3.5-3.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2.6 14.6 13.6H1.4z"/><path d="M8 6.6v3M8 11.4v.2" stroke-linecap="round"/></svg>',
    err: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.2"/><path d="M5.9 5.9l4.2 4.2M10.1 5.9L5.9 10.1" stroke-linecap="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  };
  // 命令面板(阶段 2):search 同时供 titlebar.html 的命令入口胶囊按钮与 palette.html 的输入行使用,
  // 二者是同一个语义("搜索或跳转"),放两处会各自漂移成两种放大镜。
  const palette = {
    search: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4 14 14" stroke-linecap="round"/></svg>',
  };
  window.UI_ICONS = { result, activity, menu, cmdbar, toast, palette };
})();
