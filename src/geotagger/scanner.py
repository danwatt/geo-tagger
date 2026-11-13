import hashlib
import os
from pathlib import Path
from geotagger.config import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, CACHE_DIR_NAME


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


def walk_media(root: Path, cancel=None, unreadable: list[str] | None = None):
    """Yield (path, media_type, xmp_names) for every supported file under root, in
    ONE tree walk that never enters the cache directory.

    The old rglob("*") enumerated everything under .geotagger (the thumbnail cache,
    easily hundreds of thousands of small files) and only then discarded it, and it
    ran twice per scan. Here the directory is pruned before it is listed.

    `xmp_names` is the casefolded set of .xmp file names in the file's own
    directory (shared by every file there). Callers use it as a cheap negative
    test for "this file has no sidecar", saving a stat per file; a casefolded
    miss is a miss on case-insensitive filesystems too, so only a hit still needs
    the real stat.

    Like rglob it lists symlinks (a link to a media file is yielded) but never
    descends into a symlinked directory, and an unreadable directory is skipped,
    not fatal. `cancel` is checked once per directory so a cancelled scan stops
    walking promptly.

    `unreadable`, if given, collects the path of every directory that could not
    be listed (the root included). Skipping one is harmless for indexing but not
    for pruning: its files went unseen, which must not read as "deleted"."""
    stack = [str(root)]
    while stack:
        if cancel is not None and cancel.is_set():
            return
        dir_path = stack.pop()
        files: list[tuple[str, str]] = []  # (path, ext) of media candidates
        xmp: set[str] = set()
        try:
            with os.scandir(dir_path) as it:
                for entry in it:
                    name = entry.name
                    if name == CACHE_DIR_NAME:
                        continue  # prune: never list the cache dir's contents
                    try:
                        is_dir = entry.is_dir(follow_symlinks=False)
                    except OSError:
                        is_dir = False
                    if is_dir:
                        stack.append(entry.path)
                        continue
                    ext = os.path.splitext(name)[1].lower()
                    if ext == ".xmp":
                        xmp.add(name.casefold())
                    elif ext in IMAGE_EXTENSIONS or ext in VIDEO_EXTENSIONS:
                        files.append((entry.path, ext))
        except OSError:
            # PermissionError etc.: skip this directory, keep walking
            if unreadable is not None:
                unreadable.append(dir_path)
            continue
        xmp_names = frozenset(xmp)
        for path, ext in files:
            yield Path(path), ("image" if ext in IMAGE_EXTENSIONS else "video"), xmp_names


def iter_media(root: Path):
    """Yield (path, media_type) for all supported files under root."""
    for p, media_type, _ in walk_media(root):
        yield p, media_type


def find_sidecar_collisions(media: list[tuple[Path, str]]) -> list[str]:
    """Warn about image files sharing a basename.xmp sidecar in the same directory.
    Takes an already-walked (path, media_type) list so a scan doesn't walk twice.

    Videos are left out on purpose: one that shares a stem with an image (a Live
    Photo pair) gets its own IMG_1.MOV.xmp from sidecar.sidecar_path, so it no
    longer collides; a pair that used to share is split, and warned about, by
    scanning._split_legacy_shared_sidecars."""
    from collections import defaultdict
    stem_map: dict[Path, list[Path]] = defaultdict(list)
    for p, _ in media:
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


def detect_sidecar_collisions(root: Path) -> list[str]:
    return find_sidecar_collisions([(p, t) for p, t in iter_media(root)])
