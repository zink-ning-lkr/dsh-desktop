// DSH Desktop —— DeepSeek Harness (dsh) 的桌面壳。
// 托盘常驻(关闭默认收进后台)、自绘菜单、深色主题;会话/文件/设置与本体完全共享。
// 原理:以用户选的工作目录为 cwd,后台启动本体 `dsh web`,从 stdout 解析实际地址,
// 窗口加载该地址。不动 $DSH_HOME,因此会话/设置/插件/文件与本体 dsh 完全共享。
//
// 模块划分(本文件只负责窗口/视图/托盘/菜单/辅助窗与生命周期编排):
//   core.js          配置读写/日志缓冲与轮转/token 脱敏/限时 execSync/共享常量
//   dsh-process.js   dsh 子进程域:定位 node/dsh、启动与地址解析、等待就绪、进程树终止、启动快照
//   updates.js       双通道更新(桌面端 GitHub Releases + dsh 本体 npm),共享状态集中在 state
//   diagnostics.js   错误诊断(收集 → 归类 → 渲染 → 落盘)
//   uitest.js        自动化冒烟编排(SMOKE/DEMO/UITEST,不参与生产路径)
//
// UI 层(除 dsh 页面本身):
//   - titlebar.html  自绘标题栏(可收起)
//   - loading.html   dsh 启动加载页(阶段提示 + 日志尾巴)
//   - menu.html      主菜单/托盘菜单弹层
//   - status.html    统一状态窗(检查更新/下载/安装/结果,可挂后台)
//   - dialog.html    通用深色对话框(替代原生 MessageBox)
//   - report.html    错误报告窗(启动失败/进程退出,一键导出)
// 单一 uncaughtException 处理器(原两处重叠注册已合并;Node 官方警告异常后继续运行
// 状态未定义,必须记录后主动退出,而非静默放行)。
// 模块加载期(下方 require 全部完成之前)触发的异常同样由本处理器兜底:崩溃记录部分
// 用内联 require 完成,不依赖尚未初始化的模块级绑定;其余(日志/报告/退出)逐段 try 兜底,
// 避免 TDZ 或依赖缺位导致处理过程中二次抛错。
let crashHandling = false; // 防重入:处理期间的二次异常不再递归
process.on('uncaughtException', (err) => {
  if (crashHandling) return;
  crashHandling = true;
  try {
    // 崩溃记录写入 userData(打包后 __dirname 是只读 asar,写那里会静默失效)
    try {
      let ud = null;
      try { ud = require('electron').app.getPath('userData'); } catch { /* electron/app 未就绪 */ }
      const cf = require('node:path').join(ud || __dirname, 'CRASH.txt');
      // 轮转:崩溃记录不宜无限膨胀(异常频繁时每次追加),超 2MB 归档 .old
      try {
        const fs2 = require('node:fs');
        if (fs2.statSync(cf).size > 2 * 1024 * 1024) {
          try { fs2.renameSync(cf, cf + '.old'); } catch { /* 归档失败继续追加 */ }
        }
      } catch { /* 文件尚不存在 */ }
      require('node:fs').appendFileSync(cf, `${new Date().toISOString()}\n${err.stack || err}\n`);
    } catch (e) { /* 无法落盘 */ }
  } catch (e) { /* 处理器自身异常:直接退出,避免递归 */ try { process.exit(1); } catch {} return; }
  // 模块加载期只负责落盘 + 退出,其余逻辑依赖的绑定此时可能尚未初始化,先硬退出
  try { app; } catch { try { process.exit(1); } catch {} return; }
  try {
    // 日志系统在 core.js;崩溃发生在该模块加载完成之前时 require 会重抛原始错误,逐段 try 兜底
    const core = require('./core');
    core.log(`未捕获异常: ${err.stack || err}`);
    core.flushLog(); // 日志缓冲即时刷盘,保证崩溃现场进入 dsh-web.log
  } catch (e) { /* 日志系统未就绪,忽略 */ }
  // 生成错误报告落盘(不弹窗,避免打扰);仅当 app 已就绪且能取到路径
  try {
    if (app.isReady()) {
      const core = require('./core');
      const dshProc = require('./dsh-process');
      const snap = dshProc.getBootSnapshot();
      const ctx = {
        app, screen, phase: 'uncaught', error: err, code: null, buf: snap.buf,
        logFile: core.logFile, crashFile: core.crashFilePath(), configPath: core.configPath(),
        workspace: core.loadConfig().workspace, userData: app.getPath('userData'),
        dshBin: dshProc.findDshBinSafe(), nodeExe: dshProc.findNodeSafe(), args: snap.args,
        elapsedMs: snap.startedAt ? Date.now() - snap.startedAt : null,
      };
      try { diagnostics.buildReport(ctx); } catch (e2) { core.log(`诊断落盘失败: ${e2.message}`); }
    }
  } catch (e3) { /* 模块加载期 app 未就绪等,忽略 */ }
  // 记录完毕主动退出:走 app.quit() 会触发 before-quit 正常清理(dsh 子进程树 + 日志);
  // app 不可用(未初始化/已损坏)时退硬退出兜底
  try { app.quit(); } catch { try { process.exit(1); } catch {} }
});
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeTheme, screen, shell, session, WebContentsView, Notification, clipboard } = require('electron');
const { exec } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const diagnostics = require('./diagnostics');
const { DEFAULT_SEGMENTS } = require('./downloader');
// 拆分的三个主进程模块:core(配置/日志/脱敏)、dsh-process(dsh 子进程域)、
// updates(双通道更新)。解构导出保持本文件既有调用点不变
const core = require('./core');
const { log, flushLog, logFile, loadConfig, saveConfig, configPath, crashFilePath, redactToken, ACCEL_SEGMENTS_MIN, ACCEL_SEGMENTS_MAX } = core;
const shortcuts = require('./shortcuts'); // 快捷键单一数据源(P2-2):菜单文案/accelerator/速查浮层共用
const commands = require('./commands'); // 命令注册表(阶段 2):☰ 菜单 / 命令面板 / 托盘菜单共用同一份条目
const i18n = require('./i18n'); // 文案集中(P2-6 结构先行):主进程自绘文案渐进收编,渲染层后续接入
const { t } = i18n;
const dshProc = require('./dsh-process');
const { findDshBinSafe, findNodeSafe, dshVersion, killTree } = dshProc;
const updates = require('./updates');
const { IS_PORTABLE } = updates;

const IS_WIN = process.platform === 'win32';
// Windows 规范:固定 AppUserModelID,保证任务栏图标/分组/通知归属正确
if (IS_WIN) app.setAppUserModelId('com.zinkning.dsh-desktop');
// Win11 判定(build ≥ 22000):Mica/Acrylic 系统材质仅 Win11 可用(P2-3 试点 reportWin)
function isWin11() {
  if (!IS_WIN) return false;
  const m = os.release().match(/^10\.0\.(\d+)$/);
  return !!m && parseInt(m[1], 10) >= 22000;
}
// 后台/遮挡时不挂起 dsh 页面:避免对话正在工作时切走再切回触发重连/视图重建/滚动重置。
// 保活核心 = dshView 的 backgroundThrottling:false(per-view);全局开关保留与 Windows 遮挡
// 判定强相关的两个;disable-background-timer-throttling 已明确被 per-view 覆盖(零风险),
// 移除后辅助窗口/标题栏等后台 timer 恢复节流,省 CPU/电量(内存优化方案 P0-4)。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// 本地磁盘/内存缓存限额:避免 userData 缓存无限增长(内存优化方案 P1-2)
app.commandLine.appendSwitch('disk-cache-size', String(64 * 1024 * 1024));
// 主题决策链:config.theme(auto/dark/light,默认 auto 跟随系统) → themeSource。
// 渲染层经 ui-theme.js 的 matchMedia 自动跟随(themeSource=system 时随 OS 实时切换)
const THEME_SOURCE = { auto: 'system', dark: 'dark', light: 'light' };
function applyTheme() {
  const t = loadConfig().theme || 'auto';
  nativeTheme.themeSource = THEME_SOURCE[t] || 'system';
}
applyTheme();

let mainWindow = null;
let dshChild = null;
let bootSeq = 0; // 递增序号:重启后,旧一次 boot 的回调不再生效
let quitting = false;
let cleaned = false;
let quitConfirmShown = false; // 退出确认对话框是否已弹出(防 before-quit 反复触发时重复弹)
let forceQuit = false;        // 用户在确认框中确认退出:跳过再次确认
let quitCleanup = null;       // 退出时的进程树清理 Promise(重入 before-quit 时等待同一同步点)
let dshWebUrl = null; // 当前 dsh web 服务地址(供"在浏览器中打开"使用)
let dsh431Healed = false; // 431 自愈只做一次:防止清不掉时的重载风暴

// 清理历史 dsh 会话 Cookie(v0.6.3 修复"桌面端空白而浏览器正常")。
// 根因:dsh 每个实例使用随机命名的会话 Cookie(dsh-auth-<随机>,30 天有效,Cookie 不分端口),
// 在 127.0.0.1 域下只增不减;dsh 0.1.2-rc.1 起服务端拒绝过大的请求头(约 16KB,HTTP 431 空响应),
// 累积越限后壳内加载服务页得到空文档(无任何失败日志),表现为桌面端空白而浏览器正常。
// 每次加载服务页前清掉服务宿主上的 dsh 命名空间 Cookie(不影响其他本地应用)。
async function clearDshAuthCookies(serviceUrl) {
  try {
    const u = new URL(serviceUrl);
    const stale = await session.defaultSession.cookies.get({ url: `${u.protocol}//${u.hostname}` });
    const dshCookies = stale.filter((c) => c.name.startsWith('dsh-auth-'));
    for (const c of dshCookies) {
      await session.defaultSession.cookies.remove(`${u.protocol}//${u.hostname}${c.path || '/'}`, c.name);
    }
    if (dshCookies.length) log(`已清理历史 dsh 会话 Cookie ${dshCookies.length} 枚(防请求头超限 431)`);
  } catch (e) { log(`清理 dsh Cookie 失败: ${e.message}`); }
}
// 最近一次启动的 stdout 尾/参数/时刻由 dsh-process 的 getBootSnapshot() 提供(错误报告与崩溃诊断用)

// ---------- 窗口:无边框主窗 + 自绘标题栏(上) + dsh 内容(下) ----------
// dsh 页面从标题栏下方开始渲染,与窗口按钮物理隔离,永不重叠。
// 标题栏可收起(滑动动画),收起后顶部中央出现下拉把手;F11 全屏时自动收起。
const TITLEBAR_H = 30;
// 注:标题栏刻意不向下多占重叠区——旧版 BAR_OVERLAP=10 让标题栏视图覆盖页面顶端 10px,
// 而该区实际是不透明的(视图表面底色 + html 实色背景把渐变完全遮住),等于把 dsh 页面顶部
// 裁掉一截,视觉突兀;主题跟随下栏底色与页面一致,栏底与页面顶边在 30px 处自然无缝
const TITLE_BAR_DEFAULT = '#0d1117';
// 窗口/视图画布底色随主题:浅色主题下启动首帧与未绘制边缘不再露深色(loading 页底色即
// --c-bg0,与画布同色才无缝);主题切换时对窗口内全部自绘页即时生效
function chromeBgColor() {
  return nativeTheme.shouldUseDarkColors ? TITLE_BAR_DEFAULT : '#ffffff';
}
let dshView = null;
let titlebarView = null;
let revealTabView = null;
let menuPopupView = null;
let barVisible = true;
let barBeforeFullscreen = true; // 进全屏前的标题栏可见性:退出全屏时恢复原状(而非强制显示)
let barBeforeHtmlFullscreen = true; // dsh 页面内元素全屏(HTML5)前的标题栏可见性:退出时恢复
let currentBarH = TITLEBAR_H;
let barAnim = null;
let menuClosedAt = 0; // 弹层最后关闭时刻:防"点按钮关闭→blur 先关→点击又打开"的抖动
let menuQueued = null; // 菜单页未加载完成时排队的载荷(极快点击首帧不丢失)

function layoutViews() {
  if (!mainWindow || !titlebarView || !dshView) return;
  const [w, h] = mainWindow.getContentSize();
  // 展开时标题栏高度 = 逻辑栏高,与页面完全不重叠;收起时完全隐藏
  titlebarView.setBounds({ x: 0, y: 0, width: w, height: currentBarH });
  dshView.setBounds({ x: 0, y: currentBarH, width: w, height: Math.max(0, h - currentBarH) });
  // 把手默认隐藏,由 handlePoll 检测到鼠标靠近顶部中央时再浮现
  revealTabView?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  // 通知宿主贴主窗右上角,主窗尺寸/命令栏高度一变就必须跟着走(X1)。
  // 挂在这里而不是各处 resize 分支:layoutViews 已是"任何几何变化都要调一次"的汇合点
  syncToastBounds();
}

// 强制视图 surface 与逻辑尺寸同步。首次显示时,窗口的实际显示尺寸(高 DPI 下的
// devicePixelRatio 换算、系统对超出屏幕窗口的收缩等)可能与 show 之前预设的
// bounds 不同步,表现为界面右侧/底部有一条未绘制的暗色区域,拖拽窗口边缘后恢复。
// 把宽度先收 1px 再恢复,迫使 Chromium 重算渲染 surface(值相同时 setBounds 不触发重算)。
function forceViewRelayout() {
  if (!mainWindow || !dshView) return;
  try {
    const b = dshView.getBounds();
    if (b.width <= 1) return;
    dshView.setBounds({ x: b.x, y: b.y, width: b.width - 1, height: b.height });
    dshView.setBounds(b);
  } catch { /* 窗口销毁中,忽略 */ }
}

// ---------- 把手浮现:标题栏隐藏期间轮询鼠标位置,靠近顶部中央才显示 ----------
const HANDLE_ZONE = { w: 280, h: 34 }; // 基础感应区(比把手本身大;上浮后按 1.5 倍迟滞,防闪烁)
const HANDLE_W = 96, HANDLE_H = 26; // 把手本体尺寸(高 ≥24px 最小点击目标;原 64×20 偏小且易漏触)
let handlePoll = null;
let handleShown = false; // 迟滞状态记忆:已上浮后扩大判定区再收,避免边界抖动

// ---------- 首次收起的把手演示(S3) ----------
// 问题:收起标题栏后,恢复入口只在鼠标进入顶部中央感应区时才浮现。这个机制本身很扎实
// (防闪烁、防空转、1.5× 迟滞),但没有任何视觉线索告诉用户"把手在这儿" —— 新用户收起
// 标题栏后极可能以为窗口坏了(此前只在 README 里用文字说明覆盖)。
// 做法:首次收起时让把手自己浮出来、呼吸 3s 再隐去,用一次演示替代文字说明;
// 之后完全交回"悬停才浮现"的既有机制。靠配置项 handleHintShown 保证只演示一次。
const HANDLE_HINT_MS = 3000;
let handleHintActive = false;
let handleHintTimer = null;

function markHandleHintSeen() {
  // 写失败不阻断:最坏结果是下次再演示一遍,属无害
  try {
    const cfg = loadConfig();
    if (!cfg.handleHintShown) { cfg.handleHintShown = true; saveConfig(cfg); }
  } catch { /* 配置不可写 */ }
}

function beginHandleHint() {
  if (handleHintActive || !mainWindow || !revealTabView) return;
  handleHintActive = true;
  handleShown = true; // 与轮询共用同一份"已上浮"记忆:演示结束交回轮询时不会先闪一下
  const [w] = mainWindow.getContentSize();
  // 演示期间由本函数独占 bounds:轮询看到 handleHintActive 会直接跳过(见 startHandlePolling),
  // 否则鼠标一移开就会被 80ms 轮询收走,3s 驻留根本走不完
  revealTabView.setBounds({ x: Math.floor(w / 2 - HANDLE_W / 2), y: 0, width: HANDLE_W, height: HANDLE_H });
  const wc = revealTabView.webContents;
  // 视图可能仍在加载(document 未就绪时 send 会被丢弃):加载完成钩子里补发一次
  if (!wc.isLoading()) { try { wc.send('tb:handle-hint', true); } catch { /* 竞态 */ } }
  handleHintTimer = setTimeout(endHandleHint, HANDLE_HINT_MS);
}

function endHandleHint() {
  if (!handleHintActive) return;
  handleHintActive = false;
  clearTimeout(handleHintTimer);
  handleHintTimer = null;
  try { revealTabView?.webContents.send('tb:handle-hint', false); } catch { /* 竞态 */ }
  revealTabView?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  handleShown = false;
  markHandleHintSeen();
}

// 下拉把手懒创建(内存优化 P0-1):只有标题栏收起时才需要这个 96×26 的视图,
// 展开时销毁——避免一个几乎空白的渲染进程常驻(典型 50-90MB)
function ensureRevealTab() {
  if (!mainWindow) return;
  if (revealTabView && !revealTabView.webContents.isDestroyed()) return;
  revealTabView = new WebContentsView({
    webPreferences: { sandbox: true, spellcheck: false, preload: path.join(__dirname, 'titlebar-preload.js') },
  });
  revealTabView.setBackgroundColor('#00000000'); // 圆角处的透明角落不露白
  revealTabView.webContents.loadFile(path.join(__dirname, 'reveal-tab.html')).catch(() => {});
  // S3:首次收起与把手视图创建是同一时刻发生的,提示可能在 document 就绪前就置位了 ——
  // 加载完成补发一次(捕获局部引用:此间视图可能已被销毁重建)
  const v = revealTabView;
  v.webContents.once('did-finish-load', () => {
    if (!handleHintActive || !v.webContents || v.webContents.isDestroyed()) return;
    try { v.webContents.send('tb:handle-hint', true); } catch { /* 竞态 */ }
  });
  mainWindow.contentView.addChildView(revealTabView);
  layoutViews();
}
function destroyRevealTab() {
  if (!revealTabView) return;
  const v = revealTabView;
  revealTabView = null;
  try { mainWindow.contentView.removeChildView(v); } catch { /* 窗口销毁中 */ }
  try { v.webContents.close(); } catch { /* 已销毁 */ }
}

function startHandlePolling() {
  if (handlePoll) return;
  handleShown = false;
  ensureRevealTab(); // 收起态:确保把手视图存在(可见性由轮询中的 bounds 控制)
  // S3:仅首次收起时演示一次;之后完全交回"悬停才浮现"
  if (!loadConfig().handleHintShown) beginHandleHint();
  handlePoll = setInterval(() => {
    if (!mainWindow || !mainWindow.isVisible() || !revealTabView || barVisible || currentBarH > 0) return; // 收托盘后台时不空转
    if (handleHintActive) return; // 演示期间 bounds 归提示独占,轮询不得插手
    try {
      const p = screen.getCursorScreenPoint();
      const b = mainWindow.getBounds(); // 无边框窗口,bounds 即内容区
      const cx = b.x + b.width / 2;
      // 迟滞:已上浮后判定区扩大 1.5 倍;80ms 轮询(原 150ms 会让快速划过顶部漏触发)
      const zw = handleShown ? HANDLE_ZONE.w * 1.5 : HANDLE_ZONE.w;
      const zh = handleShown ? HANDLE_ZONE.h * 1.5 : HANDLE_ZONE.h;
      const inZone = p.x >= cx - zw / 2 && p.x <= cx + zw / 2
        && p.y >= b.y && p.y <= b.y + zh;
      if (inZone) {
        handleShown = true;
        const [w] = mainWindow.getContentSize();
        revealTabView.setBounds({ x: Math.floor(w / 2 - HANDLE_W / 2), y: 0, width: HANDLE_W, height: HANDLE_H });
      } else if (handleShown) {
        handleShown = false;
        revealTabView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    } catch { /* 窗口销毁等 */ }
  }, 80);
}

function stopHandlePolling() {
  clearInterval(handlePoll);
  handlePoll = null;
  handleShown = false;
  // S3:演示进行中被还原(用户点了把手 / 快捷键 / 菜单还原标题栏):演示已达成目的,
  // 落盘记忆并清计时 —— 但不能走 endHandleHint,它会对即将销毁的视图 setBounds
  if (handleHintActive) {
    handleHintActive = false;
    clearTimeout(handleHintTimer);
    handleHintTimer = null;
    markHandleHintSeen();
  }
  destroyRevealTab(); // 展开/退出:销毁把手视图,释放渲染进程
}

function toggleTitlebar(visible, animated = true) {
  if (barVisible === visible) return;
  barVisible = visible;
  closeMenuPopup();
  if (visible) stopHandlePolling();
  clearInterval(barAnim);
  if (!animated) {
    currentBarH = visible ? TITLEBAR_H : 0;
    layoutViews();
    if (!visible) startHandlePolling();
    return;
  }
  // 平滑滑动:240ms easeInOutCubic,60fps 单定时器按时间戳插值。
  // 原实现:120fps 链式 setTimeout,动画期间每一帧都对 dshView setBounds → 整个页面视图
  // 逐帧重排重绘,8ms 帧预算被布局占满后逐帧漂移,表现为卡顿。
  // 现在:固定 60fps 单 interval,无累积漂移;整数高度未变化时跳过布局(亚像素区间零开销);
  // 结束精确落位,防取整误差残留。
  const from = currentBarH;
  const to = visible ? TITLEBAR_H : 0;
  const startedAt = Date.now();
  const DURATION_MS = 240;
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  barAnim = setInterval(() => {
    const t = Math.min(1, (Date.now() - startedAt) / DURATION_MS);
    const next = Math.round(from + (to - from) * easeInOutCubic(t));
    if (next !== currentBarH) {
      currentBarH = next;
      layoutViews();
    }
    if (t >= 1) {
      if (currentBarH !== to) { currentBarH = to; layoutViews(); }
      clearInterval(barAnim);
      barAnim = null;
      if (!visible) startHandlePolling();
    }
  }, 1000 / 60);
}

function toggleFullscreen() {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
}

// 标题栏「关闭」按钮 tooltip 随设置联动(收托盘 vs 直接退出),避免「关闭=消失」的误解
function sendCloseTip() {
  titlebarView?.webContents.send('tb:close-tip', loadConfig().closeAction !== 'quit' ? t('tip.closeTray') : t('tip.closeQuit'));
}

// 恢复上次关闭时的窗口位置/大小/最大化状态(显示器变更后旧坐标可能失效,校验与任一工作区有交集才恢复)
function applyWindowState() {
  try {
    const cfg = loadConfig();
    const b = cfg.winBounds;
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && b.width >= 960 && Number.isFinite(b.height) && b.height >= 600) {
      const visible = screen.getAllDisplays().some((d) => {
        const wa = d.workArea;
        return b.x + 60 < wa.x + wa.width && b.x + b.width - 60 > wa.x && b.y + 60 < wa.y + wa.height && b.y + b.height - 60 > wa.y;
      });
      if (visible) mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    }
    if (cfg.winMaximized) mainWindow.maximize();
  } catch { /* 状态恢复失败,用默认窗口 */ }
}

// ---------- 托盘:关闭窗口默认最小化到后台,托盘可恢复/退出 ----------
let tray = null;
let trayMenuWin = null; // 托盘右键的自绘菜单(独立小窗,与主菜单同款 UI)

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------- 托盘状态(P0-3):tooltip 动态化 + 状态角标 + 菜单首行只读状态项 ----------
// 三档状态:boot(启动中,黄点) / ok(运行中,绿点) / err(已停止或崩溃,红点);
// 收托盘后用户一眼可知 dsh 死活,崩溃不再无感知(参照 Discord presence 的状态外显)
let trayState = 'boot';  // 应用启动即进入 boot,bootDsh 成功加载服务页后转 ok
let trayStartedAt = 0;   // 最近一次进入 ok 的时间戳(菜单运行时长)
// 错误级通知未处理标志(阶段 1 X1):与 trayState(服务真值)分开表达——
// 一次「更新失败」不该让托盘 tooltip 谎报「服务已停止」,但红角标必须亮到用户处理为止。
// 只影响托盘图标,trayState 本身不动 ⇒ 命令栏状态点仍如实反映服务状态。
let notifyErrPending = false;

function trayStatusText() {
  const st = trayState === 'ok' ? t('tray.running') : trayState === 'boot' ? t('tray.booting') : t('tray.stopped');
  let dl = '';
  for (const t of statusTasks.values()) { // 任一进行中下载任务(任务中心模型,P1-1)
    if (!t.done && t.mode === 'download' && t.pct) {
      // 进度取整到整数百分点:tooltip 按 1% 粒度变化,配合 refreshTray 同值短路,
      // 下载期间不再以 ~150ms 一次的频率重设托盘(0.1% 级的字符串抖动穿透不了缓存)
      const n = parseFloat(t.pct);
      dl = i18n.t('tray.downloadingPct', { n: Number.isFinite(n) ? Math.round(n) : t.pct }); // 循环变量 t 遮蔽文案函数,此处走 i18n.t
      break;
    }
  }
  const ws = loadConfig().workspace || '';
  return `DSH Desktop — ${st}${dl}${ws ? ` · ${ws}` : ''}`;
}

// 同值短路缓存:进度帧(pushTasks)每 150ms 到达一次,tooltip/图标仅在内容真变时才触碰系统 API——
// 否则整个下载期间托盘图标与 tooltip 以 ~7 次/秒被全量重设(无谓系统调用 + 潜在图标闪烁)
let trayLastTip = null;
let trayLastIcon = null;
function refreshTray() {
  // 命令栏状态簇与托盘用同一份数据(托盘态/进行中任务/工作目录),也在同一时机刷新:
  // 挂在 refreshTray 上而不是散在各个状态变更点,新增状态变更时不会漏刷。
  pushTitlebarStatus();
  if (!tray) return;
  const tip = trayStatusText();
  if (tip !== trayLastTip) { trayLastTip = tip; tray.setToolTip(tip); }
  // 角标图标为构建期预生成资产;缺失(旧包升级)时回退基础图标,不阻断状态文字。
  // 未处理的错误级通知优先压红角标(见 notifyErrPending):它比服务运行状态更紧急
  const iconState = notifyErrPending ? 'err' : trayState;
  const p = path.join(__dirname, 'assets', iconState === 'ok' ? 'icon-ok.ico' : iconState === 'boot' ? 'icon-warn.ico' : 'icon-err.ico');
  if (p !== trayLastIcon) {
    trayLastIcon = p;
    tray.setImage(fs.existsSync(p) ? p : path.join(__dirname, 'assets', 'icon.ico'));
  }
}

function setTrayState(s) {
  const changed = trayState !== s;
  trayState = s;
  if (s === 'ok' && changed) trayStartedAt = Date.now();
  refreshTray(); // 内部会一并刷新命令栏状态簇(阶段 1 S1)
}

// ---------- 命令栏状态簇推送(阶段 1 S1) ----------
// 托盘态 / 进行中任务数 / 更新可用性 / 主题模式四个字段整体推给 titlebar 渲染层。
// 整推而非按字段增量:载荷只有 5 个短字段,整推更容易保证两侧一致,调用方也不必
// 记得"这次改的是哪个字段"。调用点只有一处(refreshTray),故新增状态变更不会漏刷。
// 同值短路:内容没变就一个 IPC 都不发 —— 这条让本函数可以安全地挂在每 150ms 一次的
// 进度帧路径上。唯一的例外是下载期间 svcText 里的百分比,它按 1% 粒度变化,属预期。
let titlebarStatusLast = null;
function pushTitlebarStatus() {
  try {
    const wc = titlebarView && !titlebarView.webContents.isDestroyed() ? titlebarView.webContents : null;
    if (!wc) return;
    // 「进行中」= 未完成的任务。瞬时提示不再是任务(状态窗已卸下 toast 宿主职责,X1)
    let tasks = 0;
    for (const task of statusTasks.values()) if (!task.done) tasks++;
    const payload = {
      svc: trayState,                 // ok / boot / err → 服务点颜色
      svcText: trayStatusText(),      // 含运行时长与工作目录,与托盘 tooltip 同源
      tasks,                          // 0 → 渲染层整钮隐藏
      update: !!(updates.state.pendingVersion || updates.state.updateDownloaded),
      themeMode: loadConfig().theme || 'auto', // auto / dark / light → 渲染层映射文案
    };
    const key = JSON.stringify(payload);
    if (key === titlebarStatusLast) return; // 同值短路:进度帧不产生 IPC
    titlebarStatusLast = key;
    wc.send('tb:status', payload);
  } catch { /* 窗口销毁竞态等,忽略 */ }
}

// 命令栏「更新徽标」的可用性真值源在 updates.js(state.pendingVersion 的两次变更);
// 它经 init 注入的 onUpdateStateChange 回调回来 → 这里刷新徽标。
// 渲染层未就绪时会话失败也无妨:同值短路保证下次推送仍是最终态。

// 任务徽标点击 → 把任务中心拉回前台。窗口不存在时不凭空造一个空窗:
// 徽标的前提就是有进行中任务,而任务都会 ensureStatusWindow(),二者不会脱节。
function focusStatusWindow() {
  if (!statusWin || statusWin.isDestroyed()) return;
  if (statusWin.isMinimized()) statusWin.restore();
  statusWin.show();
  statusWin.focus();
}

// 命令栏工作目录点击 → 复制完整路径(S1)。反馈走通知统一出口(阶段 1 X1):
// 此处只表达"要说什么",落点(应用内 toast / 系统通知)由 notify() 按主窗是否在屏裁决。
function copyWorkspacePath() {
  const ws = loadConfig().workspace || '';
  if (!ws) return;
  clipboard.writeText(ws);
  log(`已复制工作目录路径: ${ws}`);
  notify(t('cmdbar.wsCopied'), { tone: 'ok' });
}

function trayMenuStatusLabel() {
  const st = trayState === 'ok' ? t('tray.running') : trayState === 'boot' ? t('tray.booting') : t('tray.stopped');
  let up = '';
  if (trayState === 'ok' && trayStartedAt) {
    const m = Math.floor((Date.now() - trayStartedAt) / 60000);
    up = m < 1 ? t('tray.upJustNow') : m < 60 ? t('tray.upMin', { n: m }) : t('tray.upHourMin', { h: Math.floor(m / 60), m: m % 60 });
  }
  const v = dshProc.dshVersion() || '';
  return `dsh${v ? ` v${v}` : ''} · ${st}${up}`;
}

// 托盘菜单(阶段 2):条目元信息取自注册表(commands.js),加速键与勾选态不再各写一份。
// 两处有意不回注册表:① tray-status 是只读状态行,不属命令域;② check-update 在托盘用短文案——
// 托盘菜单宽固定 264px,'检查更新…(便携版请手动下载)' 会被省略号截掉,托盘场景要的是"能点就行"。
// show-main 只进托盘与命令面板(主窗隐藏时从托盘/面板唤起),故注册表里标了 menu:false。
function trayMenuItems() {
  const ctx = commandCtx();
  const pick = (id) => {
    const c = commands.list.find((x) => x.id === id);
    const it = { type: 'item', id, label: commands.labelOf(c, ctx) };
    const accel = commands.accelOf(id);
    if (accel) it.accel = accel;
    const checked = commands.checkedOf(c, ctx);
    if (checked !== undefined) it.checked = checked;
    return it;
  };
  return [
    { type: 'item', id: 'tray-status', label: trayMenuStatusLabel(), enabled: false }, // 只读状态行(P0-3)
    { type: 'sep' },
    pick('show-main'),
    pick('open-workspace'),
    { type: 'item', id: 'check-update', label: IS_PORTABLE ? t('menu.checkUpdate') : t('menu.checkUpdateCurrent', { v: app.getVersion() }) },
    { type: 'sep' },
    pick('close-to-tray'),
    { type: 'sep' },
    pick('quit'),
  ];
}

function closeTrayMenu() {
  trayMenuWin?.destroy();
  trayMenuWin = null;
}

// 在托盘光标处弹出自绘菜单(向上展开,贴屏幕边缘自适应)
function showTrayMenu() {
  closeTrayMenu();
  closeMenuPopup(true); // 与主菜单弹层互斥:托盘菜单弹出时收起主菜单
  const items = trayMenuItems();
  let mh = 20; // 上下内边距(.panel padding 10px × 2)
  // 逐项高度须与 menu.html 的 .item/.sep 实际盒高一致(.item 32px、.sep 1+8=9px),否则菜单底部被裁
  for (const it of items) mh += it.type === 'sep' ? 9 : 32;
  const W = 264 + 24, H = mh + 24; // 含阴影边距,与主菜单一致
  const cursor = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cursor).workArea;
  let x = Math.round(cursor.x - W / 2);
  x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - W - 4));
  let y = cursor.y - H - 10;
  if (y < wa.y + 4) y = cursor.y + 10;

  trayMenuWin = new BrowserWindow({
    x, y, width: W, height: H, useContentSize: true,
    frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, show: false,
    webPreferences: { sandbox: true, spellcheck: false, preload: path.join(__dirname, 'menu-preload.js') },
  });
  trayMenuWin.setMenuBarVisibility(false);
  trayMenuWin.loadFile(path.join(__dirname, 'menu.html')).then(() => {
    if (!trayMenuWin) return;
    trayMenuWin.webContents.send('m:show', { items, w: 264, margin: 12 });
    trayMenuWin.show();
    trayMenuWin.focus();
  }).catch(() => {}); // 窗口早关等取消加载,忽略
  trayMenuWin.on('blur', () => closeTrayMenu());
  trayMenuWin.on('closed', () => { trayMenuWin = null; });
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
  trayLastTip = trayLastIcon = null; // 新实例无任何已设状态:缓存失效,首次 refreshTray 必须全量落地
  refreshTray(); // 动态 tooltip + 状态角标(初始为启动中)
  tray.on('click', () => showMainWindow());
  tray.on('right-click', () => showTrayMenu());
}

// ---------- 统一状态窗(检查更新/下载/安装/结果,可挂后台到任务栏) ----------
let statusWin = null;        // 状态窗实例
let statusMinimized = false; // 处于"挂后台"(最小化到任务栏)状态
let statusQueued = false;    // 窗口未加载完成:任务帧待发标记
let statusPayload = null;    // 最近活动任务载荷(updates.js 兼容读取 / 兜底语义)

// ---------- 任务注册表(P1-1 通知/任务中心) ----------
// 状态窗从"单槽翻页"改为任务列表渲染器:desktop(桌面端更新)与 dsh(本体安装)
// 双流各有独立任务槽,幂等 upsert,多任务并存,完成项保留为历史折叠。
// 旧 API(showStatus/updateStatus/showStatusResult/closeStatus)签名不变、内部映射注册表——
// updates.js 无需感知模型变化;otherFlowActive 双更新流互斥链随之删除(任务不再互相顶掉)。
const statusTasks = new Map();   // id → task { id, mode, title, detail, pct, size, spin, progress, type, buttons, done, ts }
const statusActions = new Map(); // 任务 id → 结果按钮回调(按任务隔离,替代全局单槽)

function taskIdOf(p) { return (p && p.__origin) || 'default'; }

// 下载时把进度同步到任务栏(窗口挂后台也能看到),其余状态清除进度;
// 同时镜像到主窗任务栏图标——状态窗挂后台期间,用户盯着的主窗也能看到下载进度(P1-5)。
// mainWindowProgress 记录镜像值(UITEST 断言用;Windows 无 getProgressBar API)
let mainWindowProgress = -1;
function applyStatusProgress() {
  try {
    let pct = null;
    for (const t of statusTasks.values()) {
      if (!t.done && t.mode === 'download' && typeof t.progress === 'number') { pct = t.progress; break; }
    }
    const v = pct === null ? -1 : Math.max(0, Math.min(1, pct / 100));
    if (statusWin) statusWin.setProgressBar(v);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(v);
    mainWindowProgress = v;
  } catch { /* 窗口已销毁等 */ }
}

// 窗口内容高度:单任务保持旧尺寸(活动 186 / 结果 250,UITEST 锁定);
// 多任务列表按行数增长并封顶 460,超出由列表内部滚动吸收
function statusHeight() {
  const n = statusTasks.size;
  if (n <= 1) {
    const t = statusTasks.values().next().value;
    if (t && t.done) return 250; // 结果视图固定档(UITEST 锁定);瞬时提示已不在此窗渲染(X1)
    return 186;
  }
  const vals = [...statusTasks.values()];
  const act = vals.filter((t) => !t.done).length;
  const done = n - act;
  const collapsed = act > 0 && done > 0; // 有进行中任务时完成项折叠进历史条
  const rows = act + (collapsed ? 0 : done);
  return Math.min(46 + rows * 118 + (collapsed ? 30 : 0) + 12, 460);
}

function statusWinTitle(tasks) {
  if (tasks.length === 1) return tasks[0].title || 'DSH';
  const act = tasks.filter((t) => !t.done).length;
  return act ? i18n.t('status.titleActive', { n: act }) : i18n.t('status.title'); // 过滤参数 t 遮蔽文案函数,此处走 i18n.t
}

// 推送整帧任务数组给渲染器(渲染器单任务时退化为旧单视图,多任务渲染列表)
function pushTasks({ focus = false } = {}) {
  if (!statusWin) return;
  const tasks = [...statusTasks.values()];
  const act = tasks.filter((t) => !t.done);
  statusPayload = act[act.length - 1] || null; // "最近活动载荷":托盘 tooltip/updates 进度守卫读取
  statusWin.setContentSize(410, statusHeight());
  statusWin.setTitle(statusWinTitle(tasks));
  statusWin.webContents.send('st:tasks', tasks);
  applyStatusProgress();
  refreshTray(); // 下载进度/状态变化同步进托盘 tooltip(P0-3)
  // 挂后台(最小化)期间不强制拉起窗口,由桌面通知引导,点击通知再恢复
  // (否则"挂后台=不打扰"被破坏:窗口自己弹回来 + 通知双提醒)
  if (!focus || statusMinimized) return;
  if (statusWin.isMinimized()) statusWin.restore();
  statusWin.show();
  statusWin.focus();
}

function ensureStatusWindow() {
  if (statusWin) return true;
  statusWin = new BrowserWindow({
    width: 410, height: 186, useContentSize: true,
    frame: false, resizable: false, skipTaskbar: false, show: false,
    // Win11 Acrylic 轻量层(P2-3 铺开,v0.6.1):系统材质透出,渲染层经 st:env 加半透明底;Win10 回落实色
    backgroundMaterial: isWin11() ? 'acrylic' : undefined,
    webPreferences: { sandbox: true, spellcheck: false, preload: path.join(__dirname, 'status-preload.js') },
  });
  statusWin.setMenuBarVisibility(false);
  // 与对话框/报告窗一致:在主窗口所在显示器居中(否则副屏用户会在主屏看到状态窗/进度窗)
  centerOn(statusWin, mainWindow);
  statusWin.loadFile(path.join(__dirname, 'status.html')).catch(() => {});
  statusWin.webContents.once('did-finish-load', () => {
    statusQueued = false;
    pushTasks({ focus: true });
  });
  statusWin.on('closed', () => {
    statusWin = null; statusMinimized = false; statusQueued = false;
    statusTasks.clear(); statusActions.clear(); statusPayload = null;
    refreshTray();
  });
  statusWin.on('minimize', () => { statusMinimized = true; });
  statusWin.on('restore', () => { statusMinimized = false; });
  statusQueued = true;
  return false;
}

// 退出确认未决时的复位(「取消」语义):三处触发源复用(点「取消」/确认框被直接关闭/确认框加载失败)。
// 同时复位 cleaned——清理从未执行过,取消后下一次正常退出仍须走 killTree,
// 否则 dsh 复拉后再次退出会跳过清理,让新进程成孤儿
function resetQuitConfirm() {
  if (!quitConfirmShown || forceQuit) return;
  quitConfirmShown = false;
  quitting = false;
  cleaned = false;
  log('退出确认中止,取消退出');
  // 确认框挂着期间安装可能已完成:finish 因 quitting 早退跳过了服务恢复,取消后必须把 dsh 拉回来
  if (!updates.state.dshStoppedForInstall && !dshChild && !updates.state.dshInstallChild) {
    log('拉取 dsh 服务(安装已结束)');
    bootDsh();
  }
}

function showStatus(p) {
  const id = taskIdOf(p);
  // 幂等 upsert:同一任务源重复 show(如重新检查)只更新自己的槽位,不影响另一流任务
  statusTasks.set(id, { ...statusTasks.get(id), ...p, id, done: false, ts: Date.now() });
  if (!ensureStatusWindow()) return; // 窗口加载中:did-finish-load 统一补发
  pushTasks({ focus: true });
}

function updateStatus(patch) {
  const id = taskIdOf(patch);
  const cur = statusTasks.get(id);
  if (!cur) return; // 任务已被取消/窗口已关:迟到进度帧丢弃
  statusTasks.set(id, { ...cur, ...patch, id });
  if (!statusWin || statusQueued) return;
  pushTasks(); // 进度帧不抢焦点
}

function dismissTask(id) {
  statusTasks.delete(id);
  statusActions.delete(id);
  if (!statusTasks.size) { closeStatus(); return; } // 最后一条关闭即收窗(保持旧 ✕ 语义)
  pushTasks();
}

function closeStatus() {
  statusWin?.destroy();
  statusWin = null;
  statusQueued = false;
  statusTasks.clear();
  statusActions.clear();
  statusPayload = null; // 清残留:否则 result 残留会让后续 nonIntrusive 结果被永久跳过
  try { mainWindow?.setProgressBar(-1); } catch { /* 已销毁 */ } // 清主窗任务栏进度镜像
  refreshTray(); // 状态窗关闭,tooltip 去掉"下载中"段
}

// ---------- 通知统一出口(阶段 1 X1) ----------
// 背景:"已复制""已切换外观"这类零成本确认,此前在三种载体间摇摆——就地闪一下、挤进状态窗
// (而状态窗只在有任务时才存在)、或直接走系统通知(打断性过强)。本批把三处收成一个出口。
//
// 载体是主窗右上角的一扇独立透明窗,而不是主窗内的 WebContentsView:
// WebContentsView 作为子视图会吞掉其矩形内的鼠标事件,"绝不挡点击"做不到;
// BrowserWindow 有 setIgnoreMouseEvents(true, { forward: true })——常态点击穿透,
// 鼠标移动事件仍可达渲染层,悬停才能"延长驻留"。代价是位置须随主窗同步(见 syncToastBounds)。
const TOAST_W = 360;         // 条目宽(方案 5.4)
const TOAST_MAX = 3;         // 同屏上限,超出排队
const TOAST_DWELL_MS = 2200; // 默认驻留:统一 X1 里 2600/1800 的分歧
const TOAST_EDGE_X = 12;     // 距内容区右缘
const TOAST_EDGE_Y = 8;      // 距命令栏下缘
const TOAST_H_MIN = 28;      // 首帧高度占位(随即由渲染层实测回报覆盖)

let toastWin = null;
let toastQueued = false;   // 窗口加载中:渲染载荷待发(did-finish-load 统一补发)
let toastSeq = 0;
let toastLastH = TOAST_H_MIN;
const toastItems = [];     // 权威队列:到达顺序 = 屏幕上从上到下的顺序

// 主窗内容区右上角。无边框窗的 contentBounds 即窗口矩形,x/y 直接用屏幕坐标。
// 每次移动/缩放/条目增删后重算——位置不接受累计估算,漂移一次就再也贴不回边。
function toastBounds(h) {
  const b = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getContentBounds()
    : screen.getPrimaryDisplay().workArea;
  const width = Math.max(160, Math.min(TOAST_W, b.width - 2 * TOAST_EDGE_X));
  return {
    x: Math.round(b.x + b.width - width - TOAST_EDGE_X),
    y: Math.round(b.y + currentBarH + TOAST_EDGE_Y),
    width,
    height: Math.max(1, Math.round(h || TOAST_H_MIN)),
  };
}

function ensureToastWindow() {
  if (toastWin) return;
  toastWin = new BrowserWindow({
    ...toastBounds(TOAST_H_MIN), frame: false, transparent: true, hasShadow: false, resizable: false,
    movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, show: false,
    parent: mainWindow || undefined, // 子窗:恒在主窗之上,不参与 Alt+Tab,随主窗一起收起
    webPreferences: {
      sandbox: true, spellcheck: false, backgroundThrottling: false, // 计时与渲染不受后台降频影响
      preload: path.join(__dirname, 'toast-preload.js'),
    },
  });
  toastWin.setMenuBarVisibility(false);
  // 常态点击穿透。forward:true 让鼠标移动事件仍到达渲染层——这是"悬停延长驻留"的前提
  toastWin.setIgnoreMouseEvents(true, { forward: true });
  toastWin.loadFile(path.join(__dirname, 'toast.html')).catch(() => {});
  toastWin.webContents.once('did-finish-load', () => {
    toastQueued = false;
    renderToasts();
  });
  toastWin.on('closed', () => { toastWin = null; toastQueued = false; });
  toastQueued = true;
}

function destroyToastWindow() {
  const w = toastWin;
  toastWin = null;
  toastQueued = false;
  for (const it of toastItems) { clearTimeout(it.timer); it.timer = null; }
  toastItems.length = 0;
  setNotifyErrPending(false); // 队列清空 ⇒ 已无待处理的错误通知
  try { w?.destroy(); } catch { /* 已销毁 */ }
}

function syncToastBounds() {
  if (!toastWin || toastWin.isDestroyed()) return;
  try { toastWin.setBounds(toastBounds(toastLastH)); } catch { /* 窗口销毁竞态等,忽略 */ }
}

function setNotifyErrPending(v) {
  if (notifyErrPending === !!v) return;
  notifyErrPending = !!v;
  refreshTray();
}

function visibleToasts() { return toastItems.slice(0, TOAST_MAX); }

function toastPayload() {
  return visibleToasts().map((it) => ({
    id: it.id, text: it.text, tone: it.tone, persistent: it.persistent,
    action: it.action ? { label: it.action.label || t('toast.view') } : null,
  }));
}

// 计时只给"在屏 + 不常驻 + 未被悬停"的条目;排队中的条目轮到自己才开始起算
function syncToastTimers() {
  const vis = new Set(visibleToasts());
  for (const it of toastItems) {
    const run = vis.has(it) && !it.persistent && !it.hovered;
    if (run && !it.timer) {
      it.timer = setTimeout(() => { it.timer = null; dropToast(it.id); }, it.ms || TOAST_DWELL_MS);
    } else if (!run && it.timer) {
      clearTimeout(it.timer);
      it.timer = null;
    }
  }
}

// 点击穿透策略:仅当在屏条目带动作按钮时才解除穿透(否则按钮点不到)。
// 错误级常驻条目因此会占住右上角一小块矩形——这是"必须被处理"的代价,且只在该条在屏期间成立。
function applyToastMousePolicy() {
  if (!toastWin || toastWin.isDestroyed()) return;
  const blocking = visibleToasts().some((it) => it.action);
  try { toastWin.setIgnoreMouseEvents(!blocking, { forward: true }); } catch { /* 忽略 */ }
}

function renderToasts() {
  if (!toastWin || toastWin.isDestroyed()) return;
  syncToastTimers();
  applyToastMousePolicy();
  if (!toastQueued) {
    try { toastWin.webContents.send('nt:render', toastPayload()); } catch { /* 窗口销毁竞态 */ }
  }
}

function dropToast(id) {
  const i = toastItems.findIndex((it) => it.id === id);
  if (i < 0) return;
  const [it] = toastItems.splice(i, 1);
  clearTimeout(it.timer);
  if (it.tone === 'err') setNotifyErrPending(false);
  if (!toastItems.length) { destroyToastWindow(); return; } // 空队列即收窗:不常驻渲染进程(约束 8)
  renderToasts();
}

function pushToast(o) {
  // 同文同色连发合并(连点两次「复制路径」不该堆出两条一模一样的提示):在屏那条重新起算,
  // 即 syncToastTimers 会以完整驻留时长重挂计时(所以这里必须先清掉旧 timer,否则剩余时间是旧的)
  const dup = toastItems.find((it) => it.text === o.text && it.tone === o.tone && !it.action);
  if (dup) {
    dup.ts = Date.now();
    clearTimeout(dup.timer);
    dup.timer = null;
    renderToasts();
    return;
  }
  toastItems.push({
    id: `n${++toastSeq}`, text: o.text, tone: o.tone, action: o.action || null,
    persistent: !!o.persistent, ms: o.ms, hovered: false, timer: null, ts: Date.now(),
  });
  ensureToastWindow();
  if (toastQueued) return; // 首帧:did-finish-load 后统一补发(避免打到尚未加载完成的 webContents)
  renderToasts();
}

// 统一出口:调用方只说"要说什么",落点由这里裁决(方案 5.4)
//   ① 主窗在屏(可见且未最小化) → 应用内 toast,永不抢焦点
//   ② 主窗收进托盘 / 最小化    → 系统通知(窗口不在前台,不刷屏)
//   ③ 错误级(tone:'err')      → 应用内常驻 toast + 托盘红角标,直到用户处理
// 与方案的唯一偏差:① 不额外要求 mainWindow.isFocused()。通知宿主按构造就不抢焦点,
// 而"窗口明明在眼前,却因为焦点落在别处(比如刚点完托盘菜单)就改弹系统通知"是更差的行为。
function notify(text, opts) {
  const o = opts || {};
  const msg = String(text == null ? '' : text).trim();
  if (!msg) return;
  const tone = o.tone || 'info';
  const persistent = o.persistent != null ? !!o.persistent : (tone === 'err' || !!o.action);
  const onScreen = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();

  if (tone === 'err') setNotifyErrPending(true); // ③ 红角标亮到用户处理(dropToast 里复位)

  if (onScreen) {
    pushToast({ text: msg, tone, persistent, ms: o.ms, action: o.action || null });
    return;
  }
  // ② 主窗不在屏上:系统通知取代 toast。图标固定用基础图标——系统通知的图标语义是"谁在说话",
  // 级别已由正文表达,再按 tone 换图标只会让通知中心更花
  try {
    const n = new Notification({ title: app.getName(), body: msg, icon: path.join(__dirname, 'assets', 'icon.ico') });
    if (o.action && typeof o.action.run === 'function') {
      n.on('click', () => { try { o.action.run(); } catch (e) { log(`通知动作失败: ${e.message}`); } });
    }
    trackNotification(n);
    n.show();
  } catch (e) { log(`通知失败: ${e.message}`); }
}

// 渲染层回程:悬停 / 动作 / 关闭 / 高度。每条首行 trustedEvent + 发送方身份双验
ipcMain.on('nt:hover', (e, p) => {
  if (!trustedEvent(e) || !toastWin || e.sender !== toastWin.webContents || !p) return;
  const it = toastItems.find((x) => x.id === String(p.id));
  if (!it) return;
  it.hovered = !!p.over;
  syncToastTimers(); // 悬停只影响计时,不重建 DOM(重建会把鼠标底下那条换掉)
});

ipcMain.on('nt:action', (e, id) => {
  if (!trustedEvent(e) || !toastWin || e.sender !== toastWin.webContents) return;
  const it = toastItems.find((x) => x.id === String(id));
  if (!it || !it.action) return;
  const run = it.action.run;
  dropToast(it.id); // 先收条目:动作本身可能再开窗/再通知,顺序反了会出现"点了没反应"的错觉
  try { if (typeof run === 'function') run(); } catch (err) { log(`通知动作失败: ${err.message}`); }
});

ipcMain.on('nt:close', (e, id) => {
  if (!trustedEvent(e) || !toastWin || e.sender !== toastWin.webContents) return;
  dropToast(String(id));
});

ipcMain.on('nt:height', (e, h) => {
  if (!trustedEvent(e) || !toastWin || e.sender !== toastWin.webContents) return;
  toastLastH = Math.max(1, Math.min(600, Math.round(Number(h) || 0)));
  syncToastBounds();
  // 首次实测高度到达才显示:先量后亮,避免"占位高度 → 真实高度"的一帧抖动
  if (toastItems.length && !toastWin.isVisible()) {
    try { toastWin.showInactive(); } catch { /* 窗口销毁竞态等 */ }
  }
});

// 更新流程占用时的菜单反馈:有状态窗则回到进度窗;否则弹提示(用户点了菜单不能静默无响应)
function noticeFlowBusy(message, statusFallback) {
  if (statusWin) { showStatus(statusPayload || statusFallback); return; }
  showDialog({ type: 'info', title: t('dlg.busyTitle'), message, buttons: [{ label: t('dlg.ok'), primary: true }] });
}

// ---------- 桌面通知引用保持 ----------
// Electron 要求 Notification 在展示期间保持 JS 引用,否则可能被 GC 导致点击回调失效
let activeNotifications = [];
function trackNotification(n) {
  activeNotifications.push(n);
  n.on('close', () => { activeNotifications = activeNotifications.filter((x) => x !== n); });
}

// 挂后台期间有结果到达 → 桌面通知,点击恢复状态窗
function statusNotify(title, body) {
  if (!statusMinimized || !statusWin) return;
  try {
    const n = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.ico') });
    n.on('click', () => { if (!statusWin) return; statusWin.restore(); statusWin.show(); statusWin.focus(); });
    trackNotification(n);
    n.show();
  } catch (e) { log(`通知失败: ${e.message}`); }
}

// 结果视图:type=info/success/warning/error;回程按钮走 onAction(id)。
// P1-1 起结果为任务槽中的一条完成项:不再顶掉进行中的另一更新流(otherFlowActive 互斥链已删);
// 有其他进行中任务时结果不抢焦点(参照 VS Code 通知:出现但不打断),用户从列表处置。
// nonIntrusive=true 用于被动路径(自动检查的通知点击等):撞上更新流程进行中时——
// 状态窗已开 → 结果入列不抢焦点(不再静默丢弃,P1-5);窗口未开 → 维持跳过(不为被动结果拉窗打扰)
function showStatusResult(p, onAction, nonIntrusive) {
  const id = taskIdOf(p);
  const asResult = () => {
    if (onAction) statusActions.set(id, onAction); else statusActions.delete(id);
    statusTasks.set(id, { ...statusTasks.get(id), ...p, id, mode: 'result', done: true, ts: Date.now() });
  };
  if (nonIntrusive && (updates.state.downloadInProgress || updates.state.dshInstallChild || updates.state.dshStoppedForInstall || [...statusTasks.values()].some((t) => !t.done))) {
    if (!statusWin) { log(`跳过被动结果(无状态窗,更新流程进行中): ${p.title}`); return; }
    asResult();
    pushTasks({ focus: false });
    log(`被动结果已入列(不抢焦点): ${p.title}`);
    return;
  }
  asResult();
  if (!ensureStatusWindow()) { statusQueued = true; }
  else {
    // 有其他进行中任务:结果只入列表不抢焦点;否则正常聚焦
    const hasActive = [...statusTasks.values()].some((t) => !t.done);
    pushTasks({ focus: !hasActive });
  }
  statusNotify(p.title || 'DSH', String(p.detail || '').split('\n')[0]);
}

// ---------- IPC 信任校验 ----------
// 所有渲染层 IPC 只接受来自本应用本地窗口(file:// 顶层帧)的调用。
// 当前各窗口均无外部导航入口、无注入面,此为纵深防御:未来若某窗口开始加载
// 可导航内容(或引入 XSS),这些通道不会瞬间变成完整的主进程能力
function trustedEvent(e) {
  try {
    const frame = e && e.senderFrame;
    if (!frame) return false;
    return new URL(frame.url).protocol === 'file:';
  } catch { return false; }
}

// 文案表下发(v0.6.0 渲染层 i18n):sandbox 渲染层读不了 fs,preload 经 sendSync 拉取一次。
// 不走 trustedEvent:preload 阶段 senderFrame 可能尚未指向 file: 页;本通道只回只读静态文案,
// 无敏感信息与副作用,任意调用方拉取无安全影响
ipcMain.on('i18n:table', (e) => { e.returnValue = i18n.snapshot(); });

// 窗口环境标志(v0.6.1):Win11 Acrylic 材质透出,渲染层据此加 .win.acrylic(只读静态,同 i18n:table 不设信任门槛)
ipcMain.on('st:env', (e) => { e.returnValue = { acrylic: isWin11() }; });

ipcMain.on('st:bg', (e) => {
  if (!trustedEvent(e)) return;
  if (statusWin && !statusWin.isMinimized()) statusWin.minimize();
});
ipcMain.on('st:close', (e) => {
  if (!trustedEvent(e)) return;
  closeStatus();
});
ipcMain.on('st:action', (e, m) => {
  if (!trustedEvent(e) || !m) return;
  const fn = statusActions.get(m.taskId);
  statusActions.delete(m.taskId); // 回调一次性:防重复点击/迟到帧二次触发
  if (fn) fn(m.btnId);
});
// 关闭单条已完成任务(列表模式);最后一条关闭即收窗
ipcMain.on('st:dismiss', (e, taskId) => {
  if (!trustedEvent(e)) return;
  dismissTask(String(taskId));
});
// ✕ 按钮语义(P0-1 全模式对齐):单任务活动态 = 取消该操作并关闭;结果态 = 仅关闭;
// 列表模式 = 取消全部未完成任务并关闭(st:cancel-all);「后台」按钮才是最小化(不打断任务)
ipcMain.on('st:cancel', (e) => {
  if (!trustedEvent(e)) return;
  updates.cancelStatusOp(statusPayload?.__origin); // 取消逻辑本体在 updates.js(清计时器/忽略迟到结果/中止下载与 npm 安装)
});
// 列表模式行级取消:按任务 id 精确取消所属流,不误伤另一更新流
ipcMain.on('st:cancel-one', (e, taskId) => {
  if (!trustedEvent(e)) return;
  const id = String(taskId);
  updates.cancelStatusOp(id === 'default' ? undefined : id);
});
// 列表模式「全部关闭」(✕/Esc)= 逐个取消未完成任务后整窗关闭。
// 旧实现走 st:close → closeStatus() 直接清注册表:运行中的下载/安装成了"不可见且不可取消"
// 的孤儿任务(进度帧被丢弃、托盘丢"下载中"段、再无任何 UI 可达);现复用 cancelStatusOp 的
// 按流收窄逻辑逐流取消,与单任务「✕ = 取消并关闭」契约对齐(P0-1)
ipcMain.on('st:cancel-all', (e) => {
  if (!trustedEvent(e)) return;
  for (const t of [...statusTasks.values()]) {
    if (!t.done) updates.cancelStatusOp(t.id);
  }
  closeStatus(); // 未完成任务已取消,结果历史随窗一并丢弃(与「全部关闭」语义一致)
});

// 列表模式渲染完成回报(P1-1):按真实内容高度微调,修正 statusHeight 行数估算的漂移。
// 列表模式渲染完成回报(P1-1):按真实内容高度微调,修正 statusHeight 行数估算的漂移。
// 单任务固定档(活动 186 / 结果 250)保持旧尺寸不动(UITEST 锁定)——渲染层只在列表模式下回报
ipcMain.on('st:rendered', (e) => {
  if (!trustedEvent(e) || !statusWin || e.sender !== statusWin.webContents) return;
  const tasks = [...statusTasks.values()];
  if (tasks.length <= 1) return;
  fitWindowToContent(statusWin,
    '(()=>{const l=document.querySelector(".tlist");const cs=getComputedStyle(l);const gap=parseFloat(cs.rowGap)||0;'
    + 'const pad=parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom);const seq=[];'
    + 'for(const k of l.children){if(getComputedStyle(k).display==="contents"){seq.push(...k.children)}else seq.push(k)}'
    + 'let h=pad;seq.forEach((k,i)=>{h+=k.getBoundingClientRect().height;if(i>0)h+=gap});'
    + 'return h + document.querySelector(".win-head").getBoundingClientRect().height + 2})()',
    { min: 100, max: 460 });
});

// ---------- 通用深色对话框(替代原生 MessageBox;文件选择仍用原生) ----------
// 内存优化 P0-3:辅助窗口隐藏后 60s 无复用即销毁,释放渲染进程(打开时按既有路径重建)
const AUX_IDLE_DESTROY_MS = 60_000;
let dialogWin = null;
const dialogQueue = []; // 待展示对话框队列(P2-1 队列化):替代旧单槽 dialogQueued——
                        // 旧实现在屏时再次调用会静默替换内容并丢弃前一个回调(点了没反应类缺陷源)
let dialogBusy = false; // 有对话框在屏(等待用户回程)
let dialogCb = null;    // 当前在屏对话框的回程回调(与队列元素一一对应)
let dialogIdleTimer = null; // 对话框隐藏后的空闲回收定时器

function scheduleDialogRecycle() {
  clearTimeout(dialogIdleTimer);
  dialogIdleTimer = setTimeout(() => {
    dialogIdleTimer = null;
    if (!dialogWin) return;
    if (quitConfirmShown) return; // 退出确认框未决:不自动销毁(closed 会触发复位语义,不能误取消退出)
    log('对话框闲置回收:销毁释放渲染进程');
    dialogWin.destroy();
    dialogWin = null;
    dialogCb = null;
  }, AUX_IDLE_DESTROY_MS);
}
function cancelDialogRecycle() {
  clearTimeout(dialogIdleTimer);
  dialogIdleTimer = null;
}

function centerOn(win, ref) {
  try {
    const b = ref && !ref.isDestroyed() ? ref.getBounds() : screen.getPrimaryDisplay().workArea;
    const [w, h] = win.getContentSize();
    win.setPosition(Math.round(b.x + (b.width - w) / 2), Math.round(b.y + (b.height - h) / 2));
  } catch { /* 忽略 */ }
}

// 对话框内容高度估算:按信息量与当前宽度粗算(全角按 2 单位宽),并 clamp 到工作区内。
// 宁可略高:多余空间由 detail 滚动区吸收,不会遮住按钮。
// 半角/标点按 1 单位,全角字符按 2 单位;每行容量 = 2 × 可容纳全角字符数。
function dialogTextLines(s, cpl) {
  if (!s) return 0;
  let n = 0;
  for (const seg of String(s).split('\n')) {
    let w = 0;
    // 阈值取 CJK 部首区起点 U+2E80:ASCII/西文/数字按 1 计,CJK/全角按 2 计
    // (旧阈值 0x2e 会把数字与英文字母也当全角计宽,纯英文内容对话框虚高一倍)
    for (const ch of seg) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
    n += Math.max(1, Math.ceil(w / (cpl * 2)));
  }
  return n;
}

function dialogHeightFor(o, width) {
  const cpl = Math.max(10, Math.floor((width - 100) / 13)); // 每行可容纳的全角字符数(13px 全角≈13px 宽)
  const line = 20;
  const msg = dialogTextLines(o.message, cpl) * line;
  const det = Math.min(dialogTextLines(o.detail, cpl) * line, 140); // detail 上限 140px,超出内部滚动
  const h = 30 + msg + det + 74; // 图标/标题区 + 脚区按钮与内边距 + 安全余量
  return Math.min(Math.max(200, h), dialogMaxHeight());
}

// 对话框高度上限按主窗口所在显示器的工作区(而不是主显示器):副屏更矮时对话框不会超高
function dialogMaxHeight() {
  const d = mainWindow ? screen.getDisplayMatching(mainWindow.getBounds()) : screen.getPrimaryDisplay();
  return Math.max(240, d.workArea.height - 120);
}

// 实测式窗口高度校准(P1-1):估算值(dialogHeightFor / statusHeight)只做首帧,
// 渲染层渲染完成后回报(dl:rendered / st:rendered),这里按真实内容高度微调一次,
// 消除字符估算模型与真实渲染的漂移(长 URL/多行 detail/多按钮下的按钮贴边与大留白)。
// 差值 ≤tolerance 不动(避免可见跳动);渲染层未就绪/表达式异常一律静默跳过
function fitWindowToContent(win, expr, { min = 0, max = Infinity, tolerance = 8, recenter = false } = {}) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(expr).then((h) => {
    if (!win || win.isDestroyed() || !Number.isFinite(h) || h <= 0) return;
    const [w] = win.getContentSize();
    const cur = win.getContentSize()[1];
    const target = Math.round(Math.max(min, Math.min(max, h)));
    if (Math.abs(target - cur) <= tolerance) return;
    win.setContentSize(w, target);
    if (recenter) centerOn(win, mainWindow);
  }).catch(() => {});
}

// 解除对话框模态(阶段 0 修复 X3 的配套兜底)。
// 对话框窗口是「隐藏复用」而非一次性销毁(P2-1 队列化的刻意设计),而 modal 子窗在平台上
// 解除父窗禁用的时机并不完全一致(销毁必解除,hide 的解除时机依平台而异)。此处显式恢复
// 主窗可交互,避免出现「对话框已关、主窗却永久点不动」这类不可自愈的状态。
// 默认只在确认没有下一个待展示对话框、且窗口确已隐藏时生效——队列换页期间恢复可交互
// 会短暂击穿模态;窗口 destroyed 路径传 force=true(此时 helper 的可见性判据已不适用)。
function releaseDialogModal(force) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!force) {
    if (!dialogWin || dialogWin.isDestroyed() || dialogBusy || dialogWin.isVisible()) return;
  }
  try { mainWindow.setEnabled(true); } catch { /* 平台无此能力或窗口销毁中,静默 */ }
}

function flushDialog() {
  if (!dialogWin || dialogBusy || !dialogQueue.length) return;
  cancelDialogRecycle();
  const { opts, cb } = dialogQueue.shift();
  dialogBusy = true;
  dialogCb = cb;
  const w = opts.width || 460;
  dialogWin.setContentSize(w, dialogHeightFor(opts, w));
  dialogWin.setTitle(opts.title || 'DSH');
  dialogWin.webContents.send('dl:show', { ...opts, acrylic: isWin11() }); // 渲染层据此让 Acrylic 透出(v0.6.1)
  centerOn(dialogWin, mainWindow);
  dialogWin.show();
  dialogWin.focus();
}

// opts: { type:'info'|'success'|'warning'|'error', title, message, detail, width, cancel, critical,
//         buttons:[{label,primary,id,style}] }
// critical(当前仅退出确认):退出确认未决期间的其他对话框不入队,保证退出行优先;
// 该类对话框被直接关掉(Alt+F4/父窗连带销毁等)= 显式取消语义,由 closed/did-fail-load 走复位
function showDialog(opts, cb) {
  // 退出确认未决期间,其他对话框不入队(确认回调必须保序,退出行优先)。
  // 互斥判据用 critical 标志而非标题文案(DLG-5):标题改动不再静默破坏护栏
  if (quitConfirmShown && !opts.critical) {
    log(`退出确认未决,忽略对话框: ${opts.title || ''}`);
    return;
  }
  cancelDialogRecycle(); // 正在使用:取消闲置回收
  dialogQueue.push({ opts, cb: cb || null });
  if (!dialogWin) {
    dialogWin = new BrowserWindow({
      width: 460, height: 220, useContentSize: true,
      frame: false, resizable: false, skipTaskbar: true, show: false, parent: mainWindow,
      // 模态语义(阶段 0 修复 X3):此前只给 parent —— 那只保证「置顶于父窗」,不阻断父窗输入,
      // 而渲染层一直声明 aria-modal="true",声明与事实不符;退出确认/破坏性操作确认弹着时
      // 用户仍可继续操作主窗。modal 仅在存在 parent 时生效,与本窗一致。
      modal: true,
      // Win11 Acrylic 轻量层(P2-3 铺开,v0.6.1):同 status 窗
      backgroundMaterial: isWin11() ? 'acrylic' : undefined,
      webPreferences: { sandbox: true, spellcheck: false, preload: path.join(__dirname, 'dialog-preload.js') },
    });
    dialogWin.setMenuBarVisibility(false);
    dialogWin.loadFile(path.join(__dirname, 'dialog.html')).catch(() => {});
    dialogWin.webContents.once('did-finish-load', flushDialog);
    // 确认框本身加载失败(did-finish-load 永不触发,框不可见):按「取消」复位,避免退出状态卡死且无任何可见入口
    dialogWin.webContents.on('did-fail-load', () => resetQuitConfirm());
    dialogWin.on('closed', () => {
      releaseDialogModal(true); // 必须先于置空:模态解除需要主窗仍可寻址(销毁路径强制解除)
      dialogWin = null;
      dialogCb = null;
      dialogBusy = false;
      if (dialogQueue.length) log(`对话框窗口销毁,丢弃队列中 ${dialogQueue.length} 个未展示对话框`);
      dialogQueue.length = 0;
      cancelDialogRecycle();
      // 退出确认框被直接关掉(Alt+F4/父窗连带销毁等):按「取消」语义复位
      resetQuitConfirm();
    });
    return;
  }
  flushDialog(); // 空闲:接续展示;忙:入队等待当前对话框回程(P2-1,不再顶掉)
}

ipcMain.on('dl:choose', (e, i, id) => {
  if (!trustedEvent(e)) return;
  const cb = dialogCb;
  dialogCb = null;
  dialogBusy = false;
  dialogWin?.hide();
  if (cb) cb(i, id);
  flushDialog(); // 队列还有下一个:同一窗口接续展示(P2-1)
  // 无后续对话框才解除模态(P0-3 闲置回收同时启动)
  if (!dialogBusy) { releaseDialogModal(); scheduleDialogRecycle(); }
});

// 对话框渲染完成回报(P1-1):按真实内容高度微调(.top + .foot + 上下内边距 36/20 + 边框 2)
ipcMain.on('dl:rendered', (e) => {
  if (!trustedEvent(e) || !dialogWin || e.sender !== dialogWin.webContents) return;
  fitWindowToContent(dialogWin,
    'document.querySelector(".top").getBoundingClientRect().height + document.querySelector(".foot").getBoundingClientRect().height + 58',
    { min: 200, max: dialogMaxHeight(), recenter: true });
});

// ---------- 下载加速设置窗(可视化表单:分段数 / 镜像源,改动即时写入 config.json) ----------
// 分段数取值区间在 core.js(与 updates.js 的加速下载共用同一份契约)
let accelWin = null;
let accelQueued = false; // 窗口仍在加载中(等待 did-finish-load 后展示)
let accelIdleTimer = null; // 隐藏后的空闲回收定时器(内存优化 P0-3,与对话框同策略)

function scheduleAccelRecycle() {
  clearTimeout(accelIdleTimer);
  accelIdleTimer = setTimeout(() => {
    accelIdleTimer = null;
    if (!accelWin) return;
    log('加速设置窗闲置回收:销毁释放渲染进程');
    accelWin.destroy();
    accelWin = null;
  }, AUX_IDLE_DESTROY_MS);
}
function cancelAccelRecycle() {
  clearTimeout(accelIdleTimer);
  accelIdleTimer = null;
}

// 从 config.json 读当前生效的设置(缺失时回落默认值)
function accelSettingsFromConfig() {
  const cfg = loadConfig();
  const seg = Math.round(Number(cfg.downloadSegments));
  return {
    segments: Number.isFinite(seg)
      ? Math.max(ACCEL_SEGMENTS_MIN, Math.min(ACCEL_SEGMENTS_MAX, seg))
      : DEFAULT_SEGMENTS,
    downloadMirror: typeof cfg.downloadMirror === 'string' ? cfg.downloadMirror : '',
    cfgPath: configPath(), // 底部提示"改动保存到哪"
    // 有更新下载进行中:accel 窗显示提示条(新设置只对下次下载生效)
    downloadActive: !!(updates.state.downloadInProgress || (statusPayload && statusPayload.mode === 'download')),
    mica: isWin11(), // 渲染层据此让 Mica 透出(v0.6.1)
  };
}

function flushAccel() {
  if (!accelQueued || !accelWin) return;
  cancelAccelRecycle();
  accelQueued = false;
  accelWin.webContents.send('acc:show', accelSettingsFromConfig());
  centerOn(accelWin, mainWindow);
  accelWin.show();
  accelWin.focus();
}

function showAccelSettings() {
  cancelAccelRecycle(); // 正在使用:取消闲置回收
  if (!accelWin) {
    accelWin = new BrowserWindow({
      width: 520, height: 566, useContentSize: true, // 内容 470px 在 11px 标签后零余量:+10px 恢复呼吸空间(第四轮 X4-5)
      frame: false, resizable: false, skipTaskbar: true, show: false, parent: mainWindow,
      // Win11 Mica(P2-3 铺开,v0.6.1):与 reportWin 同档系统材质
      backgroundMaterial: isWin11() ? 'mica' : undefined,
      webPreferences: { sandbox: true, spellcheck: false, preload: path.join(__dirname, 'accel-preload.js') },
    });
    accelWin.setMenuBarVisibility(false);
    accelWin.loadFile(path.join(__dirname, 'accel.html')).catch(() => {});
    accelWin.webContents.once('did-finish-load', flushAccel);
    accelWin.on('closed', () => { accelWin = null; cancelAccelRecycle(); });
    accelQueued = true;
    return;
  }
  if (accelQueued) return; // 仍在加载:等 did-finish-load 统一展示
  accelWin.webContents.send('acc:show', accelSettingsFromConfig());
  centerOn(accelWin, mainWindow);
  accelWin.show();
  accelWin.focus();
}

ipcMain.on('acc:close', (e) => {
  if (!trustedEvent(e)) return;
  accelWin?.hide();
  scheduleAccelRecycle(); // 隐藏即开始闲置计时(P0-3)
});

ipcMain.on('acc:copy', (e, text) => {
  if (!trustedEvent(e)) return;
  clipboard.writeText(String(text || ''));
});

ipcMain.handle('acc:get', (e) => {
  if (!trustedEvent(e)) return null;
  return accelSettingsFromConfig();
});

// 校验并保存单个设置项;返回 {ok} 或 {ok:false,error}
ipcMain.handle('acc:set', (e, payload) => {
  if (!trustedEvent(e)) return { ok: false, error: '拒绝:非本地窗口调用' };
  // 非对象载荷(损坏的渲染层调用)直接拒绝,不能解构抛错变成无反馈的 unhandled rejection
  const field = payload && payload.field;
  const value = payload && payload.value;
  if (field === 'segments') {
    const v = Math.round(Number(value));
    if (!Number.isFinite(v)) return { ok: false, error: t('accel.errNotInt') };
    const clamped = Math.max(ACCEL_SEGMENTS_MIN, Math.min(ACCEL_SEGMENTS_MAX, v));
    const cfg = loadConfig();
    cfg.downloadSegments = clamped;
    if (!saveConfig(cfg)) return { ok: false, error: t('accel.errSaveFail') };
    log(`下载加速设置: 分段数 → ${clamped}`);
    return { ok: true, value: clamped }; // 就地反馈由 accel 窗 .inline-feedback 呈现,不再跨窗重复提示(P0-3)
  }
  if (field === 'mirror') {
    const raw = String(value || '').trim();
    if (raw) {
      if (!/^https?:\/\//i.test(raw)) return { ok: false, error: t('accel.errProtocol') };
      // host 段非空且不含空白(仅协议前缀如 "https://" 或含空格的串,下载时才失败,这里提前拦)
      if (!/^https?:\/\/[^\s/]+(\/|$)/i.test(raw)) return { ok: false, error: t('accel.errFormat') };
    }
    const cfg = loadConfig();
    if (raw) cfg.downloadMirror = raw;
    else delete cfg.downloadMirror;
    if (!saveConfig(cfg)) return { ok: false, error: t('accel.errSaveFail') };
    log(`下载加速设置: 镜像源 ${raw ? '→ ' + raw : '已清除'}`);
    return { ok: true, value: raw }; // 同上:accel 窗自带就地反馈(P0-3)
  }
  return { ok: false, error: t('accel.errUnknownField') };
});

// ---------- 错误报告窗(启动失败 / dsh 意外退出,一键导出) ----------
let reportWin = null;
let reportQueued = null;
let reportText = '';
let reportPath = null;
let reportLogFile = '';

function flushReport() {
  if (!reportQueued || !reportWin) return;
  const o = reportQueued;
  reportQueued = null;
  reportWin.setTitle(o.name || t('report.winTitle'));
  reportWin.webContents.send('rp:show', o);
  centerOn(reportWin, mainWindow);
  reportWin.show();
  reportWin.focus();
}

function closeReportWindow() {
  reportWin?.destroy();
  reportWin = null;
}

// opts: { phase:'boot'|'exit', error, code, buf, actions:[{id,label,style}] }
function showReport(opts) {
  closeStatus();
  const bootSnap = dshProc.getBootSnapshot(); // 最近一次启动的 stdout 尾/参数/时刻(dsh-process 维护)
  const ctx = {
    app, screen,
    phase: opts.phase,
    error: opts.error || null,
    code: opts.code != null ? opts.code : null,
    buf: opts.buf || bootSnap.buf,
    logFile,
    crashFile: crashFilePath(),
    configPath: configPath(),
    workspace: loadConfig().workspace,
    userData: app.getPath('userData'),
    dshBin: findDshBinSafe(),
    nodeExe: findNodeSafe(),
    args: bootSnap.args,
    elapsedMs: bootSnap.startedAt ? Date.now() - bootSnap.startedAt : null,
  };
  const rep = (() => {
    try { return diagnostics.buildReport(ctx); }
    catch (e) {
      log(`诊断失败: ${e.message}`);
      return {
        diag: {}, filePath: null,
        cls: { title: '诊断模块异常', cause: e.message, suggestions: ['请查看日志文件定位问题。'] },
        text: `诊断模块自身失败:\n${e.stack || e}\n\n原始错误:\n${(opts.error && opts.error.stack) || opts.error || ''}`,
      };
    }
  })();
  reportText = rep.text;
  reportPath = rep.filePath;
  reportLogFile = logFile;
  const logPreview = redactToken(String(ctx.buf || '').slice(-3000)) || diagnostics.tailFile(logFile, 60) || '';
  const payload = {
    phase: opts.phase,
    badge: opts.phase === 'exit' ? t('report.badgeExit') : t('report.badgeBoot'),
    name: rep.cls.title,
    cause: rep.cls.cause,
    suggestions: rep.cls.suggestions || [],
    logPreview,
    reportPath: rep.filePath,
    actions: opts.actions || [],
    mica: isWin11(), // 渲染层据此改半透明底让 Mica 透出(P2-3)
  };

  if (!reportWin) {
    reportWin = new BrowserWindow({
      width: 760, height: 600, minWidth: 640, minHeight: 480, useContentSize: true,
      frame: false, resizable: true, show: false,
      // Win11 Mica 试点(P2-3,仅 reportWin 一个窗口验证):系统材质透出,页面按 payload.mica
      // 改半透明底并去掉自绘大阴影;Win10 无此选项自动回落实色
      backgroundMaterial: isWin11() ? 'mica' : undefined,
      webPreferences: { sandbox: true, spellcheck: false, preload: path.join(__dirname, 'report-preload.js') },
    });
    reportWin.setMenuBarVisibility(false);
    reportWin.loadFile(path.join(__dirname, 'report.html')).catch(() => {});
    reportWin.webContents.once('did-finish-load', flushReport);
    reportWin.on('closed', () => { reportWin = null; });
    reportQueued = payload;
    return;
  }
  if (reportQueued) { reportQueued = payload; return; } // 仍在加载:更新排队载荷
  // 已就绪:直接展示
  reportWin.setTitle(payload.name || t('report.winTitle'));
  reportWin.webContents.send('rp:show', payload);
  centerOn(reportWin, mainWindow);
  reportWin.show();
  reportWin.focus();
}

ipcMain.on('rp:export', (e) => {
  if (!trustedEvent(e)) return;
  if (!reportWin) return;
  const def = reportPath || path.join(app.getPath('userData'), 'dsh-error-report.txt');
  const save = dialog.showSaveDialogSync(reportWin, {
    title: t('report.exportDlgTitle'),
    defaultPath: def,
    filters: [{ name: t('report.exportFilter'), extensions: ['txt'] }],
  });
  if (!save) return;
  try {
    fs.writeFileSync(save, reportText, 'utf8');
    reportWin.webContents.send('rp:exported', save);
    shell.showItemInFolder(save); // 就地反馈由 report 窗 .inline-feedback 呈现,不再跨窗重复提示(P0-3)
  } catch (e2) {
    log(`报告导出失败: ${e2.message}`);
  }
});
ipcMain.on('rp:copy', (e) => {
  if (!trustedEvent(e)) return;
  clipboard.writeText(reportText);
  reportWin?.webContents.send('rp:copied'); // 同上:report 窗自带就地反馈(P0-3)
});
ipcMain.on('rp:open-log', (e) => {
  if (!trustedEvent(e)) return;
  if (reportLogFile) shell.showItemInFolder(reportLogFile);
});
ipcMain.on('rp:action', (e, id) => {
  if (!trustedEvent(e)) return;
  if (id === '_close') return closeReportWindow();
  closeReportWindow();
  if (id === 'quit') app.quit();
  else if (id === 'retry' || id === 'restart') bootDsh();
  else log(`报告窗未知动作: ${String(id)}`); // 契约外 id 留痕:表现为"点了没反应+窗关"的问题可查(RPT-4)
});

// ---------- 自绘菜单弹层(替代原生 Menu.popup,风格与应用统一) ----------
// 内存仪表(内存优化 P1-3):总占用 = Electron 壳进程(getAppMetrics 同步快照) + dsh 本体进程树(异步枚举)。
// 菜单项 label 读 10s 后台刷新的缓存值(零阻塞打开菜单);点开详情时精确枚举本体树一次。
function shellMemMB() {
  let total = 0;
  try {
    for (const m of app.getAppMetrics()) {
      if (m.memory && m.memory.workingSetSize) total += m.memory.workingSetSize;
    }
  } catch { /* 忽略 */ }
  return Math.round(total / 1048576);
}
function fmtMB(mb) {
  return mb >= 1024 ? (mb / 1024).toFixed(1) + 'GB' : mb + 'MB';
}
let cachedTotalMemMB = null; // 壳 + dsh 本体进程树 总内存缓存(后台 10s 刷新)

// 枚举 dsh 本体进程树(web 主进程 + 插件子进程如 mcp-proxy)的内存(WorkingSet64 字节)之和。
// P2-4 轻量化:从根 PID 定向逐层取子进程(按 ParentProcessId 的 WMI 查询),不再全系统枚举 +
// ConvertTo-Json 全量回传(旧实现每轮数百 ms CPU 尖峰);单次 PowerShell 调用,脚本经
// -EncodedCommand 传递(规避 cmd.exe 引号转义),进程数封顶 64 防异常树膨胀。
// 异步 exec(脚本为固定模板,仅替换根 PID 数字,无注入面)+ 失败返回 0:降级为只显示壳,不阻塞不抛错。
function dshTreeMemMB() {
  return new Promise((resolve) => {
    const root = dshChild && dshChild.pid;
    if (!root) return resolve(0);
    const script = [
      '$ids = New-Object System.Collections.ArrayList',
      `[void]$ids.Add(${root})`,
      'for ($i = 0; $i -lt $ids.Count -and $ids.Count -le 64; $i++) {',
      '  Get-CimInstance -Query ("SELECT ProcessId FROM Win32_Process WHERE ParentProcessId=" + $ids[$i]) | ForEach-Object { [void]$ids.Add($_.ProcessId) }',
      '}',
      '(Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum',
    ].join('; ');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${enc}`, { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(0);
      const n = Number(String(stdout).trim());
      resolve(Number.isFinite(n) && n > 0 ? n : 0);
    });
  });
}
async function refreshTotalMemory() {
  // 主窗口隐藏(收进托盘)时跳过:内存数值只出现在主菜单 label,托盘后台常驻期不值得
  // 每 10s 拉起一次 PowerShell 枚举全系统进程(单次数百 ms CPU);恢复可见后下一轮补刷
  if (!mainWindow || !mainWindow.isVisible()) return;
  const tree = await dshTreeMemMB();
  cachedTotalMemMB = shellMemMB() + Math.round(tree / 1048576);
}

async function showMemoryInfo() {
  const shell = shellMemMB();
  const tree = Math.round((await dshTreeMemMB()) / 1048576); // 点开详情时精确枚举本体进程树一次
  const total = shell + tree;
  // 状态评价:总内存(壳 + dsh 本体)分三档,映射对话框图标颜色;实测基线约 1.4GB
  const level = total <= 1500
    ? { type: 'info', key: 'dlg.memLevelOk' }
    : total <= 2200 ? { type: 'warning', key: 'dlg.memLevelHigh' } : { type: 'error', key: 'dlg.memLevelVeryHigh' };
  const advice = level.key === 'dlg.memLevelOk'
    ? t('dlg.memAdviceOk')
    : level.key === 'dlg.memLevelHigh'
      ? t('dlg.memAdviceHigh')
      : t('dlg.memAdviceVeryHigh');
  const detail = [
    t('dlg.memShell', { size: fmtMB(shell) }),
    t('dlg.memDsh', { size: fmtMB(tree) }),
  ];
  if (!dshChild) detail.push(t('dlg.memNoDsh'));
  detail.push('', t('dlg.memAdvicePrefix', { advice }));
  showDialog({
    type: level.type, title: t('dlg.memoryTitle'), width: 440,
    message: t('dlg.memoryMsg', { size: fmtMB(total), level: t(level.key) }),
    detail: detail.join('\n'),
    buttons: [{ label: t('dlg.ok'), primary: true }],
  });
}

// 命令注册表的运行时上下文(阶段 2):注册表只描述"有哪些命令",值从哪来由这里拼。
// 集中在一处,菜单与命令面板取到的是同一帧的同一份值(否则两处会各自 loadConfig 一次,
// 面板里显示的外观模式可能比菜单晚一帧 → 用户看到两个不一样的当前值)。
function commandCtx() {
  return {
    t,
    cfg: loadConfig(),
    barVisible,
    version: app.getVersion(),
    dshVersion: dshVersion(),
    mem: fmtMB(cachedTotalMemMB ?? shellMemMB()),
    isPortable: IS_PORTABLE,
  };
}

// ☰ 主菜单条目(阶段 2):由 commands.js 注册表生成,不再手写第二份顺序与文案。
// menu:false 的条目(复制路径 / 任务中心)只进命令面板,菜单留底部一行「所有命令…」引过去。
// 分组分隔符暂用 type:'sep'(v0.7.13 换成分组小标题,届时这里改为 type:'sec')。
function menuItems() {
  const ctx = commandCtx();
  const items = [];
  let prevGroup = null;
  for (const c of commands.list) {
    if (c.menu === false) continue;
    if (prevGroup !== null && c.group !== prevGroup) items.push({ type: 'sep' });
    prevGroup = c.group;
    const it = { type: 'item', id: c.id, label: commands.labelOf(c, ctx) };
    const accel = commands.accelOf(c.id);
    if (accel) it.accel = accel; // 无快捷键的命令不带 accel 字段,menu.html 也就不会画空白槽位
    const checked = commands.checkedOf(c, ctx);
    if (checked !== undefined) it.checked = checked; // 返回 undefined 才是普通 menuitem,不能写成 falsy 判断
    items.push(it);
  }
  return items;
}

// 快捷键速查浮层(P2-2):数据源与菜单弹层/应用菜单同源(shortcuts.js),不手写第二份
// 文案走 labelKey → i18n(阶段 0 修 X5),与主菜单同名条目取到同一句话
function showShortcutsDialog() {
  const lines = shortcuts.list.map((s) => `${t(s.labelKey)} · ${shortcuts.display(s.menu)}`);
  showDialog({
    type: 'info', title: t('dlg.shortcutsTitle'), width: 420,
    message: t('dlg.shortcutsMsg'),
    detail: lines.join('\n'),
    buttons: [{ label: t('dlg.ok'), primary: true }],
  });
}

const MENU_W = 264;
const MENU_MARGIN = 12; // 视图四周留白,容纳阴影

// 菜单弹层懒创建(内存优化 P0-2):菜单平时不可见,点开才创建视图、关闭即销毁,
// 避免一个 0 尺寸的渲染进程常驻(典型 50-90MB)
function ensureMenuPopup() {
  if (!mainWindow) return;
  if (menuPopupView && !menuPopupView.webContents.isDestroyed()) return;
  menuPopupView = new WebContentsView({
    webPreferences: { sandbox: true, spellcheck: false, preload: path.join(__dirname, 'menu-preload.js') },
  });
  // View 默认底色是白色,会把面板周围透明边距(阴影区)衬成白圈,必须置为全透明
  menuPopupView.setBackgroundColor('#00000000');
  menuPopupView.webContents.loadFile(path.join(__dirname, 'menu.html')).catch(() => {});
  // 点击菜单外任意处关闭;blur 时若面板仍展开,把键盘焦点还给 dsh 页面(否则菜单关闭后打字无响应)
  menuPopupView.webContents.on('blur', () => { if (menuPopupView && menuPopupView.getBounds().width > 0) closeMenuPopup(true); });
  // 菜单首帧加载完成时补发排队载荷(极快点击不会出现空白菜单)
  menuPopupView.webContents.on('did-finish-load', () => {
    if (menuQueued && menuPopupView && menuPopupView.getBounds().width > 0) {
      const q = menuQueued;
      menuQueued = null;
      menuPopupView.webContents.send('m:show', q);
    }
  });
  mainWindow.contentView.addChildView(menuPopupView); // 后 add 的位于最上层
  layoutViews();
}
function destroyMenuPopup() {
  if (!menuPopupView) return;
  const v = menuPopupView;
  menuPopupView = null;
  menuQueued = null;
  try { mainWindow.contentView.removeChildView(v); } catch { /* 窗口销毁中 */ }
  try { v.webContents.close(); } catch { /* 已销毁 */ }
}

function showMenuPopup() {
  if (!mainWindow) return;
  closeTrayMenu(); // 与托盘菜单互斥
  const items = menuItems();
  let mh = 20; // 上下内边距(.panel padding 10px × 2)
  // 逐项高度须与 menu.html 的 .item/.sep 实际盒高一致(.item 32px、.sep 1+8=9px),否则菜单底部被裁
  for (const it of items) mh += it.type === 'sep' ? 9 : 32;
  ensureMenuPopup();
  menuPopupView.setBounds({
    x: 0,
    y: currentBarH,
    width: MENU_W + MENU_MARGIN * 2,
    height: mh + MENU_MARGIN * 2,
  });
  const wc = menuPopupView.webContents;
  const payload = { items, w: MENU_W, margin: MENU_MARGIN };
  if (wc.isLoading()) { menuQueued = payload; } // 首帧未加载完:入队,加载完成后补发
  else { menuQueued = null; wc.send('m:show', payload); }
  titlebarView?.webContents.send('tb:menu-state', true); // 菜单按点亮起
  menuPopupView.webContents.focus();
}

function closeMenuPopup(refocus = false) {
  menuClosedAt = Date.now();
  if (menuPopupView) {
    try { menuPopupView.setBounds({ x: 0, y: 0, width: 0, height: 0 }); } catch { /* 销毁竞态 */ }
    destroyMenuPopup();
  }
  titlebarView?.webContents.send('tb:menu-state', false);
  if (refocus) dshView?.webContents.focus();
}

// 左上角菜单按钮:点击打开,再点关闭(toggle);blur 自动收起后 350ms 内再点不算重开
ipcMain.on('tb:menu', (e) => {
  if (!trustedEvent(e)) return;
  const open = !!menuPopupView && menuPopupView.getBounds().width > 0;
  if (open || Date.now() - menuClosedAt < 350) { closeMenuPopup(true); return; }
  showMenuPopup();
});

// 命令分发单一入口(阶段 1 S1,阶段 2 收口):主菜单弹层 / 托盘菜单 / 命令栏状态簇 /
// 命令面板全部走同一实现。命令的"元信息"(分组/分类/文案/勾选态/加速键)归 commands.js,
// 本函数只管"执行"——注册表描述命令,这里执行命令,职责不重叠。
function runCommand(id) {
  switch (id) {
    case 'show-main': showMainWindow(); break;
    case 'open-workspace': changeWorkspace(); break;
    case 'restart-dsh': bootDsh(); break;
    case 'open-browser': if (dshWebUrl) shell.openExternal(dshWebUrl); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'toggle-bar': toggleTitlebar(!barVisible); break;
    case 'copy-workspace': copyWorkspacePath(); break;
    case 'open-tasks': focusStatusWindow(); break;
    case 'reload': dshView?.webContents.reload(); break;
    case 'devtools': dshView?.webContents.toggleDevTools(); break;
    case 'dsh-home': shell.openPath(path.join(os.homedir(), '.dsh')); break;
    case 'log': shell.showItemInFolder(logFile); break;
    case 'memory-info': showMemoryInfo(); break;
    case 'check-update': updates.checkForUpdates(true); break;
    case 'check-dsh-update': updates.checkDshUpdate(true); break;
    case 'download-accel': {
      showAccelSettings(); // 可视化设置窗:分段数 / 镜像源即时保存到 config.json
      break;
    }
    case 'shortcuts': {
      showShortcutsDialog(); // 快捷键速查浮层(P2-2)
      break;
    }
    case 'auto-open-browser': {
      // 设置项:启动 dsh 时是否随带打开系统浏览器(dsh 0.1.0-rc.8 起默认会,故桌面壳默认关闭并传 --no-open)
      const cfg = loadConfig();
      cfg.openBrowser = !cfg.openBrowser;
      saveConfig(cfg);
      log(`自动打开浏览器已切换为: ${cfg.openBrowser ? '开启' : '关闭'}`);
      break;
    }
    case 'close-to-tray': {
      // 设置项:切换"关闭按钮 = 最小化到托盘 / 直接退出"
      const cfg = loadConfig();
      cfg.closeAction = cfg.closeAction === 'quit' ? 'tray' : 'quit';
      saveConfig(cfg);
      sendCloseTip(); // 标题栏关闭按钮 tooltip 语义同步
      log(`关闭行为已切换为: ${cfg.closeAction === 'quit' ? '直接退出' : '最小化到托盘'}`);
      break;
    }
    case 'cycle-theme': {
      // 外观三态循环:auto(跟随系统) → dark → light → auto
      // themeSource 变更后,全部自绘页经 ui-theme.js 的 matchMedia 自动换肤,无需逐窗通知
      const cfg = loadConfig();
      const order = ['auto', 'dark', 'light'];
      cfg.theme = order[(order.indexOf(cfg.theme || 'auto') + 1) % order.length];
      saveConfig(cfg);
      applyTheme();
      applyChromeBg(); // 画布底色随主题(与 nativeTheme 'updated' 同一路径,P0-5)
      const label = t(commands.THEME_KEYS[cfg.theme]);
      log(`外观已切换为: ${label}`);
      notify(t('menu.appearance', { mode: label }));
      pushTitlebarStatus(); // 命令栏主题钮的提示文案随模式变(阶段 1 S1);此路径不走 refreshTray
      break;
    }
    case 'quit': app.quit(); break;
  }
}

ipcMain.on('m:action', (e, id) => {
  if (!trustedEvent(e)) return;
  // 区分来源:主窗口菜单弹层 / 托盘菜单小窗
  const fromTray = trayMenuWin && e.sender === trayMenuWin.webContents;
  if (fromTray) closeTrayMenu();
  else closeMenuPopup(true);
  runCommand(id);
});
ipcMain.on('m:close', (e) => {
  if (!trustedEvent(e)) return;
  if (trayMenuWin && e.sender === trayMenuWin.webContents) closeTrayMenu();
  else closeMenuPopup(true);
});

// 标题栏底色跟随 dsh 页面实际背景色,视觉上与内容融为一体。
// dsh 页面可能动态切换主题(白天/夜间、用户改色):仅 did-finish-load 采样一次会在切换后失同步,
// 故增加 ①页面导航钩子(did-navigate / did-navigate-in-page 覆盖整页跳转与 SPA 路由)②周期采样器
// (窗口可见时每 3s 采样一次,托盘隐藏/退出时暂停)③同色短路采样相同颜色不再重复 IPC;
// ④in-flight 互斥,慢页面下 executeJavaScript 超 3s 也不并发采样。
let lastTitlebarTheme = null;      // 上次已下发的主题色(hex):相同则跳过
let titlebarThemeInFlight = false; // 采样在途标志
async function syncTitleBarTheme() {
  if (titlebarThemeInFlight) return;
  const wc = dshView?.webContents;
  if (!wc || !titlebarView) return;
  // 仅采样 dsh 页面本体:loadFile 的本地页(loading.html 等走主题令牌自绘,不需要跟随)不采样,避免无意义覆盖
  const cur = wc.getURL();
  if (!cur || cur.startsWith('file:')) return;
  titlebarThemeInFlight = true;
  try {
    const bg = await wc.executeJavaScript(
      'getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor',
    );
    const m = bg && bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
    if (!m || (m[4] !== undefined && +m[4] === 0)) return; // 透明背景则保持默认色
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (hex === lastTitlebarTheme) return; // 主题未变化:不重复 IPC/刷色
    lastTitlebarTheme = hex;
    // light 标志供标题栏切换鲸鱼 logo 黑白版(浅色页面上白鲸不可见;前景与 ui.css --c-fg2 同源)
    titlebarView.webContents.send('tb:theme', { bg: hex, fg: lum < 0.5 ? '#8b949e' : '#5f6368', light: lum >= 0.5 });
    // 视图表面底色跟随页面色:缩放/未绘制边缘露出的底色与页面一致,不突兀
    titlebarView.setBackgroundColor(hex);
  } catch { /* 页面未就绪等,忽略 */ } finally { titlebarThemeInFlight = false; }
}

// 主题采样事件化(P2-5):向 dsh 页面注入一次性 MutationObserver,观察 html/body 的 style/class
// 变化(覆盖页面自身的白天/夜间切换),变化去抖 150ms 后经 console 消息通知主进程采样一次;
// 替代旧常驻 3s 轮询。executeJavaScript 与 devtools 同权,不受页面 CSP 限制;
// 幂等(同页只注一次),导航后由 did-finish-load/did-navigate 重新注入。
const THEME_HOOK_JS = `(() => {
  if (window.__dshThemeHook) return 'hooked';
  let t = 0;
  const ping = () => { clearTimeout(t); t = setTimeout(() => { console.debug('__dsh-theme-changed'); }, 150); };
  const obs = new MutationObserver(ping);
  const opt = { attributes: true, attributeFilter: ['style', 'class'] };
  obs.observe(document.documentElement, opt);
  if (document.body) obs.observe(document.body, opt);
  window.__dshThemeHook = true;
  return 'hooked';
})()`;
function injectThemeObserver() {
  dshView?.webContents.executeJavaScript(THEME_HOOK_JS).catch(() => { /* 页面未就绪等,忽略 */ });
}

// 窗口画布/标题栏 surface 底色随主题刷新:浅色下启动首帧与未绘制边缘不露深色。
// 两个触发源共用:菜单「外观」切换(cycle-theme)与系统主题变化(auto 模式下 OS 换深浅色,
// 渲染层经 matchMedia 即时换肤,但画布底色必须在这里同步,否则未绘制边缘露出相反底色, P0-5);
// 标题栏 surface 以 dsh 页面采样色为准(与栏视觉一致),无采样时才回落画布色
function applyChromeBg() {
  try {
    const bg = chromeBgColor();
    mainWindow?.setBackgroundColor(bg);
    dshView?.setBackgroundColor(bg);
    titlebarView?.setBackgroundColor(lastTitlebarTheme || bg);
  } catch { /* 窗口销毁竞态等,忽略 */ }
}
nativeTheme.on('updated', applyChromeBg);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: chromeBgColor(),
    frame: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'), // 用 ico:任务栏/标题栏小尺寸有原生 16/24/32 档
  });
  mainWindow.setMenuBarVisibility(false);

  titlebarView = new WebContentsView({
    webPreferences: { sandbox: true, spellcheck: false, preload: path.join(__dirname, 'titlebar-preload.js') },
  });
  // View 默认底色是白色:Windows 无边框窗口顶沿的隐形系统边框带/未绘制区会露白边,必须显式设主题色
  titlebarView.setBackgroundColor(chromeBgColor());
  titlebarView.webContents.loadFile(path.join(__dirname, 'titlebar.html')).catch(() => {});
  // 页面加载完成后同步一次关闭语义 tooltip(loadFile 前 send 会丢)
  // 同时补推一次状态簇(阶段 1 S1):同值短路下 titlebarStatusLast 可能已有缓存值,
  // 页面重载后必须无条件重发,否则新页面会一直空着——故先清缓存再推。
  titlebarView.webContents.on('did-finish-load', () => {
    sendCloseTip();
    titlebarStatusLast = null;
    pushTitlebarStatus();
  });

  dshView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
      // 仅本地 file:// 加载页暴露 dshBoot 动作桥,dsh 服务页零暴露(见 dsh-preload.js)
      preload: path.join(__dirname, 'dsh-preload.js'),
    },
  });
  dshView.webContents.setBackgroundThrottling(false);
  dshView.webContents.loadFile(path.join(__dirname, 'loading.html')).catch(() => {});
  // 同上:标题栏收起时 dshView 顶边就是窗口顶边,同样防白边/未绘制区露白
  dshView.setBackgroundColor(chromeBgColor());
  // 431 自愈(v0.6.3):万一头仍超限(单会话内多次重启累积等边缘路径),清 Cookie 后自动重载一次
  dshView.webContents.session.webRequest.onCompleted({ urls: [] }, (d) => {
    if (d.statusCode !== 431 || d.resourceType !== 'mainFrame' || !dshWebUrl || dsh431Healed) return;
    try { if (new URL(d.url).origin !== new URL(dshWebUrl).origin) return; } catch { return; }
    dsh431Healed = true;
    log('服务端返回 431(请求头超限):已清理历史 Cookie,自动重载服务页');
    clearDshAuthCookies(dshWebUrl).then(() => dshView?.webContents.reload());
  });
  dshView.webContents.on('did-finish-load', () => {
    injectThemeObserver(); // 主题变化事件化(P2-5):每次页面加载后重注观察钩子
    syncTitleBarTheme();
    forceViewRelayout(); // 页面加载完成后再确认一次 surface 尺寸(首帧可能仍按旧 viewport 绘制)
    dshView?.webContents.focus();
  });
  // 页面导航/SPA 路由变化后重注钩子并重新采样标题栏主题(整页跳转与前端路由都覆盖)
  dshView.webContents.on('did-navigate', () => { injectThemeObserver(); syncTitleBarTheme(); });
  dshView.webContents.on('did-navigate-in-page', () => { injectThemeObserver(); syncTitleBarTheme(); });
  // 页面主题钩子(P2-5):dsh 页面 html/body 的 style/class 变化 → 去抖通知 → 采样一次,
  // 覆盖页面内白天/夜间切换;同色短路保证无变化时零开销
  dshView.webContents.on('console-message', (e) => {
    if (e.message && e.message.includes('__dsh-theme-changed')) syncTitleBarTheme();
  });
  // dsh 页面加载失败要有痕迹:静默失败 = 用户面对空白窗无从排查
  dshView.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return; // ERR_ABORTED:重启/再导航取消旧加载,属正常竞态
    log(`dsh 页面加载失败 ${code}: ${desc} @ ${redactToken(String(url || ''))}`);
  });
  dshView.webContents.on('render-process-gone', (_e, detail) => log(`dsh 渲染进程退出: ${JSON.stringify(detail)}`));
  // dsh 页面里的外链(文档/仓库等)交给系统浏览器
  dshView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { log(`页面请求开新窗,转交浏览器: ${redactToken(url)}`); shell.openExternal(url); }
    return { action: 'deny' };
  });
  // 同标签导航防护(will-navigate 只在页面自身发起导航时触发,loadURL/loadFile 不受影响):
  // 只放行 dsh 服务同源(刷新/前端路由),其余导航(外链、表单提交、被注入的 <a> 等)
  // 一律截断并交给系统浏览器,防止第三方站点整窗替换进来
  dshView.webContents.on('will-navigate', (e, url) => {
    if (dshWebUrl) {
      try {
        if (new URL(url).origin === new URL(dshWebUrl).origin) return; // 同源放行
      } catch { /* URL 解析失败按外链处理 */ }
    }
    e.preventDefault();
    log(`已拦截异源主框架导航,转交浏览器: ${redactToken(url)}`);
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  // 子框架(iframe)导航同样只放行同源:被注入/恶意内容嵌入异源 iframe(钓鱼页冒充 dsh 等)时拦截
  dshView.webContents.on('will-frame-navigate', (e, url, _isMainFrame, _frameProcessId, _frameRoutingId) => {
    if (e.isMainFrame) return; // 主框架由 will-navigate 管理
    if (dshWebUrl) {
      try {
        if (new URL(url).origin === new URL(dshWebUrl).origin) return;
      } catch { /* 解析失败按外链处理 */ }
    }
    e.preventDefault();
    log(`已拦截异源子框架导航,转交浏览器: ${redactToken(url)}`);
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  // dsh 页面内元素全屏(HTML5 fullscreen,如视频/演示):收齐标题栏让内容占满,退出时恢复进入前状态。
  // 关键:记录必须无条件执行——若用户已手动收起标题栏(barVisible=false)后页面才进全屏,
  // 进入时不改任何状态,但退出时仍需按「进入前状态(false)」恢复,否则手收的标题栏会被强制弹回。
  // (旧实现只在 barVisible 时记录,barBeforeHtmlFullscreen 残留 true,手动收起 + 页面全屏一进一出即触发)
  dshView.webContents.on('enter-html-full-screen', () => {
    barBeforeHtmlFullscreen = barVisible;
    if (barVisible) toggleTitlebar(false, false);
  });
  dshView.webContents.on('leave-html-full-screen', () => toggleTitlebar(barBeforeHtmlFullscreen, false));

  // 堆叠顺序(后加的上层):dsh 页面 → 标题栏。
  // 下拉把手 / 菜单弹层为按需创建(见 ensureRevealTab / ensureMenuPopup,内存优化 P0-1/P0-2),
  // 收起标题栏或打开菜单时才加入 contentView,关闭即销毁,不常驻渲染进程。
  mainWindow.contentView.addChildView(dshView);
  mainWindow.contentView.addChildView(titlebarView);
  layoutViews();
  applyWindowState(); // 恢复上次的位置/大小/最大化(校验仍落在某屏幕工作区内)
  mainWindow.on('resize', layoutViews);
  // 移动不改变视图尺寸,但通知宿主用的是屏幕坐标:必须与 resize 分开监听(X1)
  mainWindow.on('move', syncToastBounds);
  mainWindow.on('maximize', () => { layoutViews(); titlebarView?.webContents.send('tb:maximized', true); });
  mainWindow.on('unmaximize', () => { layoutViews(); titlebarView?.webContents.send('tb:maximized', false); });
  // 全屏:标题栏自动收起;退出全屏恢复进入前的状态(用户手动隐藏标题栏后全屏,退出时不应被强制显示)
  mainWindow.on('enter-full-screen', () => { barBeforeFullscreen = barVisible; toggleTitlebar(false, false); });
  mainWindow.on('leave-full-screen', () => toggleTitlebar(barBeforeFullscreen, false));
  mainWindow.show();
  // 首次显示补偿(见 forceViewRelayout):show 后多拍重设,对齐真实显示尺寸并强制 surface 重算,
  // 修复「首次启动右侧/底部暗色未绘制区、拉伸窗口后消失」
  for (const ms of [0, 80, 240, 600]) setTimeout(() => { layoutViews(); forceViewRelayout(); }, ms);
  // 关闭按钮:按设置隐藏到托盘(dsh 后台继续跑)或真正退出(不弹系统通知);每次关闭前记忆窗口位置/大小/最大化
  mainWindow.on('close', () => {
    try {
      const b = mainWindow.getBounds();
      const cfg = loadConfig();
      cfg.winBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      cfg.winMaximized = mainWindow.isMaximized();
      saveConfig(cfg);
    } catch { /* 记录失败忽略 */ }
  });
  mainWindow.on('close', (e) => {
    // 退出确认未决:拦截关闭(否则 quitting=true 放行销毁主窗 → 确认框连带销毁、回调永不触发,应用成无窗僵尸)
    // forceQuit 例外:用户已确认「仍然退出」,关闭必须放行,否则退出流程被自己的拦截永远中止
    if (quitConfirmShown && !forceQuit) { e.preventDefault(); return; }
    if (quitting || loadConfig().closeAction === 'quit') return;
    e.preventDefault();
    mainWindow.hide();
    // 首次收托盘:一次性系统通知——Win11 托盘图标默认折叠,无提示时用户极易以为应用已退出
    // (后续再关不再打扰;菜单/README 已有说明,这里补首次引导)
    try {
      const cfg = loadConfig();
      if (!cfg.trayHintShown) {
        saveConfig({ ...cfg, trayHintShown: true });
        const n = new Notification({
          title: t('tray.hintTitle'),
          body: t('tray.hintBody'),
          icon: path.join(__dirname, 'assets', 'icon.ico'),
        });
        trackNotification(n); // 保持引用:GC 会导致点击回调失效
        n.show();
      }
    } catch (e2) { log(`托盘提示通知失败: ${e2.message}`); }
  });
  mainWindow.on('closed', () => {
    mainWindow = null; dshView = null; titlebarView = null; revealTabView = null; menuPopupView = null;
    // 「关闭即退出」模式下主窗口是唯一主载体:直接退出,不等状态窗等辅助窗口也关闭
    if (loadConfig().closeAction === 'quit' && !quitting) app.quit();
  });
}

// ---------- 标题栏按钮 → 主进程 ----------
ipcMain.on('tb:min', (e) => {
  if (!trustedEvent(e)) return;
  mainWindow?.minimize();
});
ipcMain.on('tb:max', (e) => {
  if (!trustedEvent(e)) return;
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  dshView?.webContents.focus(); // 窗口按钮操作后把焦点还给页面,聊天输入框无需再点一次
});
ipcMain.on('tb:close', (e) => {
  if (!trustedEvent(e)) return;
  mainWindow?.close();
});
ipcMain.on('tb:hide-bar', (e) => {
  if (!trustedEvent(e)) return;
  toggleTitlebar(false);
  dshView?.webContents.focus(); // 收起标题栏后焦点还给页面,避免聊天输入框失焦
});
ipcMain.on('tb:show-bar', (e) => {
  if (!trustedEvent(e)) return;
  toggleTitlebar(true);
  dshView?.webContents.focus();
});
// 命令栏状态簇(阶段 1 S1):四个动作全部复用 runCommand(阶段 2 起四个都成了注册表里的命令),
// 不另写一份语义
ipcMain.on('tb:tasks', (e) => {
  if (!trustedEvent(e)) return;
  runCommand('open-tasks'); // 与命令面板「任务中心」同源
});
ipcMain.on('tb:update', (e) => {
  if (!trustedEvent(e)) return;
  runCommand('check-update'); // 与主菜单「检查更新…」同源
});
ipcMain.on('tb:cycle-theme', (e) => {
  if (!trustedEvent(e)) return;
  runCommand('cycle-theme'); // 与主菜单「外观」同源
});
ipcMain.on('tb:copy-ws', (e) => {
  if (!trustedEvent(e)) return;
  runCommand('copy-workspace'); // 与命令面板「复制工作目录路径」同源
});

// ---------- 启动 / 重启 dsh 并加载页面 ----------
// 加载页慢启动自助动作(P0-2):查看日志 / 重试 / 取消并退出。
// 双重校验:发送者必须是 dshView,且当前框架必须是本地 file:// 页面——
// dsh 服务页(http://127.0.0.1)即使被注入恶意脚本也无权触发这些动作
ipcMain.on('boot:action', (e, id) => {
  if (!dshView || e.sender !== dshView.webContents || !trustedEvent(e)) return;
  if (id === 'view-log') shell.showItemInFolder(logFile);
  else if (id === 'retry') bootDsh();
  else if (id === 'quit') app.quit();
});

async function bootDsh() {
  // 退出流程已开始(before-quit 已置 quitting):不再新拉服务,否则新进程不在
  // before-quit 的进程快照里,退出完成后会留下孤儿 dsh 服务
  if (quitting) return;
  // dsh 本体安装期间服务已暂停:手动"重启 dsh"忽略,安装完成(成败都)会自动恢复服务;
  // 恢复路径(updates.installDshUpdate/cancelStatusOp)在调用前已置 dshStoppedForInstall=false,不受影响
  if (updates.state.dshStoppedForInstall) { log('dsh 本体安装进行中,忽略重启请求(安装完成后自动恢复服务)'); return; }
  const seq = ++bootSeq;
  if (dshChild) {
    const old = dshChild;
    dshChild = null;
    await killTree(old);
  }
  if (!dshView) return;
  dshWebUrl = null; // 重启期间旧地址失效
  setTrayState('boot'); // 托盘转"启动中"(黄点)

  // 加载页阶段提示:窗口未加载完成的阶段入队,加载完成后统一补发
  const loading = dshView.webContents.loadFile(path.join(__dirname, 'loading.html'));
  let loadingFlush = [];
  let settledUrl = false;
  loading.then(() => {
    const wc = dshView?.webContents;
    if (!wc) return;
    for (const c of loadingFlush) wc.executeJavaScript(c).catch(() => {});
    loadingFlush = null;
  }).catch(() => {}); // 重启竞态:旧导航被取消会以 ERR_ABORTED 拒绝,忽略
  const stage = (i, text) => {
    if (seq !== bootSeq || settledUrl || !dshView) return;
    const cmd = `setStage(${i}, ${JSON.stringify(text)})`;
    if (loadingFlush) { loadingFlush.push(cmd); return; }
    dshView.webContents.executeJavaScript(cmd).catch(() => {});
  };
  // 慢启动兜底(P0-2):15s 仍未加载出服务页 → 加载页亮出自助操作行(查看日志/重试/取消并退出),
  // dsh 卡死时用户不再只能关窗(参照 VS Code "taking longer than expected" 的渐进披露)
  const slowTimer = setTimeout(() => {
    if (seq !== bootSeq || settledUrl || !dshView) return;
    const cmd = 'showSlowActions()';
    if (loadingFlush) { loadingFlush.push(cmd); return; }
    dshView.webContents.executeJavaScript(cmd).catch(() => {});
  }, 15_000);

  const cwd = loadConfig().workspace;
  titlebarView?.webContents.send('tb:workspace', cwd);
  try {
    stage(0, t('boot.locate')); // 加载页阶段 0(findDshBin 定位可能耗时,点亮对应阶段)
    stage(1, t('boot.start'));
    const { child, url } = await dshProc.startDsh(cwd, {
      onOut: (line) => {
        if (seq !== bootSeq || settledUrl || !dshView || loadingFlush) return;
        dshView.webContents.executeJavaScript(`pushLog(${JSON.stringify(line.slice(0, 160))})`).catch(() => {});
      },
      onChild: (c) => { dshChild = c; }, // 立即登记:启动窗口期内退出应用时,before-quit 也能杀掉它,避免孤儿进程
    });
    dshChild = child;
    child.once('exit', (code) => {
      if (quitting || seq !== bootSeq) return; // 主动停止/重启:新流程已接管,状态由其负责
      // 意外退出:清理死状态(否则「在浏览器中打开」会打开连接被拒的旧地址,安装判断也会误以为服务在跑)
      if (dshChild === child) dshChild = null;
      dshWebUrl = null;
      setTrayState('err'); // 托盘转"已停止"(红点):收托盘后崩溃不再无感知
      log(`dsh web 进程意外退出 (code=${code})`);
      showReport({
        phase: 'exit',
        error: null,
        code,
        buf: dshProc.getBootSnapshot().buf,
        actions: [
          { id: 'restart', label: t('action.restartDsh'), style: 'primary' },
          { id: 'quit', label: t('action.quit'), style: 'danger' },
        ],
      });
    });
    log(`服务地址: ${redactToken(url)},等待 HTTP 就绪…`);
    dshWebUrl = url;
    stage(2, t('boot.waitReady'));
    const ready = await dshProc.waitServerReady(url, () => seq !== bootSeq || quitting);
    if (!ready || quitting || seq !== bootSeq || !dshView) return;
    log(`加载 ${redactToken(url)}`);
    stage(3, t('boot.loadPage'));
    settledUrl = true;
    clearTimeout(slowTimer); // 服务页已接管,慢启动提示不再出现
    setTrayState('ok'); // 托盘转"运行中"(绿点)
    dsh431Healed = false;
    await clearDshAuthCookies(url); // 防 431:历史 Cookie 堆积会被服务端拒掉,见函数注释
    dshView.webContents.loadURL(url).catch((e) => log(`加载服务页失败: ${e.message}`)); // 加载中再次重启,旧导航被取消(ERR_ABORTED),忽略
  } catch (err) {
    clearTimeout(slowTimer); // 失败已转错误报告窗,不再亮加载页操作行
    setTrayState('err'); // 启动失败:托盘转"已停止"(红点)
    if (quitting || seq !== bootSeq) return;
    log(`启动失败: ${err.message}`);
    showReport({
      phase: 'boot',
      error: err,
      code: null,
      buf: dshProc.getBootSnapshot().buf,
      actions: [
        { id: 'retry', label: t('action.retry'), style: 'primary' },
        { id: 'quit', label: t('action.quit'), style: 'danger' },
      ],
    });
  }
}

// ---------- 工作目录(决定文件归属与会话列表,与本体共享的关键) ----------
// 首启欢迎页(P1-6):无有效工作目录时不直接弹裸系统目录对话框,先亮品牌引导——
// 一句话说明与本体共享、「选择工作目录」主按钮(内嵌原生选择器)、「关闭=收托盘」事前告知
// (原首收托盘的事后通知内容前移到第一触点);取消=退出语义保留为「退出」按钮与 Alt+F4。
// 返回 Promise<string|null>:选定并保存的工作目录,或 null(用户退出)
let welcomeWin = null;
let welcomeResolve = null;
function showWelcome() {
  return new Promise((resolve) => {
    welcomeResolve = resolve;
    const finish = (ws) => {
      ipcMain.removeListener('wl:choose', onChoose);
      ipcMain.removeListener('wl:quit', onQuit);
      const r = welcomeResolve;
      welcomeResolve = null;
      try { welcomeWin?.destroy(); } catch { /* 已销毁 */ }
      welcomeWin = null;
      r?.(ws);
    };
    const onChoose = (e) => {
      if (!trustedEvent(e) || !welcomeWin) return;
      const pick = dialog.showOpenDialogSync(welcomeWin, {
        title: t('welcome.pickTitle'),
        buttonLabel: t('welcome.pickBtn'),
        properties: ['openDirectory'],
        defaultPath: app.getPath('home'), // 用户主目录(不能硬编码 D:\,无 D 盘机器会行为不确定)
      });
      if (pick && pick[0]) {
        saveConfig({ ...loadConfig(), workspace: pick[0] });
        finish(pick[0]);
      }
    };
    const onQuit = (e) => { if (trustedEvent(e)) finish(null); };
    ipcMain.on('wl:choose', onChoose);
    ipcMain.on('wl:quit', onQuit);
    welcomeWin = new BrowserWindow({
      width: 480, height: 560, useContentSize: true,
      frame: false, resizable: false, show: false,
      backgroundColor: chromeBgColor(),
      webPreferences: { sandbox: true, spellcheck: false, preload: path.join(__dirname, 'welcome-preload.js') },
    });
    welcomeWin.setMenuBarVisibility(false);
    welcomeWin.center(); // 主窗尚未创建:屏幕居中
    welcomeWin.loadFile(path.join(__dirname, 'welcome.html')).catch(() => {});
    welcomeWin.webContents.once('did-finish-load', () => welcomeWin?.show());
    // Alt+F4 等直接关闭 = 退出(与旧 ensureWorkspace 的取消语义一致)
    welcomeWin.on('closed', () => { welcomeWin = null; finish(null); });
  });
}

function changeWorkspace() {
  const cfg = loadConfig();
  // 托盘态触发时主窗口是隐藏的:原生父窗口对话框不会正常显示,先恢复主窗口
  if (mainWindow && !mainWindow.isVisible()) showMainWindow();
  const pick = dialog.showOpenDialogSync(mainWindow, {
    title: t('workspace.changeTitle'),
    buttonLabel: t('workspace.changeBtn'),
    properties: ['openDirectory'],
    defaultPath: cfg.workspace || app.getPath('home'),
  });
  if (!pick || !pick[0]) return;
  saveConfig({ ...cfg, workspace: pick[0] });
  bootDsh();
}

// ---------- 菜单 ----------
// accelerator 与弹层 accel 文案同源自 shortcuts.js(P2-2)
function buildMenu() {
  const acc = (id) => shortcuts.list.find((s) => s.id === id)?.menu;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.openWorkspace'), accelerator: acc('open-workspace'), click: changeWorkspace },
        { label: t('menu.restartDsh'), accelerator: acc('restart-dsh'), click: () => bootDsh() },
        { type: 'separator' },
        { label: t('menu.quit'), role: 'quit' },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.fullscreen'), accelerator: acc('fullscreen'), click: toggleFullscreen },
        { label: t('menu.toggleBar'), accelerator: acc('toggle-bar'), click: () => toggleTitlebar(!barVisible) },
        { type: 'separator' },
        { label: t('menu.reload'), accelerator: acc('reload'), click: () => dshView?.webContents.reload() },
        { label: t('menu.devtools'), accelerator: acc('devtools'), click: () => dshView?.webContents.toggleDevTools() },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        { label: t('menu.shortcuts'), click: showShortcutsDialog },
        { label: t('menu.dshHomeData'), click: () => shell.openPath(path.join(os.homedir(), '.dsh')) },
        { label: t('menu.openLog'), click: () => shell.showItemInFolder(logFile) },
        { label: t('menu.checkDshUpdatePlain'), click: () => updates.checkDshUpdate(true) },
      ],
    },
  ]));
}

// ---------- 应用生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    log(`应用就绪 userData=${app.getPath('userData')}`);
    const cfg = loadConfig();
    if (cfg.workspace && fs.existsSync(cfg.workspace)) {
      startMain(cfg.workspace);
    } else {
      // 首启/工作目录失效(P1-6):欢迎页替代裸系统目录对话框,选定后再拉起主流程
      showWelcome().then((ws) => {
        if (!ws) {
          log('未选择工作目录,退出');
          app.quit();
          return;
        }
        startMain(ws);
      });
    }
  });

  function startMain(ws) {
    log(`工作目录: ${ws}`);
    // 更新模块注入编排能力:状态窗/对话框/通知/重启 dsh 均在 main.js,
    // updates.js 只依赖此注入面,不反向 require main.js
    updates.init({
      bootDsh,
      showStatus, showStatusResult, updateStatus, closeStatus,
      showDialog, noticeFlowBusy, trackNotification,
      dismissTask, // 任务中心(P1-1):按任务关闭单条(取消语义精确到流)
      getStatusPayload: (origin) => (origin ? statusTasks.get(origin) || null : statusPayload),
      isQuitting: () => quitting,
      getDshChild: () => dshChild,
      setDshChild: (c) => { dshChild = c; },
      bumpBootSeq: () => { bootSeq++; },
      // 更新可用性变化(阶段 1 S1):命令栏更新徽标的显隐由 state.pendingVersion 决定,
      // 通道侧在置值/清空两处回调过来,主进程只负责刷新徽标
      onUpdateStateChange: () => pushTitlebarStatus(),
    });
    buildMenu();
    createWindow();
    createTray();
    bootDsh();
    // 内存仪表:首次刷新 + 每 30s 后台刷新(壳 + dsh 本体进程树,P2-4 由 10s 放宽),菜单 label 读缓存零阻塞
    refreshTotalMemory();
    setInterval(refreshTotalMemory, 30_000);

    // 启动 6 秒后静默检查更新(仅打包版;不打扰,有新版才弹提示)
    setTimeout(() => { if (app.isPackaged) updates.checkForUpdates(false); }, 6_000);
    // 12 秒后静默检查 dsh 本体更新(错开桌面端更新检查,避免两个弹窗同时出现)
    setTimeout(() => updates.checkDshUpdate(false), 12_000);

    // 自动化冒烟(uitest.js):SMOKE 窗口/托盘闭环自动退出;DEMO 额外按阶段写出窗口屏幕坐标
    // (DSH_DEMO_BOUNDS 指定 JSON 路径)供外部截屏;UITEST 全量 UI 断言。
    // 测试代码本体在 uitest.js,依赖以 getters 注入:statusWin/dialogWin 等会随时重建/置空,
    // 直接传值会固化旧实例,getter 保证测试读到当前实例
    if (process.env.DSH_DESKTOP_SMOKE || process.env.DSH_DESKTOP_DEMO || process.env.DSH_DESKTOP_UITEST) {
      const uitestDeps = {
        app, screen, log,
        TITLEBAR_H, MENU_W, MENU_MARGIN,
        get mainWindow() { return mainWindow; },
        get dshView() { return dshView; },
        get titlebarView() { return titlebarView; },
        get statusWin() { return statusWin; },
        get dialogWin() { return dialogWin; },
        get reportWin() { return reportWin; },
        get accelWin() { return accelWin; },
        get menuPopupView() { return menuPopupView; },
        get trayMenuWin() { return trayMenuWin; },
        get currentBarH() { return currentBarH; },
        // S3 首次收起演示:revealTabView 会随收起/展开创建销毁,故走 getter;
        // 断言面是"提示状态机 + 视图 bounds",不暴露内部计时器
        get revealTabView() { return revealTabView; },
        get handleHintActive() { return handleHintActive; },
        HANDLE_W, HANDLE_H,
        get trayState() { return trayState; },
        trayStatusText,
        updatesState: updates.state, // 双通道共享状态对象(稳定引用):断言取消旗标/安装子进程等
        get mainWindowProgress() { return mainWindowProgress; }, // 主窗任务栏进度镜像值(P1-5)
        get welcomeWin() { return welcomeWin; }, // 首启欢迎页(P1-6):UITEST 做页面级冒烟
        showWelcome,
        abortWelcome: () => {
          // 测试收尾:吞掉 resolve(否则 null 会触发 whenReady 的退出分支),仅销毁窗口
          welcomeResolve = null;
          try { welcomeWin?.destroy(); } catch { /* 已销毁 */ }
        },
        showStatus, showStatusResult, updateStatus, showDialog, showReport,
        notify, // X1 通知统一出口(旧 notifyToast 已并入)
        // 通知宿主断言面:窗口会随队列清空即销毁,故 toastWin 走 getter;toastItems 是稳定引用的权威队列
        get toastWin() { return toastWin; },
        toastItems,
        get notifyErrPending() { return notifyErrPending; },
        destroyToastWindow, // 测试收尾:清队列并收窗,避免残留渲染进程影响后续断言
        getThemeSource: () => nativeTheme.themeSource,
        applyTheme,
        showMenuPopup, closeMenuPopup, showTrayMenu, closeTrayMenu, showMainWindow,
        toggleTitlebar, showAccelSettings, installDshUpdate: updates.installDshUpdate,
        isWin11, // Mica 试点(P2-3):断言 reportWin 的 mica 类与平台判定一致
        configPath, loadConfig, saveConfig,
      };
      if (process.env.DSH_DESKTOP_SMOKE || process.env.DSH_DESKTOP_DEMO) require('./uitest').runSmokeDemo(uitestDeps);
      if (process.env.DSH_DESKTOP_UITEST) require('./uitest').runUitest(uitestDeps);
    }
  }

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (e) => {
    // 无条件先置退出标志:否则在 dsh 启动失败(dshChild 为空)时,
    // 窗口 close 会被"最小化到托盘"拦截,app.quit() 将永远无法完成
    quitting = true;
    // npm 安装进行中退出会强杀全局包写入,可能损坏 dsh 本体:先二次确认
    // (下载中的桌面更新不拦——进程退出自然中止下载,无损坏风险,下次启动会重新检查)
    // 注意:确认框未决期间的一切后续退出请求都挂起(不再往下走到 killTree),
    // 直到用户点「仍然退出」(forceQuit)或「取消」(quitting 复位);否则
    // 确认框开着时再次点退出会绕过确认直接杀掉 npm 安装
    // 未决条件:安装进行中(dshInstallChild)或确认框已挂起(quitConfirmShown)。
    // 安装恰好完成时 quitConfirmShown 仍为 true:所有 quit 请求继续挂起等用户决策,
    // 不再落入清理段——否则 cleaned 被提前置真,取消退出后 dsh 复拉成功、下次退出却跳过 killTree,新进程成孤儿
    if ((updates.state.dshInstallChild || quitConfirmShown) && !forceQuit) {
      e.preventDefault();
      if (!quitConfirmShown) {
        quitConfirmShown = true;
        log('npm 安装进行中收到退出请求,弹确认');
        showMainWindow(); // 收托盘时确认框需要可见窗口
        showDialog({
          type: 'warning', title: t('dlg.quitTitle'), critical: true,
          message: t('dlg.quitInstallMsg'),
          detail: t('dlg.quitInstallDetail'),
          // 位次契约(DLG-2):主操作/默认焦点居左,取消与关闭类居右,破坏性操作用 danger 且不作默认——
          // Enter/Esc 均落到「取消」,与 dialog.html 的 primary/cancel 回落逻辑配合
          cancel: 0,
          buttons: [{ id: 'cancel', label: t('dlg.cancel'), primary: true }, { id: 'quit', label: t('dlg.quitStill'), style: 'danger' }],
        }, (_i, id) => {
          if (id === 'quit') { forceQuit = true; quitConfirmShown = false; app.quit(); }
          else resetQuitConfirm();
        });
      }
      return;
    }
    flushLog();
    stopHandlePolling();
    // dsh web 与进行中的 npm 安装都要随退出终止,避免留下孤儿进程
    const children = [dshChild, updates.state.dshInstallChild].filter(Boolean);
    if (cleaned) return;
    if (children.length === 0) {
      // 清理在途(首次已 killTree 且把 children 变量置空):等待同一同步点,不抢跑退出,
      // 否则 taskkill 可能尚未枚举到目标进程
      if (quitCleanup) { e.preventDefault(); return; }
      cleaned = true;
      return;
    }
    e.preventDefault();
    dshChild = null;
    updates.state.dshInstallChild = null;
    log('退出:终止 dsh web / npm 安装进程树');
    quitCleanup = Promise.all(children.map(killTree));
    quitCleanup.finally(() => {
      quitCleanup = null;
      flushLog();
      cleaned = true;
      app.quit();
    });
    // 兜底:被杀进程出现 D 状态/系统挂钩异常时 killTree 可能永挂,10 秒后强制退出
    setTimeout(() => {
      if (!cleaned) {
        log('退出清理超时,强制退出');
        cleaned = true;
        flushLog();
        app.exit(1);
      }
    }, 10_000);
  });
}