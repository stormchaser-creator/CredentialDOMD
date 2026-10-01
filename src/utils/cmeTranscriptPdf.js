import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { formatDate } from "./helpers.js";
import { complianceFor, findStateLicense, cycleBucket, cmeTopics } from "./compliance";
import { getStateEntry, hasSeparateBoards } from "../constants/stateRequirements";
import { STATE_NAMES } from "../constants/states";
import { boardComplianceFor, aoaNationalEntry } from "./boardCompliance";
import { cat1BucketLabel } from "../constants/creditEquivalence";
import { resolveDocument } from "./receiptFiles.js";

/**
 * Board-ready CME transcript PDF.
 *
 * Two flavors, one renderer:
 *   - State renewal: the cycle window, requirement-by-requirement standing
 *     (total, Category 1 minimum, every topic mandate, MATE Act when a DEA
 *     registration is on file), the entries inside the window, and each
 *     linked certificate: an image on its own page, a PDF as a separate
 *     file in the same share.
 *   - Board continuing certification (ABMS MOC / AOA OCC): the board's
 *     window and count rule, the same entry table, the same certificates.
 *
 * Built exactly the way the CV and invoices ship: jsPDF file, share sheet
 * on iOS, download everywhere else. Model building is separate from
 * rendering so the empty cases (no entries in the window, no state) can be
 * shown in-app before any PDF exists.
 */

const M = 54;                 // page margin (pt), matches cvPdf
const PAGE_W = 612;           // letter
const W = PAGE_W - M * 2;     // usable width
const BOTTOM = 50;            // room for the two-line footer
const NAVY = [10, 37, 64];
const INK = [20, 24, 33];
const MUTED = [90, 98, 110];
const DIM = [130, 136, 145];
const GREEN = [16, 150, 105];
const RED = [190, 40, 40];

const fmtHrs = (n) => String(Math.round((parseFloat(n) || 0) * 100) / 100);
const isoToday = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const longDate = (d = new Date()) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const dateOf = (v) => (v instanceof Date ? v : new Date(v));
const showDate = (v) => (v ? formatDate(v instanceof Date ? isoToday(v) : v) : "");
// Rule text and board labels in the constants carry em dashes; the PDF is
// user-facing copy, so they become plain punctuation here.
const plain = (s) => String(s || "").replace(/\s*—\s*/g, ", ");
const windowLabelText = (label) => {
  const m = /^(\d{4}) \(no carryover\)$/.exec(label || "");
  if (m) return `calendar year ${m[1]}, no carryover`;
  return plain(label);
};

const IMAGE_TYPES = { "image/png": "PNG", "image/jpeg": "JPEG", "image/jpg": "JPEG", "image/webp": "WEBP", "image/gif": "GIF", "image/bmp": "BMP" };

const EXT_TYPES = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", heic: "image/heic", heif: "image/heif" };

function mimeOf(doc) {
  let mime = "";
  if (doc.type && String(doc.type).includes("/")) mime = String(doc.type).toLowerCase();
  if (!mime || mime === "application/octet-stream") {
    const m = String(doc.data || "").match(/^data:(.*?)[;,]/);
    if (m && m[1] && m[1] !== "application/octet-stream") mime = m[1].toLowerCase();
  }
  if (!mime || mime === "application/octet-stream") {
    const ext = /\.([a-z0-9]+)$/i.exec(String(doc.name || ""))?.[1]?.toLowerCase();
    if (ext && EXT_TYPES[ext]) mime = EXT_TYPES[ext];
  }
  return mime;
}

/** The compliance engine's own in-window test (cycleBucket), so the
 *  transcript's numbers match the compliance card to the entry: entry dates
 *  parse at LOCAL midnight to match the engine's window bounds (a bare
 *  YYYY-MM-DD is UTC midnight otherwise, which drops the first day of the
 *  cycle in US zones). The desk-width CME table groups by the same call. */
function entriesBetween(cme, start, end) {
  const s = dateOf(start), e = dateOf(end);
  return (cme || [])
    .filter(c => cycleBucket(c, s, e) === "in")
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

/** Certificates linked to a CME entry: documents.linkedTo = "cme:<id>". */
export function certificatesFor(data, cmeId) {
  return (data.documents || []).filter(d => d.linkedTo === `cme:${cmeId}`);
}

/**
 * Number every linked certificate (Cert 1, Cert 2 ...) in table order and
 * classify how it can ride in the PDF.
 *
 * A certificate's bytes are usually NOT in doc.data: saveData strips them
 * once the file is in Storage, so on any device past its first save they are
 * only in the cloud. `certFiles` is what prefetchCertificates fetched BEFORE
 * the tap (a Map of doc id to { data } or { reason }); fetching inside the tap
 * would cost the share sheet its user gesture.
 */
function assignCertificates(data, entries, certFiles = null) {
  const certs = [];
  const rows = entries.map(c => {
    const refs = [];
    for (const stored of certificatesFor(data, c.id)) {
      const ref = `Cert ${certs.length + 1}`;
      const fetched = stored.data ? null : certFiles?.get?.(stored.id) || null;
      const doc = fetched?.data ? { ...stored, data: fetched.data } : stored;
      const mime = mimeOf(doc);
      let mode, reason = null;
      if (!doc.data) {                              // bytes not on this device
        mode = "remote";
        reason = fetched?.reason || (doc.storagePath ? "pending" : "never_uploaded");
      }
      else if (mime === "application/pdf") mode = "pdf";
      else if (IMAGE_TYPES[mime]) mode = "image";
      else if (mime.startsWith("image/")) mode = "convert"; // HEIC etc: try the canvas in the browser
      else mode = "other";
      certs.push({ ref, doc, entry: c, mode, mime, reason });
      refs.push(ref);
    }
    return { entry: c, certRefs: refs };
  });
  return { rows, certs };
}

/**
 * The certificate documents a set of transcript models would carry whose
 * bytes are only in cloud storage: the certificates of entries inside the
 * windows on offer, never every CME certificate the physician has ever saved
 * (years of them, fetched on every visit, on hospital Wi-Fi or cellular).
 */
export function certificateDocsForModels(models) {
  const docs = new Map();
  for (const model of models || []) {
    for (const c of model?.certs || []) {
      if (c.mode === "remote" && c.doc?.storagePath && c.doc.id && !docs.has(c.doc.id)) docs.set(c.doc.id, c.doc);
    }
  }
  return [...docs.values()];
}

const bytesToBase64 = (u8) => {
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
};

// Downloads run a few at a time, so one slow certificate does not hold back
// the rest.
const PREFETCH_PARALLEL = 3;

/** One certificate, cut off (and its request aborted) when the budget ends. */
async function prefetchOne(doc, download, msLeft) {
  if (msLeft <= 0) return { reason: "timeout" };
  const ctrl = new AbortController();
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => { ctrl.abort(); resolve(null); }, msLeft); });
  try {
    const r = await resolveDocument(doc, {
      signal: ctrl.signal,
      download: (path) => Promise.race([Promise.resolve().then(() => download(path, { signal: ctrl.signal })), expired]),
    });
    if (!r.file) return { reason: r.reason || "unavailable" };
    const u8 = new Uint8Array(await r.file.arrayBuffer());
    return { data: `data:${r.file.type || "application/octet-stream"};base64,${bytesToBase64(u8)}` };
  } catch {
    return { reason: "corrupt" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch certificate bytes ahead of the tap, under one time budget that also
 * bounds each download: a stalled request is aborted when the budget ends
 * rather than holding the caller indefinitely. Returns a Map of doc id to
 * { data } (a data URL) or { reason } (why it could not be read: offline,
 * timeout, unavailable, ...). The bytes are held by the caller, never written
 * back to data.documents. `download(storagePath, { signal })`.
 */
export async function prefetchCertificates(docs, { download, budgetMs = 10000, now = () => Date.now() } = {}) {
  const out = new Map();
  const list = (Array.isArray(docs) ? docs : []).filter(d => d && d.id);
  const deadline = now() + budgetMs;
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const doc = list[next++];
      out.set(doc.id, await prefetchOne(doc, download, deadline - now()));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREFETCH_PARALLEL, list.length) }, worker));
  return out;
}

// A certificate that timed out or was fetched offline is worth fetching
// again later; one that was never uploaded or cannot be read is not.
const RETRY_REASONS = new Set(["timeout", "offline"]);

/**
 * Session bookkeeping for a screen that fetches certificates while it is on
 * screen (Home's Renewal packet). A document is settled once fetched or once
 * it failed for good; one that timed out or was fetched offline waits until
 * retryLater() (the next visit, or the connection coming back) and is then
 * fetched again. One in flight is never fetched twice.
 */
export function certificateFetchTracker() {
  const settled = new Set(), inFlight = new Set(), waiting = new Set();
  return {
    toFetch: (docs) => (docs || []).filter(d => d?.id && !settled.has(d.id) && !inFlight.has(d.id) && !waiting.has(d.id)),
    started: (docs) => { for (const d of docs || []) inFlight.add(d.id); },
    finished: (docs, fetched) => {
      for (const d of docs || []) {
        inFlight.delete(d.id);
        const r = fetched?.get?.(d.id);
        if (r?.data || (r?.reason && !RETRY_REASONS.has(r.reason))) settled.add(d.id);
        else waiting.add(d.id);
      }
    },
    retryLater: () => waiting.clear(),
  };
}

const NOT_INCLUDED_WHY = {
  offline: "this device is offline",
  timeout: "they had not finished downloading to this device",
  pending: "they had not finished downloading to this device",
  unavailable: "they could not be read from your account storage",
  never_uploaded: "they were never uploaded from the device that saved them",
  corrupt: "the saved file could not be read",
  format: "that file type cannot go in a transcript",
  convert: "this device could not convert the photo format to a page",
  share_limit: "the share sheet on this device could not carry them with the transcript",
  share_failed: "the share sheet did not open and this device downloads only one file at a time",
};

// A model is "delivered" once shareTranscriptPdf has built and sent it: it
// then says how the PDF certificates went (pdfDelivery), and a photo that
// still needs converting is one this device could not convert.
const isDelivered = (model) => !!model?.pdfDelivery;
const pdfsLeftOut = (model) => model?.pdfDelivery === "omitted";
// The PDF certificates leave the device with the transcript (in the share,
// or downloaded beside it), and its index says so.
const pdfsGoWith = (model) => model?.pdfDelivery === "share" || model?.pdfDelivery === "download";

function whyNotIncluded(c, model) {
  if (c.mode === "other") return "format";
  if (c.mode === "convert") return "convert";
  if (c.mode === "pdf") return model?.pdfOmittedWhy || "share_limit";
  return c.reason;
}

/**
 * One sentence for the physician naming the certificates that are not in the
 * packet and why, or "" when every one is in it. Pass the model
 * shareTranscriptPdf returned: only it knows what the share or download
 * actually carried.
 */
export function certificatesNotIncludedMessage(model) {
  const missing = certificateSummary(model).missing;
  if (!missing.length) return "";
  const names = missing.slice(0, 3).map(c => c.doc?.name || c.ref).join(", ");
  const more = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
  const why = [...new Set(missing.map(c => NOT_INCLUDED_WHY[whyNotIncluded(c, model)] || "they could not be read"))].join("; ");
  const n = missing.length;
  return `${n} certificate${n === 1 ? " is" : "s are"} not in this packet (${names}${more}) because ${why}. Open ${n === 1 ? "it" : "them"} from Documents to send separately.`;
}

/**
 * What a model's certificates come to: embedded pages, attached PDFs, photos
 * that may not convert (before the build), and what is not included. On a
 * delivered model a photo that stayed unconverted, and a PDF the share could
 * not carry, are not included.
 */
export function certificateSummary(model) {
  const certs = model?.certs || [];
  const delivered = isDelivered(model);
  const pdfOut = pdfsLeftOut(model);
  return {
    total: certs.length,
    pages: certs.filter(c => c.mode === "image").length,
    mayNotConvert: delivered ? 0 : certs.filter(c => c.mode === "convert").length,
    files: pdfOut ? 0 : certs.filter(c => c.mode === "pdf").length,
    missing: certs.filter(c => c.mode === "remote" || c.mode === "other"
      || (c.mode === "convert" && delivered)
      || (c.mode === "pdf" && pdfOut)),
  };
}

function physicianBlock(data) {
  const s = data.settings || {};
  return { name: s.name || "", degree: s.degreeType || "", npi: s.npi || "" };
}

// ─── Models ───────────────────────────────────────────────────────────────

/**
 * Everything the state transcript needs, or { error } with a sentence the
 * UI can show instead of producing an empty PDF.
 */
export function stateTranscriptModel(data, state, { certFiles = null } = {}) {
  if (!state) return { error: "Pick a state first. Add a state medical license or set your primary state in Settings." };
  const deg = data.settings?.degreeType || "";
  const comp = complianceFor(data, state);
  const entries = entriesBetween(data.cme, comp.windowStart, comp.windowEnd);
  const stateName = STATE_NAMES[state] || state;
  if (!(data.cme || []).length) {
    return { error: `No CME logged yet. Add your CME activities, then build the ${stateName} transcript.` };
  }
  if (!entries.length) {
    return {
      error: `No CME entries fall inside the ${stateName} cycle window (${showDate(comp.windowStart)} to ${showDate(comp.windowEnd)}). Check entry dates or the license expiration that anchors the window.`,
    };
  }
  const req = getStateEntry(state, deg) || {};
  const lic = findStateLicense(data.licenses, state);
  const { rows, certs } = assignCertificates(data, entries, certFiles);
  const source = req.source || "State medical board rule";
  return {
    kind: "state",
    state,
    stateName,
    title: "CME Transcript",
    subtitle: `${stateName} medical license renewal${hasSeparateBoards(state) && deg ? ` (${deg} board)` : ""}`,
    physician: physicianBlock(data),
    license: lic ? { number: lic.licenseNumber || "", expires: lic.expirationDate || "", name: lic.name || lic.type || "" } : null,
    window: {
      start: comp.windowStart,
      end: comp.windowEnd,
      // A board reading this needs the window the hours were counted in, and
      // whether it came from the license record or from the physician.
      label: comp.windowSource === "custom"
        ? `CME cycle start set on the ${state} license record, ending at license expiration`
        : comp.windowAnchored
          ? `${comp.cycle}-year cycle ending at license expiration`
          : `rolling ${comp.cycle}-year window ending today (no ${state} license expiration on file)`,
    },
    comp,
    req,
    rows,
    certs,
    source,
    fileName: `CME-Transcript-${state}-${isoToday()}.pdf`,
    footnotes: [
      comp.degreeUnknown ? "Degree not set in Settings. MD board rules were applied." : "",
      // Surface a board/MOC exemption when a Board Certification record is on
      // file, rather than silently applying it: the physician (or their board)
      // decides whether it is claimed. Only shown when the state names one.
      (() => {
        const hasBoardCert = (data.licenses || []).some(l => /board certification/i.test(l.type || ""));
        const moc = plain(req.moc || "").trim();
        return hasBoardCert && moc && !/^no$/i.test(moc)
          ? `You may be exempt from the ${stateName} CME requirement: ${moc}. This transcript does not apply the exemption; confirm with the board and claim it on your renewal if it applies to you.`
          : "";
      })(),
      req.notes && req.notes !== "Not specified" ? `State notes: ${plain(req.notes)}` : "",
    ].filter(Boolean),
  };
}

/** Boards that can get their own transcript: the same cards Home shows. */
export function boardTranscriptOptions(data) {
  const list = boardComplianceFor(data).filter(b => !b.followsParent);
  if (data.settings?.degreeType === "DO" && (data.cme || []).length > 0 && !list.some(b => b.source === "AOA")) {
    list.unshift(aoaNationalEntry(data));
  }
  return list;
}

export function boardTranscriptModel(data, board, { certFiles = null } = {}) {
  if (!board) return { error: "Pick a board first. Choose your board specialties in Settings." };
  // Same string-compare window the board engine uses (dates are YYYY-MM-DD).
  const entries = (data.cme || [])
    .filter(c => c.date && c.date >= board.from && c.date <= board.to)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (!(data.cme || []).length) {
    return { error: `No CME logged yet. Add your CME activities, then build the ${board.name} transcript.` };
  }
  if (!entries.length) {
    return { error: `No CME entries fall inside the ${board.name} window (${formatDate(board.from)} to ${formatDate(board.to)}).` };
  }
  const isABMS = board.source === "ABMS";
  const counts = isABMS
    ? (c) => (c.category || "").includes("AMA PRA Category 1")
    : () => true;
  const { rows, certs } = assignCertificates(data, entries, certFiles);
  const source = isABMS
    ? `ABMS ${board.code} continuing certification, ${board.unit || "AMA PRA Category 1"}`
    : `AOA ${board.code === "AOA" ? "national CME requirement" : `${board.code} OCC`}, ${board.windowLabel || "3-year cycle"}`;
  return {
    kind: "board",
    board,
    title: "CME Transcript",
    subtitle: `${plain(board.label || board.name)} continuing certification`,
    physician: physicianBlock(data),
    license: null,
    window: { start: board.from + "T00:00:00", end: board.to + "T23:59:59", label: windowLabelText(board.windowLabel) },
    rows: rows.map(r => ({ ...r, counted: counts(r.entry) })),
    certs,
    countRule: board.countRule || null,
    requirements: [
      {
        name: `Total hours (${board.unit || "all categories"})`,
        rule: plain(board.assessment),
        required: fmtHrs(board.required),
        earned: fmtHrs(board.earned),
        met: board.earned >= board.required,
      },
      ...(board.cat1aRequired > 0 ? [{
        name: "AOA Category 1-A minimum",
        rule: "",
        required: fmtHrs(board.cat1aRequired),
        earned: fmtHrs(board.cat1aEarned),
        met: board.cat1aEarned >= board.cat1aRequired,
      }] : []),
    ],
    source,
    fileName: `CME-Transcript-${String(board.code || board.name).replace(/[^A-Za-z0-9-]+/g, "")}-${isoToday()}.pdf`,
    footnotes: [
      board.countRule ? `Earned total counts ${board.countRule} activities only; other rows are listed for completeness.` : "",
      plain(board.notes),
    ].filter(Boolean),
  };
}

// ─── Rendering ────────────────────────────────────────────────────────────

export function stateRequirementRows(model) {
  const { comp, req } = model;
  const deg = model.physician.degree;
  const rows = [];
  if (comp.noGeneralReq) {
    rows.push({ name: "Total CME hours", rule: "No general hour requirement in this state", required: "None", earned: fmtHrs(comp.totalEarned), met: true });
  } else {
    rows.push({
      name: `Total CME hours (${comp.cycle}-year cycle)`,
      rule: req.rollover && req.rollover !== "No" ? `Carryover: ${req.rollover}` : "",
      required: fmtHrs(comp.totalRequired),
      earned: fmtHrs(comp.totalEarned),
      met: comp.totalMet,
    });
  }
  if (comp.cat1Required > 0) {
    // Label from the credit types the engine actually counted, never from the
    // degree. The old line called every DO row "AOA Category 1-A/1-B or AMA
    // PRA Category 1 minimum", which for California is false: OMBC accepts
    // AOA 1-A or 1-B here and reads AMA-designated credit as Category 2. This
    // is the page a board sees at audit, so the row has to name the same
    // credit types the earned figure was filtered on.
    const label = cat1BucketLabel(comp.cat1Keywords, deg);
    rows.push({ name: label, rule: plain(req.cat1note), required: fmtHrs(comp.cat1Required), earned: fmtHrs(comp.cat1Earned), met: comp.cat1Met });
  }
  for (const t of comp.topicResults || []) {
    let rule = plain(t.note);
    // Non-cycle mandates count outside the renewal window; say so, the way the
    // MATE row does, or the "earned" number looks inconsistent with the cycle.
    const periodNote = t.period === "lifetime"
      ? "counted across all dates, not just this cycle"
      : (t.period && t.period.years ? `counted over the last ${t.period.years} years, not just this cycle` : "");
    if (periodNote) rule = rule ? `${rule} (${periodNote})` : periodNote[0].toUpperCase() + periodNote.slice(1);
    rows.push({
      name: t.topic,
      rule,
      required: t.checklist ? "Any activity" : fmtHrs(t.required),
      earned: fmtHrs(t.earned),
      met: t.met,
    });
  }
  for (const topic of comp.conditionalTopics || []) {
    if (topic.applicability === "applies") continue;
    rows.push({
      name: `${topic.topic} (conditional)`,
      rule: `${topic.condition.description} ${topic.cite}; checked ${topic.checkedOn}. ${topic.url}`,
      required: topic.applicability === "unknown" ? `${topic.required} if applicable` : "Not applied",
      earned: "-",
      met: null,
      status: topic.applicability === "unknown" ? "Confirm applicability" : "Not applicable (selected)",
    });
  }
  if (comp.mate) {
    rows.push({
      name: "MATE Act opioid/SUD training",
      rule: "One-time 8 hours of opioid or substance use disorder training for DEA registrants; counted across all dates, not just this cycle",
      required: fmtHrs(comp.mate.required),
      earned: fmtHrs(comp.mate.earned),
      met: comp.mate.met,
    });
  }
  return rows;
}

function drawKeyValue(doc, y, label, value) {
  doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(...DIM);
  doc.text(label.toUpperCase(), M, y);
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...INK);
  const lines = doc.splitTextToSize(value || "", W - 120);
  doc.text(lines, M + 120, y);
  return y + Math.max(1, lines.length) * 12 + 2;
}

/**
 * The certificate index printed under the activities table, written for the
 * reader (a board, a credentialing office): what is in this packet and what
 * is not. "On file" used to promise a page that never came.
 */
export function certificateIndexNote(model) {
  if (!model.certs.length) return "No certificate files are linked to these entries. Attach certificates to CME entries in Documents to include them.";
  const ONREQUEST = "not included; available from the physician on request";
  const label = (c) => {
    if (c.mode === "image") return "embedded on a following page";
    if (c.mode === "convert") return `${ONREQUEST} (image format could not be embedded)`;
    if (c.mode === "pdf") return pdfsGoWith(model) ? "sent as a separate PDF file with this transcript" : ONREQUEST;
    return ONREQUEST;
  };
  return `Certificates: ${model.certs.map(c => `${c.ref} = ${c.doc.name || "certificate"} (${label(c)})`).join("; ")}.`;
}

/**
 * Render a transcript model to a jsPDF document. Pure: no DOM, no network,
 * so it runs in node for tests. Certificate images are embedded from their
 * data URLs; anything jsPDF cannot decode is listed instead.
 */
export function buildTranscriptPdf(model, { today = new Date() } = {}) {
  // compress: certificate images otherwise land in the file as raw pixels
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  const pageH = doc.internal.pageSize.getHeight();
  const tableMargin = { left: M, right: M, top: M, bottom: BOTTOM };
  let y = M;

  // ── Title ──
  doc.setFont("helvetica", "bold").setFontSize(19).setTextColor(...NAVY);
  doc.text(model.title, M, y + 14);
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...DIM);
  doc.text(`Generated ${longDate(today)}`, M + W, y + 14, { align: "right" });
  y += 24;
  doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...MUTED);
  for (const line of doc.splitTextToSize(model.subtitle, W)) { doc.text(line, M, y + 10); y += 14; }
  y += 6;
  doc.setDrawColor(...NAVY).setLineWidth(1.4);
  doc.line(M, y, M + W, y);
  y += 16;

  // ── Physician + window ──
  const p = model.physician;
  const who = [p.name || "Physician", p.degree].filter(Boolean).join(", ");
  y = drawKeyValue(doc, y, "Physician", who);
  y = drawKeyValue(doc, y, "NPI", p.npi || "Not on file");
  if (model.kind === "state") {
    const lic = model.license;
    y = drawKeyValue(doc, y, `${model.state} license`,
      lic ? `${lic.number ? `#${lic.number}` : "Number not on file"}${lic.expires ? `, expires ${formatDate(lic.expires)}` : ""}` : `No ${model.state} medical license on file`);
  } else {
    y = drawKeyValue(doc, y, "Board", plain(model.board.label || model.board.name));
  }
  y = drawKeyValue(doc, y, "Cycle window", `${showDate(model.window.start)} to ${showDate(model.window.end)}${model.window.label ? `. ${model.window.label[0].toUpperCase()}${model.window.label.slice(1)}` : ""}`);
  y += 6;

  // ── Requirements table ──
  const reqRows = model.kind === "state" ? stateRequirementRows(model) : model.requirements;
  doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...NAVY);
  doc.text("REQUIREMENTS", M, y + 10);
  y += 16;
  autoTable(doc, {
    startY: y,
    margin: tableMargin,
    head: [["Requirement", "Rule", "Required", "Earned", "Status"]],
    body: reqRows.map(r => [r.name, r.rule || "", r.required, r.earned, r.status || (r.met ? "Met" : "Not met")]),
    styles: { font: "helvetica", fontSize: 8.5, cellPadding: 3.5, textColor: INK, overflow: "linebreak", valign: "top" },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 8.5 },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    columnStyles: {
      0: { cellWidth: 138, fontStyle: "bold" },
      1: { cellWidth: 190, textColor: MUTED, fontSize: 7.5 },
      2: { cellWidth: 56, halign: "right" },
      3: { cellWidth: 56, halign: "right" },
      4: { cellWidth: 64, halign: "center", fontStyle: "bold" },
    },
    didParseCell: (h) => {
      if (h.section === "body" && h.column.index === 4) {
        h.cell.styles.textColor = h.cell.raw === "Met" ? GREEN : h.cell.raw === "Not met" ? RED : MUTED;
      }
    },
  });
  y = doc.lastAutoTable.finalY + 18;

  // ── Entries table ──
  const totalHrs = model.rows.reduce((s, r) => s + (parseFloat(r.entry.hours) || 0), 0);
  const countedHrs = model.rows.reduce((s, r) => s + (r.counted === false ? 0 : (parseFloat(r.entry.hours) || 0)), 0);
  if (y > pageH - BOTTOM - 80) { doc.addPage(); y = M; }
  doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...NAVY);
  doc.text(`CME ACTIVITIES IN WINDOW (${model.rows.length})`, M, y + 10);
  y += 16;
  const body = model.rows.map((r, i) => {
    const c = r.entry;
    return [
      String(i + 1),
      c.date ? formatDate(c.date) : "",
      (c.title || c.category || "CME activity") + (r.counted === false ? " *" : ""),
      c.provider || "",
      c.category || "",
      fmtHrs(c.hours),
      cmeTopics(c).join(", "),
      r.certRefs.length ? r.certRefs.join(", ") : (c.certificateNumber ? `#${c.certificateNumber}` : ""),
    ];
  });
  const footRows = [["", "", "Total hours in window", "", "", fmtHrs(totalHrs), "", ""]];
  if (model.countRule && countedHrs !== totalHrs) {
    footRows.push(["", "", `Counted toward ${model.countRule}`, "", "", fmtHrs(countedHrs), "", ""]);
  }
  autoTable(doc, {
    startY: y,
    margin: tableMargin,
    head: [["#", "Date", "Activity", "Provider", "Credit type", "Hours", "Topics", "Cert"]],
    body,
    foot: footRows,
    styles: { font: "helvetica", fontSize: 7.8, cellPadding: 3, textColor: INK, overflow: "linebreak", valign: "top" },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 8 },
    footStyles: { fillColor: [235, 239, 244], textColor: INK, fontStyle: "bold", fontSize: 8 },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    columnStyles: {
      0: { cellWidth: 20, halign: "right", textColor: DIM },
      1: { cellWidth: 60 },
      2: { cellWidth: 128, fontStyle: "bold" },
      3: { cellWidth: 84 },
      4: { cellWidth: 74 },
      5: { cellWidth: 34, halign: "right" },
      6: { cellWidth: 70, fontSize: 7, textColor: MUTED },
      7: { cellWidth: 34, fontSize: 7 },
    },
  });
  y = doc.lastAutoTable.finalY + 12;

  // ── Certificate index + notes ──
  const notes = [];
  notes.push(certificateIndexNote(model));
  if (model.rows.some(r => r.counted === false)) notes.push(`* Listed but not counted toward ${model.countRule}.`);
  notes.push(...(model.footnotes || []));
  doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...MUTED);
  for (const n of notes) {
    const lines = doc.splitTextToSize(n, W);
    if (y + lines.length * 10 > pageH - BOTTOM) { doc.addPage(); y = M; }
    doc.text(lines, M, y + 8);
    y += lines.length * 10 + 4;
  }

  // ── Certificate pages ──
  const embedded = [];
  for (const cert of model.certs) {
    if (cert.mode !== "image") continue;
    doc.addPage();
    let cy = M;
    doc.setFont("helvetica", "bold").setFontSize(12).setTextColor(...NAVY);
    doc.text(cert.ref, M, cy + 10);
    doc.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(...INK);
    const head = [cert.entry.title || cert.entry.category || "CME activity", cert.entry.date ? formatDate(cert.entry.date) : "", cert.entry.provider || ""].filter(Boolean).join("  |  ");
    doc.text(doc.splitTextToSize(head, W - 60), M + 52, cy + 10);
    cy += 26;
    doc.setFontSize(8).setTextColor(...DIM);
    doc.text(doc.splitTextToSize(`File: ${cert.doc.name || "certificate"}`, W), M, cy + 8);
    cy += 18;
    const maxW = W, maxH = pageH - BOTTOM - cy - 6;
    try {
      const props = doc.getImageProperties(cert.doc.data);
      const scale = Math.min(maxW / props.width, maxH / props.height, 1.5);
      const w = props.width * scale, h = props.height * scale;
      const fmt = IMAGE_TYPES[cert.mime] || props.fileType || "JPEG";
      doc.addImage(cert.doc.data, fmt, M + (maxW - w) / 2, cy, w, h);
      embedded.push(cert.ref);
    } catch (err) {
      doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...RED);
      doc.text(doc.splitTextToSize(`This certificate image could not be embedded (${err?.message || "unreadable image"}). The file is on record in CredentialDOMD.`, W), M, cy + 12);
    }
  }

  // ── Footer on every page ──
  const pages = doc.getNumberOfPages();
  const footer = `Generated by CredentialDOMD on ${longDate(today)}. Source rule: ${model.source}.`;
  for (let pg = 1; pg <= pages; pg++) {
    doc.setPage(pg);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...DIM);
    const lines = doc.splitTextToSize(footer, W - 70).slice(0, 2);
    doc.text(lines, M, pageH - 30);
    doc.text(`Page ${pg} of ${pages}`, M + W, pageH - 30, { align: "right" });
  }

  return doc;
}

// ─── Browser: image prep + share ──────────────────────────────────────────

/**
 * Photos of certificates from a phone are big and sometimes HEIC. In the
 * browser, re-encode anything jsPDF cannot take (or anything wider than
 * MAX_PX) through a canvas to JPEG. Failures leave the certificate listed
 * as "on file" rather than breaking the PDF.
 */
const MAX_PX = 1800;
async function prepareCertificateImages(model) {
  if (typeof document === "undefined" || typeof Image === "undefined") return model;
  const certs = await Promise.all(model.certs.map(async (cert) => {
    if (cert.mode !== "image" && cert.mode !== "convert") return cert;
    let needs = cert.mode === "convert";
    let img;
    try {
      img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("decode failed"));
        i.src = cert.doc.data;
      });
      if (img.naturalWidth > MAX_PX || img.naturalHeight > MAX_PX) needs = true;
    } catch {
      return cert; // leave as-is; jsPDF gets one more try at render time
    }
    if (!needs) return cert;
    try {
      const scale = Math.min(1, MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", 0.85);
      return { ...cert, mode: "image", mime: "image/jpeg", doc: { ...cert.doc, data, type: "image/jpeg" } };
    } catch {
      return cert;
    }
  }));
  return { ...model, certs };
}

const dataUrlBytes = (dataUrl) => {
  const bin = atob(String(dataUrl).slice(String(dataUrl).indexOf(",") + 1));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
};

/** The PDF certificates as files, named by their index ref so the reader can match them. */
export function pdfCertificateFiles(model) {
  return (model?.certs || []).filter(c => c.mode === "pdf" && c.doc?.data).map(c => {
    const name = String(c.doc.name || "certificate.pdf").replace(/[\\/:*?"<>|]+/g, " ").trim() || "certificate.pdf";
    return new File([dataUrlBytes(c.doc.data)], `${c.ref} - ${/\.pdf$/i.test(name) ? name : `${name}.pdf`}`, { type: "application/pdf" });
  });
}

// iOS and iPadOS take one programmatic download at a time: a second <a
// download> click made without a fresh tap is dropped. iPadOS reports itself
// as a Mac, so a Mac with a touch screen counts too.
const downloadsOneAtATime = (nav) => {
  const ua = String(nav?.userAgent || "");
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav?.maxTouchPoints) > 1);
};

const downloadFile = (file) => {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};

/**
 * Share sheet where it can take files, download otherwise (the CV pattern).
 * PDF certificates travel as separate files in the same share (or download)
 * as the transcript; the transcript's certificate index says which, decided
 * before the PDF is built so it never promises a file the share cannot carry.
 *
 * A share can still fail after the build (on iOS the tap's gesture has
 * expired by the time the PDF is ready, and the share target can refuse the
 * files). The fallback downloads instead, and the transcript it downloads
 * says what that download carries: where the device takes several downloads
 * the PDF certificates are downloaded beside it and listed as sent with it;
 * where it takes one (iOS, iPadOS) the transcript is rebuilt to list them as
 * not included, and the physician is told which. The transcript never says a
 * certificate went with it when it did not.
 *
 * Returns null when the physician cancelled the share sheet, otherwise
 * { method: "share" | "download", model }: model is what was actually sent
 * (images converted, pdfDelivery set), for certificatesNotIncludedMessage.
 */
export async function shareTranscriptPdf(model) {
  const certFiles = pdfCertificateFiles(model);
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const probe = new File([new Uint8Array([37, 80, 68, 70])], model.fileName, { type: "application/pdf" });
  const canShare = (files) => { try { return !!nav?.canShare && nav.canShare({ files }); } catch { return false; } };
  const shareOne = canShare([probe]);
  const shareAll = certFiles.length > 0 && canShare([probe, ...certFiles]);
  const pdfDelivery = !certFiles.length ? "none" : shareAll ? "share" : shareOne ? "omitted" : "download";
  const prepared = await prepareCertificateImages({ ...model, pdfDelivery });
  const pdfOf = (m) => new File([buildTranscriptPdf(m).output("blob")], model.fileName, { type: "application/pdf" });
  const file = pdfOf(prepared);
  if (shareOne) {
    try {
      await nav.share({ title: file.name, files: pdfDelivery === "share" ? [file, ...certFiles] : [file] });
      return { method: "share", model: prepared };
    } catch (err) {
      if (err?.name === "AbortError") return null;
    }
  }
  // Downloading. After a failed share the index was written for the share,
  // so it is rewritten for what this download can actually carry.
  let sent = prepared, sentFile = file;
  if (shareOne && certFiles.length) {
    const oneAtATime = downloadsOneAtATime(nav);
    sent = oneAtATime
      ? { ...prepared, pdfDelivery: "omitted", pdfOmittedWhy: "share_failed" }
      : { ...prepared, pdfDelivery: "download" };
    if (pdfsGoWith(sent) !== pdfsGoWith(prepared)) sentFile = pdfOf(sent);
  }
  downloadFile(sentFile);
  if (pdfsGoWith(sent)) certFiles.forEach(downloadFile);
  return { method: "download", model: sent };
}
