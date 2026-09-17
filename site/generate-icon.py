#!/usr/bin/env python3
"""Generate the Botcaptcha mark: a 3x3 challenge grid on Paper.

Ink tiles with one focus-blue tile at center, supersampled 4x for smooth
rounded corners. No third-party dependencies; writes icon.png and
apple-icon.png next to this script. Record the SHA-256 of each output in
BRAND_ASSETS.md after regeneration.
"""

import struct
import zlib
from pathlib import Path

PAPER = (0xF8, 0xF7, 0xF4)
INK = (0x1C, 0x19, 0x17)
BLUE = (0x1F, 0x5E, 0xEA)
SUPERSAMPLE = 4


def write_png(path: Path, size: int, pixels: bytearray) -> None:
    rows = b"".join(
        b"\x00" + bytes(pixels[y * size * 3 : (y + 1) * size * 3])
        for y in range(size)
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data))
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def inside_rounded(px: float, py: float, x0: float, y0: float, t: float, r: float) -> bool:
    cx = min(max(px, x0 + r), x0 + t - r)
    cy = min(max(py, y0 + r), y0 + t - r)
    return (px - cx) * (px - cx) + (py - cy) * (py - cy) <= r * r


def render(size: int) -> bytearray:
    s = size * SUPERSAMPLE
    img = bytearray(PAPER * (s * s))
    margin = s * 0.09
    tile = s * 0.24
    gap = (s - 2 * margin - 3 * tile) / 2
    radius = tile * 0.22
    for row in range(3):
        for col in range(3):
            x0 = margin + col * (tile + gap)
            y0 = margin + row * (tile + gap)
            color = BLUE if (row, col) == (1, 1) else INK
            for y in range(int(y0), int(y0 + tile)):
                py = y + 0.5
                base = y * s * 3
                for x in range(int(x0), int(x0 + tile)):
                    if inside_rounded(x + 0.5, py, x0, y0, tile, radius):
                        off = base + x * 3
                        img[off : off + 3] = bytes(color)
    out = bytearray(size * size * 3)
    for y in range(size):
        for x in range(size):
            r = g = b = 0
            for sy in range(SUPERSAMPLE):
                row = (y * SUPERSAMPLE + sy) * s * 3
                for sx in range(SUPERSAMPLE):
                    off = row + (x * SUPERSAMPLE + sx) * 3
                    r += img[off]
                    g += img[off + 1]
                    b += img[off + 2]
            n = SUPERSAMPLE * SUPERSAMPLE
            o = (y * size + x) * 3
            out[o : o + 3] = bytes((r // n, g // n, b // n))
    return out


def main() -> None:
    here = Path(__file__).parent
    for name, size in (("icon.png", 512), ("apple-icon.png", 180)):
        write_png(here / name, size, render(size))
        print(f"wrote {name} ({size}x{size})")


if __name__ == "__main__":
    main()
