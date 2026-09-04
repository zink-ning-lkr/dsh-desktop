// uitest.js —— 自动化冒烟编排(SMOKE / DEMO / UITEST 环境变量触发,由 main.js 在应用就绪后调用)。
// 从 main.js 抽离的纯测试代码:不参与生产路径;依赖经 deps 注入,其中 statusWin/dialogWin 等
// 会随时重建/置空的窗口变量一律以 getter 传入,保证测试读到的是当前实例。
//
// 三种模式:
//   DSH_DESKTOP_SMOKE=1  启动完成 + 窗口/托盘闭环验证(16s 自动退出)
//   DSH_DESKTOP_DEMO=1   SMOKE + 分阶段输出窗口屏幕坐标(供外部脚本截屏)
//   DSH_DESKTOP_UITEST=1 全量 UI 冒烟:状态窗/对话框/报告窗/菜单/标题栏动画/假 npm 安装/
//                        多线程下载器 sha512/布局一致性断言
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------- SMOKE / DEMO ----------
function runSmokeDemo(d) {
  if (process.env.DSH_DESKTOP_DEMO) {
    const demoShot = (name, win = d.mainWindow) => {
      try {
        const b = win.getBounds();
        const disp = d.screen.getDisplayMatching(b);
        fs.writeFileSync(process.env.DSH_DEMO_BOUNDS, JSON.stringify({
          name,
          x: Math.round(b.x * disp.scaleFactor),
          y: Math.round(b.y * disp.scaleFactor),
          w: Math.round(b.width * disp.scaleFactor),
          h: Math.round(b.height * disp.scaleFactor),
        }));
        d.log(`DEMO: 阶段 ${name}`);
      } catch (e) { d.log(`DEMO: 坐标输出失败 ${e.message}`); }
    };
    setTimeout(() => demoShot('1-bar'), 9_000);
    setTimeout(() => { d.showMenuPopup(); setTimeout(() => demoShot('2-menu'), 900); }, 10_500);
    setTimeout(() => {
      d.closeMenuPopup();
      d.saveConfig({ ...d.loadConfig(), closeAction: 'tray' });
      d.mainWindow?.close(); // 应被拦截:隐藏到托盘而非退出
      setTimeout(() => {
        d.log(`SMOKE: close 后窗口可见=${d.mainWindow?.isVisible()}(期望 false),进程仍存活`);
        d.showTrayMenu(); // 此刻外部脚本已把鼠标移到托盘区,菜单在光标处弹出
        setTimeout(() => {
          if (d.trayMenuWin) demoShot('3-tray-menu', d.trayMenuWin);
          d.closeTrayMenu();
          d.showMainWindow();
          setTimeout(() => {
            d.log(`SMOKE: 托盘恢复后窗口可见=${d.mainWindow?.isVisible()}(期望 true)`);
            d.app.quit();
          }, 600);
        }, 900);
      }, 800);
    }, 12_300);
  } else {
    setTimeout(() => { d.log('SMOKE: 自动退出'); d.app.quit(); }, 16_000);
  }
}

// ---------- 全量 UI 冒烟 ----------
// 依次弹出 状态窗(检查→下载→结果)/ 对话框 / 错误报告窗,抓取各窗口渲染器控制台报错与
// 加载失败,随后自动退出(供回归验证)
function runUitest(d) {
  const hookWin = (win, tag) => {
    if (!win) return;
    win.webContents.on('console-message', (e) => {
      d.log(`UITEST ${tag} console(${e.level}): ${e.message}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      d.log(`UITEST ${tag} did-fail-load ${code}: ${desc}`);
    });
  };
  const uiStep = (fn, delay, tag) => setTimeout(() => { try { fn(); d.log(`UITEST ${tag} ✓`); } catch (err) { d.log(`UITEST ${tag} ✗ 主进程异常: ${err.stack || err}`); } }, delay);
  const readDom = (win, expr, tag) => win?.webContents.executeJavaScript(expr)
    .then((v) => d.log(`UITEST dom ${tag} = "${v}"`))
    .catch((e) => d.log(`UITEST dom ${tag} ✗ ${e.message}`));
  // ⓪ 模块面与纯逻辑断言(拆分回归锁):core 脱敏与配置回环 / dsh-process 定位与启动快照 /
  //    updates semver 兼容判定 / diagnostics 归类顺序 / updates 初始状态面
  uiStep(() => {
    const core = require('./core');
    const dshProc = require('./dsh-process');
    const upd = require('./updates');
    const diag = require('./diagnostics');
    const ck = [];
    const t = (name, cond) => ck.push(`${name}:${cond ? 'ok' : 'FAIL'}`);
    t('redact', core.redactToken('http://127.0.0.1:1/?token=xy&a=1') === 'http://127.0.0.1:1/?token=***&a=1');
    t('redact-none', core.redactToken('http://127.0.0.1:1/') === 'http://127.0.0.1:1/');
    const cfg0 = core.loadConfig();
    t('cfg-save', core.saveConfig(cfg0) === true);
    t('cfg-eq', JSON.stringify(core.loadConfig()) === JSON.stringify(cfg0));
    t('dshbin', !!dshProc.findDshBinSafe());
    const snap = dshProc.getBootSnapshot();
    t('bootsnap', Array.isArray(snap.args) && snap.args.includes('web') && snap.args.includes('--host'));
    t('cmp-newer', upd.compareVersion('0.1.2-alpha.2', '0.1.1-rc.2') > 0);
    t('cmp-pre-rel', upd.compareVersion('0.1.1', '0.1.1-rc.2') > 0);
    t('cmp-pre-pre', upd.compareVersion('0.1.1-rc.2', '0.1.1-rc.10') < 0);
    t('cmp-bad', upd.compareVersion('garbage', '0.1.0') === 0);
    t('parse-v', upd.parseVersion('v0.1.1-rc.2').nums.join('.') === '0.1.1');
    t('cls-plugin', diag.classifyError(new Error("dsh: plugin tree failed to load: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'"), { phase: 'boot' }).kind === 'plugin-incompat');
    t('cls-missing', diag.classifyError(new Error('找不到 dsh,请先全局安装:npm install -g @deepseek-ai/dsh'), { phase: 'boot' }).kind === 'missing-dsh');
    t('cls-exit', diag.classifyError(null, { phase: 'exit', code: 1 }).kind === 'exit');
    t('upd-state', upd.state && upd.state.dshStoppedForInstall === false && upd.state.downloadInProgress === false && upd.state.installEpoch === 0);
    t('upd-face', ['checkForUpdates', 'checkDshUpdate', 'installDshUpdate', 'cancelStatusOp'].every((k) => typeof upd[k] === 'function'));
    d.log(`UITEST unit ${ck.every((s) => s.endsWith(':ok')) ? 'PASS' : 'FAIL'} ${ck.join(' ')}`);
  }, 2400, 'unit');
  // ⑩ 托盘状态(P0-3):启动完成后应为 ok/运行中;下载进度进 tooltip;结果页到达后进度清除
  uiStep(() => {
    const t = d.trayStatusText();
    const ok = d.trayState === 'ok' && t.includes('运行中');
    d.log(`UITEST tray-status state=${d.trayState} tip="${t}" → ${ok ? 'PASS' : 'FAIL'}`);
  }, 2600, 'tray-status');
  uiStep(() => { d.showStatus({ mode: 'check', title: '正在检查更新…', detail: '当前 v0.0.0', spin: true }); hookWin(d.statusWin, 'status'); }, 3500, 'status-show');
  // ⑨ 首帧布局断言:视图 bounds 与页面视口(innerWidth/Height)必须一致。
  //    不一致 = WebContentsView surface 未按 DPR 换算(Windows 高 DPI 首帧右侧/底部黑块的根因)
  uiStep(() => {
    try {
      const b = d.dshView.getBounds();
      d.dshView.webContents.executeJavaScript('({ w: window.innerWidth, h: window.innerHeight })')
        .then((s) => {
          const ok = !!s && Math.abs(s.w - b.width) <= 1 && Math.abs(s.h - b.height) <= 1;
          d.log(`UITEST layout-fit view=${b.width}x${b.height} page=${s && s.w}x${s && s.h} → ${ok ? 'PASS' : 'FAIL'}`);
        })
        .catch((e) => d.log(`UITEST layout-fit ✗ ${e.message}`));
    } catch (e) { d.log(`UITEST layout-fit ✗ ${e.stack || e}`); }
  }, 3050, 'layout-fit');
  uiStep(() => d.showStatusResult({ type: 'success', title: '更新就绪', detail: 'v9.9.9 已下载完成', buttons: [{ id: 'install', label: '立即重启安装', primary: true }] }, () => {}), 4200, 'flip-result');
  uiStep(() => readDom(d.statusWin, 'document.getElementById("rtitle").textContent', 'flip'), 4600);
  uiStep(() => d.log(`UITEST h-result=${d.statusWin?.getContentSize()[1]}(期望 250,确定按钮可见)`), 4700, 'h-result-verify');
  // 结果态 ✕ = 仅关闭
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('document.getElementById("xBtn").click()').catch(() => {}); }, 5000, 'result-x');
  uiStep(() => d.log(`UITEST result-x win=${!!d.statusWin}(期望 false) → ${!d.statusWin ? 'PASS' : 'FAIL'}`), 5300, 'result-x-verify');
  // 活动态 ✕ = 取消并关闭
  uiStep(() => d.showStatus({ mode: 'check', title: '正在检查更新…', detail: '当前 v0.0.0', spin: true }), 5800, 'check2');
  uiStep(() => d.log(`UITEST h-activity=${d.statusWin?.getContentSize()[1]}(期望 186)`), 5950, 'h-activity-verify');
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('document.getElementById("xBtn").click()').catch(() => {}); }, 6100, 'cancel-click');
  uiStep(() => { const ok = !d.statusWin; d.log(`UITEST cancel2 win=${!!d.statusWin} → ${ok ? 'PASS' : 'FAIL'}`); }, 6400, 'cancel-verify');
  // 下载 → 进度 → 结果
  uiStep(() => d.showStatus({ mode: 'download', title: '正在下载 v9.9.9…', detail: '当前 v0.0.0', pct: '0%', size: '' }), 7000, 'dl-show');
  uiStep(() => d.updateStatus({ mode: 'download', progress: 42, pct: '42.0%', size: '38 / 89 MB · 4.2 MB/s' }), 7400, 'dl-progress');
  uiStep(() => {
    const t = d.trayStatusText();
    d.log(`UITEST tray-dl tip 含"下载中 42.0%" → ${t.includes('下载中 42.0%') ? 'PASS' : 'FAIL'} ("${t}")`);
  }, 7500, 'tray-dl');
  uiStep(() => d.showStatusResult({ type: 'success', title: '更新就绪(下载完成)', detail: 'v9.9.9 已下载完成', buttons: [{ id: 'install', label: '立即重启安装', primary: true }] }, () => d.log('UITEST install-click ✓')), 7800, 'dl-result');
  uiStep(() => {
    const t = d.trayStatusText();
    d.log(`UITEST tray-dl-clear 结果页后无"下载中" → ${!t.includes('下载中') ? 'PASS' : 'FAIL'}`);
  }, 8000, 'tray-dl-clear');
  // ② 标题栏动画:收起 → 240ms 后应收敛到 0,再展开 → 应回到 TITLEBAR_H
  uiStep(() => d.toggleTitlebar(false), 8400, 'bar-collapse');
  uiStep(() => d.log(`UITEST bar-collapsed h=${d.currentBarH}(期望 0) → ${d.currentBarH === 0 ? 'PASS' : 'FAIL'}`), 8900, 'bar-verify0');
  uiStep(() => d.toggleTitlebar(true), 9200, 'bar-expand');
  uiStep(() => d.log(`UITEST bar-expanded h=${d.currentBarH}(期望 ${d.TITLEBAR_H},PASS=${d.currentBarH === d.TITLEBAR_H}) viewH=${d.titlebarView?.getBounds().height}(期望 ${d.TITLEBAR_H},栏高即视图高,无重叠)`), 9700, 'bar-verify30');
  // ③ 对话框复用(第二次调用必须仍能显示)
  uiStep(() => { d.showDialog({ type: 'info', title: 'D1', message: '第一个对话框', buttons: [{ label: '好', primary: true }] }); hookWin(d.dialogWin, 'dialog'); }, 10200, 'd1');
  uiStep(() => d.showDialog({ type: 'warning', title: 'D2', message: '第二个对话框(复用)', buttons: [{ label: '好', primary: true }] }), 10800, 'd2');
  uiStep(() => readDom(d.dialogWin, 'document.getElementById("title").textContent', 'd2'), 11200);
  // ④ 报告窗复用(启动失败自动弹出后,再次 showReport 仍要更新内容)
  uiStep(() => d.showReport({ phase: 'boot', error: new Error('等待 dsh web 输出服务地址超时(90s)'), code: null, buf: '[i] dsh web: 正在启动…', actions: [{ id: 'retry', label: '重试', style: 'primary' }] }), 11800, 'report2');
  uiStep(() => readDom(d.reportWin, 'document.getElementById("name").textContent', 'report'), 12400);
  // ⑤ 菜单 toggle:打开 → 点击按钮关闭 → 再点打开
  uiStep(() => d.showMenuPopup(), 13000, 'menu-open');
  uiStep(() => d.log(`UITEST menu-open w=${d.menuPopupView?.getBounds().width}(期望 ${d.MENU_W + d.MENU_MARGIN * 2}) → ${d.menuPopupView?.getBounds().width > 0 ? 'PASS' : 'FAIL'}`), 13300, 'menu-open-verify');
  uiStep(() => { d.titlebarView?.webContents.executeJavaScript('document.getElementById("menuBtn").click()').catch(() => {}); }, 13500, 'menu-toggle-close');
  uiStep(() => d.log(`UITEST menu-toggled-close destroyed=${!d.menuPopupView}(期望 true,P0-2 关闭即销毁) → ${!d.menuPopupView ? 'PASS' : 'FAIL'}`), 13750, 'menu-close-verify');
  uiStep(() => { d.titlebarView?.webContents.executeJavaScript('document.getElementById("menuBtn").click()').catch(() => {}); }, 13900, 'menu-toggle-open');
  uiStep(() => d.log(`UITEST menu-toggled-open w=${d.menuPopupView?.getBounds().width}(期望 ${d.MENU_W + d.MENU_MARGIN * 2}) → ${d.menuPopupView?.getBounds().width > 0 ? 'PASS' : 'FAIL'}`), 14150, 'menu-reopen-verify');
  // ⑤' 对话框高度自适应:长 detail(下载加速设置)必须加高窗口,按钮不被推出
  uiStep(() => d.showDialog({
    type: 'info', title: '下载加速设置', width: 540,
    message: '桌面端更新已默认启用多线程分段下载;仍慢时可配置镜像源,或为 npm 切换国内镜像。',
    detail: `【桌面端】在配置文件中加入镜像根目录(目录内需含 latest.yml 与安装包,文件名与 GitHub Release 资产一致):\n  "downloadMirror": "https://镜像根目录/",\n配置文件位置:\n  ${d.configPath()}\n\n【dsh 本体】执行下面命令改用国内 npm 镜像:\n  npm config set registry https://registry.npmmirror.com\n\n提示:镜像源不稳定时,下载会自动回退官方源,不影响更新。`,
    buttons: [{ label: '好的', primary: true }],
  }), 14300, 'accel-dialog');
  uiStep(() => {
    const s = d.dialogWin?.getContentSize();
    const ok = !!s && s[0] === 540 && s[1] >= 260;
    d.log(`UITEST accel-h=${s?.[1]}(期望 540 宽且高≥260,原 220 会遮按钮) → ${ok ? 'PASS' : 'FAIL'}`);
  }, 14600, 'accel-size-verify');
  uiStep(() => readDom(d.dialogWin, '(()=>{const r=document.querySelector("#foot button").getBoundingClientRect();return r.bottom<=innerHeight+1?`VISIBLE bottom=${Math.round(r.bottom)}/h=${innerHeight}`:`CLIPPED bottom=${Math.round(r.bottom)}/h=${innerHeight}`})()', 'accel-btn'), 14700);
  uiStep(() => { d.dialogWin?.webContents.executeJavaScript('document.querySelector("#foot button").click()').catch(() => {}); }, 14900, 'accel-close');
  // ⑥ dsh 本体安装(修复点:Windows spawn .cmd 抛 EINVAL → 状态窗永远"请稍后")
  //    成功路径:假 npm 输出两行后正常退出 0 → 应出现"dsh 更新完成"结果窗
  fs.writeFileSync(path.join(d.app.getPath('userData'), 'fake-npm-ok.js'),
    "process.stdout.write('fetching dsh metadata...\\n');setTimeout(()=>{process.stdout.write('added 1 package in 2s\\n');process.exit(0);},900);");
  fs.writeFileSync(path.join(d.app.getPath('userData'), 'fake-npm-hang.js'),
    "process.stdout.write('hanging...\\n');setInterval(()=>{},1000);");
  uiStep(() => { process.env.DSH_UITEST_FAKE_NPM = path.join(d.app.getPath('userData'), 'fake-npm-ok.js'); d.installDshUpdate('9.9.9'); hookWin(d.statusWin, 'status'); }, 15200, 'dsh-install-ok');
  uiStep(() => readDom(d.statusWin, 'document.getElementById("title").textContent', 'install-title'), 15500);
  uiStep(() => readDom(d.statusWin, 'document.getElementById("rtitle").textContent', 'install-result'), 16400);
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('Array.from(document.querySelectorAll("#btns button")).find(b=>b.textContent==="好的").click()').catch(() => {}); }, 16600, 'install-later');
  uiStep(() => d.log(`UITEST install-later win=${!!d.statusWin}(期望 false) → ${!d.statusWin ? 'PASS' : 'FAIL'}`), 16800, 'install-later-verify');
  //    超时护栏:假 npm 挂死不退出 → 总超时应强制终止并弹"dsh 更新失败"
  uiStep(() => { process.env.DSH_UITEST_FAKE_NPM = path.join(d.app.getPath('userData'), 'fake-npm-hang.js'); d.installDshUpdate('9.9.9'); }, 17600, 'dsh-install-hang');
  uiStep(() => readDom(d.statusWin, 'document.getElementById("rtitle").textContent', 'install-timeout'), 22000);
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('Array.from(document.querySelectorAll("#btns button")).find(b=>b.textContent==="好的").click()').catch(() => {}); }, 22150, 'install-okbtn');
  uiStep(() => d.log(`UITEST install-timeout win=${!!d.statusWin}(期望 false) → ${!d.statusWin ? 'PASS' : 'FAIL'}`), 22300, 'install-okbtn-verify');
  // ⑨ 加载页慢启动自助行(P0-2):dsh 服务页(http)必须零暴露 dshBoot;
  //    回到 loading.html 后 showSlowActions() 亮出操作行(3 按钮 + 桥可用)
  uiStep(() => d.dshView.webContents.executeJavaScript('typeof window.dshBoot')
    .then((v) => d.log(`UITEST boot-bridge-remote typeof=${v}(期望 undefined,远程页零暴露) → ${v === 'undefined' ? 'PASS' : 'FAIL'}`))
    .catch((e) => d.log(`UITEST boot-bridge-remote ✗ ${e.message}`)), 24100, 'boot-bridge-remote');
  uiStep(() => { d.dshView.webContents.loadFile(path.join(__dirname, 'loading.html')).catch(() => {}); }, 24400, 'loading-reload');
  uiStep(() => readDom(d.dshView, '(()=>{const s=document.getElementById("slow");const v0=getComputedStyle(s).display==="none";showSlowActions();const v1=getComputedStyle(s).display!=="none";const n=document.querySelectorAll("#slow button").length;const b=typeof window.dshBoot==="object"&&typeof window.dshBoot.action==="function";return (v0&&v1&&n===3&&b)?"PASS":"FAIL v0="+v0+" v1="+v1+" btns="+n+" bridge="+b})()', 'boot-slow'), 25000);
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
    const dest = path.join(d.app.getPath('userData'), 'dl-test.bin');
    try {
      const dl = require('./downloader');
      await dl.multiThreadDownload(`http://127.0.0.1:${port}/pkg.bin`, dest, { sha512: expect });
      const got = await dl.hashFile(dest);
      const mirrorUrl = dl.resolveDownloadUrl('https://github.com/x/y/releases/download/v1/a.exe', 'https://m.example.com/dir/');
      d.log(`UITEST downloader-multi PASS=${got === expect} size=${payload.length} seg=${dl.DEFAULT_SEGMENTS} mirror=${mirrorUrl}`);
    } catch (err) {
      d.log(`UITEST downloader-multi ✗ ${err.stack || err}`);
    } finally {
      server.close();
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
    }
    // ⑧ 下载加速设置窗冒烟:打开 → 读当前默认 → 保存分段数/镜像源(含非法值校验) → 关闭
    try {
      d.showAccelSettings();
      hookWin(d.accelWin, 'accel');
      await new Promise((resolve) => d.accelWin.webContents.once('did-finish-load', resolve));
      await new Promise((r) => setTimeout(r, 350)); // 等渲染层 A.get() 初始化表单
      const before = await d.accelWin.webContents.executeJavaScript('window.__accel.get()');
      const uiSeg = await d.accelWin.webContents.executeJavaScript('document.getElementById("segN").textContent');
      const s1 = await d.accelWin.webContents.executeJavaScript('window.__accel.set("segments", 12)');
      const cfg1 = d.loadConfig().downloadSegments;
      const s2 = await d.accelWin.webContents.executeJavaScript('window.__accel.set("mirror", "https://m.example.com/dir/")');
      const cfg2 = d.loadConfig().downloadMirror;
      const bad = await d.accelWin.webContents.executeJavaScript('window.__accel.set("mirror", "not-a-url")');
      const s3 = await d.accelWin.webContents.executeJavaScript('window.__accel.set("mirror", "")');
      const cfg3 = d.loadConfig().downloadMirror; // delete 后应为 undefined
      const ok = before.segments === 6 && before.downloadMirror === '' && uiSeg === '6'
        && s1.ok && s1.value === 12 && cfg1 === 12
        && s2.ok && cfg2 === 'https://m.example.com/dir/'
        && !bad.ok && s3.ok && cfg3 === undefined;
      d.log(`UITEST accel-win ✓ UIseg=${uiSeg} → ${ok ? 'PASS' : 'FAIL'} (seg=${cfg1} mirror=${cfg2} bad=${!bad.ok} cleared=${cfg3 === undefined})`);
      d.accelWin.close();
    } catch (err) {
      d.log(`UITEST accel-win ✗ ${err.stack || err}`);
    }
  }, 23200);
  setTimeout(() => {
    // 清理 UITEST 写入 userData 的假 npm 脚本
    for (const f of ['fake-npm-ok.js', 'fake-npm-hang.js']) {
      try { fs.unlinkSync(path.join(d.app.getPath('userData'), f)); } catch { /* 已不存在 */ }
    }
    // 恢复 UITEST 动过的加速设置(segments/mirror),保证测试可重复、不污染真实配置
    try {
      const cfg = d.loadConfig();
      if (cfg.downloadSegments !== undefined || cfg.downloadMirror !== undefined) {
        delete cfg.downloadSegments;
        delete cfg.downloadMirror;
        d.saveConfig(cfg);
        d.log('UITEST: 已恢复加速设置默认值');
      }
    } catch (e) { d.log(`UITEST: 恢复配置失败 ${e.message}`); }
    d.log('UITEST: 完成,自动退出');
    d.app.quit();
  }, 26400);
}

module.exports = { runSmokeDemo, runUitest };
