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
process.on('uncaughtException', (err) => {
  try { require('fs').writeFileSync(require('path').join(__dirname, 'CRASH.txt'), `${new Date().toISOString()}\n${err.stack || err}`); } catch (e) { /* 无法落盘 */ }
});
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeTheme, screen, shell, WebContentsView, Notification, clipboard } = require('electron');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const diagnostics = require('./diagnostics');

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
const DSH_REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'; // dsh 本体最新版本查询地址

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

// ---------- 日志(内存缓冲 + 定期批量刷盘,避免高频 stdout 把主进程卡在同步 IO 上) ----------
const logFile = path.join(app.getPath('userData'), 'dsh-web.log');
let logBuf = [];
let logTimer = null;
function flushLog() {
  if (!logBuf.length) return;
  const data = logBuf.join('');
  logBuf = [];
  try {
    fs.appendFileSync(logFile, data);
  } catch (e) {
    try { fs.appendFileSync(path.join(__dirname, 'CRASH.txt'), `log失败: ${e.message}\n`); } catch { /* 彻底失败 */ }
  }
}
function log(line) {
  const s = String(line);
  logBuf.push(`[${new Date().toISOString()}] ${s.length > 2000 ? s.slice(0, 2000) + '…' : s}\n`);
  if (!logTimer) logTimer = setInterval(flushLog, 500);
}
process.on('uncaughtException', (err) => {
  const now = new Date().toISOString();
  try { fs.appendFileSync(path.join(__dirname, 'CRASH.txt'), `${now}\n${err.stack || err}\n`); } catch (e) { /* 无法落盘 */ }
  log(`未捕获异常: ${err.stack || err}`);
  // 生成错误报告落盘(不弹窗,避免打扰);仅当 app 已就绪且能取到路径
  try {
    if (app && app.isReady()) {
      const ctx = {
        app, screen, phase: 'uncaught', error: err, code: null, buf: lastBootBuf,
        logFile, crashFile: path.join(__dirname, 'CRASH.txt'), configPath: configPath(),
        workspace: loadConfig().workspace, userData: app.getPath('userData'),
        dshBin: findDshBinSafe(), nodeExe: findNodeSafe(), args: lastBootArgs,
        elapsedMs: lastBootStart ? Date.now() - lastBootStart : null,
      };
      try { diagnostics.buildReport(ctx); } catch (e2) { log(`诊断落盘失败: ${e2.message}`); }
    }
  } catch (e3) { /* 忽略 */ }
});

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
  if (node) {
    cachedNode = { exe: node, env: process.env };
    return cachedNode;
  }
  // 兜底:让 Electron 二进制以纯 Node 模式运行
  cachedNode = { exe: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
  return cachedNode;
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

// 读取已定位 dsh 包的版本号(写入启动日志,便于跨版本排查兼容问题)
function dshVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(findDshBin()), '..', 'package.json'), 'utf8')).version;
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
      // dsh web 启动后打印形如 "dsh web: http://127.0.0.1:7123" 的地址行
      const m = buf.match(/dsh web: (https?:\/\/\S+)/) || buf.match(/https?:\/\/(127\.0\.0\.1|localhost):\d+/);
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
const TITLE_BAR_DEFAULT = '#0d1117';
let dshView = null;
let titlebarView = null;
let revealTabView = null;
let menuPopupView = null;
let barVisible = true;
let currentBarH = TITLEBAR_H;
let barAnim = null;

function layoutViews() {
  if (!mainWindow || !titlebarView || !dshView) return;
  const [w, h] = mainWindow.getContentSize();
  titlebarView.setBounds({ x: 0, y: 0, width: w, height: currentBarH });
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
  });
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

function flushStatus() {
  if (!statusQueued || !statusWin) return;
  const p = statusQueued;
  statusQueued = null;
  statusPayload = p;
  statusWin.setTitle(p.title || 'DSH');
  statusWin.webContents.send('st:set', p);
  if (statusWin.isMinimized()) statusWin.restore();
  statusWin.show();
  statusWin.focus();
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
    statusWin.loadFile(path.join(__dirname, 'status.html'));
    statusWin.webContents.once('did-finish-load', flushStatus);
    statusWin.on('closed', () => { statusWin = null; statusMinimized = false; statusActions = null; });
    statusWin.on('minimize', () => { statusMinimized = true; });
    statusWin.on('restore', () => { statusMinimized = false; });
    statusQueued = p;
    return;
  }
  flushStatus();
}

function updateStatus(patch) {
  if (statusQueued) { statusQueued = { ...statusQueued, ...patch }; statusPayload = statusQueued; return; }
  if (!statusWin) return;
  statusPayload = { ...(statusPayload || {}), ...patch };
  statusWin.webContents.send('st:set', statusPayload);
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
    n.on('click', () => { statusWin?.show(); statusWin?.focus(); });
    n.show();
  } catch (e) { log(`通知失败: ${e.message}`); }
}

// 结果视图:type=info/success/warning/error;回程按钮走 onAction(id)
function showStatusResult(p, onAction) {
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
// 取消当前状态窗对应操作:清计时器、忽略迟到结果、停止 npm 安装、关闭窗口
function cancelStatusOp() {
  log('用户取消当前操作(状态窗关闭)');
  statusOpCancelled = true;
  if (updateCheckTimer) finishUpdateCheckTimer();
  if (dshCheckTimer) finishDshCheckTimer();
  manualCheckTimedOut = true;     // 忽略迟到的桌面端检查结果
  dshManualCheckTimedOut = true;  // 忽略迟到的 dsh 本体检查结果
  downloadInProgress = false;
  updateDownloaded = false;
  pendingVersion = null;
  if (dshInstallChild) {
    installCancelled = true;
    const c = dshInstallChild;
    dshInstallChild = null;
    killTree(c);
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

function flushDialog() {
  if (!dialogQueued || !dialogWin) return;
  const o = dialogQueued;
  dialogQueued = null;
  dialogWin.setTitle(o.title || 'DSH');
  dialogWin.webContents.send('dl:show', o);
  centerOn(dialogWin, mainWindow);
  dialogWin.show();
  dialogWin.focus();
}

// opts: { type:'info'|'success'|'warning'|'error', title, message, detail, buttons:[{label,primary}] }
function showDialog(opts, cb) {
  dialogCb = cb || null;
  if (!dialogWin) {
    dialogWin = new BrowserWindow({
      width: 440, height: 220, useContentSize: true,
      frame: false, resizable: false, skipTaskbar: true, show: false, parent: mainWindow,
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'dialog-preload.js') },
    });
    dialogWin.setMenuBarVisibility(false);
    dialogWin.loadFile(path.join(__dirname, 'dialog.html'));
    dialogWin.webContents.once('did-finish-load', flushDialog);
    dialogWin.on('closed', () => { dialogWin = null; });
    dialogQueued = opts;
    return;
  }
  flushDialog();
}

ipcMain.on('dl:choose', (_e, i) => {
  const cb = dialogCb;
  dialogCb = null;
  dialogWin?.hide();
  if (cb) cb(i);
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
    crashFile: path.join(__dirname, 'CRASH.txt'),
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

  if (!reportWin) {
    reportWin = new BrowserWindow({
      width: 760, height: 600, minWidth: 640, minHeight: 480, useContentSize: true,
      frame: false, resizable: true, show: false,
      webPreferences: { sandbox: true, preload: path.join(__dirname, 'report-preload.js') },
    });
    reportWin.setMenuBarVisibility(false);
    reportWin.loadFile(path.join(__dirname, 'report.html'));
    reportWin.webContents.once('did-finish-load', flushReport);
    reportWin.on('closed', () => { reportWin = null; });
    reportQueued = {
      phase: opts.phase,
      badge: opts.phase === 'exit' ? '进程退出' : '启动失败',
      name: rep.cls.title,
      cause: rep.cls.cause,
      suggestions: rep.cls.suggestions || [],
      logPreview,
      reportPath: rep.filePath,
      actions: opts.actions || [],
    };
    return;
  }
  reportWin.webContents.send('rp:show', {
    phase: opts.phase,
    badge: opts.phase === 'exit' ? '进程退出' : '启动失败',
    name: rep.cls.title,
    cause: rep.cls.cause,
    suggestions: rep.cls.suggestions || [],
    logPreview,
    reportPath: rep.filePath,
    actions: opts.actions || [],
  });
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
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;        // 由用户确认后再下载
autoUpdater.autoInstallOnAppQuit = false; // 用户选"稍后"即本次跳过,下次启动检查时再提示

let manualCheck = false;
let manualCheckTimedOut = false; // 手动检查超时后,忽略迟到的结果事件
let updateCheckTimer = null;
let pendingVersion = null; // 已发现/已下载的新版本号
let updateDownloaded = false;
let downloadInProgress = false; // 处于下载阶段(错误信息区分"检查失败/下载失败")
let statusOpCancelled = false;  // 用户已取消当前状态窗操作(忽略迟到结果)

function finishUpdateCheckTimer() {
  clearTimeout(updateCheckTimer);
  updateCheckTimer = null;
}

autoUpdater.on('update-available', (info) => {
  if (manualCheckTimedOut) return; // 手动检查已超时,忽略迟到结果
  finishUpdateCheckTimer();
  pendingVersion = info.version;
  showStatusResult({
    type: 'info', title: '发现新版本',
    detail: `新版本 v${info.version} 可用(当前 v${app.getVersion()})\n「现在更新」将在下载完成后自动重启安装;「稍后」则跳过本次更新。`,
    buttons: [{ id: 'dl', label: '现在更新', primary: true }, { id: 'later', label: '稍后' }],
  }, (id) => {
    if (id === 'later' || quitting) return closeStatus();
    statusOpCancelled = false;
    showStatus({ mode: 'download', title: `正在下载 v${info.version}…`, detail: `当前 v${app.getVersion()}`, pct: '0%', size: '' });
    downloadInProgress = true;
    autoUpdater.downloadUpdate().catch((e) => {
      downloadInProgress = false;
      log(`更新下载失败: ${e.message}`);
      if (!quitting) {
        showStatusResult({
          type: 'error', title: '更新下载失败',
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
  if (statusOpCancelled) { updateDownloaded = false; return; } // 用户已取消,迟到结果不再弹窗
  downloadInProgress = false;
  updateDownloaded = true;
  showStatusResult({
    type: 'success', title: '更新就绪',
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
      type: 'info', title: '检查更新',
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
    type: 'error', title: wasDownload ? '更新下载失败' : '检查更新失败',
    detail: `原因: ${e.message}${wasDownload ? '\n可稍后重试,或重新检查更新。' : '\n请确认网络可用后重试。'}`,
    buttons: [{ id: 'ok', label: '好的' }],
  }, () => closeStatus());
});

function checkForUpdates(manual) {
  manualCheck = manual;
  manualCheckTimedOut = false;
  statusOpCancelled = false;
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
  if (updateDownloaded) {
    // 已下载过:直接询问是否重启安装
    showStatusResult({
      type: 'success', title: '更新就绪',
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
        type: 'warning', title: '检查更新超时',
        detail: `${CHECK_UPDATE_TIMEOUT_MS / 1000} 秒内未能获取最新版本信息,请确认网络可用后再试。`,
        buttons: [{ id: 'ok', label: '好的' }],
      }, () => closeStatus());
    }, CHECK_UPDATE_TIMEOUT_MS);
  }
  autoUpdater.checkForUpdates().catch((e) => log(`更新检查失败: ${e.message}`));
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

// 从 npm registry 读取 dsh 最新版本号(带超时;返回版本号字符串,失败返回 null)
function fetchLatestDshVersion(timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(DSH_REGISTRY_URL, { timeout: timeoutMs }, (res) => {
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

function finishDshCheckTimer() {
  clearTimeout(dshCheckTimer);
  dshCheckTimer = null;
}

// 通过 npm 全局安装 dsh 新版本;完成后提示重启 dsh 服务(对应桌面端"立即重启安装")
function installDshUpdate(version) {
  statusOpCancelled = false;
  installCancelled = false;
  const npm = findNpmCli();
  log(`安装 dsh 本体更新: "${npm}" install -g @deepseek-ai/dsh`);
  showStatus({ mode: 'install', title: `正在安装 dsh 本体 v${version}…`, detail: 'npm install -g @deepseek-ai/dsh', spin: true });
  const child = spawn(npm, ['install', '-g', '@deepseek-ai/dsh'], { windowsHide: true });
  dshInstallChild = child;
  let buf = '';
  const onData = (c) => {
    const text = c.toString();
    if (text.trim()) log(`[npm] ${text.trim()}`);
    buf += text;
    if (buf.length > 8000) buf = buf.slice(-8000);
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length) {
      const last = lines[lines.length - 1].trim().slice(0, 130);
      updateStatus({ mode: 'install', title: `正在安装 dsh 本体 v${version}…`, detail: last || '请稍候…', spin: true });
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code) => {
    if (dshInstallChild === child) dshInstallChild = null;
    if (quitting || installCancelled) return; // 用户已取消:忽略安装结果
    if (code === 0) {
      log(`dsh 本体更新完成 v${version}`);
      showStatusResult({
        type: 'success', title: 'dsh 更新完成',
        detail: `dsh 本体已更新到 v${version},重启 dsh 服务后生效。`,
        buttons: [{ id: 'restart', label: '重启 dsh', primary: true }, { id: 'later', label: '稍后' }],
      }, (id) => {
        closeStatus();
        if (id === 'restart' && !quitting) bootDsh();
      });
    } else {
      log(`dsh 更新安装失败 (code=${code})`);
      showStatusResult({
        type: 'error', title: 'dsh 更新失败',
        detail: `npm 安装失败 (code=${code})\n${buf.slice(-300)}`,
        buttons: [{ id: 'ok', label: '好的' }],
      }, () => closeStatus());
    }
  });
  child.on('error', (e) => {
    if (dshInstallChild === child) dshInstallChild = null;
    if (quitting || installCancelled) return;
    log(`dsh 更新安装进程启动失败: ${e.message}`);
    showStatusResult({
      type: 'error', title: 'dsh 更新失败',
      detail: `无法启动 npm:${e.message}`,
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => closeStatus());
  });
}

function checkDshUpdate(manual) {
  finishDshCheckTimer();
  dshManualCheckTimedOut = false;
  statusOpCancelled = false;
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
        type: 'warning', title: '检查 dsh 更新超时',
        detail: `${CHECK_DSH_UPDATE_TIMEOUT_MS / 1000} 秒内未能获取 dsh 最新版本信息,请确认网络可用后再试。`,
        buttons: [{ id: 'ok', label: '好的' }],
      }, () => closeStatus());
    }, CHECK_DSH_UPDATE_TIMEOUT_MS);
  }
  fetchLatestDshVersion(8_000).then((latest) => {
    if (dshManualCheckTimedOut) return; // 已按超时处理,忽略迟到结果
    finishDshCheckTimer();
    if (!latest) {
      log('检查 dsh 更新失败: 未能获取最新版本信息');
      if (manual) {
        showStatusResult({
          type: 'error', title: '检查 dsh 本体更新失败',
          detail: '请确认网络可用后重试。',
          buttons: [{ id: 'ok', label: '好的' }],
        }, () => closeStatus());
      }
      return;
    }
    if (compareVersion(latest, current) > 0) {
      log(`发现 dsh 新版本 v${latest}(当前 v${current})`);
      showStatusResult({
        type: 'info', title: '发现 dsh 新版本',
        detail: `dsh 本体新版本 v${latest} 可用(当前 v${current})\n「现在更新」将通过 npm 全局安装新版本;安装完成后提示重启 dsh 服务。`,
        buttons: [{ id: 'install', label: '现在更新', primary: true }, { id: 'later', label: '稍后' }],
      }, (id) => {
        if (id === 'install' && !quitting) installDshUpdate(latest);
        else closeStatus();
      });
    } else if (manual) {
      showStatusResult({
        type: 'info', title: '检查 dsh 更新',
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
    { type: 'item', id: 'check-update', label: `检查更新…(当前 v${app.getVersion()})` },
    { type: 'item', id: 'check-dsh-update', label: `检查 dsh 本体更新…(当前 v${dshVersion()})` },
    { type: 'sep' },
    { type: 'item', id: 'auto-open-browser', label: '自动打开浏览器', checked: !!loadConfig().openBrowser },
    { type: 'item', id: 'close-to-tray', label: '关闭时最小化到托盘', checked: loadConfig().closeAction !== 'quit' },
    { type: 'sep' },
    { type: 'item', id: 'quit', label: '退出', accel: 'Alt+F4' },
  ];
}

const MENU_W = 264;
const MENU_MARGIN = 12; // 视图四周留白,容纳阴影

function showMenuPopup() {
  if (!mainWindow || !menuPopupView) return;
  const items = menuItems();
  let mh = 20; // 上下内边距
  for (const it of items) mh += it.type === 'sep' ? 9 : 30;
  menuPopupView.setBounds({
    x: 0,
    y: currentBarH,
    width: MENU_W + MENU_MARGIN * 2,
    height: mh + MENU_MARGIN * 2,
  });
  menuPopupView.webContents.send('m:show', { items, w: MENU_W, margin: MENU_MARGIN });
  menuPopupView.webContents.focus();
}

function closeMenuPopup(refocus = false) {
  menuPopupView?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  if (refocus) dshView?.webContents.focus();
}

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
  titlebarView.webContents.loadFile(path.join(__dirname, 'titlebar.html'));

  dshView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  dshView.webContents.setBackgroundThrottling(false);
  dshView.webContents.loadFile(path.join(__dirname, 'loading.html'));
  dshView.webContents.on('did-finish-load', () => {
    syncTitleBarTheme();
    dshView?.webContents.focus();
  });
  // dsh 页面里的外链(文档/仓库等)交给系统浏览器
  dshView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 标题栏收起后顶部的下拉把手
  revealTabView = new WebContentsView({
    webPreferences: { sandbox: true, preload: path.join(__dirname, 'titlebar-preload.js') },
  });
  revealTabView.setBackgroundColor('#00000000'); // 圆角处的透明角落不露白
  revealTabView.webContents.loadFile(path.join(__dirname, 'reveal-tab.html'));

  // 自绘菜单弹层(最后添加,位于最上层)
  menuPopupView = new WebContentsView({
    webPreferences: { sandbox: true, preload: path.join(__dirname, 'menu-preload.js') },
  });
  // View 默认底色是白色,会把面板周围透明边距(阴影区)衬成白圈,必须置为全透明
  menuPopupView.setBackgroundColor('#00000000');
  menuPopupView.webContents.loadFile(path.join(__dirname, 'menu.html'));
  menuPopupView.webContents.on('blur', () => closeMenuPopup()); // 点击菜单外任意处关闭

  mainWindow.contentView.addChildView(titlebarView);
  mainWindow.contentView.addChildView(dshView);
  mainWindow.contentView.addChildView(revealTabView);
  mainWindow.contentView.addChildView(menuPopupView);
  layoutViews();
  mainWindow.on('resize', layoutViews);
  mainWindow.on('maximize', () => { layoutViews(); titlebarView?.webContents.send('tb:maximized', true); });
  mainWindow.on('unmaximize', () => { layoutViews(); titlebarView?.webContents.send('tb:maximized', false); });
  // 全屏:标题栏自动收起,退出全屏自动恢复
  mainWindow.on('enter-full-screen', () => toggleTitlebar(false, false));
  mainWindow.on('leave-full-screen', () => toggleTitlebar(true, false));
  mainWindow.show();
  // 关闭按钮:按设置隐藏到托盘(dsh 后台继续跑)或真正退出(不弹系统通知)
  mainWindow.on('close', (e) => {
    if (quitting || loadConfig().closeAction === 'quit') return;
    e.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; dshView = null; titlebarView = null; revealTabView = null; menuPopupView = null; });
}

// ---------- 标题栏按钮 → 主进程 ----------
ipcMain.on('tb:min', () => mainWindow?.minimize());
ipcMain.on('tb:max', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('tb:close', () => mainWindow?.close());
ipcMain.on('tb:menu', () => showMenuPopup());
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
  });
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
    dshView.webContents.loadURL(url);
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
    defaultLocation: 'D:\\',
  });
  if (pick && pick[0]) {
    saveConfig({ ...cfg, workspace: pick[0] });
    return pick[0];
  }
  return null; // 用户取消,直接退出
}
function changeWorkspace() {
  const cfg = loadConfig();
  const pick = dialog.showOpenDialogSync(mainWindow, {
    title: '切换工作目录(将重启 dsh 服务)',
    properties: ['openDirectory'],
    defaultLocation: cfg.workspace || 'D:\\',
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
      // ① 状态窗:检查 → ✕ 取消(应关窗且清计时器)→ 再开下载 → 结果
      uiStep(() => { showStatus({ mode: 'check', title: '正在检查更新…', detail: '当前 v0.0.0', spin: true }); hookWin(statusWin, 'status'); }, 4000, 'status-show');
      uiStep(() => { statusWin?.webContents.executeJavaScript('document.getElementById("xBtn").click()').catch(() => {}); }, 4300, 'status-cancel-click');
      uiStep(() => {
        const ok = !statusWin && !updateCheckTimer && !dshCheckTimer;
        log(`UITEST cancel-chk win=${!!statusWin} timer=${!!updateCheckTimer} dshTimer=${!!dshCheckTimer} → ${ok ? 'PASS' : 'FAIL'}`);
      }, 4500, 'status-cancel-verify');
      uiStep(() => { showStatus({ mode: 'download', title: '正在下载 v9.9.9…', detail: '当前 v0.0.0', pct: '0%', size: '' }); hookWin(statusWin, 'status2'); }, 5200, 'status-download');
      uiStep(() => updateStatus({ mode: 'download', progress: 42, pct: '42.0%', size: '38 / 89 MB · 4.2 MB/s' }), 6400, 'status-progress');
      uiStep(() => showStatusResult({ type: 'success', title: '更新就绪', detail: 'v9.9.9 已下载完成,现在重启并安装?', buttons: [{ id: 'install', label: '立即重启安装', primary: true }, { id: 'later', label: '稍后' }] }, () => log('UITEST status-action ✓')), 7600, 'status-result');
      // ② 标题栏动画:收起 → 240ms 后应收敛到 0,再展开 → 240ms 后应回到 TITLEBAR_H
      uiStep(() => toggleTitlebar(false), 8200, 'bar-collapse');
      uiStep(() => log(`UITEST bar-after-collapse currentBarH=${currentBarH}(期望 0)`), 8600, 'bar-collapse-verify');
      uiStep(() => toggleTitlebar(true), 8800, 'bar-expand');
      uiStep(() => log(`UITEST bar-after-expand currentBarH=${currentBarH}(期望 ${TITLEBAR_H})`), 9200, 'bar-expand-verify');
      uiStep(() => { showDialog({ type: 'warning', title: '检查 dsh 更新', message: '未检测到 dsh 本体,请先全局安装:', detail: 'npm install -g @deepseek-ai/dsh', buttons: [{ label: '好的', primary: true }] }); hookWin(dialogWin, 'dialog'); }, 9600, 'dialog-show');
      uiStep(() => { showReport({ phase: 'boot', error: new Error('等待 dsh web 输出服务地址超时(90s)'), code: null, buf: '[i] dsh web: 正在启动…', actions: [{ id: 'retry', label: '重试', style: 'primary' }, { id: 'quit', label: '退出', style: 'danger' }] }); hookWin(reportWin, 'report'); }, 10800, 'report-show');
      setTimeout(() => { log('UITEST: 完成,自动退出'); app.quit(); }, 13000);
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (e) => {
    // 无条件先置退出标志:否则在 dsh 启动失败(dshChild 为空)时,
    // 窗口 close 会被"最小化到托盘"拦截,app.quit() 将永远无法完成
    quitting = true;
    flushLog();
    stopHandlePolling();
    if (cleaned || !dshChild) { cleaned = true; return; }
    e.preventDefault();
    const child = dshChild;
    dshChild = null;
    log('退出:终止 dsh web 进程树');
    killTree(child).finally(() => {
      flushLog();
      cleaned = true;
      app.quit();
    });
  });
}