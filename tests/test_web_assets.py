"""Static guards for the frontend's XSS posture.

React escapes everything it renders, so the only way to put unescaped markup on
the page is to bypass it. These cheap checks keep that door shut: no React source
may write raw HTML (photo filenames, place and person names all come from the
library and from user input). If one ever genuinely needs it, sanitise first and
make the exception explicit here.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "src"
WEB = ROOT / "src" / "geotagger" / "web"

RAW_HTML = re.compile(r"dangerouslySetInnerHTML|\.(inner|outer)HTML\s*=|insertAdjacentHTML")


def _sources():
    return [p for p in SRC.rglob("*") if p.suffix in {".ts", ".tsx"} and p.name != "schema.d.ts"]


def test_frontend_sources_exist():
    assert _sources(), f"no TypeScript sources under {SRC}"


def test_no_frontend_source_writes_raw_html():
    offenders = [
        f"{p.relative_to(ROOT)}:{n}"
        for p in _sources()
        for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
        if RAW_HTML.search(line)
    ]
    assert not offenders, "raw HTML sink(s): " + ", ".join(offenders)


def test_no_legacy_page_scripts_remain():
    # Every page is a React build now; web/ keeps only the shared theme and the
    # static design reference. A vanilla-JS page coming back would bypass the
    # guard above.
    assert not list(WEB.glob("*.js")), "legacy page scripts are back in web/"
