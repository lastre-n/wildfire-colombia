import React, { useEffect, useState } from "react";
import { supabase } from "../supabaseClient.js";

export default function IncidentPanel({ selected, onSelect }) {
  const [incidents, setIncidents] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const { data } = await supabase.from("incidents").select("*").order("created_at", { ascending: false });
    setIncidents(data || []);
  }
  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    const form = new FormData(e.target);
    const { data, error } = await supabase
      .from("incidents")
      .insert({ code: form.get("code"), name: form.get("name") })
      .select()
      .single();
    if (error) { setError(error.message); return; }
    setCreating(false);
    e.target.reset();
    await load();
    onSelect(data);
  }

  return (
    <div className="ops-panel">
      <h3>INCIDENTES</h3>
      {incidents.map((inc) => (
        <div
          key={inc.id}
          className={"ops-list-item" + (selected?.id === inc.id ? " on" : "")}
          onClick={() => onSelect(inc)}
        >
          <div className="ops-mono">{inc.code}</div>
          <div>{inc.name}</div>
        </div>
      ))}
      {!creating && (
        <button className="ops-btn-ghost" onClick={() => setCreating(true)}>+ Nuevo incidente</button>
      )}
      {creating && (
        <form className="ops-form" onSubmit={handleCreate}>
          <input name="code" placeholder="Código (ej: INC-2026-0092)" required />
          <input name="name" placeholder="Nombre / lugar" required />
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
