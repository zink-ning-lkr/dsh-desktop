// dsh-process.js —— dsh 本体子进程域:定位 node/dsh、启动 dsh web 并解析服务地址、
// 等待 HTTP 就绪、整树终止、版本读取,以及最近一次启动的快照(供错误报告/崩溃诊断)。
// 依赖 core.js(配置/日志/脱敏);不依赖 electron 窗口与更新流程。
'use strict';

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { log, redactToken, loadConfig, firstLine } = require('./core');

const IS_WIN = process.platform === 'win32';
const DSH_PKG_SUB = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js');
const BOOT_URL_TIMEOUT_MS = 90_000; // 等待 dsh 打印服务地址(升级/首启时 dsh 要用 pnpm 装 40+ 个包,放宽到 90s)
const SERVER_READY_TIMEOUT_MS = 60_000; // 等待 HTTP 就绪(首次启动要装依赖,放宽)

// ---------- 定位 node 与 dsh(不经过 dsh.cmd 转发,便于管理进程树);成功后缓存避免重复 execSync ----------
let cachedDshBin = null;
let cachedNode = null;
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
      // dsh web 会派生自己的子进程,必须整树终止;
      // taskkill 启动失败(如进程已消失)也要完成清理流程,error 不得泄漏到 uncaughtException
      const p = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      p.on('error', () => resolve());
      p.on('close', () => resolve());
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

// ---------- 最近一次启动的快照(错误报告/崩溃诊断读取;内存中保留完整 token 用于排障) ----------
let bootBuf = '';   // 最近一次启动的 stdout/stderr 缓冲尾部
let bootArgs = null; // 最近一次启动的 spawn 参数
let bootStartedAt = null; // 最近一次启动的时刻
function getBootSnapshot() {
  return { buf: bootBuf, args: bootArgs, startedAt: bootStartedAt };
}

// 启动 dsh web 并解析其打印的服务地址。
// opts.onChild(child):spawn 成功立即回调——主进程借此登记子进程,启动窗口期内
//   退出应用时 before-quit 也能杀掉它,避免孤儿进程;
// opts.onOut(line):启动期每个输出行回调(加载页日志尾巴)。
function startDsh(cwd, { onOut, onChild } = {}) {
  const bin = findDshBin();
  const node = findNode();
  const args = [bin, 'web', '--host', '127.0.0.1', '--port', String(loadConfig().port ?? 0)];
  // dsh 0.1.0-rc.8 起默认自动打开系统浏览器;桌面壳已内嵌 UI,默认加 --no-open 抑制,由菜单"自动打开浏览器"控制
  if (!loadConfig().openBrowser) args.push('--no-open');
  bootArgs = args;
  bootStartedAt = Date.now();
  bootBuf = '';
  log(`dsh 版本: ${dshVersion()}`);
  log(`启动 dsh web: "${node.exe}" ${args.map((a) => `"${a}"`).join(' ')} (cwd=${cwd})`);
  // cwd 失效(工作目录被删/可移动磁盘拔出)时 spawn 会同步抛错,wrap 后走 boot 失败报告流
  const child = (() => {
    try {
      return spawn(node.exe, args, {
        cwd,
        env: node.env,
        windowsHide: true,
        detached: !IS_WIN,
      });
    } catch (e) { throw new Error(`无法启动 dsh 进程: ${e.message}`); }
  })();
  if (onChild) onChild(child);

  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const onError = (e) => settle(reject, new Error(`无法启动 dsh 进程: ${e.message}`));
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      // 启动完成:detach 启动期监听(地址解析/回显/逐行日志),只保留轻量尾部缓冲供退出报告;
      // 运行期输出不再对 256KB 缓冲反复跑正则,也不再把 dsh 的运行日志刷进启动日志
      const keepTail = (chunk) => { bootBuf = (bootBuf + chunk.toString()).slice(-16000); };
      child.stdout.removeListener('data', onData);
      child.stderr.removeListener('data', onData);
      child.stdout.on('data', keepTail);
      child.stderr.on('data', keepTail);
      fn(value);
    };
    const onData = (chunk) => {
      const text = chunk.toString();
      bootBuf = (bootBuf + text).slice(-16000);
      if (text.trim()) {
        log(`[dsh] ${redactToken(text.trim())}`);
        const line = text.trim().split('\n').pop();
        if (onOut) onOut(line);
      }
      buf += text;
      if (buf.length > 262144) buf = buf.slice(-262144); // 启动输出限量:防超长日志撑爆内存
      // dsh web 启动后打印形如 "dsh web: http://127.0.0.1:7123" 的地址行;
      // 仅匹配 "dsh web:" 前缀行(旧的兜底分支会把任意回环地址输出误判为服务地址)。
      // dsh 0.1.2-alpha.2 起地址会带一次性鉴权参数(如 http://127.0.0.1:PORT/?token=xxx,
      // 浏览器会话 Cookie 认证):\S+ 会连同 token 一起捕获,必须原样保留——桌面内嵌浏览器
      // 正是靠它换取会话 Cookie,截断成裸地址会得到 401 空白页
      const m = buf.match(/dsh web:\s*(https?:\/\/\S+)/);
      if (m) settle(resolve, { child, url: m[1] });
    };
    const onExit = (code) => settle(reject, new Error(`dsh web 启动后即退出 (code=${code})\n${buf.slice(-2000)}`));
    const timer = setTimeout(() => settle(reject, new Error(`等待 dsh web 输出服务地址超时(${BOOT_URL_TIMEOUT_MS / 1000}s)\n${buf.slice(-2000)}`)), BOOT_URL_TIMEOUT_MS);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError); // node 在 findNode 与 spawn 之间被删/被杀软拦截等:转为启动失败报告,而非 uncaughtException 闪退
  });
}

// 返回 true=就绪;false=被取消(shouldStop 由调用方组合:重启换代/退出等),调用方应静默放弃本轮
function waitServerReady(url, shouldStop = () => false) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (shouldStop()) return resolve(false);
      const req = http.get(url, (res) => { res.resume(); resolve(true); }); // 任何 HTTP 状态都说明服务已监听
      req.setTimeout(3000, () => req.destroy(new Error('socket 超时'))); // 连接挂起时及时销毁并重试,防无效连接堆积
      req.on('error', retry);
    };
    const retry = () => {
      if (shouldStop()) return resolve(false);
      if (Date.now() - startedAt > SERVER_READY_TIMEOUT_MS) return reject(new Error(`dsh web 服务 ${SERVER_READY_TIMEOUT_MS / 1000}s 内未就绪`));
      setTimeout(tryOnce, 400);
    };
    tryOnce();
  });
}

module.exports = {
  findDshBin,
  findDshBinSafe,
  findNode,
  findNodeSafe,
  nodeUsable,
  dshVersion,
  killTree,
  startDsh,
  waitServerReady,
  getBootSnapshot,
};
