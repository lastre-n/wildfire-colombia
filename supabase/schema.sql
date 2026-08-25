-- Wildfire Colombia — Supabase / PostGIS schema
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query)

create extension if not exists postgis;

-- ── Raw hotspot detections (FIRMS VIIRS/MODIS, NOAA GOES) ─────────────────
create table if not exists fire_hotspots (
  id            bigserial primary key,
  source        text        not null,          -- 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'MODIS_NRT', 'GOES'
  acq_date      date        not null,
  acq_time      text,                            -- raw HHMM from FIRMS, kept as text
  latitude      double precision not null,
  longitude     double precision not null,
  frp           double precision,               -- fire radiative power (MW) — proxy for intensity
  confidence    text,
  satellite     text,
  geom          geometry(Point, 4326) generated always as (
                  st_setsrid(st_makepoint(longitude, latitude), 4326)
                ) stored,
  inserted_at   timestamptz default now(),
  unique (source, acq_date, acq_time, latitude, longitude)
);
create index if not exists idx_hotspots_geom on fire_hotspots using gist (geom);
create index if not exists idx_hotspots_date on fire_hotspots (acq_date);

-- ── Daily fire-extent polygons (one row per fire cluster per day) ─────────
-- day_index lets the frontend colour polygons by "days since first detected"
create table if not exists fire_polygons (
  id            bigserial primary key,
  cluster_id    text        not null,           -- stable id per fire event, e.g. 'COL-2026-08-14-003'
  acq_date      date        not null,
  day_index     int         not null,           -- 0 = first day this cluster was seen, 1 = next day, etc.
  geom          geometry(Polygon, 4326) not null,
  area_ha       double precision,
  hotspot_count int,
  mean_frp      double precision,
  created_at    timestamptz default now(),
  unique (cluster_id, acq_date)
);
create index if not exists idx_polygons_geom on fire_polygons using gist (geom);
create index if not exists idx_polygons_cluster on fire_polygons (cluster_id, acq_date);

-- ── 24h spread projection polygons ─────────────────────────────────────────
create table if not exists fire_projections (
  id              bigserial primary key,
  cluster_id      text        not null,
  base_date       date        not null,          -- the day this projection was computed from
  valid_until     timestamptz not null,           -- base_date + 24h
  geom            geometry(Polygon, 4326) not null,
  model_name      text        not null default 'rothermel_huygens_ellipse',
  wind_speed_ms   double precision,
  wind_dir_deg    double precision,
  ros_m_per_min   double precision,               -- rate of spread used
  length_breadth_ratio double precision,
  notes           text,                            -- e.g. uncertainty caveat shown in the UI
  created_at      timestamptz default now(),
  unique (cluster_id, base_date)
);
create index if not exists idx_projections_geom on fire_projections using gist (geom);

-- ── Weather snapshots used as model input (kept for audit/reproducibility) ─
create table if not exists weather_snapshots (
  id            bigserial primary key,
  cluster_id    text,
  acq_date      date not null,
  latitude      double precision not null,
  longitude     double precision not null,
  temp_c        double precision,
  humidity_pct  double precision,
  wind_speed_ms double precision,
  wind_dir_deg  double precision,
  source        text default 'open-meteo',
  created_at    timestamptz default now()
);

-- ── Row Level Security: public read-only, service role writes ─────────────
alter table fire_hotspots enable row level security;
alter table fire_polygons enable row level security;
alter table fire_projections enable row level security;
alter table weather_snapshots enable row level security;

create policy "public read hotspots" on fire_hotspots for select using (true);
create policy "public read polygons" on fire_polygons for select using (true);
create policy "public read projections" on fire_projections for select using (true);
create policy "public read weather" on weather_snapshots for select using (true);

-- Writes only via the service_role key (used by the GitHub Actions pipeline),
-- which bypasses RLS by default — no insert/update policy needed for anon/authenticated.

-- ── GeoJSON views ───────────────────────────────────────────────────────────
-- PostgREST returns PostGIS `geometry` columns as WKB by default. The pipeline
-- (for cluster-id matching) and the frontend (for map rendering) both need
-- GeoJSON, so expose it explicitly here instead of decoding WKB client-side.
create or replace view fire_polygons_geojson as
select
  id, cluster_id, acq_date, day_index, area_ha, hotspot_count, mean_frp, created_at,
  st_asgeojson(geom)::json as geom_geojson
from fire_polygons;

create or replace view fire_projections_geojson as
select
  id, cluster_id, base_date, valid_until, model_name, wind_speed_ms, wind_dir_deg,
  ros_m_per_min, length_breadth_ratio, notes, created_at,
  st_asgeojson(geom)::json as geom_geojson
from fire_projections;

create or replace view fire_hotspots_geojson as
select
  id, source, acq_date, acq_time, frp, confidence, satellite,
  st_asgeojson(geom)::json as geom_geojson
from fire_hotspots;

-- Views inherit querying (not RLS directly) — grant select to anon/authenticated,
-- underlying table RLS policies above still gate the actual rows returned.
grant select on fire_polygons_geojson to anon, authenticated;
grant select on fire_projections_geojson to anon, authenticated;
grant select on fire_hotspots_geojson to anon, authenticated;
