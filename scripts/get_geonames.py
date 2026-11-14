"""
Download the GeoNames data files used for offline reverse geocoding (see
geotagger.config.get_geonames_dir — by default alongside the database, under
the primary scan root's cache dir, or ~/.geotagger before any root is
configured; override with GEOTAGGER_CACHE_DIR or GEOTAGGER_GEONAMES_DIR).

Run:  uv run python scripts/get_geonames.py

GeoNames data is published by https://www.geonames.org under CC BY 4.0.
We use:
  - cities500.txt        all cities with population >= 500 (dense enough for
                         city-level tagging; ~30 MB unzipped)
  - admin1CodesASCII.txt maps "<CC>.<admin1>"        -> state/province name
  - admin2Codes.txt      maps "<CC>.<admin1>.<admin2>" -> county/district name
  - countryInfo.txt      maps ISO country code         -> country name
"""

import argparse
import sys
from pathlib import Path

from geotagger import downloads
from geotagger.config import get_geonames_dir

BASE = "https://download.geonames.org/export/dump"
DATA_DIR = get_geonames_dir()  # overridden by --root in main()

# (filename to save, source url, is_zip)
FILES = [
    ("cities500.txt", f"{BASE}/cities500.zip", True),
    ("admin1CodesASCII.txt", f"{BASE}/admin1CodesASCII.txt", False),
    ("admin2Codes.txt", f"{BASE}/admin2Codes.txt", False),
    ("countryInfo.txt", f"{BASE}/countryInfo.txt", False),
]


def download(url: str, dest: Path, is_zip: bool) -> None:
    """Atomic, length-checked download straight to `dest` (downloads.download_to);
    for the cities zip, the CRC-checked .txt inside it is what lands at `dest`. An
    interrupted run leaves no `dest`, so the skip-if-present check below can trust
    whatever it finds."""
    print(f"Downloading {url} …")
    got = downloads.download_to(
        url, dest, transform=downloads.extract_zip_txt if is_zip else None,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) geo-tagger-setup/1.0"})
    print(f"  {got['bytes']:,} bytes -> {dest}")


def main():
    global DATA_DIR
    ap = argparse.ArgumentParser(description="Download GeoNames data for offline reverse geocoding.")
    ap.add_argument("--root", type=Path,
                    help="The directory you'll pass as --scan-dir. Installs into "
                         "<root>/.geotagger/data/geonames instead of the global default, "
                         "matching where the app looks once it's configured with this root.")
    args = ap.parse_args()
    if args.root:
        DATA_DIR = get_geonames_dir(args.root)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    for name, url, is_zip in FILES:
        dest = DATA_DIR / name
        if dest.exists():
            print(f"{name} already present ({dest.stat().st_size:,} bytes) — skipping")
            continue

        download(url, dest, is_zip)

    # Sanity check
    cities = DATA_DIR / "cities500.txt"
    if cities.exists():
        with cities.open(encoding="utf-8") as f:
            n = sum(1 for _ in f)
        print(f"\nGeoNames ready in {DATA_DIR} ({n:,} cities). Reverse geocoding enabled.")
    else:
        print("ERROR: cities500.txt missing after download.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
