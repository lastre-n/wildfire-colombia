import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { fetchPolygonsInRange, fetchProjectionsInRange, getLastNDates } from "./supabaseClient.js";

const COLOMBIA_CENTER = [-74.3, 4.6];
const HISTORY_DAYS = 15;

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
    // Esri's "reference overlay" — a single transparent layer covering admin
    // boundaries, cities, water features/rivers, and roads/railways, explicitly
    // designed to sit on top of World_Imagery.
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

// Day 0 (today) through day 14+ (oldest in the window), one clearly distinct
// color per day — same red->orange->yellow ColorBrewer-derived journey used
// before, just interpolated to 15 steps so each day still reads as visually
// distinct instead of the oldest half of the window collapsing into one color.
const DAY_COLOR_STEPS = [
  "#b10026", "#ca0d21", "#e31a1c", "#f03423", "#fc4e2a",
  "#fd6e33", "#fd8d3c", "#fea044", "#feb24c", "#fec661",
  "#fed976", "#ffe38b", "#ffeda0", "#fff6b6", "#ffffcc",
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

/** Days between dateStr and todayStr, both 'YYYY-MM-DD' — used for color/label,
 * intentionally independent of the cluster's own day_index (fire lifetime), so
 * "day 0" always means "today" regardless of when a given fire started. */
function daysAgoFromToday(dateStr, todayStr) {
  const toUTCms = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUTCms(todayStr) - toUTCms(dateStr)) / 86400000);
}

function polygonsToFeatureCollection(rows, todayStr) {
  return {
    type: "FeatureCollection",
    features: rows.map((row) => {
      const daysAgo = daysAgoFromToday(row.acq_date, todayStr);
      return {
        type: "Feature",
        geometry: row.geom_geojson,
        properties: {
          cluster_id: row.cluster_id,
          days_ago: daysAgo,
          acq_date: row.acq_date,
          area_ha: row.area_ha,
          hotspot_count: row.hotspot_count,
          color: dayIndexToColor(daysAgo),
        },
      };
    }),
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
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState(null);
  const [basemap, setBasemap] = useState("street"); // "street" | "satellite"

  // Collapsible panel — defaults collapsed on narrow (mobile) screens so it
  // doesn't cover half the map on load, expanded on desktop.
  const [panelCollapsed, setPanelCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 640
  );

  const [dateOptions, setDateOptions] = useState(() => getLastNDates(HISTORY_DAYS));
  const todayStr = dateOptions[dateOptions.length - 1];

  // Multi-select: which days' POLYGONS are visible. All visible by default.
  const [visibleDates, setVisibleDates] = useState(() => new Set(dateOptions));
  // Separate multi-select: which days' PROJECTIONS are visible — independent
  // from the polygon toggle above, per-day, as requested.
  const [visibleProjectionDates, setVisibleProjectionDates] = useState(() => new Set(dateOptions));

  // Raw data fetched once (then polled) — filtering per visibleDates/
  // visibleProjectionDates happens client-side, so toggling is instant.
  const [allPolygonRows, setAllPolygonRows] = useState([]);
  const [allProjectionRows, setAllProjectionRows] = useState([]);

  function toggleDate(dateStr) {
    setVisibleDates((prev) => {
      const next = new Set(prev);
      const wasVisible = next.has(dateStr);
      if (wasVisible) next.delete(dateStr);
      else next.add(dateStr);

      // Turning a day OFF must also turn off its projection — a projection
      // for a day whose polygon isn't even shown is confusing and was staying
      // lit even after the day was deactivated.
      if (wasVisible) {
        setVisibleProjectionDates((prevProj) => {
          const nextProj = new Set(prevProj);
          nextProj.delete(dateStr);
          return nextProj;
        });
      }
      return next;
    });
  }

  function toggleProjectionDate(dateStr) {
    setVisibleProjectionDates((prev) => {
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
            `<strong>${p.cluster_id}</strong><br/>Fecha: ${p.acq_date} · Hace ${p.days_ago} día${p.days_ago === 1 ? "" : "s"}<br/>` +
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

  // Fetch the full history window once the map is ready, and refresh every 10 minutes.
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
  }, [mapReady, dateOptions[0]]);

  // Keep the day window itself current — without this, a tab left open across
  // a day boundary freezes "today" at whatever it was on page load, and every
  // subsequent real day's data gets silently filtered out (fetched, but never
  // added to visibleDates/visibleProjectionDates). Re-checks on a timer AND
  // when the tab regains focus, so coming back after being away also catches up.
  useEffect(() => {
    function refreshDateWindowIfStale() {
      const fresh = getLastNDates(HISTORY_DAYS);
      const freshToday = fresh[fresh.length - 1];
      setDateOptions((prevOptions) => {
        const prevToday = prevOptions[prevOptions.length - 1];
        if (freshToday === prevToday) return prevOptions; // no day boundary crossed, nothing to do

        const newlyAppeared = fresh.filter((d) => !prevOptions.includes(d));
        setVisibleDates((prev) => {
          const next = new Set(prev);
          newlyAppeared.forEach((d) => next.add(d)); // new days default to visible, like page load
          return next;
        });
        setVisibleProjectionDates((prev) => {
          const next = new Set(prev);
          newlyAppeared.forEach((d) => next.add(d));
          return next;
        });
        return fresh;
      });
    }

    const interval = setInterval(refreshDateWindowIfStale, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", refreshDateWindowIfStale);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshDateWindowIfStale);
    };
  }, []);

  const visibleClusterCount = useMemo(() => {
    const ids = new Set(
      allPolygonRows.filter((r) => visibleDates.has(r.acq_date)).map((r) => r.cluster_id)
    );
    return ids.size;
  }, [allPolygonRows, visibleDates]);

  // Re-render the map layers whenever the raw data OR either day-toggle set changes.
  useEffect(() => {
    if (!mapReady) return;
    const filteredPolygons = allPolygonRows.filter((r) => visibleDates.has(r.acq_date));
    const filteredProjections = allProjectionRows.filter((r) => visibleProjectionDates.has(r.base_date));

    mapRef.current.getSource("fire-polygons").setData(polygonsToFeatureCollection(filteredPolygons, todayStr));
    mapRef.current.getSource("fire-projections").setData(projectionsToFeatureCollection(filteredProjections));
  }, [mapReady, allPolygonRows, allProjectionRows, visibleDates, visibleProjectionDates, todayStr]);

  // Toggle base layer (street vs. satellite) by swapping which raster layer is visible.
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

      <div className={`panel ${panelCollapsed ? "collapsed" : ""}`}>
        <div className="panel-header">
          <div>
            <h1>Monitoreo de Incendios</h1>
            {!panelCollapsed && <div className="subtitle">Colombia — evolución diaria y proyección 24h</div>}
          </div>
          <button
            className="panel-toggle"
            onClick={() => setPanelCollapsed((v) => !v)}
            aria-label={panelCollapsed ? "Expandir panel" : "Colapsar panel"}
          >
            {panelCollapsed ? "▸" : "▾"}
          </button>
        </div>

        {!panelCollapsed && (
          <>
            <div className="day-legend-strip">
              {DAY_COLOR_STEPS.map((color, i) => (
                <div key={i} className="day-legend-item">
                  <span className="swatch" style={{ background: color }} />
                  <span className="day-legend-num">{i === DAY_COLOR_STEPS.length - 1 ? `${i}+` : i}</span>
                </div>
              ))}
            </div>
            <div className="subtitle" style={{ marginTop: 4 }}>Antigüedad de la detección (días atrás)</div>

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

            <div className="projection-note">
              La proyección de 24h (verde fluorescente) se activa/desactiva por
              día individual desde la línea de tiempo, abajo. Estimación basada
              en viento, pendiente y tipo de combustible (modelo tipo Rothermel +
              elipse de Anderson) — es una ayuda de planeación, no una predicción
              operativa certificada.
            </div>
          </>
        )}
      </div>

      <div className="status">
        {error
          ? error
          : `${visibleClusterCount} incendios visibles${
              lastUpdated ? ` · actualizado ${lastUpdated.toLocaleTimeString("es-CO")}` : ""
            }`}
      </div>

      <div className="timeline">
        <div className="timeline-label">Últimos {HISTORY_DAYS} días — clic en la fecha: polígono · switch: proyección 24h</div>
        <div className="timeline-track">
          {dateOptions.map((d) => (
            <div key={d} className={`timeline-day-card ${visibleDates.has(d) ? "active" : ""}`}>
              <button className="timeline-day-label" onClick={() => toggleDate(d)}>
                {formatDateLabel(d, d === todayStr)}
              </button>
              <label
                className="mini-switch"
                title={`Proyección 24h — ${formatDateLabel(d, d === todayStr)}`}
              >
                <input
                  type="checkbox"
                  checked={visibleProjectionDates.has(d)}
                  onChange={() => toggleProjectionDate(d)}
                />
                <span className="mini-switch-track">
                  <span className="mini-switch-thumb" />
                </span>
              </label>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
