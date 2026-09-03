// diagnostics.js —— 错误诊断模块(纯逻辑,不依赖 electron):
// 启动失败/进程意外退出时,收集尽可能详细的运行时状态、归类错误、生成可导出的错误报告。
// 主进程通过 ctx 传入 app/screen 等运行期对象,本模块只负责读取与文本生成。

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// ---------- 小工具 ----------

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

// 读取文件尾部(按行截断,防止超长)
function tailFile(file, lines = 200, maxBytes = 200 * 1024) {
  return safe(() => {
    if (!fs.existsSync(file)) return '';
    const stat = fs.statSync(file);
    const s = fs.readFileSync(file, 'utf8');
    const text = s.length > maxBytes ? s.slice(-maxBytes) : s;
    return text.split('\n').slice(-lines).join('\n').trim();
  }, '');
}

// 读取 JSON 文件,失败返回 null
function readJson(file) {
  return safe(() => {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }, null);
}

// 报告会被用户导出分享:dsh 服务地址带一次性 ?token= 鉴权参数,未消费前可换取会话,落盘前脱敏
function redactToken(s) {
  return String(s).replace(/([?&]token=)[^\s&]+/gi, '$1***');
}

function safeStr(v) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// ---------- 收集运行时状态 ----------

// ctx 由主进程构造:{ app, screen, phase, error, code, buf, logFile, configPath, workspace, dshBin, nodeExe, args, elapsedMs }
// 返回结构化状态对象(逐项容错,尽力而为)
function collectDiagnostics(ctx = {}) {
  const app = ctx.app;
  const out = {};

  const withApp = (fn) => { try { return app && fn(); } catch { return null; } };

  out.timestamp = new Date().toISOString();
  out.phase = ctx.phase || 'unknown';

  // 运行时与环境
  out.runtime = {
    appVersion: withApp(() => app.getVersion()) || '未知',
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node || '',
    platform: process.platform + ' ' + process.arch,
    osRelease: safeStr(os.release()),
    osType: os.type(),
    hostname: os.hostname(),
    locale: withApp(() => app.getLocale()),
    userData: withApp(() => app.getPath('userData') || app.getPath('appData')) || '',
    uptimeSec: Math.round(process.uptime()),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    cpuCount: os.cpus().length,
    totalMemGB: (os.totalmem() / 1073741824).toFixed(1),
    freeMemGB: (os.freemem() / 1073741824).toFixed(1),
  };
  if (ctx.screen) {
    out.runtime.screens = safe(() => ctx.screen.getAllDisplays().map((d) => ({ bounds: d.bounds, scale: d.scaleFactor })), null);
  }

  // 配置
  if (ctx.configPath) {
    out.config = readJson(ctx.configPath);
  }
  out.workspace = ctx.workspace || null;

  // dsh 本体
  if (ctx.dshBin) {
    const pkgPath = path.join(path.dirname(ctx.dshBin), '..', 'package.json');
    const pkg = readJson(pkgPath);
    out.dsh = {
      bin: ctx.dshBin,
      packagePath: pkgPath,
      version: (pkg && pkg.version) || '未知',
      main: (pkg && pkg.main) || null,
      exists: fs.existsSync(ctx.dshBin),
      modulesOk: safe(() => {
        const nm = path.join(path.dirname(ctx.dshBin), '..', 'node_modules');
        if (!fs.existsSync(nm)) return false;
        // 抽查头几个依赖目录是否存在;scoped 包(@scope/name)直接按完整路径检查即可
        const deps = Object.keys((pkg && pkg.dependencies) || {}).slice(0, 8);
        return deps.every((d) => fs.existsSync(path.join(nm, d)));
      }, '未知'),
    };
  }

  // 启动过程
  out.boot = {
    nodeExe: ctx.nodeExe || null,
    args: ctx.args || null,
    elapsedMs: ctx.elapsedMs != null ? ctx.elapsedMs : null,
    exitCode: ctx.code != null ? ctx.code : null,
    stdoutTail: redactToken((ctx.buf || '').slice(-4000)) || '',
  };

  // 日志
  if (ctx.logFile) {
    out.logTail = tailFile(ctx.logFile, 200);
    out.logFile = ctx.logFile;
  }
  // 崩溃记录
  if (ctx.crashFile && fs.existsSync(ctx.crashFile)) {
    out.crashTxt = safeStr(fs.readFileSync(ctx.crashFile, 'utf8')).slice(-4000);
  }

  return out;
}

// ---------- 错误归类 ----------

// 依据错误签名与阶段给出:标题 / 原因 / 建议列表
function classifyError(err, ctx = {}) {
  const msg = String((err && (err.message || err)) || '');
  const phase = ctx.phase;

  const mk = (kind, title, cause, suggestions) => ({ kind, title, cause, suggestions });

  if (phase === 'exit') {
    return mk('exit', `dsh web 进程意外退出 (code=${ctx.code})`,
      'dsh web 服务进程在运行期间退出,服务已不可用。',
      ['点击「重启 dsh」恢复服务。',
        '若反复退出,请查看下方日志尾部,关注报错前最后几行。',
        '可导出错误报告,连同日志文件一起反馈问题。']);
  }
  if (/找不到 dsh/.test(msg)) {
    return mk('missing-dsh', '未找到 dsh 本体',
      '桌面端需要全局安装的 dsh 包才能启动,当前未定位到。',
      ['执行 npm install -g @deepseek-ai/dsh 安装后重试。',
        '安装后需重启 DSH Desktop。']);
  }
  if (/ledger|already owned by process/i.test(msg)) {
    return mk('already-running', '检测到另一个 dsh 实例正在运行',
      'dsh 的任务板单实例锁已被其他进程持有,当前启动被拒绝。',
      ['退出其他正在运行的 dsh / DSH Desktop 窗口后再启动。',
        '若确认没有其他实例,可能是上次异常退出残留,重启电脑后重试。']);
  }
  // dsh 升级后最常见的启动失败:第三方插件与新版不兼容(如 0.1.2-alpha.2 移除了
  // @deepseek-ai/dsh-settings 的 settingsNamespace 导出),插件树加载失败,报错形如
  // "dsh: plugin tree failed to load: ... The requested module '@deepseek-ai/dsh-settings'
  // does not provide an export named 'settingsNamespace'"。必须排在「启动后即退出」之前,
  // 否则用户只会看到泛泛的退出提示,无从知道是哪个插件出了问题
  if (/plugin tree failed to load|failed to apply loader entry|failed to import loader entry|does not provide an export named|The requested module .* does not provide/i.test(msg)) {
    return mk('plugin-incompat', 'dsh 第三方插件与当前版本不兼容',
      'dsh 升级后,旧版第三方插件不再兼容,插件树加载失败导致 dsh web 启动即退出。',
      ['先定位下方报错中的插件名(形如 dsh-better-sidebar / @xxx/dsh-xxx):它通常装在 ~/.dsh/profiles/web 下。',
        '临时禁用:编辑 ~/.dsh/profiles/web/cordis.patch.yml,给该插件加 disabled: true。',
        '或更新到兼容版本:dsh plugin --profile web add <插件名>@latest',
        '或移除该插件:dsh plugin --profile web remove <插件名>',
        '若为官方内置插件报错,可先回退 dsh:npm install -g @deepseek-ai/dsh@0.1.1-rc.2,等官方修复后再升级。']);
  }
  if (/EPERM|EACCES|EINVAL/.test(msg)) {
    return mk('permission', '权限或占用问题',
      msg, [
        '以管理员身份重试,或检查端口是否被其他程序占用。',
        '杀毒软件/系统策略可能拦截了 node 进程,请在拦截列表放行。']);
  }
  if (/ENOENT|cannot find module|not found/i.test(msg)) {
    return mk('missing-file', 'dsh 依赖缺失或损坏',
      msg, [
        '检查全局 dsh 安装是否完整:npm ls -g @deepseek-ai/dsh',
        '可尝试重装:npm install -g @deepseek-ai/dsh --force']);
  }
  if (/输出服务地址超时/.test(msg)) {
    return mk('boot-timeout', 'dsh 启动超时(90 秒无服务地址)',
      'dsh web 未在规定时间内输出服务地址。首次启动需要联网安装依赖,可能耗时较长。',
      ['确认网络可用后重试(首次启动可能要等 1-2 分钟)。',
        '检查下方启动输出,看卡在哪一步。',
        '可尝试在终端手动运行 dsh web 观察输出。']);
  }
  if (/未就绪/.test(msg)) {
    return mk('http-timeout', 'dsh 服务未就绪(60 秒内 HTTP 不可达)',
      '进程已启动但服务端口始终无响应。',
      ['检查防火墙/代理是否拦截了 127.0.0.1 回环地址。',
        '在终端手动运行 dsh web 验证端口是否可访问。']);
  }
  if (/启动后即退出/.test(msg)) {
    return mk('early-exit', 'dsh web 启动后立即退出',
      msg.slice(0, 500),
      ['查看下方启动输出尾部与完整日志,定位具体报错。',
        '常见原因:端口被占、依赖缺失、Node 版本不兼容。']);
  }
  if (/端口|EADDRINUSE/.test(msg)) {
    return mk('port-busy', '端口被占用', msg, ['更换端口或结束占用该端口的进程后重试。']);
  }
  return mk('generic', 'dsh 启动失败',
    msg.slice(0, 600) || '未知错误',
    ['查看下方启动输出与完整日志,定位具体报错。',
      '可导出错误报告,连同日志文件一起反馈问题。']);
}

// ---------- 报告生成 ----------

function renderReport(diag, cls, ctx = {}) {
  const L = [];
  const push = (s = '') => L.push(s);
  const table = (obj) => { for (const k of Object.keys(obj || {})) push(`- **${k}**: ${safeStr(obj[k])}`); };

  push('# DSH Desktop 错误报告');
  push('');
  push(`生成时间: ${diag.timestamp || new Date().toISOString()}`);
  push(`阶段: ${diag.phase || 'unknown'}`);
  push('');
  push('## 错误归类');
  push(`- 判定: ${cls.title}`);
  push(`- 原因: ${cls.cause}`);
  push('- 建议:');
  for (const s of cls.suggestions) push(`  - ${s}`);
  push('');
  push('## 运行时环境');
  table(diag.runtime);
  push('');
  if (diag.workspace) { push('## 工作目录'); push(`- ${diag.workspace}`); push(''); }
  if (diag.config) { push('## 应用配置'); push('```json'); push(safeStr(diag.config)); push('```'); push(''); }
  if (diag.dsh) {
    push('## dsh 本体');
    table(diag.dsh);
    push('');
  }
  push('## 启动过程');
  table(diag.boot);
  push('');

  const err = ctx.error;
  if (err) {
    push('## 原始错误');
    push('```');
    push(String((err && err.stack) || err || ''));
    push('```');
    push('');
  }
  if (diag.crashTxt) {
    push('## 崩溃记录 (CRASH.txt)');
    push('```');
    push(diag.crashTxt);
    push('```');
    push('');
  }
  if (diag.logTail) {
    push('## 日志尾部 (最近 200 行)');
    push('```');
    push(diag.logTail);
    push('```');
  }
  return L.join('\n');
}

// 落盘报告,返回路径;保留最近 10 份,更早的清理(频繁报障时目录不能无限膨胀,文件名精确到秒,同一秒两次会互相覆盖)
function writeReport(text, userData) {
  const dir = path.join(userData, 'error-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const file = path.join(dir, `dsh-error-${stamp}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith('dsh-error-') && f.endsWith('.txt'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(10)) {
      try { fs.unlinkSync(path.join(dir, old.f)); } catch { /* 删除失败不影响本次报告 */ }
    }
  } catch { /* 清理失败不影响报告 */ }
  return file;
}

// 汇总入口:收集 → 归类 → 渲染 → 落盘,返回 { diag, cls, text, filePath }
function buildReport(ctx) {
  const diag = collectDiagnostics(ctx);
  const cls = classifyError(ctx.error, ctx);
  const text = renderReport(diag, cls, ctx);
  let filePath = null;
  try {
    filePath = writeReport(text, ctx.userData);
  } catch (e) {
    filePath = null; // 落盘失败不影响报告展示
  }
  return { diag, cls, text, filePath };
}

module.exports = {
  collectDiagnostics,
  classifyError,
  renderReport,
  writeReport,
  buildReport,
  tailFile,
};

// 供主进程用:contexts 仅用于测试/调试时直接运行本文件
if (require.main === module) {
  const demo = buildReport({
    app: null, phase: 'boot', error: new Error('等待 dsh web 输出服务地址超时(90s)'),
    code: null, buf: 'dsh web: 正在启动…\n[i] 安装依赖中', logFile: null, configPath: null,
    workspace: 'D:\\work', userData: require('node:os').tmpdir(),
    nodeExe: process.execPath, args: ['a', 'b'], elapsedMs: 90000,
  });
  process.stdout.write(demo.text.slice(0, 1200) + '\n');
}