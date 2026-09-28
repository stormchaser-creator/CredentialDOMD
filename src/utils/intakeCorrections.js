// The physician's corrections to what email intake did, recorded so the next
// reading learns from them.
//
// Every docs@ and cme@ email is read by one model call before anything is
// decided (supabase/functions/_shared/intakeUnderstanding.mjs). When the
// physician undoes or changes what that led to, the app writes one row to
// public.intake_corrections (migration 20260928160000), and the account's
// last ten rows go into the next prompt as one-line examples
// (correctionExamples). The corrections recorded:
//
//   dismiss_request    a request row dismissed from More > Requests
//   edit_cover_note    the drafted reply changed before it was sent
//   move_document      an emailed document taken out of the inbox into a record
//   relink_document    an emailed document moved from one record to another
//   keep_as_document   "Keep as plain document" chosen for an emailed document
//
// What a row holds is what the physician chose, never who anyone is: kinds,
// sections, statuses, and ask or line texts with addresses, links, numbers,
// honorific names and the names the caller passes all taken out. No email
// body and no file. The table's insert policy caps each side at 4 KB.
//
// Writing is fire-and-forget: a failed write (offline, or the migration not
// yet applied) costs one example, never the action the physician took. Pure
// apart from recordCorrection, so scripts/intake-corrections.test.mjs runs
// the builders under plain node.
import { INBOX_DOC_TYPES } from "./inboxDocs.js";

export const CORRECTION_ACTIONS = Object.freeze(["dismiss_request", "edit_cover_note", "move_document", "relink_document", "keep_as_document"]);

const MAX_ITEMS = 12;

/**
 * Did this document arrive by email? An inbox type, or a MIME type in
 * mimeType: email-inbound writes documents.mime_type, and the app's own
 * uploads keep their MIME type in `type` and leave that column empty.
 */
export function arrivedByEmail(doc) {
  return !!doc && (INBOX_DOC_TYPES.includes(doc.type) || !!doc.mimeType);
}

/** "licenses" from "licenses:abc"; "inbox" for an emailed document with no link; "" otherwise. */
export function sectionOf(doc, linkedTo = doc?.linkedTo) {
  const s = String(linkedTo || "").split(":")[0];
  if (s) return s;
  return doc && INBOX_DOC_TYPES.includes(doc.type) ? "inbox" : "";
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text with anything that identifies a person taken out: email addresses,
 * links, runs of digits, a capitalised name after an honorific, and each word
 * of the names passed in (the physician's, the requester's).
 */
export function scrubText(s, names = [], max = 80) {
  let t = String(s ?? "")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/g, "")
    .replace(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "")
    .replace(/\b\d[\d\s./-]{3,}\d\b/g, "#")
    .replace(/\b(?:[Dd]r|[Mm]rs?|[Mm]s|[Mm]x|[Pp]rof)\.?\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?/g, "the person");
  for (const n of names) {
    for (const w of String(n || "").split(/[\s,]+/).filter((x) => x.length > 2)) {
      t = t.replace(new RegExp(`\\b${escapeRe(w)}\\b`, "gi"), "the person");
    }
  }
  t = t.replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/\s+/g, " ").trim();
  // Cut at a word, not inside one.
  if (t.length <= max) return t;
  const at = t.slice(0, max + 1).lastIndexOf(" ");
  return (at > 0 ? t.slice(0, at) : t.slice(0, max)).trim();
}

const list = (xs, names) => (Array.isArray(xs) ? xs : []).map((x) => scrubText(x, names, 60)).filter(Boolean).slice(0, MAX_ITEMS);

/** The "- item" lines of a note, as written. */
export function bulletLines(note) {
  return String(note ?? "").split("\n").map((l) => l.match(/^\s*-\s+(.+?)\s*$/)?.[1] || "").filter(Boolean);
}

const requestNames = (request, physicianName) => [request?.from_name, physicianName];

/** What a proposal was, for the "before" side of a request correction. */
function proposalBefore(request, names) {
  const p = request?.proposal && typeof request.proposal === "object" ? request.proposal : {};
  const items = Array.isArray(p.items) ? p.items.filter((i) => i && typeof i === "object") : [];
  return {
    intent: "request",
    source: typeof p.source === "string" ? p.source : "rules",
    confidence: typeof p.confidence === "string" ? p.confidence : "keyword",
    asks: list(items.map((i) => i.ask), names),
    kinds: items.map((i) => String(i.kind || "unknown")).slice(0, MAX_ITEMS),
  };
}

/** A request dismissed: it was not something the physician would answer. */
export function dismissCorrection(request, { physicianName = "" } = {}) {
  if (!request?.id) return null;
  const names = requestNames(request, physicianName);
  return {
    action: "dismiss_request",
    request_id: request.id,
    inbound_email_id: request.inbound_ledger_id || null,
    before: proposalBefore(request, names),
    after: { status: "dismissed" },
  };
}

/**
 * The drafted reply changed before sending: which of its lines went, which
 * were added, or that it was cleared. null when the note went as drafted.
 * `drafted` is the note the app wrote for what was ticked (noteForSelection),
 * so unticking a document is not counted as an edit.
 */
export function coverNoteCorrection(request, drafted, sent, { physicianName = "" } = {}) {
  if (!request?.id) return null;
  const a = String(drafted ?? "").trim(), b = String(sent ?? "").trim();
  if (a === b) return null;
  const names = requestNames(request, physicianName);
  const was = bulletLines(a), now = bulletLines(b);
  const removed = was.filter((l) => !now.includes(l));
  const added = now.filter((l) => !was.includes(l));
  return {
    action: "edit_cover_note",
    request_id: request.id,
    inbound_email_id: request.inbound_ledger_id || null,
    before: proposalBefore(request, names),
    after: { cleared: !b, removedAsks: list(removed, names), addedAsks: list(added, names), lineCountChange: b.split("\n").length - a.split("\n").length },
  };
}

/**
 * An emailed document given another home: out of the inbox into a record
 * (move_document) or from one record to another (relink_document). null
 * for a document that did not come by email, or when nothing moved.
 */
export function relinkCorrection(doc, nextLinkedTo, { scanType = "" } = {}) {
  if (!arrivedByEmail(doc)) return null;
  const from = sectionOf(doc);
  const to = String(nextLinkedTo || "").split(":")[0] || "unlinked";
  if (from === to) return null;
  return {
    action: from === "inbox" ? "move_document" : "relink_document",
    request_id: null,
    inbound_email_id: null,
    before: { section: from || "unlinked", scanType: scrubText(scanType, [], 30), kind: scrubText(doc.type === "request-attachment-inbox" ? "request attachment" : "document", [], 30) },
    after: { section: to },
  };
}

/** "Keep as plain document" for an emailed document the scanner offered to file. */
export function keepCorrection(doc, { scanType = "", suggested = "" } = {}) {
  if (!arrivedByEmail(doc)) return null;
  return {
    action: "keep_as_document",
    request_id: null,
    inbound_email_id: null,
    before: { section: sectionOf(doc) || "unlinked", scanType: scrubText(scanType, [], 30), suggested: scrubText(suggested, [], 40) },
    after: { kept: "plain document" },
  };
}

/**
 * Write one correction for this account. Never throws and never blocks the
 * action it records; resolves true when the row was written.
 */
export async function recordCorrection(client, userId, row) {
  if (!client || !userId || !row || !CORRECTION_ACTIONS.includes(row.action)) return false;
  try {
    const { error } = await client.from("intake_corrections").insert({ ...row, user_id: userId });
    return !error;
  } catch {
    return false;
  }
}
