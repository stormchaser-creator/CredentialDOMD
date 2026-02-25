import { useState, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import { EmailIcon, TextMsgIcon, CopyIcon, CheckIcon, FileIcon } from "../shared/Icons";
import { buildCredentialText, buildEmailSubject, generateId, copyToClipboard } from "../../utils/helpers";

function ShareModal({ open, onClose, item, section, linkedDocs, onLogShare }) {
  const { data, theme: T } = useApp();
  const iS = useInputStyle();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(null);

  if (!open || !item) return null;

  const credText = buildCredentialText(item, section, data.settings);
  const subject = buildEmailSubject(item, section, data.settings);
  const full = note ? note + "\n\n" + credText : credText;

  const log = (method, to) => {
    onLogShare?.({
      id: generateId(),
      itemName: item.name || item.type || item.title || item.category,
      section, method, recipient: to || "",
      sentAt: new Date().toISOString(),
    });
  };

  const doEmail = () => {
    window.open(`mailto:${encodeURIComponent(email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(full)}`, "_blank");
    setSent("email"); setTimeout(() => setSent(null), 3000); log("email", email);
  };

  const doText = () => {
    window.open(`sms:${phone || ""}?body=${encodeURIComponent(full)}`, "_blank");
    setSent("text"); setTimeout(() => setSent(null), 3000); log("text", phone);
  };

  const doCopy = async () => {
    await copyToClipboard(full);
    setCopied(true); setTimeout(() => setCopied(false), 2500); log("clipboard");
  };

  return (
    <Modal open={open} onClose={onClose} title="Send Credential">
      <div style={{
        backgroundColor: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 12,
        padding: 14, marginBottom: 16, maxHeight: 160, overflow: "auto",
        fontFamily: "monospace", fontSize: 13, color: T.textMuted, lineHeight: 1.5, whiteSpace: "pre-wrap",
      }}>
        {credText}
      </div>

      {linkedDocs?.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, marginBottom: 6, textTransform: "uppercase" }}>
            Linked Documents ({linkedDocs.length})
          </div>
          {linkedDocs.map(doc => (
            <div key={doc.id} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
              border: `1px solid ${T.border}`, borderRadius: 8, marginBottom: 4, fontSize: 14, color: T.text,
            }}>
              <FileIcon />{doc.name}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <Field label="Email">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={iS} placeholder="admin@hospital.org" />
        </Field>
        <Field label="Phone">
          <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} style={iS} placeholder="(555) 123-4567" />
        </Field>
      </div>
      <Field label="Note (optional)">
        <textarea value={note} onChange={e => setNote(e.target.value)} style={{ ...iS, minHeight: 44, resize: "vertical" }} placeholder="Please find my credential..." />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 18 }}>
        <button onClick={doEmail} style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 10px",
          backgroundColor: T.accentDim, color: T.accent, border: "none", borderRadius: 14, cursor: "pointer", fontSize: 14, fontWeight: 600,
        }}>
          <EmailIcon />{sent === "email" ? "Opening..." : "Email"}
        </button>
        <button onClick={doText} style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 10px",
          backgroundColor: T.successDim, color: T.success, border: "none", borderRadius: 14, cursor: "pointer", fontSize: 14, fontWeight: 600,
        }}>
          <TextMsgIcon />{sent === "text" ? "Opening..." : "Text"}
        </button>
        <button onClick={doCopy} style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 10px",
          backgroundColor: T.shareDim, color: T.share, border: "none", borderRadius: 14, cursor: "pointer", fontSize: 14, fontWeight: 600,
        }}>
          {copied ? <CheckIcon /> : <CopyIcon />}{copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </Modal>
  );
}

export default memo(ShareModal);
