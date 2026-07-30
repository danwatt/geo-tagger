"""
Download the US Census Cartographic Boundary "places" file (national, 1:500,000)
and build the offline census places DB used as the middle step of city reverse
geocoding — after OSM polygon containment, before the GeoNames distance estimate.

Run:  uv run python scripts/get_census_places.py
      uv run python scripts/get_census_places.py --root D:/Photos
      uv run python scripts/get_census_places.py --year 2022
      uv run python scripts/get_census_places.py --zip cb_2023_us_place_500k.zip   # already downloaded

Why this dataset: it carries every incorporated place *and* every census designated
place (CDP), which is the only offline source here that covers unincorporated
suburbia. OSM only has boundary=administrative city polygons — a coordinate in, say,
unincorporated Harris County TX falls inside no OSM city at all, and used to land on
whatever GeoNames populated place happened to be nearest.

Output goes to geotagger.config.get_census_db (by default alongside the database,
under the primary scan root's cache dir, or ~/.geotagger before any root is
configured; override with GEOTAGGER_CACHE_DIR or GEOTAGGER_CENSUS_DB).

Census Cartographic Boundary Files are published by the US Census Bureau and are in
the public domain: https://www.census.gov/geographies/mapping-files.html
"""

import argparse
import sys
from pathlib import Path

# Allow running from a source checkout without installing.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from geotagger.census_builder import build, download_cb_zip  # noqa: E402
from geotagger.config import get_census_db  # noqa: E402


def main():
    ap = argparse.ArgumentParser(
        description="Download + build the offline US Census places DB (incorporated places + CDPs).")
    ap.add_argument("--db", type=Path, default=None,
                    help=f"Output SQLite DB (default: {get_census_db()}, or "
                         "<root>/.geotagger/data/census/places.sqlite with --root)")
    ap.add_argument("--root", type=Path,
                    help="The directory you'll pass as --scan-dir. Builds into "
                         "<root>/.geotagger/data/census/places.sqlite instead of the global "
                         "default, matching where the app looks once configured with this root. "
                         "Ignored if --db is also given.")
    ap.add_argument("--year", type=int, default=None,
                    help="Cartographic Boundary vintage (default: GEOTAGGER_CENSUS_CB_YEAR). "
                         "Earlier years are tried automatically if this one isn't published yet.")
    ap.add_argument("--zip", dest="zip_path", type=Path,
                    help="Use an already-downloaded cb_<year>_us_place_500k.zip instead of "
                         "fetching one (no network access at all)")
    args = ap.parse_args()

    db_path = args.db or (get_census_db(args.root) if args.root else get_census_db())

    if args.zip_path:
        if not args.zip_path.exists():
            sys.exit(f"ERROR: {args.zip_path} not found.")
        zip_path = args.zip_path
    else:
        zip_path = db_path.parent / "cb-place-500k.zip"
        year, url = download_cb_zip(zip_path, args.year, progress_cb=print)
        print(f"Source: {url}")

    summary = build(db_path, zip_path, progress_cb=print)
    by_kind = ", ".join(f"{n:,} {kind}" for kind, n in
                        sorted(summary["by_kind"].items(), key=lambda kv: -kv[1]))
    print(f"\n{summary['total_places']:,} places in {db_path} ({by_kind}).")
    print("Census place containment is now the first fallback when a coordinate "
          "falls outside every OSM city polygon.")


if __name__ == "__main__":
    main()
