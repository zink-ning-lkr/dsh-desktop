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
  // ⑩ 托盘状态(P0-3):tooltip 必须跟随运行态且含工作目录(不依赖启动耗时,慢启动下也稳定)
  uiStep(() => {
    const t = d.trayStatusText();
    const want = { ok: '运行中', boot: '启动中', err: '已停止' }[d.trayState];
    const ok = !!want && t.includes(want) && t.includes('D:\\Work');
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
  // P1-5:任务栏进度镜像主窗——下载中镜像值应 ≈0.42(Windows 无 getProgressBar,读主进程记录值)
  uiStep(() => { const p = d.mainWindowProgress; d.log(`UITEST dl-mirror main=${p}(期望 ≈0.42) → ${p != null && Math.abs(p - 0.42) < 0.02 ? 'PASS' : 'FAIL'}`); }, 7550, 'dl-mirror');
  uiStep(() => {
    const t = d.trayStatusText();
    // 进度按 1% 粒度入 tooltip(P0-4 去抖):42.0% 显示为整数 42%
    d.log(`UITEST tray-dl tip 含"下载中 42%" → ${t.includes('下载中 42%') ? 'PASS' : 'FAIL'} ("${t}")`);
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
  // P0-7:dialog 打开即聚焦主按钮(键盘 Enter 直达,与状态窗结果视图一致)
  uiStep(() => readDom(d.dialogWin, '(()=>{const ae=document.activeElement;return (ae&&ae.classList.contains("primary")&&ae.closest("#foot"))?"PASS focus=主按钮":"FAIL ae="+(ae?ae.className:"none")})()', 'd1-focus'), 10500);
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
  // P1-1 任务中心:前置流程已 ✕ 关闭(注册表清空),此时仅安装任务一项 → 单任务模式(与旧版像素兼容)
  uiStep(() => readDom(d.statusWin, '(()=>{const single=document.getElementById("activity").style.display!=="none";const t=document.getElementById("title").textContent;return (single&&t.includes("正在安装"))?"PASS 单任务模式":"FAIL single="+single+" t="+t})()', 'install-title'), 15500);
  // 安装完成:唯一任务转完成态 → 单任务结果视图(#rtitle 含"dsh 更新完成")
  uiStep(() => readDom(d.statusWin, '(()=>{const t=document.getElementById("rtitle").textContent;const shown=document.getElementById("result").style.display!=="none";return (shown&&t.includes("dsh 更新完成"))?"PASS":"FAIL shown="+shown+" t="+t})()', 'install-result'), 17400);
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('Array.from(document.querySelectorAll("#btns button")).find(b=>b.textContent==="好的").click()').catch(() => {}); }, 17600, 'install-later');
  uiStep(() => d.log(`UITEST install-later win=${!!d.statusWin}(期望 false) → ${!d.statusWin ? 'PASS' : 'FAIL'}`), 17800, 'install-later-verify');
  //    超时护栏:假 npm 挂死不退出 → 总超时应强制终止并弹"dsh 更新失败"
  uiStep(() => { process.env.DSH_UITEST_FAKE_NPM = path.join(d.app.getPath('userData'), 'fake-npm-hang.js'); d.installDshUpdate('9.9.9'); }, 18600, 'dsh-install-hang');
  uiStep(() => readDom(d.statusWin, 'document.getElementById("rtitle").textContent', 'install-timeout'), 23000);
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('Array.from(document.querySelectorAll("#btns button")).find(b=>b.textContent==="好的").click()').catch(() => {}); }, 23150, 'install-okbtn');
  uiStep(() => d.log(`UITEST install-timeout win=${!!d.statusWin}(期望 false) → ${!d.statusWin ? 'PASS' : 'FAIL'}`), 23300, 'install-okbtn-verify');
  // ⑪ 任务中心(P1-1):双流任务并存列表化 + 行级取消不误伤另一流 + toast 瞬时条目 4s 消退
  uiStep(() => { d.showStatus({ mode: 'download', title: '正在下载 v9.9.9…', detail: '当前 v0.0.0', pct: '0%', size: '', __origin: 'desktop' }); }, 23450, 'tc-dl');
  uiStep(() => { d.showStatus({ mode: 'install', title: '正在安装 dsh 本体 v9.9.9…', detail: 'npm install -g', spin: true, __origin: 'dsh' }); d.notifyToast('加速设置已保存:并发 6 段'); }, 23600, 'tc-install');
  uiStep(() => readDom(d.statusWin, '(()=>{const rows=[...document.querySelectorAll("#tlist .trow")];const act=rows.filter(r=>!r.classList.contains("done")).length;const eph=rows.filter(r=>r.classList.contains("ephemeral")).length;const t=document.getElementById("title").textContent;return (rows.length===3&&act===2&&eph===1&&t.includes("2 项进行中"))?"PASS":"FAIL rows="+rows.length+" act="+act+" eph="+eph+" t="+t})()', 'tc-list'), 23950);
  uiStep(() => { const h = d.statusWin?.getContentSize()[1] || 0; d.log(`UITEST tc-h=${h}(期望 >186 列表加高) → ${h > 186 ? 'PASS' : 'FAIL'}`); }, 24000, 'tc-h');
  // P1-1 实测式高度校准:渲染回报后窗口高度应与真实内容高度贴合(差 ≤14px,含主进程 8px 容差)
  uiStep(() => readDom(d.statusWin, '(()=>{const l=document.querySelector(".tlist");const cs=getComputedStyle(l);const gap=parseFloat(cs.rowGap)||0;const pad=parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom);const seq=[];for(const k of l.children){if(getComputedStyle(k).display==="contents"){seq.push(...k.children)}else seq.push(k)}let h=pad;seq.forEach((k,i)=>{h+=k.getBoundingClientRect().height;if(i>0)h+=gap});const natural=h+document.querySelector(".win-head").getBoundingClientRect().height+2;const diff=Math.abs(innerHeight-natural);return (diff<=14)?"PASS 实测贴合 natural="+Math.round(natural)+" win="+innerHeight:"FAIL diff="+Math.round(diff)+" natural="+Math.round(natural)+" win="+innerHeight})()', 'tc-fit'), 24150);
  // 行级取消 dsh 任务:desktop 下载任务必须不受影响(旧单槽模型无法表达,互斥链已删)
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('[...document.querySelectorAll("#tlist .trow:not(.done) .lx")][1].click()').catch(() => {}); }, 24200, 'tc-cancel-one');
  uiStep(() => readDom(d.statusWin, '(()=>{const ts=[...document.querySelectorAll("#tlist .trow .ltitle")].map(e=>e.textContent);const hasDl=ts.some(s=>s.includes("下载"));const hasDsh=ts.some(s=>s.includes("dsh 本体"));return (hasDl&&!hasDsh)?"PASS":"FAIL "+ts.join("|")})()', 'tc-narrow'), 24500);
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('document.getElementById("xBtn").click()').catch(() => {}); }, 24700, 'tc-close');
  uiStep(() => d.log(`UITEST tc-close win=${!!d.statusWin}(期望 false) → ${!d.statusWin ? 'PASS' : 'FAIL'}`), 24900, 'tc-close-verify');
  // ⑪' 孤儿 toast(P0-2 回归锁):真实任务全部结束后仅剩一条瞬时提示——必须渲染为列表 ephemeral 行,
  //    不得落入单任务 render() 画成"空 detail + 不定态进度条"的假进度窗;行级取消后仅剩 toast 同样走列表
  uiStep(() => { d.showStatus({ mode: 'check', title: '正在检查更新…', detail: '当前 v0.0.0', spin: true, __origin: 'desktop' }); }, 24950, 'lone-toast-prep');
  uiStep(() => { d.notifyToast('仅一条瞬时提示'); }, 25150, 'lone-toast-add');
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('[...document.querySelectorAll("#tlist .trow:not(.done) .lx")][0].click()').catch(() => {}); }, 25300, 'lone-toast-cancel-active');
  uiStep(() => readDom(d.statusWin, '(()=>{const list=document.getElementById("tlist");const rows=[...list.querySelectorAll(".trow")];const actEl=document.getElementById("activity");const t=document.getElementById("title").textContent;const ok=list.style.display!=="none"&&rows.length===1&&rows[0].classList.contains("ephemeral")&&actEl.style.display==="none"&&t==="任务中心";return ok?"PASS 单toast走列表行":"FAIL shown="+list.style.display+" rows="+rows.length+" eph0="+(rows[0]&&rows[0].classList.contains("ephemeral"))+" actHidden="+(actEl.style.display==="none")+" t="+t})()', 'lone-toast'), 25550);
  // ⑪'' 全部关闭语义(P0-1 回归锁):列表模式 ✕ = 逐个取消全部未完成任务再收窗——
  //    旧实现 st:close 直接清注册表,运行中的任务成为不可见且不可取消的孤儿
  uiStep(() => {
    d.updatesState.manualCheckDropped = false;      // 复位旗标:仅观察本轮取消效果
    d.updatesState.dshManualCheckDropped = false;
    d.showStatus({ mode: 'check', title: '正在检查更新…', detail: '当前 v0.0.0', spin: true, __origin: 'desktop' });
  }, 25800, 'cancel-all-prep');
  uiStep(() => { d.showStatus({ mode: 'install', title: '正在安装 dsh 本体 v9.9.9…', detail: 'npm install -g', spin: true, __origin: 'dsh' }); }, 25950, 'cancel-all-second');
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('document.getElementById("xBtn").click()').catch(() => {}); }, 26100, 'cancel-all-click');
  uiStep(() => {
    const ok = !d.statusWin && d.updatesState.manualCheckDropped && d.updatesState.dshManualCheckDropped;
    d.log(`UITEST cancel-all win=${!!d.statusWin}(期望 false) desktopDrop=${d.updatesState.manualCheckDropped} dshDrop=${d.updatesState.dshManualCheckDropped}(期望 true) → ${ok ? 'PASS' : 'FAIL'}`);
  }, 26250, 'cancel-all-verify');
  // ⑪''' Esc 语义梯度(P1-4):活动任务存在时 Esc = 挂后台(安全离开);仅剩结果时 Esc = 关窗
  uiStep(() => { d.showStatus({ mode: 'check', title: '正在检查更新…', detail: '当前 v0.0.0', spin: true, __origin: 'desktop' }); }, 26400, 'esc-active-prep');
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))').catch(() => {}); }, 26550, 'esc-active');
  uiStep(() => { const w = d.statusWin; const ok = !!w && w.isMinimized(); d.log(`UITEST esc-active minimized=${!!(w && w.isMinimized())}(期望 true,Esc=后台) → ${ok ? 'PASS' : 'FAIL'}`); }, 26700, 'esc-active-verify');
  uiStep(() => { d.statusWin?.show(); }, 26750, 'esc-restore');
  uiStep(() => { d.showStatusResult({ type: 'success', title: '更新就绪', detail: 'v9.9.9 已下载完成', buttons: [{ id: 'ok', label: '好的' }], __origin: 'desktop' }, () => {}); }, 26800, 'esc-result-prep');
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))').catch(() => {}); }, 26950, 'esc-result');
  uiStep(() => { const ok = !d.statusWin; d.log(`UITEST esc-result win=${!!d.statusWin}(期望 false,Esc=关窗) → ${ok ? 'PASS' : 'FAIL'}`); }, 27100, 'esc-result-verify');
  // ⑪'''' 被动结果不丢弃(P1-5):nonIntrusive 结果撞上进行中流程且状态窗已开 → 入列不抢焦点,
  //      行内按钮回调仍然可达(旧实现直接丢弃,只能靠日志追踪)
  let niActionFired = false;
  uiStep(() => { d.showStatus({ mode: 'check', title: '正在检查更新…', detail: '当前 v0.0.0', spin: true, __origin: 'desktop' }); }, 27200, 'ni-prep');
  uiStep(() => d.showStatusResult({ type: 'info', title: '被动结果', detail: '测试入列', buttons: [{ id: 'ni-ok', label: '知道了', primary: true }], __origin: 'dsh' }, () => { niActionFired = true; }, true), 27350, 'ni-result');
  uiStep(() => readDom(d.statusWin, '(()=>{const l=document.getElementById("tlist");const rows=[...l.querySelectorAll(".trow")];const doneRow=rows.find(r=>r.classList.contains("done"));const t=doneRow&&doneRow.querySelector(".ltitle").textContent;return (l.style.display!=="none"&&rows.length===2&&t==="被动结果")?"PASS 被动结果入列":"FAIL rows="+rows.length+" done="+(t||"none")+" shown="+l.style.display})()', 'ni-enqueue'), 27650);
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('document.querySelector("#tlist .trow.done .lbtns button").click()').catch(() => {}); }, 27800, 'ni-click');
  uiStep(() => { d.log(`UITEST ni-action fired=${niActionFired}(期望 true) → ${niActionFired ? 'PASS' : 'FAIL'}`); }, 27950, 'ni-action-verify');
  // ⑨ 加载页慢启动自助行(P0-2):dshBoot 桥按协议条件暴露——file:// 页必须有,http(s) 服务页必须零暴露
  //    (断言不变量本身,不依赖"检查瞬间 dshView 停在哪一页",慢启动时序下稳定)
  uiStep(() => d.dshView.webContents.executeJavaScript('(()=>{const f=location.protocol==="file:";const has=typeof window.dshBoot==="object";return (f===has)?"PASS protocol="+location.protocol+" has="+has:"FAIL protocol="+location.protocol+" has="+has})()')
    .then((v) => d.log(`UITEST boot-bridge-remote ${v}`))
    .catch((e) => d.log(`UITEST boot-bridge-remote ✗ ${e.message}`)), 25100, 'boot-bridge-remote');
  uiStep(() => { d.dshView.webContents.loadFile(path.join(__dirname, 'loading.html')).catch(() => {}); }, 25400, 'loading-reload');
  uiStep(() => readDom(d.dshView, '(()=>{const s=document.getElementById("slow");const v0=getComputedStyle(s).display==="none";showSlowActions();const v1=getComputedStyle(s).display!=="none";const n=document.querySelectorAll("#slow button").length;const b=typeof window.dshBoot==="object"&&typeof window.dshBoot.action==="function";return (v0&&v1&&n===3&&b)?"PASS":"FAIL v0="+v0+" v1="+v1+" btns="+n+" bridge="+b})()', 'boot-slow'), 26000);
  // ⑧ a11y(P1-3):菜单角色标注(menu/menuitem/menuitemcheckbox+aria-checked)、
  //    键盘导航(aria-activedescendant 跟随)与 typeahead(前缀匹配跳转),Escape 关闭
  uiStep(() => { d.showMenuPopup(); }, 26300, 'a11y-menu-open');
  // P0-7:菜单焦点落在 role=menu 容器(panel)上,aria-activedescendant 才对读屏器生效
  uiStep(() => readDom(d.menuPopupView, '(()=>{const ae=document.activeElement;return (ae&&ae.id==="panel")?"PASS focus=panel":"FAIL ae="+(ae?(ae.id||ae.tagName):"none")})()', 'a11y-menu-focus'), 26500);
  uiStep(() => readDom(d.menuPopupView, '(()=>{const p=document.getElementById("panel");const items=p.querySelectorAll("[role=menuitem],[role=menuitemcheckbox]").length;const chk=p.querySelectorAll("[role=menuitemcheckbox][aria-checked=true]").length;const sep=p.querySelectorAll("[role=separator]").length;return (p.getAttribute("role")==="menu"&&items>=10&&chk>=1&&sep>=1)?"PASS items="+items+" chk="+chk+" sep="+sep:"FAIL role="+p.getAttribute("role")+" items="+items+" chk="+chk+" sep="+sep})()', 'a11y-roles'), 26700);
  uiStep(() => readDom(d.menuPopupView, '(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown"}));document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown"}));const ad=document.getElementById("panel").getAttribute("aria-activedescendant");const sel=document.querySelector(".item.sel");return (ad&&sel&&sel.id===ad)?"PASS activedescendant="+ad:"FAIL ad="+ad+" sel="+(sel&&sel.id)})()', 'a11y-arrownav'), 27000);
  uiStep(() => readDom(d.menuPopupView, '(()=>{const before=document.querySelector(".item.sel");document.dispatchEvent(new KeyboardEvent("keydown",{key:"重"}));const after=document.querySelector(".item.sel");return (after&&after!==before&&after.textContent.includes("重"))?"PASS → "+after.textContent.trim().slice(0,10):"FAIL before="+(before&&before.textContent.trim().slice(0,10))+" after="+(after&&after.textContent.trim().slice(0,10))})()', 'a11y-typeahead'), 27300);
  uiStep(() => { d.menuPopupView?.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))').catch(() => {}); }, 27600, 'a11y-esc');
  uiStep(() => d.log(`UITEST a11y-closed win=${!!d.menuPopupView}(期望 false) → ${!d.menuPopupView ? 'PASS' : 'FAIL'}`), 27900, 'a11y-closed-verify');
  // ⑫ 外观主题(P1-2):菜单项存在 → 点击循环(auto→dark→light→auto) → config/themeSource 映射
  //    → 渲染层 data-theme + 令牌覆写 + 鲸鱼 logo 黑白换版;结束恢复原配置
  const theme0 = d.loadConfig().theme;
  const clickThemeItem = (win) => win?.webContents.executeJavaScript(
    '(()=>{const it=[...document.querySelectorAll(".item .lbl")].find(e=>e.textContent.startsWith("外观:"));if(!it)return "FAIL no-item";const label=it.textContent.trim();it.parentElement.click();return label})()'
  ).catch((e) => 'ERR ' + e.message);
  uiStep(() => { d.showMenuPopup(); }, 28200, 'theme-menu-open');
  uiStep(() => clickThemeItem(d.menuPopupView), 28500, 'theme-click-1');
  uiStep(() => { const cfg = d.loadConfig().theme; const src = d.getThemeSource(); const ok = cfg === 'dark' && src === 'dark'; d.log(`UITEST theme-1 auto→dark cfg=${cfg} src=${src} → ${ok ? 'PASS' : 'FAIL'}`); }, 28800, 'theme-1-verify');
  uiStep(() => { d.showMenuPopup(); }, 29100, 'theme-menu-open2');
  uiStep(() => clickThemeItem(d.menuPopupView), 29400, 'theme-click-2');
  uiStep(() => {
    const cfg = d.loadConfig().theme; const src = d.getThemeSource();
    const ok = cfg === 'light' && src === 'light';
    d.log(`UITEST theme-2 dark→light cfg=${cfg} src=${src} → ${ok ? 'PASS' : 'FAIL'}`);
    // 已开窗的渲染器应实时换肤(reportWin 自 11.8s 起一直开着,未重建)
    readDom(d.reportWin,
      `(()=>{const attr=document.documentElement.getAttribute("data-theme");const bg0=getComputedStyle(document.documentElement).getPropertyValue("--c-bg0").trim();const logo=document.querySelector(".logo").src;return (attr==="light"&&bg0==="#ffffff"&&logo.includes("whale-black"))?"PASS attr="+attr+" bg0="+bg0:"FAIL attr="+attr+" bg0="+bg0+" logo="+logo})()`,
      'theme-light-dom');
  }, 29700, 'theme-2-verify');
  uiStep(() => { d.showMenuPopup(); }, 30100, 'theme-menu-open3');
  uiStep(() => clickThemeItem(d.menuPopupView), 30400, 'theme-click-3');
  uiStep(() => {
    const cfg = d.loadConfig().theme; const src = d.getThemeSource();
    const ok = cfg === 'auto' && src === 'system';
    d.log(`UITEST theme-3 light→auto cfg=${cfg} src=${src} → ${ok ? 'PASS' : 'FAIL'}`);
    // 回到 auto:渲染层 data-theme 应与系统 prefers-color-scheme 自洽(测试机系统主题未知,断言一致性而非具体值)
    readDom(d.reportWin,
      `(()=>{const attr=document.documentElement.getAttribute("data-theme")||"";const want=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"";return (attr===want)?"PASS attr="+attr:"FAIL attr="+attr+" want="+want})()`,
      'theme-auto-dom');
  }, 30700, 'theme-3-verify');
  uiStep(() => { d.reportWin?.webContents.executeJavaScript('document.getElementById("xBtn").click()').catch(() => {}); }, 31100, 'theme-report-close');
  uiStep(() => d.log(`UITEST theme-report-closed win=${!!d.reportWin}(期望 false) → ${!d.reportWin ? 'PASS' : 'FAIL'}`), 31350, 'theme-report-close-verify');
  // ⑬ 首启欢迎页(P1-6):窗口创建/文案/按钮/桥接齐备;abortWelcome 吞掉 resolve 不触发退出分支
  uiStep(() => { d.showWelcome(); }, 31400, 'welcome-open');
  uiStep(() => readDom(d.welcomeWin, '(()=>{const c=document.getElementById("wlChoose");const q=document.getElementById("wlQuit");const h=document.body.textContent;const bridge=typeof window.__welcome==="object"&&typeof window.__welcome.choose==="function";const ok=!!c&&!!q&&h.includes("欢迎使用 DSH Desktop")&&h.includes("收进系统托盘")&&h.includes("会话、文件、设置、插件")&&bridge;return ok?"PASS 欢迎页齐备":"FAIL choose="+!!c+" quit="+!!q+" bridge="+bridge})()', 'welcome-dom'), 32000);
  uiStep(() => { d.abortWelcome(); }, 32200, 'welcome-abort');
  uiStep(() => d.log(`UITEST welcome-closed win=${!!d.welcomeWin}(期望 false) → ${!d.welcomeWin ? 'PASS' : 'FAIL'}`), 32400, 'welcome-closed-verify');
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
  }, 24200);
  setTimeout(() => {
    // 清理 UITEST 写入 userData 的假 npm 脚本
    for (const f of ['fake-npm-ok.js', 'fake-npm-hang.js']) {
      try { fs.unlinkSync(path.join(d.app.getPath('userData'), f)); } catch { /* 已不存在 */ }
    }
    // 恢复 UITEST 动过的加速设置(segments/mirror)与外观主题(theme),保证测试可重复、不污染真实配置
    try {
      const cfg = d.loadConfig();
      if (cfg.downloadSegments !== undefined || cfg.downloadMirror !== undefined) {
        delete cfg.downloadSegments;
        delete cfg.downloadMirror;
        d.saveConfig(cfg);
        d.log('UITEST: 已恢复加速设置默认值');
      }
      if (d.loadConfig().theme !== theme0) {
        const cfg2 = d.loadConfig();
        if (theme0 === undefined) delete cfg2.theme;
        else cfg2.theme = theme0;
        d.saveConfig(cfg2);
        d.applyTheme();
        d.log(`UITEST: 已恢复外观主题(${theme0 === undefined ? 'auto 默认' : theme0})`);
      }
    } catch (e) { d.log(`UITEST: 恢复配置失败 ${e.message}`); }
    d.log('UITEST: 完成,自动退出');
    d.app.quit();
  }, 33600);
}

module.exports = { runSmokeDemo, runUitest };
