// 从 assets/icon-src/<size>.png(由 rasterize-icon.js 生成)组装:
//   assets/icon.ico  多尺寸 Windows 图标
//   assets/icon.png  256 PNG(窗口运行时图标)
// PNG/ICO 编码用 Node 标准库手写,零第三方依赖。
const fs = require('node:fs');
const path = require('node:path');

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// ---- ICO 编码(内嵌 PNG 数据的标准格式,Vista+ 均支持)----
function encodeICO(entries) {
  // entries: [{ size, png }]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(entries.length * 16);
  const blobs = [];
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const e = dir.subarray(i * 16, (i + 1) * 16);
    const dim = size >= 256 ? 0 : size; // 256 在目录项里记为 0
    e[0] = dim;   // 宽
    e[1] = dim;   // 高
    e[2] = 0;     // 颜色数
    e[3] = 0;     // 保留
    e.writeUInt16LE(1, 4);           // 位平面
    e.writeUInt16LE(32, 6);          // 位深
    e.writeUInt32LE(png.length, 8);  // 数据长度
    e.writeUInt32LE(offset, 12);     // 数据偏移
    offset += png.length;
    blobs.push(png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const srcDir = path.join(__dirname, '..', 'assets', 'icon-src');
const outDir = path.join(__dirname, '..', 'assets');
const entries = sizes.map((size) => ({
  size,
  png: fs.readFileSync(path.join(srcDir, `${size}.png`)),
}));
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeICO(entries));
fs.copyFileSync(path.join(srcDir, '256.png'), path.join(outDir, 'icon.png'));
console.log(`已组装 icon.ico (${sizes.join('/')}) 与 icon.png (256) 于 ${outDir}`);
