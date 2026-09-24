import React, { useEffect, useState } from "react";
import { supabase } from "../supabaseClient.js";

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
        (payload) => {
          const p = payload.new;
          const matches = resourceId ? p.resource_id === resourceId : p.resource_id === null;
          if (matches) setMessages((m) => [...m, p]);
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
            <span className="ops-mono">{m.profiles?.resources?.code || "Comando"}</span>: {m.message}
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
