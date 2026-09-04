# make-tray-badges.py —— 预生成托盘三档状态角标图标(P0-3)。
# 以 assets/icon.png 为底,右下角叠状态圆点(配色与 ui.css 令牌一致):
#   icon-ok.ico   绿点  dsh 运行中
#   icon-warn.ico 黄点  启动中
#   icon-err.ico  红点  已停止/崩溃
# 用法:python tools/make-tray-badges.py(icon.png 变更后重跑并提交产物)
from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / 'assets' / 'icon.png'
SIZES = [16, 24, 32, 48]  # 托盘常用档,ico 多尺寸内嵌
STATES = {
    'icon-ok.ico': (63, 185, 80),    # --c-ok   #3fb950
    'icon-warn.ico': (210, 153, 34),  # --c-warn #d29922
    'icon-err.ico': (248, 81, 73),    # --c-err  #f85149
}
OUTLINE = (13, 17, 23)  # --c-bg0,与托盘深色/浅色背景都有区分度


def badge(size: int, color: tuple) -> Image.Image:
    img = Image.open(BASE).convert('RGBA').resize((size, size), Image.LANCZOS)
    d = ImageDraw.Draw(img)
    r = max(4, round(size * 0.30))          # 圆点半径:16px 时约 5px,清晰可见
    cx, cy = size - r - 1, size - r - 1     # 右下角,留 1px 边
    d.ellipse([cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1], fill=OUTLINE)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (255,))
    return img


for name, color in STATES.items():
    # 从最大帧重采样各档(sizes 参数逐档重绘,避免 16px 底图放大发虚)
    big = badge(max(SIZES), color)
    out = ROOT / 'assets' / name
    big.save(out, format='ICO', sizes=[(s, s) for s in SIZES])
    print(f'{name}: {len(SIZES)} sizes')
