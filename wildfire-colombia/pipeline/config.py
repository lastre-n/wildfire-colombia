"""
Central configuration for the wildfire pipeline.
All secrets come from environment variables (set as GitHub Actions secrets in production,
or a local .env file for development — see .env.example).
"""
import os

# ── Secrets / API keys ──────────────────────────────────────────────────────
FIRMS_MAP_KEY = os.environ["FIRMS_MAP_KEY"]  # https://firms.modaps.eosdis.nasa.gov/api/map_key/
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]  # service_role key (server-side only, never in frontend)

# ── Area of interest: Colombia bounding box (west, south, east, north) ─────
COLOMBIA_BBOX = (-79.1, -4.3, -66.8, 13.5)

# ── FIRMS settings ──────────────────────────────────────────────────────────
# Sources: VIIRS 375m is the best resolution/latency tradeoff. NOAA-20 + SNPP together
# roughly double temporal coverage. MODIS kept as a lower-res cross-check.
FIRMS_SOURCES = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT"]
FIRMS_DAY_RANGE = 1  # NRT endpoint: how many days back to pull each run

# ── Clustering ───────────────────────────────────────────────────────────────
# DBSCAN eps in meters: hotspots within this distance are considered the same fire.
CLUSTER_EPS_METERS = 1500
CLUSTER_MIN_SAMPLES = 2
# A fire cluster's polygon gets buffered outward by this much to turn point
# clusters into a plausible burned-area footprint before the concave hull.
HOTSPOT_BUFFER_METERS = 375  # ~ VIIRS pixel size

# ── Fuel model lookup: ESA WorldCover class -> Scott & Burgan fuel model proxy ─
# WorldCover classes: https://esa-worldcover.org/en/data-access
# This is a simplified proxy mapping land cover to a fuel category used by the
# spread model below, not the full 40-fuel-model Scott & Burgan system.
WORLDCOVER_FUEL_MAP = {
    10: "timber_litter",    # Tree cover
    20: "shrub",            # Shrubland
    30: "grass",            # Grassland
    40: "grass",            # Cropland
    90: "grass",            # Herbaceous wetland (treated conservatively as grass)
    95: "shrub",            # Mangroves
}
DEFAULT_FUEL = "grass"

# Rate-of-spread + fuel model parameters (simplified Rothermel-style coefficients).
# ros_base_m_min: baseline spread rate at 0 wind, flat ground, moderate moisture.
# wind_coeff: multiplier applied per (m/s) of 10m wind speed above 0.
FUEL_PARAMS = {
    "grass":         {"ros_base_m_min": 3.0, "wind_coeff": 0.55},
    "shrub":         {"ros_base_m_min": 1.4, "wind_coeff": 0.35},
    "timber_litter": {"ros_base_m_min": 0.5, "wind_coeff": 0.18},
}

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
