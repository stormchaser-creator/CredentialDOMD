// Certificates that arrive by email (cme@credentialdomd.com) are written by
// the email-inbound edge function as documents rows with
// type = INBOX_DOC_TYPE and the real MIME type in mime_type. Everywhere else
// in the app doc.type IS the MIME type, so docMime() reads whichever is
// present, and leaveInbox() gives the fields to write when the physician links
// or files the doc, so the rest of the app (transcript PDF, exports, CME cards)
// sees an ordinary document again.

export const INBOX_DOC_TYPE = "cme-certificate-inbox";
export const CME_INBOX_ADDRESS = "cme@credentialdomd.com";

export const REQUEST_INBOX_DOC_TYPE = "request-attachment-inbox";
export const isInboxDoc = (d) => (d?.type === INBOX_DOC_TYPE || d?.type === REQUEST_INBOX_DOC_TYPE) && !d?.linkedTo;

export function docMime(doc) {
  if (!doc) return "";
  if (doc.type && doc.type.includes("/")) return doc.type;
  if (doc.mimeType) return doc.mimeType;
  const m = String(doc.data || "").match(/^data:(.*?)[;,]/);
  return m ? m[1] : "";
}

export const leaveInbox = (doc) =>
  doc?.type === INBOX_DOC_TYPE ? { type: docMime(doc) || "application/octet-stream" } : {};
