/**
 * email-inbound: Resend "email.received" webhook for @credentialdomd.com.
 *
 * Three routes, decided by the local part of the address the message was sent to:
 *
 *   cme@credentialdomd.com   Certificate intake by email forwarding.
 *     Sender must match a profile: lower(profiles.email) = lower(from), or a
 *     CONFIRMED row in forwarding_addresses (the physician added the address in
 *     More > Settings > Email and clicked the link sent to it). Every
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
 *     they have confirmed as a forwarding address. Same sender matching and
 *     authentication as cme@. The ORIGINAL requester (From:), subject and
 *     body are parsed out of the forwarded text (Gmail / Outlook / Apple Mail
 *     header blocks) and a `document_requests` row is written; PDF / image
 *     attachments (the requester's checklist) are stored as documents with
 *     type = "request-attachment-inbox". The physician gets a short reply
 *     pointing at More > Requests, where the packet is built and sent by
 *     the send-packet-email function.
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
 */

import { Webhook } from "https://esm.sh/svix@1.40.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.97.0";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

// ─── Configuration ────────────────────────────────────────────────────────────

const INBOX_DOMAIN = "credentialdomd.com";
const CME_LOCAL = "cme";
const DOCS_LOCALS = new Set(["docs", "requests", "packets"]);
const DOCS_ADDR = `docs@${INBOX_DOMAIN}`;
const FORWARD_TO = "stormchaser@elryx.com";
const FROM_ADDR = "whit@credentialdomd.com";
const FROM_CME = `CredentialDOMD <${FROM_ADDR}>`;
const FROM_DOCS = `CredentialDOMD <${DOCS_ADDR}>`;
const FROM_RELAY = `CredentialDOMD Inbox <${FROM_ADDR}>`;
const APP_URL = "https://credentialdomd.com/app/";
const INBOX_DOC_TYPE = "cme-certificate-inbox";
const REQUEST_DOC_TYPE = "request-attachment-inbox";
const STORAGE_BUCKET = "documents";
const MAX_REQUEST_BODY_CHARS = 20_000;   // document_requests.body_text

const GLOBAL_PER_10MIN = 120;
const CME_PER_SENDER_PER_HOUR = 20;
const UNREG_REPLY_PER_DAY = 1;
const STALE_PROCESSING_MIN = 10;
const UNREG_REPLIED = "replied: not registered";   // ledger detail that marks a sent "not registered" reply

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // matches the app's 10 MB upload cap
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;  // raw; base64 stays under Resend's 40 MB per-email limit
const MIN_INLINE_IMAGE_BYTES = 40 * 1024;  // inline images under this are signature logos, not certificates
const MAX_BODY_CHARS = 200_000;

// ─── Env / clients ────────────────────────────────────────────────────────────

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_API = (Deno.env.get("RESEND_API_BASE") ?? "https://api.resend.com").replace(/\/$/, ""); // override only for local tests
const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";
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

type Route = "cme" | "docs" | "forward";

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

/** ilike pattern with % and _ escaped so an address is matched literally. */
function ilikeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
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
 * Sender -> profile, in two passes.
 *
 * First profiles.email, the address the physician typed in Settings. Then
 * forwarding_addresses: an extra address they registered and CONFIRMED by
 * clicking a link sent to that mailbox (the forwarding-address function owns
 * that flow). Credentialing mail arrives at a work address, so the common case
 * is a physician who signed up as name@gmail.com forwarding from
 * name@hospital.org; without the second pass that message is refused.
 *
 * Only verified_at rows count, and a verified address is unique across
 * accounts (partial unique index), so this pass can match at most one account.
 */
async function matchProfile(from: string): Promise<MatchedProfile | null> {
  const direct = await profilesByIds(async () => {
    const { data: rows, error } = await db.from("profiles")
      .select("id, auth_user_id, email, access_status")
      .ilike("email", ilikeLiteral(from))
      .limit(5);
    if (error) throw new Error(`profile lookup: ${error.message}`);
    return ((rows ?? []) as ProfileLookupRow[]).filter((p) => (p.email ?? "").trim().toLowerCase() === from);
  });
  if (direct) return direct;

  return await profilesByIds(async () => {
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
 * Sender authentication: the From header is trusted only when the inbound
 * path's Authentication-Results do not say it failed. A forged From with
 * dmarc=fail (or spf and dkim both failed) is dropped silently: no upload,
 * no reply. A missing header is treated as pass (residual risk noted in
 * docs/EMAIL-INBOUND.md). Returns the offending header text, or "" when ok.
 */
function senderAuthFailure(email: ReceivedEmail): string {
  const h = lowerKeys(email.headers);
  const auth = (h["authentication-results"] || h["arc-authentication-results"] || "").toLowerCase();
  if (!auth) return "";
  const dmarcFail = /dmarc=fail/.test(auth);
  const spfFail = /spf=(fail|softfail)/.test(auth);
  const dkimFail = /dkim=fail/.test(auth) || !/dkim=pass/.test(auth);
  return dmarcFail || (spfFail && dkimFail) ? auth : "";
}

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
      `This address is not registered to a CredentialDOMD account. Forward from the email on your account, or add this address in Settings and click the link we send here to confirm it.

Open the app: ${APP_URL} (More > Settings > Email)

CredentialDOMD
https://credentialdomd.com`);
  }

  const authFail = senderAuthFailure(email);
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

  if (!profile) {
    return await replyUnregistered(ledgerId, "docs", email, from, FROM_DOCS, replySubject, replyHeaders,
      `This address is not registered to a CredentialDOMD account. Forward the request from the email on your account, or add this address in Settings (More > Settings > Email) and click the link we send here to confirm it.

Open the app: ${APP_URL}

CredentialDOMD
https://credentialdomd.com`);
  }

  const authFail = senderAuthFailure(email);
  if (authFail) {
    await finish(ledgerId, "failed", `sender authentication failed: ${authFail.slice(0, 200)}`);
    return json({ ok: true, route: "docs", result: "rejected_auth" });
  }

  // The original request lives inside the forwarded text.
  const rawText = (email.text && email.text.trim()) ? email.text : (email.html ? stripHtml(email.html) : "");
  const parsed = parseForwarded(rawText);
  const fromAddr = parsed.found ? parsed.from_addr : from;
  let bodyText = parsed.body_text;
  if (!parsed.found) {
    bodyText = `Requester address not found in the forwarded text; edit before replying.\n\n${bodyText}`.trim();
  }
  bodyText = bodyText.slice(0, MAX_REQUEST_BODY_CHARS);
  const requestSubject = parsed.subject ?? (stripFwdPrefix(subject) || null);

  // The requester's checklist PDF, when one rides along (rare).
  const { files, skipped } = await downloadAttachments(emailId, acceptCertificateLike);
  const { stored, failed } = await storeAsDocuments(profile, files, REQUEST_DOC_TYPE);

  const { data: reqRow, error: rErr } = await db.from("document_requests").insert({
    user_id: profile.id,
    from_addr: fromAddr,
    from_name: parsed.found ? parsed.from_name : null,
    subject: requestSubject,
    body_text: bodyText,
    message_id: messageId,
    original_message_id: parsed.original_message_id,
    forwarded_by: from,
    received_at: email.created_at || new Date().toISOString(),
    status: "new",
    inbound_ledger_id: ledgerId,
  }).select("id").single();
  if (rErr) throw new Error(`document_requests insert: ${rErr.message}`);
  const requestId = (reqRow as { id: string }).id;

  const notes: string[] = [];
  if (!parsed.found) notes.push("The requester's address was not found in the forwarded text, so the request is addressed to you for now. Open it and correct the To address before replying.");
  if (stored > 0) notes.push(`${stored} attachment${stored === 1 ? "" : "s"} from the request ${stored === 1 ? "was" : "were"} saved to your Documents.`);
  if (skipped > 0) notes.push(`${skipped} attachment${skipped === 1 ? " was" : "s were"} skipped for size (10 MB per file, 20 MB per email) or count (10 per email).`);
  if (failed > 0) notes.push(`${failed} attachment${failed === 1 ? "" : "s"} could not be saved.`);

  let text = `Got it. The request from ${fromAddr} is in your app under More > Requests. Open it to build the packet and reply by email.`;
  if (notes.length) text += `\n\n${notes.join("\n")}`;
  text += `\n\nOpen the app: ${APP_URL} (More > Requests)\n\nCredentialDOMD\nhttps://credentialdomd.com`;

  const r = await sendEmail({ from: FROM_DOCS, to: [from], subject: replySubject, headers: replyHeaders, text });
  const detail = `request ${requestId}, from ${fromAddr}${parsed.found ? "" : " (requester not found)"}, attachments ${stored}, skipped ${skipped}, failed ${failed}${r.ok ? "" : `, confirmation failed ${r.status}`}`;
  await finish(ledgerId, "done", detail, { attachment_count: stored, profile_id: profile.id });
  return json({ ok: true, route: "docs", request_id: requestId, requester_found: parsed.found, stored, skipped, failed, confirmed: r.ok });
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
  const route: Route = local === CME_LOCAL ? "cme" : DOCS_LOCALS.has(local) ? "docs" : "forward";

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
    return await handleForward(ledgerId, emailId, from, ourAddr, subject, messageId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`inbound ${emailId} (${route}) failed: ${msg}`);
    await finish(ledgerId, "failed", msg);
    return json({ error: "processing failed" }, 500);
  }
});
