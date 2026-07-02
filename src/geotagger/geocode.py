"""Offline reverse geocoding from GeoNames data.

Maps a coordinate to the nearest populated place (GeoNames cities500) and
resolves that place's administrative hierarchy into human names:

    {city, state, county, country, country_code}

Lookup is a nearest-neighbour search over a KD-tree built on unit-sphere XYZ
vectors, so it's globally correct (no longitude-wrap or latitude-scaling bugs)
and runs in microseconds. Results are cached by quantized coordinate (see
config.GEOCODE_PRECISION) via the index module, so nearby photos share one
lookup.

The data is downloaded with `scripts/get_geonames.py`. If it's missing, every
lookup returns None and `status()` reports it — the rest of the app keeps working.
"""

import logging
import math
import threading
from pathlib import Path

from geotagger.config import GEONAMES_DIR, GEOCODE_PRECISION

logger = logging.getLogger(__name__)

# Load state machine: "unloaded" -> "ready" | "unavailable". Guarded by _lock.
_lock = threading.Lock()
_state = "unloaded"
_error: str | None = None

_tree = None                       # scipy.spatial.cKDTree over city XYZ
_names: list[str] = []             # parallel to the KD-tree points
_ccs: list[str] = []
_admin1: list[str] = []
_admin2: list[str] = []
_lats = None                        # numpy array, parallel to _names — for bbox queries
_lngs = None
_populations = None
_admin1_names: dict[str, str] = {}  # "<cc>.<a1>"        -> state/province name
_admin2_names: dict[str, str] = {}  # "<cc>.<a1>.<a2>"   -> county/district name
_country_names: dict[str, str] = {}  # cc                -> country name


def _cities_file() -> Path:
    return GEONAMES_DIR / "cities500.txt"


def is_available() -> bool:
    """True if the GeoNames data has been downloaded."""
    return _cities_file().exists()


def status() -> dict:
    """Health/diagnostics for the /api/status endpoint."""
    return {
        "available": is_available(),
        "state": _state,
        "error": _error,
        "cities": len(_names) if _state == "ready" else 0,
    }


def _load():
    """Parse the GeoNames files and build the KD-tree. Idempotent; call via
    _ensure_loaded() so it runs once under the lock."""
    global _state, _error, _tree, _lats, _lngs, _populations
    if _state != "unloaded":
        return
    if not is_available():
        _state = "unavailable"
        _error = (f"GeoNames data not found in {GEONAMES_DIR}. "
                  "Run: uv run python scripts/get_geonames.py")
        logger.warning(_error)
        return
    try:
        import numpy as np
        from scipy.spatial import cKDTree

        _load_admin1()
        _load_admin2()
        _load_countries()

        lats: list[float] = []
        lngs: list[float] = []
        pops: list[int] = []
        with _cities_file().open(encoding="utf-8") as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                if len(p) < 11:
                    continue
                try:
                    lat = float(p[4])
                    lng = float(p[5])
                except ValueError:
                    continue
                lats.append(lat)
                lngs.append(lng)
                _names.append(p[1])
                _ccs.append(p[8])
                _admin1.append(p[10])
                _admin2.append(p[11] if len(p) > 11 else "")
                try:
                    pops.append(int(p[14]) if len(p) > 14 and p[14] else 0)
                except ValueError:
                    pops.append(0)

        _lats = np.asarray(lats)
        _lngs = np.asarray(lngs)
        _populations = np.asarray(pops, dtype=np.int64)

        # Unit-sphere XYZ so nearest-neighbour by Euclidean (chord) distance
        # matches nearest-by-great-circle and is correct near poles/antimeridian.
        lat_r = np.radians(_lats)
        lng_r = np.radians(_lngs)
        cos_lat = np.cos(lat_r)
        xyz = np.column_stack((cos_lat * np.cos(lng_r),
                               cos_lat * np.sin(lng_r),
                               np.sin(lat_r)))
        _tree = cKDTree(xyz)
        _state = "ready"
        logger.info("Reverse geocoder ready: %d cities from %s", len(_names), GEONAMES_DIR)
    except Exception as e:  # noqa: BLE001 — degrade gracefully, never crash startup
        _state = "unavailable"
        _error = f"Failed to load GeoNames data: {e}"
        logger.exception("Reverse geocoder failed to load")


def _load_admin1():
    path = GEONAMES_DIR / "admin1CodesASCII.txt"
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                _admin1_names[parts[0]] = parts[1]


def _load_admin2():
    path = GEONAMES_DIR / "admin2Codes.txt"
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                _admin2_names[parts[0]] = parts[1]


def _load_countries():
    path = GEONAMES_DIR / "countryInfo.txt"
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            # ISO(0)  ISO3(1)  ISO-Numeric(2)  fips(3)  Country(4) ...
            if len(parts) >= 5 and parts[0]:
                _country_names[parts[0]] = parts[4]


def _ensure_loaded():
    if _state == "unloaded":
        with _lock:
            _load()


def quantize(lat: float, lng: float) -> tuple[int, int]:
    """Snap a coordinate to the geocode grid as integer keys (round(coord * 10**precision))."""
    scale = 10 ** GEOCODE_PRECISION
    return round(lat * scale), round(lng * scale)


def _place_dict(i: int) -> dict:
    """Resolve GeoNames row i's admin codes into the {city, state, county,
    country, country_code} shape shared by lookup() and cities_in_bbox()."""
    cc = _ccs[i]
    a1 = _admin1[i]
    a2 = _admin2[i]
    state = _admin1_names.get(f"{cc}.{a1}") if a1 else None
    county = _admin2_names.get(f"{cc}.{a1}.{a2}") if (a1 and a2) else None
    return {
        "city": _names[i] or None,
        "state": state,
        "county": county,
        "country": _country_names.get(cc),
        "country_code": cc or None,
    }


def _raw_lookup(lat: float, lng: float) -> dict | None:
    """Nearest-city lookup without the cache. None if data unavailable."""
    _ensure_loaded()
    if _state != "ready" or _tree is None:
        return None
    lat_r = math.radians(lat)
    lng_r = math.radians(lng)
    cos_lat = math.cos(lat_r)
    point = [cos_lat * math.cos(lng_r), cos_lat * math.sin(lng_r), math.sin(lat_r)]
    _, idx = _tree.query(point)
    return _place_dict(int(idx))


def cities_in_bbox(min_lat: float, max_lat: float, min_lng: float, max_lng: float,
                    limit: int = 3000) -> tuple[list[dict], int]:
    """GeoNames places within a lat/lng box — lets the UI show the raw
    reverse-geocode reference data (city/state/county/country + population)
    for inspection, rather than a lookup for a single point.

    Returns (places, total_matched). When total_matched exceeds limit, the
    returned places are the largest by population so the capped view still
    shows the most recognizable places first.
    """
    _ensure_loaded()
    if _state != "ready" or _lats is None:
        return [], 0
    import numpy as np

    mask = (_lats >= min_lat) & (_lats <= max_lat) & (_lngs >= min_lng) & (_lngs <= max_lng)
    idxs = np.nonzero(mask)[0]
    total = int(len(idxs))
    if total > limit:
        idxs = idxs[np.argsort(-_populations[idxs])][:limit]
    places = []
    for i in idxs:
        i = int(i)
        d = _place_dict(i)
        d["lat"] = float(_lats[i])
        d["lng"] = float(_lngs[i])
        d["population"] = int(_populations[i])
        places.append(d)
    return places, total


def lookup(lat: float | None, lng: float | None, use_cache: bool = True) -> dict | None:
    """Reverse-geocode a coordinate to {city, state, county, country, country_code}.

    Caches by quantized coordinate so nearby photos reuse one result. Returns
    None when the GeoNames data isn't available or no place is found. Cache
    access degrades silently if the DB isn't initialized (e.g. raw CLI use)."""
    if lat is None or lng is None:
        return None
    qlat, qlng = quantize(lat, lng)
    if use_cache:
        try:
            from geotagger import index
            cached = index.get_cached_geocode(qlat, qlng)
            if cached is not None:
                return cached
        except Exception:
            pass
    result = _raw_lookup(lat, lng)
    if use_cache and result is not None:
        try:
            from geotagger import index
            index.put_cached_geocode(qlat, qlng, result)
        except Exception:
            pass
    return result
