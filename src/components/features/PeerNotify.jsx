import { useState, memo, useCallback } from "react";
import { useApp } from "../../context/AppContext";
import Modal from "../shared/Modal";

function PeerNotify({ peer }) {
  const { data, theme: T } = useApp();
  const [show, setShow] = useState(null); // "email" | "text" | null

  const userName = data.settings?.name || "Dr. [Your Name]";
  const userDegree = data.settings?.degreeType || "";
  const userFull = userDegree ? `${userName}, ${userDegree}` : userName;

  // Extract last name: handles "Jane Smith, MD" -> "Smith", "Smith" -> "Smith", "Jane Smith" -> "Smith"
  const peerLastName = (() => {
    if (!peer.name) return "Colleague";
    const beforeComma = peer.name.split(",")[0].trim();
    const parts = beforeComma.split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : parts[0];
  })();

  const emailSubject = `Upcoming Reference Request \u2014 ${userName}`;

  const emailBody = `Dear Dr. ${peerLastName},

I hope this message finds you well. I am writing to let you know that you may be contacted in the near future as part of a credentialing or privileging process on my behalf.

A representative from the credentialing organization may reach out to you via email or phone to verify our professional relationship and to ask about my clinical competence, character, and qualifications.

I truly appreciate your willingness to serve as a reference for me. Your support means a great deal, and I am grateful for the professional relationship we have built over the years.

If you have any questions or concerns, please do not hesitate to reach out to me directly.

With sincere gratitude,
${userFull}`;

  const textBody = `Hi, this is ${userName}. I wanted to give you a heads up that someone from a credentialing organization may be reaching out to you soon for a professional reference on my behalf. I truly appreciate your willingness to vouch for me. Thank you so much for your support!`;

  const handleEmail = useCallback(() => {
    if (peer.email) {
      window.open(`mailto:${peer.email}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`);
    } else {
      setShow("email");
    }
  }, [peer.email, emailSubject, emailBody]);

  const handleText = useCallback(() => {
    if (peer.phone) {
      const cleaned = peer.phone.replace(/\D/g, "");
      window.open(`sms:${cleaned}?body=${encodeURIComponent(textBody)}`);
    } else {
      setShow("text");
    }
  }, [peer.phone, textBody]);

  const handleCopy = useCallback((text) => {
    navigator.clipboard?.writeText(text);
  }, []);

  return (
    <>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button onClick={handleEmail} style={{
          padding: "4px 10px", borderRadius: 8, border: "none",
          backgroundColor: T.accentDim, color: T.accent,
          fontSize: 12, fontWeight: 600, cursor: "pointer",
        }}>
          {"\u2709\ufe0f"} Email Heads-Up
        </button>
        <button onClick={handleText} style={{
          padding: "4px 10px", borderRadius: 8, border: "none",
          backgroundColor: T.successDim || "rgba(34,197,94,0.1)", color: T.success || "#22c55e",
          fontSize: 12, fontWeight: 600, cursor: "pointer",
        }}>
          {"\ud83d\udcac"} Text Heads-Up
        </button>
      </div>

      {/* Show draft in modal when no email/phone */}
      <Modal open={show === "email"} onClose={() => setShow(null)} title="Email Draft">
        <div style={{ fontSize: 13, color: T.textDim, marginBottom: 8 }}>
          {peer.email ? `To: ${peer.email}` : "No email on file \u2014 copy this draft and send manually."}
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
          {peer.phone ? `To: ${peer.phone}` : "No phone on file \u2014 copy this draft and send manually."}
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
