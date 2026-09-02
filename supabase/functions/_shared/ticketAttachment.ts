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
 *   tickets/<ticket_id>/screenshot.<ext>            the ticket's own
 *   tickets/<ticket_id>/replies/<message_id>.<ext>  one per reply
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
