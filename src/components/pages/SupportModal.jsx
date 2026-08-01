import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";

const CATEGORIES = [
  { id: "bug",             label: "Bug / something broken" },
  { id: "billing",         label: "Billing or subscription" },
  { id: "feature_request", label: "Feature request / idea" },
  { id: "data_issue",      label: "Data issue (lost, wrong, missing)" },
  { id: "compliance",      label: "Privacy / HIPAA / compliance" },
  { id: "feedback",        label: "General feedback" },
  { id: "other",           label: "Other" },
];

const PRIORITIES = [
  { id: "low",    label: "Low" },
  { id: "normal", label: "Normal" },
  { id: "high",   label: "High" },
  { id: "urgent", label: "Urgent — license expires soon" },
];

export default function SupportModal({ open, onClose, contextPage }) {
  const { theme: T, user } = useApp();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("other");
  const [priority, setPriority] = useState("normal");
  const [rating, setRating] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const submit = async () => {
    // Feedback shouldn't demand a subject line — derive one from the message
    const subj = subject.trim() || body.trim().slice(0, 80);
    if (subj.length < 3) { setError("Tell us a bit more first."); return; }
    if (body.trim().length < 10)   { setError("Tell us a bit more — at least 10 characters."); return; }
    if (!supabase) { setError("App not connected to backend."); return; }

    setSubmitting(true); setError("");
    try {
      const res = await supabase.functions.invoke("create-ticket", {
        body: {
          subject: subj,
          body: (rating ? `Rating: ${rating}/5\n\n` : "") + body.trim(),
          category: category === "feedback" ? "other" : category,
          priority,
          context_page: contextPage || window.location.pathname,
        },
      });
      if (res.error) throw new Error(res.error.message || "Failed to submit");
      setDone(true);
      setTimeout(() => { onClose(); reset(); }, 1800);
    } catch (e) {
      setError(e.message || "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setSubject(""); setBody(""); setCategory("other"); setPriority("normal");
    setRating(0); setDone(false); setError("");
  };

  const close = () => { onClose(); reset(); };

  const inputStyle = {
    width: "100%", padding: "10px 12px", borderRadius: 10,
    backgroundColor: T.input, border: `1px solid ${T.inputBorder || T.border}`,
    color: T.text, fontSize: 16, outline: "none", boxSizing: "border-box",
  };

  return (
    <div onClick={close} style={{
      position: "fixed", inset: 0, zIndex: 200,
      backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto",
        backgroundColor: T.card, borderRadius: "20px 20px 0 0",
        padding: "20px 18px",
        animation: "slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1)",
      }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: T.border }} />
        </div>

        {done ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>✓</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>
              Ticket received.
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>
              You'll get a reply at {user?.email}. Urgent tickets within 24 hours.
            </div>
          </div>
        ) : (
          <>
            <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: T.text }}>
              Help & feedback
            </h2>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: T.textMuted }}>
              Bug, question, or just a thought — goes straight to the founder. He responds personally.
            </p>

            {/* Optional rating */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 6 }}>How's the app? (optional)</div>
              <div style={{ display: "flex", gap: 6 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => setRating(rating === n ? 0 : n)} style={{
                    flex: 1, padding: "8px", borderRadius: 8,
                    border: `1px solid ${rating >= n ? T.accent : T.border}`,
                    backgroundColor: rating >= n ? (T.accentDim || "rgba(59,130,246,0.12)") : "transparent",
                    color: rating >= n ? T.accent : T.textMuted,
                    fontSize: 17, fontWeight: 700, cursor: "pointer",
                  }}>{"\u2605"}</button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Category */}
              <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
                {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>

              {/* Priority */}
              <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inputStyle}>
                {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>

              {/* Subject */}
              <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Subject</label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Short summary (optional)"
                maxLength={200}
                style={inputStyle}
              />

              {/* Body */}
              <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>What happened</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="As much detail as helps. Steps, error messages, screenshots welcome via email after you submit."
                style={{ ...inputStyle, minHeight: 120, resize: "vertical", fontFamily: "inherit" }}
              />
            </div>

            {error && (
              <div style={{
                marginTop: 10, padding: "8px 10px", borderRadius: 8,
                backgroundColor: "rgba(239,68,68,0.1)",
                color: "#ef4444", fontSize: 12, fontWeight: 600,
              }}>{error}</div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                onClick={submit}
                disabled={submitting || body.trim().length < 10}
                style={{
                  flex: 1, padding: "12px", borderRadius: 10, border: "none",
                  backgroundColor: submitting || body.trim().length < 10 ? T.textDim : T.accent,
                  color: "#fff", fontSize: 14, fontWeight: 700,
                  cursor: submitting || body.trim().length < 10 ? "not-allowed" : "pointer",
                }}
              >
                {submitting ? "Sending..." : "Send ticket"}
              </button>
              <button
                onClick={close}
                style={{
                  padding: "12px 18px", borderRadius: 10,
                  border: `1px solid ${T.border}`, backgroundColor: "transparent",
                  color: T.text, fontSize: 14, fontWeight: 600, cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>

            <p style={{ marginTop: 10, fontSize: 11, color: T.textDim, textAlign: "center" }}>
              Submitted as <strong>{user?.email || "anonymous"}</strong>
            </p>
          </>
        )}
      </div>
      <style>{`@keyframes slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`}</style>
    </div>
  );
}
