import React, { useEffect, useState } from "react";
import { supabase } from "../supabaseClient.js";
import ChatPanel from "./ChatPanel.jsx";

export default function CommandChat({ incidentId, senderId }) {
  const [resources, setResources] = useState([]);
  const [activeId, setActiveId] = useState("general");

  useEffect(() => {
    if (!incidentId) return;
    supabase
      .from("resources")
      .select("id, code, name")
      .eq("incident_id", incidentId)
      .order("code")
      .then(({ data }) => setResources(data || []));
  }, [incidentId]);

  if (!incidentId) return null;

  return (
    <div className="ops-panel">
      <h3>CHAT</h3>
      <select
        className="ops-theme-select"
        style={{ width: "100%", marginBottom: 8 }}
        value={activeId}
        onChange={(e) => setActiveId(e.target.value)}
      >
        <option value="general">General (todos)</option>
        {resources.map((r) => (
          <option key={r.id} value={r.id}>{r.code} · {r.name}</option>
        ))}
      </select>
      <ChatPanel
        incidentId={incidentId}
        resourceId={activeId === "general" ? null : activeId}
        senderId={senderId}
      />
    </div>
  );
}
