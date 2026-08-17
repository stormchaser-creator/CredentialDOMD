import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { formatDate } from "./helpers.js";
import { complianceFor, findStateLicense } from "./compliance";
import { getStateEntry, hasSeparateBoards } from "../constants/stateRequirements";
import { STATE_NAMES } from "../constants/states";
import { computeBoardCompliance, aoaNationalEntry } from "./boardCompliance";

/**
 * Board-ready CME transcript PDF.
 *
 * Two flavors, one renderer:
 *   - State renewal: the cycle window, requirement-by-requirement standing
 *     (total, Category 1 minimum, every topic mandate, MATE Act when a DEA
 *     registration is on file), the entries inside the window, and each
 *     linked certificate image on its own page.
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

function mimeOf(doc) {
  if (doc.type) return String(doc.type).toLowerCase();
  const m = String(doc.data || "").match(/^data:(.*?)[;,]/);
  return m ? m[1].toLowerCase() : "";
}

/** Same in-window test the compliance engine uses, so the transcript's
 *  numbers match the compliance card to the entry. */
function entriesBetween(cme, start, end) {
  const s = dateOf(start), e = dateOf(end);
  return (cme || [])
    .filter(c => {
      if (!c.date) return false;
      const d = new Date(c.date);
      return d >= s && d <= e;
    })
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

/** Certificates linked to a CME entry: documents.linkedTo = "cme:<id>". */
export function certificatesFor(data, cmeId) {
  return (data.documents || []).filter(d => d.linkedTo === `cme:${cmeId}`);
}

/**
 * Number every linked certificate (Cert 1, Cert 2 ...) in table order and
 * classify how it can ride in the PDF.
 */
function assignCertificates(data, entries) {
  const certs = [];
  const rows = entries.map(c => {
    const refs = [];
    for (const doc of certificatesFor(data, c.id)) {
      const ref = `Cert ${certs.length + 1}`;
      const mime = mimeOf(doc);
      let mode;
      if (!doc.data) mode = "remote";               // synced metadata, bytes not on this device
      else if (mime === "application/pdf") mode = "pdf";
      else if (IMAGE_TYPES[mime]) mode = "image";
      else if (mime.startsWith("image/")) mode = "convert"; // HEIC etc: try the canvas in the browser
      else mode = "other";
      certs.push({ ref, doc, entry: c, mode, mime });
      refs.push(ref);
    }
    return { entry: c, certRefs: refs };
  });
  return { rows, certs };
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
export function stateTranscriptModel(data, state) {
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
  const { rows, certs } = assignCertificates(data, entries);
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
      label: comp.windowAnchored
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
      req.notes && req.notes !== "Not specified" ? `State notes: ${plain(req.notes)}` : "",
    ].filter(Boolean),
  };
}

/** Boards that can get their own transcript: the same cards Home shows. */
export function boardTranscriptOptions(data) {
  const list = computeBoardCompliance(data).filter(b => !b.followsParent);
  if (data.settings?.degreeType === "DO" && (data.cme || []).length > 0 && !list.some(b => b.source === "AOA")) {
    list.unshift(aoaNationalEntry(data));
  }
  return list;
}

export function boardTranscriptModel(data, board) {
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
  const { rows, certs } = assignCertificates(data, entries);
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

function stateRequirementRows(model) {
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
    const label = comp.cat1OneAOnly ? "AOA Category 1-A minimum"
      : deg === "DO" ? "AOA Category 1-A/1-B or AMA PRA Category 1 minimum"
        : "AMA PRA Category 1 minimum";
    rows.push({ name: label, rule: plain(req.cat1note), required: fmtHrs(comp.cat1Required), earned: fmtHrs(comp.cat1Earned), met: comp.cat1Met });
  }
  for (const t of comp.topicResults || []) {
    rows.push({
      name: t.topic,
      rule: plain(t.note),
      required: t.checklist ? "Any activity" : fmtHrs(t.required),
      earned: fmtHrs(t.earned),
      met: t.met,
    });
  }
  if (comp.mate) {
    rows.push({
      name: "MATE Act opioid/SUD training",
      rule: "One-time 8 hours for DEA registrants; counted across all dates, not just this cycle",
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
    body: reqRows.map(r => [r.name, r.rule || "", r.required, r.earned, r.met ? "Met" : "Not met"]),
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
        h.cell.styles.textColor = h.cell.raw === "Met" ? GREEN : RED;
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
      (c.topics || []).join(", "),
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
  if (model.certs.length) {
    const label = (c) => {
      if (c.mode === "image") return "embedded on a following page";
      if (c.mode === "convert") return "image on file; format not embeddable here";
      if (c.mode === "pdf") return "PDF on file";
      if (c.mode === "remote") return "on file in cloud storage; not on this device";
      return "file on record";
    };
    notes.push(`Certificates: ${model.certs.map(c => `${c.ref} = ${c.doc.name || "certificate"} (${label(c)})`).join("; ")}.`);
  } else {
    notes.push("No certificate files are linked to these entries. Attach certificates to CME entries in Documents to include them.");
  }
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

export async function transcriptPdfFile(model) {
  const prepared = await prepareCertificateImages(model);
  const doc = buildTranscriptPdf(prepared);
  const blob = doc.output("blob");
  return new File([blob], model.fileName, { type: "application/pdf" });
}

/** Share sheet where it can take files, download otherwise (the CV pattern). */
export async function shareTranscriptPdf(model) {
  const file = await transcriptPdfFile(model);
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ title: file.name, files: [file] });
      return "share";
    } catch (err) {
      if (err?.name === "AbortError") return null;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "download";
}
