"""API routers. The import/include order below doesn't affect correctness (paths are
distinct) but keep it readable; create_app() mounts static files after all of these."""

from geotagger.api import (status, stats, photos, geotag, geocode, places,
                           contexts, faces)

ROUTERS = [status.router, stats.router, photos.router, geotag.router,
           geocode.router, places.router, contexts.router, faces.router]
