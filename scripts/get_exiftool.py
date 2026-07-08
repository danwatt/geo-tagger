"""
Download ExifTool for the current platform and extract it into tools/.

Windows gets the standalone exiftool.exe distribution. macOS/Linux get the
Perl library distribution (needs `perl` on PATH — preinstalled on macOS and
most Linux distros); the extracted `exiftool` script plus its `lib/` package
directory are copied into tools/ together, since the script locates its
modules relative to itself.

Every download is verified against the SHA-256 checksums ExifTool publishes
at https://exiftool.org/checksums-<version>.txt before anything is extracted.

Run:  uv run python scripts/get_exiftool.py
"""

import hashlib
import io
import shutil
import stat
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path
from urllib.request import Request, build_opener, HTTPCookieProcessor

EXIFTOOL_VERSION = "13.59"
TOOLS_DIR = Path(__file__).parent.parent / "tools"

# From https://exiftool.org/checksums-13.59.txt — update alongside EXIFTOOL_VERSION.
SHA256_SUMS = {
    "exiftool-13.59_64.zip": "44b512b25af500724ba579d0a53c8fc5851628b692dd5e5d94ae4a15c2cba9ec",
    "Image-ExifTool-13.59.tar.gz": "668ea3acececb7235fbd0f4900e72d5f12c9b07e5c778fd36cb1e9b5828fd65a",
}


def download(filename: str) -> bytes:
    url = f"https://sourceforge.net/projects/exiftool/files/{filename}/download"
    print(f"Downloading {url} …")
    # SourceForge needs a cookie-accepting client for its redirect chain
    opener = build_opener(HTTPCookieProcessor())
    req = Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; geo-tagger-setup/1.0)",
    })
    with opener.open(req, timeout=60) as r:
        data = r.read()
    print(f"  {len(data):,} bytes")
    return data


def verify(filename: str, data: bytes):
    head = data.lstrip()[:15].lower()
    if head.startswith(b"<!doctype html") or head.startswith(b"<html"):
        print(f"ERROR: got an HTML page instead of {filename}.")
        print("SourceForge sometimes serves a bot-check/mirror-selection landing page")
        print("instead of the file for scripted downloads. Download it by hand instead:")
        print(f"  https://sourceforge.net/projects/exiftool/files/{filename}/download")
        print(f"and place the result at tools/ (see README's manual fallback instructions).")
        sys.exit(1)
    expected = SHA256_SUMS[filename]
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        print(f"ERROR: checksum mismatch for {filename}")
        print(f"  expected: {expected}")
        print(f"  actual:   {actual}")
        print("The download may be corrupt, or exiftool.org published a new build under")
        print("the same filename. Aborting rather than installing an unverified binary.")
        sys.exit(1)
    print(f"  sha256 verified ({actual})")


def _confirm_overwrite(dest: Path) -> bool:
    print(f"ExifTool already present at {dest}")
    answer = input("Re-download and overwrite? [y/N] ").strip().lower()
    if answer != "y":
        print("Aborted.")
        return False
    return True


def _report_version(dest: Path):
    result = subprocess.run([str(dest), "-ver"], capture_output=True, text=True)
    version = result.stdout.strip()
    if not version:
        print(f"WARNING: could not run {dest} to verify version.")
        if result.stderr:
            print(result.stderr.strip())
    else:
        print(f"\nExifTool {version} installed successfully at {dest}")


def install_windows():
    filename = f"exiftool-{EXIFTOOL_VERSION}_64.zip"
    dest = TOOLS_DIR / "exiftool.exe"
    if dest.exists() and not _confirm_overwrite(dest):
        return

    data = download(filename)
    verify(filename, data)

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
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
    _report_version(dest)


def install_unix():
    filename = f"Image-ExifTool-{EXIFTOOL_VERSION}.tar.gz"
    dest = TOOLS_DIR / "exiftool"
    if dest.exists() and not _confirm_overwrite(dest):
        return

    data = download(filename)
    verify(filename, data)

    extract_dir = TOOLS_DIR / f"Image-ExifTool-{EXIFTOOL_VERSION}"
    if extract_dir.exists():
        shutil.rmtree(extract_dir)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        tf.extractall(TOOLS_DIR)

    shutil.copy2(extract_dir / "exiftool", dest)
    lib_dest = TOOLS_DIR / "lib"
    if lib_dest.exists():
        shutil.rmtree(lib_dest)
    shutil.copytree(extract_dir / "lib", lib_dest)
    shutil.rmtree(extract_dir)

    dest.chmod(dest.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"  Extracted: {dest} (+ {lib_dest})")

    try:
        _report_version(dest)
    except OSError as e:
        print(f"WARNING: could not run {dest}: {e}")
        print("exiftool is a Perl script and needs `perl` on PATH — install it via your")
        print("package manager (already present on most macOS/Linux installs).")


def main():
    TOOLS_DIR.mkdir(exist_ok=True)
    if sys.platform == "win32":
        install_windows()
    else:
        install_unix()


if __name__ == "__main__":
    main()
