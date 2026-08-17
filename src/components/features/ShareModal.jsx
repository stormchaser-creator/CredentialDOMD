import { useState, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import EmailPacketModal from "./EmailPacketModal";
import { EmailIcon, TextMsgIcon, CopyIcon, CheckIcon, FileIcon } from "../shared/Icons";
import { buildCredentialText, buildCredentialBlurb, buildEmailSubject, generateId, copyToClipboard, mailtoHref } from "../../utils/helpers";
import { composeText } from "../../utils/notifications";

function ShareModal({ open, onClose, item, section, linkedDocs, onLogShare }) {
  const { data, theme: T } = useApp();
  const iS = useInputStyle();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(null);
  // "Email with attachments": the server sends the linked files as real
  // attachments from docs@credentialdomd.com (reply_to = the physician).
  // share_log for that path is written by the server, not here.
  const [emailPacketOpen, setEmailPacketOpen] = useState(false);

  if (!open || !item) return null;

  const credText = buildCredentialText(item, section, data.settings);
  const subject = buildEmailSubject(item, section, data.settings);
  const physician = data.settings?.name ? `${data.settings.name}${data.settings.degreeType ? `, ${data.settings.degreeType}` : ""}` : "the physician";
  const hasDocs = (linkedDocs?.length ?? 0) > 0;
  // A letter-shaped body — recipients are credentialing staff, not the app.
  const full = [
    "To whom it may concern,",
    "",
    note || `Please find the credential verification for ${physician} below${hasDocs ? ", with supporting documentation attached" : ""}.`,
    "",
    credText,
  ].join("\n");

  const log = (method, to) => {
    onLogShare?.({
      id: generateId(),
      itemId: item.id,
      itemName: item.name || item.type || item.title || item.category,
      section, method, recipient: to || "",
      sentAt: new Date().toISOString(),
    });
  };

  // Send history for THIS credential — who it went to and when.
  const history = (data.shareLog || [])
    .filter((e) => e.itemId === item.id || (!e.itemId && e.itemName === (item.name || item.type || item.title || item.category)))
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));

  // Native share sheet — the only client-side path that ATTACHES the actual
  // document files (mailto: cannot). User picks Mail/Messages/AirDrop and the
  // send happens from their own account.
  const canNativeShare = typeof navigator !== "undefined" && !!navigator.share;
  const doShare = async () => {
    const files = (linkedDocs || []).map((doc) => {
      try {
        const [head, b64] = (doc.data || "").split(",");
        if (!b64) return null;
        const mime = doc.type || head.match(/data:(.*?)[;,]/)?.[1] || "application/octet-stream";
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new File([arr], doc.name || "document", { type: mime });
      } catch { return null; }
    }).filter(Boolean);

    // iOS Mail drops the title and flattens newlines in shared text — the
    // letter-shaped `full` became one giant run-on with the salutation as
    // the subject. Share a flowing one-paragraph blurb instead, and put the
    // formatted letter on the clipboard for pasting.
    const blurb = buildCredentialBlurb(item, section, data.settings, files.length > 0, note);
    await copyToClipboard(full);
    const payload = files.length && navigator.canShare?.({ files })
      ? { files, title: subject, text: blurb }
      : { title: subject, text: blurb };
    try {
      await navigator.share(payload);
      setSent("share"); setTimeout(() => setSent(null), 3000);
      log("share", email);
    } catch (err) {
      if (err?.name !== "AbortError") setSent(null);
    }
  };

  const doEmail = () => {
    window.open(mailtoHref(email, subject, full), "_blank");
    setSent("email"); setTimeout(() => setSent(null), 3000); log("email", email);
  };

  const doText = () => {
    composeText(phone || "", full);
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

      {canNativeShare && (
        <button onClick={doShare} style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          width: "100%", marginTop: 18, padding: "14px 10px",
          background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
          border: "none", borderRadius: 14, cursor: "pointer", fontSize: 15, fontWeight: 700,
        }}>
          {sent === "share" ? "Opening…" : hasDocs
            ? `Send with ${linkedDocs.length} document${linkedDocs.length > 1 ? "s" : ""} attached`
            : "Send via Mail, Messages, AirDrop…"}
        </button>
      )}

      {hasDocs && (
        <button onClick={() => setEmailPacketOpen(true)} title="Sends the linked documents as real email attachments from CredentialDOMD; replies come to your account email" style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          width: "100%", marginTop: canNativeShare ? 10 : 18, padding: "13px 10px",
          backgroundColor: T.accentDim, color: T.accent, border: `1px solid ${T.accent}`,
          borderRadius: 14, cursor: "pointer", fontSize: 14.5, fontWeight: 700,
        }}>
          <EmailIcon />Email with attachments ({linkedDocs.length})
        </button>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
        <button onClick={doEmail} title="Opens your mail app with the text only: email links cannot carry attachments" style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 10px",
          backgroundColor: T.accentDim, color: T.accent, border: "none", borderRadius: 14, cursor: "pointer", fontSize: 14, fontWeight: 600,
        }}>
          <EmailIcon />{sent === "email" ? "Opening..." : "Email (opens Mail)"}
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

      {history.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, marginBottom: 6, textTransform: "uppercase" }}>
            Send history
          </div>
          {history.slice(0, 8).map((e) => (
            <div key={e.id} style={{
              display: "flex", justifyContent: "space-between", gap: 8,
              padding: "7px 10px", border: `1px solid ${T.border}`, borderRadius: 8,
              marginBottom: 4, fontSize: 13, color: T.text,
            }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.method === "share" ? "Shared" : e.method === "email" ? "Emailed" : e.method === "text" ? "Texted" : "Copied"}
                {e.recipient ? ` to ${e.recipient}` : ""}
              </span>
              <span style={{ color: T.textMuted, flexShrink: 0 }}>
                {new Date(e.sentAt).toLocaleDateString()} {new Date(e.sentAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      )}

      {hasDocs && (
        <EmailPacketModal
          open={emailPacketOpen}
          onClose={() => setEmailPacketOpen(false)}
          request={null}
          initialTo={email}
          initialSubject={subject}
          initialNote={full}
          initialDocIds={linkedDocs.map(d => d.id)}
        />
      )}
    </Modal>
  );
}

export default memo(ShareModal);
