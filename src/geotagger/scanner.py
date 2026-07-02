import hashlib
from pathlib import Path
from geotagger.config import ALL_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, CACHE_DIR_NAME


def file_checksum(path: Path, _chunk: int = 1 << 20) -> str:
    """SHA-256 hex digest of a file's bytes, read in 1 MiB chunks so a large
    video never lands in memory whole. Originals are immutable, so the digest is
    stable until the file itself changes — hence it's only (re)computed when a
    file is first indexed or its mtime/size moves (see is_fresh)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_chunk), b""):
            h.update(chunk)
    return h.hexdigest()


def iter_media(root: Path):
    """Yield (path, media_type) for all supported files under root."""
    for p in root.rglob("*"):
        # Skip cache dir and sidecar files
        if CACHE_DIR_NAME in p.parts:
            continue
        if p.suffix.lower() == ".xmp":
            continue
        ext = p.suffix.lower()
        if ext in IMAGE_EXTENSIONS:
            yield p, "image"
        elif ext in VIDEO_EXTENSIONS:
            yield p, "video"


def detect_sidecar_collisions(root: Path) -> list[str]:
    """Warn about files sharing a basename.xmp sidecar in the same directory."""
    from collections import defaultdict
    stem_map: dict[Path, list[Path]] = defaultdict(list)
    for p, _ in iter_media(root):
        if p.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        stem_map[p.parent / p.stem].append(p)
    warnings = []
    for stem_path, files in stem_map.items():
        if len(files) > 1:
            names = ", ".join(f.name for f in files)
            warnings.append(
                f"Sidecar collision: {names} in {stem_path.parent} share {stem_path.name}.xmp"
            )
    return warnings
