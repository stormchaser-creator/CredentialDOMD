/**
 * The one screenshot a ticket or a ticket reply can carry.
 *
 * The client sends it as a data URL; this decodes it and applies the type
 * and size rules once, so create-ticket and reply-ticket accept exactly the
 * same thing and refuse it with the same sentence. Pure by design (no Deno
 * or Supabase imports): scripts/ticket-attachment.test.mjs runs it under
 * plain node.
 *
 * Storage keys live here too so the writer (create-ticket / reply-ticket)
 * and the reader (ticket-attachment-url) agree on the layout under the
 * private "documents" bucket:
 *   tickets/<ticket_id>/screenshot.<ext>              the ticket's first
 *   tickets/<ticket_id>/screenshot-2.<ext>            the second, and so on
 *   tickets/<ticket_id>/replies/<message_id>.<ext>    a reply's first
 *   tickets/<ticket_id>/replies/<message_id>-2.<ext>  the second, and so on
 *
 * The first key of each pair is unchanged from when one screenshot was all a
 * ticket could carry, so nothing already in the bucket has to move. A
 * physician asked to send several at once because one picture rarely shows
 * a bug; the index starts at 2 for exactly that reason.
 */

export const ATTACHMENT_BUCKET = "documents";
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB decoded

export const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
};

export const ATTACHMENT_TYPE_ERROR = "Attachment must be a JPEG, PNG, WEBP, or GIF image.";
export const ATTACHMENT_SIZE_ERROR = "Attachment is too large (5 MB max).";

export interface DecodedAttachment {
  bytes: Uint8Array;
  mime: string;
  ext: string;
}

const DATA_URL = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.+)$/;

/**
 * Reads the `attachment` field of a request body.
 *   null                 -> the request carries no attachment (not an error)
 *   { error }            -> refused; the message is written for the person who attached it
 *   DecodedAttachment    -> bytes, mime, and the file extension to store it under
 */
export function parseAttachment(input: unknown): DecodedAttachment | { error: string } | null {
  const data = (input as { data?: unknown } | null | undefined)?.data;
  if (!data) return null;

  const match = DATA_URL.exec(String(data));
  if (!match) return { error: ATTACHMENT_TYPE_ERROR };
  const mime = match[1];
  const ext = MIME_EXT[mime];
  if (!ext) return { error: ATTACHMENT_TYPE_ERROR };

  // Base64 inflates by 4/3 (minus up to two padding bytes), so a payload
  // that cannot fit is refused from its length alone, before a 20 MB blob
  // gets decoded just to be thrown away.
  const b64 = match[2];
  if (Math.floor((b64.length * 3) / 4) - 2 > MAX_ATTACHMENT_BYTES) return { error: ATTACHMENT_SIZE_ERROR };

  let bin: string;
  try { bin = atob(b64); } catch { return { error: ATTACHMENT_TYPE_ERROR }; }
  if (bin.length > MAX_ATTACHMENT_BYTES) return { error: ATTACHMENT_SIZE_ERROR };

  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime, ext };
}

export const ticketScreenshotPath = (ticketId: string, ext: string) =>
  `tickets/${ticketId}/screenshot.${ext}`;

export const replyScreenshotPath = (ticketId: string, messageId: string, ext: string) =>
  `tickets/${ticketId}/replies/${messageId}.${ext}`;

/** How many images one ticket or one reply may carry. */
export const MAX_ATTACHMENTS = 5;
export const ATTACHMENT_COUNT_ERROR = `Attach at most ${MAX_ATTACHMENTS} images at a time.`;
/** And how much they may weigh together, so one request cannot carry 25 MB. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const ATTACHMENT_TOTAL_ERROR = "Those images are too large together (12 MB max). Send them across two messages.";

/**
 * Reads either shape the client may send:
 *   attachment:  { data }            one image, the original wire field
 *   attachments: [{ data }, ...]     several
 * Returns [] when there is nothing to read, { error } when the set is
 * refused, and the decoded images otherwise. A single bad image refuses the
 * whole set rather than silently dropping one: a physician who attached four
 * and sees three arrive has no way to know which went missing.
 */
export function parseAttachments(body: unknown): DecodedAttachment[] | { error: string } {
  const b = (body || {}) as { attachment?: unknown; attachments?: unknown };
  const list = Array.isArray(b.attachments)
    ? b.attachments
    : (b.attachment ? [b.attachment] : []);
  if (!list.length) return [];
  if (list.length > MAX_ATTACHMENTS) return { error: ATTACHMENT_COUNT_ERROR };

  const out: DecodedAttachment[] = [];
  let total = 0;
  for (const item of list) {
    const one = parseAttachment(item);
    if (one === null) continue;            // an empty slot is not an error
    if ("error" in one) return { error: one.error };
    total += one.bytes.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) return { error: ATTACHMENT_TOTAL_ERROR };
    out.push(one);
  }
  return out;
}

/**
 * The key for image `index` (0-based). Index 0 keeps the original key so
 * every object already in the bucket stays where the reader expects it.
 */
export const ticketScreenshotPathAt = (ticketId: string, ext: string, index: number) =>
  index === 0 ? ticketScreenshotPath(ticketId, ext) : `tickets/${ticketId}/screenshot-${index + 1}.${ext}`;

export const replyScreenshotPathAt = (ticketId: string, messageId: string, ext: string, index: number) =>
  index === 0
    ? replyScreenshotPath(ticketId, messageId, ext)
    : `tickets/${ticketId}/replies/${messageId}-${index + 1}.${ext}`;

/**
 * Every path a ticket or message row carries, old shape or new, in order and
 * without duplicates. `attachment_path` was the only column for a while, so a
 * row can hold the singular, the array, or both.
 */
export function attachmentPathsOf(row: { attachment_path?: string | null; attachment_paths?: string[] | null } | null | undefined): string[] {
  const many = Array.isArray(row?.attachment_paths) ? row!.attachment_paths.filter(Boolean) : [];
  const one = row?.attachment_path ? [row.attachment_path] : [];
  return [...new Set([...one, ...many])];
}
