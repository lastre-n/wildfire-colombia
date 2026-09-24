import React, { useEffect, useState } from "react";
import { supabase } from "../supabaseClient.js";

export default function ChatPanel({ incidentId, senderId }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (!incidentId) return;
    supabase
      .from("chat_messages")
      .select("*, profiles(full_name)")
      .eq("incident_id", incidentId)
      .order("created_at", { ascending: true })
      .limit(50)
      .then(({ data }) => setMessages(data || []));

    const channel = supabase
      .channel(`chat_${incidentId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `incident_id=eq.${incidentId}` },
        (payload) => setMessages((m) => [...m, payload.new])
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [incidentId]);

  async function send(e) {
    e.preventDefault();
    if (!input.trim()) return;
    await supabase.from("chat_messages").insert({ incident_id: incidentId, sender_id: senderId, message: input.trim() });
    setInput("");
  }

  if (!incidentId) return null;

  return (
    <div className="ops-chat">
      <h3 className="ops-chat-title">CHAT DEL INCIDENTE</h3>
      <div className="ops-chat-log">
        {messages.map((m) => (
          <div key={m.id} className="ops-chat-msg">
            <span className="ops-mono">{m.profiles?.full_name || "—"}</span>: {m.message}
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
