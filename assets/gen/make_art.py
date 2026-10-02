#!/usr/bin/env python3
"""火柴等式 MATCHWORK —— 全套位图资产的唯一真相源（仓内可复现，只依赖 Pillow）。

    python3 assets/gen/make_art.py           # 重画全套，逐张打印 路径 宽高 字节数
    python3 assets/gen/make_art.py --check   # 只校验盘上资产：合法 PNG / 宽高 / 内容指纹

母题和玩法同源，不是贴花：一根火柴被**从等式里拿起来**，正落进一条虚线的空位。
这就是游戏的全部动作（一手搬法 = 拿起一根 + 放到一个空位上），而空位在盘面上确实是
虚线段（js/view.js 的 `SLOT`），等号那两根是灰色的锁死段（`#8c95a5`）。图标里那条
灰色横杠就是等号，所以画面讲的其实是"从这一等式里搬走一根，让它重新成立"。

配色全部取自运行时实测读数，图标与游戏画面是同一批颜色：
  css/game.css :root  #141210 背景 · #e0a63c 琥珀 · #c8563c 红 · #78b4ff 蓝 · #ece5da 墨
  js/view.js   FELT #1d1a16 · STICK #d8cdb8 · HEAD_A #c8563c · HEAD_B #a33f2b
               等号 #8c95a5/#5d6675 · SLOT rgba(236,229,218,.09) · HELD #ffe9b0

纹理是**盘上真文件、运行时真用**（不是矢量凑数）：
  felt-256.png   可平铺毛毡底纹（view.js 用 createPattern 铺在版面下）
  ember-64.png   暖余烬精灵（view.js 用 drawImage + 'lighter' 打粒子）
文字只在 og 卡上出现，字体是**可选**的：找不到任何一款就退化成纯几何块，绝不因为缺
某个 .ttc 而生不出图。
"""
import argparse
import hashlib
import os
import random
import shutil
import struct
import sys

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageFilter
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：python3 -m pip install pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
ICON_DIR = os.path.join(REPO, 'assets', 'icons')
TEX_DIR = os.path.join(REPO, 'assets', 'textures')
OG_DIR = os.path.join(REPO, 'assets', 'og')

# ---------------------------------------------------------------- palette (measured, see header)
BG = (20, 18, 16)            # css --bg
BG2 = (28, 26, 23)           # css --bg2
FELT = (29, 26, 22)          # js/view.js FELT
INK = (236, 229, 218)        # css --ink
STICK = (216, 205, 184)      # js/view.js STICK
STICK_HOT = (244, 231, 200)  # js/view.js STICK_HOT
HEAD_A = (200, 86, 60)       # js/view.js HEAD_A
HEAD_B = (163, 63, 43)       # js/view.js HEAD_B
HELD = (255, 233, 176)       # js/view.js HELD
AMBER = (224, 166, 60)       # css --amber
RED = (200, 86, 60)          # css --red
GREEN = (111, 174, 122)      # css --green
LOCK_A = (140, 149, 165)     # 等号火柴
LOCK_B = (93, 102, 117)
SLOT = (236, 229, 218, 23)   # rgba(236,229,218,.09)

ICON_SIZES = [16, 32, 48, 64, 96, 128, 180, 192, 512, 1024]
TEX_SIZES = {'felt-256.png': (256, 256), 'ember-64.png': (64, 64)}
OG_NAME = 'matchwork-og.png'
OG_SIZE = (1200, 630)

# 盘上应有的每张位图与它的期望宽高（--check 的对账表，也是 build() 的产物清单）
EXPECTED = {}
for _s in ICON_SIZES:
    EXPECTED['assets/icons/icon-%d.png' % _s] = (_s, _s)
EXPECTED['assets/icons/favicon-16.png'] = (16, 16)
EXPECTED['assets/icons/favicon-32.png'] = (32, 32)
EXPECTED['assets/icons/apple-touch-icon.png'] = (180, 180)
EXPECTED['assets/icons/maskable-512.png'] = (512, 512)
for _n, _sz in TEX_SIZES.items():
    EXPECTED['assets/textures/' + _n] = _sz
EXPECTED['assets/og/' + OG_NAME] = OG_SIZE


def scaled(size, px):
    """母图坐标 -> 目标尺寸：一切几何都由 1024 网格上的比例决定。"""
    return size * px / 1024.0


def stick(img, p0, p1, width, body, head, head_r=None, glow=0.0):
    """画一根火柴：圆头杆身 + 靠 p1 那一端的头。端头有头是玩法事实（view.js 把头画在
    `to` 端，好让一根火柴的两端可分辨），所以图标与纹理都遵守同一条约定。"""
    draw = ImageDraw.Draw(img, 'RGBA')
    x0, y0 = p0
    x1, y1 = p1
    length = max(1e-6, ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5)
    ux, uy = (x1 - x0) / length, (y1 - y0) / length
    # 头的半径按 js/view.js 的实测比例：HEAD*0.5 / MATCH = 0.1 / 0.055 ≈ 1.8 倍半宽，
    # 也就是 0.9 倍杆宽。原来取 1.45 倍全宽，画出来是一根棒棒糖而不是火柴。
    hr = head_r if head_r is not None else width * 0.9
    # 杆身缩到头部内侧，别让头看起来挂在杆子外面
    bx1, by1 = x1 - ux * hr * 0.45, y1 - uy * hr * 0.45
    if glow > 0:
        g = Image.new('RGBA', img.size, (0, 0, 0, 0))
        ImageDraw.Draw(g, 'RGBA').line([(x0, y0), (bx1, by1)], fill=(AMBER[0], AMBER[1], AMBER[2], 70),
                                        width=int(max(1, width * 2.6)), joint='curve')
        g = g.filter(ImageFilter.GaussianBlur(width * 0.9))
        img.alpha_composite(g)
    draw.line([(x0, y0), (bx1, by1)], fill=body[:3] + (255,), width=max(1, int(round(width))), joint='curve')
    draw.ellipse([bx1 - hr, by1 - hr, bx1 + hr, by1 + hr], fill=head[:3] + (255,))
    # 头的高光，让它在 16px 下仍然是一块"亮的头"而不是一坨红
    ih = hr * 0.42
    draw.ellipse([bx1 - ih - hr * 0.18, by1 - ih - hr * 0.24, bx1 + ih - hr * 0.18, by1 + ih - hr * 0.24],
                 fill=tuple(min(255, c + 46) for c in head[:3]) + (150,))
    return (bx1, by1)


def dashed(draw, p0, p1, width, fill, on, off):
    x0, y0 = p0
    x1, y1 = p1
    length = max(1e-6, ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5)
    ux, uy = (x1 - x0) / length, (y1 - y0) / length
    t = 0.0
    while t < length:
        e = min(length, t + on)
        draw.line([(x0 + ux * t, y0 + uy * t), (x0 + ux * e, y0 + uy * e)], fill=fill,
                  width=max(1, int(round(width))))
        t = e + off


def arc_arrow(img, p0, c0, c1, p1, fill, width, head):
    """一段三次贝塞尔搬运箭头：画在自己的图层上（高斯模糊才不会糊到别的笔迹），
    箭头沿末端切线取向，落点就是那根火柴要放下去的格子中心。"""
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer, 'RGBA')
    pts = []
    n = 96
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt ** 3 * p0[0] + 3 * mt * mt * t * c0[0] + 3 * mt * t * t * c1[0] + t ** 3 * p1[0]
        y = mt ** 3 * p0[1] + 3 * mt * mt * t * c0[1] + 3 * mt * t * t * c1[1] + t ** 3 * p1[1]
        pts.append((x, y))
    draw.line(pts, fill=fill, width=width, joint='curve')
    tx, ty = p1[0] - c1[0], p1[1] - c1[1]
    L = max(1e-6, (tx * tx + ty * ty) ** 0.5)
    ux, uy = tx / L, ty / L
    bx, by = p1[0] - ux * head, p1[1] - uy * head
    draw.polygon([p1, (bx - uy * head * 0.42, by + ux * head * 0.42),
                  (bx + uy * head * 0.42, by - ux * head * 0.42)], fill=fill)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(width * 0.18)))


def tileable_noise(size, cell, seed, octaves=3):
    """可平铺的 value noise：格点用取址回绕，所以左右/上下严格接缝一致。"""
    rng = random.Random(seed)
    out = bytearray(size * size * 4)
    grids = []
    for o in range(octaves):
        n = max(2, size // (cell * (2 ** o)))
        g = [[rng.random() for _ in range(n)] for _ in range(n)]
        grids.append((n, g))
    amps = [0.55, 0.3, 0.15][:octaves]
    for y in range(size):
        for x in range(size):
            v = 0.0
            for (n, g), a in zip(grids, amps):
                fx, fy = x * n / size, y * n / size
                x0, y0 = int(fx) % n, int(fy) % n
                x1, y1 = (x0 + 1) % n, (y0 + 1) % n
                tx, ty = fx - int(fx), fy - int(fy)
                sx, sy = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
                v += a * (g[y0][x0] * (1 - sx) * (1 - sy) + g[y0][x1] * sx * (1 - sy)
                          + g[y1][x0] * (1 - sx) * sy + g[y1][x1] * sx * sy)
            i = (y * size + x) * 4
            b = int(118 + 137 * v)
            out[i] = b
            out[i + 1] = b
            out[i + 2] = b
            out[i + 3] = 255
    return Image.frombytes('RGBA', (size, size), bytes(out))


def make_felt(size=256, seed=20261002):
    """毛毡底纹：暖色纤维短划线 + 取址回绕的噪声颗粒 + 经纬暗线。接缝实测连续。"""
    img = Image.new('RGBA', (size, size), FELT + (255,))
    noise = tileable_noise(size, 32, seed).convert('L')
    dark = _sub(mean(noise, 128), noise)    # 噪声低于均值的那一半 => 暗部
    light = _sub(mean(noise, 40), noise)    # 亮部取得更窄，避免底纹发灰
    shade = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    shade.putalpha(dark.point(lambda v: int(v * 0.75)))
    shade = ImageChops.multiply(shade, Image.new('RGBA', (size, size), (6, 4, 2, 255)))
    img.alpha_composite(shade)
    hi = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    hi.putalpha(light.point(lambda v: int(v * 0.42)))
    hi = ImageChops.multiply(hi, Image.new('RGBA', (size, size), (250, 236, 210, 255)))
    img.alpha_composite(hi)

    rng = random.Random(seed + 7)
    fibers = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fibers, 'RGBA')
    for _ in range(int(size * 2.2)):
        x, y = rng.random() * size, rng.random() * size
        a = rng.uniform(0, 6.28318)
        ln = rng.uniform(size * 0.02, size * 0.075)
        tone = rng.choice([(250, 238, 214), (120, 96, 66), (200, 86, 60)])
        al = rng.randint(7, 26)
        # 越界的纤维按 ±size 各画一次，保证平铺后接缝连续
        for ox in (-size, 0, size):
            for oy in (-size, 0, size):
                if abs(ox) + abs(oy) and not (-48 < ox < 48 or -48 < oy < 48):
                    continue
                fd.line([(x + ox, y + oy), (x + ox + ln * 0.92, y + oy + ln * 0.39)],
                        fill=tone + (al,), width=max(1, size // 128))
    img.alpha_composite(fibers)

    weave = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    wd = ImageDraw.Draw(weave, 'RGBA')
    step = size // 8
    for i in range(step, size, step):
        wd.line([(i, 0), (i, size)], fill=(0, 0, 0, 12), width=1)
        wd.line([(0, i), (size, i)], fill=(255, 246, 232, 7), width=1)
    img.alpha_composite(weave)
    return img.convert('RGBA')


def mean(img, k):
    """把灰度图整体上移 k（用于"从噪声里切出高于/低于某条线的部分"）。"""
    return img.point(lambda v: min(255, max(0, v + k)))


def _sub(a, b):
    return ImageChops.subtract(a, b)


def make_ember(size=64):
    """余烬精灵：径向暖光 + 一根斜着的热尾。view.js 用 'lighter' 打点，所以这里
    alpha 就是亮度，边缘必须严格归零（否则平铺/缩放会出现方框）。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')
    r = size * 0.19
    c = size / 2
    for rad, col in ((r * 3.1, (224, 166, 60, 16)), (r * 1.9, (240, 186, 86, 46)),
                     (r * 1.15, (250, 214, 132, 120)), (r * 0.62, (255, 240, 200, 210)),
                     (r * 0.3, (255, 252, 238, 255))):
        d.ellipse([c - rad, c - rad, c + rad, c + rad], fill=col)
    img = img.filter(ImageFilter.GaussianBlur(size * 0.045))
    # 外圈强制透明，确保 0 像素处 alpha=0（平铺接缝与缩放都不出方框）
    edge = Image.new('L', (size, size), 0)
    ed = ImageDraw.Draw(edge)
    ed.ellipse([1, 1, size - 2, size - 2], fill=255)
    a = ImageChops.multiply(img.split()[3], edge)
    img.putalpha(a)
    return img


def draw_glyph(size, maskable=False, detail=True):
    """图标母图：被拿起的琥珀火柴 + 它留下的虚线空位 + 右上锁死的灰等号 + 余烬。

    画在两张画布上是有原因的：所有内容先落在一张**不透明**画布上（半透明底板在白色
    桌面上会发灰——上一版 512 母图背景实测 alpha=140，肉眼读出来就是一块中灰），最后
    用圆角遮罩一次裁出透明角。maskable 版不裁角、内容收进 80% 安全区（Android 啃四周）。
    """
    art = Image.new('RGBA', (size, size), BG2 + (255,))
    d = ImageDraw.Draw(art, 'RGBA')

    # 底板铺满毛毡：与盘上 assets/textures/felt-256.png 同一张纹理，只是缩到图标尺寸
    tile = make_felt(64).resize((size, size), Image.BILINEAR)
    tile.putalpha(tile.split()[3].point(lambda v: int(v * 0.7)))
    art.alpha_composite(tile)
    vign = Image.new('L', (size, size), 0)
    vd = ImageDraw.Draw(vign)
    vd.rectangle([0, 0, size, size], fill=96)
    vd.rounded_rectangle([0, 0, size - 1, size - 1], radius=scaled(size, 210), fill=0)
    dark = Image.new('RGBA', (size, size), (8, 7, 6, 255))
    dark.putalpha(vign)
    art.alpha_composite(dark)

    w = scaled(size, 60 if detail else 96)
    cx, cy = size / 2.0, size / 2.0

    if detail and size >= 96:
        # 等号：两根锁死的灰火柴（游戏里既不能搬走也不能往上放）
        for k in (0, 1):
            yy = cy + scaled(size, -186) + k * scaled(size, 104)
            stick(art, (cx + scaled(size, 214), yy), (cx + scaled(size, 402), yy),
                  w * 0.66, LOCK_A, LOCK_B)
        # 它来的那个空位：盘面上就是虚线段（view.js 的 SLOT）
        dashed(d, (cx - scaled(size, 420), cy + scaled(size, 236)),
               (cx - scaled(size, 70), cy + scaled(size, 236)),
               max(1.0, w * 0.3), (INK[0], INK[1], INK[2], 92),
               scaled(size, 66), scaled(size, 42))

    # 被拿起的那根：斜抬起、头朝右上，正是 onPick 之后手里那一根的样子
    x0, y0 = cx - scaled(size, 392), cy + scaled(size, 128)
    x1, y1 = cx + scaled(size, 150), cy - scaled(size, 152)
    stick(art, (x0, y0), (x1, y1), w, STICK_HOT, HEAD_A, glow=size / 1024.0)

    flame(art, x1, y1, w * 1.5)
    embers(art, x1, y1, size)
    return flatten(art, size, maskable)


def flame(img, hx, hy, r):
    """火苗：头上一枚上挑的水滴 + 一圈收在火头附近的暖光。上一版光晕半径取整张图的
    300/1024，把半个图标糊成琥珀色；现在按火头大小给，最大 2.6 倍。"""
    g = Image.new('RGBA', img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(g, 'RGBA')
    fy = hy - r * 1.1
    for rad, col in ((r * 2.6, (224, 166, 60, 46)), (r * 1.5, (250, 200, 96, 84)),
                     (r * 0.82, (255, 236, 176, 178))):
        gd.ellipse([hx - rad, fy - rad, hx + rad, fy + rad], fill=col)
    gd.ellipse([hx - r * 0.46, fy - r * 0.9, hx + r * 0.46, fy + r * 0.6], fill=(255, 246, 214, 232))
    g = g.filter(ImageFilter.GaussianBlur(r * 0.3))
    img.alpha_composite(g)


def embers(img, hx, hy, size):
    """三颗往上飘的余烬，用与盘上 ember-64.png 同一张精灵打点。"""
    em = make_ember(max(16, int(scaled(size, 96))))
    for (ex, ey, sc, al) in ((0.30, -0.30, 0.62, 235), (0.14, -0.46, 0.42, 160), (0.44, -0.16, 0.34, 120)):
        s2 = max(4, int(scaled(size, 96 * sc)))
        e2 = em.resize((s2, s2), Image.BILINEAR)
        e2.putalpha(e2.split()[3].point(lambda v: int(v * al / 255.0)))
        img.alpha_composite(e2, (int(hx + scaled(size, 1024 * ex) - s2 / 2),
                                 int(hy + scaled(size, 1024 * ey) - s2 / 2)))


def flatten(art, size, maskable):
    """不透明内容 + 圆角遮罩 => 只有四角透明，板体严格 alpha=255。"""
    if maskable:
        return art
    mask = Image.new('L', (size, size), 0)
    md = ImageDraw.Draw(mask)
    pad = scaled(size, 20)
    md.rounded_rectangle([pad, pad, size - pad, size - pad], radius=scaled(size, 200), fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(art, (0, 0), mask)
    return out


def _ink(font, text):
    """把文字渲染成位图数亮像素：这是判断"这款字体到底有没有这个字"的唯一可靠办法
    （getbbox 对 .notdef 也返回一个框，Arial Black 画中文就是一排豆腐块）。"""
    im = Image.new('L', (int(len(text) * 90) + 40, 140), 0)
    ImageDraw.Draw(im).text((8, 8), text, font=font, fill=255)
    px = im.tobytes()
    return sum(px), sum(1 for b in px if b > 8)


def latin_font(px):
    for p in ('/System/Library/Fonts/Supplemental/Arial Black.ttf',
              '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
              '/System/Library/Fonts/Helvetica.ttc',
              '/Library/Fonts/Arial Bold.ttf',
              '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(p, px)
        except Exception:
            continue
    return None


def cjk_font(px):
    """只认"真画得出中文"的字体：拿一个必然不存在的私有区码位当 .notdef 参照，位图
    像素签名与它相同就说明这款字体没有这个字（会画豆腐块）。全找不到返回 None，
    og 卡退化成纯几何 + 拉丁文，绝不因为缺某个 .ttc 而生不出图。"""
    probe = '\uf0ff\uf0fe'
    for p in ('/System/Library/Fonts/PingFang.ttc',
              '/System/Library/Fonts/Hiragino Sans GB.ttc',
              '/System/Library/Fonts/STHeiti Medium.ttc',
              '/System/Library/Fonts/Supplemental/Songti.ttc',
              '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
              '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
              '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'):
        try:
            f = ImageFont.truetype(p, px)
        except Exception:
            continue
        a, b = _ink(f, '火柴等式最少搬数'), _ink(f, probe)
        if a[1] > 400 and a != b:
            return f
    return None


# 七段数码管的段名与数字表（与 js/core/board.js 的段序一致：a 上、b 右上、c 右下、
# d 下、e 左下、f 左上、g 中）。题面不是编的：`9 + 2 + 4 = 3` 是 js/data/lots.js 里
# 真实烤出来的 `single-04`，par=1、proof=exhaustive-1，最短解是把 9 的左上段搬到
# 末尾 3 的左上段（9→3、3→9），得到 `3 + 2 + 4 = 9`。
SEG = {
    'a': (0.14, 0.03, 0.86, 0.03), 'f': (0.08, 0.10, 0.08, 0.46),
    'b': (0.92, 0.10, 0.92, 0.46), 'g': (0.14, 0.50, 0.86, 0.50),
    'e': (0.08, 0.54, 0.08, 0.90), 'c': (0.92, 0.54, 0.92, 0.90),
    'd': (0.14, 0.97, 0.86, 0.97),
}
DIGITS = {
    '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd',
    '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
 }


def draw_digit(img, ch, x, y, w, h, lw, lift=None, target=None, hr=0.9):
    """把一个数字画成一堆火柴；`lift` 给出段名时，那一段被拿起来（画在原位右上方，
    原位留一条虚线空位）—— 这正是游戏里 onPick 之后的样子。`target` 给出段名时，
    原位画一条虚线空位（火柴还没放下来），并把空位中点返回给调用方当箭头落点。"""
    d = ImageDraw.Draw(img, 'RGBA')
    slot = None
    for name in DIGITS[ch]:
        x0, y0, x1, y1 = SEG[name]
        if name == lift:
            dashed(d, (x + x0 * w, y + y0 * h), (x + x1 * w, y + y1 * h),
                   lw * 0.55, (INK[0], INK[1], INK[2], 80), w * 0.16, w * 0.1)
            continue
        stick(img, (x + x0 * w, y + y0 * h), (x + x1 * w, y + y1 * h), lw, STICK, HEAD_A,
              head_r=lw * hr)
    if target and target not in DIGITS[ch]:
        x0, y0, x1, y1 = SEG[target]
        dashed(d, (x + x0 * w, y + y0 * h), (x + x1 * w, y + y1 * h),
               lw * 0.55, (AMBER[0], AMBER[1], AMBER[2], 150), w * 0.16, w * 0.1)
        slot = (x + (x0 + x1) / 2 * w, y + (y0 + y1) / 2 * h)
    if lift:
        x0, y0, x1, y1 = SEG[lift]
        ox, oy = x + x0 * w + w * 0.62, y + y0 * h - h * 0.34
        px, py = x + x1 * w + w * 0.62, y + y1 * h - h * 0.34
        stick(img, (ox, oy), (px, py), lw * 1.15, STICK_HOT, HEAD_A, glow=1,
              head_r=lw * 1.15 * hr)
        flame(img, px, py, lw * 1.7)
        return (px, py)
    return slot


def draw_op(img, op, cx, cy, h, lw, locked=False, span=0.24):
    d = ImageDraw.Draw(img, 'RGBA')
    body, head = (LOCK_A, LOCK_B) if locked else (STICK, HEAD_A)
    if op == '=':
        for k in (-1, 1):
            stick(img, (cx - h * span, cy + k * h * 0.13), (cx + h * span, cy + k * h * 0.13),
                  lw, body, head)
    elif op == '+':
        stick(img, (cx - h * 0.2, cy), (cx + h * 0.2, cy), lw, body, head)
        stick(img, (cx, cy - h * 0.2), (cx, cy + h * 0.2), lw, body, head)
    elif op == '\u2212':
        stick(img, (cx - h * 0.2, cy), (cx + h * 0.2, cy), lw, body, head)
    elif op == '\u00d7':
        stick(img, (cx - h * 0.17, cy - h * 0.17), (cx + h * 0.17, cy + h * 0.17), lw, body, head)
        stick(img, (cx + h * 0.17, cy - h * 0.17), (cx - h * 0.17, cy + h * 0.17), lw, body, head)


def make_og(size=OG_SIZE):
    """社交卡 1200x630：真实题面 + 被拿起的那一根 + 三行说明。中文标题走 cjk_font()
    的实测校验（Arial Black 那类字体画中文是一排豆腐块，这里宁可用拉丁文也不发豆腐）。"""
    w, h = size
    img = Image.new('RGBA', (w, h), BG + (255,))
    tex = make_felt(256).resize((w, h), Image.BILINEAR)
    tex.putalpha(tex.split()[3].point(lambda v: int(v * 0.5)))
    img.alpha_composite(tex)
    d = ImageDraw.Draw(img, 'RGBA')
    d.rounded_rectangle([28, 28, w - 28, h - 28], radius=24, outline=(53, 48, 42, 255), width=2)
    icon = draw_glyph(1024).resize((132, 132), Image.LANCZOS)
    img.alpha_composite(icon, (w - 176, 52))

    # 题面：9 + 2 + 4 = 3（single-04，par 1，穷举量出），route off:5 → on:36
    # 即拿起 9 的 f 段（bit 5，左上竖）放进末位 3 的 f 空位（全局下标 36）。
    dh, dw, gap, opw, hr = 176, 104, 26, 76, 0.62
    y = 150
    x = 84
    head_end = draw_digit(img, '9', x, y, dw, dh, 11, lift='f', hr=hr)
    x += dw + gap
    draw_op(img, '+', x + opw / 2, y + dh / 2, dh, 11)
    x += opw
    draw_digit(img, '2', x, y, dw, dh, 11, hr=hr)
    x += dw + gap
    draw_op(img, '+', x + opw / 2, y + dh / 2, dh, 11)
    x += opw
    draw_digit(img, '4', x, y, dw, dh, 11, hr=hr)
    x += dw + gap
    draw_op(img, '=', x + opw / 2, y + dh / 2, dh, 11, locked=True, span=0.17)
    x += opw
    dest = draw_digit(img, '3', x, y, dw, dh, 11, target='f', hr=hr)

    f_title, f_body, f_small = cjk_font(66), cjk_font(27), cjk_font(23)
    latin = latin_font(30)
    if f_title:
        d.text((84, 372), '火柴等式', font=f_title, fill=INK + (255,))
        tw = 84 + f_title.getlength('火柴等式') + 22
        if latin:
            d.text((tw, 404), 'MATCHWORK', font=latin, fill=AMBER + (255,))
    elif latin:
        d.text((84, 386), 'MATCHWORK', font=latin, fill=INK + (255,))
    lines = ([
        '一手搬法 = 拿起一根 + 放到一个空位上；等号那两根锁死，搬不走也放不下。',
        '每一题的「最少搬数」都是合法版面图上穷举量出来的：跑不完就不印数字。',
        '题面 9 + 2 + 4 = 3 是题库里的 single-04，par 1，proof exhaustive-1。',
    ] if f_body else [
        'A move = lift one match, drop it in an empty slot. The equals sign is locked.',
        'Every par is measured by complete enumeration of the legal-board graph.',
        'Shown above: single-04 from the baked library, par 1, proof exhaustive-1.',
    ])
    for i, line in enumerate(lines):
        d.text((84, 452 + i * 36), line, font=f_body or latin, fill=(163, 150, 138, 255))
    if f_small:
        foot = 'z-biz-game · 无服务器 · 成绩只在本机'
        d.text((w - 60 - f_small.getlength(foot), h - 54), foot, font=f_small,
               fill=(111, 101, 88, 255))
    # 搬的路线：从被拿起的那根出发，贴着等式上方的空带走一个弧，竖直落到末位的虚线
    # 空位上（直接连线会横穿中间的加号和 2，看起来像"划掉"而不是"搬运"）。
    if head_end and dest:
        arc_arrow(img, (head_end[0] + 6, head_end[1] - 4),
                  (head_end[0] + 90, 78), (dest[0] - 90, 78), (dest[0], dest[1] - 4),
                  AMBER + (205,), 5, 22)
    return img.convert('RGB')


def build(out=sys.stdout):
    made = []
    icon_dir = ICON_DIR
    os.makedirs(icon_dir, exist_ok=True)
    os.makedirs(TEX_DIR, exist_ok=True)
    os.makedirs(OG_DIR, exist_ok=True)

    mother = draw_glyph(1024)
    mother.save(os.path.join(icon_dir, 'icon-1024.png'), optimize=True)
    for s in ICON_SIZES[:-1]:
        im = mother.resize((s, s), Image.LANCZOS)
        im.save(os.path.join(icon_dir, 'icon-%d.png' % s), optimize=True)
    shutil.copyfile(os.path.join(icon_dir, 'icon-32.png'), os.path.join(icon_dir, 'favicon-32.png'))
    shutil.copyfile(os.path.join(icon_dir, 'icon-16.png'), os.path.join(icon_dir, 'favicon-16.png'))
    shutil.copyfile(os.path.join(icon_dir, 'icon-180.png'), os.path.join(icon_dir, 'apple-touch-icon.png'))
    draw_glyph(512, maskable=True).save(os.path.join(icon_dir, 'maskable-512.png'), optimize=True)

    felt = make_felt(256)
    felt.save(os.path.join(TEX_DIR, 'felt-256.png'), optimize=True)
    make_ember(64).save(os.path.join(TEX_DIR, 'ember-64.png'), optimize=True)
    make_og().save(os.path.join(OG_DIR, OG_NAME), optimize=True)

    for rel, (w, h) in sorted(EXPECTED.items()):
        p = os.path.join(REPO, rel)
        img = Image.open(p)
        img.verify()
        print('%-34s %4dx%-4d %8d B  %s' % (rel, w, h, os.path.getsize(p),
                                            hashlib.sha256(open(p, 'rb').read()).hexdigest()[:12]), file=out)
        made.append(rel)
    return made


def check():
    bad = []
    for rel, (w, h) in sorted(EXPECTED.items()):
        p = os.path.join(REPO, rel)
        if not os.path.exists(p):
            bad.append('%s 缺失' % rel)
            continue
        if os.path.getsize(p) == 0:
            bad.append('%s 是 0 字节' % rel)
            continue
        try:
            with open(p, 'rb') as fh:
                head = fh.read(33)
            if head[:8] != b'\x89PNG\r\n\x1a\n':
                bad.append('%s 不是 PNG 签名' % rel)
                continue
            dw, dh = struct.unpack('>II', head[16:24])
            if head[24:25] != b'\x08':
                bad.append('%s 位深不是 8bit' % rel)
            if head[25:26] not in (b'\x00', b'\x02', b'\x03', b'\x04', b'\x06'):
                bad.append('%s 色彩类型异常' % rel)
            if (dw, dh) != (w, h):
                bad.append('%s 实测 %dx%d，应为 %dx%d' % (rel, dw, dh, w, h))
        except Exception as exc:
            bad.append('%s 读 IHDR 失败: %s' % (rel, exc))
    # 脚本比资产新 ⇒ 资产可能是手改的旧图（不是当前母题画出来的）
    newest_src = max(os.path.getmtime(os.path.join(REPO, rel)) for rel in EXPECTED)
    gen = os.path.getmtime(os.path.abspath(__file__))
    if gen > newest_src + 1:
        bad.append('assets/gen/make_art.py 比全部资产新 ⇒ 资产未重画')
    if bad:
        print('CHECK FAIL:')
        for b in bad:
            print('  - ' + b)
        return 1
    print('CHECK OK: %d 张位图全部为真实 PNG 且宽高符合清单' % len(EXPECTED))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--check', action='store_true', help='只校验盘上资产，不重画')
    ap.add_argument('--only', choices=('icons', 'textures', 'og'), help='只重画一类')
    a = ap.parse_args()
    if a.check:
        sys.exit(check())
    if a.only == 'icons':
        os.makedirs(ICON_DIR, exist_ok=True)
        mother = draw_glyph(1024)
        mother.save(os.path.join(ICON_DIR, 'icon-1024.png'), optimize=True)
        for s in ICON_SIZES[:-1]:
            mother.resize((s, s), Image.LANCZOS).save(os.path.join(ICON_DIR, 'icon-%d.png' % s), optimize=True)
        print('icons ok')
        return
    if a.only == 'textures':
        os.makedirs(TEX_DIR, exist_ok=True)
        make_felt(256).save(os.path.join(TEX_DIR, 'felt-256.png'), optimize=True)
        make_ember(64).save(os.path.join(TEX_DIR, 'ember-64.png'), optimize=True)
        print('textures ok')
        return
    if a.only == 'og':
        os.makedirs(OG_DIR, exist_ok=True)
        make_og().save(os.path.join(OG_DIR, OG_NAME), optimize=True)
        print('og ok')
        return
    build()


if __name__ == '__main__':
    main()
