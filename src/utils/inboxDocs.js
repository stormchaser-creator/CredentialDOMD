// Certificates that arrive by email (cme@credentialdomd.com, and documents
// forwarded to docs@ to keep) are written by the email-inbound edge function
// as documents rows with an inbox type (INBOX_DOC_TYPES below) and the real
// MIME type in mime_type. Everywhere else in the app doc.type IS the MIME
// type, so docMime() reads whichever is present, and leaveInbox() gives the
// fields to write when the physician links or files the doc, so the rest of
// the app (transcript PDF, exports, CME cards) sees an ordinary document again.

export const INBOX_DOC_TYPE = "cme-certificate-inbox";
export const CME_INBOX_ADDRESS = "cme@credentialdomd.com";
export const DOCS_INBOX_ADDRESS = "docs@credentialdomd.com";

export const REQUEST_INBOX_DOC_TYPE = "request-attachment-inbox";
// A document forwarded to docs@ to keep (an approval letter, a renewed card)
// that email-inbound could not file on its own: a receipt, a CV, a scan that
// failed. Filed ones arrive with linkedTo set and their MIME type in `type`,
// like any upload. Kept equal to EMAIL_INBOX_DOC_TYPE in
// supabase/functions/_shared/intakeFiling.mjs.
export const EMAIL_INBOX_DOC_TYPE = "email-inbox";
export const INBOX_DOC_TYPES = Object.freeze([INBOX_DOC_TYPE, REQUEST_INBOX_DOC_TYPE, EMAIL_INBOX_DOC_TYPE]);
export const isInboxDoc = (d) => INBOX_DOC_TYPES.includes(d?.type) && !d?.linkedTo;

export function docMime(doc) {
  if (!doc) return "";
  if (doc.type && doc.type.includes("/")) return doc.type;
  if (doc.mimeType) return doc.mimeType;
  const m = String(doc.data || "").match(/^data:(.*?)[;,]/);
  return m ? m[1] : "";
}

export const leaveInbox = (doc) =>
  doc?.type === INBOX_DOC_TYPE || doc?.type === EMAIL_INBOX_DOC_TYPE ? { type: docMime(doc) || "application/octet-stream" } : {};
