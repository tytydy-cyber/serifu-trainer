#!/usr/bin/env python3
"""PWA用アイコンPNGを生成する（Python標準ライブラリのみ）。

台本のページ＋ハイライトされた1行（自分のセリフ）をモチーフにしたアイコン。
使い方: python3 scripts/gen_icons.py
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"

BG = (21, 20, 26, 255)        # --bg
PAGE = (236, 233, 242, 255)   # --text (クリーム系)
LINE = (111, 106, 126, 255)   # --text-faint 相当（地の文の線）
HILITE = (224, 164, 92, 255)  # --accent（自分のセリフのハイライト）


def write_png(path, size, pixels):
    def chunk(typ, data):
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = bytearray()
    row = size * 4
    for y in range(size):
        raw.append(0)
        raw += pixels[y * row : (y + 1) * row]
    idat = zlib.compress(bytes(raw), 9)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    )


def blend(px, s, x, y, color, cover):
    if cover <= 0:
        return
    i = (y * s + x) * 4
    if cover >= 1:
        px[i:i + 4] = bytes(color)
        return
    for c in range(4):
        px[i + c] = int(px[i + c] * (1 - cover) + color[c] * cover)


def rounded_rect_cover(cx, cy, x0, y0, x1, y1, r):
    if x0 <= cx <= x1 and y0 <= cy <= y1:
        if cx < x0 + r and cy < y0 + r:
            return 1.0 if (cx - (x0 + r)) ** 2 + (cy - (y0 + r)) ** 2 <= r * r else 0.0
        if cx > x1 - r and cy < y0 + r:
            return 1.0 if (cx - (x1 - r)) ** 2 + (cy - (y0 + r)) ** 2 <= r * r else 0.0
        if cx < x0 + r and cy > y1 - r:
            return 1.0 if (cx - (x0 + r)) ** 2 + (cy - (y1 - r)) ** 2 <= r * r else 0.0
        if cx > x1 - r and cy > y1 - r:
            return 1.0 if (cx - (x1 - r)) ** 2 + (cy - (y1 - r)) ** 2 <= r * r else 0.0
        return 1.0
    return 0.0


def render(size, safe):
    s = size
    px = bytearray(BG * (s * s))

    page_x0, page_y0 = s * safe, s * safe * 0.85
    page_x1, page_y1 = s * (1 - safe), s * (1 - safe * 0.85)
    page_r = s * 0.05

    line_h = (page_y1 - page_y0) * 0.10
    gap = (page_y1 - page_y0) * 0.06
    line_x0 = page_x0 + (page_x1 - page_x0) * 0.14
    widths = [0.72, 0.55, 0.85, 0.40]
    hilite_row = 2

    for y in range(s):
        cy = y + 0.5
        for x in range(s):
            cx = x + 0.5
            cover = rounded_rect_cover(cx, cy, page_x0, page_y0, page_x1, page_y1, page_r)
            if cover > 0:
                blend(px, s, x, y, PAGE, cover)
                for row, w in enumerate(widths):
                    ly0 = page_y0 + (page_y1 - page_y0) * 0.16 + row * (line_h + gap)
                    ly1 = ly0 + line_h
                    lx1 = line_x0 + (page_x1 - page_x0) * 0.72 * w
                    if line_x0 <= cx <= lx1 and ly0 <= cy <= ly1:
                        color = HILITE if row == hilite_row else LINE
                        blend(px, s, x, y, color, 1.0)
    return px


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        write_png(OUT / f"icon-{size}.png", size, render(size, 0.14))
    write_png(OUT / "icon-maskable-512.png", 512, render(512, 0.26))
    write_png(OUT / "apple-touch-icon.png", 180, render(180, 0.14))
    write_png(OUT / "favicon-32.png", 32, render(32, 0.10))
    for p in sorted(OUT.glob("*.png")):
        print(p.relative_to(OUT.parent), p.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
