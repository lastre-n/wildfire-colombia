"""
Daily wildfire pipeline for Colombia. Run via `python main.py` (locally) or on a
schedule via GitHub Actions (see .github/workflows/daily_pipeline.yml).

Flow:
  1. Pull today's active-fire hotspots (FIRMS: VIIRS + MODIS).
  2. Cluster hotspots into fire events, keep cluster_id/day_index stable vs. yesterday.
  3. Write raw hotspots + today's evolution polygons to Supabase.
  4. For each active cluster: pull wind/temp (Open-Meteo), slope (terrain sample),
     fuel type (WorldCover) and compute a 24h spread projection ellipse.
  5. Write projections + the weather snapshot used, for auditability.

A single cluster failing (timeout, rate-limited free API, bad geometry, etc.)
must never take down the whole run — with 100+ active clusters on a bad fire
day, some external API hiccups are expected. Each cluster is processed in its
own try/except so the rest of the run still completes and gets written.
"""
import logging
import time
from datetime import date, timedelta

from shapely.geometry import shape

from cluster_hotspots import cluster_today, match_cluster_ids
from fetch_firms import fetch_all_hotspots
from fetch_fuel import get_fuel_type
from fetch_terrain import estimate_slope_deg
from fetch_weather import fetch_weather_at
from fire_spread_model import projection_geojson_and_meta
from supabase_client import get_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("pipeline")

# Small pause between clusters' external-API calls so we don't hammer the free
# public services (Open-Meteo, Open-Elevation, Terrascope WMS) in a tight loop.
DELAY_BETWEEN_CLUSTERS_SECONDS = 0.5


def get_yesterdays_polygons(sb, today: date) -> list[dict]:
    yesterday = (today - timedelta(days=1)).isoformat()
    # Query the GeoJSON view (see supabase/schema.sql) rather than the raw table,
    # since PostgREST serializes PostGIS `geometry` columns as WKB by default.
    resp = sb.table("fire_polygons_geojson").select("cluster_id, day_index, geom_geojson").eq(
        "acq_date", yesterday
    ).execute()
    rows = resp.data or []
    out = []
    for r in rows:
        try:
            geom = shape(r["geom_geojson"])
        except Exception:
            continue
        out.append({"cluster_id": r["cluster_id"], "day_index": r["day_index"], "geom": geom})
    return out


def write_hotspots(sb, hotspots_df):
    if hotspots_df.empty:
        return
    records = hotspots_df.to_dict(orient="records")
    for r in records:
        r["acq_date"] = r["acq_date"].isoformat() if hasattr(r["acq_date"], "isoformat") else r["acq_date"]
    # Chunk to stay under request size limits.
    chunk = 500
    for i in range(0, len(records), chunk):
        sb.table("fire_hotspots").upsert(
            records[i:i + chunk],
            on_conflict="source,acq_date,acq_time,latitude,longitude",
        ).execute()
    log.info("Wrote %d hotspot rows", len(records))


def write_polygon(sb, cluster, today: date):
    row = {
        "cluster_id": cluster["cluster_id"],
        "acq_date": today.isoformat(),
        "day_index": cluster["day_index"],
        "geom": f"SRID=4326;{shape(cluster['geometry']).wkt}",
        "area_ha": cluster["area_ha"],
        "hotspot_count": cluster["hotspot_count"],
        "mean_frp": cluster["mean_frp"],
    }
    sb.table("fire_polygons").upsert(row, on_conflict="cluster_id,acq_date").execute()


def write_projection(sb, cluster_id, today, geojson_geom, meta):
    row = {
        "cluster_id": cluster_id,
        "base_date": today.isoformat(),
        "valid_until": meta["valid_until"],
        "geom": f"SRID=4326;{shape(geojson_geom).wkt}",
        "model_name": meta["model_name"],
        "wind_speed_ms": meta["wind_speed_ms"],
        "wind_dir_deg": meta["wind_dir_deg"],
        "ros_m_per_min": meta["ros_m_per_min"],
        "length_breadth_ratio": meta["length_breadth_ratio"],
        "notes": meta["notes"],
    }
    sb.table("fire_projections").upsert(row, on_conflict="cluster_id,base_date").execute()


def write_weather(sb, cluster_id, today, lon, lat, weather):
    row = {
        "cluster_id": cluster_id,
        "acq_date": today.isoformat(),
        "latitude": lat,
        "longitude": lon,
        **weather,
    }
    sb.table("weather_snapshots").insert(row).execute()


def run():
    today = date.today()
    sb = get_client()

    log.info("Fetching FIRMS hotspots for Colombia...")
    hotspots = fetch_all_hotspots()
    if hotspots.empty:
        log.info("No hotspots detected today. Nothing to do.")
        return

    write_hotspots(sb, hotspots)

    log.info("Clustering hotspots into fire events...")
    clusters = cluster_today(hotspots)
    if not clusters:
        log.info("No clusters formed (all detections were isolated noise).")
        return

    prior_polygons = get_yesterdays_polygons(sb, today)
    clusters = match_cluster_ids(clusters, prior_polygons, today)

    succeeded, failed = 0, 0
    for cluster in clusters:
        try:
            write_polygon(sb, cluster, today)
            log.info("Cluster %s: day_index=%d, area=%.1f ha, hotspots=%d",
                      cluster["cluster_id"], cluster["day_index"], cluster["area_ha"], cluster["hotspot_count"])

            lon, lat = cluster["centroid_lon"], cluster["centroid_lat"]
            weather = fetch_weather_at(lat, lon)
            slope_deg = estimate_slope_deg(lon, lat)
            fuel = get_fuel_type(lon, lat)

            if weather.get("wind_speed_ms") is None:
                log.warning("No weather data for cluster %s after retries, skipping its projection "
                            "(polygon was still saved above)", cluster["cluster_id"])
                failed += 1
                continue

            write_weather(sb, cluster["cluster_id"], today, lon, lat, weather)

            geojson_geom, meta = projection_geojson_and_meta(
                lon, lat, fuel, weather["wind_speed_ms"], weather["wind_dir_deg"], slope_deg, today
            )
            write_projection(sb, cluster["cluster_id"], today, geojson_geom, meta)
            log.info("Projection for %s: ROS=%.1f m/min, L/B=%.2f",
                      cluster["cluster_id"], meta["ros_m_per_min"], meta["length_breadth_ratio"])
            succeeded += 1

        except Exception as e:
            # A single cluster's bad geometry, a flaky free API, or an unexpected
            # write conflict must not take down the rest of the day's run.
            log.error("Cluster %s failed, skipping it and continuing: %s", cluster.get("cluster_id"), e)
            failed += 1

        time.sleep(DELAY_BETWEEN_CLUSTERS_SECONDS)

    log.info("Pipeline run complete: %d/%d clusters fully processed (%d had projection failures, "
              "polygons for those were still saved).", succeeded, len(clusters), failed)


if __name__ == "__main__":
    run()
