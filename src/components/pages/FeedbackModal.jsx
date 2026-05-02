import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";

/**
 * FeedbackModal — quick rating + free-text feedback.
 * Posts to /functions/v1/submit-feedback. Auth required.
 */
export default function FeedbackModal({ open, onClose, contextPage }) {
  const { theme: T, user } = useApp();
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const submit = async () => {
    if (!message.trim()) {
      setError("Tell us what's on your mind.");
      return;
    }
    if (!supabase) {
      setError("App not connected to backend.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await supabase.functions.invoke("submit-feedback", {
        body: {
          rating: rating || null,
          message: message.trim(),
          context_page: contextPage || window.location.pathname,
        },
      });
      if (res.error) throw new Error(res.error.message || "Failed to submit");
      setDone(true);
      setTimeout(() => { onClose(); reset(); }, 1500);
    } catch (e) {
      setError(e.message || "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setRating(0); setMessage(""); setDone(false); setError("");
  };

  const close = () => { onClose(); reset(); };

  return (
    <div onClick={close} style={{
      position: "fixed", inset: 0, zIndex: 200,
      backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 480, backgroundColor: T.card,
        borderRadius: "20px 20px 0 0", padding: "20px 18px",
        animation: "slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1)",
      }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: T.border }} />
        </div>

        {done ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>✓</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>
              Thanks for the feedback.
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>
              {user?.email && `Reading every word at ${user.email}.`}
            </div>
          </div>
        ) : (
          <>
            <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: T.text }}>
              Send feedback
            </h2>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: T.textMuted }}>
              The founder reads every one. Be honest.
            </p>

            {/* Rating */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 6 }}>
                Overall (optional)
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setRating(rating === n ? 0 : n)}
                    style={{
                      flex: 1, padding: "10px", borderRadius: 8,
                      border: `1px solid ${rating >= n ? T.accent : T.border}`,
                      backgroundColor: rating >= n ? T.accentDim : T.bg,
                      color: rating >= n ? T.accent : T.textMuted,
                      fontSize: 18, fontWeight: 700, cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    {"★"}
                  </button>
                ))}
              </div>
            </div>

            {/* Message */}
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What's working? What isn't? What would you build next?"
              style={{
                width: "100%", minHeight: 100,
                padding: "10px 12px", borderRadius: 10,
                backgroundColor: T.input, border: `1px solid ${T.inputBorder || T.border}`,
                color: T.text, fontSize: 14, fontFamily: "inherit",
                outline: "none", resize: "vertical", boxSizing: "border-box",
              }}
            />

            {error && (
              <div style={{
                marginTop: 8, padding: "8px 10px", borderRadius: 8,
                backgroundColor: "rgba(239,68,68,0.1)",
                color: "#ef4444", fontSize: 12, fontWeight: 600,
              }}>{error}</div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                onClick={submit}
                disabled={submitting || !message.trim()}
                style={{
                  flex: 1, padding: "12px", borderRadius: 10, border: "none",
                  backgroundColor: submitting || !message.trim() ? T.textDim : T.accent,
                  color: "#fff", fontSize: 14, fontWeight: 700,
                  cursor: submitting || !message.trim() ? "not-allowed" : "pointer",
                }}
              >
                {submitting ? "Sending..." : "Send"}
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
