"""
Force already-geocoded photos to be re-resolved against updated place data —
e.g. after building or extending the OSM places database
(scripts/build_osm_places.py). /api/geocode/backfill only processes photos
that have never been geocoded (geocoded_at IS NULL), so a photo already
resolved with the old GeoNames-only nearest-city lookup (or a smaller/older
OSM extract) won't pick up newly-imported places on its own — this script
forces the targeted photos through geocode.lookup() again.

Also clears the geocode_cache table (the quantized-coordinate lookup cache):
once any OSM data exists, geocode.lookup()'s merge behavior changes globally
(OSM replaces the city lookup — see geocode._merged_lookup), so every
previously-cached result is potentially stale, not just ones in the newly
imported region. The cache is pure derived data, cheap to rebuild, so this
script always clears it before re-processing.

Use --bbox and/or --limit to verify a small subset first (e.g. just the
region you imported) before re-running against the whole library.

Run:  uv run python scripts/regeocode.py --dry-run --bbox -97.5,32.5,-97.0,33.0 --limit 20
      uv run python scripts/regeocode.py --bbox -97.5,32.5,-97.0,33.0 --limit 20   # verify a subset
      uv run python scripts/regeocode.py --bbox -97.5,32.5,-97.0,33.0              # the whole region
      uv run python scripts/regeocode.py                                          # the whole library
      uv run python scripts/regeocode.py --cache-dir D:/path/.geotagger
"""
import argparse
import os
import sys
from pathlib import Path

# Allow running from a source checkout without installing.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from geotagger import index, geocode, osm_places  # noqa: E402


def resolve_root(args) -> Path | None:
    """Pick the cache location the same way the server does."""
    if args.cache_dir:
        os.environ["GEOTAGGER_CACHE_DIR"] = str(Path(args.cache_dir).resolve())
        return None
    if os.environ.get("GEOTAGGER_CACHE_DIR"):
        return None
    last = index.get_last_scan_root() if hasattr(index, "get_last_scan_root") else None
    if not last:
        sys.exit("No cache directory found. Pass --cache-dir or run a scan first.")
    return Path(last)


def find_candidates(bbox: str | None, limit: int):
    """Every geotagged photo (optionally restricted to a bbox), capped at limit
    (0 = all matching). Includes photos already geocoded — that's the point."""
    rows = index.get_photos(geotagged="yes", bbox=bbox)
    rows = [r for r in rows if r["lat"] is not None and r["lng"] is not None]
    if limit:
        rows = rows[:limit]
    return rows


def _describe_loc(r) -> str:
    city = r["loc_city"] or "(none)"
    return f"{city} / {r['loc_sublocation']}" if r["loc_sublocation"] else city


def main():
    parser = argparse.ArgumentParser(
        description="Force already-geocoded photos to be re-resolved (e.g. after building/extending "
                    "the OSM places database)")
    parser.add_argument("--cache-dir", help="Cache dir holding index.db (the .geotagger folder)")
    parser.add_argument("--bbox", help="minLng,minLat,maxLng,maxLat — restrict to photos in this "
                                        "region (e.g. the area you just imported OSM data for)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Max photos to process (0 = all matching) — try a small number first")
    parser.add_argument("--dry-run", action="store_true",
                        help="List what would be processed (with current place names) and exit, "
                             "changing nothing")
    args = parser.parse_args()

    root = resolve_root(args)
    index.init_db(root)

    if not geocode.is_available():
        print("Note: GeoNames data not installed — state/county/country will stay blank "
              "(run scripts/get_geonames.py to enable them).")
    if not osm_places.is_available():
        print("Note: OSM places DB not found — this will only re-run the GeoNames nearest-city "
              "lookup (run scripts/build_osm_places.py to enable city/sub-location boundaries).")

    todo = find_candidates(args.bbox, args.limit)
    if not todo:
        print("Nothing to do — no matching geotagged photos.")
        return

    if args.dry_run:
        print(f"Would re-geocode {len(todo)} photo(s):")
        for r in todo[:50]:
            print(f"  {r['filename']}  ({r['lat']:.5f}, {r['lng']:.5f})  currently: {_describe_loc(r)}")
        if len(todo) > 50:
            print(f"  … and {len(todo) - 50} more")
        return

    db = index.get_db()
    cleared = db.execute("SELECT COUNT(*) FROM geocode_cache").fetchone()[0]
    db.execute("DELETE FROM geocode_cache")
    db.commit()
    print(f"Cleared {cleared:,} cached geocode lookup(s) (stale now that new place data is available).")

    print(f"Re-geocoding {len(todo)} photo(s)…")
    matched = 0
    for i, r in enumerate(todo, 1):
        loc = geocode.lookup(r["lat"], r["lng"])
        index.update_photo_location(r["id"], loc)
        if loc:
            matched += 1
        was = _describe_loc(r)
        now = f"{(loc or {}).get('city') or '(none)'}" + (
            f" / {loc['sublocation']}" if loc and loc.get("sublocation") else "")
        print(f"  [{i}/{len(todo)}] {r['filename']}: {was} -> {now}")

    print(f"\nDone: re-geocoded {len(todo)} photo(s), {matched} matched a place.")


if __name__ == "__main__":
    main()
