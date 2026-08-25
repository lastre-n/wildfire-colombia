"""
24-hour fire spread projection.

Literature basis:
  - Rate of spread driven by fuel type + wind + slope, in the spirit of the
    Rothermel (1972) surface fire spread model — simplified here to fuel-model
    coefficients rather than the full physical combustion equations.
  - Fire shape propagated as an ellipse using the Huygens-principle wave
    propagation approach used in FARSITE/Prometheus, with the elliptical
    length-to-breadth ratio from wind speed per Anderson (1983) / Alexander (1985).

This is a planning/situational-awareness aid, not a certified operational fire
model. Every projection carries this caveat through to the `notes` field that
gets stored and displayed in the UI.
"""
import math
from datetime import datetime, timedelta, timezone

from pyproj import Transformer
from shapely.affinity import rotate, scale, translate
from shapely.geometry import Point, mapping
from shapely.ops import transform as shp_transform

from config import FUEL_PARAMS, DEFAULT_FUEL

_TO_METERS = Transformer.from_crs("EPSG:4326", "EPSG:3116", always_xy=True)
_TO_WGS84 = Transformer.from_crs("EPSG:3116", "EPSG:4326", always_xy=True)

MODEL_NAME = "rothermel_fuel_coeff__anderson_ellipse_v1"
BACKING_RATIO = 0.10  # backing (downwind-against-wind) spread as a fraction of heading spread — common simplifying assumption


MAX_LENGTH_BREADTH_RATIO = 8.0  # Alexander (1985) fire-behavior tables treat L/B as
                                 # saturating around 8-10 even at extreme wind speeds;
                                 # the raw Anderson exponential is only fit to moderate
                                 # winds and diverges unrealistically beyond ~40 km/h.


def anderson_length_to_breadth(wind_speed_ms: float) -> float:
    """Empirical L/B ratio vs. 10m wind speed (Anderson 1983, wind speed in mph), capped
    per Alexander (1985) to avoid degenerate needle-thin ellipses at high wind speeds."""
    wind_mph = min(wind_speed_ms, 15) * 2.23694  # clamp input before the exponential, not just the output
    lb = 0.936 * math.exp(0.2566 * wind_mph) + 0.461 * math.exp(-0.1548 * wind_mph) - 0.397
    return min(max(lb, 1.0), MAX_LENGTH_BREADTH_RATIO)


def compute_ros_m_per_min(fuel: str, wind_speed_ms: float, slope_deg: float) -> float:
    params = FUEL_PARAMS.get(fuel, FUEL_PARAMS[DEFAULT_FUEL])
    wind_factor = 1 + params["wind_coeff"] * max(wind_speed_ms, 0)
    # Rough upslope acceleration / downslope deceleration; steep slopes on the
    # lee/head side are the dominant real-world driver after wind.
    slope_factor = 1 + 0.03 * slope_deg
    return params["ros_base_m_min"] * wind_factor * slope_factor


def _compass_to_math_deg(bearing_deg: float) -> float:
    """Convert a compass bearing (0=N, clockwise) to a math angle (0=E, counterclockwise)."""
    return (90 - bearing_deg) % 360


def project_fire_ellipse(
    centroid_lon: float,
    centroid_lat: float,
    fuel: str,
    wind_speed_ms: float,
    wind_dir_deg: float,
    slope_deg: float = 0.0,
    hours: float = 24.0,
):
    """
    Returns (shapely_polygon_wgs84, metadata_dict).
    wind_dir_deg is the meteorological convention: direction the wind is
    coming FROM. The fire spreads in the direction the wind blows TO
    (wind_dir_deg + 180).
    """
    minutes = hours * 60

    head_ros = compute_ros_m_per_min(fuel, wind_speed_ms, slope_deg)
    back_ros = head_ros * BACKING_RATIO
    lb_ratio = anderson_length_to_breadth(wind_speed_ms)

    head_dist = head_ros * minutes
    back_dist = back_ros * minutes
    major_axis = head_dist + back_dist
    semi_major = major_axis / 2
    semi_minor = semi_major / lb_ratio

    # The ignition point is a focus of the ellipse, not its center — offset the
    # center forward from the ignition point along the spread direction.
    forward_offset = head_dist - semi_major

    spread_bearing = (wind_dir_deg + 180) % 360
    math_angle = _compass_to_math_deg(spread_bearing)
    rad = math.radians(math_angle)

    unit_circle = Point(0, 0).buffer(1, resolution=64)
    ellipse = scale(unit_circle, semi_major, semi_minor)
    ellipse = rotate(ellipse, math_angle, origin=(0, 0), use_radians=False)
    ellipse = translate(ellipse, xoff=forward_offset * math.cos(rad), yoff=forward_offset * math.sin(rad))

    cx, cy = _TO_METERS.transform(centroid_lon, centroid_lat)
    ellipse = translate(ellipse, xoff=cx, yoff=cy)

    ellipse_wgs84 = shp_transform(lambda x, y: _TO_WGS84.transform(x, y), ellipse)

    meta = {
        "model_name": MODEL_NAME,
        "wind_speed_ms": wind_speed_ms,
        "wind_dir_deg": wind_dir_deg,
        "ros_m_per_min": head_ros,
        "length_breadth_ratio": lb_ratio,
        "notes": (
            "Simplified Rothermel-style rate-of-spread with an Anderson (1983) elliptical "
            "growth model. Situational-awareness estimate only — not a certified operational "
            "fire behavior prediction. Assumes uniform fuel/wind over the projection window; "
            "does not model spotting, fire whirls, or fuel moisture changes."
        ),
    }
    return ellipse_wgs84, meta


def projection_geojson_and_meta(centroid_lon, centroid_lat, fuel, wind_speed_ms, wind_dir_deg, slope_deg, base_date):
    polygon, meta = project_fire_ellipse(centroid_lon, centroid_lat, fuel, wind_speed_ms, wind_dir_deg, slope_deg)
    valid_until = datetime.combine(base_date, datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=24)
    meta["valid_until"] = valid_until.isoformat()
    return mapping(polygon), meta
