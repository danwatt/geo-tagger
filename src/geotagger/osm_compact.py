"""Shrink a cached GeoFabrik .osm.pbf down to the objects this app can use.

A raw state extract is ~90% things nothing here ever reads: unnamed building
footprints, driveways and sidewalks, untagged landuse, power lines, turn
restrictions, plus version/timestamp/changeset metadata on every object. Dropping
them takes Colorado from 375 MB to under 50 MB and makes every later pass over the
file (places merge, street search) several times faster — with byte-identical
results from both consumers, because the keep rules below are a superset of what
they read:

  osm_builder.classify()  — named areas (closed ways, multipolygon/boundary relations)
  osm_streets.search()    — highway ways with a name or ref

On top of that, named features nothing reads *yet* are kept so a future feature
(rivers, lakes, peaks, points of interest) doesn't need every extract downloaded
again: see FEATURE_KEYS.

Geometry is never simplified — vertex-dropping broke area assembly for a handful
of polygons in testing (lost places), for a much smaller win than the filtering.

Framework-free, like osm_builder: used by services/data_service.py right after a
download and by scripts/compact_osm_pbf.py for extracts already in the cache.

OSM data © OpenStreetMap contributors, ODbL.
"""

import logging
import os
import time
from pathlib import Path
from typing import Callable

import osmium

from geotagger.osm_builder import classify
from geotagger.osm_streets import PATH_HIGHWAY_VALUES, STREET_HIGHWAY_VALUES

logger = logging.getLogger(__name__)

# Written into the output's header (the pbf "writingprogram" field) so an already
# compacted file is recognized and skipped. Bump the version whenever the keep
# rules *widen*: files carrying an older marker were filtered with narrower rules
# and can't grow the missing objects back — they need a fresh download.
MARKER = "geotagger-compact/1"

_HIGHWAYS = STREET_HIGHWAY_VALUES | PATH_HIGHWAY_VALUES

# A *named* node, way or multipolygon carrying any of these keys is kept even
# though no code reads it today: waterways (rivers, creeks), natural features
# (lakes, glaciers, ridges, peaks), place points (hamlets, localities) and points
# of interest. Unnamed ones are the bulk of the file and stay dropped.
FEATURE_KEYS = ("waterway", "natural", "place", "amenity", "shop", "office", "tourism")

# The only tag keys that survive on a kept object: everything classify() and the
# street search read, `type`/`area` (libosmium's area assembler decides what is a
# polygon from them), the FEATURE_KEYS, and `water`/`ele` which qualify a
# natural=water / natural=peak. Everything else (surface, lanes, tiger:*, addr:*,
# …) is ~2.4M tags per state that nothing reads.
KEEP_TAGS = frozenset({
    "name", "ref", "highway", "admin_level", "boundary", "place", "leisure",
    "amenity", "tourism", "building", "council_style", "landuse", "type", "area",
    "waterway", "natural", "shop", "office", "water", "ele",
})

_AREA_RELATION_TYPES = ("multipolygon", "boundary")


def _is_feature(tags) -> bool:
    if not tags.get("name"):
        return False
    return any(key in tags for key in FEATURE_KEYS)


def _keep_way(way) -> bool:
    tags = way.tags
    if tags.get("highway") in _HIGHWAYS and (tags.get("name") or tags.get("ref")):
        return True
    # classify() only ever sees areas, and a way is only an area when closed.
    if way.is_closed() and classify(tags) is not None:
        return True
    return _is_feature(tags)


def _keep_relation(rel) -> bool:
    if rel.tags.get("type") not in _AREA_RELATION_TYPES:
        return False
    return classify(rel.tags) is not None or _is_feature(rel.tags)


def _trim(tags) -> dict[str, str]:
    return {tag.k: tag.v for tag in tags if tag.k in KEEP_TAGS}


def is_compacted(path: Path) -> bool:
    """True if `path` was written by compact() with the current rules. Header-only
    read (one seek), so it's cheap enough to call per cached file."""
    try:
        reader = osmium.io.Reader(str(path), osmium.osm.osm_entity_bits.NOTHING)
        try:
            return reader.header().get("generator") == MARKER
        finally:
            reader.close()
    except Exception:  # noqa: BLE001 — unreadable file: let the caller's real pass report it
        return False


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = value = 0
    while True:
        if i >= len(buf) or shift > 63:
            raise ValueError("bad varint")
        b = buf[i]
        i += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, i
        shift += 7


def _blob_datasize(header: bytes) -> tuple[str, int]:
    """(type, datasize) from a serialized fileformat.proto BlobHeader."""
    i, kind, size = 0, "", None
    while i < len(header):
        key, i = _varint(header, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(header, i)
            if field == 3:
                size = value
        elif wire == 2:
            n, i = _varint(header, i)
            if field == 1:
                kind = header[i:i + n].decode("ascii", "replace")
            i += n
        else:
            raise ValueError(f"unexpected wire type {wire}")
    if size is None:
        raise ValueError("BlobHeader without datasize")
    return kind, size


def is_complete_pbf(path: Path) -> bool:
    """True if `path` is structurally a whole .osm.pbf: it opens with an OSMHeader
    blob and its chain of length-prefixed blobs ends exactly at end of file. Only
    the small blob headers are read (one seek per blob, a few ms for a state
    extract); blob contents are not decoded.

    This is how a partial file from the pre-atomic downloader is recognised
    without handing it to osmium — pyosmium leaks the file handle of a reader that
    hits a truncated file, which on Windows locks it for the rest of the process."""
    try:
        end = path.stat().st_size
        with open(path, "rb") as f:
            pos = 0
            first = True
            while pos < end:
                raw = f.read(4)
                if len(raw) < 4:
                    return False
                hlen = int.from_bytes(raw, "big")
                if hlen > 64 * 1024:  # the spec's BlobHeader cap
                    return False
                header = f.read(hlen)
                if len(header) < hlen:
                    return False
                kind, size = _blob_datasize(header)
                if first and kind != "OSMHeader":
                    return False
                first = False
                pos += 4 + hlen + size
                f.seek(pos)
            return pos == end and not first
    except (OSError, ValueError):
        return False


def compact(path: Path, progress_cb: Callable[[str], None] | None = None) -> dict:
    """Rewrite `path` in place, keeping only what the app can use. No-op if the
    file already carries the current MARKER.

    Returns {"skipped": bool, "before": bytes, "after": bytes, "seconds": float}.

    The output is written beside the original under a name the cache's
    "*.osm.pbf" globs don't match, then swapped in with os.replace — so a crash
    mid-way leaves the original intact and a concurrent street search never sees
    a half-written extract."""
    before = path.stat().st_size
    if is_compacted(path):
        return {"skipped": True, "before": before, "after": before, "seconds": 0.0}

    def progress(message: str):
        if progress_cb:
            progress_cb(message)

    t0 = time.time()
    src = str(path)
    tmp = path.with_name(path.name + ".compacting")

    # Every selection pass below adds ids to one IdTracker, and the write pass then
    # filters on it in C++ — so Python only ever touches named objects (a small
    # fraction of the file) plus the objects that are actually written.
    keep = osmium.IdTracker()

    progress(f"Compacting {path.name}: selecting areas…")
    for rel in osmium.FileProcessor(src, osmium.osm.RELATION):
        if _keep_relation(rel):
            keep.add_relation(rel.id)
            # Member ways carry the polygon's actual outline. Added here rather
            # than left to complete_backward_references below, which (at its
            # default relation depth) only resolves ways -> nodes: relying on it
            # silently lost two thirds of the city boundaries in testing.
            keep.add_references(rel)

    progress(f"Compacting {path.name}: selecting streets and named ways…")
    fp = (osmium.FileProcessor(src, osmium.osm.WAY)
          .with_filter(osmium.filter.KeyFilter("name", "ref")))
    for way in fp:
        if _keep_way(way):
            keep.add_way(way.id)

    progress(f"Compacting {path.name}: selecting named points…")
    fp = (osmium.FileProcessor(src, osmium.osm.NODE)
          .with_filter(osmium.filter.KeyFilter("name")))
    for node in fp:
        if _is_feature(node.tags):
            keep.add_node(node.id)

    # Pull in every node of every kept way (selected ways and relation members
    # alike). Done in C++ in one pass.
    progress(f"Compacting {path.name}: resolving geometry…")
    keep.complete_backward_references(src)

    # Reuse the source header so the bounding box survives — osm_streets.file_bbox
    # relies on it to skip extracts that can't contain the viewport.
    reader = osmium.io.Reader(src, osmium.osm.osm_entity_bits.NOTHING)
    try:
        header = reader.header()
    finally:
        reader.close()
    header.set("generator", MARKER)

    progress(f"Compacting {path.name}: writing…")
    try:
        # add_metadata=false drops version/timestamp/changeset from every object.
        writer = osmium.SimpleWriter(osmium.io.File(str(tmp), "pbf,add_metadata=false"),
                                     header=header, overwrite=True)
        try:
            for obj in osmium.FileProcessor(src).with_filter(keep.id_filter()):
                if obj.is_node():
                    if len(obj.tags) == 0:
                        writer.add_node(obj)  # plain vertex — the common case, no copy
                    else:
                        # A tagged way vertex that isn't a named feature (crossing,
                        # gate, signal) is needed for geometry; its tags are not.
                        writer.add_node(obj.replace(
                            tags=_trim(obj.tags) if _is_feature(obj.tags) else {}))
                elif obj.is_way():
                    # A way kept only as a relation member contributes geometry; its
                    # own tags would just resurface it as a stray feature.
                    writer.add_way(obj.replace(tags=_trim(obj.tags) if _keep_way(obj) else {}))
                elif obj.is_relation():
                    writer.add_relation(obj.replace(tags=_trim(obj.tags)))
        finally:
            writer.close()
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise

    after = path.stat().st_size
    seconds = round(time.time() - t0, 1)
    logger.info(f"Compacted {path.name}: {before / 1e6:.0f} MB -> {after / 1e6:.0f} MB in {seconds}s")
    progress(f"Compacted {path.name}: {before / 1e6:.0f} MB → {after / 1e6:.0f} MB")
    return {"skipped": False, "before": before, "after": after, "seconds": seconds}
