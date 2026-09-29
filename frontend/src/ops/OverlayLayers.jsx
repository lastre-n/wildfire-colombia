import { useEffect, useRef } from "react";
import { supabase } from "../supabaseClient.js";
import { OVERLAY_SOURCE_ID as SOURCE_ID } from "./overlayConstants.js";

const ICONS = {
  "icon-water": `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
    <path fill="#3E7CB1" stroke="#fff" stroke-width="1.5"
      d="M12 2C12 2 5 11 5 15.5C5 19.09 8.13 22 12 22C15.87 22 19 19.09 19 15.5C19 11 12 2 12 2Z"/>
  </svg>`,
  "icon-hydrant": `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
    <g fill="none" stroke="#C0392E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="7" width="6" height="10" rx="2" fill="#C0392E" stroke="#fff"/>
      <line x1="12" y1="3" x2="12" y2="7"/>
      <circle cx="12" cy="3" r="1.4" fill="#C0392E" stroke="#fff"/>
      <line x1="5" y1="10" x2="9" y2="10"/>
      <line x1="15" y1="10" x2="19" y2="10"/>
      <line x1="9" y1="19" x2="9" y2="21"/>
      <line x1="15" y1="19" x2="15" y2="21"/>
    </g>
  </svg>`,
};

function loadIcon(map, name) {
  return new Promise((resolve) => {
    if (map.hasImage(name)) return resolve();
    const img = new Image(32, 32);
    img.onload = () => { if (!map.hasImage(name)) map.addImage(name, img); resolve(); };
    img.src = "data:image/svg+xml;base64," + btoa(ICONS[name]);
  });
}

export default function OverlayLayers({ map, incidentId }) {
  const featuresRef = useRef([]);

  useEffect(() => {
    if (!map || !incidentId) return;
    let channel;
    let cancelled = false;

    async function ensureLayers() {
      await Promise.all([loadIcon(map, "icon-water"), loadIcon(map, "icon-hydrant")]);
      if (map.getSource(SOURCE_ID)) return;
      map.addSource(SOURCE_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: SOURCE_ID + "-fill", type: "fill", source: SOURCE_ID,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.35 },
      });
      map.addLayer({
        id: SOURCE_ID + "-outline", type: "line", source: SOURCE_ID,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": ["get", "color"], "line-width": 1.5 },
      });
      map.addLayer({
        id: SOURCE_ID + "-lines", type: "line", source: SOURCE_ID,
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": ["get", "color"], "line-width": 2.5 },
      });
      map.addLayer({
        id: SOURCE_ID + "-points", type: "symbol", source: SOURCE_ID,
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "icon-image": ["match", ["get", "layer_type"], "hidrante", "icon-hydrant", "icon-water"],
          "icon-size": 0.85,
          "icon-allow-overlap": true,
        },
      });
    }
    function render() {
      const src = map.getSource(SOURCE_ID);
      if (!src) return;
      src.setData({ type: "FeatureCollection", features: featuresRef.current });
    }
    function addFeature(row) {
      featuresRef.current = [
        ...featuresRef.current.filter((f) => f.properties.id !== row.id),
        { type: "Feature", geometry: row.geometry, properties: { id: row.id, color: row.color, label: row.label, layer_type: row.layer_type } },
      ];
      render();
    }
    function removeFeature(id) {
      featuresRef.current = featuresRef.current.filter((f) => f.properties.id !== id);
      render();
    }

    async function setup() {
      await ensureLayers();
      featuresRef.current = [];
      const { data } = await supabase.from("map_overlays").select("*").eq("incident_id", incidentId);
      if (cancelled || !data) return;
      data.forEach(addFeature);

      channel = supabase
        .channel(`overlays_${incidentId}`)
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "map_overlays", filter: `incident_id=eq.${incidentId}` },
          (payload) => addFeature(payload.new))
        .on("postgres_changes",
          { event: "DELETE", schema: "public", table: "map_overlays", filter: `incident_id=eq.${incidentId}` },
          (payload) => removeFeature(payload.old.id))
        .subscribe();
    }
    setup();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
      ["fill", "outline", "lines", "points"].forEach((suf) => {
        if (map.getLayer(SOURCE_ID + "-" + suf)) map.removeLayer(SOURCE_ID + "-" + suf);
      });
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
  }, [map, incidentId]);

  return null;
}
