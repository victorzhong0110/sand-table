#!/usr/bin/env python3
"""生成 Sand Table 桌面版图标。

一块暖色纸面上的沙盘：点阵是台面，三张卡片里有一张是 AI 正在写的那张。
配色取自白板界面本身（纸面 #f6f1e6、赭石 #b67547、描边 #ddd5c4）。

用法：python3 desktop/scripts/make-icon.py
产出：desktop/build/icon.png（1024）与 desktop/build/icon.ico（多尺寸）。
"""

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(os.path.dirname(HERE), "build")

S = 1024
PAPER = (241, 231, 215)
PAPER_EDGE = (214, 199, 176)
DOT = (203, 184, 156)
CARD = (255, 253, 247)
CARD_EDGE = (221, 213, 196)
ACCENT = (182, 117, 71)
ACCENT_SOFT = (214, 166, 121)
INK = (50, 47, 40)


def rounded(draw, box, radius, fill=None, outline=None, width=0):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def main():
    image = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(image)

    # 底板
    rounded(d, (16, 16, S - 16, S - 16), 200, fill=PAPER, outline=PAPER_EDGE, width=10)

    # 台面点阵
    for gx in range(150, S - 110, 104):
        for gy in range(150, S - 110, 104):
            d.ellipse((gx - 9, gy - 9, gx + 9, gy + 9), fill=DOT)

    # 关系连线：一张卡连到另一张卡
    d.line((330, 300, 640, 470), fill=ACCENT_SOFT, width=14)

    # 左侧大卡：人写的卡片
    rounded(d, (196, 214, 470, 400), 28, fill=CARD, outline=CARD_EDGE, width=8)
    d.rounded_rectangle((228, 254, 396, 276), radius=11, fill=INK)
    d.rounded_rectangle((228, 300, 360, 318), radius=9, fill=(196, 186, 168))
    d.rounded_rectangle((228, 338, 384, 356), radius=9, fill=(196, 186, 168))

    # 右侧赭石卡：AI 正在写的卡片
    rounded(d, (612, 420, 852, 570), 26, fill=ACCENT)
    d.rounded_rectangle((644, 452, 772, 472), radius=10, fill=(255, 250, 244))
    d.rounded_rectangle((644, 492, 812, 510), radius=9, fill=ACCENT_SOFT)
    d.rounded_rectangle((644, 524, 742, 542), radius=9, fill=ACCENT_SOFT)

    # 下方小卡
    rounded(d, (232, 520, 452, 664), 24, fill=CARD, outline=CARD_EDGE, width=8)
    d.rounded_rectangle((262, 552, 396, 572), radius=10, fill=INK)
    d.rounded_rectangle((262, 596, 366, 614), radius=9, fill=(196, 186, 168))

    os.makedirs(BUILD, exist_ok=True)
    # 窗口图标用 512 的 PNG，安装器与快捷方式用多尺寸 ICO。
    image.resize((512, 512), Image.LANCZOS).save(os.path.join(BUILD, "icon.png"))
    image.save(
        os.path.join(BUILD, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("wrote", os.path.join(BUILD, "icon.png"))
    print("wrote", os.path.join(BUILD, "icon.ico"))


if __name__ == "__main__":
    main()
