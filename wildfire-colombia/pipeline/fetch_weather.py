"""
Fetch current wind speed/direction, temperature, and humidity for a given
lat/lon from Open-Meteo (free, no API key required, global coverage).

Docs: https://open-meteo.com/en/docs
"""
import logging

import requests

from config import OPEN_METEO_URL

log = logging.getLogger(__name__)


def fetch_weather_at(lat: float, lon: float) -> dict:
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m",
        "wind_speed_unit": "ms",
        "timezone": "auto",
    }
    resp = requests.get(OPEN_METEO_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json().get("current", {})

    return {
        "temp_c": data.get("temperature_2m"),
        "humidity_pct": data.get("relative_humidity_2m"),
        "wind_speed_ms": data.get("wind_speed_10m"),
        "wind_dir_deg": data.get("wind_direction_10m"),
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    # Bogotá as a smoke test
    print(fetch_weather_at(4.7110, -74.0721))
