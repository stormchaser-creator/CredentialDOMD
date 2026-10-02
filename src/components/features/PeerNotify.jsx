import { useState, memo, useCallback } from "react";
import { composeText } from "../../utils/notifications";
import { useApp } from "../../context/AppContext";
import Modal from "../shared/Modal";
import { mailtoHref } from "../../utils/helpers";
import { peerHeadsUp, smsCutNotice } from "../../utils/shareText";
import { TAP_MIN, CARD_ACTION_GAP } from "../shared/actionButton.js";

// The two heads-up buttons under a reference's phone card: 28 px tall at
// padding 4px 10px, under the app's 32 px floor (CRED-041).
const headsUpButton = (backgroundColor, color) => ({
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  minHeight: TAP_MIN, padding: "6px 12px", borderRadius: 8, border: "none",
  backgroundColor, color, fontSize: 12, fontWeight: 600, cursor: "pointer",
});

const NEEDS_NAME = "Add your name in More > Profile & settings first, so the heads-up says who it is from.";

function PeerNotify({ peer }) {
  const { data, theme: T } = useApp();
  const [show, setShow] = useState(null); // "email" | "text" | null
  const [cutNote, setCutNote] = useState("");

  // The wording lives in shareText.peerHeadsUp (pure, unit-tested). With no
  // name on the profile there is no draft: it used to go out signed
  // "Dr. [Your Name]".
  const draft = peerHeadsUp(data.settings, peer);
  const { emailSubject = "", emailBody = "", textBody = "" } = draft || {};

  const handleEmail = useCallback(() => {
    if (!draft) { setCutNote(NEEDS_NAME); return; }
    if (peer.email) {
      window.open(mailtoHref(peer.email, emailSubject, emailBody));
    } else {
      setShow("email");
    }
  }, [draft, peer.email, emailSubject, emailBody]);

  const handleText = useCallback(() => {
    if (!draft) { setCutNote(NEEDS_NAME); return; }
    if (peer.phone) {
      const cleaned = peer.phone.replace(/\D/g, "");
      const { truncated, copied } = composeText(cleaned, textBody, { copyFullOnCut: true });
      if (truncated) copied.then(ok => setCutNote(smsCutNotice(ok)));
    } else {
      setShow("text");
    }
  }, [draft, peer.phone, textBody]);

  const handleCopy = useCallback((text) => {
    navigator.clipboard?.writeText(text);
  }, []);

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: CARD_ACTION_GAP, marginTop: 6 }}>
        <button onClick={handleEmail} style={headsUpButton(T.accentDim, T.accent)}>
          {"\u2709\ufe0f"} Email Heads-Up
        </button>
        <button onClick={handleText} style={headsUpButton(T.successDim || "rgba(34,197,94,0.1)", T.success || "#22c55e")}>
          {"\ud83d\udcac"} Text Heads-Up
        </button>
      </div>
      {cutNote && <div role="status" style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>{cutNote}</div>}

      {/* Show draft in modal when no email/phone */}
      <Modal open={show === "email"} onClose={() => setShow(null)} title="Email Draft">
        <div style={{ fontSize: 13, color: T.textDim, marginBottom: 8 }}>
          {peer.email ? `To: ${peer.email}` : "No email on file. Copy this draft and send it yourself."}
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.accent, marginBottom: 4 }}>
          Subject: {emailSubject}
        </div>
        <div style={{
          whiteSpace: "pre-wrap", fontSize: 13, color: T.text, lineHeight: 1.6,
          padding: 14, borderRadius: 10, backgroundColor: T.input,
          border: `1px solid ${T.border}`, maxHeight: 300, overflowY: "auto",
        }}>
          {emailBody}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={() => setShow(null)} style={{
            padding: "10px 16px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}>Close</button>
          <button onClick={() => { handleCopy(emailBody); setShow(null); }} style={{
            padding: "10px 16px", borderRadius: 10, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}>Copy to Clipboard</button>
        </div>
      </Modal>

      <Modal open={show === "text"} onClose={() => setShow(null)} title="Text Draft">
        <div style={{ fontSize: 13, color: T.textDim, marginBottom: 8 }}>
          {peer.phone ? `To: ${peer.phone}` : "No phone on file. Copy this draft and send it yourself."}
        </div>
        <div style={{
          whiteSpace: "pre-wrap", fontSize: 13, color: T.text, lineHeight: 1.6,
          padding: 14, borderRadius: 10, backgroundColor: T.input,
          border: `1px solid ${T.border}`,
        }}>
          {textBody}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={() => setShow(null)} style={{
            padding: "10px 16px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}>Close</button>
          <button onClick={() => { handleCopy(textBody); setShow(null); }} style={{
            padding: "10px 16px", borderRadius: 10, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}>Copy to Clipboard</button>
        </div>
      </Modal>
    </>
  );
}

export default memo(PeerNotify);
