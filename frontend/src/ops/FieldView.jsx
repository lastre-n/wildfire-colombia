import React, { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient.js";

export default function FieldView({ profile, theme, setTheme, onLogout }) {
  const [resource, setResource] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [lastPos, setLastPos] = useState(null);
  const [gpsError, setGpsError] = useState("");
  const watchId = useRef(null);

  useEffect(() => {
    if (!profile?.resource_id) return;
    supabase
      .from("resources")
      .select("*, incidents(code, name)")
      .eq("id", profile.resource_id)
      .single()
      .then(({ data }) => setResource(data));
  }, [profile?.resource_id]);

  useEffect(() => {
    if (!profile?.resource_id || !navigator.geolocation) return;
    watchId.current = navigator.geolocation.watchPosition(
      async (pos) => {
        setTracking(true);
        setGpsError("");
        const { latitude, longitude } = pos.coords;
        setLastPos({ lat: latitude, lng: longitude, at: new Date() });
        await supabase.from("resource_positions").insert({
          resource_id: profile.resource_id,
          lat: latitude,
          lng: longitude,
        });
      },
      (err) => { setTracking(false); setGpsError(err.message); },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    );
    return () => { if (watchId.current) navigator.geolocation.clearWatch(watchId.current); };
  }, [profile?.resource_id]);

  return (
    <div className="ops-shell">
      <header className="ops-topbar">
        <div><b>Wildfire Colombia</b> · Ops</div>
        <div className="ops-topbar-right">
          <span className="ops-dim">{profile?.full_name} · {resource?.code}</span>
          <button className="ops-theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Modo claro" : "Modo oscuro"}
          </button>
          <button className="ops-theme-btn" onClick={onLogout}>Salir</button>
        </div>
      </header>
      <div className="ops-field-body">
        <div className="ops-field-card">
          <div className="ops-dim">{resource?.incidents?.name || "Cargando incidente…"}</div>
          <h2>{resource?.name}</h2>
          <div className={"ops-gps-badge" + (tracking ? " on" : "")}>
            <i /> {tracking ? "GPS activo · transmitiendo" : "Esperando señal GPS…"}
          </div>
          {gpsError && (
            <p className="ops-error">No se pudo activar el GPS: {gpsError}. Actívalo en los permisos del navegador.</p>
          )}
          {lastPos && (
            <p className="ops-dim">
              Última posición: {lastPos.lat.toFixed(5)}, {lastPos.lng.toFixed(5)} · {lastPos.at.toLocaleTimeString()}
            </p>
          )}
          <p className="ops-dim" style={{ marginTop: 20 }}>
            Los reportes (punto de calor, línea de fuego, clima, SOS) y el chat se agregan en el siguiente paso.
          </p>
        </div>
      </div>
    </div>
  );
}
