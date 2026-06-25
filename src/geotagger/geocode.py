# Reverse geocoding stub — off by default.
# Set GEOTAGGER_REVERSE_GEOCODE=1 to enable (requires internet, Nominatim ToS compliance).

import os

ENABLED = os.environ.get("GEOTAGGER_REVERSE_GEOCODE", "0") == "1"


async def reverse_geocode(lat: float, lng: float) -> dict | None:
    if not ENABLED:
        return None
    # TODO: implement Nominatim reverse geocode with 1 req/s throttle
    return None
