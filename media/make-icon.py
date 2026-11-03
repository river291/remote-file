"""生成插件图标 media/icon.png（128×128，市场要求 PNG 且不小于 128×128）。

设计：VSCode 蓝渐变圆角方块 + 白色上下双向箭头，表达"本地 ↔ 远程 传输"。
改完跑一遍：python media/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 128
RADIUS = 27
TOP = (0x1F, 0x9C, 0xF0)  # 亮一点的蓝
BOTTOM = (0x0B, 0x5C, 0xA8)  # 深蓝

OUT = Path(__file__).with_name("icon.png")


def main() -> None:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # 竖向渐变
    gradient = Image.new("RGB", (SIZE, SIZE))
    pen = ImageDraw.Draw(gradient)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        pen.line(
            [(0, y), (SIZE, y)],
            fill=tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)),
        )

    # 圆角遮罩
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)
    image.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(image)
    white = (255, 255, 255, 255)

    # 左：向上箭头（上传）
    draw.rounded_rectangle([40, 44, 54, 98], radius=7, fill=white)
    draw.polygon([(47, 26), (29, 54), (65, 54)], fill=white)

    # 右：向下箭头（下载）
    draw.rounded_rectangle([74, 30, 88, 84], radius=7, fill=white)
    draw.polygon([(81, 102), (63, 74), (99, 74)], fill=white)

    image.save(OUT, "PNG")
    print(f"已生成 {OUT}（{SIZE}x{SIZE}）")


if __name__ == "__main__":
    main()
