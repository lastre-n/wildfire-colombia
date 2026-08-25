"""
Look up the ESA WorldCover land-cover class at a point (via the free public
Terrascope WMS) and map it to a fuel-model category used by the spread model.

WorldCover WMS docs: https://viewer.esa-worldcover.org / https://docs.terrascope.be
"""
import logging

import requests

from config import WORLDCOVER_FUEL_MAP, DEFAULT_FUEL

log = logging.getLogger(__name__)

_WMS_URL = "https://services.terrascope.be/wms/v2"
_LAYER = "WORLDCOVER_2021_MAP"
_PIXEL_DEG = 0.001  # small bbox around the point, well above the 10m native resolution


def get_fuel_type(lon: float, lat: float) -> str:
    bbox = (lon - _PIXEL_DEG, lat - _PIXEL_DEG, lon + _PIXEL_DEG, lat + _PIXEL_DEG)
    params = {
        "service": "WMS",
        "version": "1.1.1",
        "request": "GetFeatureInfo",
        "layers": _LAYER,
        "query_layers": _LAYER,
        "styles": "",
        "bbox": ",".join(str(b) for b in bbox),
        "width": 3,
        "height": 3,
        "srs": "EPSG:4326",
        "x": 1,
        "y": 1,
        "info_format": "application/json",
    }
    try:
        resp = requests.get(_WMS_URL, params=params, timeout=20)
        resp.raise_for_status()
        features = resp.json().get("features", [])
        if not features:
            return DEFAULT_FUEL
        class_value = features[0]["properties"].get("MAP") or features[0]["properties"].get("value")
        return WORLDCOVER_FUEL_MAP.get(int(class_value), DEFAULT_FUEL)
    except Exception as e:
        log.warning("Fuel lookup failed for (%s, %s): %s — defaulting to '%s'", lon, lat, e, DEFAULT_FUEL)
        return DEFAULT_FUEL
