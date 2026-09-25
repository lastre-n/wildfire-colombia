import { useEffect, useRef } from "react";
import { supabase } from "../supabaseClient.js";

const SOURCE_ID = "ops-overlays";

export default function OverlayLayers({ map, incidentId }) {
  const featuresRef = useRef([]);

  useEffect(() => {
    if (!map || !incidentId) return;
    let channel;
    let cancelled = false;

    function ensureLayers() {
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
        id: SOURCE_ID + "-points", type: "circle", source: SOURCE_ID,
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 6, "circle-color": ["get", "color"], "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
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
        { type: "Feature", geometry: row.geometry, properties: { id: row.id, color: row.color, label: row.label } },
      ];
      render();
    }
    function removeFeature(id) {
      featuresRef.current = featuresRef.current.filter((f) => f.properties.id !== id);
      render();
    }

    async function setup() {
      ensureLayers();
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
