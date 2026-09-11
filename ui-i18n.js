/* ui-i18n.js —— 渲染层文案层(单一事实源):t() 实现只此一份。
   背景:10 个 preload 各写一份「sendSync 拉表 + __i18n.t()」,取值/占位符约定改一处漏九处。
   sandbox preload 不能 require 项目文件,故分工调整为:
   ① preload 只拉一次快照并暴露 __i18nTable(纯数据,见各 *-preload.js);
   ② 本文件(经典脚本,与 ui-theme.js 同层,页面 <head> 引用)读 __i18nTable,定义 window.__i18n.t()。
   页面用法不变:const T = (k, p) => window.__i18n.t(k, p)。
   本文件须在页面自身脚本之前加载(CSP script-src 'self' 已允许)。 */
(function () {
  const TABLE = window.__i18nTable || {};
  window.__i18n = {
    // 与主进程 i18n.js 同一取值/占位符约定,表缺失回退 key
    t: (key, params) => {
      let s = TABLE[key] || key;
      if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
      return s;
    },
  };
})();
