"""Static guards for the frontend's shared XSS helper (web/common.js).

The frontend has no JS test harness, so these cheap checks keep the escaping
contract from silently rotting: every page must load common.js, and no page
script may grow back its own (weaker) copy of the helper.
"""
import re
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "src" / "geotagger" / "web"

# design-artifacts.html is a static design reference with no page scripts.
PAGES = sorted(p for p in WEB.glob("*.html") if p.name != "design-artifacts.html")


def test_common_js_defines_quote_safe_escape_helper():
    src = (WEB / "common.js").read_text(encoding="utf-8")
    assert "function escapeHtml" in src
    # Quotes must be escaped: values land inside title="…" attributes.
    assert '"&quot;"' in src or "&quot;" in src
    assert "&#39;" in src


def test_every_page_loads_common_js_before_its_own_scripts():
    assert PAGES, "no pages found"
    for page in PAGES:
        html = page.read_text(encoding="utf-8")
        # Ignore commented-out tags (a page may park a disabled script in a comment).
        html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
        scripts = re.findall(r'<script src="([^"]+)"', html)
        local = [s for s in scripts if not s.startswith("http")]
        assert "common.js" in local, f"{page.name} does not load common.js"
        assert local[0] == "common.js", f"{page.name}: common.js must be the first local script"


def test_no_page_script_redefines_the_escape_helper():
    pattern = re.compile(r"function\s+(escHtml|escapeHtml)\s*\(")
    for js in WEB.glob("*.js"):
        if js.name == "common.js":
            continue
        assert not pattern.search(js.read_text(encoding="utf-8")), (
            f"{js.name} defines its own escape helper; use common.js's escapeHtml"
        )
