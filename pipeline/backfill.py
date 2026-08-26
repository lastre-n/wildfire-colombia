"""
One-time (or occasional) backfill: reconstruct the last N days of fire history,
so the frontend's 7-day timeline isn't empty for days before the live pipeline
started running.

Run manually from the GitHub Actions tab ("Backfill historical fire data"
workflow) — this is NOT on the daily schedule, it's meant to be run once (or
re-run if you ever need to extend history further back).

Processes the OLDEST day first and works forward to yesterday, so
cluster_id/day_index continuity builds up correctly — exactly as if the daily
pipeline had been running all along instead of starting today.
"""
import logging
from datetime import date, timedelta

from fetch_weather import fetch_historical_weather_avg
from main import process_day
from supabase_client import get_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("backfill")

BACKFILL_DAYS = 6  # how many days before today to reconstruct


def run():
    sb = get_client()
    today = date.today()

    total_succeeded, total_failed = 0, 0
    for i in range(BACKFILL_DAYS, 0, -1):
        target_date = today - timedelta(days=i)
        date_str = target_date.isoformat()
        log.info("=== Backfilling %s ===", date_str)

        def weather_fn(lat, lon, d=date_str):
            return fetch_historical_weather_avg(lat, lon, d)

        succeeded, failed = process_day(sb, target_date, weather_fn, firms_date_str=date_str)
        total_succeeded += succeeded
        total_failed += failed

    log.info("Backfill complete: reconstructed %d days before today (%d clusters processed, %d had "
              "projection failures).", BACKFILL_DAYS, total_succeeded, total_failed)


if __name__ == "__main__":
    run()
