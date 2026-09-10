/**
 * How many files one ticket or one reply may carry, what kinds, and what
 * happens when somebody picks more.
 *
 * The limits live here rather than in the control so a node test can hold
 * them to the same numbers the edge function enforces
 * (MAX_ATTACHMENTS and MAX_TOTAL_ATTACHMENT_BYTES in
 * supabase/functions/_shared/ticketAttachment.ts). A client that lets a
 * physician attach six images and a server that refuses the sixth is a bug
 * they discover only after writing the message.
 */

export const MAX_TICKET_IMAGES = 5;
export const MAX_TICKET_IMAGE_BYTES = 5 * 1024 * 1024;   // per image, decoded
export const MAX_TICKET_TOTAL_BYTES = 12 * 1024 * 1024;  // all of them together

/**
 * What the file picker offers. It was "image/*", which is why a physician
 * reporting a problem with a PDF opened the picker and found the PDF grayed
 * out: the one file that showed what was wrong was the one file he could not
 * send. iOS grays out anything whose exact MIME type is missing, so the
 * extension AND the MIME appear for each kind, and this list holds exactly
 * what MIME_EXT in supabase/functions/_shared/ticketAttachment.ts stores.
 *
 * HTML and SVG are absent on purpose: a browser executes them, and these are
 * served back under a signed link from a storage domain.
 */
export const TICKET_ATTACH_ACCEPT = [
  "image/*",
  ".pdf", "application/pdf",
  ".doc", "application/msword",
  ".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls", "application/vnd.ms-excel",
  ".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv", "text/csv",
  ".txt", "text/plain",
  ".rtf", "application/rtf",
  ".heic", ".heif",
].join(",");

/** The MIME types the server will store, by extension. */
export const TICKET_MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  heic: "image/heic", heif: "image/heif",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv", txt: "text/plain", rtf: "application/rtf",
};

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif)$/i;

/**
 * Whether a thing can be shown in the thread or only linked to.
 *
 * Takes a filename, a MIME type or a signed URL, because the sender knows the
 * file and the reader only ever has the link. A signed link carries a query
 * string, so the path is read up to the "?".
 */
export function attachmentKind(source = "", mime = "") {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return m.includes("heic") || m.includes("heif") ? "file" : "image";
  if (m === "application/pdf") return "pdf";
  const path = String(source || "").split("?")[0].split("#")[0];
  if (/\.pdf$/i.test(path)) return "pdf";
  // HEIC is an image a browser will not draw, so it is offered as a file.
  if (/\.(heic|heif)$/i.test(path)) return "file";
  if (IMAGE_EXT.test(path)) return "image";
  if (m && m !== "application/octet-stream") return "file";
  return "file";
}

/** The MIME type a data URL declares, or "" when it declares nothing. */
export function mimeOfDataUrl(dataUrl) {
  const m = /^data:([^;,]+)/.exec(String(dataUrl || ""));
  return m ? m[1].toLowerCase() : "";
}

/** The name to show for a link when the original filename is long gone. */
export function attachmentLabel(url = "", index = 0) {
  const path = String(url || "").split("?")[0].split("#")[0];
  const ext = (path.match(/\.([a-z0-9]{1,5})$/i) || [])[1];
  const kind = attachmentKind(url);
  if (kind === "pdf") return `PDF attachment ${index + 1}`;
  if (ext) return `${ext.toUpperCase()} attachment ${index + 1}`;
  return `Attachment ${index + 1}`;
}

/** Roughly what a data URL weighs once decoded. */
export function dataUrlBytes(dataUrl) {
  const i = String(dataUrl || "").indexOf(",");
  if (i < 0) return 0;
  const b64 = String(dataUrl).slice(i + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

export function totalBytes(images) {
  return (Array.isArray(images) ? images : []).reduce((n, im) => n + dataUrlBytes(im?.data), 0);
}

/**
 * Add newly picked images to the ones already attached.
 *
 * Returns { images, error }. Whatever fits is kept, and `error` says what did
 * not and why, because silently dropping the fourth file is how a physician
 * sends three and believes they sent four.
 */
export function addImages(existing, picked) {
  const have = Array.isArray(existing) ? [...existing] : [];
  const list = Array.isArray(picked) ? picked : [picked].filter(Boolean);
  let error = "";

  for (const img of list) {
    if (!img?.data) continue;
    if (have.length >= MAX_TICKET_IMAGES) {
      error = `Only ${MAX_TICKET_IMAGES} files fit on one message. The rest were not attached.`;
      break;
    }
    const size = dataUrlBytes(img.data);
    if (size > MAX_TICKET_IMAGE_BYTES) {
      error = `"${img.name || "That file"}" is larger than 5 MB and was not attached.`;
      continue;
    }
    if (totalBytes(have) + size > MAX_TICKET_TOTAL_BYTES) {
      error = "Those files are too large together (12 MB max). Send the rest in a second message.";
      break;
    }
    have.push(img);
  }
  return { images: have, error };
}

/** The wire field both edge functions read. */
export function attachmentsPayload(images) {
  const list = (Array.isArray(images) ? images : [images]).filter((im) => im?.data);
  if (!list.length) return {};
  // The singular is still sent so a function that has not been redeployed
  // yet still receives the first image rather than none.
  return { attachment: { data: list[0].data }, attachments: list.map((im) => ({ data: im.data })) };
}

/** Every signed link for one message, from either shape the API returns. */
export function linksFor(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}
