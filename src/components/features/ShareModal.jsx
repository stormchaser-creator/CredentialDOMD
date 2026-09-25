import { useState, useEffect, useRef, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import EmailPacketModal from "./EmailPacketModal";
import CredentialPortalLauncher from "./CredentialPortalModal.jsx";
import { EmailIcon, TextMsgIcon, CopyIcon, CheckIcon, FileIcon } from "../shared/Icons";
import { buildCredentialText, buildCredentialBlurb, buildEmailSubject, generateId, copyToClipboard, mailtoHref } from "../../utils/helpers";
import { composeText } from "../../utils/notifications";
import { scrubSsn } from "../../utils/outgoingText.js";
import { credentialLetter, credentialSharePayload, smsCutNotice } from "../../utils/shareText";
import { resolveDocuments, missingReceiptMessage } from "../../utils/receiptFiles";
import { downloadDocumentBlob } from "../../lib/supabase";

function ShareModal({ open, onClose, item, section, linkedDocs, onLogShare }) {
  const { data, theme: T } = useApp();
  const iS = useInputStyle();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(null);
  // What the SENDER needs to know after a send (never put in the message).
  // App keeps this sheet mounted and only toggles `open`, so a hint is tied
  // to the credential it was written for and cleared on close: credential
  // B's sheet must never say "the formatted letter is on your clipboard"
  // while the clipboard holds credential A's letter.
  const hintKey = open && item ? String(item.id ?? "") : "";
  const [hintState, setHintState] = useState({ key: "", text: "" });
  const hintTimer = useRef(null);
  const hint = hintState.key === hintKey ? hintState.text : "";
  const clearHint = () => { clearTimeout(hintTimer.current); setHintState({ key: "", text: "" }); };
  const flashHint = (msg) => {
    clearTimeout(hintTimer.current);
    setHintState({ key: hintKey, text: msg });
    hintTimer.current = setTimeout(() => setHintState({ key: "", text: "" }), 12000);
  };
  const close = () => { clearHint(); onClose?.(); };
  // The linked files, resolved when the sheet opens. `doc.data` is stripped
  // from the device once a document has a storagePath, so reading only
  // `doc.data` found nothing and "Send with 2 documents attached" went out
  // as the letter alone. Resolving here, not in the tap, keeps the user
  // gesture live for the share sheet.
  const docsKey = hintKey && linkedDocs?.length ? `${hintKey}|${linkedDocs.map((d) => d.id).join(",")}` : "";
  const [resolved, setResolved] = useState({ key: "", files: [], missing: [] });
  useEffect(() => {
    if (!docsKey) return undefined;
    let live = true;
    resolveDocuments(linkedDocs, { download: downloadDocumentBlob })
      .then(({ files, missing }) => { if (live) setResolved({ key: docsKey, files, missing }); });
    return () => { live = false; };
  }, [docsKey, linkedDocs]);
  const docFiles = resolved.key === docsKey ? resolved : null; // null while resolving
  // "Email with attachments": the server sends the linked files as real
  // attachments from docs@credentialdomd.com (reply_to = the physician).
  // share_log for that path is written by the server, not here.
  const [emailPacketOpen, setEmailPacketOpen] = useState(false);

  if (!open || !item) return null;

  const credText = buildCredentialText(item, section, data.settings);
  const subject = buildEmailSubject(item, section, data.settings);
  const hasDocs = (linkedDocs?.length ?? 0) > 0;
  // A letter-shaped body: recipients are credentialing staff, not the app.
  // `full` goes where nothing can be attached (mailto:, SMS, Copy, a share
  // with no file), so it never claims attachments. `withDocs` goes with the
  // files (the clipboard copy beside a file share, Email with attachments).
  const full = credentialLetter(item, section, data.settings, { note });
  const withDocs = credentialLetter(item, section, data.settings, { note, attached: hasDocs });

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
    // A button that says "Send with N documents attached" never sends the
    // letter alone: if any linked file is not in hand, or this browser cannot
    // share files, nothing opens and the sender is told why.
    const files = hasDocs ? (docFiles?.files || []) : [];
    if (hasDocs && !docFiles) {
      flashHint("The linked documents are still loading. Try again in a moment, or use Email with attachments.");
      return;
    }
    if (hasDocs && docFiles.missing.length) {
      flashHint(`${missingReceiptMessage(docFiles.missing, { one: "document", many: "documents" })} Nothing was sent. Use Email with attachments, or send again once they are available.`);
      return;
    }
    const attach = files.length > 0 && !!navigator.canShare?.({ files });
    if (hasDocs && !attach) {
      flashHint("This browser cannot attach files to a share, so nothing was sent. Use Email with attachments, or send from the app on your phone.");
      return;
    }

    // With files, iOS Mail drops the title and flattens newlines in shared
    // text (the letter became one giant run-on with the salutation as the
    // subject), so a file share carries a flowing one-paragraph blurb and the
    // formatted letter goes on the clipboard. With no file, the share IS the
    // letter, line breaks and all.
    const blurb = scrubSsn(buildCredentialBlurb(item, section, data.settings, attach, note));
    const copied = attach ? await copyToClipboard(withDocs) : false;
    const payload = credentialSharePayload({ files: attach ? files : [], subject, blurb, letter: full });
    clearHint();
    try {
      await navigator.share(payload);
      setSent("share"); setTimeout(() => setSent(null), 3000);
      if (copied) flashHint("The formatted letter is on your clipboard if you want to paste it over the short intro.");
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
    const { truncated, copied } = composeText(phone || "", full, { copyFullOnCut: true });
    clearHint();
    if (truncated) copied.then(ok => flashHint(smsCutNotice(ok)));
    setSent("text"); setTimeout(() => setSent(null), 3000); log("text", phone);
  };

  const doCopy = async () => {
    await copyToClipboard(full);
    setCopied(true); setTimeout(() => setCopied(false), 2500); log("clipboard");
  };

  return (
    <Modal open={open} onClose={close} title="Send Credential">
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

      {hint && (
        <div role="status" style={{ marginTop: 10, fontSize: 13, color: T.textMuted, lineHeight: 1.45 }}>{hint}</div>
      )}

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

      <CredentialPortalLauncher initialDocIds={(linkedDocs || []).map(doc => doc.id)} initialTo={email} />

      {hasDocs && (
        <EmailPacketModal
          open={emailPacketOpen}
          onClose={() => setEmailPacketOpen(false)}
          request={null}
          initialTo={email}
          initialSubject={subject}
          initialNote={withDocs}
          initialDocIds={linkedDocs.map(d => d.id)}
        />
      )}
    </Modal>
  );
}

export default memo(ShareModal);
