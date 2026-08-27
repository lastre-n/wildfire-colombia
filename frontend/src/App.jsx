import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { fetchPolygonsInRange, fetchProjectionsInRange, getLastNDates } from "./supabaseClient.js";

const COLOMBIA_CENTER = [-74.3, 4.6];
const HISTORY_DAYS = 7;

// Two free, no-API-key raster basemaps as plain tile sources — toggled via
// layer visibility rather than swapping the whole style (which would wipe out
// our custom fire-data sources/layers and force re-adding everything).
const BASE_STYLE = {
  version: 8,
  sources: {
    "osm-tiles": {
      type: "raster",
      tiles: [
        "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
    "satellite-tiles": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Esri, Maxar, Earthstar Geographics",
    },
    // Esri's "reference overlay" — a single transparent layer covering exactly
    // what was asked for (admin boundaries, cities, water features/rivers,
    // roads/railways), explicitly designed to sit on top of World_Imagery.
    "reference-overlay-tiles": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Reference_Overlay/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Esri, Garmin, USGS, NPS",
    },
  },
  layers: [
    { id: "osm-layer", type: "raster", source: "osm-tiles", layout: { visibility: "visible" } },
    { id: "satellite-layer", type: "raster", source: "satellite-tiles", layout: { visibility: "none" } },
    { id: "reference-overlay-layer", type: "raster", source: "reference-overlay-tiles", layout: { visibility: "none" } },
  ],
};

// Day 0 through day 7+, one clearly distinct color per day (not a smooth blend) —
// ColorBrewer's "YlOrRd" 8-class palette, designed for maximum perceptual
// separation between adjacent steps while still reading as yellow->orange->red.
const DAY_COLOR_STEPS = [
  "#b10026", "#e31a1c", "#fc4e2a", "#fd8d3c",
  "#feb24c", "#fed976", "#ffeda0", "#ffffcc",
];

function dayIndexToColor(dayIndex) {
  return DAY_COLOR_STEPS[Math.min(dayIndex, DAY_COLOR_STEPS.length - 1)];
}

function formatDateLabel(dateStr, isToday) {
  if (isToday) return "Hoy";
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

function polygonsToFeatureCollection(rows) {
  return {
    type: "FeatureCollection",
    features: rows.map((row) => ({
      type: "Feature",
      geometry: row.geom_geojson,
      properties: {
        cluster_id: row.cluster_id,
        day_index: row.day_index,
        acq_date: row.acq_date,
        area_ha: row.area_ha,
        hotspot_count: row.hotspot_count,
        color: dayIndexToColor(row.day_index),
      },
    })),
  };
}

function projectionsToFeatureCollection(rows) {
  return {
    type: "FeatureCollection",
    features: rows.map((row) => ({
      type: "Feature",
      geometry: row.geom_geojson,
      properties: {
        cluster_id: row.cluster_id,
        valid_until: row.valid_until,
        ros_m_per_min: row.ros_m_per_min,
        wind_speed_ms: row.wind_speed_ms,
        wind_dir_deg: row.wind_dir_deg,
        notes: row.notes,
      },
    })),
  };
}

export default function App() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [showProjection, setShowProjection] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState(null);
  const [basemap, setBasemap] = useState("street"); // "street" | "satellite"

  const dateOptions = useMemo(() => getLastNDates(HISTORY_DAYS), []);
  const todayStr = dateOptions[dateOptions.length - 1];

  // Multi-select: which of the last 7 days are currently visible on the map.
  // All visible by default (same overall look as before this feature existed).
  const [visibleDates, setVisibleDates] = useState(() => new Set(dateOptions));

  // Raw data fetched once (then polled) — filtering per visibleDates happens
  // client-side, so toggling a day on/off is instant with no network round-trip.
  const [allPolygonRows, setAllPolygonRows] = useState([]);
  const [allProjectionRows, setAllProjectionRows] = useState([]);

  function toggleDate(dateStr) {
    setVisibleDates((prev) => {
      const next = new Set(prev);
      if (next.has(dateStr)) next.delete(dateStr);
      else next.add(dateStr);
      return next;
    });
  }

  // Initialize the map once.
  useEffect(() => {
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: BASE_STYLE,
      center: COLOMBIA_CENTER,
      zoom: 5.2,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("load", () => {
      map.addSource("fire-polygons", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("fire-projections", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

      map.addLayer({
        id: "fire-polygons-fill",
        type: "fill",
        source: "fire-polygons",
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.55 },
      });
      map.addLayer({
        id: "fire-polygons-outline",
        type: "line",
        source: "fire-polygons",
        paint: { "line-color": ["get", "color"], "line-width": 1.5 },
      });

      // Fluorescent projection layer — distinct from the day-evolution palette on purpose.
      map.addLayer({
        id: "fire-projections-fill",
        type: "fill",
        source: "fire-projections",
        paint: { "fill-color": "#39ff14", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "fire-projections-outline",
        type: "line",
        source: "fire-projections",
        paint: { "line-color": "#39ff14", "line-width": 2, "line-dasharray": [2, 1.5] },
      });

      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

      map.on("mousemove", "fire-polygons-fill", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const p = e.features[0].properties;
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `<strong>${p.cluster_id}</strong><br/>Fecha: ${p.acq_date} · Día ${p.day_index}<br/>` +
              `Área: ${Number(p.area_ha).toFixed(1)} ha · Focos: ${p.hotspot_count}`
          )
          .addTo(map);
      });
      map.on("mouseleave", "fire-polygons-fill", () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });

      map.on("mousemove", "fire-projections-fill", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const p = e.features[0].properties;
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `<strong>Proyección 24h — ${p.cluster_id}</strong><br/>` +
              `Viento: ${Number(p.wind_speed_ms).toFixed(1)} m/s desde ${Math.round(p.wind_dir_deg)}°<br/>` +
              `Avance estimado: ${Number(p.ros_m_per_min).toFixed(1)} m/min<br/>` +
              `<em>Válido hasta: ${new Date(p.valid_until).toLocaleString("es-CO")}</em>`
          )
          .addTo(map);
      });
      map.on("mouseleave", "fire-projections-fill", () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });

      mapRef.current = map;
      setMapReady(true);
    });

    return () => map.remove();
  }, []);

  // Fetch the full 7-day window once the map is ready, and refresh every 10 minutes.
  useEffect(() => {
    if (!mapReady) return;

    async function loadData() {
      try {
        const [polygonRows, projectionRows] = await Promise.all([
          fetchPolygonsInRange(dateOptions[0]),
          fetchProjectionsInRange(dateOptions[0]),
        ]);
        setAllPolygonRows(polygonRows);
        setAllProjectionRows(projectionRows);
        setLastUpdated(new Date());
        setError(null);
      } catch (err) {
        console.error(err);
        setError("No se pudieron cargar los datos. Verifica la configuración de Supabase.");
      }
    }

    loadData();
    const interval = setInterval(loadData, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [mapReady]);

  // Re-render the map layers whenever the raw data OR the day toggles change —
  // purely client-side filtering, no re-fetch.
  const visibleClusterCount = useMemo(() => {
    const ids = new Set(
      allPolygonRows.filter((r) => visibleDates.has(r.acq_date)).map((r) => r.cluster_id)
    );
    return ids.size;
  }, [allPolygonRows, visibleDates]);

  useEffect(() => {
    if (!mapReady) return;
    const filteredPolygons = allPolygonRows.filter((r) => visibleDates.has(r.acq_date));
    const filteredProjections = allProjectionRows.filter((r) => visibleDates.has(r.base_date));

    mapRef.current.getSource("fire-polygons").setData(polygonsToFeatureCollection(filteredPolygons));
    mapRef.current.getSource("fire-projections").setData(projectionsToFeatureCollection(filteredProjections));
  }, [mapReady, allPolygonRows, allProjectionRows, visibleDates]);

  // Toggle projection layer visibility.
  useEffect(() => {
    if (!mapReady) return;
    const visibility = showProjection ? "visible" : "none";
    mapRef.current.setLayoutProperty("fire-projections-fill", "visibility", visibility);
    mapRef.current.setLayoutProperty("fire-projections-outline", "visibility", visibility);
  }, [showProjection, mapReady]);

  // Toggle base layer (street vs. satellite) by swapping which raster layer is visible.
  // The Esri reference overlay (boundaries/cities/rivers/roads) only makes sense
  // paired with the satellite imagery — OSM's street tiles already render all of
  // that natively — so it follows the same on/off switch as the satellite layer.
  useEffect(() => {
    if (!mapReady) return;
    const isSatellite = basemap === "satellite";
    mapRef.current.setLayoutProperty("osm-layer", "visibility", isSatellite ? "none" : "visible");
    mapRef.current.setLayoutProperty("satellite-layer", "visibility", isSatellite ? "visible" : "none");
    mapRef.current.setLayoutProperty("reference-overlay-layer", "visibility", isSatellite ? "visible" : "none");
  }, [basemap, mapReady]);

  return (
    <div className="app">
      <div id="map" ref={mapContainer} />

      <div className="panel">
        <h1>Monitoreo de Incendios</h1>
        <div className="subtitle">Colombia — evolución diaria y proyección 24h</div>

        <div className="day-legend-strip">
          {DAY_COLOR_STEPS.map((color, i) => (
            <div key={i} className="day-legend-item">
              <span className="swatch" style={{ background: color }} />
              <span className="day-legend-num">{i === DAY_COLOR_STEPS.length - 1 ? `${i}+` : i}</span>
            </div>
          ))}
        </div>
        <div className="subtitle" style={{ marginTop: 4 }}>Día de evolución del incendio</div>

        <div className="divider" />

        <div className="basemap-toggle">
          <button
            className={basemap === "street" ? "active" : ""}
            onClick={() => setBasemap("street")}
          >
            Calles
          </button>
          <button
            className={basemap === "satellite" ? "active" : ""}
            onClick={() => setBasemap("satellite")}
          >
            Satélite
          </button>
        </div>

        <div className="divider" />

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={showProjection}
            onChange={(e) => setShowProjection(e.target.checked)}
          />
          Mostrar proyección de avance (24h)
        </label>
        <div className="projection-note">
          Estimación basada en viento, pendiente y tipo de combustible (modelo tipo
          Rothermel + elipse de Anderson). Es una ayuda de planeación, no una
          predicción operativa certificada.
        </div>
      </div>

      <div className="status">
        {error
          ? error
          : `${visibleClusterCount} incendios visibles${
              lastUpdated ? ` · actualizado ${lastUpdated.toLocaleTimeString("es-CO")}` : ""
            }`}
      </div>

      <div className="timeline">
        <div className="timeline-label">Últimos 7 días (clic para mostrar/ocultar)</div>
        <div className="timeline-track">
          {dateOptions.map((d) => (
            <button
              key={d}
              className={`timeline-day ${visibleDates.has(d) ? "active" : ""}`}
              onClick={() => toggleDate(d)}
            >
              {formatDateLabel(d, d === todayStr)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
