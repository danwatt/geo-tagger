"""Numbered contact sheets of the cached images, used to hand-label ground truth.

    uv run python -m bench.contact
"""
from PIL import Image, ImageDraw

from bench.common import CACHE, THUMB_DIR, load_manifest

COLS, ROWS, CELL = 6, 5, 240


def main() -> None:
    m = load_manifest()
    per = COLS * ROWS
    out = CACHE / "contact"
    out.mkdir(exist_ok=True)
    for s in range(0, len(m), per):
        sheet = Image.new("RGB", (COLS * CELL, ROWS * CELL), "black")
        d = ImageDraw.Draw(sheet)
        for k, item in enumerate(m[s:s + per]):
            im = Image.open(THUMB_DIR / f"{item['id']}.jpg")
            im.thumbnail((CELL - 6, CELL - 26))
            x, y = (k % COLS) * CELL, (k // COLS) * CELL
            sheet.paste(im, (x + 3, y + 22))
            d.rectangle([x, y, x + 60, y + 20], fill="yellow")
            d.text((x + 4, y + 3), str(s + k), fill="black", font_size=16)
        path = out / f"sheet_{s // per:02d}.jpg"
        sheet.save(path, quality=85)
        print(path)


if __name__ == "__main__":
    main()
