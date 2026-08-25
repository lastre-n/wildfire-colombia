"""
Estimate slope (degrees) at a point by sampling elevation at 4 nearby points
(N/S/E/W) and computing the steepest gradient.

Uses Open-Elevation (free, no API key) for simplicity. For production-grade
accuracy, swap this for a direct raster read of Copernicus DEM GLO-30
(hosted as Cloud-Optimized GeoTIFFs on AWS Open Data, no auth needed) via
rasterio + vsicurl — see the comment at the bottom of this file.
"""
import logging
import math

import requests
from pyproj import Geod

log = logging.getLogger(__name__)

_GEOD = Geod(ellps="WGS84")
_OPEN_ELEVATION_URL = "https://api.open-elevation.com/api/v1/lookup"
_SAMPLE_DISTANCE_M = 250  # half-distance between the two sample points on each axis


def _offset_point(lon, lat, bearing_deg, distance_m):
    lon2, lat2, _ = _GEOD.fwd(lon, lat, bearing_deg, distance_m)
    return lon2, lat2


def estimate_slope_deg(lon: float, lat: float) -> float:
    """Return an approximate terrain slope in degrees at (lon, lat). Falls back to 0 (flat) on failure."""
    try:
        pts = {
            "n": _offset_point(lon, lat, 0, _SAMPLE_DISTANCE_M),
            "s": _offset_point(lon, lat, 180, _SAMPLE_DISTANCE_M),
            "e": _offset_point(lon, lat, 90, _SAMPLE_DISTANCE_M),
            "w": _offset_point(lon, lat, 270, _SAMPLE_DISTANCE_M),
        }
        locations = [{"latitude": p[1], "longitude": p[0]} for p in pts.values()]
        resp = requests.post(_OPEN_ELEVATION_URL, json={"locations": locations}, timeout=20)
        resp.raise_for_status()
        results = resp.json()["results"]
        elev = {k: r["elevation"] for k, r in zip(pts.keys(), results)}

        dz_ns = elev["n"] - elev["s"]
        dz_ew = elev["e"] - elev["w"]
        rise = math.hypot(dz_ns, dz_ew)
        run = 2 * _SAMPLE_DISTANCE_M
        return math.degrees(math.atan2(rise, run))
    except Exception as e:
        log.warning("Slope estimation failed for (%s, %s): %s — assuming flat terrain", lon, lat, e)
        return 0.0


# ── Production alternative (higher accuracy, no rate limits) ────────────────
# import rasterio
# url = "/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/<tile>/<tile>.tif"
# with rasterio.open(url) as src:
#     row, col = src.index(lon, lat)
#     elevation = src.read(1)[row, col]
# Sample a small window and run numpy.gradient for slope/aspect instead of 4 API calls.
