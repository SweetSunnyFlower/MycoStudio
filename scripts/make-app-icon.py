#!/usr/bin/env python3
"""把一张方形图做成 macOS 风格的应用图标：圆角方 + 透明外边距。

macOS 的 Dock/Finder 不会给图标自动加圆角，圆角必须画在图里，
而且图标画布需要留出外边距（作品占画布的 ~80%），否则会比其他应用显得大一圈。

用法：
    python3 -m pip install Pillow
    python3 scripts/make-app-icon.py logo.png src-tauri/app-icon.png
    npx tauri icon src-tauri/app-icon.png
"""

import sys

from PIL import Image, ImageDraw

CANVAS = 1024  # 图标画布边长
ART = 824  # macOS 图标里圆角方的边长（1024 画布留 100px 边距）
MARGIN = (CANVAS - ART) // 2
RADIUS = round(ART * 0.2237)  # 圆角半径 ≈ 圆角方边长的 22.4%
SUPERSAMPLE = 4  # 超采样倍数，遮罩放大后再缩小以获得平滑边缘


def main(src_path: str, out_path: str) -> None:
    src = Image.open(src_path).convert("RGBA")
    # 先按短边居中裁成正方形
    side = min(src.size)
    left = (src.width - side) // 2
    top = (src.height - side) // 2
    art = src.crop((left, top, left + side, top + side)).resize((ART, ART), Image.LANCZOS)

    mask = Image.new("L", (ART * SUPERSAMPLE, ART * SUPERSAMPLE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, ART * SUPERSAMPLE - 1, ART * SUPERSAMPLE - 1],
        radius=RADIUS * SUPERSAMPLE,
        fill=255,
    )
    mask = mask.resize((ART, ART), Image.LANCZOS)

    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.paste(art, (MARGIN, MARGIN), mask)
    out.save(out_path)
    print(f"已生成 {out_path}: {CANVAS}x{CANVAS}，圆角半径 {RADIUS}px，外边距 {MARGIN}px")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
