import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

/**
 * Career case-log engine. A surgeon's year runs July 1 – June 30 (the
 * training/academic year), so every summary, total, and report buckets
 * by that year — "2018-19" is Jul 1 2018 through Jun 30 2019.
 */

// Training-year label: PGY 1 began Jul 1 2018, so the year starting Jul 1
// of (2017 + N) is PGY N. The medicine year always runs Jul 1 – Jun 30.
const PGY_ANCHOR = 2018; // start year of PGY 1
export function pgyLabelOf(academicYear) {
  const start = parseInt(String(academicYear).slice(0, 4), 10);
  if (!start) return academicYear;
  const n = start - PGY_ANCHOR + 1;
  return n >= 1 ? `PGY ${n}` : academicYear;
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

// A case's wRVU: the stored value from import wins; nothing is invented here.
export function caseWRVU(item) {
  const v = parseFloat(item.wRvu ?? item.w_rvu);
  return Number.isFinite(v) ? v : 0;
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
  return lines.join("\n");
}

export function buildCaseLogPdf(cases, { physician = "Physician", year = null } = {}) {
  const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "landscape" });
  const title = year ? `Surgical Case Log — ${year}` : "Surgical Case Log — Career";
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
    body: totals.map(t => [`${pgyLabelOf(t.year)} (${t.year})`, String(t.cases), t.wRVU.toFixed(2)]),
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
      c.date || "—",
      c.category || "",
      String(c.title || "").slice(0, 90),
      c.facility || "",
      c.role || "",
      parseCodes(c.cptCodes).join(", "),
      caseWRVU(c) ? caseWRVU(c).toFixed(2) : "",
    ]),
    styles: { fontSize: 7.5, cellPadding: 2.5, overflow: "linebreak" },
    headStyles: { fillColor: [13, 110, 253], fontSize: 8 },
    columnStyles: { 2: { cellWidth: 250 }, 5: { cellWidth: 110 } },
    margin: { left: 40, right: 40 },
    didDrawPage: () => {
      doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(160, 165, 172);
      doc.text(`${physician} — ${title} · page ${doc.getNumberOfPages()}`, 40, doc.internal.pageSize.getHeight() - 20);
    },
  });

  const blob = doc.output("blob");
  return new File([blob], `Case Log — ${physician}${year ? " " + year : ""}.pdf`, { type: "application/pdf" });
}

export async function shareCaseLogFile(file) {
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
