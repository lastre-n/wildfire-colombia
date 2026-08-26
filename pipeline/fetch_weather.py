"""
Weather inputs for the fire spread model — free, no API key required.

Wind is now vector-averaged over a time window, not a single instantaneous
reading. This matters: a fire's net displacement tracks the *resultant* wind
over the relevant period, not whatever the wind happened to be doing at the
exact minute the pipeline ran. Averaging direction arithmetically would also
be wrong (mean of 350° and 10° should be ~0°, not 180°), so readings are
converted to vector components, averaged, and converted back.

Two modes:
  - fetch_weather_at(): live runs — averages the NEXT 24h forecast, i.e. the
    actual window the spread projection covers.
  - fetch_historical_weather_avg(): backfill runs — averages one specific past
    calendar day's actual hourly observations, from Open-Meteo's free archive.
"""
import logging
import math
import time

import requests

log = logging.getLogger(__name__)

_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
_HOURLY_VARS = "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m"

_MAX_RETRIES = 3
_RETRY_BACKOFF_SECONDS = 3

_EMPTY = {"temp_c": None, "humidity_pct": None, "wind_speed_ms": None, "wind_dir_deg": None}


def _vector_mean_wind(speeds, dirs):
    """Average (speed, direction) readings as vectors -> physically correct resultant wind."""
    pairs = [(s, d) for s, d in zip(speeds, dirs) if s is not None and d is not None]
    if not pairs:
        return None, None
    u_sum = v_sum = 0.0
    for spd, d in pairs:
        rad = math.radians(d)
        # meteorological "from" direction -> actual velocity vector components
        u_sum += -spd * math.sin(rad)
        v_sum += -spd * math.cos(rad)
    n = len(pairs)
    u_mean, v_mean = u_sum / n, v_sum / n
    mean_speed = math.hypot(u_mean, v_mean)
    mean_dir = math.degrees(math.atan2(-u_mean, -v_mean)) % 360
    return mean_speed, mean_dir


def _request_with_retries(url, params):
    last_error = None
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            resp = requests.get(url, params=params, timeout=20)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            last_error = e
            log.warning("Weather request attempt %d/%d failed: %s", attempt, _MAX_RETRIES, e)
            if attempt < _MAX_RETRIES:
                time.sleep(_RETRY_BACKOFF_SECONDS * attempt)
    log.error("Weather request failed after %d attempts: %s", _MAX_RETRIES, last_error)
    return None


def _summarize_hourly(hourly: dict) -> dict:
    speeds = hourly.get("wind_speed_10m") or []
    dirs = hourly.get("wind_direction_10m") or []
    temps = [t for t in (hourly.get("temperature_2m") or []) if t is not None]
    hums = [h for h in (hourly.get("relative_humidity_2m") or []) if h is not None]

    if not speeds:
        return dict(_EMPTY)

    mean_speed, mean_dir = _vector_mean_wind(speeds, dirs)
    if mean_speed is None:
        return dict(_EMPTY)

    return {
        "temp_c": (sum(temps) / len(temps)) if temps else None,
        "humidity_pct": (sum(hums) / len(hums)) if hums else None,
        "wind_speed_ms": mean_speed,
        "wind_dir_deg": mean_dir,
    }


def fetch_weather_at(lat: float, lon: float) -> dict:
    """Live run: vector-averaged wind over the NEXT 24h forecast (the window the
    projection actually covers), plus mean temp/humidity over the same window."""
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": _HOURLY_VARS,
        "wind_speed_unit": "ms",
        "forecast_hours": 24,
        "timezone": "auto",
    }
    payload = _request_with_retries(_FORECAST_URL, params)
    if payload is None:
        return dict(_EMPTY)
    return _summarize_hourly(payload.get("hourly", {}))


def fetch_historical_weather_avg(lat: float, lon: float, date_str: str) -> dict:
    """Backfill run: vector-averaged wind over one specific past calendar day's
    actual hourly observations (Open-Meteo historical archive, free, no key)."""
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": date_str,
        "end_date": date_str,
        "hourly": _HOURLY_VARS,
        "wind_speed_unit": "ms",
        "timezone": "auto",
    }
    payload = _request_with_retries(_ARCHIVE_URL, params)
    if payload is None:
        return dict(_EMPTY)
    return _summarize_hourly(payload.get("hourly", {}))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print("Live (next 24h avg):", fetch_weather_at(4.7110, -74.0721))
    print("Historical (fixed date):", fetch_historical_weather_avg(4.7110, -74.0721, "2026-08-20"))
