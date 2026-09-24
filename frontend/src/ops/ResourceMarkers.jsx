import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { supabase } from "../supabaseClient.js";

const STALE_MS = 90 * 1000;

function pinEl(resource) {
  const el = document.createElement("div");
  el.className = "ops-pin";
  const head = document.createElement("div");
  head.className = "ops-pin-head";
  if (resource.logo_url) {
    const img = document.createElement("img");
    img.src = resource.logo_url;
    head.appendChild(img);
  } else {
    head.textContent = (resource.code || "").slice(0, 2);
  }
  el.appendChild(head);
  return el;
}

export default function ResourceMarkers({ map, incidentId }) {
  const markersRef = useRef({});
  const resourcesRef = useRef({});

  useEffect(() => {
    console.log("[ResourceMarkers] init", { map: !!map, incidentId });
    if (!map || !incidentId) return;
    let channel;
    let cancelled = false;

    function placeMarker(resourceId, lat, lng) {
      console.log("[ResourceMarkers] placeMarker", resourceId, lat, lng);
      const existing = markersRef.current[resourceId];
      if (existing) {
        existing.marker.setLngLat([lng, lat]);
        existing.marker.getElement().classList.add("live");
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => existing.marker.getElement().classList.remove("live"), STALE_MS);
      } else {
        const resource = resourcesRef.current[resourceId];
        if (!resource) { console.warn("[ResourceMarkers] no resource cached for", resourceId); return; }
        const el = pinEl(resource);
        el.classList.add("live");
        const marker = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([lng, lat]).addTo(map);
        const timer = setTimeout(() => el.classList.remove("live"), STALE_MS);
        markersRef.current[resourceId] = { marker, timer };
      }
    }

    async function setup() {
      Object.values(markersRef.current).forEach(({ marker, timer }) => { marker.remove(); clearTimeout(timer); });
      markersRef.current = {};
      resourcesRef.current
