"""Compact GeoFabrik .osm.pbf extracts already sitting in the pbf cache.

Run:  uv run python scripts/compact_osm_pbf.py --root "D:\\Photos"
      uv run python scripts/compact_osm_pbf.py --dir path/to/pbf-cache --jobs 4
      uv run python scripts/compact_osm_pbf.py one-latest.osm.pbf two-latest.osm.pbf

New downloads from the Data Management page are compacted automatically; this is
the one-shot catch-up for extracts downloaded before that existed. Each file is
rewritten in place, keeping only what the app can use (see geotagger.osm_compact
for the rules). Files already compacted are skipped, so it's safe to re-run.

The places DB does not need rebuilding afterwards — compaction keeps everything
the merge reads.

OSM data © OpenStreetMap contributors, ODbL.
"""

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from geotagger.config import get_osm_db
from geotagger.osm_compact import compact


def _one(path: Path) -> tuple[str, dict | None, str | None]:
    try:
        return path.name, compact(path), None
    except Exception as e:  # noqa: BLE001 — report and carry on with the other files
        return path.name, None, f"{type(e).__name__}: {e}"


def main():
    ap = argparse.ArgumentParser(description="Compact cached GeoFabrik .osm.pbf extracts in place.")
    ap.add_argument("pbf", nargs="*", type=Path, help="Specific .osm.pbf files (default: every file in the cache dir)")
    ap.add_argument("--dir", type=Path, help="pbf cache directory to compact")
    ap.add_argument("--root", type=Path,
                    help="The directory you pass as --scan-dir; compacts <root>/.geotagger/data/osm/pbf-cache")
    ap.add_argument("--jobs", type=int, default=2,
                    help="Files compacted in parallel (default 2). Each job holds the kept-id "
                         "sets for one extract in RAM, so don't go wild on big regions.")
    args = ap.parse_args()

    paths = list(args.pbf)
    if not paths:
        cache = args.dir or (get_osm_db(args.root) if args.root else get_osm_db()).parent / "pbf-cache"
        if not cache.is_dir():
            print(f"ERROR: {cache} is not a directory.", file=sys.stderr)
            sys.exit(1)
        paths = sorted(cache.glob("*.osm.pbf"))
    if not paths:
        print("Nothing to compact.")
        return

    # Biggest first, so the long ones aren't all left for the end of the queue.
    paths.sort(key=lambda p: p.stat().st_size, reverse=True)
    before = after = 0
    failed = 0
    with ProcessPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = [pool.submit(_one, p) for p in paths]
        for n, fut in enumerate(as_completed(futures), 1):
            name, result, error = fut.result()
            if error:
                failed += 1
                print(f"[{n}/{len(paths)}] {name}: FAILED — {error}", flush=True)
                continue
            before += result["before"]
            after += result["after"]
            if result["skipped"]:
                print(f"[{n}/{len(paths)}] {name}: already compacted", flush=True)
            else:
                print(f"[{n}/{len(paths)}] {name}: {result['before'] / 1e6:.0f} MB -> "
                      f"{result['after'] / 1e6:.0f} MB in {result['seconds']}s", flush=True)

    print(f"\nDone. {before / 1e9:.2f} GB -> {after / 1e9:.2f} GB"
          + (f", {failed} file(s) failed" if failed else ""))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
