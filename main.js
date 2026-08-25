// DSH Desktop —— DeepSeek Harness (dsh) 的桌面壳。
// 托盘常驻(关闭默认收进后台)、自绘菜单、深色主题;会话/文件/设置与本体完全共享。
// 原理:以用户选的工作目录为 cwd,后台启动本体 `dsh web`,从 stdout 解析实际地址,
// 窗口加载该地址。不动 $DSH_HOME,因此会话/设置/插件/文件与本体 dsh 完全共享。
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
      require('node:fs').appendFileSync(
        require('node:path').join(ud || __dirname, 'CRASH.txt'),
        `${new Date().toISOString()}\n${err.stack || err}\n`,
      );
    } catch (e) { /* 无法落盘 */ }
  } catch (e) { /* 处理器自身异常:直接退出,避免递归 */ try { process.exit(1); } catch {} return; }
  // 模块加载期只负责落盘 + 退出,其余逻辑依赖的绑定此时可能尚未初始化,先硬退出
  try { app; } catch { try { process.exit(1); } catch {} return; }
  try {
    log(`未捕获异常: ${err.stack || err}`);
    flushLog(); // 日志缓冲即时刷盘,保证崩溃现场进入 dsh-web.log
  } catch (e) { /* 日志系统未就绪,忽略 */ }
  // 生成错误报告落盘(不弹窗,避免打扰);仅当 app 已就绪且能取到路径
  try {
    if (app.isReady()) {
      const ctx = {
        app, screen, phase: 'uncaught', error: err, code: null, buf: lastBootBuf,
        logFile, crashFile: crashFilePath(), configPath: configPath(),
        workspace: loadConfig().workspace, userData: app.getPath('userData'),
        dshBin: findDshBinSafe(), nodeExe: findNodeSafe(), args: lastBootArgs,
        elapsedMs: lastBootStart ? Date.now() - lastBootStart : null,
      };
      try { diagnostics.buildReport(ctx); } catch (e2) { log(`诊断落盘失败: ${e2.message}`); }
    }
  } catch (e3) { /* 模块加载期 app 未就绪等,忽略 */ }
  // 记录完毕主动退出:走 app.quit() 会触发 before-quit 正常清理(dsh 子进程树 + 日志);
  // app 不可用(未初始化/已损坏)时退硬退出兜底
  try { app.quit(); } catch { try { process.exit(1); } catch {} }
});
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeTheme, screen, shell, WebContentsView, Notification, clipboard } = require('electron');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const diagnostics = require('./diagnostics');
const { multiThreadDownload, resolveDownloadUrl, DEFAULT_SEGMENTS } = require('./downloader');

const IS_WIN = process.platform === 'win32';
// Windows 规范:固定 AppUserModelID,保证任务栏图标/分组/通知归属正确
if (IS_WIN) app.setAppUserModelId('com.zinkning.dsh-desktop');
// 后台/遮挡时不挂起 dsh 页面:避免对话正在工作时切走再切回触发重连/视图重建/滚动重置
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// 菜单弹层、右键菜单等原生 UI 跟随应用深色风格
nativeTheme.themeSource = 'dark';
const DSH_PKG_SUB = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js');
const BOOT_URL_TIMEOUT_MS = 90_000; // 等待 dsh 打印服务地址(升级/首启时 dsh 要用 pnpm 装 40+ 个包,放宽到 90s)
const SERVER_READY_TIMEOUT_MS = 60_000; // 等待 HTTP 就绪(首次启动要装依赖,放宽)
const CHECK_UPDATE_TIMEOUT_MS = 8_000; // 手动检查更新的超时时间
const CHECK_DSH_UPDATE_TIMEOUT_MS = 7_000; // 手动检查 dsh 本体更新的超时时间
const DSH_REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'; // 兜底:dsh 本体最新版本查询地址
let cachedDshRegistry = null;
// 跟随用户 npm registry 配置(镜像站用户直连 npmjs 往往不可达,与安装所用 registry 保持一致),
// 把 registry 根路径指向 @deepseek-ai/dsh/latest;解析失败退回官方地址
function dshRegistryUrl() {
  if (cachedDshRegistry) return cachedDshRegistry;
  try {
    const reg = (firstLine('npm config get registry') || 'https://registry.npmjs.org/').trim();
    const u = new URL(reg);
    u.pathname = '/@deepseek-ai/dsh/latest';
    cachedDshRegistry = u.toString();
  } catch { cachedDshRegistry = DSH_REGISTRY_URL; }
  if (!cachedDshRegistry) cachedDshRegistry = DSH_REGISTRY_URL;
  return cachedDshRegistry;
}
const DSH_INSTALL_IDLE_TIMEOUT_MS = 60_000; // npm 安装连续无输出多久后提示"可能卡住"(dsh 运行中文件被占用/网络慢)
const DSH_INSTALL_TOTAL_TIMEOUT_MS = 15 * 60_000; // npm 安装总超时:强制终止并报错,避免无限"请稍后"

let mainWindow = null;
let dshChild = null;
let bootSeq = 0; // 递增序号:重启后,旧一次 boot 的回调不再生效
let quitting = false;
let cleaned = false;
let dshWebUrl = null; // 当前 dsh web 服务地址(供"在浏览器中打开"使用)
let lastBootBuf = '';   // 最近一次启动的 stdout/stderr 缓冲尾部(供错误报告)
let lastBootArgs = null; // 最近一次启动的 spawn 参数
let lastBootStart = null; // 最近一次启动的时刻

// ---------- 配置(记住上次的工作目录) ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
// 崩溃记录统一落 userData(打包后 __dirname 是只读 asar,写那里会静默失败)
const crashFilePath = () => {
  try { return path.join(app.getPath('userData'), 'CRASH.txt'); } catch { return path.join(__dirname, 'CRASH.txt'); }
};

// ---------- 日志(内存缓冲 + 定期批量刷盘,避免高频 stdout 把主进程卡在同步 IO 上) ----------
const logFile = path.join(app.getPath('userData'), 'dsh-web.log');
let logBuf = [];
let logTimer = null;
function flushLog() {
  if (!logBuf.length) return;
  const data = logBuf.join('');
  logBuf = [];
  try {
    rotateLogIfNeeded();
    fs.appendFileSync(logFile, data);
  } catch (e) {
    try { fs.appendFileSync(crashFilePath(), `log失败: ${e.message}\n`); } catch { /* 彻底失败 */ }
  }
}
function log(line) {
  const s = String(line);
  logBuf.push(`[${new Date().toISOString()}] ${s.length > 2000 ? s.slice(0, 2000) + '…' : s}\n`);
  if (!logTimer) logTimer = setInterval(flushLog, 500);
}

// ---------- 日志轮转:单文件超过上限时归档为 .old 并重开,防长期运行无限膨胀 ----------
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB
function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(logFile);
    if (st.size > LOG_MAX_BYTES) {
      const old = logFile + '.old';
      try { fs.unlinkSync(old); } catch { /* 无旧档 */ }
      fs.renameSync(logFile, old);
      logBuf.unshift(`[${new Date().toISOString()}] 日志已轮转(旧档: ${old})\n`);
    }
  } catch { /* 日志文件尚不存在,无需轮转 */ }
}

// ---------- 定位 node 与 dsh(不经过 dsh.cmd 转发,便于管理进程树);成功后缓存避免重复 execSync ----------
let cachedDshBin = null;
let cachedNode = null;
function firstLine(cmd) {
  try { return execSync(cmd, { windowsHide: true }).toString().split('\n')[0].trim(); } catch { return ''; }
}
function findDshBin() {
  if (cachedDshBin && fs.existsSync(cachedDshBin)) return cachedDshBin;
  const candidates = [];
  if (IS_WIN && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', DSH_PKG_SUB));
  }
  const npmRoot = firstLine('npm root -g');
  if (npmRoot) candidates.push(path.join(npmRoot, DSH_PKG_SUB));
  const dshOnPath = firstLine(IS_WIN ? 'where dsh' : 'which dsh');
  if (dshOnPath) candidates.push(path.join(path.dirname(dshOnPath), 'node_modules', DSH_PKG_SUB));
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      cachedDshBin = c;
      return c;
    }
  }
  throw new Error('找不到 dsh,请先全局安装:npm install -g @deepseek-ai/dsh');
}
function findDshBinSafe() { try { return findDshBin(); } catch { return null; } }
function findNode() {
  if (cachedNode) return cachedNode;
  const node = firstLine(IS_WIN ? 'where node' : 'which node');
  if (node && nodeUsable(node)) {
    cachedNode = { exe: node, env: process.env };
    return cachedNode;
  }
  // PATH 里的 node 缺失或不可用(损坏/过旧/权限异常):回退 Electron 内置 node,
  // 否则 dsh 起不来而壳看起来正常,排障指向性差
  if (node) log(`系统 node 不可用("${node}" -v 失败),回退 Electron 内置 node`);
  // 兜底:让 Electron 二进制以纯 Node 模式运行
  cachedNode = { exe: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
  return cachedNode;
}
// 验证 node 可执行且能输出版本号(5s 超时防悬挂)
function nodeUsable(exe) {
  try { return execSync(`"${exe}" -v`, { windowsHide: true, timeout: 5000 }).toString().trim().length > 0; } catch { return false; }
}
function findNodeSafe() { try { return findNode().exe; } catch { return null; } }

// ---------- 进程管理 ----------
function killTree(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    if (IS_WIN) {
      // dsh web 会派生自己的子进程,必须整树终止
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('close', resolve);
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } }
      resolve();
    }
  });
}

// 读取已定位 dsh 包的版本号(写入启动日志,便于跨版本排查兼容问题);
// 带 10s 缓存:打开菜单/检查更新时不必反复读盘;安装完成后调用 dshVersion(true) 强制刷新
let cachedDshVersion = null;
let cachedDshVersionAt = 0;
function dshVersion(force = false) {
  if (!force && cachedDshVersion && Date.now() - cachedDshVersionAt < 10_000) return cachedDshVersion;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(path.dirname(findDshBin()), '..', 'package.json'), 'utf8')).version;
    cachedDshVersion = v;
    cachedDshVersionAt = Date.now();
    return v;
  } catch { return '未知'; }
}

function startDsh(cwd, onOut) {
  const bin = findDshBin();
  const node = findNode();
  const args = [bin, 'web', '--host', '127.0.0.1', '--port', String(loadConfig().port ?? 0)];
  // dsh 0.1.0-rc.8 起默认自动打开系统浏览器;桌面壳已内嵌 UI,默认加 --no-open 抑制,由菜单"自动打开浏览器"控制
  if (!loadConfig().openBrowser) args.push('--no-open');
  lastBootArgs = args;
  lastBootStart = Date.now();
  lastBootBuf = '';
  log(`dsh 版本: ${dshVersion()}`);
  log(`启动 dsh web: "${node.exe}" ${args.map((a) => `"${a}"`).join(' ')} (cwd=${cwd})`);
  const child = spawn(node.exe, args, {
    cwd,
    env: node.env,
    windowsHide: true,
    detached: !IS_WIN,
  });
  dshChild = child; // 立即登记:启动窗口期内退出应用时,before-quit 也能杀掉它,避免孤儿进程

  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); child.off('exit', onExit); fn(value); };
    const onData = (chunk) => {
      const text = chunk.toString();
      lastBootBuf = (lastBootBuf + text).slice(-16000);
      if (text.trim()) {
        log(`[dsh] ${text.trim()}`);
        const line = text.trim().split('\n').pop();
        if (onOut) onOut(line);
      }
      buf += text;
      if (buf.length > 262144) buf = buf.slice(-262144); // 启动输出限量:防超长日志撑爆内存
      // dsh web 启动后打印形如 "dsh web: http://127.0.0.1:7123" 的地址行;
      // 仅匹配 "dsh web:" 前缀行(旧的兜底分支会把任意回环地址输出误判为服务地址)
      const m = buf.match(/dsh web:\s*(https?:\/\/\S+)/);
      if (m) settle(resolve, { child, url: m[1] });
    };
    const onExit = (code) => settle(reject, new Error(`dsh web 启动后即退出 (code=${code})\n${buf.slice(-2000)}`));
    const timer = setTimeout(() => settle(reject, new Error(`等待 dsh web 输出服务地址超时(${BOOT_URL_TIMEOUT_MS / 1000}s)\n${buf.slice(-2000)}`)), BOOT_URL_TIMEOUT_MS);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

// 返回 true=就绪;false=被取消(重启/退出),调用方应静默放弃本轮
function waitServerReady(url, shouldStop = () => false) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (shouldStop() || quitting) return resolve(false);
      const req = http.get(url, (res) => { res.resume(); resolve(true); }); // 任何 HTTP 状态都说明服务已监听
      req.setTimeout(3000, () => req.destroy(new Error('socket 超时'))); // 连接挂起时及时销毁并重试,防无效连接堆积
      req.on('error', retry);
    };
    const retry = () => {
      if (shouldStop() || quitting) return resolve(false);
      if (Date.now() - startedAt > SERVER_READY_TIMEOUT_MS) return reject(new Error(`dsh web 服务 ${SERVER_READY_TIMEOUT_MS / 1000}s 内未就绪`));
      setTimeout(tryOnce, 400);
    };
    tryOnce();
  });
}

// ---------- 窗口:无边框主窗 + 自绘标题栏(上) + dsh 内容(下) ----------
// dsh 页面从标题栏下方开始渲染,与窗口按钮物理隔离,永不重叠。
// 标题栏可收起(滑动动画),收起后顶部中央出现下拉把手;F11 全屏时自动收起。
const TITLEBAR_H = 30;
const BAR_OVERLAP = 10; // 标题栏底部渐变透明区,覆盖到页面顶端,柔化两者边界
const TITLE_BAR_DEFAULT = '#0d1117';
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
  // 展开时标题栏高度 = 逻辑栏高 + 底部渐变区(盖住页面顶端);收起时完全隐藏
  titlebarView.setBounds({ x: 0, y: 0, width: w, height: currentBarH > 0 ? currentBarH + BAR_OVERLAP : 0 });
  dshView.setBounds({ x: 0, y: currentBarH, width: w, height: Math.max(0, h - currentBarH) });
  // 把手默认隐藏,由 handlePoll 检测到鼠标靠近顶部中央时再浮现
  revealTabView?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

// ---------- 把手浮现:标题栏隐藏期间轮询鼠标位置,靠近顶部中央才显示 ----------
const HANDLE_ZONE = { w: 280, h: 34 }; // 感应区(比把手本身大,防闪烁)
let handlePoll = null;

function startHandlePolling() {
  if (handlePoll) return;
  handlePoll = setInterval(() => {
    if (!mainWindow || !revealTabView || barVisible || currentBarH > 0) return;
    try {
      const p = screen.getCursorScreenPoint();
      const b = mainWindow.getBounds(); // 无边框窗口,bounds 即内容区
      const cx = b.x + b.width / 2;
      const inZone = p.x >= cx - HANDLE_ZONE.w / 2 && p.x <= cx + HANDLE_ZONE.w / 2
        && p.y >= b.y && p.y <= b.y + HANDLE_ZONE.h;
      if (inZone) {
        const [w] = mainWindow.getContentSize();
        revealTabView.setBounds({ x: Math.floor(w / 2 - 32), y: 0, width: 64, height: 20 });
      } else {
        revealTabView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    } catch { /* 窗口销毁等 */ }
  }, 150);
}

function stopHandlePolling() {
  clearInterval(handlePoll);
  handlePoll = null;
  revealTabView?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

function toggleTitlebar(visible, animated = true) {
  if (barVisible === visible) return;
  barVisible = visible;
  closeMenuPopup();
  if (visible) stopHandlePolling();
  clearTimeout(barAnim);
  if (!animated) {
    currentBarH = visible ? TITLEBAR_H : 0;
    layoutViews();
    if (!visible) startHandlePolling();
    return;
  }
  // 平滑滑动:240ms easeInOutCubic,自适应帧间隔(高刷显示器更顺滑)
  const from = currentBarH;
  const to = visible ? TITLEBAR_H : 0;
  const startedAt = Date.now();
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const FRAME_MS = 1000 / 120;
  let last = startedAt;
  const step = () => {
    const now = Date.now();
    const t = Math.min(1, (now - startedAt) / 240);
    currentBarH = Math.round(from + (to - from) * easeInOutCubic(t));
    layoutViews();
    if (t >= 1) {
      barAnim = null;
      if (!visible) startHandlePolling();
      return;
    }
    barAnim = setTimeout(step, Math.max(0, FRAME_MS - (Date.now() - last)));
    last = Date.now();
  };
  barAnim = setTimeout(step, 0);
}

function toggleFullscreen() {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
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

function trayMenuItems() {
  return [
    { type: 'item', id: 'show-main', label: '显示 DSH' },
    { type: 'item', id: 'open-workspace', label: '打开工作目录…', accel: 'Ctrl+O' },
    { type: 'sep' },
    { type: 'item', id: 'close-to-tray', label: '关闭时最小化到托盘', checked: loadConfig().closeAction !== 'quit' },
    { type: 'sep' },
    { type: 'item', id: 'quit', label: '退出' },
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
  let mh = 20; // 上下内边距
  for (const it of items) mh += it.type === 'sep' ? 9 : 30;
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
    webPreferences: { sandbox: true, preload: path.join(__dirname, 'menu-preload.js') },
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
  tray.setToolTip('DSH Desktop');
  tray.on('click', () => showMainWindow());
  tray.on('right-click', () => showTrayMenu());
}

// ---------- 统一状态窗(检查更新/下载/安装/结果,可挂后台到任务栏) ----------
let statusWin = null;        // 状态窗实例
let statusMinimized = false; // 处于"挂后台"(最小化到任务栏)状态
let statusPayload = null;    // 当前展示的载荷(用于增量更新)
let statusQueued = null;     // 窗口未加载完成时排队的载荷
let statusActions = null;    // 结果视图按钮 id → 回调

// 下载时把进度同步到任务栏按钮(窗口挂后台也能看到),其余状态清除进度
function applyStatusProgress(p) {
  if (!statusWin) return;
  try {
    if (p && p.mode === 'download' && typeof p.progress === 'number') {
      statusWin.setProgressBar(Math.max(0, Math.min(1, p.progress / 100)));
    } else {
      statusWin.setProgressBar(-1);
    }
  } catch { /* 窗口已销毁等 */ }
}

function sendStatus(p) {
  if (!statusWin) return;
  statusPayload = p;
  // 结果视图需要 ~226px 内容高度(大图标+标题+多行详情+按钮),固定 186px 会裁掉确定按钮
  const h = p.mode === 'result' ? 250 : 186;
  statusWin.setContentSize(410, h);
  statusWin.setTitle(p.title || 'DSH');
  statusWin.webContents.send('st:set', p);
  applyStatusProgress(p);
  // 挂后台(最小化)期间结果到达:不强制拉起窗口,由桌面通知引导,点击通知再恢复。
  // (否则"挂后台=不打扰"被破坏:窗口自己弹回来 + 通知双提醒)
  if (statusMinimized && p.mode === 'result') return;
  if (statusWin.isMinimized()) statusWin.restore();
  statusWin.show();
  statusWin.focus();
}

function flushStatus() {
  if (!statusQueued || !statusWin) return;
  const p = statusQueued;
  statusQueued = null;
  sendStatus(p);
}

function showStatus(p) {
  statusPayload = p;
  if (!statusWin) {
    statusWin = new BrowserWindow({
      width: 410, height: 186, useContentSize: true,
      frame: false, resizable: false, skipTaskbar: false, show: false,
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'status-preload.js') },
    });
    statusWin.setMenuBarVisibility(false);
    statusWin.loadFile(path.join(__dirname, 'status.html')).catch(() => {});
    statusWin.webContents.once('did-finish-load', flushStatus);
    statusWin.on('closed', () => { statusWin = null; statusMinimized = false; statusActions = null; });
    statusWin.on('minimize', () => { statusMinimized = true; });
    statusWin.on('restore', () => { statusMinimized = false; });
    statusQueued = p;
    return;
  }
  if (statusQueued) { statusQueued = p; return; } // 窗口仍在加载:更新排队载荷
  sendStatus(p); // 窗口已就绪:直接下发(修复"检查后结果永远不显示")
}

function updateStatus(patch) {
  if (statusQueued) { statusQueued = { ...statusQueued, ...patch }; statusPayload = statusQueued; return; }
  if (!statusWin) return;
  statusPayload = { ...(statusPayload || {}), ...patch };
  statusWin.webContents.send('st:set', statusPayload);
  applyStatusProgress(statusPayload);
}

function closeStatus() {
  statusWin?.destroy();
  statusWin = null;
  statusActions = null;
}

// 挂后台期间有结果到达 → 桌面通知,点击恢复状态窗
function statusNotify(title, body) {
  if (!statusMinimized || !statusWin) return;
  try {
    const n = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.ico') });
    n.on('click', () => { if (!statusWin) return; statusWin.restore(); statusWin.show(); statusWin.focus(); });
    n.show();
  } catch (e) { log(`通知失败: ${e.message}`); }
}

// 结果视图:type=info/success/warning/error;回程按钮走 onAction(id)
// nonIntrusive=true 用于被动路径(自动检查的通知点击等):若桌面端更新流程正占着结果窗
// (发现新版本/下载/就绪),跳过本次弹窗,避免两个更新流互相顶掉按钮——用户仍可从菜单重查。
function showStatusResult(p, onAction, nonIntrusive) {
  if (nonIntrusive && (downloadInProgress || (statusPayload?.mode === 'result' && statusPayload?.__origin === 'desktop'))) {
    log(`跳过被动结果弹窗(桌面更新流程进行中): ${p.title}`);
    return;
  }
  statusActions = onAction || null;
  showStatus({ ...p, mode: 'result' });
  statusNotify(p.title || 'DSH', String(p.detail || '').split('\n')[0]);
}

ipcMain.on('st:bg', () => { if (statusWin && !statusWin.isMinimized()) statusWin.minimize(); });
ipcMain.on('st:close', () => closeStatus());
ipcMain.on('st:action', (_e, id) => {
  const fn = statusActions;
  statusActions = null;
  if (fn) fn(id);
});
// ✕ 按钮语义 = 取消当前操作并关闭窗口(检查/下载/安装);「后台」按钮才是最小化
ipcMain.on('st:cancel', () => cancelStatusOp());
// 取消当前状态窗对应操作:清计时器、忽略迟到结果、中止下载/停止 npm 安装、关闭窗口
function cancelStatusOp() {
  log('用户取消当前操作(状态窗关闭)');
  statusOpCancelled = true;
  if (updateCheckTimer) finishUpdateCheckTimer();
  if (dshCheckTimer) finishDshCheckTimer();
  manualCheckTimedOut = true;     // 忽略迟到的桌面端检查结果
  dshManualCheckTimedOut = true;  // 忽略迟到的 dsh 本体检查结果
  if (downloadInProgress) desktopDownloadCanceled = true; // 正在下载:迟到结果不再弹窗
  if (downloadToken) { downloadToken.cancel(); downloadToken = null; } // 中止桌面端下载传输
  downloadInProgress = false;
  updateDownloaded = false;
  pendingVersion = null;
  if (dshInstallChild) {
    installCancelled = true;
    const c = dshInstallChild;
    dshInstallChild = null;
    killTree(c);
  }
  // 安装 dsh 本体期间服务已被暂停:取消后立即恢复,避免应用失去 dsh 服务
  if (dshStoppedForInstall) {
    dshStoppedForInstall = false;
    if (!quitting) bootDsh();
  }
  closeStatus();
}

// ---------- 通用深色对话框(替代原生 MessageBox;文件选择仍用原生) ----------
let dialogWin = null;
let dialogQueued = null;
let dialogCb = null;

function centerOn(win, ref) {
  try {
    const b = ref && !ref.isDestroyed() ? ref.getBounds() : screen.getPrimaryDisplay().workArea;
    const [w, h] = win.getContentSize();
    win.setPosition(Math.round(b.x + (b.width - w) / 2), Math.round(b.y + (b.height - h) / 2));
  } catch { /* 忽略 */ }
}

// 对话框内容高度估算:按信息量与当前宽度粗算(全角按 2 单位宽),并 clamp 到工作区内。
// 宁可略高:多余空间由 detail 滚动区吸收,不会遮住按钮。
// 半角/标点按 1 单位,全角中文字符按 2 单位;每行容量 = 2 × 可容纳全角字符数。
function dialogTextLines(s, cpl) {
  if (!s) return 0;
  let n = 0;
  for (const seg of String(s).split('\n')) {
    let w = 0;
    for (const ch of seg) w += ch.charCodeAt(0) > 0x2e ? 2 : 1;
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
  const wa = screen.getPrimaryDisplay().workArea;
  return Math.min(Math.max(200, h), Math.max(240, wa.height - 120));
}

function flushDialog() {
  if (!dialogQueued || !dialogWin) return;
  const o = dialogQueued;
  dialogQueued = null;
  const w = o.width || 460;
  dialogWin.setContentSize(w, dialogHeightFor(o, w));
  dialogWin.setTitle(o.title || 'DSH');
  dialogWin.webContents.send('dl:show', o);
  centerOn(dialogWin, mainWindow);
  dialogWin.show();
  dialogWin.focus();
}

// opts: { type:'info'|'success'|'warning'|'error', title, message, detail, width, buttons:[{label,primary}] }
function showDialog(opts, cb) {
  dialogCb = cb || null;
  if (!dialogWin) {
    dialogWin = new BrowserWindow({
      width: 460, height: 220, useContentSize: true,
      frame: false, resizable: false, skipTaskbar: true, show: false, parent: mainWindow,
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'dialog-preload.js') },
    });
    dialogWin.setMenuBarVisibility(false);
    dialogWin.loadFile(path.join(__dirname, 'dialog.html')).catch(() => {});
    dialogWin.webContents.once('did-finish-load', flushDialog);
    dialogWin.on('closed', () => { dialogWin = null; });
    dialogQueued = opts;
    return;
  }
  if (dialogQueued) { dialogQueued = opts; return; } // 仍在加载:更新排队载荷
  // 已就绪:直接展示(修复第二次调用不显示)
  const w = opts.width || 460;
  dialogWin.setContentSize(w, dialogHeightFor(opts, w));
  dialogWin.setTitle(opts.title || 'DSH');
  dialogWin.webContents.send('dl:show', opts);
  centerOn(dialogWin, mainWindow);
  dialogWin.show();
  dialogWin.focus();
}

ipcMain.on('dl:choose', (_e, i) => {
  const cb = dialogCb;
  dialogCb = null;
  dialogWin?.hide();
  if (cb) cb(i);
});

// ---------- 下载加速设置窗(可视化表单:分段数 / 镜像源,改动即时写入 config.json) ----------
const ACCEL_SEGMENTS_MIN = 2;
const ACCEL_SEGMENTS_MAX = 16;
let accelWin = null;
let accelQueued = false; // 窗口仍在加载中(等待 did-finish-load 后展示)

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
  };
}

function flushAccel() {
  if (!accelQueued || !accelWin) return;
  accelQueued = false;
  accelWin.webContents.send('acc:show', accelSettingsFromConfig());
  centerOn(accelWin, mainWindow);
  accelWin.show();
  accelWin.focus();
}

function showAccelSettings() {
  if (!accelWin) {
    accelWin = new BrowserWindow({
      width: 520, height: 556, useContentSize: true,
      frame: false, resizable: false, skipTaskbar: true, show: false, parent: mainWindow,
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'accel-preload.js') },
    });
    accelWin.setMenuBarVisibility(false);
    accelWin.loadFile(path.join(__dirname, 'accel.html')).catch(() => {});
    accelWin.webContents.once('did-finish-load', flushAccel);
    accelWin.on('closed', () => { accelWin = null; });
    accelQueued = true;
    return;
  }
  if (accelQueued) return; // 仍在加载:等 did-finish-load 统一展示
  accelWin.webContents.send('acc:show', accelSettingsFromConfig());
  centerOn(accelWin, mainWindow);
  accelWin.show();
  accelWin.focus();
}

ipcMain.on('acc:close', () => accelWin?.hide());

ipcMain.on('acc:copy', (_e, text) => clipboard.writeText(String(text || '')));

ipcMain.handle('acc:get', () => accelSettingsFromConfig());

// 校验并保存单个设置项;返回 {ok} 或 {ok:false,error}
ipcMain.handle('acc:set', (_e, { field, value }) => {
  if (field === 'segments') {
    const v = Math.round(Number(value));
    if (!Number.isFinite(v)) return { ok: false, error: '分段数必须是整数(2-16)' };
    const clamped = Math.max(ACCEL_SEGMENTS_MIN, Math.min(ACCEL_SEGMENTS_MAX, v));
    const cfg = loadConfig();
    cfg.downloadSegments = clamped;
    saveConfig(cfg);
    log(`下载加速设置: 分段数 → ${clamped}`);
    return { ok: true, value: clamped };
  }
  if (field === 'mirror') {
    const raw = String(value || '').trim();
    if (raw && !/^https?:\/\//i.test(raw)) return { ok: false, error: '镜像地址必须以 http:// 或 https:// 开头' };
    const cfg = loadConfig();
    if (raw) cfg.downloadMirror = raw;
    else delete cfg.downloadMirror;
    saveConfig(cfg);
    log(`下载加速设置: 镜像源 ${raw ? '→ ' + raw : '已清除'}`);
    return { ok: true, value: raw };
  }
  return { ok: false, error: '未知设置项' };
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
  reportWin.setTitle(o.name || 'DSH 错误报告');
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
  const ctx = {
    app, screen,
    phase: opts.phase,
    error: opts.error || null,
    code: opts.code != null ? opts.code : null,
    buf: opts.buf || lastBootBuf,
    logFile,
    crashFile: crashFilePath(),
    configPath: configPath(),
    workspace: loadConfig().workspace,
    userData: app.getPath('userData'),
    dshBin: findDshBinSafe(),
    nodeExe: findNodeSafe(),
    args: lastBootArgs,
    elapsedMs: lastBootStart ? Date.now() - lastBootStart : null,
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
  const logPreview = String(ctx.buf || '').slice(-3000) || diagnostics.tailFile(logFile, 60) || '';
  const payload = {
    phase: opts.phase,
    badge: opts.phase === 'exit' ? '进程退出' : '启动失败',
    name: rep.cls.title,
    cause: rep.cls.cause,
    suggestions: rep.cls.suggestions || [],
    logPreview,
    reportPath: rep.filePath,
    actions: opts.actions || [],
  };

  if (!reportWin) {
    reportWin = new BrowserWindow({
      width: 760, height: 600, minWidth: 640, minHeight: 480, useContentSize: true,
      frame: false, resizable: true, show: false,
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'report-preload.js') },
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
  reportWin.setTitle(payload.name || 'DSH 错误报告');
  reportWin.webContents.send('rp:show', payload);
  centerOn(reportWin, mainWindow);
  reportWin.show();
  reportWin.focus();
}

ipcMain.on('rp:export', () => {
  if (!reportWin) return;
  const def = reportPath || path.join(app.getPath('userData'), 'dsh-error-report.txt');
  const save = dialog.showSaveDialogSync(reportWin, {
    title: '导出错误报告',
    defaultPath: def,
    filters: [{ name: '文本报告', extensions: ['txt'] }],
  });
  if (!save) return;
  try {
    fs.writeFileSync(save, reportText, 'utf8');
    reportWin.webContents.send('rp:exported', save);
    shell.showItemInFolder(save);
  } catch (e) {
    log(`报告导出失败: ${e.message}`);
  }
});
ipcMain.on('rp:copy', () => {
  clipboard.writeText(reportText);
  reportWin?.webContents.send('rp:copied');
});
ipcMain.on('rp:open-log', () => { if (reportLogFile) shell.showItemInFolder(reportLogFile); });
ipcMain.on('rp:action', (_e, id) => {
  if (id === '_close') return closeReportWindow();
  closeReportWindow();
  if (id === 'quit') app.quit();
  else if (id === 'retry' || id === 'restart') bootDsh();
});

// ---------- 应用更新(对接 GitHub Releases,electron-updater) ----------
const { autoUpdater, CancellationToken } = require('electron-updater');
autoUpdater.autoDownload = false;        // 由用户确认后再下载
autoUpdater.autoInstallOnAppQuit = false; // 用户选"稍后"即本次跳过,下次启动检查时再提示
// 便携版由 electron-builder 注入 PORTABLE_EXECUTABLE_DIR:自更新会走 NsisUpdater 把用户"转正"成
// 安装版(下载 Setup.exe 并安装),与便携预期不符,故禁用桌面端自动更新,引导手动下载
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
const UPDATE_CHECK_MAX_MS = 60_000; // 检查请求在途超过该时长 → 看门狗日志(自动检查无超时,只告警不弹窗)

let manualCheck = false;
let manualCheckTimedOut = false; // 手动检查超时后,忽略迟到的结果事件
let updateCheckTimer = null;
let updateCheckInFlight = false; // 是否有检查请求在途(网络挂起时用于看门狗告警)
let pendingVersion = null; // 桌面端已发现/已下载的新版本号(仅供桌面端流程;dsh 本体更新不写此变量)
let updateDownloaded = false;
let downloadInProgress = false; // 处于下载阶段(错误信息区分"检查失败/下载失败")
let desktopDownloadCanceled = false; // 用户已取消桌面端下载:迟到结果不得再弹窗
let downloadToken = null; // 当前桌面端下载的取消令牌(✕ 取消时中止网络传输)
let statusOpCancelled = false;  // 用户已取消当前状态窗操作(忽略迟到结果)

function finishUpdateCheckTimer() {
  clearTimeout(updateCheckTimer);
  updateCheckTimer = null;
}

// ---------- 桌面端更新加速下载(多线程分段,失败回退官方) ----------
// electron-updater 的下载缓存按 sha512 校验复用(pending/update-info.json + 安装包):
// 我们先用自己的多线程下载器把安装包抓到缓存目录并写好校验信息,
// 随后官方 downloadUpdate() 会命中缓存、瞬间触发 update-downloaded —— 全程复用官方安装流程。
function updaterCachePendingDir() {
  // updaterCacheDirName 由 electron-builder 写入打包后的 resources/app-update.yml
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const m = /^\s*updaterCacheDirName:\s*['"]?([^'"\s#]+)/m.exec(yml);
    if (m && m[1]) {
      const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(base, m[1], 'pending');
    }
  } catch { /* 未打包/配置缺失,回退官方下载 */ }
  return null;
}

// 返回 true=加速下载完成且已写入官方缓存;false=本次回退官方下载(镜像失败/不支持分段等)
async function acceleratedDownload(info) {
  const fileInfo = (info && info.files && info.files[0]) || null;
  const pendingDir = updaterCachePendingDir();
  let fileName = null;
  try { fileName = path.basename(new URL(fileInfo && fileInfo.url).pathname); } catch { /* ignore */ }
  if (!fileInfo || !fileInfo.url || !fileInfo.sha512 || !pendingDir || !fileName) {
    log('加速下载不可用(文件信息或缓存目录缺失),直接走官方下载');
    return false;
  }
  // 镜像源(config.json 可选,默认关闭):目录形态,与 GenericProvider 一致(含同名 latest.yml 与安装包)
  const mirror = loadConfig().downloadMirror;
  const url = mirror ? resolveDownloadUrl(fileInfo.url, mirror) : fileInfo.url;
  if (url !== fileInfo.url) log(`加速下载使用镜像源: ${url}`);
  // 分段数(config.json 可选,默认 6;由"下载加速设置"窗口调整)
  const segCfg = loadConfig().downloadSegments;
  const segments = Math.max(ACCEL_SEGMENTS_MIN, Math.min(ACCEL_SEGMENTS_MAX, Math.round(Number(segCfg) || DEFAULT_SEGMENTS)));
  const tempFile = path.join(pendingDir, `temp-${fileName}`);
  const finalFile = path.join(pendingDir, fileName);
  const speedFrom = Date.now();
  try {
    await fs.promises.mkdir(pendingDir, { recursive: true });
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    await multiThreadDownload(url, tempFile, {
      segments,
      sha512: fileInfo.sha512,
      onProgress: (p) => {
        if (!statusWin || statusPayload?.mode !== 'download') return;
        const dt = Math.max(1, Date.now() - speedFrom);
        const speed = (p.transferred / dt) * 1000;
        updateStatus({
          mode: 'download', progress: p.percent,
          pct: p.percent.toFixed(1) + '%',
          size: `${Math.round(p.transferred / 1048576)} / ${Math.round(p.total / 1048576)} MB · ${(speed / 1048576).toFixed(1)} MB/s`,
        });
      },
      isCancelled: () => !!(downloadToken && downloadToken.isCancelled) || quitting,
    });
    // 与 electron-updater 缓存约定保持一致:文件名 = 官方 URL 的 basename,sha512 = latest.yml 的 sha512
    await fs.promises.rename(tempFile, finalFile);
    await fs.promises.writeFile(path.join(pendingDir, 'update-info.json'), JSON.stringify({ fileName, sha512: fileInfo.sha512 }));
    log(`加速下载完成: ${url} → ${finalFile}`);
    return true;
  } catch (e) {
    // 清理残留(含 update-info.json,避免旧校验信息干扰官方回退),然后回退官方下载
    await Promise.all([
      fs.promises.rm(tempFile, { force: true }).catch(() => {}),
      fs.promises.rm(finalFile, { force: true }).catch(() => {}),
      fs.promises.rm(path.join(pendingDir, 'update-info.json'), { force: true }).catch(() => {}),
    ]);
    log(`加速下载失败(将回退官方下载): ${e.message}`);
    return false;
  }
}

// 统一下载入口:先加速,再走官方 downloadUpdate()。
// 加速成功 → 命中缓存立即 update-downloaded;加速失败 → 官方单连接下载进度照常。
async function runUpdateDownload(info) {
  await acceleratedDownload(info);
  if (quitting || desktopDownloadCanceled) return;
  await autoUpdater.downloadUpdate(downloadToken);
}

autoUpdater.on('update-available', (info) => {
  if (manualCheckTimedOut) return; // 手动检查已超时,忽略迟到结果
  finishUpdateCheckTimer();
  pendingVersion = info.version;
  showStatusResult({
    type: 'info', title: '发现新版本', __origin: 'desktop',
    detail: `新版本 v${info.version} 可用(当前 v${app.getVersion()})\n「现在更新」将用多线程加速下载,完成后自动重启安装;「稍后」则跳过本次更新。`,
    buttons: [{ id: 'dl', label: '现在更新', primary: true }, { id: 'later', label: '稍后' }],
  }, (id) => {
    if (id === 'later' || quitting) return closeStatus();
    statusOpCancelled = false;
    desktopDownloadCanceled = false; // 新一轮下载:清掉上次的取消标记
    downloadToken = new CancellationToken(); // ✕ 取消时可真正中止下载传输
    showStatus({ mode: 'download', title: `正在下载 v${info.version}…`, detail: `当前 v${app.getVersion()}`, pct: '0%', size: '' });
    downloadInProgress = true;
    runUpdateDownload(info).catch((e) => {
      downloadToken = null;
      downloadInProgress = false;
      if (desktopDownloadCanceled) { desktopDownloadCanceled = false; return; } // 用户取消:静默收尾
      log(`更新下载失败: ${e.message}`);
      if (!quitting) {
        showStatusResult({
          type: 'error', title: '更新下载失败', __origin: 'desktop',
          detail: `原因: ${e.message}\n可稍后重试,或重新检查更新。`,
          buttons: [{ id: 'ok', label: '好的' }],
        }, () => closeStatus());
      }
    });
  });
});

autoUpdater.on('download-progress', (p) => {
  if (!statusWin || statusPayload?.mode !== 'download') return;
  const speed = p.bytesPerSecond ? `${(p.bytesPerSecond / 1048576).toFixed(1)} MB/s` : '';
  updateStatus({
    mode: 'download',
    progress: p.percent,
    pct: p.percent.toFixed(1) + '%',
    size: `${Math.round(p.transferred / 1048576)} / ${Math.round(p.total / 1048576)} MB${speed ? ' · ' + speed : ''}`,
  });
});

autoUpdater.on('update-downloaded', () => {
  downloadToken = null; // 下载已结束
  if (statusOpCancelled || desktopDownloadCanceled) { updateDownloaded = false; return; } // 用户取消,迟到结果不再弹窗
  desktopDownloadCanceled = false;
  downloadInProgress = false;
  updateDownloaded = true;
  showStatusResult({
    type: 'success', title: '更新就绪', __origin: 'desktop',
    detail: `v${pendingVersion} 已下载完成,现在重启并安装?`,
    buttons: [{ id: 'install', label: '立即重启安装', primary: true }, { id: 'later', label: '稍后' }],
  }, (id) => {
    if (id === 'install') autoUpdater.quitAndInstall(true, true);
    else closeStatus();
  });
});

autoUpdater.on('update-not-available', () => {
  if (manualCheckTimedOut) return;
  finishUpdateCheckTimer();
  if (manualCheck) {
    showStatusResult({
      type: 'info', title: '检查更新', __origin: 'desktop',
      detail: `当前已是最新版本(v${app.getVersion()})。`,
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => closeStatus());
  }
});

autoUpdater.on('error', (e) => {
  if (manualCheckTimedOut) return; // 已按超时处理过,不再弹错
  finishUpdateCheckTimer();
  const wasDownload = downloadInProgress;
  downloadInProgress = false;
  log(`更新检查失败: ${e.message}`);
  if (!manualCheck && !wasDownload) return; // 自动检查出错静默
  showStatusResult({
    type: 'error', title: wasDownload ? '更新下载失败' : '检查更新失败', __origin: 'desktop',
    detail: `原因: ${e.message}${wasDownload ? '\n可稍后重试,或重新检查更新。' : '\n请确认网络可用后重试。'}`,
    buttons: [{ id: 'ok', label: '好的' }],
  }, () => closeStatus());
});

function checkForUpdates(manual) {
  manualCheck = manual;
  manualCheckTimedOut = false;
  statusOpCancelled = false;
  if (manual && downloadInProgress) {
    // 已有下载在进行:回到下载进度窗口而不是覆盖它(否则进度 UI 丢失、下载仍在后台)
    log('手动检查更新被忽略:下载仍在进行中');
    if (statusWin) showStatus(statusPayload || { mode: 'download', title: '正在下载更新…', spin: true });
    return;
  }
  if (!app.isPackaged) {
    if (manual) {
      showDialog({
        type: 'info', title: '检查更新',
        message: '开发模式下不支持在线更新,请使用打包后的应用。',
        buttons: [{ label: '好的', primary: true }],
      });
    }
    return;
  }
  if (IS_PORTABLE) {
    // 便携版会走 NsisUpdater 下载 Setup.exe 并安装,把用户"转正"成安装版,与便携预期不符 → 禁用
    if (manual) {
      showDialog({
        type: 'info', title: '检查更新',
        message: '便携版不支持自动更新,请前往 GitHub Releases 下载新版本。',
        buttons: [{ label: '好的', primary: true }],
      });
    }
    return;
  }
  if (updateDownloaded) {
    // 已下载过:直接询问是否重启安装
    showStatusResult({
      type: 'success', title: '更新就绪', __origin: 'desktop',
      detail: `v${pendingVersion} 已下载完成,现在重启并安装?`,
      buttons: [{ id: 'install', label: '立即重启安装', primary: true }, { id: 'later', label: '取消' }],
    }, (id) => {
      if (id === 'install') autoUpdater.quitAndInstall(true, true);
      else closeStatus();
    });
    return;
  }
  // 手动检查:显示"检查中"状态窗,设超时;超时仍未取到版本信息则终止本次检查并告知用户
  if (manual) {
    finishUpdateCheckTimer();
    showStatus({ mode: 'check', title: '正在检查更新…', detail: `当前 v${app.getVersion()}`, spin: true });
    updateCheckTimer = setTimeout(() => {
      updateCheckTimer = null;
      manualCheckTimedOut = true;
      log('检查更新超时');
      showStatusResult({
        type: 'warning', title: '检查更新超时', __origin: 'desktop',
        detail: `${CHECK_UPDATE_TIMEOUT_MS / 1000} 秒内未能获取最新版本信息,请确认网络可用后再试。`,
        buttons: [{ id: 'ok', label: '好的' }],
      }, () => closeStatus());
    }, CHECK_UPDATE_TIMEOUT_MS);
  }
  // 看门狗:自动检查没有超时弹窗,网络挂起时要留痕(electron-updater 在途请求会被后续检查复用)
  updateCheckInFlight = true;
  setTimeout(() => {
    if (updateCheckInFlight) log(`更新检查超过 ${UPDATE_CHECK_MAX_MS / 1000} 秒未返回,请检查网络/代理与 GitHub 连通性`);
  }, UPDATE_CHECK_MAX_MS);
  autoUpdater.checkForUpdates()
    .then(() => { updateCheckInFlight = false; })
    .catch((e) => { updateCheckInFlight = false; log(`更新检查失败: ${e.message}`); });
}

// ---------- dsh 本体更新(对接 npm registry,检查流程与桌面端更新保持一致) ----------
// 与桌面端更新相同的语义:启动时静默检查、菜单手动检查带超时、发现新版弹"现在更新/稍后"、
// 只有手动触发才弹"已是最新/失败",安装完成后提示重启 dsh 服务。
// 解析 semver 版本号(支持 v 前缀与 -pre 后缀,如 0.1.1-rc.2 / v1.2.3);
// 返回 { nums:[major,minor,patch], pre:[...] },pre 为空数组表示正式版;无法解析返回 null
function parseVersion(v) {
  const s = String(v || '').replace(/^v/i, '').trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  const nums = [1, 2, 3].map((i) => (m[i] ? parseInt(m[i], 10) : 0));
  const pre = m[4] ? m[4].split('.') : [];
  return { nums, pre };
}
// 预发布段逐段比较(semver 规则):数字段按数值、字母段按字典序、数字段 < 字母段、段耗尽者更旧
function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 正式版 > 任何预发布
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return parseInt(x, 10) < parseInt(y, 10) ? -1 : 1;
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
// a < b → -1;a === b → 0;a > b → 1;任一无法解析 → 0(不误报更新)
function compareVersion(a, b) {
  const va = parseVersion(a), vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va.nums[i] !== vb.nums[i]) return va.nums[i] < vb.nums[i] ? -1 : 1;
  }
  return comparePre(va.pre, vb.pre);
}

let cachedNpmCli = null;
function findNpmCli() {
  if (cachedNpmCli) return cachedNpmCli;
  const npm = firstLine(IS_WIN ? 'where npm.cmd' : 'which npm');
  cachedNpmCli = npm || (IS_WIN ? 'npm.cmd' : 'npm');
  return cachedNpmCli;
}

// 定位 npm-cli.js(直接由 node 执行):Windows 上 spawn .cmd 会同步抛 EINVAL,必须走 node + cli.js
let cachedNpmCliJs = null;
function findNpmCliJs() {
  if (cachedNpmCliJs) return cachedNpmCliJs;
  const cands = [findNpmCli()];
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'npm.cmd'));
  for (const c of cands) {
    if (!c) continue;
    const js = path.join(path.dirname(c), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(js)) { cachedNpmCliJs = js; return js; }
  }
  return null;
}

// 从 npm registry 读取 dsh 最新版本号(带超时;返回版本号字符串,失败返回 null)
function fetchLatestDshVersion(timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(dshRegistryUrl(), { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
        if (data.length > 1_000_000) req.destroy(new Error('响应过大'));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(data).version || null); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', () => resolve(null));
    // 总超时兜底:连接卡死(DNS/TCP 不可达)时 socket 空闲超时不一定触发,这里保证按时返回
    const overall = setTimeout(() => req.destroy(new Error('总超时')), timeoutMs + 1000);
    req.on('close', () => clearTimeout(overall));
  });
}

let dshCheckTimer = null;
let dshManualCheckTimedOut = false; // 手动检查超时后,忽略迟到的结果
let dshInstallChild = null; // 正在运行的 npm 安装进程(供 ✕ 取消)
let installCancelled = false; // 用户已取消安装(忽略安装结果)
let installEpoch = 0; // 安装代数:每次安装递增,旧安装的迟到回调(close/error/超时)一律失效
let dshStoppedForInstall = false; // 安装期间已暂停 dsh 服务(退出路径务必恢复,成败都恢复)

function finishDshCheckTimer() {
  clearTimeout(dshCheckTimer);
  dshCheckTimer = null;
}

// 通过 npm 全局安装 dsh 新版本;安装期间暂停当前 dsh 服务,结束(成败/取消/超时)后自动恢复。
// 更新对象就是当前正在运行的包:Windows 上一面运行一面替换目录最容易 EPERM,先停服务再装。
async function installDshUpdate(version) {
  const myEpoch = ++installEpoch;
  statusOpCancelled = false;
  installCancelled = false;
  if (quitting) return;
  // 停掉当前 dsh web 进程(本体文件正被它使用)
  if (dshChild) {
    bootSeq++; // 旧 dsh 的 exit 处理器因序号过期而忽略这次主动停止
    const old = dshChild;
    dshChild = null;
    dshStoppedForInstall = true;
    log('安装 dsh 本体更新:先停止当前 dsh 服务');
    try { await killTree(old); } catch (e) { log(`停止 dsh 服务失败: ${e.message}`); }
  }
  // 等待停止期间可能已被 ✕ 取消 / 退出 / 更新的安装取代
  if (quitting || installCancelled || myEpoch !== installEpoch) { dshStoppedForInstall = false; return; }
  // Windows 上 spawn .cmd/.bat 必须走 shell,否则同步抛 EINVAL 且函数中断、状态窗永远停在"请稍后"。
  // 首选 node + npm-cli.js(稳定、无注入面、进程树可清理);找不到再退回 shell 方式。
  const node = findNodeSafe();
  const npmCliJs = process.env.DSH_UITEST_FAKE_NPM || findNpmCliJs(); // UITEST 时注入假 npm 脚本
  const npm = findNpmCli();
  let exec, args, opts;
  if (node && npmCliJs) {
    exec = node;
    args = [npmCliJs, 'install', '-g', `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund']; // 锁版本+跳过 audit/fund 减负
    opts = { windowsHide: true };
  } else {
    exec = npm;
    args = ['install', '-g', `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund'];
    opts = { shell: true, windowsHide: true };
  }
  log(`安装 dsh 本体更新: ${exec} ${args.join(' ')}`);
  showStatus({ mode: 'install', title: `正在安装 dsh 本体 v${version}…`, detail: `npm install -g @deepseek-ai/dsh@${version}`, spin: true });
  let child = null;
  try {
    child = spawn(exec, args, opts);
  } catch (e) {
    // 启动失败必须反馈到窗口,不能静默卡在"请稍后";服务已停,先拉回来
    log(`无法启动 npm 安装进程: ${e.message}`);
    dshStoppedForInstall = false;
    if (!quitting) bootDsh();
    showStatusResult({
      type: 'error', title: 'dsh 更新失败', __origin: 'dsh',
      detail: `无法启动 npm:${e.message}\ndsh 服务已恢复(旧版本)。`,
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => closeStatus());
    return;
  }
  dshInstallChild = child;
  let buf = '';
  let lastOutAt = Date.now();
  let idleTimer = null;
  let totalTimer = null;
  let finished = false;
  const clearTimers = () => { clearInterval(idleTimer); clearTimeout(totalTimer); idleTimer = totalTimer = null; };
  // 超时护栏:UITEST 压短以便回归验证;生产用常量
  const idleMs = process.env.DSH_DESKTOP_UITEST ? 1500 : DSH_INSTALL_IDLE_TIMEOUT_MS;
  const totalMs = process.env.DSH_DESKTOP_UITEST ? 4000 : DSH_INSTALL_TOTAL_TIMEOUT_MS;
  // finish 幂等(spawn 失败时 Node 会同时触发 error 与 close,只处理一次)+ 安装代数隔离
  const finish = (ok, msg) => {
    if (finished) return;
    finished = true;
    if (myEpoch !== installEpoch) return; // 已有更新的安装启动,旧结果丢弃
    if (dshInstallChild === child) dshInstallChild = null;
    clearTimers();
    const stoppedForInstall = dshStoppedForInstall;
    dshStoppedForInstall = false;
    if (quitting || installCancelled) return; // 取消/超时中止:忽略迟到结果
    // 无论成败都恢复 dsh 服务(成功跑新版本,失败跑旧版本),不再依赖用户手动点"重启 dsh"
    if (stoppedForInstall) bootDsh();
    const actual = ok ? dshVersion(true) : null; // 强制刷新版本缓存,展示刚装上的版本
    log(ok ? `dsh 本体更新完成(实际 v${actual || version})` : `dsh 更新安装失败: ${msg}`);
    showStatusResult({
      type: ok ? 'success' : 'error',
      title: ok ? 'dsh 更新完成' : 'dsh 更新失败', __origin: 'dsh',
      detail: ok
        ? `dsh 本体已更新(当前版本 v${actual || version}),dsh 服务已自动重启生效。`
        : `${msg}\n${buf.slice(-300)}\ndsh 服务已恢复(旧版本)。`,
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => closeStatus());
  };
  const onData = (c) => {
    const text = c.toString();
    if (text.trim()) log(`[npm] ${text.trim().slice(-500)}`);
    buf += text;
    if (buf.length > 8000) buf = buf.slice(-8000);
    // npm 进度/日志用 \r 覆盖写,需按 \r\n|\r|\n 分段,最新一段作为详情
    const segs = String(text).split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean);
    if (segs.length) {
      lastOutAt = Date.now();
      updateStatus({ mode: 'install', title: `正在安装 dsh 本体 v${version}…`, detail: segs[segs.length - 1].slice(0, 130), spin: true });
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  // 无输出护栏:长时间没有新输出 → 提示可能的卡因(网络慢/安装挂起),但不自动中止
  idleTimer = setInterval(() => {
    if (Date.now() - lastOutAt > idleMs) {
      updateStatus({
        mode: 'install', title: `正在安装 dsh 本体 v${version}…`,
        detail: 'npm 长时间无输出,可能因网络慢或安装卡住;可点 ✕ 取消(将恢复 dsh 服务)重试',
        spin: true,
      });
    }
  }, 5000);
  // 总超时护栏:强制终止并报错,绝不无限"请稍后"
  totalTimer = setTimeout(() => {
    if (myEpoch !== installEpoch || quitting || installCancelled || dshInstallChild !== child) return;
    log('dsh 安装超时,强制终止 npm 进程');
    installCancelled = true; // 让 close 回调忽略后续结果,避免重复弹窗
    if (dshStoppedForInstall) { dshStoppedForInstall = false; if (!quitting) bootDsh(); }
    killTree(child);
    showStatusResult({
      type: 'error', title: 'dsh 更新失败', __origin: 'dsh',
      detail: `npm 安装超时(${Math.round(totalMs / 60000)} 分钟)已中止,dsh 服务已恢复(旧版本)。`,
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => closeStatus());
  }, totalMs);
  child.on('close', (code) => {
    finish(code === 0, code === 0 ? '' : `npm 安装失败 (code=${code})`);
  });
  child.on('error', (e) => finish(false, `无法启动 npm:${e.message}`));
}

function checkDshUpdate(manual) {
  finishDshCheckTimer();
  dshManualCheckTimedOut = false;
  statusOpCancelled = false;
  if (manual && (dshInstallChild || dshStoppedForInstall)) {
    // 本体安装进行中:回到安装进度窗口而不是覆盖
    log('手动检查 dsh 更新被忽略:安装仍在进行中');
    if (statusWin) showStatus(statusPayload || { mode: 'install', title: '正在安装 dsh 本体…', spin: true });
    return;
  }
  // 仅打包版才有"桌面端更新";dsh 本体检查在开发模式同样可用,故不设 isPackaged 门槛
  const current = dshVersion();
  if (current === '未知') {
    log('检查 dsh 更新: 未定位到 dsh 本体,跳过');
    if (manual) {
      showDialog({
        type: 'warning', title: '检查 dsh 更新',
        message: '未检测到 dsh 本体,请先全局安装:',
        detail: 'npm install -g @deepseek-ai/dsh',
        buttons: [{ label: '好的', primary: true }],
      });
    }
    return;
  }
  // 手动检查:显示"检查中"状态窗,设超时
  if (manual) {
    showStatus({ mode: 'check', title: '正在检查 dsh 本体更新…', detail: `当前 v${current}`, spin: true });
    dshCheckTimer = setTimeout(() => {
      dshCheckTimer = null;
      dshManualCheckTimedOut = true;
      log('检查 dsh 更新超时');
      showStatusResult({
        type: 'warning', title: '检查 dsh 更新超时', __origin: 'dsh',
        detail: `${CHECK_DSH_UPDATE_TIMEOUT_MS / 1000} 秒内未能获取 dsh 最新版本信息,请确认网络可用后再试。`,
        buttons: [{ id: 'ok', label: '好的' }],
      }, () => closeStatus());
    }, CHECK_DSH_UPDATE_TIMEOUT_MS);
  }
  fetchLatestDshVersion(CHECK_DSH_UPDATE_TIMEOUT_MS + 1000).then((latest) => {
    if (dshManualCheckTimedOut) return; // 已按超时处理,忽略迟到结果
    finishDshCheckTimer();
    if (!latest) {
      log('检查 dsh 更新失败: 未能获取最新版本信息');
      if (manual) {
        showStatusResult({
          type: 'error', title: '检查 dsh 本体更新失败', __origin: 'dsh',
          detail: '请确认网络可用后重试。',
          buttons: [{ id: 'ok', label: '好的' }],
        }, () => closeStatus());
      }
      return;
    }
    if (compareVersion(latest, current) > 0) {
      log(`发现 dsh 新版本 v${latest}(当前 v${current})`);
      // 注意:不写 pendingVersion(那是桌面端专用),dsh 版本号全程走闭包参数
      const showResult = (nonIntrusive) => showStatusResult({
        type: 'info', title: '发现 dsh 新版本', __origin: 'dsh',
        detail: `dsh 本体新版本 v${latest} 可用(当前 v${current})\n「现在更新」将暂停 dsh 服务、通过 npm 全局安装新版本,完成后自动重启 dsh 服务。`,
        buttons: [{ id: 'install', label: '现在更新', primary: true }, { id: 'later', label: '稍后' }],
      }, (id) => {
        if (id === 'install' && !quitting) installDshUpdate(latest);
        else closeStatus();
      }, nonIntrusive);
      if (!manual) {
        // 自动检查:只发桌面通知(点击后再弹窗),不抢占正在进行的检查窗口;
        // 通知点击若撞上桌面更新占位(发现新版本/下载中)则跳过,菜单仍可手动查
        try {
          if (Notification.isSupported()) {
            const n = new Notification({
              title: '发现 dsh 新版本',
              body: `dsh 本体 v${latest} 可用(当前 v${current}),点击查看。`,
              icon: path.join(__dirname, 'assets', 'icon.ico'),
            });
            n.on('click', () => showResult(true));
            n.show();
            log('自动检查发现 dsh 新版本:已发桌面通知(未弹出窗口)');
            return;
          }
        } catch (e) { log(`dsh 更新桌面通知失败: ${e.message}`); }
        showResult(true);
      } else {
        showResult(false);
      }
    } else if (manual) {
      showStatusResult({
        type: 'info', title: '检查 dsh 更新', __origin: 'dsh',
        detail: `dsh 本体已是最新版本(v${current})。`,
        buttons: [{ id: 'ok', label: '好的' }],
      }, () => closeStatus());
    }
  });
}

// ---------- 自绘菜单弹层(替代原生 Menu.popup,风格与应用统一) ----------
function menuItems() {
  return [
    { type: 'item', id: 'open-workspace', label: '打开工作目录…', accel: 'Ctrl+O' },
    { type: 'item', id: 'restart-dsh', label: '重启 dsh 服务', accel: 'Ctrl+Shift+R' },
    { type: 'item', id: 'open-browser', label: '在浏览器中打开' },
    { type: 'sep' },
    { type: 'item', id: 'fullscreen', label: '全屏', accel: 'F11' },
    { type: 'item', id: 'toggle-bar', label: barVisible ? '隐藏标题栏' : '显示标题栏', accel: 'Ctrl+Shift+B' },
    { type: 'item', id: 'reload', label: '重新加载页面', accel: 'F5' },
    { type: 'item', id: 'devtools', label: '开发者工具', accel: 'F12' },
    { type: 'sep' },
    { type: 'item', id: 'dsh-home', label: '打开 dsh 数据目录' },
    { type: 'item', id: 'log', label: '打开日志文件' },
    { type: 'item', id: 'check-update', label: IS_PORTABLE ? '检查更新…(便携版请手动下载)' : `检查更新…(当前 v${app.getVersion()})` },
    { type: 'item', id: 'check-dsh-update', label: `检查 dsh 本体更新…(当前 v${dshVersion()})` },
    { type: 'item', id: 'download-accel', label: '下载加速设置…' },
    { type: 'sep' },
    { type: 'item', id: 'auto-open-browser', label: '自动打开浏览器', checked: !!loadConfig().openBrowser },
    { type: 'item', id: 'close-to-tray', label: '关闭时最小化到托盘', checked: loadConfig().closeAction !== 'quit' },
    { type: 'sep' },
    // 注意:这里不显示 Alt+F4 快捷键。默认「关闭时最小化到托盘」下,Alt+F4 只隐藏窗口而非退出,
    // 提示该快捷键会误导用户;点击本项是真正的 app.quit()
    { type: 'item', id: 'quit', label: '退出' },
  ];
}

const MENU_W = 264;
const MENU_MARGIN = 12; // 视图四周留白,容纳阴影

function showMenuPopup() {
  if (!mainWindow || !menuPopupView) return;
  closeTrayMenu(); // 与托盘菜单互斥
  const items = menuItems();
  let mh = 20; // 上下内边距
  for (const it of items) mh += it.type === 'sep' ? 9 : 30;
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
  menuPopupView?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  titlebarView?.webContents.send('tb:menu-state', false);
  if (refocus) dshView?.webContents.focus();
}

// 左上角菜单按钮:点击打开,再点关闭(toggle);blur 自动收起后 350ms 内再点不算重开
ipcMain.on('tb:menu', () => {
  const open = !!menuPopupView && menuPopupView.getBounds().width > 0;
  if (open || Date.now() - menuClosedAt < 350) { closeMenuPopup(true); return; }
  showMenuPopup();
});

ipcMain.on('m:action', (e, id) => {
  // 区分来源:主窗口菜单弹层 / 托盘菜单小窗
  const fromTray = trayMenuWin && e.sender === trayMenuWin.webContents;
  if (fromTray) closeTrayMenu();
  else closeMenuPopup(true);
  switch (id) {
    case 'show-main': showMainWindow(); break;
    case 'open-workspace': changeWorkspace(); break;
    case 'restart-dsh': bootDsh(); break;
    case 'open-browser': if (dshWebUrl) shell.openExternal(dshWebUrl); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'toggle-bar': toggleTitlebar(!barVisible); break;
    case 'reload': dshView?.webContents.reload(); break;
    case 'devtools': dshView?.webContents.toggleDevTools(); break;
    case 'dsh-home': shell.openPath(path.join(os.homedir(), '.dsh')); break;
    case 'log': shell.showItemInFolder(logFile); break;
    case 'check-update': checkForUpdates(true); break;
    case 'check-dsh-update': checkDshUpdate(true); break;
    case 'download-accel': {
      showAccelSettings(); // 可视化设置窗:分段数 / 镜像源即时保存到 config.json
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
      log(`关闭行为已切换为: ${cfg.closeAction === 'quit' ? '直接退出' : '最小化到托盘'}`);
      break;
    }
    case 'quit': app.quit(); break;
  }
});
ipcMain.on('m:close', (e) => {
  if (trayMenuWin && e.sender === trayMenuWin.webContents) closeTrayMenu();
  else closeMenuPopup(true);
});

// 标题栏底色跟随 dsh 页面实际背景色,视觉上与内容融为一体
async function syncTitleBarTheme() {
  const wc = dshView?.webContents;
  if (!wc || !titlebarView) return;
  try {
    const bg = await wc.executeJavaScript(
      'getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor',
    );
    const m = bg && bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
    if (!m || (m[4] !== undefined && +m[4] === 0)) return; // 透明背景则保持默认色
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    titlebarView.webContents.send('tb:theme', { bg: hex, fg: lum < 0.5 ? '#9aa0a6' : '#5f6368' });
    // 视图表面底色跟随页面色:缩放/未绘制边缘露出的底色与页面一致,不突兀
    titlebarView.setBackgroundColor(hex);
  } catch { /* 页面未就绪等,忽略 */ }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: TITLE_BAR_DEFAULT,
    frame: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'), // 用 ico:任务栏/标题栏小尺寸有原生 16/24/32 档
  });
  mainWindow.setMenuBarVisibility(false);

  titlebarView = new WebContentsView({
    webPreferences: { sandbox: true, preload: path.join(__dirname, 'titlebar-preload.js') },
  });
  // View 默认底色是白色:Windows 无边框窗口顶沿的隐形系统边框带/未绘制区会露出白边,必须显式设暗色
  titlebarView.setBackgroundColor(TITLE_BAR_DEFAULT);
  titlebarView.webContents.loadFile(path.join(__dirname, 'titlebar.html')).catch(() => {});

  dshView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  dshView.webContents.setBackgroundThrottling(false);
  dshView.webContents.loadFile(path.join(__dirname, 'loading.html')).catch(() => {});
  // 同上:标题栏收起时 dshView 顶边就是窗口顶边,同样防白边/未绘制区露白
  dshView.setBackgroundColor(TITLE_BAR_DEFAULT);
  dshView.webContents.on('did-finish-load', () => {
    syncTitleBarTheme();
    dshView?.webContents.focus();
  });
  // dsh 页面里的外链(文档/仓库等)交给系统浏览器
  dshView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
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
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  // dsh 页面内元素全屏(HTML5 fullscreen,如视频/演示):收齐标题栏让内容占满,退出时恢复
  dshView.webContents.on('enter-html-full-screen', () => {
    if (barVisible) { barBeforeHtmlFullscreen = barVisible; toggleTitlebar(false, false); }
  });
  dshView.webContents.on('leave-html-full-screen', () => toggleTitlebar(barBeforeHtmlFullscreen, false));

  // 标题栏收起后顶部的下拉把手
  revealTabView = new WebContentsView({
    webPreferences: { sandbox: true, preload: path.join(__dirname, 'titlebar-preload.js') },
  });
  revealTabView.setBackgroundColor('#00000000'); // 圆角处的透明角落不露白
  revealTabView.webContents.loadFile(path.join(__dirname, 'reveal-tab.html')).catch(() => {});

  // 自绘菜单弹层(最后添加,位于最上层)
  menuPopupView = new WebContentsView({
    webPreferences: { sandbox: true, preload: path.join(__dirname, 'menu-preload.js') },
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

  // 堆叠顺序(后加的上层):dsh 页面 → 标题栏(底部渐变区盖住页面顶端)→ 下拉把手 → 菜单弹层
  mainWindow.contentView.addChildView(dshView);
  mainWindow.contentView.addChildView(titlebarView);
  mainWindow.contentView.addChildView(revealTabView);
  mainWindow.contentView.addChildView(menuPopupView);
  layoutViews();
  applyWindowState(); // 恢复上次的位置/大小/最大化(校验仍落在某屏幕工作区内)
  mainWindow.on('resize', layoutViews);
  mainWindow.on('maximize', () => { layoutViews(); titlebarView?.webContents.send('tb:maximized', true); });
  mainWindow.on('unmaximize', () => { layoutViews(); titlebarView?.webContents.send('tb:maximized', false); });
  // 全屏:标题栏自动收起;退出全屏恢复进入前的状态(用户手动隐藏标题栏后全屏,退出时不应被强制显示)
  mainWindow.on('enter-full-screen', () => { barBeforeFullscreen = barVisible; toggleTitlebar(false, false); });
  mainWindow.on('leave-full-screen', () => toggleTitlebar(barBeforeFullscreen, false));
  mainWindow.show();
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
    if (quitting || loadConfig().closeAction === 'quit') return;
    e.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null; dshView = null; titlebarView = null; revealTabView = null; menuPopupView = null;
    // 「关闭即退出」模式下主窗口是唯一主载体:直接退出,不等状态窗等辅助窗口也关闭
    if (loadConfig().closeAction === 'quit' && !quitting) app.quit();
  });
}

// ---------- 标题栏按钮 → 主进程 ----------
ipcMain.on('tb:min', () => mainWindow?.minimize());
ipcMain.on('tb:max', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('tb:close', () => mainWindow?.close());
ipcMain.on('tb:hide-bar', () => toggleTitlebar(false));
ipcMain.on('tb:show-bar', () => toggleTitlebar(true));

// ---------- 启动 / 重启 dsh 并加载页面 ----------
async function bootDsh() {
  const seq = ++bootSeq;
  if (dshChild) {
    const old = dshChild;
    dshChild = null;
    await killTree(old);
  }
  if (!dshView) return;
  dshWebUrl = null; // 重启期间旧地址失效

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

  const cwd = loadConfig().workspace;
  titlebarView?.webContents.send('tb:workspace', cwd);
  try {
    stage(1, '启动 dsh web 服务…');
    const { child, url } = await startDsh(cwd, (line) => {
      if (seq !== bootSeq || settledUrl || !dshView || loadingFlush) return;
      dshView.webContents.executeJavaScript(`pushLog(${JSON.stringify(line.slice(0, 160))})`).catch(() => {});
    });
    dshChild = child;
    child.once('exit', (code) => {
      if (quitting || seq !== bootSeq) return;
      log(`dsh web 进程意外退出 (code=${code})`);
      showReport({
        phase: 'exit',
        error: null,
        code,
        buf: lastBootBuf,
        actions: [
          { id: 'restart', label: '重启 dsh', style: 'primary' },
          { id: 'quit', label: '退出', style: 'danger' },
        ],
      });
    });
    log(`服务地址: ${url},等待 HTTP 就绪…`);
    dshWebUrl = url;
    stage(2, '等待服务就绪…');
    const ready = await waitServerReady(url, () => seq !== bootSeq);
    if (!ready || quitting || seq !== bootSeq || !dshView) return;
    log(`加载 ${url}`);
    stage(3, '加载页面…');
    settledUrl = true;
    dshView.webContents.loadURL(url).catch(() => {}); // 加载中再次重启,旧导航被取消(ERR_ABORTED),忽略
  } catch (err) {
    if (quitting || seq !== bootSeq) return;
    log(`启动失败: ${err.message}`);
    showReport({
      phase: 'boot',
      error: err,
      code: null,
      buf: lastBootBuf,
      actions: [
        { id: 'retry', label: '重试', style: 'primary' },
        { id: 'quit', label: '退出', style: 'danger' },
      ],
    });
  }
}

// ---------- 工作目录(决定文件归属与会话列表,与本体共享的关键) ----------
function ensureWorkspace() {
  const cfg = loadConfig();
  if (cfg.workspace && fs.existsSync(cfg.workspace)) return cfg.workspace;
  const pick = dialog.showOpenDialogSync({
    title: '选择 dsh 的工作目录(文件与会话都归属于它)',
    properties: ['openDirectory'],
    defaultLocation: app.getPath('home'), // 用户主目录(不能硬编码 D:\,无 D 盘机器会行为不确定)
  });
  if (pick && pick[0]) {
    saveConfig({ ...cfg, workspace: pick[0] });
    return pick[0];
  }
  return null; // 用户取消,直接退出
}
function changeWorkspace() {
  const cfg = loadConfig();
  // 托盘态触发时主窗口是隐藏的:原生父窗口对话框不会正常显示,先恢复主窗口
  if (mainWindow && !mainWindow.isVisible()) showMainWindow();
  const pick = dialog.showOpenDialogSync(mainWindow, {
    title: '切换工作目录(将重启 dsh 服务)',
    properties: ['openDirectory'],
    defaultLocation: cfg.workspace || app.getPath('home'),
  });
  if (!pick || !pick[0]) return;
  saveConfig({ ...cfg, workspace: pick[0] });
  bootDsh();
}

// ---------- 菜单 ----------
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '打开工作目录…', accelerator: 'CmdOrCtrl+O', click: changeWorkspace },
        { label: '重启 dsh 服务', accelerator: 'CmdOrCtrl+Shift+R', click: () => bootDsh() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '全屏', accelerator: 'F11', click: toggleFullscreen },
        { label: '显示/隐藏标题栏', accelerator: 'CmdOrCtrl+Shift+B', click: () => toggleTitlebar(!barVisible) },
        { type: 'separator' },
        { label: '重新加载页面', accelerator: 'F5', click: () => dshView?.webContents.reload() },
        { label: '开发者工具', accelerator: 'F12', click: () => dshView?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开 dsh 数据目录 (~/.dsh)', click: () => shell.openPath(path.join(os.homedir(), '.dsh')) },
        { label: '打开日志文件', click: () => shell.showItemInFolder(logFile) },
        { label: '检查 dsh 本体更新', click: () => checkDshUpdate(true) },
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
    const ws = ensureWorkspace();
    if (!ws) {
      log('未选择工作目录,退出');
      app.quit();
      return;
    }
    log(`工作目录: ${ws}`);
    buildMenu();
    createWindow();
    createTray();
    bootDsh();

    // 启动 6 秒后静默检查更新(仅打包版;不打扰,有新版才弹提示)
    setTimeout(() => { if (app.isPackaged) checkForUpdates(false); }, 6_000);
    // 12 秒后静默检查 dsh 本体更新(错开桌面端更新检查,避免两个弹窗同时出现)
    setTimeout(() => checkDshUpdate(false), 12_000);

    // 自动化冒烟:DSH_DESKTOP_SMOKE=1 自动退出;DSH_DESKTOP_DEMO=1 额外按阶段
    // 切换标题栏/全屏状态并写出窗口屏幕坐标(DSH_DEMO_BOUNDS 指定 JSON 路径),
    // 供外部脚本对真实窗口截屏验证
    if (process.env.DSH_DESKTOP_SMOKE || process.env.DSH_DESKTOP_DEMO) {
      if (process.env.DSH_DESKTOP_DEMO) {
        const demoShot = (name, win = mainWindow) => {
          try {
            const b = win.getBounds();
            const d = screen.getDisplayMatching(b);
            fs.writeFileSync(process.env.DSH_DEMO_BOUNDS, JSON.stringify({
              name,
              x: Math.round(b.x * d.scaleFactor),
              y: Math.round(b.y * d.scaleFactor),
              w: Math.round(b.width * d.scaleFactor),
              h: Math.round(b.height * d.scaleFactor),
            }));
            log(`DEMO: 阶段 ${name}`);
          } catch (e) { log(`DEMO: 坐标输出失败 ${e.message}`); }
        };
        setTimeout(() => demoShot('1-bar'), 9_000);
        setTimeout(() => { showMenuPopup(); setTimeout(() => demoShot('2-menu'), 900); }, 10_500);
        setTimeout(() => {
          closeMenuPopup();
          saveConfig({ ...loadConfig(), closeAction: 'tray' });
          mainWindow?.close(); // 应被拦截:隐藏到托盘而非退出
          setTimeout(() => {
            log(`SMOKE: close 后窗口可见=${mainWindow?.isVisible()}(期望 false),进程仍存活`);
            showTrayMenu(); // 此刻外部脚本已把鼠标移到托盘区,菜单在光标处弹出
            setTimeout(() => {
              if (trayMenuWin) demoShot('3-tray-menu', trayMenuWin);
              closeTrayMenu();
              showMainWindow();
              setTimeout(() => {
                log(`SMOKE: 托盘恢复后窗口可见=${mainWindow?.isVisible()}(期望 true)`);
                app.quit();
              }, 600);
            }, 900);
          }, 800);
        }, 12_300);
      } else {
        setTimeout(() => { log('SMOKE: 自动退出'); app.quit(); }, 16_000);
      }
    }

    // 自动 UI 冒烟:DSH_DESKTOP_UITEST=1 依次弹出 状态窗(检查→下载→结果)/ 对话框 / 错误报告窗,
    // 抓取各窗口渲染器控制台报错与加载失败,随后自动退出(供回归验证)
    if (process.env.DSH_DESKTOP_UITEST) {
      const hookWin = (win, tag) => {
        if (!win) return;
        win.webContents.on('console-message', (e) => {
          log(`UITEST ${tag} console(${e.level}): ${e.message}`);
        });
        win.webContents.on('did-fail-load', (_e, code, desc) => {
          log(`UITEST ${tag} did-fail-load ${code}: ${desc}`);
        });
      };
      const uiStep = (fn, delay, tag) => setTimeout(() => { try { fn(); log(`UITEST ${tag} ✓`); } catch (err) { log(`UITEST ${tag} ✗ 主进程异常: ${err.stack || err}`); } }, delay);
      const readDom = (win, expr, tag) => win?.webContents.executeJavaScript(expr)
        .then((v) => log(`UITEST dom ${tag} = "${v}"`))
        .catch((e) => log(`UITEST dom ${tag} ✗ ${e.message}`));
      // ① 状态窗翻页(本版修复点:窗口已打开时结果必须能送达)与取消语义
      uiStep(() => { showStatus({ mode: 'check', title: '正在检查更新…', detail: '当前 v0.0.0', spin: true }); hookWin(statusWin, 'status'); }, 3500, 'status-show');
      uiStep(() => showStatusResult({ type: 'success', title: '更新就绪', detail: 'v9.9.9 已下载完成', buttons: [{ id: 'install', label: '立即重启安装', primary: true }] }, () => {}), 4200, 'flip-result');
      uiStep(() => readDom(statusWin, 'document.getElementById("rtitle").textContent', 'flip'), 4600);
      uiStep(() => log(`UITEST h-result=${statusWin?.getContentSize()[1]}(期望 250,确定按钮可见)`), 4700, 'h-result-verify');
      // 结果态 ✕ = 仅关闭
      uiStep(() => { statusWin?.webContents.executeJavaScript('document.getElementById("xBtn").click()').catch(() => {}); }, 5000, 'result-x');
      uiStep(() => log(`UITEST result-x win=${!!statusWin}(期望 false) → ${!statusWin ? 'PASS' : 'FAIL'}`), 5300, 'result-x-verify');
      // 活动态 ✕ = 取消并关闭
      uiStep(() => showStatus({ mode: 'check', title: '正在检查更新…', detail: '当前 v0.0.0', spin: true }), 5800, 'check2');
      uiStep(() => log(`UITEST h-activity=${statusWin?.getContentSize()[1]}(期望 186)`), 5950, 'h-activity-verify');
      uiStep(() => { statusWin?.webContents.executeJavaScript('document.getElementById("xBtn").click()').catch(() => {}); }, 6100, 'cancel-click');
      uiStep(() => { const ok = !statusWin; log(`UITEST cancel2 win=${!!statusWin} → ${ok ? 'PASS' : 'FAIL'}`); }, 6400, 'cancel-verify');
      // 下载 → 进度 → 结果
      uiStep(() => showStatus({ mode: 'download', title: '正在下载 v9.9.9…', detail: '当前 v0.0.0', pct: '0%', size: '' }), 7000, 'dl-show');
      uiStep(() => updateStatus({ mode: 'download', progress: 42, pct: '42.0%', size: '38 / 89 MB · 4.2 MB/s' }), 7400, 'dl-progress');
      uiStep(() => showStatusResult({ type: 'success', title: '更新就绪(下载完成)', detail: 'v9.9.9 已下载完成', buttons: [{ id: 'install', label: '立即重启安装', primary: true }] }, () => log('UITEST install-click ✓')), 7800, 'dl-result');
      // ② 标题栏动画:收起 → 240ms 后应收敛到 0,再展开 → 应回到 TITLEBAR_H
      uiStep(() => toggleTitlebar(false), 8400, 'bar-collapse');
      uiStep(() => log(`UITEST bar-collapsed h=${currentBarH}(期望 0) → ${currentBarH === 0 ? 'PASS' : 'FAIL'}`), 8900, 'bar-verify0');
      uiStep(() => toggleTitlebar(true), 9200, 'bar-expand');
      uiStep(() => log(`UITEST bar-expanded h=${currentBarH}(期望 ${TITLEBAR_H},PASS=${currentBarH === TITLEBAR_H}) viewH=${titlebarView?.getBounds().height}(期望 ${TITLEBAR_H + BAR_OVERLAP},渐变区露出)`), 9700, 'bar-verify30');
      // ③ 对话框复用(第二次调用必须仍能显示)
      uiStep(() => { showDialog({ type: 'info', title: 'D1', message: '第一个对话框', buttons: [{ label: '好', primary: true }] }); hookWin(dialogWin, 'dialog'); }, 10200, 'd1');
      uiStep(() => showDialog({ type: 'warning', title: 'D2', message: '第二个对话框(复用)', buttons: [{ label: '好', primary: true }] }), 10800, 'd2');
      uiStep(() => readDom(dialogWin, 'document.getElementById("title").textContent', 'd2'), 11200);
      // ④ 报告窗复用(启动失败自动弹出后,再次 showReport 仍要更新内容)
      uiStep(() => showReport({ phase: 'boot', error: new Error('等待 dsh web 输出服务地址超时(90s)'), code: null, buf: '[i] dsh web: 正在启动…', actions: [{ id: 'retry', label: '重试', style: 'primary' }] }), 11800, 'report2');
      uiStep(() => readDom(reportWin, 'document.getElementById("name").textContent', 'report'), 12400);
      // ⑤ 菜单 toggle:打开 → 点击按钮关闭 → 再点打开
      uiStep(() => showMenuPopup(), 13000, 'menu-open');
      uiStep(() => log(`UITEST menu-open w=${menuPopupView?.getBounds().width}(期望 ${MENU_W + MENU_MARGIN * 2}) → ${menuPopupView?.getBounds().width > 0 ? 'PASS' : 'FAIL'}`), 13300, 'menu-open-verify');
      uiStep(() => { titlebarView?.webContents.executeJavaScript('document.getElementById("menuBtn").click()').catch(() => {}); }, 13500, 'menu-toggle-close');
      uiStep(() => log(`UITEST menu-toggled-close w=${menuPopupView?.getBounds().width}(期望 0) → ${menuPopupView?.getBounds().width === 0 ? 'PASS' : 'FAIL'}`), 13750, 'menu-close-verify');
      uiStep(() => { titlebarView?.webContents.executeJavaScript('document.getElementById("menuBtn").click()').catch(() => {}); }, 13900, 'menu-toggle-open');
      uiStep(() => log(`UITEST menu-toggled-open w=${menuPopupView?.getBounds().width}(期望 ${MENU_W + MENU_MARGIN * 2}) → ${menuPopupView?.getBounds().width > 0 ? 'PASS' : 'FAIL'}`), 14150, 'menu-reopen-verify');
      // ⑤' 对话框高度自适应:长 detail(下载加速设置)必须加高窗口,按钮不被推出
      uiStep(() => showDialog({
        type: 'info', title: '下载加速设置', width: 540,
        message: '桌面端更新已默认启用多线程分段下载;仍慢时可配置镜像源,或为 npm 切换国内镜像。',
        detail: `【桌面端】在配置文件中加入镜像根目录(目录内需含 latest.yml 与安装包,文件名与 GitHub Release 资产一致):\n  "downloadMirror": "https://镜像根目录/",\n配置文件位置:\n  ${configPath()}\n\n【dsh 本体】执行下面命令改用国内 npm 镜像:\n  npm config set registry https://registry.npmmirror.com\n\n提示:镜像源不稳定时,下载会自动回退官方源,不影响更新。`,
        buttons: [{ label: '好的', primary: true }],
      }), 14300, 'accel-dialog');
      uiStep(() => {
        const s = dialogWin?.getContentSize();
        const ok = !!s && s[0] === 540 && s[1] >= 260;
        log(`UITEST accel-h=${s?.[1]}(期望 540 宽且高≥260,原 220 会遮按钮) → ${ok ? 'PASS' : 'FAIL'}`);
      }, 14600, 'accel-size-verify');
      uiStep(() => readDom(dialogWin, '(()=>{const r=document.querySelector("#foot button").getBoundingClientRect();return r.bottom<=innerHeight+1?`VISIBLE bottom=${Math.round(r.bottom)}/h=${innerHeight}`:`CLIPPED bottom=${Math.round(r.bottom)}/h=${innerHeight}`})()', 'accel-btn'), 14700);
      uiStep(() => { dialogWin?.webContents.executeJavaScript('document.querySelector("#foot button").click()').catch(() => {}); }, 14900, 'accel-close');
      // ⑥ dsh 本体安装(本版修复:Windows spawn .cmd 抛 EINVAL → 状态窗永远"请稍后")
      //    成功路径:假 npm 输出两行后正常退出 0 → 应出现"dsh 更新完成"结果窗
      fs.writeFileSync(path.join(app.getPath('userData'), 'fake-npm-ok.js'),
        "process.stdout.write('fetching dsh metadata...\\n');setTimeout(()=>{process.stdout.write('added 1 package in 2s\\n');process.exit(0);},900);");
      fs.writeFileSync(path.join(app.getPath('userData'), 'fake-npm-hang.js'),
        "process.stdout.write('hanging...\\n');setInterval(()=>{},1000);");
      uiStep(() => { process.env.DSH_UITEST_FAKE_NPM = path.join(app.getPath('userData'), 'fake-npm-ok.js'); installDshUpdate('9.9.9'); hookWin(statusWin, 'status'); }, 15200, 'dsh-install-ok');
      uiStep(() => readDom(statusWin, 'document.getElementById("title").textContent', 'install-title'), 15500);
      uiStep(() => readDom(statusWin, 'document.getElementById("rtitle").textContent', 'install-result'), 16400);
      uiStep(() => { statusWin?.webContents.executeJavaScript('Array.from(document.querySelectorAll("#btns button")).find(b=>b.textContent==="好的").click()').catch(() => {}); }, 16600, 'install-later');
      uiStep(() => log(`UITEST install-later win=${!!statusWin}(期望 false) → ${!statusWin ? 'PASS' : 'FAIL'}`), 16800, 'install-later-verify');
      //    超时护栏:假 npm 挂死不退出 → 总超时应强制终止并弹"dsh 更新失败"
      uiStep(() => { process.env.DSH_UITEST_FAKE_NPM = path.join(app.getPath('userData'), 'fake-npm-hang.js'); installDshUpdate('9.9.9'); }, 17600, 'dsh-install-hang');
      uiStep(() => readDom(statusWin, 'document.getElementById("rtitle").textContent', 'install-timeout'), 22000);
      uiStep(() => { statusWin?.webContents.executeJavaScript('Array.from(document.querySelectorAll("#btns button")).find(b=>b.textContent==="好的").click()').catch(() => {}); }, 22150, 'install-okbtn');
      uiStep(() => log(`UITEST install-timeout win=${!!statusWin}(期望 false) → ${!statusWin ? 'PASS' : 'FAIL'}`), 22300, 'install-okbtn-verify');
      // ⑦ 多线程下载器冒烟:本地 HTTP 服务(支持 Range)提供 2MB 随机文件,
      //    验证分段并发下载、sha512 校验、镜像 URL 拼接
      setTimeout(async () => {
        const http = require('node:http');
        const cr = require('node:crypto');
        const payload = cr.randomBytes(2 * 1024 * 1024);
        const expect = cr.createHash('sha512').update(payload).digest('base64');
        const server = http.createServer((req, res) => {
          const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
          if (m) {
            const s = +m[1], e = Math.min(+m[2], payload.length - 1);
            res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${s}-${e}/${payload.length}`, 'Content-Length': String(e - s + 1) });
            res.end(payload.subarray(s, e + 1));
          } else {
            res.writeHead(200, { 'Content-Length': String(payload.length) });
            res.end(payload);
          }
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const port = server.address().port;
        const dest = path.join(app.getPath('userData'), 'dl-test.bin');
        try {
          const dl = require('./downloader');
          await dl.multiThreadDownload(`http://127.0.0.1:${port}/pkg.bin`, dest, { sha512: expect });
          const got = await dl.hashFile(dest);
          const mirrorUrl = dl.resolveDownloadUrl('https://github.com/x/y/releases/download/v1/a.exe', 'https://m.example.com/dir/');
          log(`UITEST downloader-multi PASS=${got === expect} size=${payload.length} seg=${dl.DEFAULT_SEGMENTS} mirror=${mirrorUrl}`);
        } catch (err) {
          log(`UITEST downloader-multi ✗ ${err.stack || err}`);
        } finally {
          server.close();
          try { fs.unlinkSync(dest); } catch { /* ignore */ }
        }
        // ⑧ 下载加速设置窗冒烟:打开 → 读当前默认 → 保存分段数/镜像源(含非法值校验) → 关闭
        try {
          showAccelSettings();
          hookWin(accelWin, 'accel');
          await new Promise((resolve) => accelWin.webContents.once('did-finish-load', resolve));
          await new Promise((r) => setTimeout(r, 350)); // 等渲染层 A.get() 初始化表单
          const before = await accelWin.webContents.executeJavaScript('window.__accel.get()');
          const uiSeg = await accelWin.webContents.executeJavaScript('document.getElementById("segN").textContent');
          const s1 = await accelWin.webContents.executeJavaScript('window.__accel.set("segments", 12)');
          const cfg1 = loadConfig().downloadSegments;
          const s2 = await accelWin.webContents.executeJavaScript('window.__accel.set("mirror", "https://m.example.com/dir/")');
          const cfg2 = loadConfig().downloadMirror;
          const bad = await accelWin.webContents.executeJavaScript('window.__accel.set("mirror", "not-a-url")');
          const s3 = await accelWin.webContents.executeJavaScript('window.__accel.set("mirror", "")');
          const cfg3 = loadConfig().downloadMirror; // delete 后应为 undefined
          const ok = before.segments === 6 && before.downloadMirror === '' && uiSeg === '6'
            && s1.ok && s1.value === 12 && cfg1 === 12
            && s2.ok && cfg2 === 'https://m.example.com/dir/'
            && !bad.ok && s3.ok && cfg3 === undefined;
          log(`UITEST accel-win ✓ UIseg=${uiSeg} → ${ok ? 'PASS' : 'FAIL'} (seg=${cfg1} mirror=${cfg2} bad=${!bad.ok} cleared=${cfg3 === undefined})`);
          accelWin.close();
        } catch (err) {
          log(`UITEST accel-win ✗ ${err.stack || err}`);
        }
      }, 23200);
      setTimeout(() => {
        // 清理 UITEST 写入 userData 的假 npm 脚本
        for (const f of ['fake-npm-ok.js', 'fake-npm-hang.js']) {
          try { fs.unlinkSync(path.join(app.getPath('userData'), f)); } catch { /* 已不存在 */ }
        }
        log('UITEST: 完成,自动退出');
        app.quit();
      }, 25000);
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (e) => {
    // 无条件先置退出标志:否则在 dsh 启动失败(dshChild 为空)时,
    // 窗口 close 会被"最小化到托盘"拦截,app.quit() 将永远无法完成
    quitting = true;
    flushLog();
    stopHandlePolling();
    // dsh web 与进行中的 npm 安装都要随退出终止,避免留下孤儿进程
    const children = [dshChild, dshInstallChild].filter(Boolean);
    if (cleaned || children.length === 0) { cleaned = true; return; }
    e.preventDefault();
    dshChild = null;
    dshInstallChild = null;
    log('退出:终止 dsh web / npm 安装进程树');
    Promise.all(children.map(killTree)).finally(() => {
      flushLog();
      cleaned = true;
      app.quit();
    });
  });
}