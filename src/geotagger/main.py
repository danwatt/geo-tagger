"""FastAPI application factory. Kept intentionally thin: build the app, include every
API router, then mount the static frontend LAST so its catch-all can't shadow the API
routes. Routes live in geotagger.api.*, blocking logic in geotagger.services.*, and
row->JSON shaping in geotagger.serializers."""

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from geotagger.lifespan import lifespan
from geotagger.api import ROUTERS
from geotagger.middleware import RequestGuard

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

_WEB_DIR = Path(__file__).parent / "web"


def create_app() -> FastAPI:
    app = FastAPI(title="Geo-Tagger", lifespan=lifespan)
    # Host/Origin guard against DNS rebinding + cross-site writes (see middleware.py).
    app.add_middleware(RequestGuard)
    for router in ROUTERS:
        app.include_router(router)
    # ── Static files (must be mounted last so it doesn't shadow the API routes) ──
    app.mount("/", StaticFiles(directory=str(_WEB_DIR), html=True), name="web")
    return app


app = create_app()
