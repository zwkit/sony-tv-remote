# -*- coding: utf-8 -*-
"""
make_pwa_icons.py — 生成「电视遥控」PWA 桌面图标。

图案：深色渐变方底 + 居中白色遥控器（机身 + 蓝色电源键 + 圆形方向键 +
      两颗功能键 + 底部三条音量/频道条）。

为什么用 Python/Pillow 自己画：
  · 不依赖 ImageMagick / inkscape / sharp，仓库里没有这些二进制；
  · 矢量式绘制 + 4x 超采样，任意尺寸都清晰；
  · 输出普通不透明 PNG（不透明四角），iOS/Android/Chrome 各自加圆角/圆形遮罩时
    不会露出黑角 or 透明角。

用法（在本项目根目录）：
  python tools/make_pwa_icons.py
  # 需要 Pillow（pip install pillow）；若默认 python 没装，指定带 Pillow 的解释器：
  #   /path/to/python tools/make_pwa_icons.py

生成物（全部落在 public/，由 server.js 静态托管）：
  public/icon.svg              任意尺寸矢量（favicon，type=image/svg+xml）
  public/icon-192.png          192×192  purpose=any
  public/icon-512.png          512×512  purpose=any
  public/icon-maskable-512.png 512×512  purpose=maskable（遥控器缩到安全区内）
  public/apple-touch-icon.png  180×180  iOS「添加到主屏幕」
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'public')
os.makedirs(OUT, exist_ok=True)

# ---- 配色（和 index.html :root 里 --bgTop / --card / --accent 对齐）----
BG_TOP = (28, 34, 50)       # 渐变起点
BG_BOTTOM = (13, 17, 27)    # 渐变终点
TILE = (37, 43, 60)         # 遥控器机身（比底色亮一档）
TILE_EDGE = (90, 102, 130)  # 机身高光描边
FG = (238, 242, 250)        # 近白：按键 / 图标
ACCENT = (91, 140, 255)     # --accent 蓝：电源键
DIM = (150, 160, 182)       # 次要按键灰
DPAD = (24, 29, 42)         # 方向键底盘

S = 4  # 超采样倍数


def gradient(ss, top, bottom):
    """ss×ss 的竖直渐变（RGBA）。"""
    img = Image.new('RGBA', (ss, ss))
    d = ImageDraw.Draw(img)
    for y in range(ss):
        t = y / (ss - 1) if ss > 1 else 0
        c = (int(round(top[0] + (bottom[0] - top[0]) * t)),
             int(round(top[1] + (bottom[1] - top[1]) * t)),
             int(round(top[2] + (bottom[2] - top[2]) * t)), 255)
        d.line([(0, y), (ss, y)], fill=c)
    return img


def render(size, shrink=1.0):
    """渲染 size×size 不透明 PNG。

    shrink：遥控器相对设计画布(0..1000)的缩放，1.0=铺满设计尺寸，
    0.8=缩到中央 80% 安全区（maskable 用）。背景始终是全幅直角渐变。
    内部以 S 倍超采样绘制，再 LANCZOS 缩小，边缘平滑。
    """
    ss = size * S
    img = gradient(ss, BG_TOP, BG_BOTTOM)
    d = ImageDraw.Draw(img)
    k = ss / 1000.0 * shrink
    off = ss * (1.0 - shrink) / 2.0

    def X(v): return off + v * k
    def Y(v): return off + v * k
    def R(v): return v * k
    def W(v): return max(1, int(round(v * k)))

    def rr(b, r, fill, outline=None, w=1):
        d.rounded_rectangle([X(b[0]), Y(b[1]), X(b[2]), Y(b[3])],
                            radius=R(r), fill=fill, outline=outline, width=W(w))

    def ell(b, fill, outline=None, w=1):
        d.ellipse([X(b[0]), Y(b[1]), X(b[2]), Y(b[3])],
                  fill=fill, outline=outline, width=W(w))

    def line(x0, y0, x1, y1, fill, w=1):
        d.line([X(x0), Y(y0), X(x1), Y(y1)], fill=fill, width=W(w))

    def arc(b, start, end, fill, w=1):
        d.arc([X(b[0]), Y(b[1]), X(b[2]), Y(b[3])],
              start=start, end=end, fill=fill, width=W(w))

    def poly(pts, fill):
        d.polygon([(X(a), Y(b)) for a, b in pts], fill=fill)

    # ---------- 遥控器本体（设计坐标 0..1000）----------
    # 机身：圆角长条，居中
    rr((330, 150, 670, 850), 95, TILE, outline=TILE_EDGE, w=6)
    line(440, 176, 560, 176, (70, 80, 105), 5)   # 顶部高光

    # 电源键：顶部居中的蓝色圆 + 电源符号
    cx, cy, pr = 500, 250, 58
    ell((cx - pr, cy - pr, cx + pr, cy + pr), ACCENT)
    arc((cx - 26, cy - 26, cx + 26, cy + 26), -55, 235, (255, 255, 255), 9)
    line(cx, cy - 34, cx, cy - 2, (255, 255, 255), 9)

    # 圆形方向键（D-pad）外圈 + 中心 OK 圆
    dcx, dcy, dr = 500, 470, 150
    ell((dcx - dr, dcy - dr, dcx + dr, dcy + dr), DPAD, outline=TILE_EDGE, w=4)
    okr = 58
    ell((dcx - okr, dcy - okr, dcx + okr, dcy + okr), FG)

    # 四个方向三角
    tw, th, gap = 34, 36, 78
    poly([(dcx, dcy - gap - th), (dcx - tw, dcy - gap + 6), (dcx + tw, dcy - gap + 6)], DIM)
    poly([(dcx, dcy + gap + th), (dcx - tw, dcy + gap - 6), (dcx + tw, dcy + gap - 6)], DIM)
    poly([(dcx - gap - th, dcy), (dcx - gap + 6, dcy - tw), (dcx - gap + 6, dcy + tw)], DIM)
    poly([(dcx + gap + th, dcy), (dcx + gap - 6, dcy - tw), (dcx + gap - 6, dcy + tw)], DIM)

    # 两颗功能键（D-pad 下方左右）
    for bx in (410, 590):
        ell((bx - 30, 630, bx + 30, 690), DIM)

    # 底部三条：音量 / 频道条
    for (y, w) in ((735, 200), (775, 200), (815, 140)):
        x0 = 500 - w // 2
        rr((x0, y - 9, x0 + w, y + 9), 9, FG)

    return img.resize((size, size), Image.LANCZOS).convert('RGB')


def write_svg():
    """和 PNG 同款图案的矢量 favicon（圆角方底，浏览器标签页里更好看）。"""
    svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c2232"/>
      <stop offset="1" stop-color="#0d111b"/>
    </linearGradient>
  </defs>
  <rect width="1000" height="1000" rx="225" fill="url(#bg)"/>
  <rect x="330" y="150" width="340" height="700" rx="95" fill="#252b3c" stroke="#5a6682" stroke-width="6"/>
  <line x1="440" y1="176" x2="560" y2="176" stroke="#465069" stroke-width="5"/>
  <circle cx="500" cy="250" r="58" fill="#5b8cff"/>
  <path d="M 476 224 A 26 26 0 1 0 524 224" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/>
  <line x1="500" y1="216" x2="500" y2="248" stroke="#fff" stroke-width="9" stroke-linecap="round"/>
  <circle cx="500" cy="470" r="150" fill="#181d2a" stroke="#5a6682" stroke-width="4"/>
  <circle cx="500" cy="470" r="58" fill="#eef2fa"/>
  <path d="M500 356 L466 398 L534 398 Z" fill="#96a0b6"/>
  <path d="M500 584 L466 542 L534 542 Z" fill="#96a0b6"/>
  <path d="M386 470 L428 436 L428 504 Z" fill="#96a0b6"/>
  <path d="M614 470 L572 436 L572 504 Z" fill="#96a0b6"/>
  <circle cx="410" cy="660" r="30" fill="#96a0b6"/>
  <circle cx="590" cy="660" r="30" fill="#96a0b6"/>
  <rect x="400" y="726" width="200" height="18" rx="9" fill="#eef2fa"/>
  <rect x="400" y="766" width="200" height="18" rx="9" fill="#eef2fa"/>
  <rect x="430" y="806" width="140" height="18" rx="9" fill="#eef2fa"/>
</svg>'''
    with open(os.path.join(OUT, 'icon.svg'), 'w', encoding='utf-8') as f:
        f.write(svg)


def main():
    any512 = render(512, 1.0)
    any512.save(os.path.join(OUT, 'icon-512.png'))
    any512.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, 'icon-192.png'))
    any512.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, 'apple-touch-icon.png'))

    render(512, 0.8).save(os.path.join(OUT, 'icon-maskable-512.png'))
    write_svg()

    for name in ('icon.svg', 'icon-192.png', 'icon-512.png',
                 'icon-maskable-512.png', 'apple-touch-icon.png'):
        p = os.path.join(OUT, name)
        print('  %-26s %6d bytes' % (name, os.path.getsize(p)))
    print('done ->', OUT)


if __name__ == '__main__':
    main()
