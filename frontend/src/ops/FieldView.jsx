import React, { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient.js";
import ChatPanel from "./ChatPanel.jsx";

const LABELS = {
  punto_calor: "Punto de calor",
  linea_fuego: "Línea de fuego",
  clima: "Clima local",
  foto_nota: "Nota con evidencia",
};

export default function FieldView({ profile, theme, setTheme, onLogout }) {
  const [resource, setResource] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [lastPos, setLastPos] = useState(null);
  const [gpsError, setGpsError] = useState("");
  const [reportType, setReportType] = useState(null);
  const [reportNote, setReportNote] = useState("");
  const [weather, setWeather] = useState({ wind: "", humidity: "", notes: "" });
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState("");
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

  function openReport(type) {
    setReportType(type);
    setFeedback("");
  }

  async function sendSOS() {
    if (!lastPos) { setFeedback("Esperando señal GPS antes de poder enviar SOS."); return; }
    setSending(true);
    await supabase.from("sos_alerts").insert({
      incident_id: resource.incident_id,
      resource_id: profile.resource_id,
      lat: lastPos.lat,
      lng: lastPos.lng,
    });
    setSending(false);
    setFeedback("SOS enviado — el centro de operaciones fue notificado.");
  }

  async function sendReport(e) {
    e.preventDefault();
    if (!lastPos) { setFeedback("Esperando señal GPS."); return; }
    setSending(true);
    const payload = {
      incident_id: resource.incident_id,
      resource_id: profile.resource_id,
      type: reportType,
      lat: lastPos.lat,
      lng: lastPos.lng,
      note: reportType === "clima" ? weather.notes : reportNote,
    };
    if (reportType === "clima") {
      payload.weather_data = { wind: weather.wind, humidity: weather.humidity };
    }
    const { error } = await supabase.from("field_reports").insert(payload);
    setSending(false);
    if (error) { setFeedback("Error: " + error.message); return; }
    setFeedback("Reporte enviado.");
    setReportType(null);
    setReportNote("");
    setWeather({ wind: "", humidity: "", notes: "" });
  }

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

          <button className="ops-sos" onClick={sendSOS} disabled={sending}>
            ENVIAR SOS
            <small>Notifica de inmediato al centro de operaciones</small>
          </button>

          <div className="ops-grid2">
            {Object.entries(LABELS).map(([key, label]) => (
              <button key={key} type="button" className="ops-rbtn" onClick={() => openReport(key)}>
                <span className="ops-rbtn-t">{label}</span>
              </button>
            ))}
          </div>

          {reportType && (
            <form className="ops-form" onSubmit={sendReport}>
              <p className="ops-dim">{LABELS[reportType]}</p>
              {reportType === "clima" ? (
                <>
                  <input placeholder="Viento (km/h)" value={weather.wind}
                    onChange={(e) => setWeather({ ...weather, wind: e.target.value })} />
                  <input placeholder="Humedad (%)" value={weather.humidity}
                    onChange={(e) => setWeather({ ...weather, humidity: e.target.value })} />
                  <textarea rows={2} placeholder="Notas" value={weather.notes}
                    onChange={(e) => setWeather({ ...weather, notes: e.target.value })} />
                </>
              ) : (
                <textarea rows={3} placeholder="Nota" value={reportNote}
                  onChange={(e) => setReportNote(e.target.value)} />
              )}
              {reportType === "foto_nota" && (
                <p className="ops-dim">La foto se agrega en un paso siguiente — por ahora se envía la nota y la ubicación.</p>
              )}
              <div className="ops-form-row">
                <button type="submit" disabled={sending}>Enviar</button>
                <button type="button" className="ops-btn-ghost" onClick={() => setReportType(null)}>Cancelar</button>
              </div>
            </form>
          )}

          {feedback && <p className="ops-dim" style={{ marginTop: 10 }}>{feedback}</p>}

          {resource?.incident_id && <ChatPanel incidentId={resource.incident_id} senderId={profile.id} />}
        </div>
      </div>
    </div>
  );
}
