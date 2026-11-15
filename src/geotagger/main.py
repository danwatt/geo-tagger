"""FastAPI application factory. Kept intentionally thin: build the app, include every
API router, then mount the static frontend LAST so its catch-all can't shadow the API
routes. Routes live in geotagger.api.*, blocking logic in geotagger.services.*, and
row->JSON shaping in geotagger.serializers."""

import logging

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from geotagger.lifespan import lifespan
from geotagger.api import ROUTERS
from geotagger.middleware import RequestGuard
from geotagger.static import DIST_DIR, WEB_DIR, LayeredStaticFiles

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """422 without echoing each error's `input`: FastAPI's default handler includes
    the offending value, and a body carrying NaN/Infinity makes that response
    unserializable, turning a clean rejection into a 500."""
    errors = [{k: v for k, v in e.items() if k not in ("input", "ctx")} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


def create_app() -> FastAPI:
    app = FastAPI(title="Geo-Tagger", lifespan=lifespan)
    app.add_exception_handler(RequestValidationError, _validation_error)
    # Host/Origin guard against DNS rebinding + cross-site writes (see middleware.py).
    app.add_middleware(RequestGuard)
    for router in ROUTERS:
        app.include_router(router)
    # ── Static files (must be mounted last so it doesn't shadow the API routes) ──
    # React build first, legacy pages as fallback (see static.py).
    app.mount("/", LayeredStaticFiles([DIST_DIR, WEB_DIR], html=True), name="web")
    return app


app = create_app()
