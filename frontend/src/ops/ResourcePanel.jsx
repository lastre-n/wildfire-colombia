import React, { useEffect, useState } from "react";
import { supabase } from "../supabaseClient.js";

const TYPES = ["bomberos", "defensa_civil", "policia", "ejercito", "cruz_roja", "manual"];
const CAPACITIES = ["cuadrilla", "brigada_tipo_1", "brigada_tipo_2", "brigada_tipo_3", "helicoportado", "avion"];

function ResourceRow({ r, indent, onChanged }) {
  async function toggleStatus() {
    const next = r.status === "no_disponible" ? "disponible" : "no_disponible";
    await supabase.from("resources").update({ status: next }).eq("id", r.id);
    onChanged();
  }
  async function remove() {
    if (!confirm(`¿Eliminar ${r.code} · ${r.name}? Borra también su personal y su código de acceso.`)) return;
    const { error } = await supabase.from("resources").delete().eq("id", r.id);
    if (error) alert("No se pudo eliminar: " + error.message);
    onChanged();
  }
  return (
    <div className={"ops-res-row" + (indent ? " ops-res-child" : "")}>
      <div><span className="ops-mono">{r.code}</span> {r.name} <span className="ops-dim">· {r.type} · {r.status}</span></div>
      <div className="ops-res-code">código: <span className="ops-mono">{r.login_code}</span></div>
      <div className="ops-res-actions">
        <button type="button" className="ops-btn-ghost" onClick={toggleStatus}>
          {r.status === "no_disponible" ? "Activar" : "Desactivar"}
        </button>
        <button type="button" className="ops-btn-ghost ops-btn-danger" onClick={remove}>Eliminar</button>
      </div>
    </div>
  );
}

export default function ResourcePanel({ incident }) {
  const [resources, setResources] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [lastAccess, setLastAccess] = useState(null);

  async function load() {
    if (!incident) return;
    const { data } = await supabase.from("resources").select("*").eq("incident_id", incident.id).order("code");
    setResources(data || []);
  }
  useEffect(() => { load(); setLastAccess(null); setCreating(false); }, [incident?.id]);

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    const form = new FormData(e.target);
    const loginCode = crypto.randomUUID().split("-")[0].toUpperCase();
    const role = form.get("has_children") === "on" ? "jefe_brigada" : "jefe_cuadrilla";

    const { data, error } = await supabase
      .from("resources")
      .insert({
        incident_id: incident.id,
        code: form.get("code"),
        name: form.get("name"),
        type: form.get("type"),
        capacity: form.get("capacity"),
        max_availability: form.get("max_availability") || null,
        notes: form.get("notes") || null,
        logo_url: form.get("logo_url") || null,
        parent_resource_id: form.get("parent_resource_id") || null,
        login_code: loginCode,
      })
      .select()
      .single();
    if (error) { setError(error.message); return; }

    const names = (form.get("personnel") || "").split("\n").map((n) => n.trim()).filter(Boolean);
    if (names.length) {
      await supabase.from("personnel").insert(names.map((full_name) => ({ resource_id: data.id, full_name })));
    }

    const { data: fnData, error: fnError } = await supabase.functions.invoke("create-field-login", {
      body: { resource_id: data.id, login_code: loginCode, role, full_name: form.get("jefe_name") },
    });
    if (fnError) {
      setError("Recurso creado, pero el acceso falló: " + fnError.message);
    } else {
      setLastAccess({ code: loginCode, email: fnData.email });
    }

    e.target.reset();
    setCreating(false);
    load();
  }

  if (!incident) return <div className="ops-panel"><p className="ops-dim">Selecciona un incidente</p></div>;

  const top = resources.filter((r) => !r.parent_resource_id);
  const childrenOf = (id) => resources.filter((r) => r.parent_resource_id === id);

  return (
    <div className="ops-panel">
      <h3>RECURSOS · {incident.code}</h3>
      {lastAccess && (
        <div className="ops-code-box">
          Código de acceso: <b>{lastAccess.code}</b>
          <div className="ops-dim">El jefe entra en /op → pestaña "Recurso" con este código.</div>
        </div>
      )}
      {top.map((r) => (
        <div key={r.id}>
          <ResourceRow r={r} onChanged={load} />
          {childrenOf(r.id).map((c) => <ResourceRow key={c.id} r={c} indent onChanged={load} />)}
        </div>
      ))}
      {!creating && <button className="ops-btn-ghost" onClick={() => setCreating(true)}>+ Nuevo recurso</button>}
      {creating && (
        <form className="ops-form" onSubmit={handleCreate}>
          <input name="code" placeholder="Código (ej: B-04)" required />
          <input name="name" placeholder="Nombre" required />
          <input name="jefe_name" placeholder="Nombre del jefe" required />
          <select name="type" required defaultValue="">
            <option value="" disabled>Tipo…</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select name="capacity" required defaultValue="">
            <option value="" disabled>Capacidad…</option>
            {CAPACITIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input name="max_availability" type="number" placeholder="Disponibilidad máxima" />
          <select name="parent_resource_id" defaultValue="">
            <option value="">¿Cuadrilla de una brigada existente? (opcional)</option>
            {top.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
          </select>
          <label className="ops-check">
            <input type="checkbox" name="has_children" /> Tiene cuadrillas propias (estructura interna)
          </label>
          <input name="logo_url" placeholder="URL del logo (opcional)" />
          <textarea name="personnel" rows={3} placeholder="Nombres del personal, uno por línea"></textarea>
          <textarea name="notes" rows={2} placeholder="Notas"></textarea>
          {error && <p className="ops-error">{error}</p>}
          <div className="ops-form-row">
            <button type="submit">Crear</button>
            <button type="button" className="ops-btn-ghost" onClick={() => setCreating(false)}>Cancelar</button>
          </div>
        </form>
      )}
    </div>
  );
}
