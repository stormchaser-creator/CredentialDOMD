import { useEffect, useState, memo } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";
import { Modal } from "../shared";

/**
 * Home-dashboard card for admin_messages: notes from Eric, individually or
 * broadcast. Mirrors NotificationBanner's card placement/styling but has its
 * own Supabase fetch since these aren't derived from local data.
 */
function AdminMessageCard() {
  const { theme: T, userIdRef, updateSettings, data } = useApp();
  const myProfileId = userIdRef.current;
  const [messages, setMessages] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [openMsg, setOpenMsg] = useState(null);
  const [thread, setThread] = useState([]);
  const [replyBody, setReplyBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailMsg, setDetailMsg] = useState("");

  const refresh = () => {
    if (!supabase || !myProfileId) return;
    supabase.from("my_admin_messages").select("*").limit(20)
      .then(({ data: rows, error }) => { if (!error) setMessages(rows || []); setLoaded(true); });
  };

  useEffect(() => { refresh(); }, [myProfileId]); // eslint-disable-line react-hooks/exhaustive-deps

  const seenAt = data?.settings?.adminMessagesSeenAt;
  const unseen = messages.filter(m => !seenAt || new Date(m.created_at) > new Date(seenAt));

  const openDetail = async (m) => {
    setOpenMsg(m); setDetailMsg("");
    const { data: rows } = await supabase.from("admin_message_replies").select("*")
      .eq("message_id", m.id).eq("user_id", myProfileId).order("created_at");
    setThread(rows || []);
  };

  const openInbox = () => {
    setOpen(true);
    updateSettings({ adminMessagesSeenAt: new Date().toISOString() });
  };

  const sendReply = async () => {
    const text = replyBody.trim();
    if (!text || !openMsg) return;
    setBusy(true); setDetailMsg("");
    const { error } = await supabase.from("admin_message_replies").insert({
      message_id: openMsg.id, user_id: myProfileId, author_id: myProfileId, body: text, is_admin_reply: false,
    });
    setBusy(false);
    if (error) { setDetailMsg(error.message); return; }
    setReplyBody("");
    const { data: rows } = await supabase.from("admin_message_replies").select("*")
      .eq("message_id", openMsg.id).eq("user_id", myProfileId).order("created_at");
    setThread(rows || []);
  };

  if (!loaded || messages.length === 0) return null;

  return (
    <>
      <div onClick={openInbox} style={{
        margin: "10px 16px", padding: "12px 14px", borderRadius: 14, cursor: "pointer",
        backgroundColor: T.card, border: `1px solid ${unseen.length > 0 ? T.accent : T.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
            {unseen.length > 0 ? `${unseen.length} new message${unseen.length > 1 ? "s" : ""} from Eric` : "Messages from Eric"}
          </div>
          <div style={{
            fontSize: 12, color: T.textMuted, marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{messages[0].subject || messages[0].body}</div>
        </div>
        {unseen.length > 0 && (
          <span style={{ width: 9, height: 9, borderRadius: 999, backgroundColor: T.accent, flexShrink: 0 }} />
        )}
      </div>

      <Modal open={open} onClose={() => { setOpen(false); setOpenMsg(null); }} title={openMsg ? (openMsg.subject || "Message") : "Messages"}>
        {!openMsg ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {messages.map(m => (
              <div key={m.id} role="button" tabIndex={0} onClick={() => openDetail(m)}
                onKeyDown={(ev) => { if (ev.key === "Enter") openDetail(m); }}
                style={{ backgroundColor: T.input, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", cursor: "pointer" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{m.subject || "(no subject)"}</div>
                <div style={{
                  fontSize: 12, color: T.textMuted, marginTop: 3, lineHeight: 1.4,
                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                }}>{m.body}</div>
                <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>{new Date(m.created_at).toLocaleString()}</div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <button onClick={() => setOpenMsg(null)} style={{
              marginBottom: 10, padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}>&larr; All messages</button>
            <div style={{ fontSize: 11.5, color: T.textDim, marginBottom: 10 }}>{new Date(openMsg.created_at).toLocaleString()}</div>
            <div style={{ fontSize: 14, color: T.text, whiteSpace: "pre-wrap", lineHeight: 1.55, padding: "10px 12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
              {openMsg.body}
            </div>
            {thread.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                {thread.map(r => (
                  <div key={r.id} style={{
                    padding: "9px 11px", borderRadius: 10,
                    backgroundColor: r.is_admin_reply ? (T.accentDim || "rgba(59,130,246,0.12)") : T.card,
                    border: `1px solid ${T.border}`,
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: r.is_admin_reply ? T.accent : T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
                      {r.is_admin_reply ? "Eric" : "You"} · {new Date(r.created_at).toLocaleString()}
                    </div>
                    <div style={{ fontSize: 13, color: T.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{r.body}</div>
                  </div>
                ))}
              </div>
            )}
            <textarea value={replyBody} onChange={e => setReplyBody(e.target.value)}
              placeholder="Reply to Eric"
              style={{
                width: "100%", minHeight: 80, marginTop: 12, padding: "10px 12px", borderRadius: 10,
                backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text,
                fontSize: 16, fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box",
              }} />
            {detailMsg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: T.accent }}>{detailMsg}</div>}
            <button onClick={sendReply} disabled={busy} style={{
              width: "100%", marginTop: 10, padding: "12px", borderRadius: 10, border: "none",
              backgroundColor: busy ? T.textDim : T.accent, color: "#fff", fontSize: 14, fontWeight: 800,
              cursor: busy ? "wait" : "pointer",
            }}>{busy ? "Sending…" : "Send reply"}</button>
          </>
        )}
      </Modal>
    </>
  );
}

export default memo(AdminMessageCard);
