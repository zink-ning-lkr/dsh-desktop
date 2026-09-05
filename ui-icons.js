/* ui-icons.js —— 全部自绘页面共享的 SVG 图标常量(单一事实源,P1-2)。
   用法:<script src="ui-icons.js"></script> 置于页面自身脚本之前(CSP script-src 'self' 已允许),
   经 window.UI_ICONS 访问:UI_ICONS.result.info / UI_ICONS.activity.download / UI_ICONS.menu['open-workspace']。
   描边规范:result/activity 族 viewBox 24(线性图标);menu 族 viewBox 16、固定 15×15。
   原三份逐字符重复的定义(status RES / dialog ICONS / menu ICONS)已收编至此,改图标只改这一处。 */
(function () {
  const result = {
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.2" stroke-linecap="round"/></svg>',
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M8 12.2l2.7 2.7L16 9.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
    'quit': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2v5M4.5 4a5 5 0 1 0 7 0"/></svg>',
    'tray-status': '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/></svg>',
  };
  window.UI_ICONS = { result, activity, menu };
})();
