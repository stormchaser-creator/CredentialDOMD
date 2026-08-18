/**
 * send-packet-email: email a packet of the physician's documents to a
 * credentialer, optionally as the reply to a document_requests row.
 *
 * POST { request_id?: uuid, to: string, cc_self?: boolean, subject: string,
 *        text: string, doc_ids: string[] }
 *   -> { ok: true, email_id, attached: n, skipped: [filenames] } | { error }
 *
 * Auth: Clerk JWT verified in _shared/clerkAuth.ts (deploy with
 * --no-verify-jwt; the gateway cannot check Clerk RS256 tokens). Identity is
 * profiles.id; every doc_id must belong to it (403 otherwise) and request_id,
 * when given, must too.
 *
 * Mail: from "<name>, <degree> via CredentialDOMD <docs@credentialdomd.com>"
 * (degree omitted when empty; "CredentialDOMD" when the name is empty),
 * reply_to = profiles.email (400 when empty), cc = physician when cc_self,
 * In-Reply-To / References from the request's original_message_id or
 * message_id, attachments pulled from Storage bucket "documents" with the
 * service role. Caps: 10 files, 25 MB total after base64 (extras skipped and
 * reported), subject 200 chars, text 5000 chars, 30 sends per hour per user
 * (share_log rows with method = 'email').
 *
 * Side effects on success: document_requests -> status 'replied', replied_at,
 * reply_email_id, doc_ids (when request_id given); share_log row always.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import { isOwnStorageObject } from "../_shared/storagePath.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_API = (Deno.env.get("RESEND_API_BASE") ?? "https://api.resend.com").replace(/\/$/, "");
const DOCS_ADDR = "docs@credentialdomd.com";
const STORAGE_BUCKET = "documents";

const MAX_FILES = 10;
const MAX_TOTAL_B64_BYTES = 25 * 1024 * 1024;
const MAX_SUBJECT = 200;
const MAX_TEXT = 5000;
const SENDS_PER_HOUR = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']{2,}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** Header-safe display text: no line breaks, quotes or angle brackets. */
function cleanHeaderText(s: string | null | undefined, max = 80): string {
  return String(s ?? "").replace(/[\r\n"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** RFC 5322 display name; quoted because it contains a comma. */
function fromHeader(name: string, degree: string): string {
  const display = name ? `${name}${degree ? `, ${degree}` : ""} via CredentialDOMD` : "CredentialDOMD";
  return `"${display}" <${DOCS_ADDR}>`;
}

function safeFilename(name: string | null | undefined, fallback: string): string {
  // deno-lint-ignore no-control-regex
  const n = String(name ?? "").trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 180);
  return n || fallback;
}

function guessMime(filename: string, fallback: string): string {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain", csv: "text/csv",
  };
  return map[ext] ?? fallback;
}

/** Give a second "DEA.pdf" the name "DEA (2).pdf" so the recipient can tell them apart. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 100; n++) {
    const cand = `${base} (${n})${ext}`;
    if (!taken.has(cand.toLowerCase())) { taken.add(cand.toLowerCase()); return cand; }
  }
  return `${base} (${crypto.randomUUID().slice(0, 8)})${ext}`;
}

async function sendEmail(payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: string }> {
  const r = await fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await r.text();
  if (!r.ok) console.error("resend send failed:", r.status, body.slice(0, 300));
  return { ok: r.ok, status: r.status, body };
}

interface DocRow {
  id: string;
  user_id: string;
  name: string | null;
  mime_type: string | null;
  type: string | null;
  storage_path: string | null;
  size_bytes: number | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!RESEND_API_KEY) return json(500, { error: "Email is not configured" });

  const who = await clerkProfile(req);
  if (!who) return json(401, { error: "Not signed in" });
  const db = who.db;

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { return json(400, { error: "Bad JSON" }); }

  const to = String(body.to ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return json(400, { error: "Enter a valid recipient email address" });
  if (/@(?:[a-z0-9-]+\.)*credentialdomd\.com$/.test(to)) return json(400, { error: "That is a CredentialDOMD address. Enter the requester's email." });
  const subject = String(body.subject ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!subject) return json(400, { error: "Subject is required" });
  if (subject.length > MAX_SUBJECT) return json(400, { error: `Subject is limited to ${MAX_SUBJECT} characters` });
  const text = String(body.text ?? "").replace(/\r\n?/g, "\n").trim();
  if (text.length > MAX_TEXT) return json(400, { error: `Cover note is limited to ${MAX_TEXT} characters` });
  const ccSelf = body.cc_self === true;
  const requestId = body.request_id == null || body.request_id === "" ? null : String(body.request_id);
  if (requestId && !UUID_RE.test(requestId)) return json(400, { error: "request_id is not a valid id" });
  if (!Array.isArray(body.doc_ids)) return json(400, { error: "doc_ids must be an array" });
  const docIds: string[] = [];
  for (const d of body.doc_ids) {
    const s = String(d ?? "").trim();
    if (!UUID_RE.test(s)) return json(400, { error: "doc_ids contains an invalid id" });
    if (!docIds.includes(s)) docIds.push(s);
  }
  // An empty doc_ids is allowed: a reply with no attachment ("nothing else on
  // file, the rest follows next week") is still a legitimate answer.

  try {
    // Sender identity.
    const { data: prof, error: pErr } = await db.from("profiles")
      .select("id, name, degree_type, email, auth_user_id")
      .eq("id", who.profileId).maybeSingle();
    if (pErr) throw pErr;
    if (!prof) return json(401, { error: "Not signed in" });
    const physEmail = String(prof.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(physEmail)) return json(400, { error: "Add your email in Settings first" });
    const name = cleanHeaderText(prof.name);
    const degree = cleanHeaderText(prof.degree_type, 20);
    const displayName = name || physEmail;

    // Rate cap: 30 email sends per hour per user, counted in share_log.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: sentRecently, error: cErr } = await db.from("share_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", who.profileId).eq("method", "email").gte("sent_at", since);
    if (cErr) throw cErr;
    if ((sentRecently ?? 0) >= SENDS_PER_HOUR) {
      return json(429, { error: `Send limit reached (${SENDS_PER_HOUR} emails per hour). Try again later.` });
    }

    // The request being answered, when any. Must be the caller's.
    let request: { id: string; message_id: string | null; original_message_id: string | null } | null = null;
    if (requestId) {
      const { data: reqRow, error: rErr } = await db.from("document_requests")
        .select("id, user_id, message_id, original_message_id")
        .eq("id", requestId).maybeSingle();
      if (rErr) throw rErr;
      if (!reqRow || reqRow.user_id !== who.profileId) return json(403, { error: "That request is not in your account" });
      request = reqRow;
    }

    // Documents: every id must be the caller's.
    const { data: docRows, error: dErr } = await db.from("documents")
      .select("id, user_id, name, mime_type, type, storage_path, size_bytes")
      .in("id", docIds);
    if (dErr) throw dErr;
    const byId = new Map<string, DocRow>();
    for (const d of (docRows ?? []) as DocRow[]) byId.set(d.id, d);
    for (const id of docIds) {
      const d = byId.get(id);
      if (!d || d.user_id !== who.profileId) return json(403, { error: "One or more documents are not in your account" });
    }

    // Pull bytes from Storage in the caller's order, within the caps.
    const attachments: { filename: string; content: string; content_type: string }[] = [];
    const attachedIds: string[] = [];
    const skipped: string[] = [];
    const taken = new Set<string>();
    let totalB64 = 0;
    for (const id of docIds) {
      const d = byId.get(id)!;
      const filename = safeFilename(d.name, `document-${attachments.length + 1}`);
      if (attachments.length >= MAX_FILES) { skipped.push(filename); continue; }
      // Only files inside the caller's own storage folder are ever read: a
      // user can edit their own row's storage_path, and the service role
      // must not become a way around storage RLS.
      const path = d.storage_path || (prof.auth_user_id ? `${prof.auth_user_id}/${d.id}` : "");
      if (!isOwnStorageObject(prof.auth_user_id, path)) { skipped.push(filename); continue; }
      const dl = await db.storage.from(STORAGE_BUCKET).download(path);
      if (dl.error || !dl.data) {
        console.error(`storage download failed for ${path}: ${dl.error?.message ?? "no data"}`);
        skipped.push(filename);
        continue;
      }
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      if (bytes.byteLength === 0) { skipped.push(filename); continue; }
      const b64 = encodeBase64(bytes);
      if (totalB64 + b64.length > MAX_TOTAL_B64_BYTES) { skipped.push(filename); continue; }
      totalB64 += b64.length;
      const mimeFromRow = (d.mime_type && d.mime_type.includes("/")) ? d.mime_type
        : (d.type && d.type.includes("/")) ? d.type : "";
      const content_type = mimeFromRow || guessMime(filename, dl.data.type || "application/octet-stream");
      attachments.push({ filename: uniqueName(filename, taken), content: b64, content_type });
      attachedIds.push(id);
    }
    if (docIds.length > 0 && attachments.length === 0) {
      return json(400, { error: "None of the chosen documents could be attached (missing file, or all over the 25 MB limit)", skipped });
    }

    // Threading, when the request carries a message id.
    const threadId = request?.original_message_id || request?.message_id || "";
    const headers: Record<string, string> = {};
    if (threadId && !threadId.startsWith("resend:")) {
      const mid = threadId.startsWith("<") ? threadId : `<${threadId}>`;
      headers["In-Reply-To"] = mid;
      headers["References"] = mid;
    }

    const footer = `Sent from CredentialDOMD on behalf of ${displayName}. Reply to this email to reach ${displayName} directly.`;
    const fullText = `${text ? `${text}\n\n` : ""}${footer}`;

    const payload: Record<string, unknown> = {
      from: fromHeader(name, degree),
      to: [to],
      reply_to: [physEmail],
      subject: subject.slice(0, MAX_SUBJECT),
      text: fullText,
    };
    if (attachments.length) payload.attachments = attachments;
    if (ccSelf) payload.cc = [physEmail];
    if (Object.keys(headers).length) payload.headers = headers;

    const r = await sendEmail(payload);
    if (!r.ok) return json(502, { error: "Email failed to send. Try again in a minute." });
    let emailId: string | null = null;
    try { emailId = (JSON.parse(r.body) as { id?: string }).id ?? null; } catch { /* body not JSON */ }

    const now = new Date().toISOString();
    if (request) {
      const { error: uErr } = await db.from("document_requests")
        .update({ status: "replied", replied_at: now, reply_email_id: emailId, doc_ids: attachedIds, updated_at: now })
        .eq("id", request.id).eq("user_id", who.profileId);
      if (uErr) console.error("document_requests update failed:", uErr.message);
    }
    const { error: lErr } = await db.from("share_log").insert({
      user_id: who.profileId,
      item_name: `Email packet (${attachments.length} file${attachments.length === 1 ? "" : "s"})`,
      section: "documents",
      method: "email",
      recipient: to,
      sent_at: now,
      item_id: null,
    });
    if (lErr) console.error("share_log insert failed:", lErr.message);

    return json(200, { ok: true, email_id: emailId, attached: attachments.length, skipped });
  } catch (e) {
    console.error("send-packet-email failed:", e instanceof Error ? e.message : String(e));
    return json(500, { error: "Could not send the packet. Try again." });
  }
});
