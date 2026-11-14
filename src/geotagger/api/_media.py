"""Shared plumbing for the image-serving routes (thumbnail, preview, full-size,
face crop): conditional GETs and the failure → status mapping (audit A6).

Not a router — nothing here is listed in ROUTERS.
"""

import asyncio
import functools
import logging
from pathlib import Path
from typing import Callable

from fastapi import HTTPException, Request
from fastapi.responses import Response

from geotagger.executor import get_executor
from geotagger.services import media_service

logger = logging.getLogger(__name__)

MISSING_DETAIL = "Photo file is missing (moved or deleted since the last scan)"
UNDECODABLE_DETAIL = "This file could not be decoded (corrupt or in an unsupported format)"

# Revalidate on every use instead of `max-age=86400`. A fresh max-age means the
# browser never asks again, so a rendition that changed under the same URL — the
# photo's orientation corrected, RAW full-decode toggled — stayed stale for a day
# however good the ETag was. A revalidation is one DB read and a 304 on localhost;
# images reused within a page still come from the browser's memory cache.
CACHE_CONTROL = "no-cache"


def etag_matches(request: Request, etag: str) -> bool:
    """RFC 9110 If-None-Match: a comma-separated list, weak comparison (W/ ignored),
    or `*`."""
    header = request.headers.get("if-none-match")
    if not header:
        return False
    for tag in header.split(","):
        tag = tag.strip()
        if tag == "*" or tag.removeprefix("W/") == etag:
            return True
    return False


def not_modified(etag: str) -> Response:
    return Response(status_code=304, headers={"ETag": etag, "Cache-Control": CACHE_CONTROL})


async def render(fn: Callable[..., bytes], path: Path, *args, what: str, ident: object,
                 **kwargs) -> bytes:
    """Run ``fn(path, *args, **kwargs)`` in the executor and map its failure to an
    HTTPException: 404 when the file is gone, 422 when it won't decode, otherwise a
    generic 500. The detail never carries the exception text — it typically holds
    the photo's absolute path — the server log gets the real error instead."""
    loop = asyncio.get_running_loop()
    call = functools.partial(media_service.render, fn, path, *args, **kwargs)
    try:
        return await loop.run_in_executor(get_executor(), call)
    except media_service.MediaMissingError:
        logger.info(f"{what} for {ident}: file missing on disk ({path})")
        raise HTTPException(404, MISSING_DETAIL)
    except media_service.MediaDecodeError as e:
        logger.warning(f"{what} for {ident}: cannot decode {path}: {e}")
        raise HTTPException(422, UNDECODABLE_DETAIL)
    except Exception:
        logger.exception(f"{what} for {ident}: render failed ({path})")
        raise HTTPException(500, f"Could not render the {what}")
