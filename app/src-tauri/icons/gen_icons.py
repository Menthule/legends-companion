#!/usr/bin/env python3
"""Generate the EQLogs placeholder icon set (RGBA PNGs + .ico) with no deps.

Design: dark rounded square, gold ring, gold "sword" diagonal — placeholder
until real art exists. Tauri requires RGBA PNGs and icons/icon.ico.

Run from this directory:  python3 gen_icons.py
"""

import struct
import zlib
from pathlib import Path

BG = (20, 22, 26, 255)        # --bg
GOLD = (212, 162, 74, 255)    # --accent
DIM = (138, 108, 52, 255)     # --accent-dim
CLEAR = (0, 0, 0, 0)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data))
    )


def png(size: int) -> bytes:
    w = h = size
    c = (size - 1) / 2
    r_outer = size * 0.47
    r_ring = size * 0.38
    ring_w = max(1.5, size * 0.045)
    corner = size * 0.18
    sword_w = max(1.0, size * 0.05)

    def pixel(x: int, y: int):
        # Rounded-square mask.
        dx = max(abs(x - c) - (c - corner), 0)
        dy = max(abs(y - c) - (c - corner), 0)
        if (dx * dx + dy * dy) ** 0.5 > corner - 0.5 and (
            abs(x - c) > c - 0.5 or abs(y - c) > c - 0.5
        ):
            return CLEAR
        if (dx * dx + dy * dy) ** 0.5 > corner:
            return CLEAR
        d = ((x - c) ** 2 + (y - c) ** 2) ** 0.5
        if d > r_outer:
            return BG
        # Gold ring.
        if abs(d - r_ring) < ring_w:
            return GOLD
        # Diagonal "sword" stroke inside the ring.
        if d < r_ring - ring_w:
            u = (x - c) + (y - c)   # perpendicular distance-ish to the diagonal
            v = (x - c) - (y - c)
            if abs(u) < sword_w * 2 and abs(v) < r_ring * 1.4:
                return GOLD
            # Crossguard.
            if abs(v - r_ring * 0.5) < sword_w * 1.2 and abs(u) < r_ring * 0.55:
                return DIM
        return BG

    raw = b""
    for y in range(h):
        raw += b"\x00"
        for x in range(w):
            raw += bytes(pixel(x, y))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico(png_bytes: bytes, size: int) -> bytes:
    # Single PNG-compressed entry (valid on Windows Vista+).
    b = 0 if size >= 256 else size
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", b, b, 0, 0, 1, 32, len(png_bytes), 22)
    return header + entry + png_bytes


def main() -> None:
    here = Path(__file__).parent
    sizes = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }
    for name, size in sizes.items():
        (here / name).write_bytes(png(size))
        print(f"wrote {name} ({size}x{size})")
    (here / "icon.ico").write_bytes(ico(png(256), 256))
    print("wrote icon.ico (256x256 PNG entry)")


if __name__ == "__main__":
    main()
