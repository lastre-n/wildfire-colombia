import React, { useEffect, useState } from "react";
import { supabase } from "../supabaseClient.js";

function formatTimestamp(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { day: "2-digit", month: "short" }) + " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// resourceId = null → canal general del incidente (todos lo ven)
// resourceId = uuid → hilo privado de ese recurso con el comandante
export default function ChatPanel({ incidentId, resourceId, senderId }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (!incidentId) return;
    let query = supabase
      .from("chat_messages")
      .select("*, profiles(full_name, resources(code))")
      .eq("incident_id", incidentId);
    query = resourceId ? query.eq("resource_id", resourceId) : query.is("resource_id", null);
    query.order("created_at", { ascending: true }).limit(50).then(({ data }) => setMessages(data || []));

    const channel = supabase
      .channel(`chat_${incidentId}_${resourceId || "general"}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `incident_id=eq.${incidentId}` },
        async (payload) => {
          const p = payload.new;
          const matches = resourceId ? p.resource_id === resourceId : p.resource_id === null;
          if (!matches) return;
          const { data: senderInfo } = await supabase
            .from("profiles")
            .select("full_name, resources(code)")
            .eq("id", p.sender_id)
            .single();
          setMessages((m) => [...m, { ...p, profiles: senderInfo }]);
        }
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [incidentId, resourceId]);

  async function send(e) {
    e.preventDefault();
    if (!input.trim()) return;
    const { error } = await supabase.from("chat_messages").insert({
      incident_id: incidentId,
      resource_id: resourceId || null,
      sender_id: senderId,
      message: input.trim(),
    });
    if (!error) setInput("");
  }

  if (!incidentId) return null;

  return (
    <div className="ops-chat">
      <div className="ops-chat-log">
        {messages.map((m) => (
          <div key={m.id} className="ops-chat-msg">
            <span className="ops-chat-body">
              <span className="ops-mono">{m.profiles?.resources?.code || "Comando"}</span>: {m.message}
            </span>
            <span className="ops-chat-time">{formatTimestamp(m.created_at)}</span>
          </div>
        ))}
      </div>
      <form className="ops-chat-form" onSubmit={send}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Escribe un mensaje…" />
        <button type="submit">Enviar</button>
      </form>
    </div>
  );
}
