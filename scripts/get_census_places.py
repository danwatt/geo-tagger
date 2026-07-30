"""
Download the US Census Cartographic Boundary files (national, 1:500,000) and build
the offline census DB used for the middle steps of city reverse geocoding — after
OSM polygon containment, before the GeoNames distance estimate.

Run:  uv run python scripts/get_census_places.py
      uv run python scripts/get_census_places.py --root D:/Photos
      uv run python scripts/get_census_places.py --year 2022
      uv run python scripts/get_census_places.py --no-zip-codes          # places only
      uv run python scripts/get_census_places.py --zip cb_2025_us_place_500k.zip \\
          --zcta-zip cb_2025_us_zcta520_500k.zip --postal-zip US.zip     # nothing downloaded

Three layers, built together (a build always replaces the whole DB):

* **places** — every incorporated place *and* every census designated place (CDP),
  the only offline source here that covers unincorporated suburbia. OSM only has
  boundary=administrative city polygons, so a coordinate in, say, unincorporated
  Harris County TX falls inside no OSM city at all and used to land on whatever
  GeoNames populated place happened to be nearest.
* **ZCTAs** — ZIP code areas, giving each photo its ZIP and, failing everything
  above, the ZIP's mailing city (which is how street addresses read there anyway).
* **ZIP -> city crosswalk** — from GeoNames, since the ZCTA file carries only the
  bare 5-digit code.

Output goes to geotagger.config.get_census_db (by default alongside the database,
under the primary scan root's cache dir, or ~/.geotagger before any root is
configured; override with GEOTAGGER_CACHE_DIR or GEOTAGGER_CENSUS_DB).

Census Cartographic Boundary Files are published by the US Census Bureau and are in
the public domain: https://www.census.gov/geographies/mapping-files.html
The postal-code crosswalk is GeoNames data, CC BY 4.0.
"""

import argparse
import sys
from pathlib import Path

# Allow running from a source checkout without installing.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from geotagger.census_builder import (  # noqa: E402
    build, download_cb_zip, download_geonames_zip_codes, download_zcta_zip,
)
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
    ap.add_argument("--zcta-zip", dest="zcta_zip_path", type=Path,
                    help="Likewise for the cb_<year>_us_zcta520_500k.zip ZIP-code boundaries")
    ap.add_argument("--postal-zip", dest="postal_zip_path", type=Path,
                    help="Likewise for GeoNames' US.zip postal-code (ZIP -> city) archive")
    ap.add_argument("--no-zip-codes", action="store_true",
                    help="Build places only — skip the ZCTA boundaries and the ZIP -> city "
                         "crosswalk (a rebuild always replaces the whole DB, so this drops them)")
    args = ap.parse_args()

    db_path = args.db or (get_census_db(args.root) if args.root else get_census_db())
    cache_dir = db_path.parent

    if args.zip_path:
        if not args.zip_path.exists():
            sys.exit(f"ERROR: {args.zip_path} not found.")
        zip_path = args.zip_path
    else:
        zip_path = cache_dir / "cb-place-500k.zip"
        _year, url = download_cb_zip(zip_path, args.year, progress_cb=print)
        print(f"Source: {url}")

    zcta_zip = postal_zip = None
    if not args.no_zip_codes:
        zcta_zip = args.zcta_zip_path or (cache_dir / "cb-zcta520-500k.zip")
        if args.zcta_zip_path and not zcta_zip.exists():
            sys.exit(f"ERROR: {zcta_zip} not found.")
        if not args.zcta_zip_path:
            _year, url = download_zcta_zip(zcta_zip, args.year, progress_cb=print)
            print(f"Source: {url}")

        postal_zip = args.postal_zip_path or (cache_dir / "geonames-us-postal.zip")
        if args.postal_zip_path and not postal_zip.exists():
            sys.exit(f"ERROR: {postal_zip} not found.")
        if not args.postal_zip_path:
            url = download_geonames_zip_codes(postal_zip, progress_cb=print)
            print(f"Source: {url}")

    summary = build(db_path, zip_path, zcta_zip, postal_zip, progress_cb=print)
    by_kind = ", ".join(f"{n:,} {kind}" for kind, n in
                        sorted(summary["by_kind"].items(), key=lambda kv: -kv[1]))
    print(f"\n{summary['total_places']:,} places in {db_path} ({by_kind}).")
    if summary["total_zctas"]:
        print(f"{summary['total_zctas']:,} ZCTAs, "
              f"{summary['total_zip_names']:,} ZIP -> city names.")
    print("Census place containment is now the first fallback when a coordinate "
          "falls outside every OSM city polygon; the ZIP's mailing city is the next one.")


if __name__ == "__main__":
    main()
