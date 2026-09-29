import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient.js";
import { OVERLAY_SOURCE_ID } from "./overlayConstants.js";

const LAYER_TYPES = [
  { key: "area_quemada", label: "Área quemada", geometryType: "polygon", color: "#6B4A3A" },
  { key: "fuente_agua", label: "Fuente de agua", geometryType: "polygon", color: "#3E7CB1" },
  { key: "zona_forestal", label: "Zona forestal", geometryType: "polygon", color: "#4C7A4F" },
  { key: "estructura", label: "Estructuras", geometryType: "polygon", color: "#8A7A5C" },
  { key: "hidrante", label: "Hidrante", geometryType: "point", color: "#C0392E" },
  { key: "punto_agua", label: "Punto de agua", geometryType: "point", color: "#3E7CB1" },
  { key: "linea", label: "Línea", geometryType: "line", color: null },
];

// Simplifica un trazo a mano alzada en tramos rectos (Douglas-Peucker)
function simplify(points, tolerance = 0.0004) {
  if (points.length < 3) return points;
  function sqDist(p, a, b) {
    let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  }
  function rdp(pts, first, last, out) {
    let maxDist = 0, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqDist(pts[i], pts[first], pts[last]);
      if (d > maxDist) { maxDist = d; idx = i; }
    }
    if (maxDist > tolerance * tolerance) {
      rdp(pts, first, idx, out);
      out.push(pts[idx]);
      rdp(pts, idx, last, out);
    }
  }
  const out = [points[0]];
  rdp(points, 0, points.length - 1, out);
  out.push(points[points.length - 1]);
  return out;
}

export default function MapEditor({ map, incidentId, active }) {
  const [layerKey, setLayerKey] = useState(null);
  const [lineColor, setLineColor] = useState("#E0932F");
  const [eraseMode, setEraseMode] = useState(false);
  const drawing = useRef(false);
  const pathRef = useRef([]);
  const previewId = "ops-draw-preview";

  // Cerrar el editor limpia cualquier modo activo, para no dejar el mapa "trabado"
  useEffect(() => {
    if (!active) { setLayerKey(null); setEraseMode(false); }
  }, [active]);

  // El paneo del mapa solo se apaga mientras el editor está abierto Y hay un modo activo
  useEffect(() => {
    if (!map) return;
    if (active && (layerKey || eraseMode)) map.dragPan.disable();
    else map.dragPan.enable();
    return () => map.dragPan.enable();
  }, [map, active, layerKey, eraseMode]);

  useEffect(() => {
    if (!map || !active) return;

    function ensurePreview() {
      if (map.getSource(previewId)) return;
      map.addSource(previewId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: previewId + "-fill", type: "fill", source: previewId,
        paint: { "fill-color": "#E0932F", "fill-opacity": 0.25 } });
      map.addLayer({ id: previewId + "-line", type: "line", source: previewId,
        paint: { "line-color": ["get", "color"], "line-width": 2 } });
    }
    function updatePreview(color) {
      const src = map.getSource(previewId);
      if (!src) return;
      const coords = pathRef.current;
      if (coords.length < 2) { src.setData({ type: "FeatureCollection", features: [] }); return; }
      src.setData({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { color }, geometry: { type: "LineString", coordinates: coords } }],
      });
    }
    async function saveOverlay(cfg, coords) {
      const color = cfg.key === "linea" ? lineColor : cfg.color;
      let geometry;
      if (cfg.geometryType === "polygon") geometry = { type: "Polygon", coordinates: [[...coords, coords[0]]] };
      else if (cfg.geometryType === "point") geometry = { type: "Point", coordinates: coords[0] };
      else geometry = { type: "LineString", coordinates: coords };
      await supabase.from("map_overlays").insert({
        incident_id: incidentId,
        geometry_type: cfg.geometryType,
        layer_type: cfg.key,
        geometry,
        color,
      });
    }
    function onDown(e) {
      if (eraseMode) return;
      if (!layerKey) return;
      const cfg = LAYER_TYPES.find((l) => l.key === layerKey);
      if (cfg.geometryType === "point") { saveOverlay(cfg, [[e.lngLat.lng, e.lngLat.lat]]); return; }
      drawing.current = true;
      pathRef.current = [[e.lngLat.lng, e.lngLat.lat]];
      ensurePreview();
    }
    function onMove(e) {
      if (!drawing.current) return;
      pathRef.current.push([e.lngLat.lng, e.lngLat.lat]);
      updatePreview(layerKey === "linea" ? lineColor : "#E0932F");
    }
    function onUp() {
      if (!drawing.current) return;
      drawing.current = false;
      const cfg = LAYER_TYPES.find((l) => l.key === layerKey);
      const simplified = simplify(pathRef.current);
      if (cfg && simplified.length >= 2) saveOverlay(cfg, simplified);
      pathRef.current = [];
      updatePreview("#E0932F");
    }
    function onClick(e) {
      if (!eraseMode) return;
      const layers = [OVERLAY_SOURCE_ID + "-fill", OVERLAY_SOURCE_ID + "-lines", OVERLAY_SOURCE_ID + "-points"]
        .filter((id) => map.getLayer(id));
      if (!layers.length) return;
      const feats = map.queryRenderedFeatures(e.point, { layers });
      if (!feats.length) return;
      const id = feats[0].properties.id;
      supabase.from("map_overlays").delete().eq("id", id);
    }

    map.on("mousedown", onDown);
    map.on("mousemove", onMove);
    map.on("mouseup", onUp);
    map.on("touchstart", onDown);
    map.on("touchmove", onMove);
    map.on("touchend", onUp);
    map.on("click", onClick);

    return () => {
      map.off("mousedown", onDown);
      map.off("mousemove", onMove);
      map.off("mouseup", onUp);
      map.off("touchstart", onDown);
      map.off("touchmove", onMove);
      map.off("touchend", onUp);
      map.off("click", onClick);
      if (map.getLayer(previewId + "-fill")) map.removeLayer(previewId + "-fill");
      if (map.getLayer(previewId + "-line")) map.removeLayer(previewId + "-line");
      if (map.getSource(previewId)) map.removeSource(previewId);
    };
  }, [map, active, layerKey, eraseMode, lineColor, incidentId]);

  if (!active) return null;

  return (
    <div className="ops-editor-toolbar">
      {LAYER_TYPES.map((l) => (
        <button
          key={l.key}
          type="button"
          className={"ops-editor-btn" + (layerKey === l.key ? " on" : "")}
          style={{ "--dot": l.color || lineColor }}
          onClick={() => { setLayerKey(layerKey === l.key ? null : l.key); setEraseMode(false); }}
        >
          <i /> {l.label}
        </button>
      ))}
      {layerKey === "linea" && (
        <label className="ops-color-row">
          Color: <input type="color" value={lineColor} onChange={(e) => setLineColor(e.target.value)} />
        </label>
      )}
      <button
        type="button"
        className={"ops-editor-btn" + (eraseMode ? " on" : "")}
        style={{ "--dot": "#C0392E" }}
        onClick={() => { setEraseMode(!eraseMode); setLayerKey(null); }}
      >
        <i /> Borrar trazo
      </button>
      {layerKey && (
        <p className="ops-dim" style={{ margin: 0 }}>
          {LAYER_TYPES.find((l) => l.key === layerKey)?.geometryType === "point"
            ? "Toca el mapa para ubicar el punto."
            : "Arrastra sobre el mapa para dibujar. Suelta para guardar."}
        </p>
      )}
      {eraseMode && <p className="ops-dim" style={{ margin: 0 }}>Toca un trazo o punto para borrarlo.</p>}
    </div>
  );
}
