// downloader.js —— 桌面端更新包多线程分段下载器(主进程专用,零外部依赖)。
// 借鉴 aria2 的分块并发思想:GET 探测服务器是否支持 Range → 按 Range 分段并发下载、
// 各段按字节偏移落盘 → 全程 sha512 校验;服务器不支持 Range 或任一分段异常 →
// 自动回退单连接整包下载,任何情况下调用方仍可走官方 electron-updater 下载兜底。
// 网络栈使用 Electron 的 net.request(与 electron-updater 相同:系统代理/证书行为一致),
// 因此本模块只在 Electron 主进程内加载。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { net } = require('electron');

const DEFAULT_SEGMENTS = 6;           // 并发分段数(平衡连接开销与 CDN 限流风险)
const MIN_SEGMENT_BYTES = 512 * 1024; // 小于该体积的包不做分段(连接开销不划算)
const SEGMENT_TIMEOUT_MS = 30_000;    // 每段无数据超时
const SINGLE_TIMEOUT_MS = 30_000;     // 单连接整包下载的无数据超时
const PROBE_TIMEOUT_MS = 8_000;       // 探测请求超时
const PROGRESS_INTERVAL_MS = 150;     // 进度回调节流

// ---------- 解析最终 URL(GitHub Release 下载会 302 → release-assets CDN) ----------
// 用 HEAD + 手动重定向拿到最终地址:后续 Range 分段/单连接都直连最终 CDN,
// 避免重定向过程丢弃 Range 头导致分段全部失效。
// 递归跟随至多 MAX_HOPS 跳(单跳 CDN 常见;多跳链(如镜像再转发)到顶仍可用最后地址,
// 若该地址还会跳,分段流程会因 Range 丢失自动回退单连接,单连接无 Range 不受影响)。
const MAX_REDIRECT_HOPS = 5;
function resolveFinalUrl(url, isCancelled) {
  const probe = (u, depth) =>
    new Promise((resolve) => {
      if (depth > MAX_REDIRECT_HOPS) return resolve(u); // 到顶:返回当前已知最深地址
      let req = null;
      let settled = false;
      let timer = null;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { req && req.abort(); } catch { /* ignore */ }
        resolve(v);
      };
      try {
        req = net.request({ url: u, method: 'HEAD', redirect: 'manual' });
      } catch {
        return finish(null);
      }
      timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
      const cancelled = () => isCancelled && isCancelled();
      req.on('redirect', (_status, _method, redirectUrl) => {
        if (cancelled()) return finish(null);
        // 继续跟踪下一跳,最终拿到无重定向的地址;子链失败时回落当前跳转地址
        probe(redirectUrl, depth + 1).then((finalUrl) => finish(finalUrl || redirectUrl));
      });
      req.on('response', () => finish(u)); // 无重定向:HEAD 直接响应,当前地址即最终地址
      req.on('error', () => finish(null));
      req.end();
    });
  return probe(url, 0);
}

// ---------- 探测:GET + "Range: bytes=0-0" ----------
// 返回 { size, range }:
//   size=null   → 拿不到总大小(chunked 等),只能单连接;
//   range=false → 服务器忽略 Range(返回全部内容),走单连接;
//   range=true  → 支持分段,size 为总字节数。
function probe(url, isCancelled) {
  return new Promise((resolve) => {
    let req = null;
    let settled = false;
    let timer = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req && req.abort(); } catch { /* ignore */ }
      resolve(v);
    };
    try {
      req = net.request({ url, headers: { Range: 'bytes=0-0' } });
    } catch {
      return finish({ size: null, range: false });
    }
    timer = setTimeout(() => finish({ size: null, range: false }), PROBE_TIMEOUT_MS);
    const cancelled = () => isCancelled && isCancelled();
    req.on('response', (res) => {
      if (cancelled()) { // 已取消:探测即断,不再读头
        try { res.destroy(); } catch { /* ignore */ }
        return finish({ size: null, range: false });
      }
      const cl = res.headers['content-length'];
      const cr = res.headers['content-range'];
      if (res.statusCode === 206 && cr) {
        const m = /bytes\s+\d+-\d+\/(\d+)/.exec(cr);
        finish({ size: m ? Number(m[1]) : null, range: true });
      } else if (res.statusCode === 200) {
        finish({ size: cl ? Number(cl) : null, range: false });
      } else {
        finish({ size: null, range: false });
      }
      try { res.destroy(); } catch { /* ignore */ } // 探测即断开,不读正文
    });
    req.on('error', () => finish({ size: null, range: false }));
    req.end();
  });
}

// ---------- 单段 Range 下载:并发调用,各自按 start 偏移顺序写同一文件句柄 ----------
// shared: { failed } —— 任一分段失败时写入首错,其余分段在下一个数据块/超时到达时立即
// 中止自己的请求,不再把整段拉完(否则单段失败回退官方下载时,其他段仍在后台白拉流量)
function fetchRangeSegment(url, start, end, fd, isCancelled, onBytes, shared) {
  return new Promise((resolve, reject) => {
    let req = null;
    let settled = false;
    let timer = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (shared) shared.failed = shared.failed || err; // 首个失败对所有兄弟分段可见
      try { req && req.abort(); } catch { /* ignore */ }
      reject(err);
    };
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(shared && shared.failed ? shared.failed : new Error('分段下载超时(无数据)')), SEGMENT_TIMEOUT_MS);
    };
    try {
      req = net.request({ url, headers: { Range: `bytes=${start}-${end}` } });
    } catch (err) {
      return fail(err);
    }
    req.on('response', (res) => {
      if (res.statusCode !== 206) {
        // 200 = 服务器忽略 Range(重定向可能丢 Range 头)返回全文件 → 本次分段不可用,
        // 由主流程整体回退单连接;其余状态码一律视为失败。
        return fail(res.statusCode === 200 ? new Error('服务器忽略 Range,回退单连接') : new Error(`分段下载 HTTP ${res.statusCode}`));
      }
      let pos = start;
      let pending = Promise.resolve(); // 已排队的写(串行化;跨段各自独立,同段内按序落盘)
      res.on('data', (chunk) => {
        if (settled) return;
        if (isCancelled && isCancelled()) return fail(new Error('已取消'));
        if (shared && shared.failed) return fail(shared.failed); // 兄弟分段已失败:尽快中止,不再拉本段
        resetTimer();
        const writePos = pos;
        pos += chunk.length;
        // 背压:写盘期间暂停接收网络流,写完当前 chunk 再继续。
        // (与单连接路径的 pause/drain 同策略——原先的分段路径只把写操作挂进 promise 链,
        // 慢盘 + 快网时数据事件不停触发,整段数据会被待写 chunk 顶在内存,峰值≈段大小×并发)
        res.pause();
        const c = chunk;
        pending = pending.then(
          () => fd.write(c, 0, c.length, writePos).then(
            () => { onBytes && onBytes(c.length); if (!settled) res.resume(); },
            (e) => fail(e),
          ),
          () => {}, // 前序写失败已由 fail 处理,本段直接跳过
        );
      });
      res.on('end', () => pending.then(
        () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } },
        (e) => fail(e),
      ));
      res.on('error', (e) => fail(e));
      resetTimer();
    });
    req.on('error', (e) => fail(e));
    req.end();
  });
}

// ---------- 单连接整包下载(回退路径,同样带进度/取消/sha512) ----------
function singleStreamDownload(url, destFile, opts = {}) {
  const { sha512, onProgress, isCancelled } = opts;
  return new Promise((resolve, reject) => {
    let req = null;
    let settled = false;
    let timer = null;
    let total = 0;
    let transferred = 0;
    let lastReport = 0;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req && req.abort(); } catch { /* ignore */ }
      reject(err);
    };
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('下载超时(无数据)')), SINGLE_TIMEOUT_MS);
    };
    try {
      req = net.request({ url });
    } catch (err) {
      return fail(err);
    }
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) return fail(new Error(`下载 HTTP ${res.statusCode}`));
      total = Number(res.headers['content-length'] || 0) || total;
      // 传输内容长度上限:服务器超发(声明 N 却持续推送)时及时中止,避免无限下载。
      // 有 content-encoding(压缩传输)时响应体会被解压,解码后长度可超过原始 Content-Length,
      // 此时不设上限,最终仍由 sha512 兜底完整性。
      const gzipped = !!res.headers['content-encoding'];
      const ws = fs.createWriteStream(destFile);
      // 背压:快网 + 慢盘(机械盘/U 盘)时 ws.write 返回 false 说明内部缓冲已满,
      // 暂停读取网络流等 drain 再继续,避免内存随下载无限膨胀
      const onData = (chunk) => {
        if (isCancelled && isCancelled()) { ws.destroy(); return fail(new Error('已取消')); }
        if (!gzipped && total && transferred + chunk.length > total) {
          ws.destroy();
          return fail(new Error(`下载内容超过声明大小(${transferred + chunk.length} > ${total})`));
        }
        resetTimer();
        transferred += chunk.length;
        if (!ws.write(chunk)) {
          res.pause();
          ws.once('drain', () => res.resume());
        }
        const now = Date.now();
        if (onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now;
          onProgress({ percent: total ? Math.min(100, (transferred / total) * 100) : 0, transferred, total });
        }
      };
      res.on('data', onData);
      res.on('end', () => ws.end());
      ws.on('finish', async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sha512) {
          try {
            const h = await hashFile(destFile);
            if (h !== sha512) {
              try { await fs.promises.unlink(destFile); } catch { /* ignore */ }
              return reject(new Error('sha512 校验失败(单连接)'));
            }
          } catch (e) { return reject(e); }
        }
        resolve({ bytes: transferred });
      });
      ws.on('error', (e) => { ws.destroy(); fail(e); });
      res.on('error', (e) => { ws.destroy(); fail(e); });
      resetTimer();
    });
    req.on('error', (e) => fail(e));
    req.end();
  });
}

// ---------- 主入口:多线程分段下载,探测/分段/Range 支持检测失败自动退化 ----------
// opts: { segments, sha512, onProgress({percent,transferred,total}), isCancelled }
async function multiThreadDownload(url, destFile, opts = {}) {
  const { segments = DEFAULT_SEGMENTS, sha512 = null, onProgress = null, isCancelled = null } = opts;
  // 预解析最终 URL(GitHub 会 302 到 release-assets CDN),保证分段请求带 Range 直达
  const finalUrl = (await resolveFinalUrl(url, isCancelled)) || url;
  const info = await probe(finalUrl, isCancelled);
  const total = info.size || 0;
  if (!info.range || total < MIN_SEGMENT_BYTES || segments <= 1) {
    return await singleStreamDownload(finalUrl, destFile, { sha512, onProgress, isCancelled, total });
  }
  const n = Math.max(1, Math.min(segments, total));
  const part = Math.ceil(total / n);
  const ranges = [];
  for (let i = 0; i < n; i++) {
    const start = i * part;
    const end = Math.min(start + part - 1, total - 1);
    if (start > end) break;
    ranges.push([start, end]);
  }
  const fd = await fs.promises.open(destFile, 'w');
  let transferred = 0;
  let lastReport = 0;
  const shared = { failed: null }; // 任一段失败 → 广播,其余段中止(见 fetchRangeSegment)
  const report = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    onProgress({ percent: total ? Math.min(100, (transferred / total) * 100) : 0, transferred, total });
  };
  const onBytes = (n2) => { transferred += n2; report(); };
  try {
    await Promise.all(ranges.map(([s, e]) => fetchRangeSegment(finalUrl, s, e, fd, isCancelled, onBytes, shared)));
    report(true);
  } catch (err) {
    try { await fd.close(); } catch { /* ignore */ }
    try { await fs.promises.unlink(destFile); } catch { /* ignore */ }
    throw err;
  }
  try { await fd.close(); } catch { /* ignore */ }
  if (sha512) {
    const h = await hashFile(destFile);
    if (h !== sha512) {
      try { await fs.promises.unlink(destFile); } catch { /* ignore */ }
      throw new Error(`sha512 校验失败(期望 ${sha512.slice(0, 16)}…,实际 ${h.slice(0, 16)}…)`);
    }
  }
  return { bytes: total };
}

// ---------- 工具 ----------
function hashFile(file, algorithm = 'sha512', encoding = 'base64') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    hash.setEncoding(encoding);
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on('error', reject)
      .on('end', () => { hash.end(); resolve(hash.read()); })
      .pipe(hash, { end: false });
  });
}

// 镜像目录形态(与 electron-updater GenericProvider 一致):镜像根目录 + 原文件名
function resolveDownloadUrl(rawUrl, mirror) {
  if (!mirror) return rawUrl;
  try {
    const fileName = path.basename(new URL(rawUrl).pathname);
    if (!fileName) return rawUrl;
    return new URL(fileName, mirror.endsWith('/') ? mirror : mirror + '/').toString();
  } catch { return rawUrl; }
}

module.exports = {
  multiThreadDownload,
  singleStreamDownload,
  hashFile,
  resolveDownloadUrl,
  DEFAULT_SEGMENTS,
};