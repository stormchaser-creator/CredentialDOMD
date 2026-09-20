/**
 * send-packet-email: email a packet of the physician's documents to a
 * credentialer, optionally as the reply to a document_requests row.
 *
 * Two ways in, one send path:
 *
 *   Hand-built   POST { request_id?: uuid, to: string, cc_self?: boolean,
 *                       subject: string, text: string, doc_ids: string[] }
 *     The modal: the physician chose everything.
 *
 *   Approve      POST { request_id: uuid, approve: true, cc_self?: boolean,
 *                       subject?: string, text?: string, doc_ids?: uuid[] }
 *     The one tap behind "Approve and send". The request row supplies the
 *     recipient (from_addr); doc_ids and text are what the app showed the
 *     physician (the app rebuilds a proposal on the client when the file has
 *     changed and saves it back without waiting, so the row can lag the
 *     screen), and the stored proposal (proposal.docIds, proposal.coverNote,
 *     built by email-inbound on arrival) stands in only when they are
 *     absent. Subject defaults to "Re: <request subject>" with the stored
 *     Re:/Fwd: prefixes peeled, and cc_self defaults on, so the physician
 *     holds a copy of what went out in their name. A proposed document that
 *     no longer resolves to the caller's account (deleted since the proposal
 *     was built) is skipped and reported, not refused: the list came from
 *     the caller's own proposal. Refused (400/403) when the request is not
 *     the caller's, was dismissed, has nothing to attach, or when from_addr
 *     is the physician's own sending address (profile email, forwarding
 *     sender, or any confirmed forwarding address): that means the forward
 *     carried no From: line and the address is a placeholder, and sending
 *     would mail the packet back to the physician. Validation lives in
 *     _shared/requestFlow.ts (approveRequestBody) so it can be tested.
 *     reply_to is the forwarding sender when that is a confirmed address
 *     other than the profile email, the same rule as the acknowledgement.
 *
 *     Text-only: doc_ids may be [] when the stored proposal has at least one
 *     item (every ask "not on file", say), or when the call carries a
 *     non-empty text of its own. The note goes with no attachment and the
 *     documents query is skipped. A proposal with no items and no note is
 *     refused: there is nothing the physician could have approved. The note
 *     counts because the row can hold no proposal at all while the screen
 *     shows one: the app rebuilds a proposal on the client when the server
 *     matcher threw (or the row predates it), writes it back once, and never
 *     retries a failed write until the file changes. The button then read
 *     "Send reply (nothing to attach)" over a note the physician could see,
 *     and every tap answered "Nothing is proposed for this request yet. Open
 *     it and choose the documents" on the very screen that is the request,
 *     with nothing to choose. The text the screen showed is what the approve
 *     path already trusts for doc_ids; it is trusted for the note too.
 *
 *     Stale note: when a proposed document was skipped as no longer on file
 *     AND the text being sent is the stored proposal.coverNote word for word,
 *     the send is refused (400) before anything is claimed. That note lists
 *     the document as attached; sending it with the file missing told a
 *     credentialer to look for an attachment that was not there. A note the
 *     client wrote (different from the stored one) is taken as deliberate.
 *
 *     Sent once. Two devices show the same button, and a tap on a slow
 *     network gets retried, so before any bytes are fetched the row is
 *     CLAIMED: update status -> 'replied' where status = 'new', and only the
 *     caller who moves the row gets to send. The loser gets 409 "Already
 *     sent on <date>" and the one next step. If the send then fails for
 *     certain (Resend refused, nothing could be attached, storage gone) the
 *     claim is handed back (status 'new', replied_at null) so the button
 *     works again, but only while the row still holds this call's own claim
 *     (status 'replied', replied_at as stamped): a "Reply again by email"
 *     from another device can complete the row in between, and a hand-back
 *     filtered on id alone once undid it. A send whose outcome is UNKNOWN
 *     keeps the claim: when the
 *     POST to Resend throws (the connection dropped after the body went out,
 *     an edge timeout) the packet may already be on its way, and for a while
 *     the catch-all released the claim on that throw too, so the button came
 *     back live under "Try again" and a second tap mailed the credentialer
 *     the whole packet twice, the second send holding the only record. Now
 *     the row is completed as replied with no reply_email_id, the share_log
 *     row is written so the physician has a record of it (the hourly cap no
 *     longer counts share_log; the reservation was taken before the send, so
 *     an unconfirmed send is already counted), and the response is 502
 *     "The send could not be confirmed" naming the Replied tab. email-inbound
 *     treats its acknowledgement the same way (the stamp stays on a throw).
 *     The hand-built path does not claim: a row already 'replied' is exactly
 *     what "Reply again by email" sends from, on purpose, so a second copy
 *     is always one deliberate step away.
 *
 *   -> { ok: true, email_id, attached: n, skipped: [filenames], to } | { error }
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
 * (reservations in public.send_reservations, see below).
 *
 * The hourly cap counts a ledger the sender cannot edit. It used to count
 * share_log rows with method = 'email', and share_log's only policy,
 * share_log_owner, is FOR ALL to authenticated on the caller's own rows, so
 * DELETE is included: the account the cap bounds could delete its own
 * share_log rows through PostgREST and the next count started at zero. The
 * count now runs against public.send_reservations, which has RLS on, no
 * policy and no grants, so only the service role writes or reads it. The
 * count and the insert are one statement inside reserve_send() behind a
 * per-user advisory lock, so two taps arriving together cannot both pass the
 * boundary. share_log is unchanged and stays the physician-facing history.
 * A genuine over-cap answer refuses with 429 and code send_cap_reached. A
 * reservation that could not be taken at all (migration not applied, RPC
 * error) ALSO refuses, with 429, code send_ledger_unavailable and a
 * Retry-After: nothing was fetched, claimed or mailed, so the caller can just
 * try again. An earlier version sent anyway on that branch, which made "break
 * the ledger" the cheapest route to an unmetered send budget over our sending
 * domain; see sendReservationVerdict.
 *
 * Side effects on success: document_requests -> status 'replied', replied_at,
 * reply_email_id, doc_ids (when request_id given); share_log row always. On
 * the approve path status and replied_at are written first as the claim and
 * completed after the send; a refused send puts them back, an unconfirmed
 * one completes them with reply_email_id null.
 *
 * No test script drives the whole function (it needs Clerk, Storage and
 * Resend); the rules it shares with the app live in _shared/requestFlow.ts and
 * are tested there. The throttle's two decisions are pure and exported
 * (sendWindowStart, sendReservationVerdict) and scripts/send-throttle.test.mjs
 * imports THIS file for them. The text-only rule above is exercised by the
 * app's "Send reply (nothing to attach)" button.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import { isOwnStorageObjectForSubjects } from "../_shared/storagePath.ts";
import { storageSubjects } from "../_shared/clerkContinuity.ts";
import { approveRequestBody, longDate, replySubject } from "../_shared/requestFlow.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_API = (Deno.env.get("RESEND_API_BASE") ?? "https://api.resend.com").replace(/\/$/, "");
const DOCS_ADDR = "docs@credentialdomd.com";
const STORAGE_BUCKET = "documents";

const MAX_FILES = 10;
const MAX_TOTAL_B64_BYTES = 25 * 1024 * 1024;
const MAX_SUBJECT = 200;
const MAX_TEXT = 5000;
export const SENDS_PER_HOUR = 30;
// The window the cap counts over. The boundary is computed here rather than
// with now() in SQL so the arithmetic is testable, and because the old
// share_log count compared sent_at against exactly this value: nothing about
// the window changes, only which table the rows are counted in.
export const SEND_WINDOW_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']{2,}$/;
// The approve path's cover note when the proposal carries none. Same words
// as the modal's default, so the two paths read alike to a credentialer.
const DEFAULT_NOTE = "Please find the requested documents attached. Let me know if anything else is needed.";

/** The two recipient rules, one place, so the approve path cannot drift from the hand-built one. */
function recipientProblem(to: string): string | null {
  if (!EMAIL_RE.test(to)) return "Enter a valid recipient email address";
  if (/@(?:[a-z0-9-]+\.)*credentialdomd\.com$/.test(to)) return "That is a CredentialDOMD address. Enter the requester's email.";
  return null;
}

/**
 * The instant the send window opens, as an ISO string: a reservation at or
 * after it counts against the cap, one before it does not. Passed to
 * reserve_send as p_since.
 *
 * Exported and pure because it is half of the throttle and the other half is
 * a SQL statement no unit test can run. A bad boundary here is a cap that
 * counts the wrong hour, which is exactly the kind of thing that looks right
 * in review and is wrong in production.
 */
export function sendWindowStart(now: number | string | Date = Date.now(), windowMs: number = SEND_WINDOW_MS): string {
  const raw = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(String(now));
  const base = Number.isFinite(raw) ? raw : Date.now();
  const span = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : SEND_WINDOW_MS;
  return new Date(base - span).toISOString();
}

/**
 * Read reserve_send's answer.
 *
 * Three outcomes:
 *
 *   reserved        a row came back. The caller is under the cap; send.
 *   over cap        the RPC ran and returned NO row (null, or an empty array
 *                   for a client shape that wraps scalars). The count and the
 *                   insert happened in one statement, so "no row" IS the
 *                   over-cap answer and there is no second number to disagree
 *                   with it. 429, as before.
 *   unavailable     the RPC itself failed: the migration has not been applied
 *                   so the function or the table is missing, PostgREST has not
 *                   reloaded its schema, the call threw.
 *
 * THE THIRD ONE USED TO SEND ANYWAY, and that was wrong. The reasoning was
 * that this function is how a physician answers a credentialer holding up a
 * start date, so a throttle failing on its own plumbing should not become a
 * physician who cannot answer their email. But the throttle is not a comfort
 * feature. It bounds how much mail one account can send over our sending
 * domain with a physician's name in the From: header, and Clerk sign-up is
 * open, so "signed in" is not a trust boundary. Fail-open means the cheapest
 * way to get an unlimited send budget is to make the ledger unavailable, which
 * is a smaller thing to arrange than it sounds: this branch fires on a missing
 * migration, and it fires on every RPC error, including ones a caller can
 * provoke.
 *
 * The honest answer to "our ledger is down" is not yes, and it is not a
 * permanent no either. It is a refusal with a code and a Retry-After: the send
 * did not happen, nothing was charged, nothing was mailed, and trying again in
 * a minute is likely to work. That keeps the failure visible to the operator
 * (this is also the shape of "the migration has not been applied yet") instead
 * of hiding it behind traffic that went out unmetered.
 *
 * The status is 429 rather than 503, and it was 503 for one day. Two reasons
 * it moved. A 503 from an edge function is also what the platform answers
 * when the function itself did not boot, so a caller cannot tell "this
 * function refused you" from "this function is not there"; a 429 with a
 * Retry-After is unambiguously a refusal this code wrote. And the batch that
 * added this refusal added a matching one to ai-proxy, where 503 is the exact
 * status an already-installed PWA bundle reads as "the shared key is not
 * configured" and acts on by switching the feature off for good. One rule
 * across both, "a refusal that clears by itself is never a 503", is worth
 * more than each function reasoning about its own callers. The code in the
 * body, not the status, is what a client should branch on.
 *
 * `send` is the only field the handler branches on for whether to continue;
 * `status`, `code` and `error` are what it answers with. Kept pure (it takes
 * the { data, error } object, not the client) so all three are testable
 * without a database, and so scripts/send-throttle.test.mjs can assert the
 * thing that matters most: on this branch the provider is never called.
 */
export const SEND_CAP_CODE = "send_cap_reached";
export const SEND_LEDGER_UNAVAILABLE_CODE = "send_ledger_unavailable";

export interface ReservationVerdict {
  /** Continue with the send. False means answer with status/code and stop. */
  send: boolean;
  overCap: boolean;
  /** The ledger could not answer. Distinct from over-cap on purpose. */
  infrastructure: boolean;
  status: number;
  code: string;
  /** What the caller is told. Empty when the send proceeds. */
  error: string;
  /** What the log records. Never shown to the caller. */
  why: string;
  /** Seconds to wait before retrying; set on the ledger refusal only. */
  retryAfter: number | null;
}

const LEDGER_UNAVAILABLE: Omit<ReservationVerdict, "why"> = {
  send: false,
  overCap: false,
  infrastructure: true,
  status: 429,
  code: SEND_LEDGER_UNAVAILABLE_CODE,
  error: "The send could not be recorded just now, so nothing was sent. Try again in a minute.",
  retryAfter: 60,
};

export function sendReservationVerdict(
  result: { data?: unknown; error?: unknown } | null | undefined,
): ReservationVerdict {
  if (!result) return { ...LEDGER_UNAVAILABLE, why: "no result from reserve_send" };
  if (result.error) {
    const e = result.error as { message?: unknown };
    const why = typeof e?.message === "string" && e.message ? e.message : String(result.error);
    return { ...LEDGER_UNAVAILABLE, why };
  }
  const data = result.data;
  // An empty array and a null are the same answer: the INSERT ... SELECT
  // matched nothing because the window was full.
  if (data == null || (Array.isArray(data) && data.length === 0)) {
    return {
      send: false, overCap: true, infrastructure: false,
      status: 429, code: SEND_CAP_CODE,
      error: `Send limit reached (${SENDS_PER_HOUR} emails per hour). Try again later.`,
      why: "at or over the hourly cap", retryAfter: null,
    };
  }
  return {
    send: true, overCap: false, infrastructure: false,
    status: 200, code: "reserved", error: "", why: "reserved", retryAfter: null,
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown, extraHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...(extraHeaders ?? {}) },
  });

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

// Three outcomes, not two. `unknown` is the POST throwing before Resend
// answered: the request may have been transmitted in full, so the email may
// exist, and the caller must not treat it as a refusal (see the header). A
// response whose status arrived but whose body could not be read is not
// unknown: the status says whether Resend accepted the message, only the id
// is lost.
type SendOutcome =
  | { ok: true; unknown: false; status: number; body: string }
  | { ok: false; unknown: false; status: number; body: string }
  | { ok: false; unknown: true };

async function sendEmail(payload: Record<string, unknown>): Promise<SendOutcome> {
  let r: Response;
  try {
    r = await fetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("resend send: no answer:", err instanceof Error ? err.message : String(err));
    return { ok: false, unknown: true };
  }
  let body = "";
  try {
    body = await r.text();
  } catch (err) {
    console.error("resend send: body unreadable:", r.status, err instanceof Error ? err.message : String(err));
  }
  if (!r.ok) {
    console.error("resend send failed:", r.status, body.slice(0, 300));
    return { ok: false, unknown: false, status: r.status, body };
  }
  return { ok: true, unknown: false, status: r.status, body };
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

  // Two ways in. The hand-built path carries everything and is checked here,
  // before any lookup, exactly as it always was. The approve path carries the
  // request id and its overrides; recipient, attachments and note come off
  // the stored proposal, so the rest of its checks wait until the row and the
  // physician's own address are loaded.
  let approve: { requestId: string; ccSelf: boolean; subjectOverride: string | null; textOverride: string | null; docIds: string[] | null } | null = null;
  let to = "";
  let subject = "";
  let text = "";
  let ccSelf = false;
  let requestId: string | null = null;
  const docIds: string[] = [];
  if (body.approve === true) {
    const v = approveRequestBody(body);
    if (!v.ok) return json(400, { error: v.error });
    approve = v;
    requestId = v.requestId;
  } else {
    to = String(body.to ?? "").trim().toLowerCase();
    const bad = recipientProblem(to);
    if (bad) return json(400, { error: bad });
    subject = String(body.subject ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!subject) return json(400, { error: "Subject is required" });
    if (subject.length > MAX_SUBJECT) return json(400, { error: `Subject is limited to ${MAX_SUBJECT} characters` });
    text = String(body.text ?? "").replace(/\r\n?/g, "\n").trim();
    if (text.length > MAX_TEXT) return json(400, { error: `Cover note is limited to ${MAX_TEXT} characters` });
    ccSelf = body.cc_self === true;
    requestId = body.request_id == null || body.request_id === "" ? null : String(body.request_id);
    if (requestId && !UUID_RE.test(requestId)) return json(400, { error: "request_id is not a valid id" });
    if (!Array.isArray(body.doc_ids)) return json(400, { error: "doc_ids must be an array" });
    for (const d of body.doc_ids) {
      const s = String(d ?? "").trim();
      if (!UUID_RE.test(s)) return json(400, { error: "doc_ids contains an invalid id" });
      if (!docIds.includes(s)) docIds.push(s);
    }
    // An empty doc_ids is allowed: a reply with no attachment ("nothing else on
    // file, the rest follows next week") is still a legitimate answer.
  }

  // Once the approve path has claimed its row (below), every exit after that
  // point that did not send must hand the row back, or the button dies on a
  // request nobody ever answered. Declared here so the catch-all can do it.
  let claimedId: string | null = null;
  // The replied_at the claim stamped. The release is conditional on it: the
  // hand-built path sends from a 'replied' row on purpose ("Reply again by
  // email") and writes status, replied_at and reply_email_id without
  // claiming, so it can land on this row between the claim and a refused
  // send. A release filtered on id alone then put that row back to 'new'
  // with the sent packet's reply_email_id still on it: the button came back
  // live over documents the credentialer already had, and the Replied tab
  // lost the record.
  let claimAt: string | null = null;
  // Set immediately before the POST to Resend. An exception after that
  // point may have a sent email behind it, and the catch-all must leave the
  // claim where it is (see the header on unknown outcomes).
  let sendAttempted = false;
  const releaseClaim = async () => {
    if (!claimedId || !claimAt) return;
    const id = claimedId, at = claimAt;
    claimedId = null;
    claimAt = null;
    const { data, error } = await db.from("document_requests")
      .update({ status: "new", replied_at: null, updated_at: new Date().toISOString() })
      .eq("id", id).eq("status", "replied").eq("replied_at", at).select("id");
    if (error) console.error("document_requests claim release failed:", error.message);
    // Zero rows: another send wrote the row since the claim, and what it
    // wrote stands.
    else if (!data || data.length === 0) console.error(`document_requests claim release skipped for ${id}: the row was written by another send`);
  };

  try {
    // Sender identity.
    const { data: prof, error: pErr } = await db.from("profiles")
      .select("id, name, degree_type, email, verified_email, auth_user_id")
      .eq("id", who.profileId).maybeSingle();
    if (pErr) throw pErr;
    if (!prof) return json(401, { error: "Not signed in" });
    const ownedStorageSubjects = await storageSubjects(db, who.profileId);
    const physEmail = String(prof.email ?? "").trim().toLowerCase();
    // The mailbox the sign-in provider verified. profiles.email is typed in
    // Settings and is often not the address the physician actually reads mail
    // at; verified_email is the one clerk-webhook stamped and the one
    // email-inbound routes on, so it is just as much "their own address" as
    // the profile email and the confirmed forwarding rows. It belongs in the
    // own-address set below. See the note there.
    const verifiedEmail = String(prof.verified_email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(physEmail)) return json(400, { error: "Add your email in Settings first" });
    const name = cleanHeaderText(prof.name);
    const degree = cleanHeaderText(prof.degree_type, 20);
    const displayName = name || physEmail;
    let replyTo = physEmail;

    // Approve and send: the row supplies the recipient, the call (or, for an
    // older client, the stored proposal) the attachments and the note.
    // Loaded before the rate cap so a request that cannot be sent is named
    // as such rather than counted against the hour.
    let request: { id: string; message_id: string | null; original_message_id: string | null } | null = null;
    // The stored cover note, normalised the way text is, for the stale-note
    // check once the documents have been resolved. "" when there is none.
    let storedCoverNote = "";
    if (approve) {
      const { data: row, error: rErr } = await db.from("document_requests")
        .select("id, user_id, from_addr, forwarded_by, subject, message_id, original_message_id, status, proposal")
        .eq("id", approve.requestId).maybeSingle();
      if (rErr) throw rErr;
      if (!row || row.user_id !== who.profileId) return json(403, { error: "That request is not in your account" });
      if (row.status === "dismissed") return json(400, { error: "That request was dismissed. Move it back to New before sending." });
      const proposal = (row.proposal ?? null) as { items?: unknown; docIds?: unknown; coverNote?: unknown } | null;
      const proposalItems = Array.isArray(proposal?.items) ? proposal.items.length : 0;
      // What the screen showed wins over what the row holds: the app
      // rebuilds a proposal on the client when the file has changed and
      // writes it back without waiting, so a tap can land before the write.
      // An empty list is a text-only reply and goes when the proposal has
      // at least one item (everything asked for was "not on file", and the
      // note says so) or when the call carries a note of its own (the row
      // holds no proposal, the screen does, and the note is what the screen
      // showed); with no items and no note there was nothing to approve.
      const proposed = approve.docIds ?? (Array.isArray(proposal?.docIds) ? proposal.docIds : []);
      if (proposed.length === 0 && proposalItems === 0 && !approve.textOverride) {
        return json(400, { error: "Nothing is proposed for this request yet. Open it and choose the documents." });
      }
      for (const d of proposed) {
        const s = String(d ?? "").trim();
        if (!UUID_RE.test(s)) return json(400, { error: "The proposal holds an invalid document id. Open the request and choose the documents." });
        if (!docIds.includes(s)) docIds.push(s);
      }
      to = String(row.from_addr ?? "").trim().toLowerCase();
      // When the forward carried no parseable From: line, email-inbound stored
      // the physician's own sending address as a placeholder (the profile
      // address, or a confirmed forwarding address). Approving would mail the
      // packet straight back to them. The confirmed addresses are loaded so
      // a request whose topmost From: was the physician's own hospital
      // account (they mailed themselves the checklist) is caught too.
      const forwardedBy = String(row.forwarded_by ?? "").trim().toLowerCase();
      const { data: fwdRows, error: fErr } = await db.from("forwarding_addresses")
        .select("email, verified_at").eq("user_id", who.profileId).not("verified_at", "is", null);
      if (fErr) throw fErr;
      const ownAddresses = new Set(((fwdRows ?? []) as { email: string | null }[])
        .map((r) => String(r.email ?? "").trim().toLowerCase()).filter(Boolean));
      // The provider-verified mailbox is one of the physician's own addresses
      // and was missing from this set. email-inbound already folds it into the
      // matching set it suppresses acknowledgements on (index.ts, `if
      // (profile.verified_email) own.add(...)`); the symmetric guard here was
      // not updated when verified_email became a first-class mailbox, and it
      // is the COMMON case, not an exotic one: migration 20260915d measured
      // five of six live accounts getting their only proven mailbox from the
      // Clerk stamp. Without this line a physician who mails themselves a
      // credentialing checklist from their hospital account and forwards it in
      // from a confirmed clinic address passes the test below, and Approve
      // mails the DEA, licence and CV packet back to their own inbox while
      // stamping the request 'replied'. The credentialer gets nothing and the
      // app shows the request answered.
      if (verifiedEmail) ownAddresses.add(verifiedEmail);
      if (to === physEmail || (forwardedBy && to === forwardedBy) || ownAddresses.has(to)) {
        return json(400, { error: "The requester's address was not found in the forwarded email. Open the request and enter it under Requester's email." });
      }
      const bad = recipientProblem(to);
      if (bad) return json(400, { error: bad });
      subject = (approve.subjectOverride || (row.subject ? replySubject(String(row.subject)) : `Credential documents from ${displayName}`))
        .replace(/[\r\n]+/g, " ").trim().slice(0, MAX_SUBJECT);
      const storedNote = proposal ? proposal.coverNote : null;
      const coverNote = typeof storedNote === "string" ? storedNote.replace(/\r\n?/g, "\n").trim() : "";
      storedCoverNote = coverNote;
      // An explicit empty text is an empty note (the physician cleared the
      // box); only an absent text falls back to the stored one.
      text = (approve.textOverride ?? (coverNote || DEFAULT_NOTE)).slice(0, MAX_TEXT);
      ccSelf = approve.ccSelf;
      // Reply where the credentialer already writes: the confirmed address
      // the request was forwarded from, when it is not the profile email.
      if (forwardedBy && forwardedBy !== physEmail && ownAddresses.has(forwardedBy)) replyTo = forwardedBy;
      request = { id: row.id, message_id: row.message_id ?? null, original_message_id: row.original_message_id ?? null };
    }

    // Rate cap: 30 email sends per hour per user. The reservation is taken
    // here, before a single byte is fetched and before the row is claimed,
    // and it is taken from public.send_reservations, which the physician
    // cannot read, write or delete. The old count ran against share_log,
    // whose only policy is FOR ALL to authenticated on the caller's own rows,
    // so the account the cap bounds could delete the rows it was counted from
    // and start the hour over. reserve_send counts and inserts in one
    // statement behind a per-user advisory lock, so two taps at the boundary
    // cannot both pass.
    //
    // A refusal further down (documents gone, Resend refused) keeps its
    // reservation. That is what a ledger of attempts means, and handing the
    // caller a way to give a reservation back is the hole this closes.
    let reservation: { data?: unknown; error?: unknown };
    try {
      reservation = await db.rpc("reserve_send", {
        p_user: who.profileId,
        p_limit: SENDS_PER_HOUR,
        p_since: sendWindowStart(),
      });
    } catch (e) {
      reservation = { error: e };
    }
    const verdict = sendReservationVerdict(reservation);
    if (!verdict.send) {
      if (verdict.infrastructure) {
        // Visible on purpose. The most likely cause is
        // 20260915e_send_reservations.sql not being applied yet, and a
        // deployment ordering mistake should look like a loud refusal in the
        // log rather than like unmetered mail going out. The log is where it
        // is loud; the answer to the caller is a plain retryable 429.
        console.error(`send throttle: reservation unavailable, refusing: ${verdict.why}`);
      }
      // Nothing has been fetched, claimed or mailed at this point: the
      // reservation is taken before the documents are read and long before
      // Resend is called, so a refusal here costs the provider nothing.
      return json(verdict.status, { error: verdict.error, code: verdict.code },
        verdict.retryAfter ? { "Retry-After": String(verdict.retryAfter) } : undefined);
    }

    // The request being answered, when any. Must be the caller's. (The
    // approve path loaded and checked its row above.)
    if (requestId && !request) {
      const { data: reqRow, error: rErr } = await db.from("document_requests")
        .select("id, user_id, message_id, original_message_id")
        .eq("id", requestId).maybeSingle();
      if (rErr) throw rErr;
      if (!reqRow || reqRow.user_id !== who.profileId) return json(403, { error: "That request is not in your account" });
      request = reqRow;
    }

    // Documents: every id must be the caller's. On the approve path an id
    // that no longer resolves is skipped, not refused: the list came from the
    // caller's own proposal, and a document deleted since it was built is
    // "not attached", which the response says, rather than "not in your
    // account", which was wrong on its face and left no next step.
    const byId = new Map<string, DocRow>();
    if (docIds.length > 0) {
      // A text-only reply has nothing to look up; .in("id", []) is not a
      // query worth sending.
      const { data: docRows, error: dErr } = await db.from("documents")
        .select("id, user_id, name, mime_type, type, storage_path, size_bytes")
        .in("id", docIds);
      if (dErr) throw dErr;
      for (const d of (docRows ?? []) as DocRow[]) byId.set(d.id, d);
    }
    const skipped: string[] = [];
    const sendIds: string[] = [];
    let goneFromFile = 0;
    for (const id of docIds) {
      const d = byId.get(id);
      if (!d || d.user_id !== who.profileId) {
        if (!approve) return json(403, { error: "One or more documents are not in your account" });
        skipped.push("a document no longer on file");
        goneFromFile++;
        continue;
      }
      sendIds.push(id);
    }
    if (approve && docIds.length > 0 && sendIds.length === 0) {
      return json(400, { error: "None of the proposed documents are on file any more. Open the request and choose the documents.", skipped });
    }
    // The stored note names every document the proposal would attach. If one
    // of them is gone and the note going out is still that note, word for
    // word, it would tell the credentialer to look for an attachment that is
    // not there. The app rebuilds the proposal (and the note) when it sees
    // the file has changed, so the fix is to open the request. A note the
    // client wrote itself is different text and is taken as deliberate; an
    // empty stored note names nothing and cannot be wrong about the packet.
    if (approve && goneFromFile > 0 && storedCoverNote && text === storedCoverNote) {
      return json(400, { error: "A proposed document is no longer on file, so the note no longer matches the packet. Open the request; the app rebuilds it." });
    }

    // Claim the row before a single byte is fetched. Two devices showing the
    // same button, or one tap retried on a slow network, arrive here with the
    // same request id; the UPDATE ... WHERE status = 'new' moves the row for
    // exactly one of them and returns nothing to the rest. Released on every
    // failure below (releaseClaim) so a refused send leaves the button live.
    if (approve && request) {
      claimAt = new Date().toISOString();
      const { data: claimedRows, error: clErr } = await db.from("document_requests")
        .update({ status: "replied", replied_at: claimAt, updated_at: claimAt })
        .eq("id", request.id).eq("user_id", who.profileId).eq("status", "new").select("id");
      if (clErr) throw clErr;
      if (!claimedRows || claimedRows.length === 0) {
        // Somebody got there first, or the row was dismissed since it loaded.
        const { data: cur } = await db.from("document_requests")
          .select("status, replied_at").eq("id", request.id).maybeSingle();
        const c = (cur ?? null) as { status?: string | null; replied_at?: string | null } | null;
        if (c?.status === "dismissed") return json(400, { error: "That request was dismissed. Move it back to New before sending." });
        const when = longDate(c?.replied_at);
        return json(409, { error: `Already sent${when ? ` on ${when}` : ""}. To send another copy, open the request and use Reply again by email.` });
      }
      claimedId = request.id;
    }

    // Pull bytes from Storage in the caller's order, within the caps.
    const attachments: { filename: string; content: string; content_type: string }[] = [];
    const attachedIds: string[] = [];
    const taken = new Set<string>();
    let totalB64 = 0;
    for (const id of sendIds) {
      const d = byId.get(id)!;
      const filename = safeFilename(d.name, `document-${attachments.length + 1}`);
      if (attachments.length >= MAX_FILES) { skipped.push(filename); continue; }
      // Only files inside the caller's own storage folder are ever read: a
      // user can edit their own row's storage_path, and the service role
      // must not become a way around storage RLS.
      const path = d.storage_path || (prof.auth_user_id ? `${prof.auth_user_id}/${d.id}` : "");
      if (!isOwnStorageObjectForSubjects(ownedStorageSubjects, path)) { skipped.push(filename); continue; }
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
    if (sendIds.length > 0 && attachments.length === 0) {
      await releaseClaim();
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
      reply_to: [replyTo],
      subject: subject.slice(0, MAX_SUBJECT),
      text: fullText,
    };
    if (attachments.length) payload.attachments = attachments;
    if (ccSelf) payload.cc = [replyTo];
    if (Object.keys(headers).length) payload.headers = headers;

    sendAttempted = true;
    const r = await sendEmail(payload);
    if (!r.ok && !r.unknown) {
      // A definite refusal: nothing went out, so the button may live again.
      await releaseClaim();
      return json(502, { error: "Email failed to send. Try again in a minute." });
    }
    let emailId: string | null = null;
    if (r.ok) {
      try { emailId = (JSON.parse(r.body) as { id?: string }).id ?? null; } catch { /* body not JSON */ }
    }

    const now = new Date().toISOString();
    claimedId = null;   // sent, or possibly sent: the claim is the answer now, never released
    if (request) {
      // On the approve path this completes the claim above with what was
      // actually attached and the Resend id (null when the outcome is
      // unknown, which is how the Replied tab tells the two apart); on the
      // hand-built path it is the whole write (a "Reply again" re-stamps an
      // already-replied row).
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

    if (!r.ok) {
      return json(502, { error: "The send could not be confirmed. Check the Replied tab before sending again; Reply again by email sends another copy." });
    }
    return json(200, { ok: true, email_id: emailId, attached: attachments.length, skipped, to });
  } catch (e) {
    // Before the POST nothing can have gone out, so the row goes back. After
    // it the claim stays (see the header): a live button over a packet that
    // may already be with the credentialer is the double send this avoids.
    if (!sendAttempted) await releaseClaim();
    console.error("send-packet-email failed:", e instanceof Error ? e.message : String(e));
    return json(500, { error: sendAttempted
      ? "The send could not be confirmed. Check the Replied tab before sending again; Reply again by email sends another copy."
      : "Could not send the packet. Try again." });
  }
});
