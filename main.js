// DSH Desktop —— DeepSeek Harness (dsh) 的桌面壳。
// 托盘常驻(关闭默认收进后台)、自绘菜单、深色主题;会话/文件/设置与本体完全共享。
// 原理:以用户选的工作目录为 cwd,后台启动本体 `dsh web`,从 stdout 解析实际地址,
// 窗口加载该地址。不动 $DSH_HOME,因此会话/设置/插件/文件与本体 dsh 完全共享。
process.on('uncaughtException', (err) => {
  try { require('fs').writeFileSync(require('path').join(__dirname, 'CRASH.txt'), `${new Date().toISOString()}\n${err.stack || err}`); } catch (e) { /* 无法落盘 */ }
});
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeTheme, screen, shell, WebContentsView } = require('electron');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
// Windows 规范:固定 AppUserModelID,保证任务栏图标/分组/通知归属正确
if (IS_WIN) app.setAppUserModelId('com.zinkning.dsh-desktop');
// 菜单弹层、右键菜单等原生 UI 跟随应用深色风格
nativeTheme.themeSource = 'dark';
const DSH_PKG_SUB = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js');
const BOOT_URL_TIMEOUT_MS = 30_000; // 等待 dsh 打印服务地址
const SERVER_READY_TIMEOUT_MS = 60_000; // 等待 HTTP 就绪(首次启动要装依赖,放宽)

let mainWindow = null;
let dshChild = null;
let bootSeq = 0; // 递增序号:重启后,旧一次 boot 的回调不再生效
let quitting = false;
let cleaned = false;

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
  try { require('fs').appendFileSync(require('path').join(__dirname, 'CRASH.txt'), `${new Date().toISOString()}\n${err.stack || err}\n`); } catch (e) { /* 无法落盘 */ }
  log(`未捕获异常: ${err.stack || err}`);
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

function startDsh(cwd) {
  const bin = findDshBin();
  const node = findNode();
  const args = [bin, 'web', '--host', '127.0.0.1', '--port', '0'];
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
      if (text.trim()) log(`[dsh] ${text.trim()}`);
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
        revealTabView.setBounds({ x: Math.floor(w / 2 - 26), y: 0, width: 52, height: 15 });
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
  clearInterval(barAnim);
  if (!animated) {
    currentBarH = visible ? TITLEBAR_H : 0;
    layoutViews();
    if (!visible) startHandlePolling();
    return;
  }
  const from = currentBarH;
  const to = visible ? TITLEBAR_H : 0;
  const startedAt = Date.now();
  barAnim = setInterval(() => {
    const t = Math.min(1, (Date.now() - startedAt) / 160);
    currentBarH = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))); // easeOutCubic
    layoutViews();
    if (t >= 1) {
      clearInterval(barAnim);
      if (!visible) startHandlePolling();
    }
  }, 16);
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

// ---------- 自绘菜单弹层(替代原生 Menu.popup,风格与应用统一) ----------
function menuItems() {
  return [
    { type: 'item', id: 'open-workspace', label: '打开工作目录…', accel: 'Ctrl+O' },
    { type: 'item', id: 'restart-dsh', label: '重启 dsh 服务', accel: 'Ctrl+Shift+R' },
    { type: 'sep' },
    { type: 'item', id: 'fullscreen', label: '全屏', accel: 'F11' },
    { type: 'item', id: 'toggle-bar', label: barVisible ? '隐藏标题栏' : '显示标题栏', accel: 'Ctrl+Shift+B' },
    { type: 'item', id: 'reload', label: '重新加载页面', accel: 'F5' },
    { type: 'item', id: 'devtools', label: '开发者工具', accel: 'F12' },
    { type: 'sep' },
    { type: 'item', id: 'dsh-home', label: '打开 dsh 数据目录' },
    { type: 'item', id: 'log', label: '打开日志文件' },
    { type: 'sep' },
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
    case 'fullscreen': toggleFullscreen(); break;
    case 'toggle-bar': toggleTitlebar(!barVisible); break;
    case 'reload': dshView?.webContents.reload(); break;
    case 'devtools': dshView?.webContents.toggleDevTools(); break;
    case 'dsh-home': shell.openPath(path.join(os.homedir(), '.dsh')); break;
    case 'log': shell.showItemInFolder(logFile); break;
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

  dshView = new WebContentsView({ webPreferences: { sandbox: true } });
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
  dshView.webContents.loadFile(path.join(__dirname, 'loading.html'));

  const cwd = loadConfig().workspace;
  titlebarView?.webContents.send('tb:workspace', cwd);
  try {
    const { child, url } = await startDsh(cwd);
    dshChild = child;
    child.once('exit', (code) => {
      if (quitting || seq !== bootSeq) return;
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'error',
        title: 'dsh 已退出',
        message: `dsh web 进程意外退出 (code=${code})。`,
        detail: `日志:\n${logFile}`,
        buttons: ['重启 dsh', '退出'],
        noLink: true,
      });
      if (choice === 0 && !quitting) bootDsh();
      else app.quit();
    });
    log(`服务地址: ${url},等待 HTTP 就绪…`);
    const ready = await waitServerReady(url, () => seq !== bootSeq);
    if (!ready || quitting || seq !== bootSeq || !dshView) return;
    log(`加载 ${url}`);
    dshView.webContents.loadURL(url);
  } catch (err) {
    if (quitting || seq !== bootSeq) return;
    log(`启动失败: ${err.message}`);
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'error',
      title: 'dsh 启动失败',
      message: String(err.message || err),
      buttons: ['重试', '退出'],
      noLink: true,
    });
    if (choice === 0 && !quitting) bootDsh();
    else app.quit();
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
