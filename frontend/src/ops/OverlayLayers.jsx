import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { supabase } from "../supabaseClient.js";
import { OVERLAY_SOURCE_ID as SOURCE_ID } from "./overlayConstants.js";

const ICONS = {
  "icon-water": `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
    <path fill="#3E7CB1" stroke="#fff" stroke-width="1.5"
      d="M12 2C12 2 5 11 5 15.5C5 19.09 8.13 22 12 22C15.87 22 19 19.09 19 15.5C19 11 12 2 12 2Z"/>
  </svg>`,
  "icon-hydrant": `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
    <g fill="#C0392E" stroke="#8E2A22" stroke-width="0.5">
      <rect x="9" y="3" width="6" height="2" rx="1"/>
      <rect x="8.5" y="5" width="7" height="11" rx="2.5"/>
      <circle cx="6.5" cy="9" r="2"/>
      <circle cx="17.5" cy="9" r="2"/>
      <circle cx="12" cy="16.5" r="1.8"/>
      <rect x="7" y="18" width="10" height="2.5" rx="1"/>
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

function toFeature(row) {
  return {
    type: "Feature",
    geometry: row.geometry,
    properties: {
      id: row.id,
      color: row.color,
      label: row.label,
      layer_type: row.layer_type,
      dash: row.dash || "solid",
      fill_style: row.fill_style || "solid",
    },
  };
}

const OverlayLayers = forwardRef(function OverlayLayers({ map, incidentId }, ref) {
  const featuresRef = useRef([]);

  function render() {
    const src = map?.getSource(SOURCE_ID);
    if (!src) return;
    src.setData({ type: "FeatureCollection", features: featuresRef.current });
  }
  function addFeature(row) {
    featuresRef.current = [
      ...featuresRef.current.filter((f) => f.properties.id !== row.id),
      toFeature(row),
    ];
    render();
  }
  function removeFeature(id) {
    featuresRef.current = featuresRef.current.filter((f) => f.properties.id !== id);
    render();
  }

  useImperativeHandle(ref, () => ({ addFeature, removeFeature }), [map]);

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
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": ["match", ["get", "fill_style"], "outline", 0, 0.35],
        },
      });
      map.addLayer({
        id: SOURCE_ID + "-outline", type: "line", source: SOURCE_ID,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": ["get", "color"], "line-width": 1.5 },
      });
      map.addLayer({
        id: SOURCE_ID + "-lines", type: "line", source: SOURCE_ID,
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 2.5,
          "line-dasharray": ["match", ["get", "dash"], "dashed", ["literal", [2, 2]], ["literal", [1, 0]]],
        },
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
});

export default OverlayLayers;
