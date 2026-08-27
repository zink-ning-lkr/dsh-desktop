// 打包前清理 dist 输出目录(旧版本 Setup/Portable/blockmap 会随每次构建堆积,~90MB/版):
// electron-builder 只重建 win-unpacked 与当前版本产物,不清除历史安装包。
// 用法: npm run dist(已在 package.json 中串联本脚本)
require('node:fs').rmSync(require('node:path').join(__dirname, '..', 'dist'), { recursive: true, force: true });