"""
Download ExifTool for Windows and extract it into tools/.

Run:  uv run python scripts/get_exiftool.py
"""

import hashlib
import io
import subprocess
import sys
import zipfile
from pathlib import Path
from urllib.request import urlopen, Request

EXIFTOOL_URL = "https://sourceforge.net/projects/exiftool/files/exiftool-13.59_64.zip/download"
TOOLS_DIR = Path(__file__).parent.parent / "tools"


def download(url: str) -> bytes:
    print(f"Downloading {url} …")
    # SourceForge needs a cookie-accepting client for its redirect chain
    import urllib.request
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    req = Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) geo-tagger-setup/1.0",
    })
    with opener.open(req, timeout=60) as r:
        data = r.read()
    print(f"  {len(data):,} bytes")
    return data


def main():
    TOOLS_DIR.mkdir(exist_ok=True)
    dest = TOOLS_DIR / "exiftool.exe"

    if dest.exists():
        print(f"ExifTool already present at {dest}")
        answer = input("Re-download and overwrite? [y/N] ").strip().lower()
        if answer != "y":
            print("Aborted.")
            return

    data = download(EXIFTOOL_URL)

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        print("Zip contents:", names)
        for name in names:
            out = TOOLS_DIR / Path(name).name if "/" not in name else TOOLS_DIR / name
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(zf.read(name))
            print(f"  Extracted: {out}")

    # Rename exiftool(-k).exe -> exiftool.exe if needed
    for candidate in TOOLS_DIR.glob("exiftool(-k)*.exe"):
        candidate.rename(dest)
        print(f"Renamed {candidate.name} -> exiftool.exe")

    if not dest.exists():
        print("ERROR: exiftool.exe not found after extraction. Check zip contents above.")
        sys.exit(1)

    # Verify
    result = subprocess.run([str(dest), "-ver"], capture_output=True, text=True)
    version = result.stdout.strip()
    print(f"\nExifTool version: {version}")
    if not version:
        print("WARNING: could not verify version — check that exiftool_files/ is beside exiftool.exe")
    else:
        print("ExifTool installed successfully.")


if __name__ == "__main__":
    main()
