/**
 * The files a ticket or a ticket reply can carry.
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
 * a bug; the index starts at 2 for exactly that reason. The word "screenshot"
 * in the key is history now that a PDF can be attached too, and renaming it
 * would move every object already in the bucket for nothing.
 */

export const ATTACHMENT_BUCKET = "documents";
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB decoded

/**
 * What may be stored, and under which extension.
 *
 * Images were the whole list until a physician tried to attach the PDF he was
 * complaining about and found every file in the picker grayed out. A ticket is
 * where someone shows you the thing that is wrong, so the thing that is wrong
 * has to fit: a certificate PDF, a statement, a spreadsheet.
 *
 * Two types are deliberately absent. HTML and SVG are documents a browser
 * executes, and these are served from a storage domain under a signed link, so
 * storing one means hosting a script someone else wrote.
 */
export const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "image/heic": "heic", "image/heif": "heif",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "text/plain": "txt",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
};

export const ATTACHMENT_TYPE_ERROR =
  "Attach an image, a PDF, or a document (Word, Excel, CSV, or text).";
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

/** How many files one ticket or one reply may carry. */
export const MAX_ATTACHMENTS = 5;
export const ATTACHMENT_COUNT_ERROR = `Attach at most ${MAX_ATTACHMENTS} files at a time.`;
/** And how much they may weigh together, so one request cannot carry 25 MB. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const ATTACHMENT_TOTAL_ERROR = "Those files are too large together (12 MB max). Send them across two messages.";

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

// ── Reading a path back: what this file is willing to hand to a signer ──────
/**
 * The failure this section exists for.
 *
 * ticket-attachment-url checked that the caller owns the TICKET and then
 * signed whatever key the row happened to carry, with the service-role
 * client, against the private "documents" bucket. That bucket also holds
 * every physician's uploaded documents at "<clerk sub>/<uuid>". Nothing
 * checked that the key belonged to the ticket.
 *
 * The path column has a second writer besides our functions. RLS lets any
 * signed-in caller INSERT a support_tickets row and UPDATE their own
 * (tickets_user_insert / tickets_owner_or_admin_update, both constrained on
 * user_id alone) and INSERT support_messages (messages_thread_insert)
 * straight through PostgREST, and create-ticket used to copy
 * body.context_payload onto the row wholesale. So a caller could open their
 * own ticket, point it at another account's document key, and ask this
 * function for a signed link to it. Clerk sign-up is open, so "signed in"
 * is not a boundary here.
 *
 * The answer is the one _shared/storagePath.ts already uses for the sibling
 * signers: do not test a prefix, demand the exact shape the writer produces.
 * Four shapes exist and nothing else is ever written:
 *   tickets/<ticketId>/screenshot.<ext>
 *   tickets/<ticketId>/screenshot-<n>.<ext>
 *   tickets/<ticketId>/replies/<messageId>.<ext>
 *   tickets/<ticketId>/replies/<messageId>-<n>.<ext>
 */

/**
 * Which extensions a stored attachment may carry, taken from MIME_EXT so the
 * writer's whitelist and this reader's check cannot drift apart. A key whose
 * extension is not one the upload path could have produced is not ours.
 */
export const ATTACHMENT_EXTS: ReadonlySet<string> = new Set(Object.values(MIME_EXT));

/** A ticket id or a message id as this system mints them: a uuid, nothing else. */
const ID_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Every character a key of ours can contain. Checking the whole string once
 * is what rules out a scheme ("https:"), an escape ("%2e%2e"), a query, a
 * backslash, whitespace and any control character, without a separate test
 * for each.
 */
const PATH_CHARS = /^[A-Za-z0-9/._-]+$/;

/**
 * The "-2" through "-99" that tells the second file from the first. The
 * writer never goes past MAX_ATTACHMENTS, but pinning this to today's cap
 * would orphan objects already in the bucket the day the cap moves, so the
 * bound is loose and the point of it is only that the suffix is a small
 * plain number.
 */
const INDEX_SUFFIX = /^([2-9]|[1-9][0-9])$/;

/**
 * A file name of ours: the stem the writer used, optionally "-<n>", then a
 * whitelisted extension. `stem` is "screenshot" for a ticket's own file and
 * the message id for a reply's.
 */
function isAttachmentLeaf(leaf: string, stem: string): boolean {
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return false;
  if (!ATTACHMENT_EXTS.has(leaf.slice(dot + 1))) return false;
  const base = leaf.slice(0, dot);
  if (base === stem) return true;
  if (!base.startsWith(`${stem}-`)) return false;
  return INDEX_SUFFIX.test(base.slice(stem.length + 1));
}

/**
 * True only for a key this system wrote for THIS ticket (and, when a message
 * id is given, for THAT reply). Pure, so scripts/ticket-attachment.test.mjs
 * covers it under plain node.
 *
 * Pass `messageId` when the path came off a support_messages row: the reply
 * family is then the only one that passes, and it must carry that row's own
 * id, so a reply cannot borrow a sibling reply's file either. Leave it out
 * (or pass null) for a path off the ticket's context_payload, where only the
 * ticket's own screenshot family is legitimate. Only undefined and null mean
 * "no message id"; anything else present but unusable, an empty string
 * included, is a reply check that fails.
 */
export function isTicketAttachmentPath(
  path: string | null | undefined,
  ticketId: string | null | undefined,
  messageId?: string | null,
): boolean {
  if (typeof path !== "string" || !path) return false;
  if (typeof ticketId !== "string" || !ID_TOKEN.test(ticketId)) return false;
  if (!PATH_CHARS.test(path)) return false;
  // Belt and braces over the character whitelist: a dot segment, an empty
  // segment or a leading slash all resolve somewhere other than where they
  // read, which is the whole trick storagePath.ts was written to stop.
  if (path.includes("..") || path.includes("//") || path.startsWith("/")) return false;

  const seg = path.split("/");
  if (seg[0] !== "tickets" || seg[1] !== ticketId) return false;

  if (messageId === undefined || messageId === null) {
    if (seg.length !== 3) return false;
    return isAttachmentLeaf(seg[2], "screenshot");
  }
  if (typeof messageId !== "string" || !ID_TOKEN.test(messageId)) return false;
  if (seg.length !== 4 || seg[2] !== "replies") return false;
  return isAttachmentLeaf(seg[3], messageId);
}

/**
 * The keys only the server may set. create-ticket used to copy
 * body.context_payload onto the new row as it arrived, which let the caller
 * name the file the reader would later sign. The upload path sets both keys
 * itself once an object actually exists, so anything the caller sent under
 * these names is dropped and the rest of the context is kept untouched.
 */
export const SERVER_ONLY_PAYLOAD_KEYS = ["attachment_path", "attachment_paths"];

/**
 * A context payload with those keys removed. A non-object (a string, an
 * array, null) comes back as an empty object rather than spread into indexed
 * keys, which is what `{ ...body.context_payload }` did with a string.
 */
export function stripServerOnlyPayloadKeys(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const key of SERVER_ONLY_PAYLOAD_KEYS) delete out[key];
  return out;
}
