// updates.js —— 双通道更新编排:
//   桌面端:GitHub Releases 检查(electron-updater)→ 通知/弹窗 → 多线程加速下载
//          (先写官方 updater 缓存,再走官方 downloadUpdate 命中缓存)→ 重启安装;
//   dsh 本体:npm registry 检查 → node + npm-cli.js 全局安装(期间暂停/恢复 dsh 服务)。
// 两通道的共享状态集中在 state(导出;main.js 的 before-quit 清理 / 状态窗忙判定 /
// 报告流程读取它);UI 能力(状态窗/对话框/通知/重启 dsh)经 init() 注入,
// 本模块不反向依赖 main.js。
'use strict';

const { app, Notification } = require('electron');
const { autoUpdater, CancellationToken } = require('electron-updater');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { log, loadConfig, firstLine, ACCEL_SEGMENTS_MIN, ACCEL_SEGMENTS_MAX } = require('./core');
const { killTree, dshVersion, findNode } = require('./dsh-process');
const { multiThreadDownload, resolveDownloadUrl, hashFile, DEFAULT_SEGMENTS } = require('./downloader');

autoUpdater.autoDownload = false;        // 由用户确认后再下载
autoUpdater.autoInstallOnAppQuit = false; // 用户选"稍后"即本次跳过,下次启动检查时再提示

const IS_WIN = process.platform === 'win32';
// 便携版由 electron-builder 注入 PORTABLE_EXECUTABLE_DIR:自更新会走 NsisUpdater 把用户"转正"成
// 安装版(下载 Setup.exe 并安装),与便携预期不符,故禁用桌面端自动更新,引导手动下载
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;

const CHECK_UPDATE_TIMEOUT_MS = 15_000; // 手动检查更新的超时时间(CN 网络直连 GitHub 常需 8s+,原 8s 过紧会误报)
const CHECK_DSH_UPDATE_TIMEOUT_MS = 12_000; // 手动检查 dsh 本体更新的超时时间
const LATE_RESULT_GRACE_MS = 25_000; // 超时提示后,迟到结果的宽限期:期间结果仍投递一次(避免「超时」误报而实际网络通了)
const UPDATE_CHECK_MAX_MS = 60_000; // 检查请求在途超过该时长 → 看门狗日志(自动检查无超时,只告警不弹窗)
const DSH_REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'; // 兜底:dsh 本体最新版本查询地址
const DSH_INSTALL_IDLE_TIMEOUT_MS = 60_000; // npm 安装连续无输出多久后提示"可能卡住"(dsh 运行中文件被占用/网络慢)
const DSH_INSTALL_TOTAL_TIMEOUT_MS = 15 * 60_000; // npm 安装总超时:强制终止并报错,避免无限"请稍后"
const DSH_COMPATIBLE_MINOR = 1; // 桌面壳验证过的 dsh 兼容区间:0.1.x(README 记录验证至 0.1.0-rc.8 / 0.1.1-rc.2 / 0.1.2-alpha.2);0.2+ 视为未验证,不自动推送

// ---------- 双通道共享状态(main.js 的 before-quit 清理 / 状态窗忙判定 / 报告流程读取) ----------
const state = {
  manualCheck: false,
  manualCheckTimedOutAt: 0, // 手动检查超时时刻(0=未超时);迟到结果在宽限期(LATE_RESULT_GRACE_MS)内仍投递
  manualCheckDropped: false, // 用户已取消手动检查:丢弃一切迟到结果
  updateCheckTimer: null,
  updateCheckInFlight: false, // 是否有检查请求在途(网络挂起时用于看门狗告警)
  pendingVersion: null, // 桌面端已发现/已下载的新版本号(仅供桌面端流程;dsh 本体更新不写此变量)
  updateDownloaded: false,
  downloadInProgress: false, // 处于下载阶段(错误信息区分"检查失败/下载失败")
  desktopDownloadCanceled: false, // 用户已取消桌面端下载:迟到结果不得再弹窗
  downloadToken: null, // 当前桌面端下载的取消令牌(✕ 取消时中止网络传输)
  statusOpCancelled: false,  // 用户已取消当前状态窗操作(忽略迟到结果)
  lastOfficialProgressAt: 0, // 官方下载进度节流计时(每轮下载独立计)
  dshCheckTimer: null,
  dshManualCheckTimedOutAt: 0, // 手动检查超时时刻(0=未超时);迟到结果在宽限期内仍投递
  dshManualCheckDropped: false, // 用户已取消:丢弃一切迟到结果
  dshInstallChild: null, // 正在运行的 npm 安装进程(供 ✕ 取消 / before-quit 清理)
  installCancelled: false, // 用户已取消安装(忽略安装结果)
  installEpoch: 0, // 安装代数:每次安装递增,旧安装的迟到回调(close/error/超时)一律失效
  dshStoppedForInstall: false, // 安装期间已暂停 dsh 服务(退出路径务必恢复,成败都恢复)
};

// init() 注入的 UI/编排能力(main.js 提供);事件处理器在 init 前不会触发
// (检查只能由菜单/定时器发起,均晚于 whenReady 中的 init),仍留空值守卫兜底
let deps = null;
function init(d) {
  deps = d;
  autoUpdater.on('update-available', onUpdateAvailable);
  autoUpdater.on('download-progress', onDownloadProgress);
  autoUpdater.on('update-downloaded', onUpdateDownloaded);
  autoUpdater.on('update-not-available', onUpdateNotAvailable);
  autoUpdater.on('error', onUpdaterError);
}

// 超时提示后,迟到结果在宽限期内仍投递一次(网络慢但通了,不应误报「超时」);
// 用户主动取消(dropped)则一律丢弃
function lateResultAllowed(at, dropped) {
  return !dropped && (!at || Date.now() - at <= LATE_RESULT_GRACE_MS);
}

function finishUpdateCheckTimer() {
  clearTimeout(state.updateCheckTimer);
  state.updateCheckTimer = null;
}
function finishDshCheckTimer() {
  clearTimeout(state.dshCheckTimer);
  state.dshCheckTimer = null;
}

// 是否已展示过「下载失败」结果窗:下载失败会同时走 autoUpdater 的 error 事件与
// downloadUpdate 的 promise reject,两边都弹会双重显示,互相见结果为真则跳过
function downloadErrorShown() {
  const p = deps && deps.getStatusPayload();
  return !!(p && p.mode === 'result' && p.__origin === 'desktop' && p.title && String(p.title).includes('下载失败'));
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

// 「立即重启安装」守卫:dsh 本体 npm 安装进行中时,重启会经 before-quit 强杀 npm 进程,
// 全局包可能写一半损坏;必须警告用户先等安装完成
function quitAndInstallGuarded() {
  if (state.dshInstallChild || state.dshStoppedForInstall) {
    log('阻止立即重启安装:dsh 本体 npm 安装进行中');
    deps.showDialog({
      type: 'warning', title: '暂不能重启安装',
      message: 'dsh 本体的 npm 安装尚未结束,立即重启会中断安装,可能导致 dsh 本体损坏。',
      detail: '请等待 dsh 安装完成(安装流程会自动重启 dsh 服务)后,再点击「立即重启安装」。',
      buttons: [{ label: '好的', primary: true }],
    });
    return;
  }
  autoUpdater.quitAndInstall(true, true);
}

// 返回 true=加速下载完成且已写入官方缓存;false=本次回退官方下载(镜像失败/不支持分段等)
// token:本轮下载的取消令牌——必须用入参固定:取消时 cancelStatusOp 会把 state.downloadToken 置空,
// 若闭包读全局状态将永远拿不到 isCancelled,✕ 取消将中止不了传输
async function acceleratedDownload(info, token) {
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
  const updateInfoPath = path.join(pendingDir, 'update-info.json');
  // 复用上次已下载完成的安装包:electron-updater 的缓存命中 = update-info.json 的
  // {fileName, sha512} 与实际文件哈希一致。「稍后」跳过安装后重启再点更新,不应白下整包
  try {
    const cached = JSON.parse(fs.readFileSync(updateInfoPath, 'utf8'));
    if (cached.fileName === fileName && cached.sha512 === fileInfo.sha512 && fs.existsSync(finalFile)) {
      const h = await hashFile(finalFile);
      if (h === fileInfo.sha512) {
        log(`加速下载:命中上次缓存 ${finalFile},跳过下载`);
        return true;
      }
      log('加速下载:缓存文件哈希不匹配,重新下载');
    }
  } catch { /* 无缓存或信息损坏,走正常下载 */ }
  const speedFrom = Date.now();
  try {
    await fs.promises.mkdir(pendingDir, { recursive: true });
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    await multiThreadDownload(url, tempFile, {
      segments,
      sha512: fileInfo.sha512,
      onProgress: (p) => {
        const cur = deps.getStatusPayload();
        if (!cur || cur.mode !== 'download') return;
        const dt = Math.max(1, Date.now() - speedFrom);
        const speed = (p.transferred / dt) * 1000;
        deps.updateStatus({
          mode: 'download', progress: p.percent,
          pct: p.percent.toFixed(1) + '%',
          size: `${Math.round(p.transferred / 1048576)} / ${Math.round(p.total / 1048576)} MB · ${(speed / 1048576).toFixed(1)} MB/s`,
        });
      },
      isCancelled: () => !!(token && token.isCancelled) || deps.isQuitting(),
    });
    if (deps.isQuitting() || (token && token.isCancelled)) throw new Error('已取消'); // 下载完成后、落盘前补一次取消检查
    // 与 electron-updater 缓存约定保持一致:文件名 = 官方 URL 的 basename,sha512 = latest.yml 的 sha512
    await fs.promises.rename(tempFile, finalFile);
    await fs.promises.writeFile(updateInfoPath, JSON.stringify({ fileName, sha512: fileInfo.sha512 }));
    log(`加速下载完成: ${url} → ${finalFile}`);
    return true;
  } catch (e) {
    // 只清理本次下载的临时文件:既有有效缓存(上次「稍后」留存)保留——
    // 官方 downloadUpdate 会按 update-info.json 命中它并跳过整包重下
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    log(`加速下载失败(将回退官方下载): ${e.message}`);
    return false;
  }
}

// 统一下载入口:先加速,再走官方 downloadUpdate()。
// 加速成功 → 命中缓存立即 update-downloaded;加速失败 → 官方单连接下载进度照常。
async function runUpdateDownload(info) {
  const token = state.downloadToken; // 固定本轮令牌(取消会在 cancelStatusOp 里把状态置空)
  await acceleratedDownload(info, token);
  if (deps.isQuitting() || state.desktopDownloadCanceled) return;
  await autoUpdater.downloadUpdate(token);
}

function onUpdateAvailable(info) {
  if (!deps) return;
  if (!lateResultAllowed(state.manualCheckTimedOutAt, state.manualCheckDropped)) return; // 已取消/超时过宽限期:丢弃迟到结果
  finishUpdateCheckTimer();
  state.pendingVersion = info.version;
  // 手动=直接弹窗;自动=只发桌面通知,点击通知再弹窗(不抢占当前操作;与 dsh 本体通道语义一致)
  const showResult = (nonIntrusive) => deps.showStatusResult({
    type: 'info', title: '发现新版本', __origin: 'desktop',
    detail: `新版本 v${info.version} 可用(当前 v${app.getVersion()})\n「现在更新」将用多线程加速下载,完成后自动重启安装;「稍后」则跳过本次更新。`,
    buttons: [{ id: 'dl', label: '现在更新', primary: true }, { id: 'later', label: '稍后' }],
  }, (id) => {
    if (id === 'later' || deps.isQuitting()) return deps.closeStatus();
    state.statusOpCancelled = false;
    state.desktopDownloadCanceled = false; // 新一轮下载:清掉上次的取消标记
    state.lastOfficialProgressAt = 0;      // 重置官方进度节流计时(每轮下载独立计)
    state.downloadToken = new CancellationToken(); // ✕ 取消时可真正中止下载传输
    deps.showStatus({ mode: 'download', title: `正在下载 v${info.version}…`, detail: `当前 v${app.getVersion()}`, pct: '0%', size: '', __origin: 'desktop' });
    state.downloadInProgress = true;
    runUpdateDownload(info).catch((e) => {
      state.downloadToken = null;
      state.downloadInProgress = false;
      if (state.desktopDownloadCanceled) { state.desktopDownloadCanceled = false; return; } // 用户取消:静默收尾
      log(`更新下载失败: ${e.message}`);
      if (!deps.isQuitting() && !downloadErrorShown()) { // error 事件可能已先弹过同一失败
        deps.showStatusResult({
          type: 'error', title: '更新下载失败', __origin: 'desktop',
          detail: `原因: ${e.message}\n可稍后重试,或重新检查更新。`,
          buttons: [{ id: 'ok', label: '好的' }],
        }, () => deps.closeStatus());
      }
    });
  }, nonIntrusive);
  if (state.manualCheck) return showResult(false);
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '发现 DSH 新版本',
        body: `v${info.version} 可用(当前 v${app.getVersion()}),点击查看。`,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
      });
      n.on('click', () => showResult(true));
      deps.trackNotification(n); // 保持引用:GC 会导致点击回调失效
      n.show();
      log('自动检查发现新版本:已发桌面通知(未弹出窗口)');
      return;
    }
  } catch (e) { log(`更新桌面通知失败: ${e.message}`); }
  showResult(true);
}

// 官方下载进度:按 150ms 节流(与自研多线程下载器一致,避免每 chunk 一次 IPC 刷屏)
function onDownloadProgress(p) {
  if (!deps) return;
  const cur = deps.getStatusPayload();
  if (!cur || cur.mode !== 'download') return;
  const now = Date.now();
  if (now - state.lastOfficialProgressAt < 150) return;
  state.lastOfficialProgressAt = now;
  const speed = p.bytesPerSecond ? `${(p.bytesPerSecond / 1048576).toFixed(1)} MB/s` : '';
  deps.updateStatus({
    mode: 'download',
    progress: p.percent,
    pct: p.percent.toFixed(1) + '%',
    size: `${Math.round(p.transferred / 1048576)} / ${Math.round(p.total / 1048576)} MB${speed ? ' · ' + speed : ''}`,
  });
}

function onUpdateDownloaded() {
  if (!deps) return;
  state.downloadToken = null; // 下载已结束
  if (state.statusOpCancelled || state.desktopDownloadCanceled) { state.updateDownloaded = false; return; } // 用户取消,迟到结果不再弹窗
  state.desktopDownloadCanceled = false;
  state.downloadInProgress = false;
  state.updateDownloaded = true;
  deps.showStatusResult({
    type: 'success', title: '更新就绪', __origin: 'desktop',
    detail: `v${state.pendingVersion} 已下载完成,现在重启并安装?`,
    buttons: [{ id: 'install', label: '立即重启安装', primary: true }, { id: 'later', label: '稍后' }],
  }, (id) => {
    if (id === 'install') quitAndInstallGuarded();
    else deps.closeStatus();
  });
}

function onUpdateNotAvailable() {
  if (!deps) return;
  if (!lateResultAllowed(state.manualCheckTimedOutAt, state.manualCheckDropped)) return;
  finishUpdateCheckTimer();
  if (state.manualCheck) {
    deps.showStatusResult({
      type: 'info', title: '检查更新', __origin: 'desktop',
      detail: `当前已是最新版本(v${app.getVersion()})。`,
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => deps.closeStatus());
  }
}

function onUpdaterError(e) {
  if (!deps) return;
  if (!lateResultAllowed(state.manualCheckTimedOutAt, state.manualCheckDropped)) return; // 已取消/超时过宽限期:不再弹错
  finishUpdateCheckTimer();
  const wasDownload = state.downloadInProgress;
  state.downloadInProgress = false;
  log(`更新检查失败: ${e.message}`);
  if (!state.manualCheck && !wasDownload) return; // 自动检查出错静默
  if (wasDownload && downloadErrorShown()) return; // catch 路径已弹过同一失败,不重复
  deps.showStatusResult({
    type: 'error', title: wasDownload ? '更新下载失败' : '检查更新失败', __origin: 'desktop',
    detail: `原因: ${e.message}${wasDownload ? '\n可稍后重试,或重新检查更新。' : '\n请确认网络可用后重试。'}`,
    buttons: [{ id: 'ok', label: '好的' }],
  }, () => deps.closeStatus());
}

function checkForUpdates(manual) {
  state.manualCheck = manual;
  state.manualCheckTimedOutAt = 0;
  state.manualCheckDropped = false;
  state.statusOpCancelled = false;
  if (manual && (state.dshInstallChild || state.dshStoppedForInstall)) {
    // dsh 本体安装进行中:回到安装进度窗口而不是覆盖它(两个更新流互相顶掉会丢进度/按钮错位)
    log('手动检查更新被忽略:dsh 本体安装仍在进行中');
    deps.noticeFlowBusy('dsh 本体的 npm 安装正在进行,暂时无法检查更新;请等安装完成后再试。', { mode: 'install', title: '正在安装 dsh 本体…', spin: true, __origin: 'dsh' });
    return;
  }
  if (manual && state.downloadInProgress) {
    // 已有下载在进行:回到下载进度窗口而不是覆盖它(否则进度 UI 丢失、下载仍在后台)
    log('手动检查更新被忽略:下载仍在进行中');
    deps.noticeFlowBusy('桌面端更新正在下载,暂时无法开始新的检查;可在当前进度窗查看进度。', { mode: 'download', title: '正在下载更新…', spin: true, __origin: 'desktop' });
    return;
  }
  if (!app.isPackaged) {
    if (manual) {
      deps.showDialog({
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
      deps.showDialog({
        type: 'info', title: '检查更新',
        message: '便携版不支持自动更新,请前往 GitHub Releases 下载新版本。',
        buttons: [{ label: '好的', primary: true }],
      });
    }
    return;
  }
  if (state.updateDownloaded) {
    // 已下载过:直接询问是否重启安装
    deps.showStatusResult({
      type: 'success', title: '更新就绪', __origin: 'desktop',
      detail: `v${state.pendingVersion} 已下载完成,现在重启并安装?`,
      buttons: [{ id: 'install', label: '立即重启安装', primary: true }, { id: 'later', label: '取消' }],
    }, (id) => {
      if (id === 'install') quitAndInstallGuarded();
      else deps.closeStatus();
    });
    return;
  }
  // 手动检查:显示"检查中"状态窗,设超时;超时提示后,迟到结果在宽限期内仍会送达
  if (manual) {
    finishUpdateCheckTimer();
    deps.showStatus({ mode: 'check', title: '正在检查更新…', detail: `当前 v${app.getVersion()}`, spin: true, __origin: 'desktop' });
    state.updateCheckTimer = setTimeout(() => {
      state.updateCheckTimer = null;
      state.manualCheckTimedOutAt = Date.now();
      log('检查更新超时(宽限期内迟到结果仍会送达)');
      deps.showStatusResult({
        type: 'warning', title: '检查更新超时', __origin: 'desktop',
        detail: `${CHECK_UPDATE_TIMEOUT_MS / 1000} 秒内未能获取最新版本信息。\n网络较慢时结果稍后仍会送达;请确认网络可用后重试。`,
        buttons: [{ id: 'ok', label: '好的' }],
      }, () => deps.closeStatus());
    }, CHECK_UPDATE_TIMEOUT_MS);
  }
  // 看门狗:自动检查没有超时弹窗,网络挂起时要留痕(electron-updater 在途请求会被后续检查复用)
  state.updateCheckInFlight = true;
  setTimeout(() => {
    if (state.updateCheckInFlight) log(`更新检查超过 ${UPDATE_CHECK_MAX_MS / 1000} 秒未返回,请检查网络/代理与 GitHub 连通性`);
  }, UPDATE_CHECK_MAX_MS);
  autoUpdater.checkForUpdates()
    .then(() => { state.updateCheckInFlight = false; })
    .catch((e) => { state.updateCheckInFlight = false; log(`更新检查失败: ${e.message}`); });
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

let cachedDshRegistry = null;
// 跟随用户 npm registry 配置(镜像站用户直连 npmjs 往往不可达,与安装所用 registry 保持一致),
// 把 registry 根路径指向 @deepseek-ai/dsh/latest;解析失败退回官方地址。
// 注意:内部 execSync 同步执行但限时 5s(npm 正常时 <300ms,挂起时最多阻塞主线程 5s 后回退官方),
// 结果缓存,仅首次检查 dsh 更新时执行;非 https 的 registry 不作为检查源(https.get 对 http 地址
// 直接报错导致静默失败),回退官方
async function dshRegistryUrl() {
  if (cachedDshRegistry) return cachedDshRegistry;
  const fallback = () => { cachedDshRegistry = DSH_REGISTRY_URL; return cachedDshRegistry; };
  try {
    const reg = firstLine('npm config get registry');
    const u = new URL(reg || 'https://registry.npmjs.org/');
    if (u.protocol !== 'https:') {
      log(`npm registry 非 https(${u.protocol}//…),改用官方 registry 检查 dsh 更新`);
      return fallback();
    }
    // 保留 registry 自身的子路径(自建源常挂在 /artifactory/api/npm/npm/ 等子目录):
    // 用 origin+pathname 手工拼接,而非整体替换 u.pathname(后者会丢掉子路径导致 404
    // 静默回退官方,镜像站用户得不到镜像加速)。registry 根以 / 结尾,直接追加包路径。
    let base = u.origin + u.pathname;
    if (!base.endsWith('/')) base += '/';
    cachedDshRegistry = base + '@deepseek-ai/dsh/latest';
  } catch { return fallback(); }
  return cachedDshRegistry || fallback();
}

// 从 npm registry 读取 dsh 最新版本号(带超时;返回版本号字符串,失败返回 null)
async function fetchLatestDshVersion(timeoutMs) {
  const url = await dshRegistryUrl();
  if (!url) return null;
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
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

// 通过 npm 全局安装 dsh 新版本;安装期间暂停当前 dsh 服务,结束(成败/取消/超时)后自动恢复。
// 更新对象就是当前正在运行的包:Windows 上一面运行一面替换目录最容易 EPERM,先停服务再装。
async function installDshUpdate(version) {
  const myEpoch = ++state.installEpoch;
  state.statusOpCancelled = false;
  state.installCancelled = false;
  if (deps.isQuitting()) return;
  // 版本号白名单:纯 semver 形态,从数据结构上杜绝 shell 元字符
  // (当前 install 走 node + npm-cli.js 数组参数无 shell;这是纵深防御,未来变更数据源也不可变注入)
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    log(`dsh 安装中止:版本号格式异常(${version})`);
    deps.showStatusResult({
      type: 'error', title: 'dsh 更新失败', __origin: 'dsh',
      detail: `npm 返回的版本号格式异常(${version}),已中止自动安装。\n请在终端手动确认后再试。`,
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => deps.closeStatus());
    return;
  }
  // 停掉当前 dsh web 进程(本体文件正被它使用)
  if (deps.getDshChild()) {
    deps.bumpBootSeq(); // 旧 dsh 的 exit 处理器因序号过期而忽略这次主动停止
    const old = deps.getDshChild();
    deps.setDshChild(null);
    state.dshStoppedForInstall = true;
    log('安装 dsh 本体更新:先停止当前 dsh 服务');
    try { await killTree(old); } catch (e) { log(`停止 dsh 服务失败: ${e.message}`); }
  }
  // 等待停止期间可能已被 ✕ 取消 / 退出 / 更新的安装取代
  if (deps.isQuitting() || state.installCancelled || myEpoch !== state.installEpoch) { state.dshStoppedForInstall = false; return; }
  // Windows 上 spawn .cmd/.bat 必须走 shell,否则同步抛 EINVAL → 一律走 node + npm-cli.js(数组参数,无注入面)。
  // 不做 shell 回退:拼接 cmd.exe 命令行会形成命令注入面(元字符不转义),找不到环境就报错引导人工处理。
  // 注意 node 可能已回退为 Electron 二进制,必须带上其 env(含 ELECTRON_RUN_AS_NODE),否则以 GUI 模式跑 npm
  const nodeInfo = findNode();
  const node = nodeInfo ? nodeInfo.exe : null;
  const npmCliJs = process.env.DSH_UITEST_FAKE_NPM || findNpmCliJs(); // UITEST 时注入假 npm 脚本
  if (!node || !npmCliJs) {
    log('dsh 安装中止:无法定位 node 或 npm-cli.js,拒绝 shell 回退安装');
    state.dshStoppedForInstall = false;
    if (!deps.isQuitting()) deps.bootDsh();
    deps.showStatusResult({
      type: 'error', title: 'dsh 更新失败', __origin: 'dsh',
      detail: '未能定位 node 或 npm 的 npm-cli.js,已中止自动安装(不使用 shell 拼接以防命令注入)。\n请在终端手动执行:npm install -g @deepseek-ai/dsh\ndsh 服务已恢复(旧版本)。',
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => deps.closeStatus());
    return;
  }
  const exec = node;
  const args = [npmCliJs, 'install', '-g', `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund']; // 锁版本+跳过 audit/fund 减负
  const opts = { windowsHide: true, env: nodeInfo.env };
  log(`安装 dsh 本体更新: ${exec} ${args.join(' ')}`);
  deps.showStatus({ mode: 'install', title: `正在安装 dsh 本体 v${version}…`, detail: `npm install -g @deepseek-ai/dsh@${version}`, spin: true, __origin: 'dsh' });
  let child = null;
  try {
    child = spawn(exec, args, opts);
  } catch (e) {
    // 启动失败必须反馈到窗口,不能静默卡在"请稍后";服务已停,先拉回来
    log(`无法启动 npm 安装进程: ${e.message}`);
    state.dshStoppedForInstall = false;
    if (!deps.isQuitting()) deps.bootDsh();
    deps.showStatusResult({
      type: 'error', title: 'dsh 更新失败', __origin: 'dsh',
      detail: `无法启动 npm:${e.message}\ndsh 服务已恢复(旧版本)。`,
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => deps.closeStatus());
    return;
  }
  state.dshInstallChild = child;
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
    clearTimers(); // 无条件先清定时器:被取代安装(myEpoch 过期)的 idle/total 定时器不得残留去改写状态窗
    if (myEpoch !== state.installEpoch) return; // 已有更新的安装启动,旧结果丢弃
    if (state.dshInstallChild === child) state.dshInstallChild = null;
    const stoppedForInstall = state.dshStoppedForInstall;
    state.dshStoppedForInstall = false;
    if (deps.isQuitting() || state.installCancelled) return; // 取消/超时中止:忽略迟到结果
    // 无论成败都恢复 dsh 服务(成功跑新版本,失败跑旧版本),不再依赖用户手动点"重启 dsh"
    if (stoppedForInstall) deps.bootDsh();
    const actual = ok ? dshVersion(true) : null; // 强制刷新版本缓存,展示刚装上的版本
    log(ok ? `dsh 本体更新完成(实际 v${actual || version})` : `dsh 更新安装失败: ${msg}`);
    deps.showStatusResult({
      type: ok ? 'success' : 'error',
      title: ok ? 'dsh 更新完成' : 'dsh 更新失败', __origin: 'dsh',
      detail: ok
        ? `dsh 本体已更新(当前版本 v${actual || version}),dsh 服务已自动重启生效。`
        : `${msg}\n${buf.slice(-300)}\ndsh 服务已恢复(旧版本)。`,
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => deps.closeStatus());
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
      deps.updateStatus({ mode: 'install', title: `正在安装 dsh 本体 v${version}…`, detail: segs[segs.length - 1].slice(0, 130), spin: true });
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  // 无输出护栏:长时间没有新输出 → 提示可能的卡因(网络慢/安装挂起),但不自动中止
  idleTimer = setInterval(() => {
    if (Date.now() - lastOutAt > idleMs) {
      deps.updateStatus({
        mode: 'install', title: `正在安装 dsh 本体 v${version}…`,
        detail: 'npm 长时间无输出,可能因网络慢或安装卡住;可点 ✕ 取消(将恢复 dsh 服务)重试',
        spin: true,
      });
    }
  }, 5000);
  // 总超时护栏:强制终止并报错,绝不无限"请稍后"
  totalTimer = setTimeout(() => {
    if (myEpoch !== state.installEpoch || deps.isQuitting() || state.installCancelled || state.dshInstallChild !== child) return;
    log('dsh 安装超时,强制终止 npm 进程');
    state.installCancelled = true; // 让 close 回调忽略后续结果,避免重复弹窗
    if (state.dshStoppedForInstall) { state.dshStoppedForInstall = false; if (!deps.isQuitting()) deps.bootDsh(); }
    killTree(child);
    deps.showStatusResult({
      type: 'error', title: 'dsh 更新失败', __origin: 'dsh',
      detail: `npm 安装超时(${Math.round(totalMs / 60000)} 分钟)已中止,dsh 服务已恢复(旧版本)。`,
      buttons: [{ id: 'ok', label: '好的' }],
    }, () => deps.closeStatus());
  }, totalMs);
  child.on('close', (code) => {
    // 权限类失败(fs 输出含 EPERM/EACCES)给出可执行的引导,而非只报 code
    const permHint = /EPERM|EACCES/i.test(buf)
      ? '\n如提示权限不足(EPERM/EACCES),常见原因:npm 前缀位于系统目录需管理员权限;请以管理员身份重试,或执行 npm config set prefix "%APPDATA%\\npm"。'
      : '';
    finish(code === 0, code === 0 ? '' : `npm 安装失败 (code=${code})${permHint}`);
  });
  child.on('error', (e) => finish(false, `无法启动 npm:${e.message}`));
}

function checkDshUpdate(manual) {
  finishDshCheckTimer();
  state.dshManualCheckTimedOutAt = 0;
  state.dshManualCheckDropped = false;
  state.statusOpCancelled = false;
  if (manual && (state.downloadInProgress || state.updateDownloaded)) {
    // 桌面端更新进行中(下载/已就绪):回到对应进度窗口而不是覆盖它,避免两个更新流互顶
    log('手动检查 dsh 更新被忽略:桌面端更新流程进行中');
    deps.noticeFlowBusy('桌面端更新流程正在进行(下载/已就绪),暂时无法检查 dsh 本体更新;请先完成桌面端流程。', { mode: 'download', title: '正在下载更新…', spin: true, __origin: 'desktop' });
    return;
  }
  if (manual && (state.dshInstallChild || state.dshStoppedForInstall)) {
    // 本体安装进行中:回到安装进度窗口而不是覆盖
    log('手动检查 dsh 更新被忽略:安装仍在进行中');
    deps.noticeFlowBusy('dsh 本体安装已在进行,暂时无法再次检查;可在当前进度窗查看安装进度。', { mode: 'install', title: '正在安装 dsh 本体…', spin: true, __origin: 'dsh' });
    return;
  }
  // 仅打包版才有"桌面端更新";dsh 本体检查在开发模式同样可用,故不设 isPackaged 门槛
  const current = dshVersion();
  if (current === '未知') {
    log('检查 dsh 更新: 未定位到 dsh 本体,跳过');
    if (manual) {
      deps.showDialog({
        type: 'warning', title: '检查 dsh 更新',
        message: '未检测到 dsh 本体,请先全局安装:',
        detail: 'npm install -g @deepseek-ai/dsh',
        buttons: [{ label: '好的', primary: true }],
      });
    }
    return;
  }
  // 手动检查:显示"检查中"状态窗,设超时;超时提示后,迟到结果在宽限期内仍会送达
  if (manual) {
    deps.showStatus({ mode: 'check', title: '正在检查 dsh 本体更新…', detail: `当前 v${current}`, spin: true, __origin: 'dsh' });
    state.dshCheckTimer = setTimeout(() => {
      state.dshCheckTimer = null;
      state.dshManualCheckTimedOutAt = Date.now();
      log('检查 dsh 更新超时(宽限期内迟到结果仍会送达)');
      deps.showStatusResult({
        type: 'warning', title: '检查 dsh 更新超时', __origin: 'dsh',
        detail: `${CHECK_DSH_UPDATE_TIMEOUT_MS / 1000} 秒内未能获取 dsh 最新版本信息。\n网络较慢时结果稍后仍会送达;请确认网络可用后再试。`,
        buttons: [{ id: 'ok', label: '好的' }],
      }, () => deps.closeStatus());
    }, CHECK_DSH_UPDATE_TIMEOUT_MS);
  }
  fetchLatestDshVersion(CHECK_DSH_UPDATE_TIMEOUT_MS + 1000).then((latest) => {
    if (!lateResultAllowed(state.dshManualCheckTimedOutAt, state.dshManualCheckDropped)) return; // 已取消/超时过宽限期:忽略迟到结果
    finishDshCheckTimer();
    if (!latest) {
      log('检查 dsh 更新失败: 未能获取最新版本信息');
      if (manual) {
        deps.showStatusResult({
          type: 'error', title: '检查 dsh 本体更新失败', __origin: 'dsh',
          detail: '请确认网络可用后重试。',
          buttons: [{ id: 'ok', label: '好的' }],
        }, () => deps.closeStatus());
      }
      return;
    }
    const lv = latest ? parseVersion(latest) : null;
    if (latest && !lv) {
      // 版本号无法解析(含 build metadata 等畸形串):不能当"已是最新"糊弄用户
      log(`dsh 最新版本号无法解析: ${latest}`);
      if (manual) {
        deps.showStatusResult({
          type: 'error', title: '检查 dsh 本体更新失败', __origin: 'dsh',
          detail: `未能解析 npm 返回的最新版本号(${latest}),请稍后重试。`,
          buttons: [{ id: 'ok', label: '好的' }],
        }, () => deps.closeStatus());
      }
      return;
    }
    if (compareVersion(latest, current) > 0) {
      // 兼容性断言:大版本(0.2+ 或 1.0+)未经桌面壳验证,不自动推送安装
      // (参数形态/端口协议若变更,自动装完服务可能起不来,必须人工确认)
      if (lv && (lv.nums[0] !== 0 || lv.nums[1] > DSH_COMPATIBLE_MINOR)) {
        log(`dsh 新版本 v${latest} 超出已验证兼容区间(0.${DSH_COMPATIBLE_MINOR}.x),不自动推送`);
        if (manual) {
          deps.showStatusResult({
            type: 'warning', title: '发现 dsh 新版本(未验证兼容)', __origin: 'dsh',
            detail: `dsh 本体 v${latest} 可用(当前 v${current}),但该版本尚未经桌面壳验证。\n建议先在终端执行:\nnpm install -g @deepseek-ai/dsh@${latest}\n确认兼容后再继续使用。`,
            buttons: [{ id: 'ok', label: '好的' }],
          }, () => deps.closeStatus());
        }
        return;
      }
      log(`发现 dsh 新版本 v${latest}(当前 v${current})`);
      // 注意:不写 state.pendingVersion(那是桌面端专用),dsh 版本号全程走闭包参数
      const showResult = (nonIntrusive) => deps.showStatusResult({
        type: 'info', title: '发现 dsh 新版本', __origin: 'dsh',
        detail: `dsh 本体新版本 v${latest} 可用(当前 v${current})\n「现在更新」将暂停 dsh 服务、通过 npm 全局安装新版本,完成后自动重启 dsh 服务。`,
        buttons: [{ id: 'install', label: '现在更新', primary: true }, { id: 'later', label: '稍后' }],
      }, (id) => {
        if (id === 'install' && !deps.isQuitting()) installDshUpdate(latest);
        else deps.closeStatus();
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
            deps.trackNotification(n); // 保持引用:GC 会导致点击回调失效
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
      deps.showStatusResult({
        type: 'info', title: '检查 dsh 更新', __origin: 'dsh',
        detail: `dsh 本体已是最新版本(v${current})。`,
        buttons: [{ id: 'ok', label: '好的' }],
      }, () => deps.closeStatus());
    }
  });
}

// 取消当前状态窗对应操作:清计时器、忽略迟到结果、中止下载/停止 npm 安装、关闭窗口
function cancelStatusOp() {
  log('用户取消当前操作(状态窗关闭)');
  state.statusOpCancelled = true;
  // 取消语义按当前状态窗所属流收窄:取消桌面检查不得误吞在途的 dsh 自动检查结果(唯一一次自动通知),反之亦然
  const payload = deps.getStatusPayload();
  const origin = payload && payload.__origin;
  if (origin !== 'dsh') {
    if (state.updateCheckTimer) finishUpdateCheckTimer();
    state.manualCheckDropped = true;     // 忽略迟到的桌面端检查结果(取消语义:一律丢弃)
  }
  if (origin !== 'desktop') {
    if (state.dshCheckTimer) finishDshCheckTimer();
    state.dshManualCheckDropped = true;  // 忽略迟到的 dsh 本体检查结果
  }
  if (state.downloadInProgress) state.desktopDownloadCanceled = true; // 正在下载:迟到结果不再弹窗
  if (state.downloadToken) { state.downloadToken.cancel(); state.downloadToken = null; } // 中止桌面端下载传输
  state.downloadInProgress = false;
  state.updateDownloaded = false;
  state.pendingVersion = null;
  if (state.dshInstallChild) {
    state.installCancelled = true;
    const c = state.dshInstallChild;
    state.dshInstallChild = null;
    killTree(c);
  }
  // 安装 dsh 本体期间服务已被暂停:取消后立即恢复,避免应用失去 dsh 服务
  if (state.dshStoppedForInstall) {
    state.dshStoppedForInstall = false;
    if (!deps.isQuitting()) deps.bootDsh();
  }
  deps.closeStatus();
}

module.exports = {
  init,
  state,
  IS_PORTABLE,
  checkForUpdates,
  checkDshUpdate,
  installDshUpdate,
  cancelStatusOp,
  quitAndInstallGuarded,
  parseVersion,
  compareVersion,
  comparePre,
  fetchLatestDshVersion,
};
