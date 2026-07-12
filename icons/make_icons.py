#!/usr/bin/env python
"""Generate Black Ink PWA icons from the brand mark (line-chart on blue).

Run:  python icons/make_icons.py
Produces PNG icons in the icons/ folder. Re-run any time to regenerate.
"""
import os
from PIL import Image, ImageDraw

BLUE = (37, 99, 235)      # --blue  #2563eb
BLUE_DK = (29, 78, 216)   # --blue-2 #1d4ed8
WHITE = (255, 255, 255)
HERE = os.path.dirname(os.path.abspath(__file__))

# Brand mark geometry, on a 24x24 viewBox:
#   axes:  M3 3 v18 h18   (down the left, across the bottom)
#   line:  M7 14 l4 -4 3 3 5 -6   ->  (7,14)(11,10)(14,13)(19,7)
AXES = [(3, 3), (3, 21), (21, 21)]
LINE = [(7, 14), (11, 10), (14, 13), (19, 7)]


def draw_mark(size, padding_ratio, bg=True, radius_ratio=0.22):
    """Render the mark centered on a rounded blue tile at `size` px.
    padding_ratio: fraction of the tile kept empty around the 24x24 art
    (use ~0.10 for regular, ~0.20 for maskable safe-zone)."""
    scale = 4  # supersample for smooth edges
    S = size * scale
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if bg:
        r = int(S * radius_ratio)
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=BLUE)

    pad = S * padding_ratio
    art = S - 2 * pad
    u = art / 24.0  # px per viewBox unit

    def T(p):
        return (pad + p[0] * u, pad + p[1] * u)

    stroke = max(2, int(2.2 * u))
    col = WHITE

    def polyline(pts):
        tp = [T(p) for p in pts]
        d.line(tp, fill=col, width=stroke, joint="curve")
        r = stroke / 2.0
        for x, y in tp:
            d.ellipse([x - r, y - r, x + r, y + r], fill=col)

    polyline(AXES)
    polyline(LINE)

    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    path = os.path.join(HERE, name)
    img.save(path)
    print("wrote", os.path.relpath(path, os.path.dirname(HERE)), img.size)


def main():
    # Standard "any" icons — modest padding, rounded tile.
    for sz in (192, 512):
        save(draw_mark(sz, padding_ratio=0.20), f"icon-{sz}.png")
    # Maskable icons — extra safe-zone padding so platform masks don't clip.
    for sz in (192, 512):
        save(draw_mark(sz, padding_ratio=0.28), f"icon-maskable-{sz}.png")
    # Apple touch icon (iOS applies its own rounding; keep a full bleed tile).
    save(draw_mark(180, padding_ratio=0.20, radius_ratio=0.0), "apple-touch-icon.png")
    # Favicons.
    save(draw_mark(32, padding_ratio=0.14), "favicon-32.png")
    save(draw_mark(16, padding_ratio=0.12), "favicon-16.png")


if __name__ == "__main__":
    main()
