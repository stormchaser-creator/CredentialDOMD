// Turning a saved document row into a File you can attach or open.
//
// WHY THIS EXISTS. A document's bytes live in one of two places and the app
// used to look in only one of them. `doc.data` is a base64 data URL held on
// the device, but saveData in src/utils/storage.js deliberately strips it as
// soon as the document has a storagePath, because localStorage is about 5 MB
// on Safari. The bytes themselves are safe in Supabase Storage. So on any
// device that has completed one save cycle, `doc.data` is empty and the real
// file is in the cloud.
//
// The expense invoice path checked only `doc.data` and silently skipped every
// receipt it could not find, while the invoice PDF it generated still printed
// "receipt attached". That is how an agency received a bill claiming proof it
// never got. Everything here is keyed by document id, never by name: two
// receipts from the same camera roll can share a filename.

import { docMime } from "./inboxDocs.js";

// One budget for the whole bundle, not per file. A per-file timeout multiplies:
// nine stalled receipts at twenty seconds each is three minutes of a frozen
// screen on a live invoice.
export const RECEIPT_BUNDLE_BUDGET_MS = 30000;

// The downloader is injected rather than imported so this module stays a pure
// unit: src/lib/supabase.js reads import.meta.env at module scope and cannot be
// loaded by a plain node test.
const dataUrlToBlob = (dataUrl) => {
  const m = /^data:([^;,]*);base64,/.exec(dataUrl || "");
  if (!m) return null;
  const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] || "" });
};

/**
 * Resolve one document row to a File.
 * Returns { id, name, file, reason } where reason is null on success and
 * otherwise names what went wrong, so the caller can tell the truth.
 */
export async function resolveDocument(doc, { download, signal } = {}) {
  const id = doc?.id || null;
  const name = doc?.name || "receipt";
  const type = docMime(doc) || "application/octet-stream";
  if (!doc) return { id, name, file: null, reason: "unavailable" };
  try {
    if (doc.data) {
      const blob = dataUrlToBlob(doc.data);
      if (blob) return { id, name, file: new File([blob], name, { type }), reason: null };
      return { id, name, file: null, reason: "corrupt" };
    }
    if (!doc.storagePath) {
      // Never uploaded. Re-fetching cannot help, so do not promise a retry.
      return { id, name, file: null, reason: "never_uploaded" };
    }
    if (signal?.aborted) return { id, name, file: null, reason: "timeout" };
    if (typeof download !== "function") return { id, name, file: null, reason: "unavailable" };
    const blob = await download(doc.storagePath);
    if (signal?.aborted) return { id, name, file: null, reason: "timeout" };
    if (!blob) {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      return { id, name, file: null, reason: offline ? "offline" : "unavailable" };
    }
    return { id, name, file: new File([blob], name, { type }), reason: null };
  } catch {
    return { id, name, file: null, reason: "corrupt" };
  }
}

/**
 * Resolve many documents, sequentially, under one wall-clock budget.
 * Anything not reached when the budget runs out is reported, not attempted,
 * so the caller never waits longer than the budget.
 */
export async function resolveDocuments(docs, { download, budgetMs = RECEIPT_BUNDLE_BUDGET_MS, now = () => Date.now() } = {}) {
  const list = Array.isArray(docs) ? docs.filter(Boolean) : [];
  const started = now();
  const files = [];
  const missing = [];
  const byId = new Map();
  for (const doc of list) {
    const overBudget = now() - started >= budgetMs;
    const result = overBudget
      ? { id: doc?.id || null, name: doc?.name || "receipt", file: null, reason: "timeout" }
      : await resolveDocument(doc, { download, signal: { aborted: false } });
    byId.set(result.id, result);
    if (result.file) files.push(result.file); else missing.push({ id: result.id, name: result.name, reason: result.reason });
  }
  return { files, missing, byId };
}

const REASON_TEXT = {
  offline: "you are offline",
  timeout: "the download timed out",
  unavailable: "they could not be read from your account storage",
  never_uploaded: "they were never uploaded from the device that saved them",
  corrupt: "the saved file could not be read",
  // The server-sent invoice email (send-invoice-email) carries at most 10
  // files and 25 MB, the same caps as send-packet-email.
  too_large: "the email would be over its 25 MB limit",
  too_many: "one email carries at most 10 files",
  // On this device but not (yet) in the account the server reads: the upload
  // or the expense's invoice link is still queued.
  not_synced: "this device has not finished saving them to your account",
};

/**
 * One honest sentence naming what did not attach and why. `nouns` lets the
 * credential Send sheet say "documents" instead of "receipts".
 */
export function missingReceiptMessage(missing, nouns = { one: "receipt", many: "receipts" }) {
  if (!missing?.length) return "";
  const names = missing.map(m => m.name).slice(0, 3).join(", ");
  const more = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
  const reasons = [...new Set(missing.map(m => REASON_TEXT[m.reason] || "they could not be read"))];
  const why = reasons.length === 1 ? reasons[0] : reasons.join(", and ");
  const noun = missing.length === 1 ? nouns.one : nouns.many;
  return `${missing.length} ${noun} could not be attached (${names}${more}) because ${why}.`;
}

/**
 * The receipt documents for the expenses an invoice actually bills.
 *
 * Intersects the two links rather than unioning them. After an offline send on
 * a second device an expense can carry a different invoice's id, and a union
 * would attach proof for work this invoice does not bill, which on a billing
 * document is worse than attaching nothing.
 */
export function billedReceiptDocs(invoice, expenses, documents) {
  if (invoice?.kind !== "expenses") return [];
  const billed = new Set(invoice.entryIds || []);
  const mine = (expenses || []).filter(e => e && e.invoiceId === invoice.id && billed.has(e.id));
  const ids = new Set(mine.map(e => `travelExpenses:${e.id}`));
  return (documents || []).filter(d => d && ids.has(d.linkedTo));
}

/**
 * The expenses whose receipts are ALL in hand for a send: `docs` are the
 * receipt documents (linkedTo "travelExpenses:<id>"), `missing` the ones that
 * could not be resolved. An expense with even one missing receipt is left
 * out, so its invoice line says "on file", never "attached".
 */
export function attachedExpenseIds(docs, missing) {
  const gone = new Set((missing || []).map(m => m?.id).filter(Boolean));
  const complete = new Map();
  for (const d of docs || []) {
    const m = /^travelExpenses:(.+)$/.exec(d?.linkedTo || "");
    if (!m) continue;
    complete.set(m[1], (complete.get(m[1]) ?? true) && !gone.has(d.id));
  }
  return new Set([...complete].filter(([, ok]) => ok).map(([id]) => id));
}
