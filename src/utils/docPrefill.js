// Document → form prefill, the pure half. DocAttach (any credential form) and
// the Contracts form share these so a file behaves the same whether it is
// uploaded fresh, uploaded a second time, or picked from Files.
//
// A file that is already in Files is never stored twice, but it is still READ:
// the physician uploaded it because they want the form filled, and refusing
// the duplicate before analysis is how an Add Agreement form ended up blank.

import { officeKind } from "./officeText.js";
import { normalizeCoveragePeriods, fileableCoveragePeriods } from "./coverageText.js";
import { docMime, INBOX_DOC_TYPE, leaveInbox } from "./inboxDocs.js";
// mergeExtracted, splitScanned and mergeScanned live in scanSplit.js, which the
// email-inbound edge function shares; re-exported so every import keeps working.
export { mergeExtracted, splitScanned, mergeScanned } from "./scanSplit.js";

/** Same match the app has always used: identical bytes, or same name and size. */
export function findDuplicateDoc(documents, file, dataUrl) {
  if (!file) return null;
  return (documents || []).find((d) => d && (
    (dataUrl && d.data && d.data.length === dataUrl.length && d.data === dataUrl) ||
    (file.name && d.name === file.name && d.size === file.size)
  )) || null;
}

/**
 * The document row to write when a file already in Files is attached to a
 * credential: link it when it is unlinked; null when nothing should change
 * (already linked here, or linked to a different credential, which is never
 * moved silently).
 */
export function attachExistingDoc(existing, linkedTo) {
  if (!existing || !linkedTo || existing.linkedTo) return null;
  return { ...existing, ...leaveInbox(existing), linkedTo };
}

/** True when one of the analyzers can read this stored document. */
export function isReadableDoc(doc) {
  if (!doc) return false;
  const mime = docMime(doc);
  if (mime === "application/pdf" || mime.startsWith("image/")) return true;
  const kind = officeKind(doc.name, mime);
  return !!kind && kind !== "doc"; // old-format .doc cannot be read client-side
}

const AGREEMENT_NAME_HINT = /agreement|contract|locum|confirmation|assignment|engagement|addendum|amendment|offer|terms/i;

/**
 * Documents in Files that could be this agreement, best first: the one already
 * linked to the contract being edited, other agreement documents, files whose
 * name says contract, then every other readable unlinked file (newest first).
 * Files linked to a license, CME, etc. are not offered. `ready` is false while
 * the bytes have not reached this device yet; `missing` is true when they never
 * will, because Storage no longer has the file (doc.fileMissing, set by
 * AppContext reconcileDocumentFiles, which then stops asking), so the picker
 * says so instead of "downloading" forever.
 */
export function agreementDocCandidates(documents, { contractId } = {}) {
  const own = contractId ? `locumContracts:${contractId}` : null;
  return (documents || [])
    .filter((d) => d && d.id && d.type !== INBOX_DOC_TYPE && isReadableDoc(d)
      && (!d.linkedTo || String(d.linkedTo).startsWith("locumContracts:")))
    .map((d) => {
      const linkedAgreement = String(d.linkedTo || "").startsWith("locumContracts:");
      const rank = d.linkedTo && d.linkedTo === own ? 3 : linkedAgreement ? 2 : AGREEMENT_NAME_HINT.test(d.name || "") ? 1 : 0;
      // Ready: on this device, or in the account (fetched when picked).
      return { doc: d, rank, linkedAgreement, ready: !!d.data || (!!d.storagePath && !d.fileMissing), missing: !!d.fileMissing && !d.data };
    })
    .sort((a, b) => b.rank - a.rank || String(b.doc.uploadedAt || "").localeCompare(String(a.doc.uploadedAt || "")));
}

// ─── Agreement field normalizer ─────────────────────────────────────────
// The analyzer is asked for plain numbers and YYYY-MM-DD dates, but a rate
// with a $ sign or a date block missing an end must not poison the form.

const NUMBER_FIELDS = [
  "dayRate", "hourlyRate", "callStipend", "stipendHours", "overageHourlyRate",
  "callHourlyRate", "orientationFee", "orientationHourlyRate", "incrementMinutes", "minCallMinutes",
];
const TEXT_FIELDS = ["facility", "location", "agency", "billTo", "notes", "shortName"];
const PAY_MODELS = ["stipend", "hourly", "daily"];

const num = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const pad2 = (n) => String(n).padStart(2, "0");
export function isoDate(v) {
  if (v == null || v === "") return "";
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Analyzer JSON → the exact shape the Contracts form and Work Log expect.
 * A coverage block keeps startTime/endTime (24-hour "HH:MM", see
 * coverageBlocks.js) only when the agreement stated them, and a start time
 * only with an end time; `text`, the agreement's own words when they are at
 * hand, fills in any the model left out, and `zone` is stamped on a block
 * with times (coverageText.js normalizeCoveragePeriods).
 */
export function normalizeAgreementFields(extracted, { text = "", zone = "" } = {}) {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) return {};
  const out = { ...extracted };

  for (const k of NUMBER_FIELDS) {
    if (!(k in out)) continue;
    const n = num(out[k]);
    if (n == null) delete out[k]; else out[k] = n;
  }
  for (const k of TEXT_FIELDS) {
    if (!(k in out)) continue;
    const s = out[k] == null ? "" : String(out[k]).trim();
    if (s) out[k] = s; else delete out[k];
  }
  if ("payModel" in out && !PAY_MODELS.includes(out.payModel)) delete out.payModel;

  const start = isoDate(out.startDate);
  const end = isoDate(out.endDate);
  let periods = normalizeCoveragePeriods(Array.isArray(out.coveragePeriods) ? out.coveragePeriods : [], { text, zone, day: isoDate });
  // A single assignment span with no blocks listed is one block.
  if (periods.length === 0 && (start || end)) periods = [{ start: start || end, end }];
  if (periods.length) out.coveragePeriods = periods; else delete out.coveragePeriods;
  if (start) out.startDate = start; else delete out.startDate;
  if (end) out.endDate = end; else delete out.endDate;

  if ("callRateGrid" in out) {
    const grid = Array.isArray(out.callRateGrid)
      ? out.callRateGrid
          .filter((r) => r && typeof r === "object")
          .map((r) => ({ hospital: r.hospital == null ? "" : String(r.hospital).trim(), primary: num(r.primary), backup: num(r.backup) }))
          .filter((r) => r.hospital || r.primary != null || r.backup != null)
      : [];
    if (grid.length) out.callRateGrid = grid; else delete out.callRateGrid;
  }
  return out;
}

const CONTRACT_NUMBER_FIELDS = ["hourlyRate", "callHourlyRate", "callStipend", "stipendHours", "overageHourlyRate", "orientationFee", "orientationHourlyRate"];

/**
 * A contract read on the Files tab (DocumentsSection), shaped the way the
 * Contracts form saves one: every rate a number, increments defaulting to
 * 15, and its coverage blocks through normalizeCoveragePeriods (times as
 * HH:MM, a start time only with an end time, any time the model left out
 * filled from `text`, the file's own words, and `zone` on a block with
 * times). A block its times make end before it starts would bill no call
 * day, so it is not saved: { entry, problem } names the first one.
 */
export function contractFromScan(fields, { text = "", zone = "" } = {}) {
  const entry = { ...(fields || {}) };
  for (const k of CONTRACT_NUMBER_FIELDS) entry[k] = parseFloat(entry[k]) || 0;
  entry.incrementMinutes = parseInt(entry.incrementMinutes, 10) || 15;
  entry.minCallMinutes = parseInt(entry.minCallMinutes, 10) || 15;
  if (Array.isArray(entry.coveragePeriods) || text) {
    const periods = normalizeCoveragePeriods(Array.isArray(entry.coveragePeriods) ? entry.coveragePeriods : [], { text, zone, day: isoDate });
    const { refused } = fileableCoveragePeriods(periods);
    if (refused.length) return { entry, problem: `${refused[0].problem} Fix its dates here or remove the block, then save.` };
    if (periods.length || Array.isArray(entry.coveragePeriods)) entry.coveragePeriods = periods;
  }
  return { entry, problem: "" };
}

/** Wrap an analyzer result so its `extracted` block is normalized in place (opts.text: the agreement's text, when read from one). */
export function withAgreementFields(result, opts = {}) {
  if (!result || typeof result !== "object") return result;
  return { ...result, extracted: normalizeAgreementFields(result.extracted, opts) };
}
