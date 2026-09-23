import React, { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { supabase } from "../supabaseClient.js";
import "./ops.css";
import IncidentPanel from "./IncidentPanel.jsx";
import ResourcePanel from "./ResourcePanel.jsx";

const COLOMBIA_CENTER = [-74.3, 4.6];
// Tiles Esri "Canvas" — gratis, sin API key, mismo proveedor que ya usas
// en la app pública para el satélite y el overlay de referencia.
const TILE_SOURCES = {
  dark: {
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Esri, HERE, Garmin, © OpenStreetMap contributors",
  },
  light: {
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Esri, HERE, Garmin, © OpenStreetMap contributors",
  },
};

function buildStyle(theme) {
  const t = TILE_SOURCES[theme];
  return {
    version: 8,
    sources: { base: { type: "raster", tiles: t.tiles, tileSize: 256, attribution: t.attribution } },
    layers: [{ id: "base", type: "raster", source: "base" }],
  };
}

export default function OpsApp() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [theme, setTheme] = useState(localStorage.getItem("ops-theme") || "dark");
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [incident, setIncident] = useState(null);
  const mapContainer = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    supabase.from("profiles").select("*").eq("id", session.user.id).single()
      .then(({ data }) => setProfile(data));
  }, [session]);

  useEffect(() => {
    document.documentElement.dataset.opsTheme = theme;
    localStorage.setItem("ops-theme", theme);
    if (mapRef.current) mapRef.current.setStyle(buildStyle(theme));
  }, [theme]);

  useEffect(() => {
    if (!session || mapRef.current || !mapContainer.current) return;
    mapRef.current = new maplibregl.Map({
      container: mapContainer.current,
      style: buildStyle(theme),
      center: COLOMBIA_CENTER,
      zoom: 5,
    });
    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-right");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

   async function handleLogin(e) {
    e.preventDefault();
    setAuthError("");
    const form = new FormData(e.target);
    const code = form.get("code").trim();
    const { error } = await supabase.auth.signInWithPassword({
      email: `${code.toLowerCase()}@ops.wildfire.local`,
      password: code,
    });
    if (error) setAuthError("Código incorrecto");
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setProfile(null);
  }

  if (loading) return <div className="ops-shell ops-center">Cargando…</div>;

  if (!session) {
    return (
      <div className="ops-shell ops-center">
                <form className="ops-login" onSubmit={handleLogin}>
          <h1>Wildfire Colombia · Ops</h1>
          <p className="ops-dim">Centro de control operativo</p>
          <input name="code" placeholder="Código de acceso" required autoCapitalize="characters" />
          {authError && <p className="ops-error">{authError}</p>}
          <button type="submit">Entrar</button>
        </form>
      </div>
    );
  }

  return (
    <div className="ops-shell">
      <header className="ops-topbar">
        <div><b>Wildfire Colombia</b> · Ops</div>
        <div className="ops-topbar-right">
          <span className="ops-dim">{profile?.full_name || session.user.email} · {profile?.role || "sin rol"}</span>
          <button className="ops-theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Modo claro" : "Modo oscuro"}
          </button>
          <button className="ops-theme-btn" onClick={handleLogout}>Salir</button>
        </div>
      </header>
           <div className="ops-body">
        {profile?.role === "comandante" && (
          <aside className="ops-sidebar">
            <IncidentPanel selected={incident} onSelect={setIncident} />
            <ResourcePanel incident={incident} />
          </aside>
        )}
        <div ref={mapContainer} className="ops-map" />
      </div>
    </div>
  );
}
