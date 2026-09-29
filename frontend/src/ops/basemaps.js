// Todos gratis, sin API key.
export const BASEMAPS = {
  dark: {
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Esri, HERE, Garmin, © OpenStreetMap contributors",
    maxzoom: 16,
  },
  light: {
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Esri, HERE, Garmin, © OpenStreetMap contributors",
    maxzoom: 16,
  },
  satellite: {
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Esri, Maxar, Earthstar Geographics",
    maxzoom: 19,
  },
  topo: {
    tiles: [
      "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
      "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
      "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
    ],
    attribution: "© OpenTopoMap (CC-BY-SA) © OpenStreetMap contributors",
    maxzoom: 17,
  },
};

export function buildStyle(basemapKey) {
  const t = BASEMAPS[basemapKey] || BASEMAPS.dark;
  return {
    version: 8,
    sources: { base: { type: "raster", tiles: t.tiles, tileSize: 256, attribution: t.attribution, maxzoom: t.maxzoom } },
    layers: [{ id: "base", type: "raster", source: "base" }],
  };
}
