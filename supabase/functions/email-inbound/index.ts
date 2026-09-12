/**
 * email-inbound: Resend "email.received" webhook for @credentialdomd.com.
 *
 * Four routes, decided by the local part of the address the message was sent to:
 *
 *   cme@credentialdomd.com   Certificate intake by email forwarding.
 *     Sender must match a profile: lower(profiles.email) = lower(from), or a
 *     CONFIRMED row in forwarding_addresses (the physician added the address in
 *     More > Settings > Email and opened the link sent to it). Every
 *     PDF / image attachment is copied into the `documents` Storage bucket at
 *     <auth_user_id>/<doc id> and a `documents` row is written with
 *     type = "cme-certificate-inbox" and no linked_to, so the app shows it under
 *     "From your inbox, not filed yet" with File-with-AI / link actions. The
 *     sender gets a confirmation. An unknown sender gets one short reply
 *     explaining how to register the address (rate-limited, never to bounces or
 *     auto-submitted mail).
 *
 *   docs@ | requests@ | packets@credentialdomd.com   Document requests.
 *     A credentialer asked the physician for documents; the physician forwards
 *     that email here from the address on their profile, or from any address
 *     they have confirmed as a forwarding address, and that forward is the
 *     last thing they type. Same sender matching and authentication as cme@.
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
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { parseVCards, isVCardAttachment, looksLikeVCardText, type VCardContact } from "../_shared/vcard.ts";
import { buildProposal, catalogueFromRows } from "../_shared/requestPacket.ts";
// replySubject is imported under another name because each route handler
// below already holds a local `replySubject` string (the physician's own
// confirmation subject); the bare name would have resolved to that string
// at the ack's call site and thrown.
import { ackAllowed, ackText, authEvidence, physicianSummaryText, replySubject as replySubjectFor, senderAuthFailure, senderPositivelyAuthenticated, type AuthEvidence, type Proposal } from "../_shared/requestFlow.ts";

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
// Documents that arrived by email and are not yet the physician's own
// filed record. Kept out of the packet matcher's catalogue: the requester's
// checklist is stored before the proposal is built, and the CV rule matches
// any unlinked file by name, so "Provider_CV_Request_Form.pdf" was offered
// straight back to the credentialer who attached it, as the physician's CV.
const INBOX_DOC_TYPES = new Set([INBOX_DOC_TYPE, REQUEST_DOC_TYPE]);
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
  email: string | null;
  access_status: string | null;
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
): Promise<{ files: Downloaded[]; skipped: number; total: number }> {
  const all = await listAttachments(emailId);
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
 * Sender -> profile, in two passes. This function decides whose account
 * receives a forwarded credentialing document, attachments and all, so the
 * order of the passes is the whole security question.
 *
 * PROVEN FIRST. forwarding_addresses is checked before profiles.email, because
 * the two claims are not equally good. A forwarding address is usable only
 * after somebody opened a link sent to that mailbox and pressed Confirm, so it
 * is evidence of control. profiles.email is a text box in Settings: a physician
 * types it, nobody checks it, and migration 20260819_lock_access_status
 * deliberately left the column editable by its owner (the identity lock freezes
 * auth_user_id and access_status, not email).
 *
 * While the typed address won, that asymmetry was a takeover: an account that
 * typed name@hospital.org into its own profile outranked the account that had
 * confirmed name@hospital.org by reading the mailbox, and the forwarded mail
 * went to the one that typed it. Confirmed now wins, and profiles.email is a
 * fallback for the ordinary case where nobody registered anything.
 *
 * The other half of that fix lives in the database: profiles.email carries a
 * unique index on lower(email) (migration 20260903e), so a second account
 * cannot even hold a copy of an address the first one typed.
 *
 * Only verified_at rows count in pass 1, and a verified address is unique
 * across accounts (partial unique index), so pass 1 matches at most one
 * account. Both passes filter ilike results down to an exact lowercased match:
 * ilike folds more than case, and this decides where a document lands.
 */
async function matchProfile(from: string): Promise<MatchedProfile | null> {
  const confirmed = await profilesByIds(async () => {
    const { data: addrs, error } = await db.from("forwarding_addresses")
      .select("user_id, email, verified_at")
      .ilike("email", ilikeLiteral(from))
      .not("verified_at", "is", null)
      .limit(5);
    if (error) throw new Error(`forwarding address lookup: ${error.message}`);
    const owners = ((addrs ?? []) as { user_id: string; email: string | null; verified_at: string | null }[])
      .filter((a) => (a.email ?? "").trim().toLowerCase() === from && a.verified_at)
      .map((a) => a.user_id);
    if (owners.length === 0) return [];
    const { data: rows, error: pErr } = await db.from("profiles")
      .select("id, auth_user_id, email, access_status").in("id", owners).limit(5);
    if (pErr) throw new Error(`profile lookup: ${pErr.message}`);
    return (rows ?? []) as ProfileLookupRow[];
  });
  if (confirmed) return confirmed;

  return await profilesByIds(async () => {
    const { data: rows, error } = await db.from("profiles")
      .select("id, auth_user_id, email, access_status")
      .ilike("email", ilikeLiteral(from))
      .limit(5);
    if (error) throw new Error(`profile lookup: ${error.message}`);
    return ((rows ?? []) as ProfileLookupRow[]).filter((p) => (p.email ?? "").trim().toLowerCase() === from);
  });
}

type ProfileLookupRow = { id: string; auth_user_id: string | null; email: string | null; access_status: string | null };

/** An account with access wins over one without, same rule for both passes. */
async function profilesByIds(load: () => Promise<ProfileLookupRow[]>): Promise<MatchedProfile | null> {
  const profiles = (await load()).filter((p) => p.auth_user_id) as MatchedProfile[];
  profiles.sort((a, b) => (a.access_status === "active" ? 0 : 1) - (b.access_status === "active" ? 0 : 1));
  return profiles[0] ?? null;
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

/**
 * Copy downloaded files into the physician's Documents (Storage + documents
 * row with the given type, no linked_to). Skips a file this user already has
 * (same name and size), same rule as the app.
 */
async function storeAsDocuments(profile: MatchedProfile, files: Downloaded[], docType: string) {
  const have = new Set<string>();
  if (files.length > 0) {
    const { data: existingDocs } = await db.from("documents")
      .select("name, size_bytes").eq("user_id", profile.id).in("name", files.map((f) => f.filename));
    for (const d of (existingDocs ?? []) as { name: string; size_bytes: number | null }[]) have.add(`${d.name}|${d.size_bytes ?? ""}`);
  }

  const now = new Date().toISOString();
  const docIds: string[] = [];
  let stored = 0;
  let duplicates = 0;
  let failed = 0;
  for (const f of files) {
    if (have.has(`${f.filename}|${f.bytes.byteLength}`)) { duplicates++; continue; }
    const docId = crypto.randomUUID();
    const path = `${profile.auth_user_id}/${docId}`; // app: documentStoragePath(docId) = <clerk sub>/<doc id>
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
    have.add(`${f.filename}|${f.bytes.byteLength}`);
    docIds.push(docId);
    stored++;
  }
  return { stored, duplicates, failed, docIds };
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
  const replySubject = `Re: ${(subject || "your certificate").slice(0, 150)}`;
  const replyHeaders = replyThreading(messageId);
  const email = await getReceivedEmail(emailId, "cid");

  if (!profile) {
    return await replyUnregistered(ledgerId, "cme", email, from, FROM_CME, replySubject, replyHeaders,
      `This address is not registered to a CredentialDOMD account. Forward from the email on your account, or add this address in Settings and open the link we send here to confirm it.

Open the app: ${APP_URL} (More > Settings > Email)

CredentialDOMD
https://credentialdomd.com`);
  }

  const authFail = senderAuthFailure(authResultsFromHeaders(email));
  if (authFail) {
    await finish(ledgerId, "failed", `sender authentication failed: ${authFail.slice(0, 200)}`);
    return json({ ok: true, route: "cme", result: "rejected_auth" });
  }

  const { files, skipped, total } = await downloadAttachments(emailId, acceptCertificateLike);
  const { stored, duplicates, failed } = await storeAsDocuments(profile, files, INBOX_DOC_TYPE);

  const notes: string[] = [];
  if (duplicates > 0) notes.push(`${duplicates} file${duplicates === 1 ? " was" : "s were"} already in your Documents and skipped.`);
  if (skipped > 0) notes.push(`${skipped} attachment${skipped === 1 ? " was" : "s were"} skipped for size (10 MB per file, 20 MB per email) or count (10 per email).`);
  if (failed > 0) notes.push(`${failed} file${failed === 1 ? "" : "s"} could not be saved; forward that one again.`);

  let text: string;
  if (stored > 0) {
    text = `Got it: ${stored} certificate${stored === 1 ? "" : "s"} added to your Documents. Open the app, tap the certificate, and use File with AI (or link it to a CME entry) to count it.

If what you sent was a full transcript rather than one certificate (a CME Passport or CE Broker export, say), use Import transcript on the CME page instead: it reads every activity as its own row for you to approve.

If the app is already open, refresh it to see the new file.`;
  } else if (total === 0) {
    text = `No PDF or image attachment was found in that email, so nothing was added. Forward the certificate itself as an attachment (PDF or photo) to ${CME_LOCAL}@${INBOX_DOMAIN}.`;
  } else {
    text = `Nothing new was added to your Documents.`;
  }
  if (notes.length) text += `\n\n${notes.join("\n")}`;
  text += `\n\nOpen the app: ${APP_URL} (Documents)\n\nCredentialDOMD\nhttps://credentialdomd.com`;

  const r = await sendEmail({ from: FROM_CME, to: [from], subject: replySubject, headers: replyHeaders, text });
  const detail = `stored ${stored}, duplicates ${duplicates}, skipped ${skipped}, failed ${failed}${r.ok ? "" : `, confirmation failed ${r.status}`}`;
  await finish(ledgerId, failed > 0 && stored === 0 && total > 0 ? "failed" : "done", detail, { attachment_count: stored, profile_id: profile.id });
  return json({ ok: true, route: "cme", stored, duplicates, skipped, failed, confirmed: r.ok });
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
      `This address is not registered to a CredentialDOMD account, so the contact was not added. Send it from the email on your account, or add this address in Settings and open the link we send here to confirm it.

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
async function loadCatalogue(profileId: string) {
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
  const docs = ((docsRes.data ?? []) as { type?: string | null }[]).filter((d) => !INBOX_DOC_TYPES.has(String(d.type ?? "")));
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
      `This address is not registered to a CredentialDOMD account. Forward the request from the email on your account, or add this address in Settings (More > Settings > Email) and open the link we send here to confirm it.

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

  // The requester's checklist PDF, when one rides along (rare).
  const { files, skipped } = await downloadAttachments(emailId, acceptCertificateLike);
  const { stored, failed } = await storeAsDocuments(profile, files, REQUEST_DOC_TYPE);

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
  const own = await verifiedAddresses(profile.id);
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
    const catalogue = await loadCatalogue(profile.id);
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
  if (failed > 0) notes.push(`${failed} attachment${failed === 1 ? "" : "s"} could not be saved.`);

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
  const detail = `request ${requestId}, ${ackDetail}, from ${fromAddr}${parsed.found ? "" : " (requester not found)"}, ${proposalDetail}, attachments ${stored}, skipped ${skipped}, failed ${failed}${r.ok ? "" : `, confirmation failed ${r.status}`}`;
  await finish(ledgerId, "done", detail, { attachment_count: stored, profile_id: profile.id });
  return json({
    ok: true, route: "docs", request_id: requestId, requester_found: parsed.found,
    proposed: proposal ? proposal.docIds.length : null, ack: ackDetail,
    stored, skipped, failed, confirmed: r.ok,
  });
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
