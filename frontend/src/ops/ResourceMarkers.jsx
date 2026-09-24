import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { supabase } from "../supabaseClient.js";

const STALE_MS = 90 * 1000; // sin actualización en 90s → se ve gris (última ubicación conocida)

function pinEl(resource) {
  const el = document.createElement("div");
  el.className = "ops-pin";
  el.title = resource.name || resource.code;
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
    if (!map || !incidentId) return;
    let channel;
    let cancelled = false;

    function placeMarker(resourceId, lat, lng) {
      const existing = markersRef.current[resourceId];
      if (existing) {
        existing.marker.setLngLat([lng, lat]);
        existing.marker.getElement().classList.add("live");
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => existing.marker.getElement().classList.remove("live"), STALE_MS);
      } else {
        const resource = resourcesRef.current[resourceId];
        if (!resource) return;
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
      resourcesRef.current = {};

      const { data: resources, error: resErr } = await supabase
        .from("resources").select("id, code, name, logo_url").eq("incident_id", incidentId);
      if (cancelled || resErr || !resources) return;
      resources.forEach((r) => { resourcesRef.current[r.id] = r; });

      const ids = resources.map((r) => r.id);
      if (ids.length) {
        const { data: positions } = await supabase
          .from("resource_positions")
          .select("resource_id, lat, lng, recorded_at")
          .in("resource_id", ids)
          .order("recorded_at", { ascending: false });
        const latest = {};
        (positions || []).forEach((p) => { if (!latest[p.resource_id]) latest[p.resource_id] = p; });
        Object.values(latest).forEach((p) => placeMarker(p.resource_id, p.lat, p.lng));
      }

      channel = supabase
        .channel("resource_positions_live")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "resource_positions" }, (payload) => {
          const p = payload.new;
          if (resourcesRef.current[p.resource_id]) placeMarker(p.resource_id, p.lat, p.lng);
        })
        .subscribe();
    }

    setup();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
      Object.values(markersRef.current).forEach(({ marker, timer }) => { marker.remove(); clearTimeout(timer); });
      markersRef.current = {};
    };
  }, [map, incidentId]);

  return null;
}
