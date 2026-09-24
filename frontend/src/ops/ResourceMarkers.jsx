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
      resourcesRef.current = {};

      const { data: resources, error: resErr } = await supabase
        .from("resources").select("id, code, logo_url").eq("incident_id", incidentId);
      console.log("[ResourceMarkers] resources query", { resources, resErr });
      if (cancelled) return;
      if (resErr || !resources) return;
      resources.forEach((r) => { resourcesRef.current[r.id] = r; });

      const ids = resources.map((r) => r.id);
      if (ids.length) {
        const { data: positions, error: posErr } = await supabase
          .from("resource_positions")
          .select("resource_id, lat, lng, recorded_at")
          .in("resource_id", ids)
          .order("recorded_at", { ascending: false });
        console.log("[ResourceMarkers] positions query", { positions, posErr });
        const latest = {};
        (positions || []).forEach((p) => { if (!latest[p.resource_id]) latest[p.resource_id] = p; });
        Object.values(latest).forEach((p) => placeMarker(p.resource_id, p.lat, p.lng));
      }

      channel = supabase
        .channel("resource_positions_live")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "resource_positions" }, (payload) => {
          console.log("[ResourceMarkers] realtime insert", payload.new);
          const p = payload.new;
          if (resourcesRef.current[p.resource_id]) placeMarker(p.resource_id, p.lat, p.lng);
        })
        .subscribe((status) => console.log("[ResourceMarkers] channel status", status));
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
