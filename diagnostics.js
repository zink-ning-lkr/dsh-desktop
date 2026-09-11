// diagnostics.js —— 错误诊断模块(纯逻辑,不依赖 electron):
// 启动失败/进程意外退出时,收集尽可能详细的运行时状态、归类错误、生成可导出的错误报告。
// 主进程通过 ctx 传入 app/screen 等运行期对象,本模块只负责读取与文本生成。

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { t } = require('./i18n'); // 诊断分类文案收编(X-2 第二批)
const { redactToken } = require('./redact'); // token 脱敏单一事实源(与 core.js 共用)

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
// (实现见 redact.js,与 core.js 的日志脱敏同源)

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
    appVersion: withApp(() => app.getVersion()) || t('diag.unknown'),
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
      version: (pkg && pkg.version) || t('diag.unknown'),
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
    return mk('exit', t('diag.exitTitle', { code: ctx.code }),
      t('diag.exitCause'),
      [t('diag.exitSug1'), t('diag.exitSug2'), t('diag.exitSug3')]);
  }
  if (/找不到 dsh/.test(msg)) {
    return mk('missing-dsh', t('diag.missingDshTitle'),
      t('diag.missingDshCause'),
      [t('diag.missingDshSug1'), t('diag.missingDshSug2')]);
  }
  if (/ledger|already owned by process/i.test(msg)) {
    return mk('already-running', t('diag.alreadyRunningTitle'),
      t('diag.alreadyRunningCause'),
      [t('diag.alreadyRunningSug1'), t('diag.alreadyRunningSug2')]);
  }
  // dsh 升级后最常见的启动失败:第三方插件与新版不兼容(如 0.1.2-alpha.2 移除了
  // @deepseek-ai/dsh-settings 的 settingsNamespace 导出),插件树加载失败,报错形如
  // "dsh: plugin tree failed to load: ... The requested module '@deepseek-ai/dsh-settings'
  // does not provide an export named 'settingsNamespace'"。必须排在「启动后即退出」之前,
  // 否则用户只会看到泛泛的退出提示,无从知道是哪个插件出了问题
  if (/plugin tree failed to load|failed to apply loader entry|failed to import loader entry|does not provide an export named|The requested module .* does not provide/i.test(msg)) {
    return mk('plugin-incompat', t('diag.pluginIncompatTitle'),
      t('diag.pluginIncompatCause'),
      [t('diag.pluginIncompatSug1'), t('diag.pluginIncompatSug2'), t('diag.pluginIncompatSug3'),
        t('diag.pluginIncompatSug4'), t('diag.pluginIncompatSug5')]);
  }
  if (/EPERM|EACCES|EINVAL/.test(msg)) {
    return mk('permission', t('diag.permissionTitle'),
      msg, [t('diag.permissionSug1'), t('diag.permissionSug2')]);
  }
  if (/ENOENT|cannot find module|not found/i.test(msg)) {
    return mk('missing-file', t('diag.missingFileTitle'),
      msg, [t('diag.missingFileSug1'), t('diag.missingFileSug2')]);
  }
  if (/输出服务地址超时/.test(msg)) {
    return mk('boot-timeout', t('diag.bootTimeoutTitle'),
      t('diag.bootTimeoutCause'),
      [t('diag.bootTimeoutSug1'), t('diag.bootTimeoutSug2'), t('diag.bootTimeoutSug3')]);
  }
  if (/未就绪/.test(msg)) {
    return mk('http-timeout', t('diag.httpTimeoutTitle'),
      t('diag.httpTimeoutCause'),
      [t('diag.httpTimeoutSug1'), t('diag.httpTimeoutSug2')]);
  }
  if (/启动后即退出/.test(msg)) {
    return mk('early-exit', t('diag.earlyExitTitle'),
      msg.slice(0, 500),
      [t('diag.earlyExitSug1'), t('diag.earlyExitSug2')]);
  }
  if (/端口|EADDRINUSE/.test(msg)) {
    return mk('port-busy', t('diag.portBusyTitle'), msg, [t('diag.portBusySug1')]);
  }
  return mk('generic', t('diag.genericTitle'),
    msg.slice(0, 600) || t('diag.genericCauseFallback'),
    [t('diag.genericSug1'), t('diag.genericSug2')]);
}

// ---------- 报告生成 ----------

function renderReport(diag, cls, ctx = {}) {
  const L = [];
  const push = (s = '') => L.push(s);
  const table = (obj) => { for (const k of Object.keys(obj || {})) push(`- **${k}**: ${safeStr(obj[k])}`); };

  // 章节标题与字段标签走文案表(repfile 域):报告会被用户导出分享,文案不允许埋在代码里
  push(t('repfile.title'));
  push('');
  push(`${t('repfile.generated')}${diag.timestamp || new Date().toISOString()}`);
  push(`${t('repfile.phase')}${diag.phase || 'unknown'}`);
  push('');
  push(t('repfile.classify'));
  push(`${t('repfile.judgment')}${cls.title}`);
  push(`${t('repfile.cause')}${cls.cause}`);
  push(t('repfile.suggestions'));
  for (const s of cls.suggestions) push(`  - ${s}`);
  push('');
  push(t('repfile.runtime'));
  table(diag.runtime);
  push('');
  if (diag.workspace) { push(t('repfile.workspace')); push(`- ${diag.workspace}`); push(''); }
  if (diag.config) { push(t('repfile.config')); push('```json'); push(safeStr(diag.config)); push('```'); push(''); }
  if (diag.dsh) {
    push(t('repfile.dsh'));
    table(diag.dsh);
    push('');
  }
  push(t('repfile.boot'));
  table(diag.boot);
  push('');

  const err = ctx.error;
  if (err) {
    push(t('repfile.rawError'));
    push('```');
    push(String((err && err.stack) || err || ''));
    push('```');
    push('');
  }
  if (diag.crashTxt) {
    push(t('repfile.crash'));
    push('```');
    push(diag.crashTxt);
    push('```');
    push('');
  }
  if (diag.logTail) {
    push(t('repfile.logTail'));
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
  classifyError,
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