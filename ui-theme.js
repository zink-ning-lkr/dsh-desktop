/* ui-theme.js —— 全部自绘页面共享的主题探针(单一事实源)。
   按 prefers-color-scheme 在 <html> 上写 data-theme="light",ui.css 的令牌覆写随即生效。
   主题链:config.theme(auto/dark/light) → 主进程 nativeTheme.themeSource
   → 渲染层 matchMedia 自动跟随(system 时随 OS 实时切换,dark/light 为强制)。
   附带:带 data-logo 的 <img>(鲸鱼 logo)按主题切换黑白版——浅色背景下白鲸不可见。
   (标题栏 logo 例外:它跟随 dsh 页面采样色而非主题,由 titlebar.html 自行处理)
   用法:<script src="ui-theme.js"></script> 置于页面 <head>(CSP script-src 'self' 已允许)。 */
(function () {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const apply = () => {
    const light = mq.matches;
    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    for (const img of document.querySelectorAll('img[data-logo]')) {
      img.src = 'assets/whale-' + (light ? 'black' : 'white') + '.png';
    }
  };
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else if (mq.addListener) mq.addListener(apply); // 旧内核兜底
  apply();
  // <head> 期执行时 body 尚未解析:图片元素要等 DOMContentLoaded 后才存在,补一次
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
})();
