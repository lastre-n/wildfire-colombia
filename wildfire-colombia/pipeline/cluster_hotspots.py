"""
Turn raw hotspot points into one polygon per fire cluster per day.

Steps:
  1. Project points to a local metric CRS (so distances are in meters, not degrees).
  2. DBSCAN clusters points that are close together into a single fire event.
  3. Each cluster's points are buffered (to approximate the sensor footprint) and
     wrapped in a concave hull to produce a plausible burned-area polygon.
  4. Cluster IDs are kept stable across days: a new day's cluster is matched to
     yesterday's polygon if their footprints are near/overlapping, so day_index
     increments (and the frontend can colour by day-of-evolution) instead of
     every day's fire looking like a brand-new, unrelated event.
"""
import logging
from datetime import date, timedelta

import alphashape
import numpy as np
import pandas as pd
from pyproj import Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform as shp_transform
from sklearn.cluster import DBSCAN

from config import CLUSTER_EPS_METERS, CLUSTER_MIN_SAMPLES, HOTSPOT_BUFFER_METERS

log = logging.getLogger(__name__)

# Colombia sits mostly in UTM zones 18N; good enough metric CRS for distance-based clustering.
_TO_METERS = Transformer.from_crs("EPSG:4326", "EPSG:3116", always_xy=True)
_TO_WGS84 = Transformer.from_crs("EPSG:3116", "EPSG:4326", always_xy=True)


def _cluster_polygon(points_lonlat: np.ndarray) -> dict:
    """Build a (buffered) concave hull polygon in WGS84 from a set of lon/lat points."""
    xs, ys = _TO_METERS.transform(points_lonlat[:, 0], points_lonlat[:, 1])
    pts_m = np.column_stack([xs, ys])

    if len(pts_m) < 3:
        # Not enough points for a hull — buffer each point and union instead.
        from shapely.geometry import MultiPoint
        geom_m = MultiPoint(pts_m).buffer(HOTSPOT_BUFFER_METERS)
    else:
        from shapely.geometry import MultiPoint
        try:
            geom_m = alphashape.alphashape(pts_m, alpha=1.0 / (CLUSTER_EPS_METERS))
            if geom_m is None or geom_m.is_empty or geom_m.area == 0:
                # Alpha too aggressive for this point arrangement (common with very
                # tight/near-collinear clusters) — a convex hull is a safe fallback.
                geom_m = MultiPoint(pts_m).convex_hull
            geom_m = geom_m.buffer(HOTSPOT_BUFFER_METERS)
        except Exception:
            geom_m = MultiPoint(pts_m).convex_hull.buffer(HOTSPOT_BUFFER_METERS)

    geom_wgs84 = shp_transform(lambda x, y: _TO_WGS84.transform(x, y), geom_m)
    return mapping(geom_wgs84), geom_wgs84


def cluster_today(hotspots: pd.DataFrame) -> list[dict]:
    """
    Run DBSCAN on today's hotspots and return one record per cluster:
    {geometry (geojson), shapely_geom, area_ha, hotspot_count, mean_frp, centroid_lat, centroid_lon}
    """
    if hotspots.empty:
        return []

    coords_lonlat = hotspots[["longitude", "latitude"]].to_numpy()
    xs, ys = _TO_METERS.transform(coords_lonlat[:, 0], coords_lonlat[:, 1])
    coords_m = np.column_stack([xs, ys])

    labels = DBSCAN(eps=CLUSTER_EPS_METERS, min_samples=CLUSTER_MIN_SAMPLES).fit_predict(coords_m)

    clusters = []
    for label in sorted(set(labels)):
        if label == -1:
            continue  # noise / isolated single detections, skip
        mask = labels == label
        cluster_points = coords_lonlat[mask]
        geojson_geom, shapely_geom = _cluster_polygon(cluster_points)

        area_ha = shp_transform(lambda x, y: _TO_METERS.transform(x, y), shapely_geom).area / 10_000
        frp_vals = hotspots.loc[mask, "frp"] if "frp" in hotspots.columns else pd.Series(dtype=float)

        clusters.append({
            "geometry": geojson_geom,
            "shapely_geom": shapely_geom,
            "area_ha": float(area_ha),
            "hotspot_count": int(mask.sum()),
            "mean_frp": float(frp_vals.mean()) if not frp_vals.empty else None,
            "centroid_lon": float(cluster_points[:, 0].mean()),
            "centroid_lat": float(cluster_points[:, 1].mean()),
        })

    log.info("Formed %d fire clusters from %d hotspots", len(clusters), len(hotspots))
    return clusters


def match_cluster_ids(today_clusters: list[dict], existing_polygons: list[dict], today: date,
                       match_distance_m: float = 5000) -> list[dict]:
    """
    Assign cluster_id + day_index to today's clusters.
    existing_polygons: rows from fire_polygons for the most recent prior date, each with
    keys 'cluster_id', 'day_index', 'geom_wkt' (or a shapely geometry) and a centroid.
    A today-cluster is treated as a continuation of a prior cluster if its centroid is
    within match_distance_m of that cluster's last known centroid; otherwise it's new.
    """
    from shapely import wkt as shapely_wkt

    prior_centroids = []
    for p in existing_polygons:
        geom = p["geom"] if hasattr(p["geom"], "centroid") else shapely_wkt.loads(p["geom"])
        c = geom.centroid
        prior_centroids.append({"cluster_id": p["cluster_id"], "day_index": p["day_index"],
                                 "lon": c.x, "lat": c.y})

    next_new_seq = 1
    date_str = today.isoformat()

    for cluster in today_clusters:
        best = None
        best_dist = float("inf")
        for prior in prior_centroids:
            xs, ys = _TO_METERS.transform([cluster["centroid_lon"], prior["lon"]],
                                           [cluster["centroid_lat"], prior["lat"]])
            dist = ((xs[0] - xs[1]) ** 2 + (ys[0] - ys[1]) ** 2) ** 0.5
            if dist < best_dist:
                best_dist = dist
                best = prior

        if best is not None and best_dist <= match_distance_m:
            cluster["cluster_id"] = best["cluster_id"]
            cluster["day_index"] = best["day_index"] + 1
        else:
            cluster["cluster_id"] = f"COL-{date_str}-{next_new_seq:03d}"
            cluster["day_index"] = 0
            next_new_seq += 1

    return today_clusters
