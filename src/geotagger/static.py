"""Static frontend serving.

Two trees serve the same URL space: `web_dist/` (the Vite build of the React
pages, see frontend/) and `web/` (hand-written files outside the build: the
shared theme.css, which the build also imports, and the static
design-artifacts.html reference). Lookups try `web_dist/` first and fall back to
`web/`, so a built page always wins over a same-named source file."""

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
    works); this just puts the build output ahead of web/."""

    def __init__(self, directories: list[Path], **kwargs) -> None:
        existing = [d for d in directories if d.is_dir()]
        if not existing:
            raise RuntimeError(f"No static directory exists among: {directories}")
        super().__init__(directory=str(existing[-1]), **kwargs)
        self.all_directories = [str(d) for d in existing]
