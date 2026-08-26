"""
Pull active-fire hotspot detections from NASA FIRMS for the Colombia bounding box.

FIRMS area API docs: https://firms.modaps.eosdis.nasa.gov/api/area/
Endpoint shape:
  https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{day_range}/{date}

Per FIRMS' own docs: omitting {date} returns the most recent day_range days up
to now (live daily use); passing {date} returns data for [date .. date +
day_range - 1] (used by the backfill script for a single historical day).

Requests retry with backoff — a single transient network hiccup on a slow
runner (seen in practice: GitHub Actions occasionally can't reach FIRMS for a
few seconds) must not silently zero out an entire day's data.
"""
import io
import logging
import time

import pandas as pd
import requests

from config import FIRMS_MAP_KEY, FIRMS_SOURCES, FIRMS_DAY_RANGE, COLOMBIA_BBOX

log = logging.getLogger(__name__)

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"

_MAX_RETRIES = 3
_RETRY_BACKOFF_SECONDS = 5
_REQUEST_TIMEOUT_SECONDS = 30


def _fetch_source(source: str, target_date: str = None) -> pd.DataFrame:
    bbox_str = ",".join(str(v) for v in COLOMBIA_BBOX)
    url = f"{FIRMS_BASE}/{FIRMS_MAP_KEY}/{source}/{bbox_str}/{FIRMS_DAY_RANGE}"
    if target_date:
        url += f"/{target_date}"

    last_error = None
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            resp = requests.get(url, timeout=_REQUEST_TIMEOUT_SECONDS)
            resp.raise_for_status()

            text = resp.text
            if text.strip() == "" or "Invalid" in text[:200]:
                log.warning("FIRMS returned no/invalid data for %s: %s", source, text[:200])
                return pd.DataFrame()

            df = pd.read_csv(io.StringIO(text))
            df["source"] = source
            return df

        except requests.RequestException as e:
            last_error = e
            log.warning("FIRMS %s attempt %d/%d failed: %s", source, attempt, _MAX_RETRIES, e)
            if attempt < _MAX_RETRIES:
                time.sleep(_RETRY_BACKOFF_SECONDS * attempt)

    log.error("FIRMS fetch failed for %s after %d attempts: %s", source, _MAX_RETRIES, last_error)
    raise last_error


def fetch_all_hotspots(target_date: str = None) -> pd.DataFrame:
    """
    Fetch and merge hotspot detections from all configured FIRMS sources.
    target_date: optional 'YYYY-MM-DD' string. Omit for live daily use (last
    FIRMS_DAY_RANGE days up to now). Pass a specific date to backfill that day.
    """
    frames = []
    for source in FIRMS_SOURCES:
        try:
            df = _fetch_source(source, target_date)
            if not df.empty:
                frames.append(df)
                log.info("FIRMS %s: %d detections", source, len(df))
        except requests.RequestException as e:
            log.error("FIRMS fetch failed for %s (all retries exhausted), skipping this source: %s", source, e)

    if not frames:
        return pd.DataFrame(
            columns=["latitude", "longitude", "acq_date", "acq_time", "frp", "confidence", "satellite", "source"]
        )

    combined = pd.concat(frames, ignore_index=True)

    # Normalize confidence: VIIRS uses l/n/h, MODIS uses 0-100. Keep raw value as text,
    # downstream code should not assume a single scale.
    keep_cols = [c for c in
                 ["latitude", "longitude", "acq_date", "acq_time", "frp", "confidence", "satellite", "source"]
                 if c in combined.columns]
    combined = combined[keep_cols].dropna(subset=["latitude", "longitude"])
    combined["acq_date"] = pd.to_datetime(combined["acq_date"]).dt.date

    if target_date:
        # The day_range window can straddle midnight; keep only the requested day.
        combined = combined[combined["acq_date"].astype(str) == target_date]

    return combined


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    hotspots = fetch_all_hotspots()
    print(hotspots.head())
    print(f"Total hotspots: {len(hotspots)}")
