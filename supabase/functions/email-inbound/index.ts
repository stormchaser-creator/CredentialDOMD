/**
 * email-inbound: Resend "email.received" webhook for @credentialdomd.com.
 *
 * Four routes, decided by the local part of the address the message was sent to:
 *
 *   cme@credentialdomd.com   Certificate intake by email forwarding.
 *     Sender must match a mailbox the account has PROVED it can read: a
 *     CONFIRMED row in forwarding_addresses (the physician added the address in
 *     More > Settings > Email and opened the link sent to it), or
 *     profiles.verified_email, which only the Clerk webhook writes. The typed
 *     profiles.email is not a match and no longer routes anything. Every
 *     PDF / image / office attachment is copied into the `documents` Storage
 *     bucket at <auth_user_id>/<doc id> and a `documents` row is written with
 *     type = "cme-certificate-inbox" and no linked_to. Each one is then READ
 *     with the app's own scanner prompt on the shared Gemini key and FILED
 *     where the app would file it (see "Filing" below); one that cannot be
 *     filed stays under "From your inbox, not filed yet" with File-with-AI /
 *     link actions. The sender gets a confirmation that says where each file
 *     went. An unknown sender gets one short reply explaining how to register
 *     the address (rate-limited, never to bounces or auto-submitted mail).
 *
 *   docs@ | requests@ | packets@credentialdomd.com   Documents and requests.
 *     Same sender matching and authentication as cme@. The email is first
 *     read for what it is FOR (_shared/intakeIntent.mjs):
 *       "delivery"  a document forwarded to keep (an approval letter, a
 *                   renewed card). Every attachment is stored with
 *                   type = "email-inbox", read and filed as below, and the
 *                   physician is told where each went. No document_requests
 *                   row, no acknowledgement to anyone.
 *       "both"      a document AND an ask. The finished documents are filed
 *                   as a delivery; attachments named like a form stay with
 *                   the request; then the request flow below runs.
 *       "request"   everything below, unchanged. An email with no attachment
 *                   is always a request.
 *     A credentialer asked the physician for documents; the physician forwards
 *     that email here from a mailbox the account has proved it can read, and
 *     that forward is the last thing they type.
 *     The ORIGINAL requester (From:), subject and body are parsed out of the
 *     forwarded text (Gmail / Outlook / Apple Mail header blocks) and a
 *     `document_requests` row is written; PDF / image attachments (the
 *     requester's checklist) are stored as documents with
 *     type = "request-attachment-inbox". Then, still on arrival:
 *       (1) every asked-for item is matched against the physician's documents
 *           (_shared/requestPacket.ts) and the proposal is stored on the row
 *           (proposal, proposal_at); a matcher failure leaves it null and the
 *           request intact;
 *       (2) the physician gets a summary from docs@ ("Madeline Castorena asked
 *           for 1 item: board certificate: Board Certification (AOA). Packet
 *           ready: 1 document. Open the app and tap Approve and send");
 *       (3) the REQUESTER gets a short acknowledgement from "<Name>, <Degree>
 *           via CredentialDOMD <docs@>", reply_to the physician, threaded on
 *           their own Message-ID, when _shared/requestFlow.ts ackAllowed says
 *           so: never when the requester was not found, is one of our
 *           addresses, is the physician, the forwarder or any confirmed
 *           forwarding address, is a no-reply mailbox, or the physician
 *           turned acks off (profiles.ack_requests); never twice for one
 *           message (ack_sent_at, stamped BEFORE the send so a webhook retry
 *           after a timeout finds it); never more than ACK_PER_PROFILE_PER_DAY
 *           for one account, counted on the service-role-only ledger and not
 *           on a column the account can edit; never to an automated sender
 *           (an out-of-office reply to our own summary is not a request and
 *           gets nothing, not even a row); and never unless the forward
 *           itself carried dmarc=pass or an aligned spf+dkim pass. That last
 *           rule is stricter than the one that files a certificate: this is
 *           mail from our domain to an address the forwarded text chose, so
 *           a missing Authentication-Results header is a no here even though
 *           it is a pass for the reply to the physician. The header is read
 *           from the raw message (top-most occurrence; see authResultsFrom),
 *           never from Resend's collapsed header map: when the raw message
 *           cannot be read, nobody is acknowledged. INBOUND_AUTHSERV_IDS
 *           can pin it to the receiving MTA's authserv-id. reply_to is the
 *           address the forward came from when that is a confirmed address
 *           other than the profile email, so the credentialer keeps
 *           writing to the mailbox they were already in.
 *     In the app, Home and More > Requests show the proposal and one button,
 *     Approve and send, which send-packet-email turns into the reply.
 *
 *   contacts@ | contact@ | refs@ | reference@ | references@   Peer references.
 *     An iPhone cannot hand a contact card to a web app: iOS has no Contact
 *     Picker API and Safari ignores the Web Share Target manifest, so nothing
 *     in the share sheet can reach the app. Mail can. Contacts > the person >
 *     Share Contact > Mail > contacts@ arrives here as a .vcf, every card in
 *     it is parsed (a multi-select share carries several), and a
 *     `peer_references` row is written per person with relationship "Other"
 *     and a note saying where it came from. Same sender matching and
 *     authentication as cme@. The reply names who was added.
 *
 *   anything else (support@, hello@, whit@, privacy@, ...)   Mailbox relay.
 *     The whole message (subject prefixed "[credentialdomd.com <local>] ",
 *     original headers in the body, attachments re-attached within limits) is
 *     forwarded to FORWARD_TO with reply_to set to the original sender, so a
 *     plain reply from Eric's inbox goes back to the physician.
 *
 * Filing (cme@ and docs@ deliveries). Each kept attachment that Gemini can
 * read (PDF, JPEG, PNG, WebP, HEIC) is scanned with the app's own prompt and
 * validator (src/utils/scannerCore.js, copied to _shared/app/), with the
 * physician's degree and category names as the app sends them, on
 * app_secrets.gemini_shared_key when the account is active or an admin (the
 * rule ai-proxy applies). Every call writes one ai_usage row the way ai-proxy
 * does. _shared/intakeFiling.mjs turns the result into writes: the scan type
 * picks the section, only real columns become columns and the rest goes to
 * custom_fields past the identifier gate, an existing record of the same
 * credential is added to (empty fields filled, expiration moved only
 * forward) rather than duplicated, an "other" document goes into the
 * physician's own category (found or created with origin "uploader"), and
 * the document is linked as "<section>:<record id>" under a readable name. A
 * receipt, a CV or anything unreadable stays in the inbox and the reply says
 * so; a file that reads as a patient record is deleted, as the app does on
 * upload. A failure on one attachment leaves that one unfiled and the rest
 * carry on. A file already in Documents (same name and size, or same bytes)
 * is not stored twice: filed, it is reported as already filed; unfiled, it
 * is filed now.
 *
 * Why a webhook and not the payload: Resend's email.received event carries only
 * metadata (from, to, subject, message_id, attachment names). Body and files
 * are fetched from the Receiving API:
 *   GET https://api.resend.com/emails/receiving/:email_id
 *   GET https://api.resend.com/emails/receiving/:email_id/attachments
 * (download_url on each attachment is valid for 1 hour).
 *
 * Auth: Svix signature (svix-id / svix-timestamp / svix-signature) checked
 * against RESEND_WEBHOOK_SECRET, the signing secret shown for THIS webhook on
 * resend.com/webhooks. Deploy with --no-verify-jwt: Resend does not send a
 * Supabase JWT.
 *
 * Idempotency: inbound_emails.message_id is unique. The row is inserted before
 * any side effect; a Svix retry of a finished message returns 200 and does
 * nothing else. A failed or stale (>10 min "processing") row is re-claimed so a
 * transient error can be retried.
 *
 * Caps (all in this file, no DB config):
 *   GLOBAL_PER_10MIN         inbound messages accepted per 10 minutes (429 beyond, Resend retries later)
 *   CME_PER_SENDER_PER_HOUR  cme / docs messages per sender per hour per route (excess recorded, no reply)
 *   UNREG_REPLY_PER_DAY      "not registered" replies per sender per day per route (backscatter control)
 *   MAX_FILES / MAX_FILE_BYTES / MAX_TOTAL_BYTES  per message, both routes
 *
 * Secrets: RESEND_API_KEY (already set for the send-* functions),
 * RESEND_WEBHOOK_SECRET (new), SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto).
 * Optional: INBOUND_AUTHSERV_IDS, comma-separated authserv-ids (the token
 * Resend's MTA writes at the front of Authentication-Results) whose verdicts
 * alone may authorise the requester acknowledgement. Unset means any
 * top-most header counts.
 */

import { Webhook } from "https://esm.sh/svix@1.40.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.97.0";
import { accessWriteDecision } from "../_shared/accessWrite.mjs";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { parseVCards, isVCardAttachment, looksLikeVCardText, type VCardContact } from "../_shared/vcard.ts";
import { buildProposal, catalogueFromRows } from "../_shared/requestPacket.ts";
// replySubject is imported under another name because each route handler
// below already holds a local `replySubject` string (the physician's own
// confirmation subject); the bare name would have resolved to that string
// at the ack's call site and thrown.
import { ackAllowed, ackText, authEvidence, physicianSummaryText, replySubject as replySubjectFor, senderAuthFailure, senderPositivelyAuthenticated, type AuthEvidence, type Proposal } from "../_shared/requestFlow.ts";
// What an email is for (a request, a document to keep, or both) and where a
// kept document goes. Both pure and node-tested; the scanner prompt and its
// validator are the app's own, copied under _shared/app/ by
// scripts/sync-shared-app-modules.mjs so the two can never read a file
// differently.
import { classifyIntent, attachmentRole } from "../_shared/intakeIntent.mjs";
import { planFiling, filingTarget, scannableMime, unfiledLine, filingReplyText, sectionScope, plain as plainText, EMAIL_INBOX_DOC_TYPE, SECTION_TABLE } from "../_shared/intakeFiling.mjs";
import { scanRequestBody, validateResponse, parseModelJson, SCAN_IMAGE_TEXT, scanPdfText } from "../_shared/app/utils/scannerCore.js";
import { GEMINI_MODEL } from "../_shared/app/utils/geminiModel.js";
import { meterUsage } from "../_shared/aiPricing.ts";
// The routing decision and the rules that hand a mailbox to an account are two
// halves of one property: a mailbox routes mail only to the account that proved
// it can read it. They live in one file so they cannot drift apart, and that
// file is the one of the pair with no Deno dependency, so node can test it.

// ─── Configuration ────────────────────────────────────────────────────────────

const INBOX_DOMAIN = "credentialdomd.com";
const CME_LOCAL = "cme";
const DOCS_LOCALS = new Set(["docs", "requests", "packets"]);
// Share Contact > Mail > one of these. iOS cannot hand a contact card to a web
// app at all (no Contact Picker API, and Safari ignores the Web Share Target
// manifest), so Mail is the whole of the share sheet that can reach us.
const CONTACT_LOCALS = new Set(["contacts", "contact", "refs", "reference", "references"]);
const CONTACTS_ADDR = `contacts@${INBOX_DOMAIN}`;
const DOCS_ADDR = `docs@${INBOX_DOMAIN}`;
const FORWARD_TO = "stormchaser@elryx.com";
const FROM_ADDR = "whit@credentialdomd.com";
const FROM_CME = `CredentialDOMD <${FROM_ADDR}>`;
const FROM_DOCS = `CredentialDOMD <${DOCS_ADDR}>`;
const FROM_CONTACTS = `CredentialDOMD <${CONTACTS_ADDR}>`;
const FROM_RELAY = `CredentialDOMD Inbox <${FROM_ADDR}>`;
const APP_URL = "https://credentialdomd.com/app/";
const INBOX_DOC_TYPE = "cme-certificate-inbox";
const REQUEST_DOC_TYPE = "request-attachment-inbox";
// A document forwarded to docs@ to keep, until it is filed. Filing sets
// linked_to and puts the MIME type back in `type`, as the app's leaveInbox does.
const EMAIL_DOC_TYPE = EMAIL_INBOX_DOC_TYPE;
// Documents that arrived by email and are not yet the physician's own
// filed record. Kept out of the packet matcher's catalogue: the requester's
// checklist is stored before the proposal is built, and the CV rule matches
// any unlinked file by name, so "Provider_CV_Request_Form.pdf" was offered
// straight back to the credentialer who attached it, as the physician's CV.
const INBOX_DOC_TYPES = new Set([INBOX_DOC_TYPE, REQUEST_DOC_TYPE, EMAIL_DOC_TYPE]);
const STORAGE_BUCKET = "documents";
const MAX_REQUEST_BODY_CHARS = 20_000;   // document_requests.body_text

const GLOBAL_PER_10MIN = 120;
const CME_PER_SENDER_PER_HOUR = 20;
// Acknowledgements docs@ sends to third parties per account per day. The
// per-sender hourly cap above is keyed on the From header, which a spoofer
// picks; this one is keyed on the account the spoof landed in, which they
// cannot multiply.
const ACK_PER_PROFILE_PER_DAY = 10;
const UNREG_REPLY_PER_DAY = 1;
// How much of the raw message is read for its Authentication-Results header.
// The receiving MTA prepends that header, so it sits in the first few KB;
// the rest of the file is the body and the attachments, up to tens of MB,
// and none of it is wanted here.
const RAW_HEAD_BYTES = 256 * 1024;
const STALE_PROCESSING_MIN = 10;
const UNREG_REPLIED = "replied: not registered";   // ledger detail that marks a sent "not registered" reply
// The ledger marker ledgerAcksSince counts for the daily ack cap. Every other
// ack outcome is worded so that these two words appear in no other detail.
const ACK_SENT = "ack sent";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // matches the app's 10 MB upload cap
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;  // raw; base64 stays under Resend's 40 MB per-email limit
const MIN_INLINE_IMAGE_BYTES = 40 * 1024;  // inline images under this are signature logos, not certificates
const MAX_BODY_CHARS = 200_000;
const MAX_CONTACTS_PER_EMAIL = 25;       // a multi-select share, not a mailing list

// Reading a kept attachment. The shared Gemini key is app_secrets
// gemini_shared_key, the model is the app's own constant, and every call
// writes one ai_usage row exactly as ai-proxy does. One call may take
// SCAN_TIMEOUT_MS; all of one email's calls together may take SCAN_BUDGET_MS,
// so ten attachments cannot run the function past its wall-clock limit (a
// file the budget does not reach is kept, unfiled, and the reply says so).
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/";
const GEMINI_SECRET_NAME = "gemini_shared_key";
const SCAN_TIMEOUT_MS = 45_000;
const SCAN_BUDGET_MS = 100_000;
const SCAN_CONCURRENCY = 3;
// Same-size files compared byte for byte to find a duplicate that was renamed
// when it was filed. More candidates than this is not a duplicate check any more.
const MAX_CONTENT_COMPARES = 3;

// ─── Env / clients ────────────────────────────────────────────────────────────

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_API = (Deno.env.get("RESEND_API_BASE") ?? "https://api.resend.com").replace(/\/$/, ""); // override only for local tests
const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";
// Authserv-ids whose Authentication-Results verdicts may authorise the
// requester acknowledgement (see authResultsFrom). Empty when unset, and then
// the top-most header counts whoever wrote it.
const INBOUND_AUTHSERV_IDS = (Deno.env.get("INBOUND_AUTHSERV_IDS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
if (!WEBHOOK_SECRET) console.error("RESEND_WEBHOOK_SECRET is not set; every request will be rejected.");
if (!RESEND_API_KEY) console.error("RESEND_API_KEY is not set; nothing can be fetched or sent.");

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReceivedEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    created_at?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    received_for?: string[];
    message_id?: string;
    subject?: string;
    attachments?: { id: string; filename?: string; content_type?: string; content_disposition?: string | null; content_id?: string | null }[];
  };
}

interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  subject?: string | null;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  message_id?: string;
  created_at?: string;
  attachments?: { id: string; filename?: string; content_type?: string; size?: number }[];
  // The full RFC 5322 message. Resend's docs (read 2026-09-11) return it as
  // { download_url, expires_at }, a signed URL with no query parameter to
  // inline it; the string form is accepted in case that changes.
  raw?: string | { download_url?: string | null; expires_at?: string | null } | null;
}

interface ReceivedAttachment {
  id: string;
  filename?: string;
  size?: number;
  content_type?: string;
  content_disposition?: string | null;
  content_id?: string | null;
  download_url?: string;
  expires_at?: string;
}

interface Downloaded {
  filename: string;
  content_type: string;
  content_id: string | null;
  inline: boolean;
  bytes: Uint8Array;
}

interface LedgerRow {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

type Route = "cme" | "docs" | "contacts" | "forward";

interface MatchedProfile {
  id: string;
  auth_user_id: string;
  email: string | null;          // profiles.email: displayed and replied to, never matched on
  access_status: string | null;
  verified_email: string | null; // the identity provider's verified mailbox, or null
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** "Name <a@b.c>" | "a@b.c" -> "a@b.c" (lowercased). */
function bareAddress(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  const m = s.match(/<([^<>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function localPart(addr: string): string {
  const i = addr.indexOf("@");
  return i > 0 ? addr.slice(0, i) : addr;
}

function domainPart(addr: string): string {
  const i = addr.indexOf("@");
  return i > 0 ? addr.slice(i + 1) : "";
}

/** The @credentialdomd.com address this message was routed on. */
function pickOurAddress(ev: NonNullable<ReceivedEvent["data"]>): string {
  const candidates = [...(ev.to ?? []), ...(ev.cc ?? []), ...(ev.received_for ?? []), ...(ev.bcc ?? [])]
    .map(bareAddress)
    .filter(Boolean);
  const ours = candidates.find((a) => {
    const d = domainPart(a);
    return d === INBOX_DOMAIN || d.endsWith(`.${INBOX_DOMAIN}`);
  });
  return ours ?? candidates[0] ?? "";
}

/**
 * ilike pattern with every wildcard escaped, so an address is matched literally.
 *
 * Three characters, not two. % and _ are SQL's; * is PostgREST's, which
 * rewrites it to % on the way to the ilike operator. Leaving * unescaped made
 * every lookup below a prefix search over addresses. Kept identical to
 * ilikeLiteral in supabase/functions/forwarding-address/lib.ts.
 */
function ilikeLiteral(s: string): string {
  return s.replace(/[\\%_*]/g, (c) => `\\${c}`);
}

function isAutomatedSender(from: string, headers: Record<string, string>): boolean {
  const l = localPart(from);
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce|bounces|noreply)/i.test(l)) return true;
  const h = lowerKeys(headers);
  const auto = (h["auto-submitted"] ?? "").toLowerCase();
  if (auto && auto !== "no") return true;
  const prec = (h["precedence"] ?? "").toLowerCase();
  if (["bulk", "list", "junk", "auto_reply"].includes(prec)) return true;
  if (h["x-auto-response-suppress"] || h["list-id"] || h["list-unsubscribe"]) return true;
  return false;
}

function lowerKeys(o: Record<string, string> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) out[k.toLowerCase()] = String(v ?? "");
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeFilename(name: string | undefined, fallback: string): string {
  // deno-lint-ignore no-control-regex
  const n = String(name ?? "").trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 180);
  return n || fallback;
}

/** Header-safe display text: no line breaks, quotes or angle brackets. Same as send-packet-email. */
function cleanHeaderText(s: string | null | undefined, max = 80): string {
  return String(s ?? "").replace(/[\r\n"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The From header the packet itself goes out under, so the acknowledgement
 * and the documents that follow it come from the same name. Quoted because
 * the display name contains a comma. Kept identical to send-packet-email.
 */
function fromHeader(name: string, degree: string): string {
  const display = name ? `${name}${degree ? `, ${degree}` : ""} via CredentialDOMD` : "CredentialDOMD";
  return `"${display}" <${DOCS_ADDR}>`;
}

function isCertificateType(contentType: string, filename: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct === "application/pdf" || ct.startsWith("image/")) return true;
  // Some clients send application/octet-stream; trust the extension then.
  return /\.(pdf|jpe?g|png|gif|webp|heic|heif|tiff?|bmp)$/i.test(filename);
}

function guessMime(filename: string, fallback: string): string {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv", txt: "text/plain", rtf: "application/rtf",
  };
  return map[ext] ?? fallback;
}

// ─── Resend API ───────────────────────────────────────────────────────────────

const resendHeaders = { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" };

async function getReceivedEmail(emailId: string, htmlFormat: "cid" | "data_uri" = "cid"): Promise<ReceivedEmail> {
  const r = await fetch(`${RESEND_API}/emails/receiving/${encodeURIComponent(emailId)}?html_format=${htmlFormat}`, { headers: resendHeaders });
  if (!r.ok) throw new Error(`retrieve received email ${emailId}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return await r.json() as ReceivedEmail;
}

async function listAttachments(emailId: string): Promise<ReceivedAttachment[]> {
  const r = await fetch(`${RESEND_API}/emails/receiving/${encodeURIComponent(emailId)}/attachments`, { headers: resendHeaders });
  if (!r.ok) throw new Error(`list attachments ${emailId}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const body = await r.json() as { data?: ReceivedAttachment[] };
  return body.data ?? [];
}

/**
 * Download attachments within the caps. `accept` decides which metadata rows
 * are even attempted. Returns the files kept plus the number skipped for size
 * or count.
 */
async function downloadAttachments(
  emailId: string,
  accept: (a: ReceivedAttachment) => boolean,
  listed?: ReceivedAttachment[],
): Promise<{ files: Downloaded[]; skipped: number; total: number }> {
  const all = listed ?? await listAttachments(emailId);
  const wanted = all.filter(accept);
  const files: Downloaded[] = [];
  let skipped = 0;
  let totalBytes = 0;
  for (const a of wanted) {
    if (files.length >= MAX_FILES) { skipped++; continue; }
    if ((a.size ?? 0) > MAX_FILE_BYTES) { skipped++; continue; }
    if (!a.download_url) { skipped++; continue; }
    let bytes: Uint8Array;
    try {
      const r = await fetch(a.download_url);
      if (!r.ok) { skipped++; continue; }
      bytes = new Uint8Array(await r.arrayBuffer());
    } catch {
      skipped++;
      continue;
    }
    if (bytes.byteLength > MAX_FILE_BYTES || totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) { skipped++; continue; }
    totalBytes += bytes.byteLength;
    const filename = safeFilename(a.filename, `attachment-${files.length + 1}`);
    const ct = (a.content_type || "").toLowerCase() || guessMime(filename, "application/octet-stream");
    files.push({
      filename,
      content_type: ct === "application/octet-stream" ? guessMime(filename, ct) : ct,
      content_id: a.content_id ? String(a.content_id).replace(/^<|>$/g, "") : null,
      inline: (a.content_disposition ?? "").toLowerCase() === "inline",
      bytes,
    });
  }
  return { files, skipped, total: wanted.length };
}

async function sendEmail(payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: string }> {
  const r = await fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: resendHeaders,
    body: JSON.stringify(payload),
  });
  const body = await r.text();
  if (!r.ok) console.error("resend send failed:", r.status, body.slice(0, 300));
  return { ok: r.ok, status: r.status, body };
}

// ─── Ledger (inbound_emails) ──────────────────────────────────────────────────

const PG_UNIQUE_VIOLATION = "23505";

/**
 * Claim the message. Returns the ledger row id, or null when this message has
 * already been handled (finished, or another attempt is in flight).
 */
async function claim(row: {
  message_id: string; email_id: string; from_addr: string; to_addr: string; subject: string; route: Route;
}): Promise<string | null> {
  const { data, error } = await db.from("inbound_emails").insert(row).select("id").single();
  if (!error && data) return (data as { id: string }).id;
  if (error && error.code !== PG_UNIQUE_VIOLATION) throw new Error(`ledger insert: ${error.message}`);

  // Duplicate delivery. Re-claim only a failed or stale attempt.
  const { data: existing } = await db.from("inbound_emails")
    .select("id, status, created_at, updated_at").eq("message_id", row.message_id).maybeSingle();
  const ex = existing as LedgerRow | null;
  if (!ex) return null;
  const staleBefore = Date.now() - STALE_PROCESSING_MIN * 60 * 1000;
  const stale = ex.status === "processing" && new Date(ex.created_at).getTime() < staleBefore;
  if (ex.status !== "failed" && !stale) return null;
  const { data: re } = await db.from("inbound_emails")
    .update({ status: "processing", detail: null, updated_at: new Date().toISOString() })
    .eq("id", ex.id).in("status", ["failed", "processing"]).eq("updated_at", ex.updated_at).select("id").maybeSingle();
  return re ? (re as { id: string }).id : null;
}

async function finish(id: string, status: "done" | "failed" | "unregistered" | "rate_limited", detail: string, extra: Record<string, unknown> = {}) {
  const { error } = await db.from("inbound_emails")
    .update({ status, detail: detail.slice(0, 500), updated_at: new Date().toISOString(), ...extra })
    .eq("id", id);
  if (error) console.error("ledger update failed:", error.message);
}

// deno-lint-ignore no-explicit-any
type AnyQuery = any;
async function countSince(minutes: number, apply: (q: AnyQuery) => AnyQuery = (q) => q): Promise<number> {
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const base = db.from("inbound_emails").select("id", { count: "exact", head: true }).gte("created_at", since);
  const { count, error } = await apply(base);
  if (error) throw new Error(`ledger count: ${error.message}`);
  return count ?? 0;
}

// ─── Shared by the physician routes (cme@, docs@) ─────────────────────────────

/**
 * Sender -> account. This function decides whose account receives a forwarded
 * credentialing document, attachments and all, so what counts as a match is
 * the whole security question.
 *
 * PROVEN ONLY. Two lookups feed the decision and both are evidence that the
 * account can READ the mailbox:
 *
 *   1. A confirmed row in forwarding_addresses. Somebody opened a link sent to
 *      that mailbox and pressed Confirm.
 *   2. profiles.verified_email. The identity provider says the address is
 *      verified for this account; only clerk-webhook writes the column, and
 *      migration 20260915d locks it against every user token.
 *
 * profiles.email was the second pass until 2026-09-15 and is now read for
 * nothing here. Ordering forwarding_addresses ahead of it (2026-09-03) fixed
 * only the collision case. The rest stayed open: the unique index on
 * lower(profiles.email) is PARTIAL, so any address no profile currently held
 * was free to type into your own Settings, and typing it was enough. The
 * genuine physician later forwards a real credential document from that
 * mailbox, SPF, DKIM and DMARC all pass because the mail IS genuine, this
 * function picks the account that typed the address, storeAsDocuments writes
 * the file under that account's auth_user_id, and documents_owner RLS hands
 * the victim's document to the person who typed. That is disclosure, not a
 * misfile, and sender authentication cannot help: it proves the mailbox sent
 * the mail, never that the account we chose owns the mailbox.
 *
 * No match returns null, which is the unregistered reply. Failing closed is
 * the point: there is no third pass that guesses. Two accounts both holding
 * proof is also null, for the same reason and more so: see inboundMatch.
 *
 * Both lookups filter ilike results down to an exact lowercased match, because
 * ilike folds more than case and this decides where a document lands. The
 * choosing itself is inboundMatch in the forwarding-address lib, which
 * is pure so scripts/inbound-routing.test.mjs can run every case in node, and
 * which lives beside the claim rules so the two cannot drift apart.
 */
type ProfileLookupRow = {
  id: string;
  auth_user_id: string | null;
  email: string | null;
  access_status: string | null;
  verified_email: string | null;
  deleted_at: string | null;
};

// deleted_at is selected so the read below can refuse a tombstoned profile.
// delete-account revokes the mailbox claim terminally, so this should never
// fire; it is here because "should never" is how verified_email was missed by
// the deletion path in the first place.
const PROFILE_COLUMNS = "id, auth_user_id, email, access_status, verified_email, deleted_at";

async function matchProfile(from: string): Promise<MatchedProfile | null> {
  const address = bareAddress(from);
  if (!address) return null;

  // ONE row, by primary key. This used to load two candidate sets, a confirmed
  // forwarding_addresses set and a profiles.verified_email set, and then decide
  // between them; when they disagreed it refused, which was correct and was
  // also the symptom. The disagreement itself was reachable: the two writers
  // that maintain the invariant checked each other across separate
  // transactions with no shared lock and no index spanning the two tables, so
  // an account could end up holding each kind of proof and every forward from
  // that mailbox was refused for BOTH of them, permanently and silently.
  //
  // public.mailbox_claims has the address as its PRIMARY KEY, so "two accounts
  // hold this mailbox" is not a state that can exist. There is nothing here to
  // adjudicate any more: the row says who, or there is no row.
  const { data, error } = await db.from("mailbox_claims")
    .select("address, profile_id, proof, terminal_at")
    .eq("address", address)
    .maybeSingle();
  if (error) throw new Error(`mailbox claim lookup: ${error.message}`);

  const claim = (data ?? null) as { profile_id: string | null; proof: string | null; terminal_at: string | null } | null;
  // No row, a revoked row (profile_id null), or a terminal one: nobody routes
  // this address. The sender gets the unregistered reply, which is the only
  // safe answer and the one a person can act on.
  if (!claim || !claim.profile_id || claim.terminal_at) return null;

  const { data: row, error: pErr } = await db.from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", claim.profile_id)
    // Belt and braces: delete-account revokes the claim terminally, so a
    // tombstoned profile should never be reachable from here at all.
    .is("deleted_at", null)
    .maybeSingle();
  if (pErr) throw new Error(`profile lookup: ${pErr.message}`);
  const p = (row ?? null) as ProfileLookupRow | null;
  if (!p) {
    console.warn(`inbound: claim on an address points at profile ${claim.profile_id}, which is gone or deleted. Refusing.`);
    return null;
  }
  // storeAsDocuments writes to `${auth_user_id}/${docId}`; without one there
  // is no Storage prefix to write into.
  if (!p.auth_user_id || !String(p.auth_user_id).trim()) return null;

  return {
    id: p.id,
    auth_user_id: p.auth_user_id as string,
    email: p.email,
    access_status: p.access_status,
    verified_email: p.verified_email,
  };
}

// Refuse recognized intake before retrieving content, attachments or sending
// any reply. Support forwarding does not call this product-write guard.
async function intakeRefusal(profile: MatchedProfile | null, ledgerId: string, route: string): Promise<Response | null> {
  if (!profile) return null;
  const access = await accessWriteDecision(db, profile.id, profile.auth_user_id, "credential");
  if (access.allowed) return null;
  if (access.status === 503) throw new Error("access policy unavailable");
  await finish(ledgerId, "done", access.error, { profile_id: profile.id });
  return json({ ok: true, route, result: access.error });
}

async function assertIntakeWrite(profile: MatchedProfile, scope: "credential" | "practice" = "credential") {
  const access = await accessWriteDecision(db, profile.id, profile.auth_user_id, scope);
  if (!access.allowed) throw new Error(access.error);
}

function replyThreading(messageId: string): Record<string, string> {
  const mid = messageId ? (messageId.startsWith("<") ? messageId : `<${messageId}>`) : "";
  return mid ? { "In-Reply-To": mid, "References": mid } : {};
}

/**
 * Unknown sender. One reply per sender per day per route, never to automated
 * mail (bounces, list mail, auto-replies), so a forged From cannot use the
 * address as a reflector.
 */
async function replyUnregistered(
  ledgerId: string, route: Route, email: ReceivedEmail, from: string, fromHeader: string,
  replySubject: string, replyHeaders: Record<string, string>, text: string,
) {
  if (isAutomatedSender(from, lowerKeys(email.headers))) {
    await finish(ledgerId, "unregistered", "automated sender, no reply");
    return json({ ok: true, route, result: "unregistered", replied: false });
  }
  const priorReplies = await countSince(
    24 * 60,
    (q) => q.eq("from_addr", from).eq("route", route).eq("status", "unregistered").neq("id", ledgerId).eq("detail", UNREG_REPLIED),
  );
  if (priorReplies >= UNREG_REPLY_PER_DAY) {
    await finish(ledgerId, "unregistered", "no reply, already replied today");
    return json({ ok: true, route, result: "unregistered", replied: false });
  }
  const r = await sendEmail({ from: fromHeader, to: [from], subject: replySubject, headers: replyHeaders, text });
  await finish(ledgerId, "unregistered", r.ok ? UNREG_REPLIED : `reply failed: ${r.status}`);
  return json({ ok: true, route, result: "unregistered", replied: r.ok });
}

/**
 * Authentication-Results from Resend's collapsed header map, arc- as the
 * fallback. Duplicate headers collapse to one value in that map and which
 * occurrence wins is undocumented, so this is evidence enough to refuse an
 * explicit failure (a sender gains nothing by forging a failure) and not
 * enough to authorise mail to a third party; see authResultsFrom for that.
 */
function authResultsFromHeaders(email: ReceivedEmail): string {
  const h = lowerKeys(email.headers);
  return h["authentication-results"] || h["arc-authentication-results"] || "";
}

/**
 * The first `max` bytes of a URL as text, or null when it could not be read.
 * Asks for a Range; a server that ignores it is cut off client-side after
 * `max` bytes and the stream cancelled, so a 20 MB raw file costs 256 KB.
 */
async function fetchHead(url: string, max: number): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { Range: `bytes=0-${max - 1}` } });
    if (!r.ok || !r.body) return null;
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    while (got < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* already closed */ }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(out.subarray(0, max));
  } catch (err) {
    console.error(`raw head fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The authentication evidence for the docs@ route, in two parts that are
 * never joined (see authEvidence in _shared/requestFlow.ts).
 *
 * `positive` is what the acknowledgement decision may trust. It used to be
 * hdrs["authentication-results"] from Resend's header map. That map
 * collapses duplicate headers into one string, and nothing says which
 * occurrence survives, so a sender who typed their own
 * "Authentication-Results: mx.resend.com; dmarc=pass" into a message could
 * have been the one that was read, and docs@ would have mailed a stranger
 * under the physician's name on the strength of it. The raw message keeps
 * every header in order and the receiving MTA prepends its own above all of
 * them, so the TOP-MOST header is the MTA's; topAuthenticationResults
 * returns that one. Resend serves raw as a signed download_url (no inline
 * form and no parameter for one, per its docs), so the head of that file is
 * fetched; a string `raw` is parsed directly should the API ever inline it.
 * A raw message with no Authentication-Results at all yields "", which the
 * ack reads as not authenticated. When raw is absent from the response or
 * cannot be read, positive is null and the ack is refused: for a while the
 * header map stood in here, which put the forgeable value back on the very
 * path it had been removed from, on every expired signed URL and on every
 * response that simply lacked the field.
 *
 * `negative` is the header map, ARC included. It refuses an explicit failure
 * (a sender gains nothing by forging one) and authorises nothing.
 */
async function authResultsFrom(email: ReceivedEmail): Promise<AuthEvidence> {
  let raw: string | null = null;
  if (typeof email.raw === "string") {
    raw = email.raw;
  } else if (email.raw && typeof email.raw === "object" && email.raw.download_url) {
    raw = await fetchHead(String(email.raw.download_url), RAW_HEAD_BYTES);
  }
  const evidence = authEvidence(raw, email.headers);
  if (evidence.positive === null) console.error(`raw unavailable for ${email.id}; acknowledgement refused`);
  return evidence;
}

// senderAuthFailure, the filing check (an explicit dmarc=fail, or spf and
// dkim both failing, drops the message; a missing header passes), lives in
// _shared/requestFlow.ts beside the acknowledgement's gate so that both read
// their verdicts from the same clause parser and the test can run it. It
// takes one header value (authResultsFromHeaders, or either side of
// authResultsFrom) and returns the offending text, or "" when ok.

/** Attachments worth keeping: PDFs always; images unless they are small inline logos. */
function acceptCertificateLike(a: ReceivedAttachment): boolean {
  const name = safeFilename(a.filename, "");
  const ct = (a.content_type ?? "").toLowerCase();
  if (!isCertificateType(ct, name)) return false;
  const inline = (a.content_disposition ?? "").toLowerCase() === "inline";
  if (inline && ct.startsWith("image/") && (a.size ?? 0) < MIN_INLINE_IMAGE_BYTES) return false;
  return true;
}

// The Word, Excel, CSV, text and RTF files the app's own upload accepts
// (src/utils/officeText.js UPLOAD_ACCEPT). They are kept and left for File
// with AI in the app, which can read them; the server cannot.
const OFFICE_EXT = /\.(docx?|xlsx?|csv|txt|rtf)$/i;
const OFFICE_TYPES = new Set([
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv", "application/csv", "text/plain", "application/rtf", "text/rtf",
]);

/**
 * Everything a physician could mean to keep: the certificate-like files above
 * plus the office documents the app accepts. A forwarded file is never
 * refused for its format when the app itself would take it; a calendar
 * invite, a signature (.p7s) or an archive still is.
 */
function acceptKeepable(a: ReceivedAttachment): boolean {
  if (acceptCertificateLike(a)) return true;
  const name = safeFilename(a.filename, "");
  const ct = (a.content_type ?? "").toLowerCase();
  if ((a.content_disposition ?? "").toLowerCase() === "inline" && !name) return false;
  return OFFICE_EXT.test(name) || OFFICE_TYPES.has(ct);
}

/**
 * The sentence for attachments that were not kept at all (an archive, an
 * attached .eml, a calendar invite), so a file is never dropped without the
 * physician hearing about it. Inline images and S/MIME signatures are mail
 * furniture, not documents, and are not mentioned.
 */
function notKeptNote(listed: ReceivedAttachment[]): string {
  const names = listed
    .filter((a) => !acceptKeepable(a))
    .filter((a) => (a.content_disposition ?? "").toLowerCase() !== "inline")
    .map((a) => safeFilename(a.filename, ""))
    .filter((n) => n && !/\.(p7s|p7m|p7c)$/i.test(n));
  if (!names.length) return "";
  const list = names.slice(0, 5).join(", ") + (names.length > 5 ? `, and ${names.length - 5} more` : "");
  return `Not kept: ${list}. Only PDFs, photos and Word, Excel or text files are saved; forward the document itself as one of those.`;
}

/** A documents row this user already has, as the dedupe reads it. */
interface ExistingDoc {
  id: string;
  name: string;
  size_bytes: number | null;
  linked_to: string | null;
  type: string | null;
  mime_type: string | null;
  storage_path: string | null;
}

/** One attachment after storeAsDocuments: the row it now is, new or already there. */
interface StoredItem {
  file: Downloaded;
  docId: string;
  existing: ExistingDoc | null;   // set when the file was already in Documents
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

/**
 * Copy downloaded files into the physician's Documents (Storage + documents
 * row with the given type, no linked_to). A file this user already has is not
 * stored again: same name and size, the app's rule, or, since email filing
 * renames a document to what it is, the same size and the same bytes. The
 * row it matched comes back in `items` so a delivery can still file it (a
 * letter forwarded before filing existed sits unfiled in the inbox until it
 * is sent again).
 */
async function storeAsDocuments(profile: MatchedProfile, files: Downloaded[], docType: string) {
  const known: ExistingDoc[] = [];
  if (files.length > 0) {
    const sizes = [...new Set(files.map((f) => f.bytes.byteLength))];
    const { data: existingDocs } = await db.from("documents")
      .select("id, name, size_bytes, linked_to, type, mime_type, storage_path").eq("user_id", profile.id).in("size_bytes", sizes);
    known.push(...((existingDocs ?? []) as ExistingDoc[]));
  }
  // Files stored earlier in this same email, compared from memory.
  const fresh: { bytes: Uint8Array; row: ExistingDoc }[] = [];

  const findDuplicate = async (f: Downloaded): Promise<ExistingDoc | null> => {
    const len = f.bytes.byteLength;
    const byName = known.find((d) => d.name === f.filename && d.size_bytes === len);
    if (byName) return byName;
    const sameNow = fresh.find((x) => sameBytes(x.bytes, f.bytes));
    if (sameNow) return sameNow.row;
    const candidates = known.filter((d) => d.size_bytes === len && d.storage_path).slice(0, MAX_CONTENT_COMPARES);
    for (const c of candidates) {
      try {
        const { data } = await db.storage.from(STORAGE_BUCKET).download(String(c.storage_path));
        if (data && sameBytes(new Uint8Array(await data.arrayBuffer()), f.bytes)) return c;
      } catch { /* unreadable: not a proven duplicate */ }
    }
    return null;
  };

  const now = new Date().toISOString();
  const docIds: string[] = [];
  const items: StoredItem[] = [];
  let stored = 0;
  let duplicates = 0;
  let failed = 0;
  for (const f of files) {
    const dup = await findDuplicate(f);
    if (dup) { duplicates++; items.push({ file: f, docId: dup.id, existing: dup }); continue; }
    const docId = crypto.randomUUID();
    const path = `${profile.auth_user_id}/${docId}`; // app: documentStoragePath(docId) = <clerk sub>/<doc id>
    await assertIntakeWrite(profile);
    const up = await db.storage.from(STORAGE_BUCKET).upload(path, f.bytes, { contentType: f.content_type, upsert: false });
    if (up.error) {
      console.error(`storage upload failed for ${path}: ${up.error.message}`);
      failed++;
      continue;
    }
    const { error: dErr } = await db.from("documents").insert({
      id: docId,
      user_id: profile.id,
      name: f.filename,
      mime_type: f.content_type,
      size_bytes: f.bytes.byteLength,
      size: f.bytes.byteLength,
      storage_path: path,
      linked_to: null,
      uploaded_at: now,
      created_at: now,
      updated_at: now,
      type: docType,
    });
    if (dErr) {
      console.error(`documents insert failed for ${docId}: ${dErr.message}`);
      await db.storage.from(STORAGE_BUCKET).remove([path]).catch(() => {});
      failed++;
      continue;
    }
    const row: ExistingDoc = { id: docId, name: f.filename, size_bytes: f.bytes.byteLength, linked_to: null, type: docType, mime_type: f.content_type, storage_path: path };
    known.push(row);
    fresh.push({ bytes: f.bytes, row });
    docIds.push(docId);
    items.push({ file: f, docId, existing: null });
    stored++;
  }
  return { stored, duplicates, failed, docIds, items };
}

// ─── Reading and filing a kept attachment ─────────────────────────────────────

/** What the scanner is told about this physician, and whether it may run on the shared key. */
interface ScanContext {
  degree: string;           // "DO" | "MD" | "" as the app passes it
  categoryNames: string[];  // live custom categories, so a second badge files where the first went
  key: string;              // the shared Gemini key, or "" when it may not be used
  why: string;              // why the key is "" (for the ledger), else ""
  deadline: number;         // epoch ms after which no new scan starts
}

/**
 * The shared key is ai-proxy's, and so is the rule for using it: an active
 * account or an admin. Anything else still has its files kept, unfiled, with
 * File with AI waiting in the app.
 */
async function scanContext(profile: MatchedProfile): Promise<ScanContext> {
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const [prof, admin, cats, secret] = await Promise.all([
    db.from("profiles").select("degree_type, access_status").eq("id", profile.id).maybeSingle(),
    db.from("app_admins").select("profile_id").eq("profile_id", profile.id).maybeSingle(),
    db.from("custom_categories").select("name, archived_at").eq("user_id", profile.id),
    db.from("app_secrets").select("value").eq("name", GEMINI_SECRET_NAME).maybeSingle(),
  ]);
  const p = (prof.data ?? {}) as { degree_type?: string | null; access_status?: string | null };
  const degree = ["DO", "MD"].includes(String(p.degree_type ?? "")) ? String(p.degree_type) : "";
  const categoryNames = ((cats.data ?? []) as { name: string | null; archived_at: string | null }[])
    .filter((c) => !c.archived_at && c.name).map((c) => String(c.name));
  const active = p.access_status === "active" || Boolean(admin.data);
  const key = String((secret.data as { value?: string } | null)?.value ?? "").trim();
  if (!active) return { degree, categoryNames, key: "", why: "account not active", deadline };
  if (!key) return { degree, categoryNames, key: "", why: "shared key not configured", deadline };
  return { degree, categoryNames, key, why: "", deadline };
}

/** ai-proxy's prompt_chars: the text parts of the request, never the file. */
function promptChars(body: unknown): number {
  let n = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string") n += o.text.length;
      for (const k of ["contents", "parts", "systemInstruction", "system_instruction"]) {
        if (k in o) walk(o[k], depth + 1);
      }
    }
  };
  walk(body, 0);
  return Math.min(n, 2_000_000_000);
}

/** One ai_usage row, as ai-proxy writes it. A logging failure never stops the filing. */
async function logAiUsage(profileId: string, row: Record<string, unknown>) {
  try {
    const { error } = await db.from("ai_usage").insert({ user_id: profileId, ...row });
    if (error) console.error(`ai_usage insert failed: ${error.message}`);
  } catch { /* ignore */ }
}

// A scan result is loosely typed JSON from the model, checked by validateResponse.
// deno-lint-ignore no-explicit-any
type Scan = any;

/**
 * Read one attachment with the app's scanner prompt and validator, on the
 * shared key. Returns the validated result, or null with the reason. Never
 * throws, and never logs a fetch error's text: it carries the URL, and the
 * URL carries the key.
 */
async function scanAttachment(profileId: string, f: Downloaded, ctx: ScanContext): Promise<{ scan: Scan | null; why: string }> {
  if (!ctx.key) return { scan: null, why: ctx.why || "no key" };
  const mime = f.content_type === "image/jpg" ? "image/jpeg" : f.content_type;
  if (!scannableMime(mime)) return { scan: null, why: `not readable here (${mime})` };
  const remaining = ctx.deadline - Date.now();
  if (remaining < 5_000) return { scan: null, why: "time budget spent" };

  const parts = [
    { inlineData: { mimeType: mime, data: encodeBase64(f.bytes) } },
    { text: mime === "application/pdf" ? scanPdfText(ctx.degree) : SCAN_IMAGE_TEXT },
  ];
  const body = scanRequestBody({ degreeType: ctx.degree, categories: ctx.categoryNames, parts });
  const path = `models/${GEMINI_MODEL}:generateContent`;
  const chars = promptChars(body);
  const startedAt = new Date();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.min(SCAN_TIMEOUT_MS, remaining));
  let status: number | null = null;
  let ok = false;
  let text = "";
  let type = "application/json";
  try {
    const r = await fetch(`${GEMINI_BASE}${path}?key=${encodeURIComponent(ctx.key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    status = r.status;
    ok = r.ok;
    type = r.headers.get("content-type") || "application/json";
    text = await r.text();
  } catch {
    await logAiUsage(profileId, { path, ok: false, status, prompt_chars: chars, provider: "gemini", model: GEMINI_MODEL });
    return { scan: null, why: abort.signal.aborted ? "scan timed out" : "AI service unreachable" };
  } finally {
    clearTimeout(timer);
  }
  let parsedBody: unknown = null;
  if (/json/i.test(type)) { try { parsedBody = JSON.parse(text); } catch { parsedBody = null; } }
  await logAiUsage(profileId, {
    path, ok, status, prompt_chars: chars, provider: "gemini",
    ...meterUsage("gemini", GEMINI_MODEL, parsedBody, startedAt),
  });
  if (!ok) return { scan: null, why: `AI service answered ${status}` };
  try {
    const result = validateResponse(parseModelJson(parsedBody));
    return result ? { scan: result, why: "" } : { scan: null, why: "no document type in the reply" };
  } catch (err) {
    return { scan: null, why: err instanceof Error ? err.message.slice(0, 120) : "unreadable reply" };
  }
}

/** What happened to one kept attachment, for the reply and the ledger. */
interface FilingResult {
  docId: string;
  outcome: "created" | "updated" | "linked" | "unfiled" | "removed" | "already";
  lines: string[];
}

/** Scan every item that needs it, a few at a time, in the order given. */
async function scanAll(profileId: string, items: StoredItem[], ctx: ScanContext): Promise<{ scan: Scan | null; why: string }[]> {
  const out: { scan: Scan | null; why: string }[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      out[i] = it.existing?.linked_to ? { scan: null, why: "already filed" } : await scanAttachment(profileId, it.file, ctx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, worker));
  return out;
}

/**
 * File each stored attachment where the app would: read it, pick the section,
 * match an existing record or create one, link the document. One at a time,
 * so two copies of the same credential in one email match instead of
 * duplicating. A failure on one leaves THAT document unfiled in the inbox and
 * the rest carry on; nothing is ever dropped except a file that reads as a
 * patient record, which the app deletes on upload too.
 */
async function fileDocuments(profile: MatchedProfile, items: StoredItem[], ctx: ScanContext): Promise<FilingResult[]> {
  const scans = await scanAll(profile.id, items, ctx);
  const results: FilingResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const name = plainText(it.file.filename, 120) || "document";
    if (it.existing?.linked_to) {
      results.push({ docId: it.docId, outcome: "already", lines: [`Already filed: ${plainText(it.existing.name, 120) || name}`] });
      continue;
    }
    const { scan, why } = scans[i] ?? { scan: null, why: "not scanned" };
    const mimeType = it.existing?.mime_type || it.file.content_type;
    if (!scan) {
      if (why) console.log(`inbound: ${it.docId} left unfiled: ${why}`);
      results.push({ docId: it.docId, outcome: "unfiled", lines: [unfiledLine(name, "unknown", null)] });
      continue;
    }
    try {
      const target = filingTarget(scan);
      let rows: unknown[] = [];
      let categories: unknown[] = [];
      if (target.kind === "section") {
        const { data, error } = await db.from(SECTION_TABLE[target.section as keyof typeof SECTION_TABLE]).select("*").eq("user_id", profile.id);
        if (error) throw new Error(`${target.section}: ${error.message}`);
        rows = data ?? [];
      } else if (target.kind === "custom") {
        const [recs, cats] = await Promise.all([
          db.from("custom_records").select("*").eq("user_id", profile.id),
          db.from("custom_categories").select("*").eq("user_id", profile.id),
        ]);
        if (recs.error) throw new Error(`custom_records: ${recs.error.message}`);
        if (cats.error) throw new Error(`custom_categories: ${cats.error.message}`);
        rows = recs.data ?? [];
        categories = cats.data ?? [];
      }
      const now = new Date().toISOString();
      const plan = planFiling({
        scan, docId: it.docId, fileName: it.file.filename, mimeType, userId: profile.id,
        rows, categories, now, newId: () => crypto.randomUUID(),
      });

      if (plan.outcome === "removed" && it.existing) {
        // Deleting is for a file this email just stored, as the app deletes an
        // upload it has just screened. A document that was already in
        // Documents is the physician's to judge, so it stays, unfiled.
        results.push({ docId: it.docId, outcome: "unfiled", lines: [`Not filed: ${name} reads like a patient record. It was already in your Documents; open it in the app and delete it if it is one.`] });
        continue;
      }
      if (plan.outcome === "removed") {
        await assertIntakeWrite(profile);
        const path = it.existing?.storage_path || `${profile.auth_user_id}/${it.docId}`;
        const { error: rmDocErr } = await db.from("documents").delete().eq("id", it.docId).eq("user_id", profile.id);
        if (rmDocErr) throw new Error(`documents delete: ${rmDocErr.message}`);
        await db.storage.from(STORAGE_BUCKET).remove([path]).catch(() => {});
        results.push({ docId: it.docId, outcome: "removed", lines: plan.lines });
        continue;
      }

      // A contract is Practice scope, and so is the document once it is
      // linked to one; everything else here is Credential.
      const scope = sectionScope(plan.section) as "credential" | "practice";
      for (const w of plan.writes) {
        await assertIntakeWrite(profile, scope);
        const { error } = w.op === "insert"
          ? await db.from(w.table).insert(w.row)
          : await db.from(w.table).update(w.row).eq("id", w.id).eq("user_id", profile.id);
        if (error) throw new Error(`${w.table} ${w.op}: ${error.message}`);
      }
      if (plan.document) {
        await assertIntakeWrite(profile, plan.document.linked_to ? scope : "credential");
        // Only an unlinked row is touched, so a webhook retry that races a
        // finished attempt, or a physician who filed it in the app meanwhile,
        // never has a link moved underneath them.
        const { error } = await db.from("documents")
          .update({ ...plan.document, updated_at: now }).eq("id", it.docId).eq("user_id", profile.id).is("linked_to", null);
        if (error) throw new Error(`documents link: ${error.message}`);
      }
      results.push({ docId: it.docId, outcome: plan.outcome as FilingResult["outcome"], lines: plan.lines });
    } catch (err) {
      console.error(`inbound: filing ${it.docId} failed: ${err instanceof Error ? err.message : String(err)}`);
      results.push({ docId: it.docId, outcome: "unfiled", lines: [unfiledLine(name, "error", null)] });
    }
  }
  return results;
}

/** "filed 1, added to 0, unfiled 0, removed 0" for the ledger detail. */
function filingDetail(results: FilingResult[]): string {
  const n = (o: FilingResult["outcome"][]) => results.filter((r) => o.includes(r.outcome)).length;
  return `filed ${n(["created"])}, added to ${n(["updated", "linked"])}, already ${n(["already"])}, unfiled ${n(["unfiled"])}, removed ${n(["removed"])}`;
}

// ─── Route: cme@ ──────────────────────────────────────────────────────────────

async function handleCme(ledgerId: string, emailId: string, from: string, subject: string, messageId: string) {
  // Per-sender cap: recorded and dropped, no reply (a reply per message would
  // hand a spammer a free reflector).
  const recent = await countSince(60, (q) => q.eq("from_addr", from).eq("route", "cme").neq("id", ledgerId));
  if (recent >= CME_PER_SENDER_PER_HOUR) {
    await finish(ledgerId, "rate_limited", `${recent} cme messages from this sender in the last hour`);
    return json({ ok: true, route: "cme", result: "rate_limited" });
  }

  const profile = await matchProfile(from);
  const refusal = await intakeRefusal(profile, ledgerId, "cme");
  if (refusal) return refusal;
  const replySubject = `Re: ${(subject || "your certificate").slice(0, 150)}`;
  const replyHeaders = replyThreading(messageId);
  const email = await getReceivedEmail(emailId, "cid");

  if (!profile) {
    return await replyUnregistered(ledgerId, "cme", email, from, FROM_CME, replySubject, replyHeaders,
      `This address is not confirmed for a CredentialDOMD account. Add it in the app under More > Settings > Email and open the link we send here: opening that link is what proves you read this mailbox. Typing the address on your profile is not enough, and never was.

Open the app: ${APP_URL} (More > Settings > Email)

CredentialDOMD
https://credentialdomd.com`);
  }

  const authFail = senderAuthFailure(authResultsFromHeaders(email));
  if (authFail) {
    await finish(ledgerId, "failed", `sender authentication failed: ${authFail.slice(0, 200)}`);
    return json({ ok: true, route: "cme", result: "rejected_auth" });
  }

  // Every attachment is kept, then read and filed where the app would file
  // it: a CME certificate becomes a CME entry, and anything else that rides
  // along (a licence, a BLS card) goes to its own section instead of waiting
  // in the inbox. What cannot be filed stays in the inbox and the reply says so.
  const listed = await listAttachments(emailId);
  const { files, skipped, total } = await downloadAttachments(emailId, acceptKeepable, listed);
  const { stored, duplicates, failed, items } = await storeAsDocuments(profile, files, INBOX_DOC_TYPE);
  const results = items.length ? await fileDocuments(profile, items, await scanContext(profile)) : [];

  const notes: string[] = [];
  const notKept = notKeptNote(listed);
  if (notKept) notes.push(notKept);
  if (skipped > 0) notes.push(`${skipped} attachment${skipped === 1 ? " was" : "s were"} skipped for size (10 MB per file, 20 MB per email) or count (10 per email).`);
  if (failed > 0) notes.push(`${failed} file${failed === 1 ? "" : "s"} could not be saved; forward that one again.`);

  let text: string;
  if (total === 0) {
    text = `No PDF or image attachment was found in that email, so nothing was added. Forward the certificate itself as an attachment (PDF or photo) to ${CME_LOCAL}@${INBOX_DOMAIN}.`;
    if (notes.length) text += `\n\n${notes.join("\n")}`;
    text += `\n\nOpen the app: ${APP_URL} (Documents)\n\nCredentialDOMD\nhttps://credentialdomd.com`;
  } else {
    text = filingReplyText({
      results, notes, appUrl: APP_URL,
      tip: "If what you sent was a full transcript rather than one certificate (a CME Passport or CE Broker export, say), use Import transcript on the CME page instead: it reads every activity as its own row for you to approve.\n\nIf the app is already open, refresh it to see the new file.",
    });
  }

  const r = await sendEmail({ from: FROM_CME, to: [from], subject: replySubject, headers: replyHeaders, text });
  const detail = `stored ${stored}, duplicates ${duplicates}, ${filingDetail(results)}, skipped ${skipped}, failed ${failed}${r.ok ? "" : `, confirmation failed ${r.status}`}`;
  await finish(ledgerId, failed > 0 && stored === 0 && duplicates === 0 && total > 0 ? "failed" : "done", detail, { attachment_count: stored, profile_id: profile.id });
  return json({ ok: true, route: "cme", stored, duplicates, skipped, failed, filed: results.map((x) => x.outcome), confirmed: r.ok });
}

// ─── Route: contacts@ / refs@ ────────────────────────────────────────────────

/** A .vcf, by type or by extension. Some clients send octet-stream. */
function acceptVCardLike(a: ReceivedAttachment): boolean {
  return isVCardAttachment(safeFilename(a.filename, ""), a.content_type ?? "");
}

/**
 * A contact card, emailed in, written as a peer reference.
 *
 * relationship is NOT NULL on the table and the app's form requires it, so it
 * is set to "Other" rather than guessed: a colleague is not a department head
 * and the app must not decide which. The note says where the row came from, so
 * a reference that appears without being typed is never a mystery.
 */
async function handleContacts(ledgerId: string, emailId: string, from: string, subject: string, messageId: string) {
  const recent = await countSince(60, (q) => q.eq("from_addr", from).eq("route", "contacts").neq("id", ledgerId));
  if (recent >= CME_PER_SENDER_PER_HOUR) {
    await finish(ledgerId, "rate_limited", `${recent} contact messages from this sender in the last hour`);
    return json({ ok: true, route: "contacts", result: "rate_limited" });
  }

  const profile = await matchProfile(from);
  const refusal = await intakeRefusal(profile, ledgerId, "contacts");
  if (refusal) return refusal;
  const replySubject = `Re: ${(subject || "the contact you sent").slice(0, 150)}`;
  const replyHeaders = replyThreading(messageId);
  const email = await getReceivedEmail(emailId, "cid");

  // An automatic reply (out of office, a bounce, list mail) is not a card
  // and must not get an answer: our own confirmation invites one, and
  // answering it would mail the physician about nothing for as long as the
  // responder keeps going. Nothing is written and nothing is sent.
  if (isAutomatedSender(from, lowerKeys(email.headers))) {
    await finish(ledgerId, "done", "automated sender, no reply", profile ? { profile_id: profile.id } : {});
    return json({ ok: true, route: "contacts", result: "automated" });
  }

  if (!profile) {
    return await replyUnregistered(ledgerId, "contacts", email, from, FROM_CONTACTS, replySubject, replyHeaders,
      `This address is not confirmed for a CredentialDOMD account, so the contact was not added. Add it in the app under More > Settings > Email and open the link we send here: opening that link is what proves you read this mailbox. Typing the address on your profile is not enough, and never was.

Open the app: ${APP_URL} (More > Settings > Email)

CredentialDOMD
https://credentialdomd.com`);
  }

  const authFail = senderAuthFailure(authResultsFromHeaders(email));
  if (authFail) {
    await finish(ledgerId, "failed", `sender authentication failed: ${authFail.slice(0, 200)}`);
    return json({ ok: true, route: "contacts", result: "rejected_auth" });
  }

  // The card arrives as an attachment from the share sheet. A few clients
  // paste it into the body instead, so the body is read when no file came.
  const { files, skipped } = await downloadAttachments(emailId, acceptVCardLike);
  const texts = files.map((f) => new TextDecoder().decode(f.bytes));
  const body = String(email.text ?? "").slice(0, MAX_BODY_CHARS);
  if (!texts.length && looksLikeVCardText(body)) texts.push(body);

  const cards: VCardContact[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    for (const c of parseVCards(t, MAX_CONTACTS_PER_EMAIL)) {
      const key = `${c.name.toLowerCase()}|${c.email.toLowerCase()}|${c.phone.replace(/\D/g, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push(c);
      if (cards.length >= MAX_CONTACTS_PER_EMAIL) break;
    }
    if (cards.length >= MAX_CONTACTS_PER_EMAIL) break;
  }

  let added = 0;
  const names: string[] = [];
  if (cards.length) {
    const now = new Date().toISOString();
    const rows = cards.map((c) => ({
      id: crypto.randomUUID(),
      // user_id on every collection table is the PROFILE id, not the Clerk id
      // (the app writes it that way and RLS reads it with current_profile_id()).
      // auth_user_id here is a Clerk string and is not even a uuid.
      user_id: profile.id,
      name: c.name || null,
      institution: c.institution || null,
      email: c.email || null,
      phone: c.phone || null,
      relationship: "Other",
      notes: "Added from a contact card you emailed in. Set the relationship and check the details.",
      created_at: now,
      updated_at: now,
    }));
    await assertIntakeWrite(profile);
    const { error } = await db.from("peer_references").insert(rows);
    if (error) {
      console.error(`contacts: peer_references insert failed for ${profile.id}: ${error.message}`);
      await finish(ledgerId, "failed", `peer_references insert failed: ${error.message.slice(0, 200)}`, { profile_id: profile.id });
      return json({ ok: true, route: "contacts", result: "insert_failed" });
    }
    added = rows.length;
    names.push(...cards.map((c) => c.name || c.email || c.phone).filter(Boolean));
  }

  let text: string;
  if (added === 1) {
    text = `Added ${names[0]} to your peer references.

Open References and set the relationship (colleague, chair, program director) and anything else the card did not carry. The relationship is the one field a credentialing office always asks for, and a contact card never has it.`;
  } else if (added > 1) {
    text = `Added ${added} peer references: ${names.join(", ")}.

Open References and set the relationship on each one. That is the field a credentialing office always asks for, and a contact card never carries it.`;
  } else {
    text = `No contact card was found in that email, so nothing was added.

On an iPhone: Contacts, the person, Share Contact, then Mail, and send it to ${CONTACTS_ADDR}. The card travels as a .vcf attachment. A typed-out name and number in the body is not a card and cannot be read.`;
  }
  if (skipped > 0) {
    text += `\n\n${skipped} attachment${skipped === 1 ? " was" : "s were"} skipped for size (10 MB per file) or count (10 per email).`;
  }
  text += `\n\nOpen the app: ${APP_URL} (References)\n\nCredentialDOMD\nhttps://credentialdomd.com`;

  const r = await sendEmail({ from: FROM_CONTACTS, to: [from], subject: replySubject, headers: replyHeaders, text });
  await finish(ledgerId, "done", `added ${added} reference${added === 1 ? "" : "s"}, skipped ${skipped}${r.ok ? "" : `, confirmation failed ${r.status}`}`,
    { attachment_count: added, profile_id: profile.id });
  return json({ ok: true, route: "contacts", added, skipped, confirmed: r.ok });
}

// ─── Route: docs@ / requests@ / packets@ ──────────────────────────────────────

interface ParsedForward {
  found: boolean;              // a forwarded header block with a From: line was located
  from_addr: string;           // "" when not found
  from_name: string | null;
  subject: string | null;
  body_text: string;
  original_message_id: string | null;
}

const FORWARD_MARKER = /^(?:-{2,}\s*(?:forwarded message|original message|forwarded by[^-]*)\s*-{2,}|begin forwarded message:?|-{2,}\s*forwarded message\s*-{2,}.*)$/i;
const HEADER_LINE = /^(from|date|sent|subject|to|cc|reply-to|message-id)\s*:\s*(.*)$/i;
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Remove quoted-reply chevrons ("> > text" -> "text") and normalize line endings. */
function stripChevrons(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/^(\s*>)+\s?/, ""));
}

/** "Name <a@b.c>" | "a@b.c" | "Name [mailto:a@b.c]" | "a@b.c (Name)" -> parts. */
function parseMailbox(v: string): { addr: string; name: string | null } {
  const m = v.match(EMAIL_RE);
  if (!m) return { addr: "", name: v.trim() || null };
  const addr = m[0].toLowerCase();
  let name = v.replace(m[0], "")
    .replace(/mailto:/gi, "")
    .replace(/[<>\[\]()]/g, " ")
    .replace(/^\s*["']+|["']+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!name || name.toLowerCase() === addr) name = "";
  return { addr, name: name || null };
}

function stripFwdPrefix(s: string): string {
  return s.replace(/^\s*(?:(?:fwd?|fw|tr|wg|vs)\s*:\s*)+/i, "").trim();
}

/**
 * Pull the ORIGINAL request out of a forwarded email. Looks for the client's
 * forwarding marker (Gmail "---------- Forwarded message ---------", Outlook
 * "-----Original Message-----", Apple Mail "Begin forwarded message:") or, failing
 * that, the first "From:" line that starts a header block. The header block is
 * consecutive From/Date/Sent/Subject/To/Cc/Reply-To/Message-ID lines (blank
 * lines inside are tolerated); the body is everything below it.
 */
function parseForwarded(text: string): ParsedForward {
  const lines = stripChevrons(text);
  const notFound = (): ParsedForward => ({
    found: false, from_addr: "", from_name: null, subject: null, original_message_id: null,
    body_text: lines.join("\n").trim(),
  });

  // Where does the header block start? Prefer a marker, then the first From: line
  // followed within 8 lines by another header line.
  let start = -1;
  const markerAt = lines.findIndex((l) => FORWARD_MARKER.test(l.trim()));
  if (markerAt >= 0) {
    for (let i = markerAt + 1; i < Math.min(lines.length, markerAt + 8); i++) {
      if (/^from\s*:/i.test(lines[i].trim())) { start = i; break; }
    }
  }
  if (start < 0) {
    for (let i = 0; i < lines.length; i++) {
      if (!/^from\s*:/i.test(lines[i].trim())) continue;
      const followed = lines.slice(i + 1, i + 9).some((l) => HEADER_LINE.test(l.trim()));
      if (followed) { start = i; break; }
    }
  }
  if (start < 0) return notFound();

  const hdr: Record<string, string> = {};
  let last = "";
  let i = start;
  let blanks = 0;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) { blanks++; if (blanks > 2) break; continue; }
    const m = t.match(HEADER_LINE);
    if (m) {
      const key = m[1].toLowerCase();
      if (key in hdr && key === "from") break;   // a second From: means the block ended and a nested quote began
      hdr[key] = m[2].trim();
      last = key;
      blanks = 0;
      continue;
    }
    // Continuation of the previous header (indented, or a wrapped To: list).
    if (last && /^\s/.test(raw) && blanks === 0) { hdr[last] += ` ${t}`; continue; }
    break;
  }
  if (!hdr["from"]) return notFound();

  const { addr, name } = parseMailbox(hdr["from"]);
  // A forward of one of our own replies is not a request; let the physician fix the address.
  const ours = domainPart(addr) === INBOX_DOMAIN || domainPart(addr).endsWith(`.${INBOX_DOMAIN}`);
  if (addr && ours) return notFound();
  const subject = hdr["subject"] ? stripFwdPrefix(hdr["subject"]).slice(0, 500) || null : null;
  const midRaw = (hdr["message-id"] ?? "").trim();
  const original_message_id = midRaw ? (midRaw.startsWith("<") ? midRaw : `<${midRaw}>`).slice(0, 500) : null;
  const body_text = lines.slice(i).join("\n").trim();
  return { found: Boolean(addr), from_addr: addr, from_name: name, subject, original_message_id, body_text };
}

/**
 * The record tables a document can be linked to, with the columns the matcher
 * reads to describe a record ("DEA Registration, ND"; "QuantiFERON-TB Gold,
 * Negative"). Table names are snake_case; the section keys are the app's
 * camelCase ones, because documents.linked_to is written by the app as
 * "<section>:<record id>" and the matcher joins on that.
 */
const RECORD_TABLES: { table: string; section: string; columns: string }[] = [
  { table: "licenses", section: "licenses", columns: "id, type, name, license_number, state, issued_date, expiration_date" },
  { table: "health_records", section: "healthRecords", columns: "id, category, type, name, date_administered, expiration_date, result, doses" },
  { table: "education", section: "education", columns: "id, type, name, institution, graduation_date" },
  { table: "insurance", section: "insurance", columns: "id, type, name, provider, policy_number, effective_date, expiration_date" },
  { table: "screenings", section: "screenings", columns: "id, type, name, agency, report_date, result, expiration_date" },
  { table: "privileges", section: "privileges", columns: "id, type, name, facility, state, appointment_date, expiration_date" },
  { table: "travel_docs", section: "travelDocs", columns: "id, type, name, provider, number, expiration_date" },
  { table: "professional_photos", section: "professionalPhotos", columns: "id, name, date_taken" },
  { table: "cme", section: "cme", columns: "id, title, category, hours, date, provider" },
  { table: "work_history", section: "workHistory", columns: "id, type, position, employer, start_date, end_date" },
  { table: "peer_references", section: "peerReferences", columns: "id, name, degree, institution, relationship, email, phone" },
  { table: "malpractice_history", section: "malpracticeHistory", columns: "id, outcome, facility, state, date_filed" },
  // Never attached (the matcher's NEVER_SECTIONS), loaded only so the link
  // resolves. The app hands the matcher every section it holds, so a contract
  // or a receipt linked as "locumContracts:<id>" is excluded there as a
  // section; here, with no rows to resolve against, the same file read as
  // unlinked, and the CV rule, which matches any unlinked file by name,
  // offered a signed locum agreement to a credentialer who asked for a CV.
  { table: "locum_contracts", section: "locumContracts", columns: "id" },
  { table: "travel_expenses", section: "travelExpenses", columns: "id" },
  // Records in the physician's own categories. Loaded so a file filed there
  // resolves to its record rather than reading as unlinked, which is what let
  // a filename rule offer the wrong file before. Packet eligible.
  { table: "custom_records", section: "customRecords", columns: "id, name, issuer, number, category_name, expiration_date" },
];

// Rows go straight to the matcher, which declares its own row shapes; typing
// them here would only make two files disagree about a nullable column.
// deno-lint-ignore no-explicit-any
type RecordRows = any[];

/**
 * Everything the matcher can attach, described. One query per table, all at
 * once. A record table that fails (a column renamed underneath us, a table
 * not yet deployed) costs that section's descriptions, not the proposal: its
 * documents still appear, unlinked, under their filenames. The documents
 * query itself failing is the one error worth throwing, since there is then
 * nothing to propose.
 */
async function loadCatalogue(profileId: string, exclude: Set<string> = new Set()) {
  const docsQ = db.from("documents").select("id, name, mime_type, type, linked_to, uploaded_at").eq("user_id", profileId);
  const recordQs = RECORD_TABLES.map(async (t): Promise<[string, RecordRows]> => {
    const { data, error } = await db.from(t.table).select(t.columns).eq("user_id", profileId);
    if (error) { console.error(`catalogue: ${t.table}: ${error.message}`); return [t.section, []]; }
    return [t.section, (data ?? []) as RecordRows];
  });
  const [docsRes, recordPairs] = await Promise.all([docsQ, Promise.all(recordQs)]);
  if (docsRes.error) throw new Error(`catalogue: documents: ${docsRes.error.message}`);
  const records: Record<string, RecordRows> = {};
  for (const [section, rows] of recordPairs) records[section] = rows;
  const docs = ((docsRes.data ?? []) as { id?: string; type?: string | null }[])
    .filter((d) => !INBOX_DOC_TYPES.has(String(d.type ?? "")) && !exclude.has(String(d.id ?? "")));
  return catalogueFromRows(docs as RecordRows, records);
}

/**
 * The physician's confirmed forwarding addresses, lowercased. Empty on a
 * failed read: the guards that use it then fall back to the profile address
 * and the forwarder, which is where they stood before the set existed.
 */
async function verifiedAddresses(profileId: string): Promise<Set<string>> {
  const { data, error } = await db.from("forwarding_addresses")
    .select("email, verified_at").eq("user_id", profileId).not("verified_at", "is", null);
  if (error) { console.error(`forwarding addresses: ${error.message}`); return new Set(); }
  return new Set(((data ?? []) as { email: string | null }[]).map((a) => (a.email ?? "").trim().toLowerCase()).filter(Boolean));
}

interface PhysicianDetails {
  name: string;         // header-safe, for the From display name and the signatures
  degree: string;
  email: string;        // the profile address
  replyTo: string;      // where the requester's reply lands
  ackRequests: boolean; // profiles.ack_requests; only an explicit false is off
}

/**
 * Name, degree, reply address and the ack switch. The profile address falls
 * back to the forwarding sender: it is a confirmed address of this physician,
 * and an ack with no reply_to would strand the credentialer's answer at docs@.
 *
 * reply_to is the forwarding sender whenever that is a confirmed address
 * other than the profile email. A physician who keeps a personal address on
 * the profile and forwards from the confirmed hospital one is in that thread
 * from the hospital address; putting the personal one on Reply-To handed it,
 * on arrival and unreviewed, to a credentialer who never had it.
 */
async function physicianDetails(profile: MatchedProfile, forwarder: string, own: Set<string>): Promise<PhysicianDetails> {
  const { data, error } = await db.from("profiles")
    .select("name, degree_type, email, ack_requests").eq("id", profile.id).maybeSingle();
  if (error) throw new Error(`profile details: ${error.message}`);
  const p = (data ?? {}) as { name?: string | null; degree_type?: string | null; email?: string | null; ack_requests?: boolean | null };
  const email = String(p.email ?? profile.email ?? "").trim().toLowerCase() || forwarder;
  const fwd = forwarder.trim().toLowerCase();
  const replyTo = fwd && fwd !== email && own.has(fwd) ? fwd : email;
  return { name: cleanHeaderText(p.name), degree: cleanHeaderText(p.degree_type, 20), email, replyTo, ackRequests: p.ack_requests !== false };
}

/**
 * Acknowledgements this account sent in the last `hours`, counted on the
 * ledger. It was counted on document_requests.ack_sent_at, and RLS lets the
 * owner UPDATE any column of their own rows, so a signed-in script clearing
 * that column lifted the daily cap for as many third-party emails as it
 * liked. inbound_emails is written by the service role only and its detail
 * carries "ack sent" for exactly the messages whose acknowledgement went
 * out (ACK_SENT below, and nothing else writes those two words), so the
 * count comes from there. The row for the message in hand is still
 * "processing" with no detail and does not count itself.
 */
async function ledgerAcksSince(profileId: string, hours: number): Promise<number> {
  return await countSince(hours * 60, (q) => q.eq("profile_id", profileId).eq("route", "docs").ilike("detail", `%${ACK_SENT}%`));
}

/**
 * Has the requester already been acknowledged for this message? A Svix
 * redelivery of a failed attempt re-runs this route and inserts a fresh
 * request row, so the new row's own ack_sent_at (null) proves nothing; the
 * question is asked of every OTHER row this physician has for the same
 * forwarded Message-ID, or for the requester's own Message-ID when the
 * forward carried one (the same request forwarded twice).
 */
async function ackAlreadySent(profileId: string, requestId: string, messageId: string, originalMessageId: string | null): Promise<boolean> {
  const hit = async (column: string, value: string) => {
    const { count, error } = await db.from("document_requests")
      .select("id", { count: "exact", head: true })
      .eq("user_id", profileId).eq(column, value).not("ack_sent_at", "is", null).neq("id", requestId);
    if (error) throw new Error(`ack lookup: ${error.message}`);
    return (count ?? 0) > 0;
  };
  if (await hit("message_id", messageId)) return true;
  if (originalMessageId && await hit("original_message_id", originalMessageId)) return true;
  return false;
}

async function handleDocsRequest(ledgerId: string, emailId: string, from: string, subject: string, messageId: string) {
  const recent = await countSince(60, (q) => q.eq("from_addr", from).eq("route", "docs").neq("id", ledgerId));
  if (recent >= CME_PER_SENDER_PER_HOUR) {
    await finish(ledgerId, "rate_limited", `${recent} docs messages from this sender in the last hour`);
    return json({ ok: true, route: "docs", result: "rate_limited" });
  }

  const profile = await matchProfile(from);
  const refusal = await intakeRefusal(profile, ledgerId, "docs");
  if (refusal) return refusal;
  const replySubject = `Re: ${(subject || "your document request").slice(0, 150)}`;
  const replyHeaders = replyThreading(messageId);
  const email = await getReceivedEmail(emailId, "cid");

  // An automatic reply is not a request. This route sends two emails per
  // message (the physician's summary and, with the guards below, the
  // requester's acknowledgement), and an out-of-office reply to either one
  // arrives here looking like a new forward. Left alone it became a request
  // row with nothing in it and a third email; answered, it could go round
  // until the holiday ended. Nothing is inserted and nothing is sent.
  if (isAutomatedSender(from, lowerKeys(email.headers))) {
    await finish(ledgerId, "done", "automated sender, no reply", profile ? { profile_id: profile.id } : {});
    return json({ ok: true, route: "docs", result: "automated" });
  }

  if (!profile) {
    return await replyUnregistered(ledgerId, "docs", email, from, FROM_DOCS, replySubject, replyHeaders,
      `This address is not confirmed for a CredentialDOMD account. Add it in the app under More > Settings > Email and open the link we send here: opening that link is what proves you read this mailbox. Typing the address on your profile is not enough, and never was.

Open the app: ${APP_URL}

CredentialDOMD
https://credentialdomd.com`);
  }

  // Two readings, kept apart. The filing refusal reads both: an explicit
  // failure in the raw top-most header OR in the header map (ARC included)
  // drops the message, which is the strictness cme@ and contacts@ have and
  // this route briefly lost when it read the raw header alone. The ack below
  // reads only the raw one. The other two routes keep the header map; they
  // send nothing to a third party.
  const auth = await authResultsFrom(email);
  const authFail = senderAuthFailure(auth.positive ?? "") || senderAuthFailure(auth.negative);
  if (authFail) {
    await finish(ledgerId, "failed", `sender authentication failed: ${authFail.slice(0, 200)}`);
    return json({ ok: true, route: "docs", result: "rejected_auth" });
  }

  // The original request lives inside the forwarded text.
  const rawText = (email.text && email.text.trim()) ? email.text : (email.html ? stripHtml(email.html) : "");
  const parsed = parseForwarded(rawText);
  const fromAddr = parsed.found ? parsed.from_addr : from;
  const requesterName = parsed.found ? parsed.from_name : null;
  // What the matcher reads: the request as written, before the not-found
  // notice below is prepended. That notice contains "forwarded" and
  // "replying", which are the very words the matcher's fallback looks for
  // when the email has no list, and it would have become an ask.
  const requestBody = parsed.body_text.slice(0, MAX_REQUEST_BODY_CHARS);
  let bodyText = parsed.body_text;
  if (!parsed.found) {
    bodyText = `Requester address not found in the forwarded text; edit before replying.\n\n${bodyText}`.trim();
  }
  bodyText = bodyText.slice(0, MAX_REQUEST_BODY_CHARS);
  const requestSubject = parsed.subject ?? (stripFwdPrefix(subject) || null);
  const receivedAt = email.created_at || new Date().toISOString();

  // What is this email FOR? Until 2026-09-25 every docs@ forward was a
  // request, so an approval letter forwarded to keep became a request whose
  // only ask was the letter's signature line, the physician was asked what
  // "Whitney, DO" meant, and the letter sat unfiled. A document to keep is
  // now filed and nothing else happens: no request row, no acknowledgement
  // (which would have thanked Sanford for a request Sanford never made). See
  // _shared/intakeIntent.mjs for the rules.
  const listed = await listAttachments(emailId);
  const keepable = listed.filter(acceptKeepable);
  const intent = classifyIntent({
    subject: requestSubject ?? "",
    body: parsed.body_text,
    attachmentNames: keepable.map((a) => safeFilename(a.filename, "")),
    attachmentCount: keepable.length,
  });
  console.log(`inbound ${emailId}: intent ${intent.intent} (${intent.reasons.join("; ")})`);
  const { files, skipped } = await downloadAttachments(emailId, acceptKeepable, listed);

  if (intent.intent === "delivery") {
    return await deliverDocs(ledgerId, profile, from, files, skipped, notKeptNote(listed), replySubject, replyHeaders);
  }

  // "both": the finished documents are filed like a delivery; a form the
  // requester wants filled in (named like an application, a checklist, an
  // attestation) stays with the request, as every attachment did before.
  let filing: FilingResult[] = [];
  let requestFiles = files;
  let deliveredFailed = 0;
  if (intent.intent === "both") {
    const keep = files.filter((f) => attachmentRole(f.filename) !== "form");
    requestFiles = files.filter((f) => attachmentRole(f.filename) === "form");
    const delivered = await storeAsDocuments(profile, keep, EMAIL_DOC_TYPE);
    deliveredFailed = delivered.failed;
    filing = delivered.items.length ? await fileDocuments(profile, delivered.items, await scanContext(profile)) : [];
  }
  // The requester's checklist, when one rides along (rare).
  const { stored, failed } = await storeAsDocuments(profile, requestFiles, REQUEST_DOC_TYPE);

  await assertIntakeWrite(profile);
  const { data: reqRow, error: rErr } = await db.from("document_requests").insert({
    user_id: profile.id,
    from_addr: fromAddr,
    from_name: requesterName,
    subject: requestSubject,
    body_text: bodyText,
    message_id: messageId,
    original_message_id: parsed.original_message_id,
    forwarded_by: from,
    received_at: receivedAt,
    status: "new",
    inbound_ledger_id: ledgerId,
  }).select("id").single();
  if (rErr) throw new Error(`document_requests insert: ${rErr.message}`);
  const requestId = (reqRow as { id: string }).id;

  // Who the physician is, for the cover note's signature and the ack. A
  // failed read keeps the request and turns the ack off for this message: an
  // acknowledgement with no name on it is not something to send a credentialer.
  // The physician's own mailboxes: the confirmed forwarding rows, plus the
  // provider-verified one on the profile. ackAllowed uses this set to refuse
  // acknowledging the physician themselves, and the verified mailbox belongs in
  // it for the same reason the confirmed ones do.
  const own = await verifiedAddresses(profile.id);
  if (profile.verified_email) own.add(profile.verified_email.trim().toLowerCase());
  const profileEmail = (profile.email ?? "").trim().toLowerCase() || from;
  let phys: PhysicianDetails = { name: "", degree: "", email: profileEmail, replyTo: profileEmail, ackRequests: false };
  try {
    phys = await physicianDetails(profile, from, own);
  } catch (err) {
    console.error(`docs: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The packet proposal: every asked-for item matched against the file, and
  // the cover note that goes with it. Built on arrival so the app can offer
  // one button. A failure anywhere in here never loses the request: the row
  // stays with proposal null and the app falls back to the hand-built reply.
  let proposal: Proposal | null = null;
  try {
    // A document that arrived in this same email is the requester's, not an
    // answer to them: it is never proposed back.
    const catalogue = await loadCatalogue(profile.id, new Set(filing.map((f) => f.docId)));
    proposal = buildProposal(
      { subject: requestSubject ?? "", body: requestBody, fromName: requesterName ?? "", fromAddr },
      catalogue,
      { name: phys.name, degree: phys.degree },
    );
    // An AI pass over the rules' result (naming the asks the rules could not) would run here, before the proposal is stored.
    const now = new Date().toISOString();
    const { error: uErr } = await db.from("document_requests")
      .update({ proposal, proposal_at: now, updated_at: now }).eq("id", requestId);
    if (uErr) throw new Error(`proposal update: ${uErr.message}`);
  } catch (err) {
    console.error(`docs: proposal for request ${requestId} failed: ${err instanceof Error ? err.message : String(err)}`);
    proposal = null;
  }

  // The physician's summary: who asked, for what, what was found, one thing
  // left to do. The not-found notice lives inside physicianSummaryText.
  const notes: string[] = [];
  if (stored > 0) notes.push(`${stored} attachment${stored === 1 ? "" : "s"} from the request ${stored === 1 ? "was" : "were"} saved to your Documents.`);
  if (skipped > 0) notes.push(`${skipped} attachment${skipped === 1 ? " was" : "s were"} skipped for size (10 MB per file, 20 MB per email) or count (10 per email).`);
  if (failed + deliveredFailed > 0) notes.push(`${failed + deliveredFailed} attachment${failed + deliveredFailed === 1 ? "" : "s"} could not be saved.`);
  const notKept = notKeptNote(listed);
  if (notKept) notes.push(notKept);
  const filedLines = filing.flatMap((f) => f.lines);
  if (filedLines.length) notes.push(`From the same email:\n${filedLines.join("\n")}`);

  let text = physicianSummaryText({ requesterName, requesterAddr: fromAddr, requesterFound: parsed.found, proposal, appUrl: APP_URL });
  if (notes.length) text += `\n\n${notes.join("\n")}`;
  text += `\n\nCredentialDOMD\nhttps://credentialdomd.com`;

  const r = await sendEmail({ from: FROM_DOCS, to: [from], subject: replySubject, headers: replyHeaders, text });

  // The requester hears "received; any documents come from this address"
  // from docs@ with the physician's name on it and reply_to set to the
  // physician. It promises nothing (see ackText). Every refusal in ackAllowed
  // is a way that mail would go to the wrong place, and one is a way it
  // would go at all on a forged From: the forward must carry dmarc=pass or
  // an aligned spf+dkim pass in the RAW top-most header, a missing header
  // counting as a no (senderAuthFailure lets a missing header through,
  // which is fine for filing into the sender's own account and not for mail
  // that leaves our domain addressed by the message itself), and a raw
  // message that could not be read counting as a no too (the header map is
  // never consulted here). Three more live here because they need the
  // database: no name on the profile (a nameless ack reads as spam), an ack
  // already sent for this message (a redelivered webhook, or the same
  // request forwarded twice), and the per-account daily cap. The per-sender
  // cap above bounds how many can go out in an hour.
  let ackDetail: string;
  try {
    const authOk = auth.positive !== null && senderPositivelyAuthenticated(auth.positive, from, INBOUND_AUTHSERV_IDS);
    const allowed = ackAllowed({
      requesterAddr: fromAddr, requesterName, forwarderAddr: from, physicianEmail: phys.email, ownAddresses: own,
      requesterFound: parsed.found, ackRequests: phys.ackRequests, senderAuthenticated: authOk,
    });
    if (!allowed.ok) {
      ackDetail = `ack skipped: ${allowed.why}${auth.positive === null ? " (raw message unavailable)" : ""}`;
    } else if (!phys.name) {
      ackDetail = "ack skipped: no name on the profile";
    } else if (await ackAlreadySent(profile.id, requestId, messageId, parsed.original_message_id)) {
      ackDetail = "ack skipped: already sent for this message";
    } else if (await ledgerAcksSince(profile.id, 24) >= ACK_PER_PROFILE_PER_DAY) {
      ackDetail = `ack skipped: daily cap of ${ACK_PER_PROFILE_PER_DAY} for this account reached`;
    } else {
      const ackPayload: Record<string, unknown> = {
        from: fromHeader(phys.name, phys.degree),
        to: [fromAddr],
        reply_to: [phys.replyTo],
        subject: replySubjectFor(requestSubject),
        text: ackText({ requesterName, physicianName: phys.name, degree: phys.degree, askCount: proposal?.items?.length ?? 1, receivedAtIso: receivedAt }),
      };
      const threading = replyThreading(parsed.original_message_id ?? "");
      if (Object.keys(threading).length) ackPayload.headers = threading;
      // The intent is recorded before the send, not after it. ack_sent_at
      // used to be written once Resend answered, and a webhook retry after
      // a timeout could ack twice: the first attempt had sent the ack and
      // been cut off before the write, so the retry found no record of it,
      // inserted its own row and sent again. Now the stamp goes on first,
      // ackAlreadySent sees it from the retry, and it comes off only when
      // Resend says the send did not happen. A stamp that cannot be written
      // means no send: an ack nobody can account for is the thing to avoid.
      const stampAt = new Date().toISOString();
      const { error: sErr } = await db.from("document_requests").update({ ack_sent_at: stampAt, updated_at: stampAt }).eq("id", requestId);
      if (sErr) throw new Error(`ack_sent_at stamp: ${sErr.message}`);
      const ack = await sendEmail(ackPayload);
      if (ack.ok) {
        ackDetail = ACK_SENT;
      } else {
        const { error: aErr } = await db.from("document_requests").update({ ack_sent_at: null, updated_at: new Date().toISOString() }).eq("id", requestId);
        if (aErr) console.error(`docs: ack_sent_at clear failed for ${requestId}: ${aErr.message}`);
        ackDetail = `ack failed: ${ack.status}`;
      }
    }
  } catch (err) {
    ackDetail = `ack skipped: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`docs: ${ackDetail}`);
  }

  const proposalDetail = proposal ? `proposal ${proposal.docIds.length} doc(s), ${proposal.missing.length} missing` : "proposal none";
  // The ack outcome sits right after the id: finish() cuts detail at 500
  // characters and ledgerAcksSince counts on the words being there.
  const detail = `request ${requestId}, ${ackDetail}, intent ${intent.intent}, from ${fromAddr}${parsed.found ? "" : " (requester not found)"}, ${proposalDetail}, attachments ${stored}${filing.length ? `, ${filingDetail(filing)}` : ""}, skipped ${skipped}, failed ${failed + deliveredFailed}${r.ok ? "" : `, confirmation failed ${r.status}`}`;
  await finish(ledgerId, "done", detail, { attachment_count: stored, profile_id: profile.id });
  return json({
    ok: true, route: "docs", intent: intent.intent, request_id: requestId, requester_found: parsed.found,
    proposed: proposal ? proposal.docIds.length : null, ack: ackDetail,
    stored, skipped, failed, filed: filing.map((f) => f.outcome), confirmed: r.ok,
  });
}

/**
 * docs@ "delivery": a document forwarded to keep. Each attachment is stored,
 * read and filed; the physician hears where each one went. No request row,
 * no acknowledgement, nothing to anyone but the physician.
 */
async function deliverDocs(
  ledgerId: string, profile: MatchedProfile, from: string, files: Downloaded[], skipped: number, notKept: string,
  replySubject: string, replyHeaders: Record<string, string>,
) {
  const { stored, duplicates, failed, items } = await storeAsDocuments(profile, files, EMAIL_DOC_TYPE);
  const results = items.length ? await fileDocuments(profile, items, await scanContext(profile)) : [];
  const notes: string[] = [];
  if (notKept) notes.push(notKept);
  if (skipped > 0) notes.push(`${skipped} attachment${skipped === 1 ? " was" : "s were"} skipped for size (10 MB per file, 20 MB per email) or count (10 per email).`);
  if (failed > 0) notes.push(`${failed} file${failed === 1 ? "" : "s"} could not be saved; forward the email again.`);
  const text = filingReplyText({ results, notes, appUrl: APP_URL });
  const r = await sendEmail({ from: FROM_DOCS, to: [from], subject: replySubject, headers: replyHeaders, text });
  // Worded so "ack sent" can never appear here: ledgerAcksSince counts on it.
  const detail = `delivery, stored ${stored}, duplicates ${duplicates}, ${filingDetail(results)}, skipped ${skipped}, failed ${failed}${r.ok ? "" : `, confirmation failed ${r.status}`}`;
  await finish(ledgerId, failed > 0 && stored === 0 && duplicates === 0 ? "failed" : "done", detail, { attachment_count: stored, profile_id: profile.id });
  return json({ ok: true, route: "docs", intent: "delivery", stored, duplicates, skipped, failed, filed: results.map((x) => x.outcome), confirmed: r.ok });
}

// ─── Route: everything else -> relay to the owner ─────────────────────────────

async function handleForward(ledgerId: string, emailId: string, from: string, ourAddr: string, subject: string, messageId: string) {
  const local = localPart(ourAddr) || "unknown";
  const email = await getReceivedEmail(emailId, "cid");
  const headers = lowerKeys(email.headers);

  const { files, skipped } = await downloadAttachments(emailId, () => true);

  const origFrom = headers["from"] || email.from || from;
  const origTo = (email.to ?? []).join(", ");
  const origCc = (email.cc ?? []).join(", ");
  const origDate = headers["date"] || email.created_at || "";
  const origReplyTo = (email.reply_to ?? []).join(", ");

  const metaLines = [
    `From: ${origFrom}`,
    `To: ${origTo}`,
    origCc ? `Cc: ${origCc}` : "",
    origReplyTo ? `Reply-To: ${origReplyTo}` : "",
    `Date: ${origDate}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Received at: ${ourAddr}`,
    files.length ? `Attachments: ${files.map((f) => f.filename).join(", ")}` : "",
    skipped ? `${skipped} attachment(s) not re-attached (over 10 MB per file / 20 MB per email / 10 files); open the message in Resend, Emails > Receiving.` : "",
  ].filter(Boolean);

  const bodyText = (email.text && email.text.trim()) ? email.text : (email.html ? stripHtml(email.html) : "");
  const text = `${metaLines.join("\n")}\n\n----- Original message -----\n\n${bodyText.slice(0, MAX_BODY_CHARS)}`;

  let html: string | undefined;
  if (email.html) {
    const meta = metaLines.map((l) => escapeHtml(l)).join("<br>");
    html = `<div style="font:13px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#444;border-bottom:1px solid #ddd;padding-bottom:10px;margin-bottom:14px">${meta}</div>${email.html.slice(0, MAX_BODY_CHARS)}`;
  }

  const attachments = files.map((f) => {
    const a: Record<string, unknown> = { filename: f.filename, content: encodeBase64(f.bytes), content_type: f.content_type };
    if (f.inline && f.content_id) a.content_id = f.content_id;
    return a;
  });

  const payload: Record<string, unknown> = {
    from: FROM_RELAY,
    to: [FORWARD_TO],
    reply_to: from ? [from] : undefined,
    subject: `[${INBOX_DOMAIN} ${local}] ${subject || "(no subject)"}`.slice(0, 250),
    text,
    headers: { "X-CredentialDOMD-Inbound-Id": emailId },
  };
  if (html) payload.html = html;
  if (attachments.length) payload.attachments = attachments;

  const r = await sendEmail(payload);
  if (!r.ok) {
    await finish(ledgerId, "failed", `forward failed: ${r.status} ${r.body.slice(0, 200)}`);
    return json({ ok: false, route: "forward", error: "forward failed" }, 502);
  }
  await finish(ledgerId, "done", `forwarded to ${FORWARD_TO}, ${files.length} attachment(s)${skipped ? `, ${skipped} skipped` : ""}`, { attachment_count: files.length });
  return json({ ok: true, route: "forward", attachments: files.length, skipped });
}

// ─── Entry ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  if (!WEBHOOK_SECRET || !RESEND_API_KEY) return new Response("not configured", { status: 500 });

  const raw = await req.text();
  const svixHeaders = {
    "svix-id": req.headers.get("svix-id") ?? "",
    "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
    "svix-signature": req.headers.get("svix-signature") ?? "",
  };
  if (!svixHeaders["svix-id"] || !svixHeaders["svix-signature"]) return new Response("missing svix headers", { status: 400 });

  let event: ReceivedEvent;
  try {
    event = new Webhook(WEBHOOK_SECRET).verify(raw, svixHeaders) as ReceivedEvent;
  } catch (err) {
    console.error("webhook signature verification failed:", err instanceof Error ? err.message : String(err));
    return new Response("bad signature", { status: 400 });
  }

  if (event.type !== "email.received" || !event.data?.email_id) {
    return json({ ok: true, ignored: event.type ?? "unknown" });
  }

  const d = event.data;
  const emailId = String(d.email_id);
  const from = bareAddress(d.from);
  const ourAddr = pickOurAddress(d);
  const subject = String(d.subject ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  const messageId = (String(d.message_id ?? "").trim() || `resend:${emailId}`).slice(0, 500);
  const local = localPart(ourAddr);
  const route: Route = local === CME_LOCAL
    ? "cme"
    : DOCS_LOCALS.has(local)
      ? "docs"
      : CONTACT_LOCALS.has(local) ? "contacts" : "forward";

  // Global ceiling. 429 makes Resend retry later instead of dropping the mail.
  try {
    const recentGlobal = await countSince(10);
    if (recentGlobal >= GLOBAL_PER_10MIN) return json({ error: "rate limited" }, 429);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return json({ error: "ledger unavailable" }, 500);
  }

  let ledgerId: string | null;
  try {
    ledgerId = await claim({ message_id: messageId, email_id: emailId, from_addr: from, to_addr: ourAddr, subject, route });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return json({ error: "ledger unavailable" }, 500);
  }
  if (!ledgerId) return json({ ok: true, duplicate: true });

  try {
    if (route === "cme") return await handleCme(ledgerId, emailId, from, subject, messageId);
    if (route === "docs") return await handleDocsRequest(ledgerId, emailId, from, subject, messageId);
    if (route === "contacts") return await handleContacts(ledgerId, emailId, from, subject, messageId);
    return await handleForward(ledgerId, emailId, from, ourAddr, subject, messageId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`inbound ${emailId} (${route}) failed: ${msg}`);
    await finish(ledgerId, "failed", msg);
    return json({ error: "processing failed" }, 500);
  }
});
