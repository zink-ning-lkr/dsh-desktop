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
    const sc = require('./shortcuts');
    t('sc-ids', ['open-workspace', 'restart-dsh', 'fullscreen', 'toggle-bar', 'reload', 'devtools'].every((id) => sc.list.some((s) => s.id === id)));
    const i18n = require('./i18n');
    t('i18n-t', i18n.t('tray.running') === '运行中');
    t('i18n-params', i18n.t('common.welcome', { app: 'DSH' }) === '欢迎使用 DSH');
    t('i18n-miss', i18n.t('nope.missing') === 'nope.missing');
    d.log(`UITEST unit ${ck.every((s) => s.endsWith(':ok')) ? 'PASS' : 'FAIL'} ${ck.join(' ')}`);
  }, 2400, 'unit');
  // ⓠ ui-kit 复合组件层(阶段 0):公开面 + 无 module + 打包白名单 + 页面静态一致性。
  // 最后两项专防两类静默故障:①build.files 是白名单,新增文件漏加不报错,装机才暴露;
  // ②页面用了 window.UI_KIT 却忘了 <script src>,开发期页面直接抛错但只在对应窗口可见。
  uiStep(() => {
    const src = fs.readFileSync(path.join(__dirname, 'ui-kit.js'), 'utf8');
    const files = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).build.files;
    const ck = [];
    const t = (name, cond) => ck.push(`${name}:${cond ? 'ok' : 'FAIL'}`);
    const exported = (src.match(/window\.UI_KIT\s*=\s*\{([^}]*)\}/) || [, ''])[1];
    t('uikit-global', /window\.UI_KIT\s*=/.test(src));
    t('uikit-apis', ['el', 'buttonRow', 'progressBar', 'bigBadge', 'feedback', 'focusPrimary', 'focusTrap', 'srOnly']
      .every((k) => new RegExp(`\\b${k}\\b`).test(exported)));
    // 禁用 ES module 的回归锁:页面走 file://,type="module" 会被 Chromium 按 CORS 拒绝
    t('uikit-nomodule', !/^\s*(import|export)\s/m.test(src));
    t('uikit-iife', /^\(function\s*\(\)\s*\{/m.test(src));
    t('uikit-packed', files.includes('ui-kit.js'));
    // 页面 ↔ 共享层一致性
    const miss = [];
    for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(__dirname, f), 'utf8');
      const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
      if (/window\.UI_KIT\b/.test(html) && !srcs.includes('ui-kit.js')) miss.push(`${f}:未加载ui-kit.js`);
      if (/window\.UI_ICONS\b/.test(html) && !srcs.includes('ui-icons.js')) miss.push(`${f}:未加载ui-icons.js`);
      for (const s of srcs) {
        if (!fs.existsSync(path.join(__dirname, s))) miss.push(`${f}:缺文件${s}`);
        else if (!files.includes(s)) miss.push(`${f}:未打包${s}`);
      }
    }
    t('ui-consistent', miss.length === 0);
    // 页面脚本 ↔ 页面 HTML:脚本里 getElementById(x) 的 x 必须真的存在(id="x" / el.id='x' / 数据里的 id:'x')。
    // 与上面两类同属"静默失败":拼错一个 id,该元素只是永不更新,页面照常渲染、控制台只报一次 null 访问
    const idBad = [];
    for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(__dirname, f), 'utf8');
      const declared = new Set();
      for (const m of html.matchAll(/id="([^"]+)"/g)) declared.add(m[1]);
      for (const m of html.matchAll(/\.id\s*=\s*'([^']+)'/g)) declared.add(m[1]);
      for (const m of html.matchAll(/^\s*id:\s*'([^']+)'/gm)) declared.add(m[1]);
      for (const m of html.matchAll(/getElementById\('([^']+)'\)/g)) {
        if (!declared.has(m[1])) idBad.push(`${f}:${m[1]}`);
      }
    }
    t('dom-ids', idBad.length === 0);
    d.log(`UITEST uikit ${ck.every((s) => s.endsWith(':ok')) ? 'PASS' : 'FAIL'} ${ck.join(' ')}${miss.length ? ` 问题:${miss.join(' ')}` : ''}${idBad.length ? ` 缺 id:${idBad.join(' ')}` : ''}`);
  }, 2500, 'uikit');
  // ⓠ i18n / a11y 收尾(阶段 0 第五批):文案零硬编码 + 键名可达 + 主区域 landmark。
  // 三项都是"静默失败":硬编码中文、拼错的键名(t() 回退 key 本身,页面照常渲染但显示
  // 成 "menu.enabled" 这种裸键)、缺 landmark(读屏器不报错,只是永远没有区域可跳)。
  uiStep(() => {
    const ck = [];
    const t = (name, cond) => ck.push(`${name}:${cond ? 'ok' : 'FAIL'}`);
    const pages = fs.readdirSync(__dirname).filter((x) => x.endsWith('.html'));
    const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
    // 渲染层零中文硬编码:剥掉 HTML/CSS/行注释后,属性值 / JS 单引号串 / 文本节点都不应含汉字。
    // 文案一律走 i18n 表,由 preload 的 __i18n 或主进程 t() 提供。
    const hard = [];
    for (const f of pages) {
      const body = read(f)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const cn = [];
      for (const m of body.matchAll(/\w[\w-]*\s*=\s*"[^"]*[\u4e00-\u9fa5][^"]*"/g)) cn.push(m[0].slice(0, 24));
      for (const m of body.matchAll(/'[^'\n]*[\u4e00-\u9fa5][^'\n]*'/g)) cn.push(m[0].slice(0, 24));
      for (const m of body.matchAll(/>[^<>\n]*[\u4e00-\u9fa5][^<>\n]*</g)) cn.push(m[0].slice(0, 24));
      if (cn.length) hard.push(`${f}:${cn[0]}`);
    }
    t('i18n-nohardcode', hard.length === 0);
    // 键名可达:所有字面量 t('域.键')/T('域.键') 必须命中文案表。
    // t() 找不到键时回退 key 本身,拼错不会抛错 —— 只有这条断言能拦住它。
    const i18n = require('./i18n');
    const dead = [];
    for (const f of [...pages, ...fs.readdirSync(__dirname).filter((x) => x.endsWith('.js') && x !== 'uitest.js')]) {
      for (const m of read(f).matchAll(/\b[tT]\('([a-z][A-Za-z0-9]*\.[A-Za-z0-9]+)'/g)) {
        if (i18n.t(m[1]) === m[1]) dead.push(`${f}:${m[1]}`);
      }
    }
    t('i18n-keys', dead.length === 0);
    // 快捷键单一数据源只存键名(修 X5):文案不得再内联,且键名必须可达
    const sc = require('./shortcuts');
    t('sc-labelKey', sc.list.every((s) => typeof s.labelKey === 'string' && !('label' in s))
      && sc.list.every((s) => i18n.t(s.labelKey) !== s.labelKey));
    // 主区域 landmark(X4-3):menu 是纯 role="menu" 弹出层、dialog 是 role="dialog" 模态窗,
    // 二者不套 <main> —— 单控件窗里再放主区域会造出误导性结构,属有意豁免。
    // toast.html 同理豁免:它是浮在主窗之上的通知层(role="region" 已带可访问名),
    // 本身没有"页面主体",硬套 <main> 只会让读屏器多出一个空的主区域跳转点。
    // palette.html 同属浮层(role="dialog" 包裹 combobox + listbox 两个控件),理由同上。
    const EXEMPT = { 'menu.html': 'role=menu 弹出层', 'dialog.html': 'role=dialog 模态', 'toast.html': 'role=region 浮动通知层', 'palette.html': 'role=dialog 命令面板浮层' };
    const noLm = pages.filter((f) => !/role="main"|<main[\s>]/.test(read(f)) && !EXEMPT[f]);
    t('a11y-landmark', noLm.length === 0);
    // reveal-tab 的交互宿主必须是真 <button>(X4-2):role="button" 挂在 <body> 上时,
    // 读屏器的控件导航与 Enter 激活都落不到它身上,键盘语义只能靠手写 keydown 兜。
    const rv = read('reveal-tab.html');
    t('a11y-reveal-btn', /<button[^>]*id="revealBtn"/.test(rv)
      && !/<body[^>]*role="button"/.test(rv)
      && !/document\.body\.addEventListener\('(click|keydown)'/.test(rv));
    const bad = [...hard, ...dead, ...noLm];
    d.log(`UITEST i18n-a11y ${ck.every((s) => s.endsWith(':ok')) ? 'PASS' : 'FAIL'} ${ck.join(' ')}${bad.length ? ` 问题:${bad.join(' ')}` : ''}`);
  }, 2550, 'i18n-a11y');
  // ⓠ 命令栏状态簇(阶段 1 S1):静态结构 + 渲染层真实状态。
  // 静态部分防"三处命令分发各写一份"与"新增通道漏接线";运行部分防"徽标数字与真实任务数脱节"。
  uiStep(() => {
    const ck = [];
    const t = (name, cond) => ck.push(`${name}:${cond ? 'ok' : 'FAIL'}`);
    const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const pre = fs.readFileSync(path.join(__dirname, 'titlebar-preload.js'), 'utf8');
    const bar = fs.readFileSync(path.join(__dirname, 'titlebar.html'), 'utf8');
    const icons = fs.readFileSync(path.join(__dirname, 'ui-icons.js'), 'utf8');
    // 命令分发单一入口:case 只允许在 runCommand 里出现一次。命令栏若照抄一份 switch,
    // 两个 case 计数会立刻变成 2 —— 这是"菜单能点、命令栏点了没反应"这类漂移的唯一防线。
    t('cmdbar-runCommand', /function runCommand\(id\)/.test(main));
    t('cmdbar-single-switch', (main.match(/case 'check-update':/g) || []).length === 1
      && (main.match(/case 'cycle-theme':/g) || []).length === 1);
    t('cmdbar-ipc', ['tb:tasks', 'tb:update', 'tb:cycle-theme', 'tb:copy-ws'].every((c) => main.includes(`'${c}'`)));
    t('cmdbar-bridge', ['onStatus', 'openTasks', 'checkUpdate', 'cycleTheme', 'copyWorkspace'].every((k) => pre.includes(k)));
    t('cmdbar-push', /function pushTitlebarStatus\(\)/.test(main) && main.includes("send('tb:status'"));
    // 状态簇四个槽位 + 图标源:新增状态钮必须落进 .cluster,不能散在栏上
    t('cmdbar-slots', ['svcStat', 'taskBtn', 'updBtn', 'themeBtn'].every((id) => bar.includes(`id="${id}"`))
      && /class="cluster"[\s\S]{0,900}?<\/div>/.test(bar));
    t('cmdbar-icons', /const cmdbar = \{/.test(icons)
      && ['tasks', 'update', 'theme'].every((k) => new RegExp(`${k}:`).test(icons)));
    t('cmdbar-icons-loaded', (bar.match(/<script\s+src="([^"]+)"/g) || []).join(' ').includes('ui-icons.js'));
    const bad = ck.filter((s) => s.endsWith(':FAIL'));
    d.log(`UITEST cmdbar ${bad.length ? 'FAIL' : 'PASS'} ${ck.join(' ')}`);
  }, 2575, 'cmdbar-static');
  // ⓠ 命令注册表静态契约(阶段 2·可发现性):commands.js 是「☰ 菜单 / 命令面板 / 托盘菜单」
  //    三方唯一来源。它一旦与执行侧脱节,表现是"面板里看得到这条命令、点下去毫无反应"——
  //    静默失败,且只在命令面板里可见(菜单恰恰因为不走这条 id 而看起来一切正常)。
  uiStep(() => {
    const ck = [];
    const t = (name, cond) => ck.push(`${name}:${cond ? 'ok' : 'FAIL'}`);
    const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
    const main = read('main.js');
    const cmds = require('./commands');
    const i18n = require('./i18n');
    const files = JSON.parse(read('package.json')).build.files;
    // 注册表本体:进白名单 + 主进程真的在用它拼条目
    t('cmd-packed', files.includes('commands.js'));
    t('cmd-require', main.includes("require('./commands')") && /function commandCtx\(\)/.test(main));
    t('cmd-menu-from-registry', /function menuItems\(\)[\s\S]{0,1200}?commands\.list/.test(main));
    // 唯一真名正向:每个注册表 id 必须能在 runCommand 里找到执行分支
    const missing = cmds.list.filter((c) => !main.includes(`case '${c.id}':`)).map((c) => c.id);
    t('cmd-ids', missing.length === 0);
    // 反向:runCommand 不许出现注册表以外的 case(残留的孤儿分支会让人误以为命令还在)
    const declared = new Set(cmds.list.map((c) => c.id));
    const orphans = [...(main.match(/case '[a-z-]+':/g) || [])]
      .map((s) => s.slice(6, -2))
      .filter((id) => !declared.has(id));
    t('cmd-no-orphan', orphans.length === 0);
    // 分组名/分类名合法,且每个分组都能取到标题(缺键会在菜单与面板里渲染成 cmd.groupXxx 裸键)
    t('cmd-groups', cmds.groups.length >= 4
      && cmds.list.every((c) => cmds.groups.includes(c.group) && cmds.KINDS.includes(c.kind))
      && cmds.groups.every((g) => i18n.t(cmds.groupLabelKey(g)) !== cmds.groupLabelKey(g)));
    // 文案可解析:用桩上下文把所有 label 跑一遍——菜单文案表漏键(渲染成 menu.xxx 裸键)当场现形
    const ctx = { t: i18n.t, cfg: {}, barVisible: true, version: '0.0.0', dshVersion: '0.0.0', mem: '0 MB', isPortable: false };
    const bare = cmds.list.filter((c) => /^(menu|cmd)\./.test(cmds.labelOf(c, ctx))).map((c) => c.id);
    t('cmd-labels', bare.length === 0);
    // 快捷键不许有孤儿:shortcuts.js 的每个 id 都必须是注册表里的命令,否则该快捷键指向不存在的命令
    const sc = require('./shortcuts');
    t('cmd-accel-linked', sc.list.every((s) => declared.has(s.id)));
    // 迁移完成标志:主菜单条目不得再手写 label(手写一份 = 又回到"改一处漏一处")
    t('cmd-menu-no-inline', !/id: 'open-workspace', label: t\(/.test(main));
    // 托盘菜单也接注册表(加速键/勾选态不再各写一份)
    t('cmd-tray-linked', /function trayMenuItems\(\)[\s\S]{0,900}?commands\.labelOf/.test(main));
    const bad = ck.filter((s) => s.endsWith(':FAIL'));
    d.log(`UITEST cmd ${bad.length ? 'FAIL' : 'PASS'} ${ck.join(' ')}${missing.length ? ` 缺执行分支:${missing.join(',')}` : ''}${orphans.length ? ` 孤儿分支:${orphans.join(',')}` : ''}${bare.length ? ` 裸键:${bare.join(',')}` : ''}`);
  }, 2598, 'cmd-static');
  // ⓠ 命令面板静态契约(阶段 2):面板是"全量命令清单"的唯一出口,三处静默故障:
  //    ① 高度常量与渲染层的行高/行数上限脱节 → 面板底部被裁或留一大片空白;
  //    ② Ctrl+K 被注册成 Electron accelerator → dsh 页面再也拿不到这个组合键(且跨进程才能排查);
  //    ③ 新文件漏进 build.files → 开发期完全无感,装机点 Ctrl+K 直接白屏。
  uiStep(() => {
    const ck = [];
    const t = (name, cond) => ck.push(`${name}:${cond ? 'ok' : 'FAIL'}`);
    const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
    const main = read('main.js');
    const html = read('palette.html');
    const pre = read('palette-preload.js');
    const bar = read('titlebar.html');
    const barPre = read('titlebar-preload.js');
    const files = JSON.parse(read('package.json')).build.files;
    t('palette-lazy', /function ensurePaletteView\(/.test(main) && /function destroyPaletteView\(/.test(main) && /function syncPaletteBounds\(/.test(main));
    // 载具必须是主窗内视图:面板要接收鼠标,独立窗会与主窗脱帧;而 toast 必须独立窗才谈得上穿透
    t('palette-view', /paletteView = new WebContentsView\(/.test(main) && /addChildView\(paletteView\)/.test(main));
    // 常量 ↔ 渲染层严格配对:高度公式的加数/乘数/上限,任一处单改就会错位
    t('palette-consts', /PALETTE_W = 560/.test(main) && /PALETTE_ROW_H = 36/.test(main)
      && /PALETTE_MAX_ROWS = 8/.test(main) && /PALETTE_INPUT_H = 56/.test(main)
      && /const MAX_ROWS = 8;/.test(html) && /height: 36px/.test(html) && /height: 56px/.test(html));
    // 绝不用 accelerator:dsh 页面自身可能也在用同一组合键,注册就是把冲突面推到进程外。
    // 排除条件收紧到"accelerator 里出现 +K"——将来别的键位加 accelerator 不该被这条误伤
    t('palette-no-accelerator', /function bindPaletteKey\(wc\)/.test(main)
      && /before-input-event/.test(main)
      && !/globalShortcut/.test(main)
      && !/accelerator:[^\n]*\+K['"]/.test(main));
    t('palette-key-bound', /bindPaletteKey\(titlebarView\.webContents\)/.test(main) && /bindPaletteKey\(dshView\.webContents\)/.test(main));
    t('palette-ipc', ['pt:show', 'pt:run', 'pt:close', 'pt:height']
      .every((c) => main.includes(`'${c}'`) && pre.includes(`'${c}'`)));
    // trustedEvent 是每个新 IPC handler 的准入门槛;回程三个通道一个都不能漏,
    // 且必须校验 sender(面板视图可能已被销毁重建,只认当前实例)
    t('palette-trusted', (main.match(/ipcMain\.on\('pt:[a-z]+',?\s*\(e[^)]*\)\s*=>\s*\{\s*\n\s*if \(!trustedEvent\(e\)/g) || []).length === 3
      && (main.match(/e\.sender [!=]== paletteView\.webContents/g) || []).length === 3);
    // 命令出口唯一:面板只回传 id,执行仍归 runCommand(与菜单/托盘/命令栏同源)
    t('palette-run-command', /ipcMain\.on\('pt:run'[\s\S]{0,700}?runCommand\(key\)/.test(main));
    // 命令栏中段入口:按钮 + 桥 + 三分支断点(≥1200 全称 / 960–1200 图标 / <960 隐藏)
    t('palette-entry', /id="cmdBtn"/.test(bar) && /openPalette:/.test(barPre)
      && /max-width: 1199px/.test(bar) && /cmdentry/.test(bar));
    // 平台前缀不由渲染层判断:经 sc:display 从 shortcuts.display() 下发
    t('palette-kbd', main.includes("'sc:display'") && /on\('sc:display'/.test(main) && barPre.includes('sc:display'));
    // 页面契约:combobox + listbox + activedescendant(WAI-ARIA APG 的 combobox 模式)
    t('palette-aria', html.includes('role="combobox"') && html.includes('aria-controls="plist"')
      && html.includes('role="listbox"') && html.includes('aria-activedescendant'));
    const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
    t('palette-page-deps', srcs.includes('ui-theme.js') && srcs.includes('ui-icons.js'));
    t('palette-packed', files.includes('palette.html') && files.includes('palette-preload.js'));
    const bad = ck.filter((s) => s.endsWith(':FAIL'));
    d.log(`UITEST palette ${bad.length ? 'FAIL' : 'PASS'} ${ck.join(' ')}`);
  }, 2602, 'palette-static');
  // ⓠ 菜单分组树静态契约(阶段 2 · v0.7.13):菜单从"一串平铺条目 + 分隔线"改成按 commands.js
  //    的 groups 渲染的分组树,并多出一行底部入口。三类静默故障:
  //    ① 小标题漏进 navRows → 键盘导航会停在一条点不动、typeahead 还会命中的假行上;
  //    ② 行高常量与菜单实际盒高脱节 → 分组让菜单长高 144px,底部那行(也就是整个可发现性闭环的入口)
  //       正好被裁掉,而这一行恰恰是用户唯一能发现 Ctrl+K 的地方;
  //    ③ 底部入口被登记成"命令" → 它会自己出现在命令面板的搜索结果里(在面板里搜"所有命令")。
  uiStep(() => {
    const ck = [];
    const t = (name, cond) => ck.push(`${name}:${cond ? 'ok' : 'FAIL'}`);
    const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
    const main = read('main.js');
    const html = read('menu.html');
    const i18n = require('./i18n');
    const cmds = require('./commands');
    // 分组小标题由注册表的分组顺序驱动,文案走 groupLabelKey(不手写第二份组名)
    t('menu-sec', /function menuItems\(\)[\s\S]{0,1600}?type: 'sec'[\s\S]{0,400}?groupLabelKey/.test(main));
    t('menu-sec-render', /it\.type === 'sec'/.test(html) && html.includes('sec-label'));
    // 分组名必须进无障碍树:role=menu 只认 menuitem/group/separator,裸标题 div 只是静态文本
    t('menu-sec-aria', html.includes("setAttribute('role', 'group')")
      && /grp\.setAttribute\('aria-label', it\.label\)/.test(html)
      && /head\.setAttribute\('aria-hidden', 'true'\)/.test(html));
    // 小标题不入键盘导航:sec 分支必须以 return 收尾,不能顺流到 navRows.push
    t('menu-sec-nav', /if \(it\.type === 'sec'\) \{[\s\S]{0,900}?host = grp;\s*\n\s*return;\s*\n\s*\}/.test(html));
    // 逐项高度收敛成一个函数:两处菜单共用,且不许再有第二份手写循环(多一种行类型只改一处)
    t('menu-height-fn', /function menuHeight\(items\)/.test(main)
      && (main.match(/menuHeight\(items\)/g) || []).length >= 2
      && !/for \(const it of items\) mh \+= /.test(main));
    // 常量 ↔ 渲染层盒高三处对齐(.item 32 / .sec 24 / .sep 1px + 上下各 4px 外边距 = 9)
    t('menu-height-sync', /MENU_ITEM_H = 32/.test(main) && /MENU_SEC_H = 24/.test(main) && /MENU_SEP_H = 9/.test(main)
      && /height: 32px/.test(html) && /height: 24px/.test(html) && /\.sep \{ height: 1px/.test(html));
    // 分组让菜单长高 144px:矮屏溢出必须钳制 + 内部滚动兜底,否则底部入口在 1366×768 上永远看不见
    t('menu-overflow', /screen\.getDisplayMatching\(mainWindow\.getBounds\(\)\)\.workArea/.test(main)
      && /max-height: calc\(100% - 24px\)/.test(html) && /overflow-y: auto/.test(html));
    t('menu-scrollinto', /navRows\[sel\]\.scrollIntoView\(\{ block: 'nearest' \}\)/.test(html));
    // 分隔线仍挂在菜单上而非落进分组:否则 a11y-roles 的 sep 计数会掉到 0(菜单就没有分隔线了)
    t('menu-sep-host', /if \(it\.type === 'sep'\)[\s\S]{0,400}?panel\.appendChild\(sep\);\s*\n\s*host = panel;/.test(html));
    // 底部入口:文案入表 + 加速键取自 shortcuts.js(不手写 "Ctrl+K")+ 图标按 id 挂在 menu 族
    t('menu-footer', main.includes("id: 'open-palette'") && main.includes("t('cmd.allCommands')")
      && /accel: shortcuts\.display\('CmdOrCtrl\+K'\)/.test(main)
      && i18n.t('cmd.allCommands') !== 'cmd.allCommands'
      && read('ui-icons.js').includes("'open-palette':"));
    // 它是界面入口而非命令:走 m:action 专线直达面板,不进注册表——进了注册表它就会出现在
    // 面板自己的搜索结果里,而 cmd-no-orphan 又只认 runCommand 的 case,两条约束在此合流
    t('menu-footer-wired', /ipcMain\.on\('m:action'[\s\S]{0,600}?if \(id === 'open-palette'\) \{ showPalette\(\); return; \}/.test(main)
      && !cmds.list.some((c) => c.id === 'open-palette')
      && !main.includes("case 'open-palette':"));
    const bad = ck.filter((s) => s.endsWith(':FAIL'));
    d.log(`UITEST menu-tree ${bad.length ? 'FAIL' : 'PASS'} ${ck.join(' ')}`);
  }, 2603, 'menu-tree-static');
  // ⓠ 通知宿主静态契约(阶段 1 X1):"不抢焦点 / 不挡点击"是这一批唯一的硬约束,
  //    而它们全靠两行 API 成立(focusable:false + setIgnoreMouseEvents)——删掉任何一行,
  //    运行时都不会报错,只会表现为"鼠标划过 toast 区域时,下方内容突然点不动了"。
  uiStep(() => {
    const ck = [];
    const t = (name, cond) => ck.push(`${name}:${cond ? 'ok' : 'FAIL'}`);
    const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
    const main = read('main.js');
    const html = read('toast.html');
    const pre = read('toast-preload.js');
    const css = read('ui.css');
    const status = read('status.html');
    const files = JSON.parse(read('package.json')).build.files;
    t('toast-focusable', /focusable:\s*false/.test(main));
    t('toast-ignoremouse', /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(main));
    t('toast-lazy', /function ensureToastWindow\(/.test(main) && /function destroyToastWindow\(/.test(main));
    t('toast-ipc', ['nt:render', 'nt:hover', 'nt:action', 'nt:close', 'nt:height']
      .every((c) => main.includes(`'${c}'`) && pre.includes(`'${c}'`)));
    // trustedEvent 是每个新 IPC handler 的准入门槛(方案 §10 质量门槛),四个回程通道一个都不能漏
    t('toast-trusted', (main.match(/ipcMain\.on\('nt:[a-z]+',?\s*\(e[^)]*\)\s*=>\s*\{\s*\n\s*if \(!trustedEvent\(e\)/g) || []).length === 4);
    // 通知出口唯一:旧 notifyToast 若复活,说明有一条反馈绕开了路由裁决
    t('toast-single-entry', /function notify\(text, opts\)/.test(main) && !/notifyToast\s*\(/.test(main));
    // 常量与方案 5.4 一致:360 宽 / 最多 3 条 / 默认 2200ms
    t('toast-consts', /TOAST_W = 360/.test(main) && /TOAST_MAX = 3/.test(main) && /TOAST_DWELL_MS = 2200/.test(main));
    // 页面 ↔ 共享层 ↔ 打包白名单(新增文件漏进 build.files 在开发期完全无感,装机才炸)
    const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
    t('toast-page-deps', srcs.includes('ui-theme.js') && srcs.includes('ui-icons.js') && html.includes('class="toast-host"'));
    t('toast-css', ['.toast-host', '.titem', '.tico', '.ttext', '.tact', '.tclose'].every((c) => css.includes(c)));
    t('toast-icons', /const toast = \{/.test(read('ui-icons.js')));
    t('toast-packed', files.includes('toast.html') && files.includes('toast-preload.js'));
    // 状态窗必须已卸下 toast 职责:ephemeral 若残留,孤儿提示会重新落进任务列表
    t('toast-status-retired', !/ephemeral/.test(status));
    const bad = ck.filter((s) => s.endsWith(':FAIL'));
    d.log(`UITEST toast ${bad.length ? 'FAIL' : 'PASS'} ${ck.join(' ')}`);
  }, 2587, 'toast-static');
  // ⓠ 首次收起演示静态契约(S3):把手的可发现性问题靠"演示一次"解决,而演示只做一次
  //    靠配置项记忆。两类静默故障:配置键写错(每次都演示,变成每次收起都闪一下)、
  //    呼吸动画被 reduced-motion 分支漏掉(动效偏好被无视)。
  uiStep(() => {
    const ck = [];
    const t = (name, cond) => ck.push(`${name}:${cond ? 'ok' : 'FAIL'}`);
    const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
    const main = read('main.js');
    const rv = read('reveal-tab.html');
    const pre = read('titlebar-preload.js');
    t('s3-const', /const HANDLE_HINT_MS = 3000;/.test(main));
    t('s3-state', /function beginHandleHint\(/.test(main) && /function endHandleHint\(/.test(main));
    // 配置项记忆:没有它就会每次收起都演示
    t('s3-once', /handleHintShown/.test(main) && /if \(!cfg\.handleHintShown\) \{ cfg\.handleHintShown = true; saveConfig\(cfg\); \}/.test(main));
    // 首次收起才演示:由 startHandlePolling 读配置裁决
    t('s3-gate', /if \(!loadConfig\(\)\.handleHintShown\) beginHandleHint\(\);/.test(main));
    // 演示期间轮询必须让位,否则鼠标一移开就被 80ms 轮询收走,3s 驻留走不完
    t('s3-poll-yield', /if \(handleHintActive\) return;/.test(main));
    t('s3-channel', main.includes("'tb:handle-hint'") && /onHandleHint:/.test(pre));
    t('s3-renderer', /body\.hint \{ animation: breathe/.test(rv) && /@keyframes breathe/.test(rv));
    t('s3-reduced-motion', /@media \(prefers-reduced-motion: reduce\) \{ body, body\.hint \{ animation: none; \} \}/.test(rv));
    t('s3-renderer-hook', /onHandleHint\?\.\(\(on\) => document\.body\.classList\.toggle\('hint', !!on\)\)/.test(rv));
    const bad = ck.filter((s) => s.endsWith(':FAIL'));
    d.log(`UITEST s3 ${bad.length ? 'FAIL' : 'PASS'} ${ck.join(' ')}`);
  }, 2594, 's3-static');
  uiStep(() => readDom(d.titlebarView, `(()=>{
    const c = document.getElementById('cluster');
    const dot = (document.getElementById('svcDot') || {}).className || '';
    const svc = (dot.split(' ')[1] || '');
    const theme = document.getElementById('themeBtn');
    const tl = theme ? (theme.getAttribute('aria-label') || '') : '';
    const ws = document.getElementById('workspace');
    const wl = ws ? (ws.getAttribute('aria-label') || '') : '';
    const problems = [];
    if (!c || c.children.length !== 4) problems.push('簇子项=' + (c ? c.children.length : 'none'));
    if (!['ok','boot','err'].includes(svc)) problems.push('服务点=' + dot);
    if (svc !== '${d.trayState}') problems.push('服务点与托盘态不符 ' + svc + '≠${d.trayState}');
    if (!tl.startsWith('外观:')) problems.push('主题提示=' + tl);
    if (tl.includes('menu.')) problems.push('主题提示回退成裸键:' + tl);
    if (!wl || wl.includes('cmdbar.')) problems.push('工作目录标签=' + wl);
    return problems.length ? 'FAIL ' + problems.join(' ;') : 'PASS svc=' + svc + ' theme="' + tl + '" ws="' + wl + '"';
  })()`, 'cmdbar-dom'), 2650);
  // ⑩ 托盘状态(P0-3):tooltip 必须跟随运行态且含工作目录(不依赖启动耗时,慢启动下也稳定)
  uiStep(() => {
    const t = d.trayStatusText();
    const want = { ok: '运行中', boot: '启动中', err: '已停止' }[d.trayState];
    const ok = !!want && t.includes(want) && t.includes('D:\\Work');
    d.log(`UITEST tray-status state=${d.trayState} tip="${t}" → ${ok ? 'PASS' : 'FAIL'}`);
  }, 2600, 'tray-status');
  // ⑪ 命令面板运行时(阶段 2):开 → 结构 → 筛选 → Esc 关。窗口在 3500 会被状态窗抢焦点,
  //    而面板是"失焦即收起",故整段必须赶在 3500 之前跑完。
  uiStep(() => {
    d.showPalette();
    const b = d.paletteView?.getBounds();
    const want = d.PALETTE_W + d.PALETTE_MARGIN * 2;
    d.log(`UITEST palette-open w=${b?.width}(期望 ${want}) → ${b && b.width === want ? 'PASS' : 'FAIL'}`);
  }, 3100, 'palette-open');
  uiStep(() => readDom(d.paletteView, `(()=>{
    const p = document.getElementById('pal');
    const q = document.getElementById('q');
    const list = document.getElementById('plist');
    const rows = list.querySelectorAll('.prow');
    const ad = q.getAttribute('aria-activedescendant');
    const sel = list.querySelector('.prow.sel');
    const focusOk = document.activeElement === q;
    const ok = p.getAttribute('role') === 'dialog'
      && q.getAttribute('role') === 'combobox'
      && q.getAttribute('aria-controls') === 'plist'
      && list.getAttribute('role') === 'listbox'
      && rows.length === ${d.PALETTE_MAX_ROWS}
      && ad && sel && sel.id === ad
      && focusOk;
    return (ok ? 'PASS' : 'FAIL') + ' rows=' + rows.length + ' ad=' + ad + ' focus=' + focusOk;
  })()`, 'palette-dom'), 3190);
  // 筛选:子序列匹配(『工录』跨字命中『工作目录』),结果必须收窄;空查询时按 MAX_ROWS 截断
  uiStep(() => readDom(d.paletteView, `(()=>{
    const q = document.getElementById('q');
    q.value = '工录';
    q.dispatchEvent(new Event('input'));
    const rows = [...document.querySelectorAll('.prow')];
    const labels = rows.map((r) => r.querySelector('.plbl').textContent);
    const ok = rows.length >= 1 && rows.length < ${d.PALETTE_MAX_ROWS} && labels.some((l) => l.includes('工作目录'));
    return (ok ? 'PASS' : 'FAIL') + ' n=' + rows.length + ' ' + labels.join('|');
  })()`, 'palette-filter'), 3300);
  // Esc 关窗:面板是把焦点交还 dsh 页面的(否则关掉后打字没反应)
  uiStep(() => {
    d.paletteView?.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))').catch(() => {});
    setTimeout(() => {
      const still = d.paletteOpen();
      d.log(`UITEST palette-closed open=${still}(期望 false) → ${!still ? 'PASS' : 'FAIL'}`);
    }, 300);
  }, 3400, 'palette-esc');
  uiStep(() => { d.showStatus({ mode: 'check', title: '正在检查更新…', detail: '当前 v0.0.0', spin: true }); hookWin(d.statusWin, 'status'); }, 3500, 'status-show');
  // 命令栏任务徽标必须跟随真实任务数(阶段 1 S1 出口标准:有任务在跑时徽标数字正确)
  uiStep(() => readDom(d.titlebarView, `(()=>{
    const tb = document.getElementById('taskBtn'), n = document.getElementById('taskN');
    const shown = !!tb && !tb.hidden;
    const num = n ? n.textContent : '';
    const label = tb ? (tb.getAttribute('aria-label') || '') : '';
    return (shown && /^\\d+$/.test(num) && label.includes(num))
      ? 'PASS 徽标=' + num + ' label="' + label + '"'
      : 'FAIL shown=' + shown + ' n=' + num + ' label=' + label;
  })()`, 'cmdbar-badge'), 3700);
  // 阶段 1 出口标准:窗口收进后台再回来,徽标数字必须仍然正确。
  // 徽标由 pushTitlebarStatus 从 refreshTray 推出,与主窗前后台无关 —— 但"无关"这件事
  // 只有真收一次才能证明;顺带覆盖 minimize/restore 往返后 titlebar 视图未被重载丢失状态。
  uiStep(() => { d.mainWindow.minimize(); }, 3800, 'badge-min');
  uiStep(() => {
    const min = !!d.mainWindow && d.mainWindow.isMinimized();
    d.titlebarView?.webContents.executeJavaScript(
      "(()=>{const tb=document.getElementById('taskBtn'),n=document.getElementById('taskN');return (tb&&!tb.hidden&&n)?n.textContent:'none'})()"
    ).then((v) => d.log(`UITEST badge-minimized minimized=${min} badge=${v}(期望 true/1) → ${min && v === '1' ? 'PASS' : 'FAIL'}`))
      .catch((e) => d.log(`UITEST badge-minimized ✗ ${e.message}`));
  }, 3900, 'badge-minimized');
  uiStep(() => { d.showMainWindow(); }, 4020, 'badge-restore');
  uiStep(() => {
    const back = !!d.mainWindow && !d.mainWindow.isMinimized() && d.mainWindow.isVisible();
    d.titlebarView?.webContents.executeJavaScript(
      "(()=>{const tb=document.getElementById('taskBtn'),n=document.getElementById('taskN');return (tb&&!tb.hidden&&n)?n.textContent:'none'})()"
    ).then((v) => d.log(`UITEST badge-restored visible=${back} badge=${v}(期望 true/1) → ${back && v === '1' ? 'PASS' : 'FAIL'}`))
      .catch((e) => d.log(`UITEST badge-restored ✗ ${e.message}`));
  }, 4120, 'badge-restored');
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
  // ⑮ 首次收起演示(S3 阶段 1):把手自己浮出、呼吸 3s 后隐去,并把"已演示"落盘(只做一次)。
  //    用非动画路径收起(toggleTitlebar(false,false)):动画有 240ms,提示的开始时刻会随帧率漂移,
  //    断言窗口就不好卡;这条路径此前无覆盖,顺带补上。
  //    旗标先清空再测、测完还原 —— 否则第二次运行永远走不到"首次"分支。
  const s3Orig = d.loadConfig().handleHintShown;
  uiStep(() => {
    const cfg = d.loadConfig();
    delete cfg.handleHintShown;
    d.saveConfig(cfg);
  }, 9710, 's3-arm');
  uiStep(() => d.toggleTitlebar(false, false), 9760, 's3-collapse');
  uiStep(() => {
    const w = d.revealTabView ? d.revealTabView.getBounds().width : 0;
    const flag = !!d.loadConfig().handleHintShown;
    const ok = d.handleHintActive === true && w === d.HANDLE_W && !flag;
    d.log(`UITEST s3-hint-on active=${d.handleHintActive} w=${w}(期望 ${d.HANDLE_W}) flag=${flag}(期望 false) → ${ok ? 'PASS' : 'FAIL'}`);
  }, 9900, 's3-hint-on');
  // 3s 驻留到期(9760 + 3000 ≈ 12760):把手收走 + 旗标落盘。此处不再检查 revealTabView 是否销毁
  // —— 展开态才销毁,收起态本就该留着(下次悬停还要用)
  uiStep(() => {
    const w = d.revealTabView ? d.revealTabView.getBounds().width : 0;
    const flag = !!d.loadConfig().handleHintShown;
    const ok = d.handleHintActive === false && w === 0 && flag;
    d.log(`UITEST s3-hint-off active=${d.handleHintActive} w=${w}(期望 0) flag=${flag}(期望 true,已落盘) → ${ok ? 'PASS' : 'FAIL'}`);
  }, 12900, 's3-hint-off');
  uiStep(() => d.toggleTitlebar(true, false), 12920, 's3-restore');
  uiStep(() => {
    const cfg = d.loadConfig();
    if (s3Orig === undefined) delete cfg.handleHintShown; else cfg.handleHintShown = s3Orig;
    d.saveConfig(cfg);
  }, 12950, 's3-flag-restore');
  // ③ 对话框队列化(P2-1):D1 在屏期间调 D2 → D2 入队不顶掉;D1 回程后接续展示 D2
  uiStep(() => { d.showDialog({ type: 'info', title: 'D1', message: '第一个对话框', buttons: [{ label: '好', primary: true }] }); hookWin(d.dialogWin, 'dialog'); }, 10200, 'd1');
  // P0-7:dialog 打开即聚焦主按钮(键盘 Enter 直达,与状态窗结果视图一致)
  uiStep(() => readDom(d.dialogWin, '(()=>{const ae=document.activeElement;return (ae&&ae.classList.contains("primary")&&ae.closest("#foot"))?"PASS focus=主按钮":"FAIL ae="+(ae?ae.className:"none")})()', 'd1-focus'), 10500);
  // 阶段 0 修复 X3:对话框必须是真模态(parent + modal),此前只有 parent(仅置顶不阻断输入),
  // 而渲染层一直声明 aria-modal="true" —— 声明与事实不符。mainEnabled 一并打出:模态期间
  // 主窗应被平台禁用;该值同时是 dialog-unmodal 断言的基线。
  uiStep(() => d.log(`UITEST dialog-modal isModal=${d.dialogWin?.isModal?.()}(期望 true) → ${d.dialogWin?.isModal?.() === true ? 'PASS' : 'FAIL'} mainEnabled=${d.mainWindow?.isEnabled?.()}`), 10650, 'dialog-modal');
  uiStep(() => d.showDialog({ type: 'warning', title: 'D2', message: '第二个对话框(排队)', buttons: [{ label: '好', primary: true }] }), 10800, 'd2');
  uiStep(() => readDom(d.dialogWin, '(()=>{const t=document.getElementById("title").textContent;return t==="D1"?"PASS D2已入队不顶掉在屏D1":"FAIL 在屏="+t})()', 'd2-queued'), 11100);
  uiStep(() => { d.dialogWin?.webContents.executeJavaScript('document.querySelector("#foot button").click()').catch(() => {}); }, 11250, 'd1-choose');
  uiStep(() => readDom(d.dialogWin, '(()=>{const t=document.getElementById("title").textContent;return t==="D2"?"PASS 接续展示D2":"FAIL 在屏="+t})()', 'd2-next'), 11550);
  // v0.6.1 Acrylic 铺开:dialog 的 .win.acrylic 类必须与 Win11 判定一致
  uiStep(() => { const want = d.isWin11(); readDom(d.dialogWin, `(()=>{const m=document.querySelector(".win").classList.contains("acrylic");return (m===${want})?"PASS acrylic="+m:"FAIL acrylic="+m+" want=${want}"})()`, 'dialog-acrylic'); }, 11620);
  uiStep(() => { d.dialogWin?.webContents.executeJavaScript('document.querySelector("#foot button").click()').catch(() => {}); }, 11700, 'd2-choose');
  // 阶段 0 修复 X3 配套:对话框走「隐藏复用」而非销毁,modal 子窗在平台上解除父窗禁用的
  // 时机不一,主进程已显式 releaseDialogModal 兜底。本断言防的正是"对话框关掉、主窗永久点不动"
  // 这类不可自愈状态(禁用则本项 FAIL)。
  uiStep(() => d.log(`UITEST dialog-unmodal mainEnabled=${d.mainWindow?.isEnabled?.()}(期望 true) → ${d.mainWindow?.isEnabled?.() === true ? 'PASS' : 'FAIL'}`), 11750, 'dialog-unmodal');
  // ④ 报告窗复用(启动失败自动弹出后,再次 showReport 仍要更新内容)
  uiStep(() => d.showReport({ phase: 'boot', error: new Error('等待 dsh web 输出服务地址超时(90s)'), code: null, buf: '[i] dsh web: 正在启动…', actions: [{ id: 'retry', label: '重试', style: 'primary' }] }), 11800, 'report2');
  // P2-3 Mica 试点:reportWin 的 .win.mica 类必须与 Win11 判定一致(Win10 回落实色)
  uiStep(() => {
    const want = d.isWin11();
    readDom(d.reportWin, `(()=>{const m=document.querySelector(".win").classList.contains("mica");return (m===${want})?"PASS mica="+m:"FAIL mica="+m+" want=${want}"})()`, 'mica-flag');
  }, 12050);
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
  // v0.6.3 服务页挂载断言: 若已在 http 服务页, 必须真实挂载(bodyLen>500), 不得是 431/空文档空白
  // (桌面端空白而浏览器正常的回归锁);若仍在 file:// 启动页(慢启动), 容忍跳过
  uiStep(() => readDom(d.dshView, '(()=>{const h=location.href;const bl=document.body?document.body.innerHTML.length:0;if(h.startsWith("file:"))return "PASS 尚在启动页(容忍)";return bl>500?"PASS 服务页已挂载 bodyLen="+bl:"FAIL 服务页空白 bodyLen="+bl+" href="+h.slice(0,60)})()', 'svc-mount'), 9500);
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
  // ⑪ 任务中心(P1-1):双流任务并存列表化 + 行级取消不误伤另一流(瞬时提示已改由 X1 通知宿主承载)
  uiStep(() => { d.showStatus({ mode: 'download', title: '正在下载 v9.9.9…', detail: '当前 v0.0.0', pct: '0%', size: '', __origin: 'desktop' }); }, 23450, 'tc-dl');
  uiStep(() => { d.showStatus({ mode: 'install', title: '正在安装 dsh 本体 v9.9.9…', detail: 'npm install -g', spin: true, __origin: 'dsh' }); }, 23600, 'tc-install');
  uiStep(() => readDom(d.statusWin, '(()=>{const rows=[...document.querySelectorAll("#tlist .trow")];const act=rows.filter(r=>!r.classList.contains("done")).length;const t=document.getElementById("title").textContent;return (rows.length===2&&act===2&&t.includes("2 项进行中"))?"PASS":"FAIL rows="+rows.length+" act="+act+" t="+t})()', 'tc-list'), 23950);
  uiStep(() => { const h = d.statusWin?.getContentSize()[1] || 0; d.log(`UITEST tc-h=${h}(期望 >186 列表加高) → ${h > 186 ? 'PASS' : 'FAIL'}`); }, 24000, 'tc-h');
  // v0.6.1 Acrylic 铺开:status 窗的 .win.acrylic 类必须与 Win11 判定一致
  uiStep(() => { const want = d.isWin11(); readDom(d.statusWin, `(()=>{const m=document.querySelector(".win").classList.contains("acrylic");return (m===${want})?"PASS acrylic="+m:"FAIL acrylic="+m+" want=${want}"})()`, 'status-acrylic'); }, 24100);
  // P1-1 实测式高度校准:渲染回报后窗口高度应与真实内容高度贴合(差 ≤14px,含主进程 8px 容差)
  uiStep(() => readDom(d.statusWin, '(()=>{const l=document.querySelector(".tlist");const cs=getComputedStyle(l);const gap=parseFloat(cs.rowGap)||0;const pad=parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom);const seq=[];for(const k of l.children){if(getComputedStyle(k).display==="contents"){seq.push(...k.children)}else seq.push(k)}let h=pad;seq.forEach((k,i)=>{h+=k.getBoundingClientRect().height;if(i>0)h+=gap});const natural=h+document.querySelector(".win-head").getBoundingClientRect().height+2;const diff=Math.abs(innerHeight-natural);return (diff<=14)?"PASS 实测贴合 natural="+Math.round(natural)+" win="+innerHeight:"FAIL diff="+Math.round(diff)+" natural="+Math.round(natural)+" win="+innerHeight})()', 'tc-fit'), 24150);
  // 行级取消 dsh 任务:desktop 下载任务必须不受影响(旧单槽模型无法表达,互斥链已删)
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('[...document.querySelectorAll("#tlist .trow:not(.done) .lx")][1].click()').catch(() => {}); }, 24200, 'tc-cancel-one');
  uiStep(() => readDom(d.statusWin, '(()=>{const ts=[...document.querySelectorAll("#tlist .trow .ltitle")].map(e=>e.textContent);const hasDl=ts.some(s=>s.includes("下载"));const hasDsh=ts.some(s=>s.includes("dsh 本体"));return (hasDl&&!hasDsh)?"PASS":"FAIL "+ts.join("|")})()', 'tc-narrow'), 24500);
  uiStep(() => { d.statusWin?.webContents.executeJavaScript('document.getElementById("xBtn").click()').catch(() => {}); }, 24700, 'tc-close');
  uiStep(() => d.log(`UITEST tc-close win=${!!d.statusWin}(期望 false) → ${!d.statusWin ? 'PASS' : 'FAIL'}`), 24900, 'tc-close-verify');
  // ⑪' 通知宿主(阶段 1 X1):状态窗已卸下 toast 职责,瞬时提示改由独立的透明窗承载。
  //     这一组把三件事一起锁住:①窗口按需创建且条目渲染正确;②悬停真的延长了驻留
  //     (600ms 的条目在 650ms 后仍活着 ⇒ forward:true 的鼠标事件确实到达了渲染层);
  //     ③队列清空即收窗,不留常驻渲染进程(约束 8)。
  uiStep(() => { d.notify('仅一条瞬时提示', { ms: 600 }); }, 24950, 'toast-add');
  uiStep(() => {
    const ok = !!d.toastWin && d.toastItems.length === 1 && !d.notifyErrPending;
    d.log(`UITEST toast-window win=${!!d.toastWin} items=${d.toastItems.length} errPending=${d.notifyErrPending}(期望 true/1/false) → ${ok ? 'PASS' : 'FAIL'}`);
  }, 25150, 'toast-window');
  uiStep(() => readDom(d.toastWin, '(()=>{const rows=[...document.querySelectorAll(".titem")];const r=rows[0];const txt=r?r.querySelector(".ttext").textContent:"";const tone=r?r.dataset.tone:"";return (rows.length===1&&txt==="仅一条瞬时提示"&&tone==="info"&&r.getAttribute("role")==="status")?"PASS tone="+tone:"FAIL rows="+rows.length+" txt="+txt+" tone="+tone+" role="+(r&&r.getAttribute("role"))})()', 'toast-dom'), 25300);
  uiStep(() => { d.toastWin?.webContents.executeJavaScript("document.querySelector(\'.titem\').dispatchEvent(new MouseEvent(\'mouseenter\'))").catch(() => {}); }, 25450, 'toast-hover');
  // 650ms > 600ms:计时若未被悬停暂停,此刻条目早已消失、窗口已销毁 —— 一条断言同时验证两件事
  uiStep(() => {
    const it = d.toastItems[0];
    const ok = !!it && it.hovered === true && !!d.toastWin;
    d.log(`UITEST toast-hover-pause hovered=${!!(it && it.hovered)} win=${!!d.toastWin}(期望 true/true,即悬停已暂停计时) → ${ok ? 'PASS' : 'FAIL'}`);
  }, 25650, 'toast-hover-verify');
  uiStep(() => {
    d.destroyToastWindow();
    const ok = !d.toastWin && d.toastItems.length === 0;
    d.log(`UITEST toast-destroy win=${!!d.toastWin} items=${d.toastItems.length}(期望 false/0) → ${ok ? 'PASS' : 'FAIL'}`);
  }, 25750, 'toast-destroy');
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
  // 分组树结构(v0.7.13):组数 = 注册表分组数、每组都有可访问名且真的装着条目、
  // 小标题一行都没混进可交互行、末尾那行必须是「所有命令…」且确实是 menuitem(点得动)
  const grpN = require('./commands').groups.length;
  uiStep(() => readDom(d.menuPopupView, `(()=>{const p=document.getElementById("panel");const gs=p.querySelectorAll("[role=group]");const secs=p.querySelectorAll(".sec");const bad=[...gs].filter(g=>!g.getAttribute("aria-label")||!g.querySelector("[role=menuitem],[role=menuitemcheckbox]")).length;const rows=[...p.querySelectorAll(".item")];const last=rows[rows.length-1];const okTail=!!last&&last.getAttribute("role")==="menuitem"&&last.textContent.includes("所有命令");const leak=p.querySelectorAll(".sec.item,.sec[role=menuitem],.sec[role=menuitemcheckbox]").length;return (gs.length===${grpN}&&secs.length===${grpN}&&bad===0&&okTail&&leak===0)?"PASS groups="+gs.length+" sec="+secs.length+" tail="+last.textContent.trim().slice(0,10):"FAIL groups="+gs.length+" sec="+secs.length+" bad="+bad+" leak="+leak+" tail="+(last?last.textContent.trim().slice(0,12):"none")})()`, 'a11y-menu-tree'), 26600);
  uiStep(() => readDom(d.menuPopupView, '(()=>{const p=document.getElementById("panel");const items=p.querySelectorAll("[role=menuitem],[role=menuitemcheckbox]").length;const chk=p.querySelectorAll("[role=menuitemcheckbox][aria-checked=true]").length;const sep=p.querySelectorAll("[role=separator]").length;return (p.getAttribute("role")==="menu"&&items>=10&&chk>=1&&sep>=1)?"PASS items="+items+" chk="+chk+" sep="+sep:"FAIL role="+p.getAttribute("role")+" items="+items+" chk="+chk+" sep="+sep})()', 'a11y-roles'), 26700);
  uiStep(() => readDom(d.menuPopupView, '(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown"}));document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown"}));const ad=document.getElementById("panel").getAttribute("aria-activedescendant");const sel=document.querySelector(".item.sel");return (ad&&sel&&sel.id===ad)?"PASS activedescendant="+ad:"FAIL ad="+ad+" sel="+(sel&&sel.id)})()', 'a11y-arrownav'), 27000);
  uiStep(() => readDom(d.menuPopupView, '(()=>{const before=document.querySelector(".item.sel");document.dispatchEvent(new KeyboardEvent("keydown",{key:"重"}));const after=document.querySelector(".item.sel");return (after&&after!==before&&after.textContent.includes("重"))?"PASS → "+after.textContent.trim().slice(0,10):"FAIL before="+(before&&before.textContent.trim().slice(0,10))+" after="+(after&&after.textContent.trim().slice(0,10))})()', 'a11y-typeahead'), 27300);
  uiStep(() => { d.menuPopupView?.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))').catch(() => {}); }, 27600, 'a11y-esc');
  uiStep(() => d.log(`UITEST a11y-closed win=${!!d.menuPopupView}(期望 false) → ${!d.menuPopupView ? 'PASS' : 'FAIL'}`), 27900, 'a11y-closed-verify');
  // ⑫ 外观主题(P1-2):菜单项存在 → 点击循环(auto→dark→light→auto) → config/themeSource 映射
  //    → 渲染层 data-theme + 令牌覆写 + 鲸鱼 logo 黑白换版;结束恢复原配置
  const theme0 = d.loadConfig().theme;
  // v0.6.3 轮询化:真实 dsh SPA 首载与菜单弹层首载会争抢资源,固定间隙的点击/断言可能落空——
  // 全部改为轮询等待(每 350ms 一次,最多 10 次),落空重试而非失败
  const pollFor = async (fn, times = 10, gap = 350) => {
    for (let i = 0; i < times; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, gap));
    }
    return null;
  };
  const clickThemeItem = (win) => pollFor(() => win?.webContents.executeJavaScript(
    '(()=>{const it=[...document.querySelectorAll(".item .lbl")].find(e=>e.textContent.startsWith("外观:"));if(!it)return null;const label=it.textContent.trim();it.parentElement.click();return label})()'
  ).catch(() => null));
  const domPoll = (win, expr) => pollFor(() => win?.webContents.executeJavaScript(expr)
    .then((v) => (String(v).startsWith('PASS') ? v : null)).catch(() => null));
  uiStep(() => { d.showMenuPopup(); }, 28200, 'theme-menu-open');
  uiStep(async () => {
    const label = await clickThemeItem(d.menuPopupView);
    if (!label) { d.log('UITEST theme-1 FAIL no-item'); return; }
    const ok = await pollFor(() => d.loadConfig().theme === 'dark' && d.getThemeSource() === 'dark');
    d.log(`UITEST theme-1 auto→dark clicked="${label}" → ${ok ? 'PASS' : 'FAIL'}`);
  }, 28400, 'theme-1');
  uiStep(() => { d.showMenuPopup(); }, 29600, 'theme-menu-open2');
  // P2-5:主题采样事件化——dsh 页面应已注入 MutationObserver 钩子(did-finish-load/did-navigate 重注)
  uiStep(async () => {
    const hook = await domPoll(d.dshView, 'window.__dshThemeHook === true ? "PASS" : "FAIL"');
    d.log(`UITEST theme-hook ${hook || 'FAIL 超时'}`);
    const label = await clickThemeItem(d.menuPopupView);
    if (!label) { d.log('UITEST theme-2 FAIL no-item'); return; }
    const ok = await pollFor(() => d.loadConfig().theme === 'light' && d.getThemeSource() === 'light');
    d.log(`UITEST theme-2 dark→light clicked="${label}" → ${ok ? 'PASS' : 'FAIL'}`);
    // 已开窗的渲染器应实时换肤(reportWin 自 11.8s 起一直开着,未重建)
    const dom = await domPoll(d.reportWin,
      `(()=>{const attr=document.documentElement.getAttribute("data-theme");const bg0=getComputedStyle(document.documentElement).getPropertyValue("--c-bg0").trim();const logo=document.querySelector(".logo").src;return (attr==="light"&&bg0==="#ffffff"&&logo.includes("whale-black"))?"PASS attr="+attr+" bg0="+bg0:"FAIL attr="+attr+" bg0="+bg0+" logo="+logo})()`);
    d.log(`UITEST dom theme-light-dom ${dom || 'FAIL 超时'}`);
  }, 29800, 'theme-2');
  uiStep(() => { d.showMenuPopup(); }, 31200, 'theme-menu-open3');
  uiStep(async () => {
    const label = await clickThemeItem(d.menuPopupView);
    if (!label) { d.log('UITEST theme-3 FAIL no-item'); return; }
    const ok = await pollFor(() => d.loadConfig().theme === 'auto' && d.getThemeSource() === 'system');
    d.log(`UITEST theme-3 light→auto clicked="${label}" → ${ok ? 'PASS' : 'FAIL'}`);
    // 回到 auto:渲染层 data-theme 应与系统 prefers-color-scheme 自洽(测试机系统主题未知,断言一致性而非具体值)
    const dom = await domPoll(d.reportWin,
      `(()=>{const attr=document.documentElement.getAttribute("data-theme")||"";const want=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"";return (attr===want)?"PASS attr="+attr:"FAIL attr="+attr+" want="+want})()`);
    d.log(`UITEST dom theme-auto-dom ${dom || 'FAIL 超时'}`);
  }, 31400, 'theme-3');
  uiStep(() => { d.reportWin?.webContents.executeJavaScript('document.getElementById("xBtn").click()').catch(() => {}); }, 32700, 'theme-report-close');
  uiStep(() => d.log(`UITEST theme-report-closed win=${!!d.reportWin}(期望 false) → ${!d.reportWin ? 'PASS' : 'FAIL'}`), 32950, 'theme-report-close-verify');
  // ⑬ 首启欢迎页(P1-6):窗口创建/文案/按钮/桥接齐备;abortWelcome 吞掉 resolve 不触发退出分支
  uiStep(() => { d.showWelcome(); }, 33100, 'welcome-open');
  uiStep(() => readDom(d.welcomeWin, '(()=>{const c=document.getElementById("wlChoose");const q=document.getElementById("wlQuit");const h=document.body.textContent;const bridge=typeof window.__welcome==="object"&&typeof window.__welcome.choose==="function";const ok=!!c&&!!q&&h.includes("欢迎使用 DSH Desktop")&&h.includes("收进系统托盘")&&h.includes("会话、文件、设置、插件")&&bridge;return ok?"PASS 欢迎页齐备":"FAIL choose="+!!c+" quit="+!!q+" bridge="+bridge})()', 'welcome-dom'), 33700);
  // WEL-2 验证项:欢迎页首帧焦点应落在「选择工作目录」(脚本解析期 focus() 在 show() 前执行,
  // 隐藏窗口期可能不生效);若此断言持续 FAIL,需在主进程 show() 后补发聚焦
  uiStep(() => readDom(d.welcomeWin, '(()=>{const ae=document.activeElement;return (ae&&ae.id==="wlChoose")?"PASS focus=选择按钮":"FAIL ae="+((ae&&ae.id)||ae.tagName)})()', 'welcome-focus'), 33800);
  uiStep(() => { d.abortWelcome(); }, 33900, 'welcome-abort');
  uiStep(() => d.log(`UITEST welcome-closed win=${!!d.welcomeWin}(期望 false) → ${!d.welcomeWin ? 'PASS' : 'FAIL'}`), 34100, 'welcome-closed-verify');
  // ⑭ 快捷键速查(P2-2):菜单「键盘快捷键…」→ 速查对话框,内容与菜单 accel 同源(shortcuts.js)
  uiStep(() => { d.showMenuPopup(); }, 34250, 'sc-menu-open');
  uiStep(() => d.menuPopupView?.webContents.executeJavaScript('(()=>{const it=[...document.querySelectorAll(".item .lbl")].find(e=>e.textContent.startsWith("键盘快捷键"));if(!it)return "FAIL no-item";it.parentElement.click();return "ok"})()')
    .then((v) => d.log(`UITEST sc-click ${v}`)).catch((e) => d.log(`UITEST sc-click ✗ ${e.message}`)), 34450, 'sc-click');
  uiStep(() => readDom(d.dialogWin, '(()=>{const t=document.getElementById("title").textContent;const det=document.getElementById("detail").textContent;return (t==="键盘快捷键"&&det.includes("Ctrl+O")&&det.includes("F11")&&det.includes("Ctrl+Shift+B"))?"PASS 速查内容同源":"FAIL t="+t+" det="+det.slice(0,40)})()', 'sc-dom'), 34700);
  uiStep(() => { d.dialogWin?.webContents.executeJavaScript('document.querySelector("#foot button").click()').catch(() => {}); }, 34850, 'sc-close');
  uiStep(() => { const ok = d.dialogWin && !d.dialogWin.isVisible(); d.log(`UITEST sc-closed hidden=${d.dialogWin ? !d.dialogWin.isVisible() : 'win-gone'}(期望 true) → ${ok ? 'PASS' : 'FAIL'}`); }, 35050, 'sc-closed-verify');
  // ⑪''' 错误级通知(阶段 1 X1 路由 ③):必须常驻、带动作按钮、并点亮托盘红角标,
  //        直到用户处理——"更新失败"不能像"已复制"那样 2.2 秒自己消失。
  //        动作点击后条目、队列与角标要同时复位(否则红点永远亮着,用户再也分不清真假)。
  let errActFired = false;
  uiStep(() => { d.notify('更新失败:测试用提示', { tone: 'err', action: { label: '查看详情', run: () => { errActFired = true; } } }); }, 35100, 'toast-err-add');
  uiStep(() => {
    d.log(`UITEST toast-err-flag errPending=${d.notifyErrPending}(期望 true) → ${d.notifyErrPending ? 'PASS' : 'FAIL'}`);
    readDom(d.toastWin, '(()=>{const r=document.querySelector(".titem");const a=r&&r.querySelector(".tact");const x=r&&r.querySelector(".tclose");const t=r?r.querySelector(".ttext").textContent:"";return (!!r&&r.dataset.tone==="err"&&r.getAttribute("role")==="alert"&&!!a&&a.textContent==="查看详情"&&!!x&&t.indexOf("更新失败")===0)?"PASS 常驻+动作+关闭":"FAIL tone="+(r&&r.dataset.tone)+" act="+(a?a.textContent:"none")+" x="+!!x+" t="+t})()', 'toast-err-dom');
  }, 35250, 'toast-err-pair');
  uiStep(() => { d.toastWin?.webContents.executeJavaScript('document.querySelector(".titem .tact").click()').catch(() => {}); }, 35350, 'toast-err-click');
  uiStep(() => {
    const ok = errActFired && !d.toastWin && d.toastItems.length === 0 && d.notifyErrPending === false;
    d.log(`UITEST toast-err-verify fired=${errActFired} win=${!!d.toastWin} items=${d.toastItems.length} errPending=${d.notifyErrPending}(期望 true/false/0/false) → ${ok ? 'PASS' : 'FAIL'}`);
  }, 35470, 'toast-err-verify');
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
      const aCls = await d.accelWin.webContents.executeJavaScript('document.querySelector(".win").classList.contains("mica")');
      d.log(`UITEST accel-mica cls=${aCls} want=${d.isWin11()} → ${aCls === d.isWin11() ? 'PASS' : 'FAIL'}`);
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
  }, 35600);
}

module.exports = { runSmokeDemo, runUitest };
