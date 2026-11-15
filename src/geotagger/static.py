"""Static frontend serving during the React migration.

Two trees serve the same URL space: `web_dist/` (the Vite build of pages already
ported to React, see frontend/) and `web/` (the legacy vanilla-JS pages). A ported
page builds to the URL its legacy page had (/settings.html), so lookups try
`web_dist/` first and fall back to `web/`. When the last page is ported, `web/`
goes away and this collapses to a plain StaticFiles."""

from pathlib import Path

from starlette.staticfiles import StaticFiles

PACKAGE_DIR = Path(__file__).parent
WEB_DIR = PACKAGE_DIR / "web"
DIST_DIR = PACKAGE_DIR / "web_dist"


def frontend_built() -> bool:
    """Whether `npm run build` has produced the React pages."""
    return (DIST_DIR / "settings.html").is_file()


class LayeredStaticFiles(StaticFiles):
    """StaticFiles over several directories, first match wins. Starlette already
    looks up a path in each of `all_directories` in order (that's how `packages=`
    works); this just puts the build output ahead of the legacy tree."""

    def __init__(self, directories: list[Path], **kwargs) -> None:
        existing = [d for d in directories if d.is_dir()]
        if not existing:
            raise RuntimeError(f"No static directory exists among: {directories}")
        super().__init__(directory=str(existing[-1]), **kwargs)
        self.all_directories = [str(d) for d in existing]
