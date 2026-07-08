"""Build (or extend) the offline OSM places database used for polygon-based reverse
geocoding — the "what city / park / stadium / campus is this coordinate inside?"
lookup that replaces the nearest-point GeoNames city lookup.

Run:  uv run python scripts/build_osm_places.py <region>.osm.pbf [more.osm.pbf ...]
      uv run python scripts/build_osm_places.py --append california.osm.pbf

Input is a GeoFabrik OpenStreetMap extract (.osm.pbf). Download the region(s)
where your photos are from:
    https://download.geofabrik.de/north-america/us/<state>-latest.osm.pbf
(e.g. .../us/texas-latest.osm.pbf). Downloading is a network action — do it
yourself, then point this script at the local file (or use the Data Management
page in the app, which downloads + runs this same pipeline for you). Start
small: a single state is ~0.3-2 GB and builds in minutes; the whole North
America extract is ~13 GB and takes hours (same pipeline — just pass that file
instead).

We assemble every named **area** (closed way or multipolygon relation) whose tags
mark it as a place we care about, and store its polygon rings + bbox in the OSM
places DB (see geotagger.config.get_osm_db — by default alongside the database,
under the primary scan root's cache dir, or ~/.geotagger before any root is
configured; override with GEOTAGGER_CACHE_DIR or GEOTAGGER_OSM_DB). Streets and
other linear features are ignored (we only look at areas, and only allow-listed
categories). The app's osm_places.py opens this DB read-only and does an R*Tree
bbox prefilter + point-in-polygon test.

The category rules and pipeline live in geotagger.osm_builder (shared with the
Data Management page's download+merge job); this script is just the CLI front end.

OSM data © OpenStreetMap contributors, ODbL.
"""

import argparse
import sys
from pathlib import Path

from geotagger.config import get_osm_db
from geotagger.osm_builder import build_or_append

DEFAULT_DB = get_osm_db()  # overridden by --root/--db in main()


def main():
    ap = argparse.ArgumentParser(description="Build the offline OSM places DB from GeoFabrik .osm.pbf extract(s).")
    ap.add_argument("pbf", nargs="+", type=Path, help="One or more GeoFabrik .osm.pbf files")
    ap.add_argument("--db", type=Path, default=None,
                    help=f"Output SQLite DB (default: {DEFAULT_DB}, or <root>/.geotagger/data/osm/places.sqlite if --root is given)")
    ap.add_argument("--root", type=Path,
                    help="The directory you'll pass as --scan-dir. Builds into "
                         "<root>/.geotagger/data/osm/places.sqlite instead of the global default, "
                         "matching where the app looks once it's configured with this root. "
                         "Ignored if --db is also given.")
    ap.add_argument("--append", action="store_true",
                    help="Add to an existing DB instead of rebuilding from scratch")
    ap.add_argument("--index", default="flex_mem",
                    help="osmium node-location storage. 'flex_mem' (default) is fine for a state; "
                         "use e.g. 'sparse_file_array,osm-nodes.cache' for the full North America extract.")
    args = ap.parse_args()
    if args.db is None:
        args.db = get_osm_db(args.root) if args.root else DEFAULT_DB

    for p in args.pbf:
        if not p.exists():
            print(f"ERROR: {p} not found. Download it from GeoFabrik first.", file=sys.stderr)
            sys.exit(1)

    if args.db.exists() and not args.append:
        print(f"Rebuilding {args.db} (removing existing). Use --append to add to it instead.")

    summary = build_or_append(args.db, args.pbf, append=args.append, index=args.index,
                               progress_cb=print)

    for region in summary["regions"]:
        print(f"  {region['file']}: kept {region['kept']:,} places")
    print(f"\nDone. {summary['total_places']:,} total places in {args.db}. Polygon reverse geocoding enabled.")


if __name__ == "__main__":
    main()
