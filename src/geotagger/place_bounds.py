"""Validation and parsing of a saved place's `bounds` JSON.

One definition of what a well-formed place shape is, shared by the write side
(POST/PATCH /api/places reject bad input with a 400) and every read side
(Search's `search_place_distance` UDF, place stats, the jump-to-location box,
the hotspot palette), which treat a row that fails it as "matches nothing".
Rows written before validation existed — or restored from a hand-edited backup
— can still hold anything, and a read path must never 500 on one (audit A5).

Pydantic, but framework-free: no FastAPI here, so services can import it.
"""

import json
import logging
from functools import lru_cache
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

logger = logging.getLogger(__name__)

PLACE_TYPES = ("rectangle", "circle")
PlaceType = Literal["rectangle", "circle"]

# Half of Earth's circumference: a circle wider than this covers the globe twice.
_MAX_RADIUS_M = 20_037_509.0

_Lat = Field(ge=-90, le=90, allow_inf_nan=False)
_Lng = Field(allow_inf_nan=False)   # range-checked after normalization below


def _wrap_lng(lng: float) -> float:
    from geotagger.geometry import normalize_lng
    return normalize_lng(lng)


class _Bounds(BaseModel):
    # strict: "5" is not a coordinate (ints still pass — JSON has no float type).
    # extra ignored so a future client adding a field doesn't break old servers.
    model_config = ConfigDict(strict=True, extra="ignore")


class CircleBounds(_Bounds):
    lat: float = _Lat
    lng: float = _Lng
    radius: float = Field(gt=0, le=_MAX_RADIUS_M, allow_inf_nan=False)

    @model_validator(mode="after")
    def _normalize(self):
        # Leaflet reports unwrapped longitudes (e.g. 262.5) once the map has been
        # panned round the globe; store the wrapped equivalent.
        self.lng = _wrap_lng(self.lng)
        return self


class RectangleBounds(_Bounds):
    south: float = _Lat
    north: float = _Lat
    west: float = _Lng
    east: float = _Lng

    @model_validator(mode="after")
    def _check(self):
        if self.south > self.north:
            raise ValueError("south must not be greater than north")
        if self.west <= self.east:
            # Leaflet's form: west <= east, possibly unwrapped (both shifted by a
            # multiple of 360). Shift the pair together — normalizing each end
            # alone could invert a narrow box straddling ±180.
            if self.east - self.west > 360:
                raise ValueError("rectangle is wider than 360 degrees of longitude")
            from geotagger.geometry import normalize_lng_bbox
            self.west, self.east = normalize_lng_bbox(self.west, self.east)
        elif not (-180 <= self.east < self.west <= 180):
            # The explicit antimeridian form (east < west) place_distance also
            # understands — only meaningful with both ends already wrapped.
            raise ValueError("west/east must be within ±180 when east < west")
        return self


_MODELS: dict[str, type[_Bounds]] = {"circle": CircleBounds, "rectangle": RectangleBounds}


def validate_bounds(kind: str, raw: str) -> str:
    """Canonical JSON for a place's bounds, or ValueError saying what's wrong.

    `raw` is the JSON string the Custom Places page sends. The returned string is
    re-serialized from the validated model (wrapped longitudes, floats), so what
    lands in the DB is always parseable by `parse_bounds`."""
    return json.dumps(_validated(kind, raw))


def _validated(kind: str, raw) -> dict:
    model = _MODELS.get(kind)
    if model is None:
        raise ValueError(f"type must be one of {', '.join(PLACE_TYPES)}")
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError("bounds must be a JSON object") from None
    if not isinstance(data, dict):
        raise ValueError("bounds must be a JSON object")
    try:
        parsed = model.model_validate(data)
    except ValidationError as e:
        # One readable line per problem; pydantic's str() is multi-line noise.
        msgs = "; ".join(
            (f"{'.'.join(str(p) for p in err['loc'])}: " if err["loc"] else "") + err["msg"]
            for err in e.errors())
        raise ValueError(f"invalid {kind} bounds: {msgs}") from None
    return parsed.model_dump()


@lru_cache(maxsize=1024)
def parse_bounds(kind: str, raw) -> dict | None:
    """A stored place's bounds as a validated dict, or None when unusable.

    Cached on (kind, raw): the SQLite UDF calls this once per candidate photo but
    there are only as many distinct strings as saved places. The cache also makes
    the warning below fire once per bad row rather than once per photo. Callers
    only read the dict."""
    try:
        return _validated(kind, raw)
    except ValueError as e:
        logger.warning(f"Ignoring saved place with unusable bounds ({e}): {str(raw)[:120]!r}")
        return None


def bounds_valid(kind: str, raw) -> bool:
    return parse_bounds(kind, raw) is not None
