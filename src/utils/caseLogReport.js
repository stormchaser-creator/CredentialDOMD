import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { billedWRVU } from "./caseBilling.js";
import { formatDate } from "./helpers.js";
import { fileShareText } from "./shareText.js";

/**
 * Career case-log engine. A surgeon's year runs July 1 – June 30 (the
 * training/academic year), so every summary, total, and report buckets
 * by that year — "2018-19" is Jul 1 2018 through Jun 30 2019.
 */

// Training-year label. `startYear` is the July the physician's residency
// began (Settings, profiles.training_start_year): the year starting Jul 1 of
// startYear is PGY 1. With no start year, or for a year before it, the label
// is the plain academic year ("2019-20"). The anchor used to be a hard-coded
// 2018, one physician's residency, so every account's chips and report PDFs
// were labelled from it. The medicine year always runs Jul 1 - Jun 30.
export function pgyLabelOf(academicYear, startYear) {
  const start = parseInt(String(academicYear).slice(0, 4), 10);
  const anchor = parseInt(startYear, 10);
  if (!start || !anchor) return academicYear;
  const n = start - anchor + 1;
  return n >= 1 ? `PGY ${n}` : academicYear;
}

/** "PGY 2 (2019-20)", or just "2019-20" when the year has no PGY label. */
export function yearLabel(academicYear, startYear) {
  const pgy = pgyLabelOf(academicYear, startYear);
  return pgy === academicYear ? String(academicYear) : `${pgy} (${academicYear})`;
}

export function currentAcademicYear(now = new Date()) {
  const y = now.getFullYear();
  const start = now.getMonth() + 1 >= 7 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function academicYearOf(dateStr) {
  if (!dateStr) return "Undated";
  const [y, m] = String(dateStr).split("-").map(Number);
  if (!y || !m) return "Undated";
  const start = m >= 7 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const parseCodes = (c) => {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  return String(c).split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
};

// A case's wRVU: the stored value (from import, or saved with the case)
// wins; a case without one is priced from its codes, the same lines its
// detail view lists as billed, so the card, the totals and Vera agree with it.
export function caseWRVU(item) {
  const v = parseFloat(item?.wRvu ?? item?.w_rvu);
  return Number.isFinite(v) ? v : billedWRVU(item);
}

// Rolling window ending today, independent of the Jul-Jun academic year —
// what the ticket meant by "the last twelve months."
export function filterLastMonths(cases, months, now = new Date()) {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now);
  start.setMonth(start.getMonth() - months);
  const startStr = start.toISOString().slice(0, 10);
  return (cases || []).filter(c => c.date && c.date >= startStr && c.date <= end);
}

/**
 * The year filter a link to `record` should land on: the current filter when
 * it already lists the case, otherwise the case's own academic year
 * ("Undated" for a case with no date, which has its own chip). A link that
 * landed on a year without its case opened nothing, then popped the case
 * open later when the physician changed years.
 */
export function yearShowing(record, year, now = new Date()) {
  if (!record || year === "all") return year;
  if (year === "last12") return filterLastMonths([record], 12, now).length ? year : academicYearOf(record.date);
  return academicYearOf(record.date);
}

/**
 * The year Case Logs opens on: this academic year when it has cases, else the
 * newest year that does (a member whose imported cases all predate this year
 * used to open on "0 cases" and "No cases logged"), else Career when only
 * undated cases exist. With no cases at all, this year.
 */
export function defaultCaseLogYear(cases, now = new Date()) {
  const current = currentAcademicYear(now);
  const years = summarizeByYear(cases).map(y => y.year);
  if (years.length === 0 || years.includes(current)) return current;
  return years.find(y => y !== "Undated") || "all";
}

/**
 * The date line under one year's summary: its Jul 1 - Jun 30 span, or, for
 * the Undated chip (where a link to a case with no date lands), what it holds.
 */
export function academicYearSpanLabel(year) {
  const start = parseInt(String(year).slice(0, 4), 10);
  if (!Number.isFinite(start)) return "Cases with no date";
  return `Jul 1 ${start} - Jun 30 ${start + 1}`;
}

/** Career's date line: from the July the earliest dated case's year began. */
export function careerSpanLabel(cases) {
  const dated = summarizeByYear(cases).map(y => y.year).filter(y => y !== "Undated");
  const first = dated[dated.length - 1];
  return first ? `Jul ${first.slice(0, 4)} - present` : "All cases";
}

export function summarizeByYear(cases) {
  const by = new Map();
  for (const c of cases || []) {
    const ay = academicYearOf(c.date);
    if (!by.has(ay)) by.set(ay, { year: ay, cases: 0, wRVU: 0 });
    const b = by.get(ay);
    b.cases += 1;
    b.wRVU += caseWRVU(c);
  }
  return [...by.values()].sort((a, b) => b.year.localeCompare(a.year));
}

export function buildCaseLogCsv(cases) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["Date,Academic Year,Category,Procedure,Facility,Role,Attending,CPT Codes,wRVU,Complication"];
  const sorted = [...cases].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const c of sorted) {
    lines.push([
      c.date || "", academicYearOf(c.date), c.category || "", c.title || "",
      c.facility || "", c.role || "", c.attending || "",
      parseCodes(c.cptCodes).join(" "), caseWRVU(c) ? caseWRVU(c).toFixed(2) : "",
      c.complication || "",
    ].map(esc).join(","));
  }
  // A byte-order mark and CRLF rows: without the mark Excel read the file as
  // Windows-1252, so "Hôpital" opened as "HÃ´pital" (every other CSV the app
  // writes already starts with one).
  return `\u{FEFF}${lines.join("\r\n")}\r\n`;
}

/** The case log CSV's file name, named like the PDF. */
export const caseLogCsvName = (physician = "Physician", range = null) => `Case Log, ${physician}${range ? " " + range : ""}.csv`;

export function buildCaseLogPdf(cases, { physician = "Physician", year = null, startYear = null } = {}) {
  const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "landscape" });
  const title = year ? `Surgical Case Log, ${year}` : "Surgical Case Log, Career";
  const sorted = [...cases].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const totals = summarizeByYear(sorted);
  const grand = totals.reduce((s, t) => ({ cases: s.cases + t.cases, wRVU: s.wRVU + t.wRVU }), { cases: 0, wRVU: 0 });

  doc.setFont("helvetica", "bold").setFontSize(15).setTextColor(20, 24, 33);
  doc.text(physician, 40, 42);
  doc.setFont("helvetica", "normal").setFontSize(11).setTextColor(90, 98, 110);
  doc.text(`${title} · ${grand.cases} cases · ${grand.wRVU.toFixed(2)} wRVU`, 40, 58);

  // Per-year summary first — the number he actually asks for
  autoTable(doc, {
    startY: 74,
    head: [["Academic Year", "Cases", "wRVU"]],
    body: totals.map(t => [yearLabel(t.year, startYear), String(t.cases), t.wRVU.toFixed(2)]),
    foot: [["Total", String(grand.cases), grand.wRVU.toFixed(2)]],
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [13, 110, 253], fontSize: 9 },
    footStyles: { fillColor: [235, 238, 242], textColor: [20, 24, 33], fontStyle: "bold" },
    margin: { left: 40, right: 40 },
    tableWidth: 260,
  });

  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 18,
    head: [["Date", "Category", "Procedure", "Facility", "Role", "CPT", "wRVU"]],
    body: sorted.map(c => [
      // An undated case says so (it printed an em dash), and a date reads
      // "Aug 12, 2026". The procedure prints whole: the column wraps it (it
      // was cut at 90 characters mid-word).
      c.date ? formatDate(c.date) : "Undated",
      c.category || "",
      String(c.title || ""),
      c.facility || "",
      c.role || "",
      parseCodes(c.cptCodes).join(", "),
      caseWRVU(c) ? caseWRVU(c).toFixed(2) : "",
    ]),
    styles: { fontSize: 7.5, cellPadding: 2.5, overflow: "linebreak" },
    headStyles: { fillColor: [13, 110, 253], fontSize: 8 },
    columnStyles: { 2: { cellWidth: 250 }, 5: { cellWidth: 110 } },
    margin: { left: 40, right: 40 },
  });
  // "page N of M" on every page, once the page count is known.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(160, 165, 172);
    doc.text(`${physician} · ${title} · page ${p} of ${pages}`, 40, doc.internal.pageSize.getHeight() - 20);
  }

  const blob = doc.output("blob");
  return new File([blob], `Case Log, ${physician}${year ? " " + year : ""}.pdf`, { type: "application/pdf" });
}

export async function shareCaseLogFile(file, share = {}) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      // A title and a short email with it (fileShareText): it used to go
      // out with an empty body.
      const { title, text } = share.settings || share.what ? fileShareText(share) : { title: file.name, text: undefined };
      await navigator.share({ title, ...(text ? { text } : {}), files: [file] });
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
