"""API routers. The import/include order below doesn't affect correctness (paths are
distinct) but keep it readable; create_app() mounts static files after all of these."""

from geotagger.api import (status, stats, photos, geotag, geocode, places,
                           faces, search, data, work_queue, semantic)

# Road Trip mode is disabled for now: geotagger/api/roadtrip.py and its service
# still exist, but the router isn't mounted (and geocode.html doesn't load
# roadtrip.js/.css). Re-enable by importing roadtrip and adding roadtrip.router.
ROUTERS = [status.router, stats.router, photos.router, geotag.router,
           geocode.router, places.router, faces.router,
           search.router, data.router, work_queue.router, semantic.router]
