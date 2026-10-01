import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { supabase } from "../supabaseClient.js";
import { OVERLAY_SOURCE_ID } from "./overlayConstants.js";

// Colores y convenciones tomadas de la simbología estándar NWCG para mapas de incidentes de incendios:
// borde controlado = negro, borde / perímetro activo no controlado = rojo.
const LAYER_TYPES = [
  { key: "area_quemada", label: "Área quemada", geometryType: "polygon", color: "#C0392E" },
  { key: "fuente_agua", label: "Fuente de agua", geometryType: "polygon", color: "#3E7CB1" },
  { key: "zona_forestal", label: "Zona forestal", geometryType: "polygon", color: "#4C7A4F" },
  { key: "estructura", label: "Estructuras", geometryType: "polygon", color: "#FF2DAE" },
  { key: "poligono_custom", label: "Polígono personalizado", geometryType: "polygon", color: null, customFill: true },
  { key: "hidrante", label: "Hidrante", geometryType: "point", color: "#C0392E" },
  { key: "punto_agua", label: "Punto de agua", geometryType: "point", color: "#3E7CB1" },
  { key: "borde_controlado", label: "Borde controlado", geometryType: "line", color: "#111111", dash: "solid" },
  { key: "borde_no_controlado", label: "Borde no controlado", geometryType: "line", color: "#C0392E", dash: "solid" },
  { key: "linea", label: "Línea genérica", geometryType: "line", color: null, customDash: true },
];

function MiniIcon({ type }) {
  if (type === "hidrante") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24">
        <g fill="#C0392E" stroke="#8E2A22" strokeWidth="0.5">
          <rect x="9" y="3" width="6" height="2" rx="1" />
          <rect x="8.5" y="5" width="7" height="11" rx="2.5" />
          <circle cx="6.5" cy="9" r="2" />
          <circle cx="17.5" cy="9" r="2" />
          <circle cx="12" cy="16.5" r="1.8" />
          <rect x="7" y="18" width="10" height="2.5" rx="1" />
        </g>
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path fill="#3E7CB1" stroke="#fff" strokeWidth="1"
        d="M12 2C12 2 5 11 5 15.5C5 19.09 8.13 22 12 22C15.87 22 19 19.09 19 15.5C19 11 12 2 12 2Z" />
    </svg>
  );
}

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

const MapEditor = forwardRef(function MapEditor({ map, incidentId, active, overlayRef }, ref) {
  const [layerKey, setLayerKey] = useState(null);
  const [customColor, setCustomColor] = useState("#E0932F");
  const [dashStyle, setDashStyle] = useState("solid");
  const [fillStyle, setFillStyle] = useState("solid");
  const [eraseMode, setEraseMode] = useState(false);
  const drawing = useRef(false);
  const pathRef = useRef([]);
  const createdStack = useRef([]);
  const previewId = "ops-draw-preview";

  useEffect(() => {
    if (!active) { setLayerKey(null); setEraseMode(false); }
  }, [active]);

  useEffect(() => {
    if (!map) return;
    if (active && (layerKey || eraseMode)) map.dragPan.disable();
    else map.dragPan.enable();
    return () => map.dragPan.enable();
  }, [map, active, layerKey, eraseMode]);

  async function undoLast() {
    const id = createdStack.current.pop();
    if (!id) return;
    overlayRef?.current?.removeFeature(id);
    await supabase.from("map_overlays").delete().eq("id", id);
  }

  useImperativeHandle(ref, () => ({ undoLast }), [overlayRef]);

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
      const color = cfg.color || customColor;
      const dash = cfg.key === "linea" ? dashStyle : (cfg.dash || "solid");
      const fill_style = cfg.key === "poligono_custom" ? fillStyle : "solid";
      let geometry;
      if (cfg.geometryType === "polygon") geometry = { type: "Polygon", coordinates: [[...coords, coords[0]]] };
      else if (cfg.geometryType === "point") geometry = { type: "Point", coordinates: coords[0] };
      else geometry = { type: "LineString", coordinates: coords };
      const { data } = await supabase.from("map_overlays").insert({
        incident_id: incidentId,
        geometry_type: cfg.geometryType,
        layer_type: cfg.key,
        geometry,
        color,
        dash,
        fill_style,
      }).select().single();
      if (data) {
        createdStack.current.push(data.id);
        overlayRef?.current?.addFeature(data);
      }
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
      updatePreview(customColor);
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
      const bbox = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
      const feats = map.queryRenderedFeatures(bbox, { layers });
      if (!feats.length) return;
      const id = feats[0].properties.id;
      if (!window.confirm("¿Borrar este trazo?")) return;
      overlayRef?.current?.removeFeature(id);
      supabase.from("map_overlays").delete().eq("id", id).then(({ error }) => {
        if (error) alert("No se pudo borrar: " + error.message);
      });
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
  }, [map, active, layerKey, eraseMode, customColor, dashStyle, fillStyle, incidentId, overlayRef]);

  if (!active) return null;

  return (
    <div className="ops-editor-toolbar">
      {LAYER_TYPES.map((l) => (
        <button
          key={l.key}
          type="button"
          className={"ops-editor-btn" + (layerKey === l.key ? " on" : "")}
          style={{ "--dot": l.color || customColor }}
          onClick={() => { setLayerKey(layerKey === l.key ? null : l.key); setEraseMode(false); }}
        >
          {l.geometryType === "point" ? <MiniIcon type={l.key} /> : <i />} {l.label}
        </button>
      ))}
      {(layerKey === "linea" || layerKey === "poligono_custom") && (
        <label className="ops-color-row">
          Color: <input type="color" value={customColor} onChange={(e) => setCustomColor(e.target.value)} />
        </label>
      )}
      {layerKey === "linea" && (
        <label className="ops-color-row">
          Estilo:
          <select value={dashStyle} onChange={(e) => setDashStyle(e.target.value)}>
            <option value="solid">Continua</option>
            <option value="dashed">Discontinua</option>
          </select>
        </label>
      )}
      {layerKey === "poligono_custom" && (
        <label className="ops-color-row">
          Relleno:
          <select value={fillStyle} onChange={(e) => setFillStyle(e.target.value)}>
            <option value="solid">Sólido</option>
            <option value="outline">Solo contorno</option>
          </select>
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
});

export default MapEditor;
