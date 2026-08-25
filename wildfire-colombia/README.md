# Monitoreo de Incendios — Colombia

Zero-cost wildfire monitoring web app for Colombia: daily fire-evolution polygons
(colored by day) built from NASA FIRMS hotspots, plus a 24h spread projection
layer driven by wind/slope/fuel, toggleable on the map.

## Architecture (all free tiers)

```
GitHub Actions (daily cron)          Supabase (Postgres + PostGIS)         Frontend
┌─────────────────────────┐          ┌──────────────────────────┐         ┌──────────────────┐
│ pipeline/main.py         │ writes → │ fire_hotspots             │ reads → │ React + MapLibre  │
│  - FIRMS (VIIRS/MODIS)   │          │ fire_polygons             │  (via  │  GL                │
│  - Open-Meteo (wind/temp)│          │ fire_projections          │ Postgr │  hosted on Vercel/ │
│  - WorldCover (fuel)     │          │ weather_snapshots         │  EST)  │  Cloudflare Pages   │
│  - slope estimate        │          │ + GeoJSON views           │         └──────────────────┘
│  - spread model          │          └──────────────────────────┘
└─────────────────────────┘
```

No server ever needs to stay running: GitHub Actions triggers the pipeline on a
schedule, Supabase's free tier includes PostGIS + an auto-generated REST API
(PostgREST), and the frontend is a static build.

## 1. Set up Supabase

1. Create a free project at https://supabase.com.
2. Open the SQL Editor and run `supabase/schema.sql` in full.
3. Go to Project Settings → API and copy:
   - `Project URL` → used as `SUPABASE_URL` / `VITE_SUPABASE_URL`
   - `anon` public key → used as `VITE_SUPABASE_ANON_KEY` (frontend, safe to expose)
   - `service_role` key → used as `SUPABASE_SERVICE_KEY` (pipeline only, **never** in the frontend)

## 2. Get a FIRMS MAP_KEY

Free, instant signup: https://firms.modaps.eosdis.nasa.gov/api/map_key/

## 3. Run the pipeline

**Locally (for testing):**
```bash
cd pipeline
cp .env.example .env   # fill in your keys
pip install -r requirements.txt
python main.py
```

**In production (GitHub Actions):**
1. Push this repo to GitHub.
2. Repo Settings → Secrets and variables → Actions → add:
   - `FIRMS_MAP_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
3. The workflow in `.github/workflows/daily_pipeline.yml` runs automatically once a
   day, and you can also trigger it manually from the Actions tab
   ("Run workflow" button) to backfill data immediately instead of waiting.

## 4. Run the frontend

```bash
cd frontend
cp .env.example .env.local   # fill in SUPABASE_URL + anon key
npm install
npm run dev
```

Deploy for free on Vercel, Netlify, or Cloudflare Pages: connect the repo, set
the build command to `npm run build` (in the `frontend/` directory), output
directory `dist`, and add the two `VITE_*` env vars in the project settings.

## What each piece does

- **`pipeline/fetch_firms.py`** — pulls active-fire detections (VIIRS SNPP + NOAA-20,
  MODIS) for the Colombia bounding box from NASA FIRMS.
- **`pipeline/cluster_hotspots.py`** — DBSCAN-clusters raw hotspot points into
  fire events, builds a concave-hull polygon per cluster, and keeps `cluster_id` +
  `day_index` stable day-to-day so the frontend can color a fire's polygon by
  how long it's been burning.
- **`pipeline/fetch_weather.py`** — wind speed/direction + temperature from
  Open-Meteo (free, no key, global coverage).
- **`pipeline/fetch_terrain.py`** — approximate slope at the fire's location
  (swap in direct Copernicus DEM raster reads for higher accuracy later — see
  the comment at the bottom of the file).
- **`pipeline/fetch_fuel.py`** — looks up ESA WorldCover land cover to pick a
  fuel category (grass / shrub / timber).
- **`pipeline/fire_spread_model.py`** — the 24h projection: a simplified
  Rothermel-style rate-of-spread combined with an Anderson (1983) elliptical
  fire-growth shape. This is a planning aid, not a certified operational
  prediction — see the caveat text stored in every projection's `notes` field
  and surfaced in the UI.
- **`frontend/`** — MapLibre GL map: fire polygons colored on a yellow→red
  ramp by `day_index`, and a fluorescent green 24h projection layer behind a
  checkbox.

## Known limitations / next steps

- **IDEAM** (Colombia's national met/hydro institute) doesn't yet have a stable
  public API for fire data — it's in a national system co-creation phase as of
  late 2025. Worth revisiting once that ships, as a validation layer.
- The slope/fuel lookups hit free public APIs (Open-Elevation, Terrascope WMS)
  that aren't built for high request volume — fine for a few dozen active fire
  clusters/day, but consider caching or switching to direct raster reads
  (Copernicus DEM COGs, local WorldCover tiles) if you scale up.
- `cluster_id` matching between days uses simple centroid-distance — good
  enough for most cases, but a fast-moving fire or two merging fires can
  confuse it. Worth revisiting with a proper polygon-overlap match if you see
  that happening in the data.
- Supabase free tier: 500MB database storage. Vector polygon/point data is
  small, so this should last a long time, but add a retention job (e.g. drop
  hotspot rows older than 90 days) if you approach the limit.
