"""
Fetch current wind speed/direction, temperature, and humidity for a given
lat/lon from Open-Meteo (free, no API key required, global coverage).

Docs: https://open-meteo.com/en/docs
"""
import logging
import time

import requests

from config import OPEN_METEO_URL

log = logging.getLogger(__name__)

_MAX_RETRIES = 3
_RETRY_BACKOFF_SECONDS = 3


def fetch_weather_at(lat: float, lon: float) -> dict:
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m",
        "wind_speed_unit": "ms",
        "timezone": "auto",
    }

    last_error = None
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            resp = requests.get(OPEN_METEO_URL, params=params, timeout=20)
            resp.raise_for_status()
            data = resp.json().get("current", {})
            return {
                "temp_c": data.get("temperature_2m"),
                "humidity_pct": data.get("relative_humidity_2m"),
                "wind_speed_ms": data.get("wind_speed_10m"),
                "wind_dir_deg": data.get("wind_direction_10m"),
            }
        except requests.RequestException as e:
            last_error = e
            log.warning("Open-Meteo attempt %d/%d failed for (%s, %s): %s",
                        attempt, _MAX_RETRIES, lat, lon, e)
            if attempt < _MAX_RETRIES:
                time.sleep(_RETRY_BACKOFF_SECONDS * attempt)

    log.error("Open-Meteo failed after %d attempts for (%s, %s): %s — skipping weather for this cluster",
               _MAX_RETRIES, lat, lon, last_error)
    return {"temp_c": None, "humidity_pct": None, "wind_speed_ms": None, "wind_dir_deg": None}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    # Bogotá as a smoke test
    print(fetch_weather_at(4.7110, -74.0721))
