import React, { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { fetchPolygonsUpTo, fetchProjectionsForDate, getLastNDates } from "./supabaseClient.js";

const COLOMBIA_CENTER = [-74.3, 4.6];
const MAX_DAY_INDEX_FOR_COLOR = 10; // day_index above this all render as the oldest color

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
  },
  layers: [
    { id: "osm-layer", type: "raster", source: "osm-tiles", layout: { visibility: "visible" } },
    { id: "satellite-layer", type: "raster", source: "satellite-tiles", layout: { visibility: "none" } },
  ],
};

function dayIndexToColor(dayIndex) {
  // Fresh fire = bright ember yellow-orange. Older/advancing perimeter = deep red.
  const t = Math.min(dayIndex, MAX_DAY_INDEX_FOR_COLOR) / MAX_DAY_INDEX_FOR_COLOR;
  const start = [255, 214, 10];  // #FFD60A
  const end = [122, 0, 10];      // #7A000A
  const rgb = start.map((s, i) => Math.round(s + (end[i] - s) * t));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function formatDateLabel(dateStr, isToday) {
  if (isToday) return "Hoy";
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

function polygonsToFeatureCollection(byClusterMap) {
  const features = [];
  for (const rows of byClusterMap.values()) {
    for (const row of rows) {
      features.push({
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
      });
    }
  }
  return { type: "FeatureCollection", features };
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
  const [clusterCount, setClusterCount] = useState(0);
  const [error, setError] = useState(null);

  const dateOptions = React.useMemo(() => getLastNDates(7), []);
  const todayStr = dateOptions[dateOptions.length - 1];
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [basemap, setBasemap] = useState("street"); // "street" | "satellite"

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

  // Load data whenever the map becomes ready OR the selected timeline date changes.
  // Auto-refresh only makes sense while viewing "today" — a past day's data is fixed.
  useEffect(() => {
    if (!mapReady) return;

    async function loadData() {
      try {
        const [polygonsByCluster, projections] = await Promise.all([
          fetchPolygonsUpTo(selectedDate),
          fetchProjectionsForDate(selectedDate),
        ]);

        const polygonFC = polygonsToFeatureCollection(polygonsByCluster);
        const projectionFC = projectionsToFeatureCollection(projections);

        mapRef.current.getSource("fire-polygons").setData(polygonFC);
        mapRef.current.getSource("fire-projections").setData(projectionFC);

        setClusterCount(polygonsByCluster.size);
        setLastUpdated(new Date());
        setError(null);
      } catch (err) {
        console.error(err);
        setError("No se pudieron cargar los datos. Verifica la configuración de Supabase.");
      }
    }

    loadData();

    if (selectedDate !== todayStr) return; // don't poll while viewing a past day
    const interval = setInterval(loadData, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [mapReady, selectedDate]);

  // Toggle projection layer visibility.
  useEffect(() => {
    if (!mapReady) return;
    const visibility = showProjection ? "visible" : "none";
    mapRef.current.setLayoutProperty("fire-projections-fill", "visibility", visibility);
    mapRef.current.setLayoutProperty("fire-projections-outline", "visibility", visibility);
  }, [showProjection, mapReady]);

  // Toggle base layer (street vs. satellite) by swapping which raster layer is visible.
  useEffect(() => {
    if (!mapReady) return;
    mapRef.current.setLayoutProperty("osm-layer", "visibility", basemap === "street" ? "visible" : "none");
    mapRef.current.setLayoutProperty("satellite-layer", "visibility", basemap === "satellite" ? "visible" : "none");
  }, [basemap, mapReady]);

  return (
    <div className="app">
      <div id="map" ref={mapContainer} />

      <div className="panel">
        <h1>Monitoreo de Incendios</h1>
        <div className="subtitle">Colombia — evolución diaria y proyección 24h</div>

        <div className="legend-row">
          <span className="swatch" style={{ background: dayIndexToColor(0) }} />
          Detección reciente (día 0)
        </div>
        <div className="legend-row">
          <span className="swatch" style={{ background: dayIndexToColor(5) }} />
          En evolución (día 5+)
        </div>
        <div className="legend-row">
          <span className="swatch" style={{ background: dayIndexToColor(10) }} />
          Avanzado (día 10+)
        </div>

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
          : `${clusterCount} incendios activos${
              lastUpdated ? ` · actualizado ${lastUpdated.toLocaleTimeString("es-CO")}` : ""
            }${selectedDate !== todayStr ? ` · viendo ${formatDateLabel(selectedDate, false)}` : ""}`}
      </div>

      <div className="timeline">
        <div className="timeline-label">Últimos 7 días</div>
        <div className="timeline-track">
          {dateOptions.map((d) => (
            <button
              key={d}
              className={`timeline-day ${d === selectedDate ? "active" : ""}`}
              onClick={() => setSelectedDate(d)}
            >
              {formatDateLabel(d, d === todayStr)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
