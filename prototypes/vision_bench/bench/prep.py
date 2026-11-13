"""Decode the sample folder once into upright 1024px JPEGs + 256px thumbs.

Every model then reads identical pixels, so timings measure the model, not RAW
decoding. RAWs use the embedded JPEG preview (same as the main app's fast path);
orientation comes from one batched ExifTool call because the embedded preview of a
NEF is stored in sensor orientation without its own tag.

    uv run python -m bench.prep [SOURCE_DIR]
"""
from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageOps

from bench.common import DEFAULT_SOURCE, EXIFTOOL, IMG_DIR, MANIFEST, THUMB_DIR, write_json

EXTS = {".jpg", ".jpeg", ".png", ".nef", ".dng", ".tif", ".tiff", ".heic"}
RAW = {".nef", ".dng"}

# EXIF orientation -> PIL transpose ops
_ORIENT = {
    2: [Image.Transpose.FLIP_LEFT_RIGHT], 3: [Image.Transpose.ROTATE_180],
    4: [Image.Transpose.FLIP_TOP_BOTTOM], 5: [Image.Transpose.TRANSPOSE],
    6: [Image.Transpose.ROTATE_270], 7: [Image.Transpose.TRANSVERSE],
    8: [Image.Transpose.ROTATE_90],
}


def _orientations(files: list[Path]) -> dict[str, int]:
    args = [str(EXIFTOOL), "-charset", "filename=utf8", "-j", "-n", "-Orientation", "-DateTimeOriginal"]
    out = subprocess.run(args + [str(f) for f in files], capture_output=True, check=False)
    rows = json.loads(out.stdout.decode("utf-8") or "[]")
    return {str(Path(r["SourceFile"])).lower(): int(r.get("Orientation") or 1) for r in rows}


def _open(path: Path) -> Image.Image:
    if path.suffix.lower() in RAW:
        import rawpy
        with rawpy.imread(str(path)) as raw:
            thumb = raw.extract_thumb()
        if thumb.format == rawpy.ThumbFormat.JPEG:
            return Image.open(io.BytesIO(thumb.data))
        return Image.fromarray(thumb.data)
    if path.suffix.lower() == ".heic":
        import pillow_heif
        pillow_heif.register_heif_opener()
    return Image.open(path)


def main(source: str) -> None:
    src = Path(source)
    files = sorted(p for p in src.rglob("*") if p.suffix.lower() in EXTS)
    print(f"{len(files)} images in {src}")
    orient = _orientations(files)
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []
    t0 = time.time()
    for n, f in enumerate(files, 1):
        iid = hashlib.sha1(str(f).encode()).hexdigest()[:12]
        out = IMG_DIR / f"{iid}.jpg"
        if not out.exists():
            try:
                img = _open(f)
                if f.suffix.lower() in RAW:
                    for op in _ORIENT.get(orient.get(str(f).lower(), 1), []):
                        img = img.transpose(op)
                else:
                    img = ImageOps.exif_transpose(img)
                img = img.convert("RGB")
                img.thumbnail((1024, 1024), Image.LANCZOS)
                img.save(out, quality=92)
                img.thumbnail((256, 256), Image.LANCZOS)
                img.save(THUMB_DIR / f"{iid}.jpg", quality=85)
            except Exception as e:
                print(f"  skip {f.name}: {e}")
                continue
        manifest.append({"id": iid, "name": f.name, "path": str(f)})
        if n % 25 == 0:
            print(f"  {n}/{len(files)}")
    write_json(MANIFEST, manifest)
    print(f"done: {len(manifest)} images in {time.time() - t0:.1f}s -> {MANIFEST}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE)
