// 第一步:用 Electron 离屏渲染三张"母版"(物理分辨率,约为标称值×系统缩放):
//   assets/icon-src/master-icon.png      蓝渐变底 + 白鲸
//   assets/icon-src/master-white.png     白鲸透明底
//   assets/icon-src/master-black.png     黑鲸透明底
// 后续由 resize-icons.ps1 重采样出精确尺寸,gen-icon.js 组装 ico。
// 用法: npx electron tools/rasterize-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SRC_SVG = path.join(__dirname, '..', 'assets', 'deepseek-whale.svg'); // viewBox 0 0 24 24
const OUT_DIR = path.join(__dirname, '..', 'assets', 'icon-src');
const MASTER_DIP = 256;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {}); // 捕获窗口销毁后的空档期不退出

function svgInner() {
  const raw = fs.readFileSync(SRC_SVG, 'utf8');
  return raw.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<\/?svg[^>]*>/g, '');
}

const TMP_HTML = path.join(__dirname, '.icon-tmp.html');

async function capture(win, html, out) {
  let last = null;
  const onPaint = (_e, _dirty, image) => { last = image; };
  win.webContents.on('paint', onPaint);
  fs.writeFileSync(TMP_HTML, html);
  await win.loadFile(TMP_HTML);
  const startedAt = Date.now();
  while (!last && Date.now() - startedAt < 3000) await sleep(50);
  await sleep(150); // 多收几帧,确保渲染完成
  win.webContents.off('paint', onPaint);
  if (!last) throw new Error(`渲染失败: ${out}`);
  fs.writeFileSync(out, last.toPNG());
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const whale = svgInner();
  const s = MASTER_DIP;
  const win = new BrowserWindow({
    show: false, width: s, height: s, useContentSize: true,
    frame: false, transparent: true, webPreferences: { offscreen: true },
  });

  await capture(win, `<body style="margin:0;width:${s}px;height:${s}px;background:transparent">
<div style="width:${s}px;height:${s}px;border-radius:${Math.round(s * 0.22)}px;background:linear-gradient(180deg,#5B7BFF,#364FC9);display:flex;align-items:center;justify-content:center">
<svg viewBox="0 0 24 24" style="width:${Math.round(s * 0.8)}px;height:${Math.round(s * 0.8)}px">${whale}</svg>
</div>
<style>svg path{fill:#fff !important}</style>
</body>`, path.join(OUT_DIR, 'master-icon.png'));

  for (const [name, fill] of [['master-white.png', '#ffffff'], ['master-black.png', '#000000']]) {
    await capture(win, `<body style="margin:0;width:${s}px;height:${s}px;background:transparent;display:flex;align-items:center;justify-content:center">
<svg viewBox="0 0 24 24" style="width:${Math.round(s * 0.9)}px;height:${Math.round(s * 0.9)}px">${whale}</svg>
<style>svg path{fill:${fill} !important}</style>
</body>`, path.join(OUT_DIR, name));
  }

  win.destroy();
  fs.rmSync(TMP_HTML, { force: true });
  console.log(`已生成三张母版于 ${OUT_DIR}`);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
