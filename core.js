// core.js —— 主进程基础设施:配置读写(原子写)、日志缓冲与轮转、崩溃记录路径、
// token 脱敏、限时 execSync 工具、跨模块共享常量。
// 被 main.js / dsh-process.js / updates.js 共同依赖;本身不依赖其他项目模块(避免循环)。
'use strict';

const { app } = require('electron');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 下载加速分段数取值区间:accel 设置窗(main.js)与加速下载(updates.js)共用同一份契约
const ACCEL_SEGMENTS_MIN = 2;
const ACCEL_SEGMENTS_MAX = 16;

// ---------- 配置(记住上次的工作目录) ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  const file = configPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 原子写:先写临时文件再 rename,断电/崩溃中断时不会留下半写的 config.json(否则配置静默丢失)
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    // Windows 上杀软/同步盘锁定目标文件时 rename 会偶发 EBUSY/EPERM:
    // 记录日志并返回失败,不抛出(调用方分散在 close/before-quit 等生命周期钩子里,抛错会打断流程)
    log(`config.json 写入失败: ${e.message}`);
    try { fs.unlinkSync(file + '.tmp'); } catch { /* 残留临时文件下次覆盖 */ }
    return false;
  }
}
// 崩溃记录统一落 userData(打包后 __dirname 是只读 asar,写那里会静默失败)
const crashFilePath = () => {
  try { return path.join(app.getPath('userData'), 'CRASH.txt'); } catch { return path.join(__dirname, 'CRASH.txt'); }
};

// ---------- 日志(内存缓冲 + 定期批量刷盘,避免高频 stdout 把主进程卡在同步 IO 上) ----------
const logFile = path.join(app.getPath('userData'), 'dsh-web.log');
// dsh 0.1.2-alpha.2 起服务地址带一次性 ?token= 鉴权参数(换取会话 Cookie),未被消费前
// 可用于劫持会话。日志文件与导出的错误报告会被用户分享,所有对外落盘的输出统一脱敏;
// 内存中的 dshWebUrl/启动快照保持原样(加载页面/排障需要完整地址)
function redactToken(s) {
  return String(s).replace(/([?&]token=)[^\s&]+/gi, '$1***');
}
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

// ---------- 限时同步命令(冷启动 npm/where 需 1-3s,挂起时不能无限冻结主进程) ----------
function firstLine(cmd) {
  // 统一 5s 超时:冷启动 npm/where 需 1-3s,挂起时不能无限冻结主进程
  try { return execSync(cmd, { windowsHide: true, timeout: 5000 }).toString().split('\n')[0].trim(); } catch { return ''; }
}

module.exports = {
  ACCEL_SEGMENTS_MIN,
  ACCEL_SEGMENTS_MAX,
  configPath,
  loadConfig,
  saveConfig,
  crashFilePath,
  logFile,
  redactToken,
  log,
  flushLog,
  firstLine,
};
