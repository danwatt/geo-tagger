"""
Download the GeoNames data files used for offline reverse geocoding and place
them in data/geonames/.

Run:  uv run python scripts/get_geonames.py

GeoNames data is published by https://www.geonames.org under CC BY 4.0.
We use:
  - cities500.txt        all cities with population >= 500 (dense enough for
                         city-level tagging; ~30 MB unzipped)
  - admin1CodesASCII.txt maps "<CC>.<admin1>"        -> state/province name
  - admin2Codes.txt      maps "<CC>.<admin1>.<admin2>" -> county/district name
  - countryInfo.txt      maps ISO country code         -> country name
"""

import io
import sys
import zipfile
from pathlib import Path
from urllib.request import urlopen, Request

BASE = "https://download.geonames.org/export/dump"
DATA_DIR = Path(__file__).parent.parent / "data" / "geonames"

# (filename to save, source url, is_zip)
FILES = [
    ("cities500.txt", f"{BASE}/cities500.zip", True),
    ("admin1CodesASCII.txt", f"{BASE}/admin1CodesASCII.txt", False),
    ("admin2Codes.txt", f"{BASE}/admin2Codes.txt", False),
    ("countryInfo.txt", f"{BASE}/countryInfo.txt", False),
]


def download(url: str) -> bytes:
    print(f"Downloading {url} …")
    req = Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) geo-tagger-setup/1.0",
    })
    with urlopen(req, timeout=120) as r:
        data = r.read()
    print(f"  {len(data):,} bytes")
    return data


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    for name, url, is_zip in FILES:
        dest = DATA_DIR / name
        if dest.exists():
            print(f"{name} already present ({dest.stat().st_size:,} bytes) — skipping")
            continue

        data = download(url)
        if is_zip:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                # The cities zip contains <name>.txt plus a readme; pull the .txt.
                member = next(n for n in zf.namelist() if n.endswith(".txt") and "readme" not in n.lower())
                dest.write_bytes(zf.read(member))
                print(f"  Extracted {member} -> {dest}")
        else:
            dest.write_bytes(data)
            print(f"  Saved -> {dest}")

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
