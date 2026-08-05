import * as XLSX from "xlsx";
import { caseWRVU } from "./caseLogReport";

/**
 * Vera's export engine: turns a section of the user's own data into a real
 * spreadsheet file, generated entirely on-device. Each section declares the
 * field its date filter runs on and how a record flattens into columns.
 */
const EXPORTS = {
  caseLogs: {
    label: "Case log", dateField: "date",
    row: c => ({
      Date: c.date || "", Category: c.category || "", Description: c.title || "",
      Facility: c.facility || "", Role: c.role || "", Attending: c.attending || "",
      "CPT Codes": c.cptCodes || "", wRVU: caseWRVU(c) || "",
      Complication: c.complication || "", Notes: c.notes || "",
    }),
  },
  cme: {
    label: "CME", dateField: "date",
    row: x => ({
      Date: x.date || "", Title: x.title || "", Hours: x.hours ?? "",
      Category: x.category || "", Provider: x.provider || "",
      "Certificate #": x.certificateNumber || "",
      Topics: Array.isArray(x.topics) ? x.topics.join(", ") : (x.topics || ""),
      Notes: x.notes || "",
    }),
  },
  workLog: {
    label: "Work log", dateField: "date",
    row: e => ({
      Date: e.date || "", Type: e.type || "", "Billed minutes": e.billedMin ?? "",
      Description: e.description || "", Invoiced: e.invoiceId ? "yes" : "no",
    }),
  },
  licenses: {
    label: "Licenses", dateField: "expirationDate",
    row: l => ({
      Type: l.type || "", Name: l.name || "", State: l.state || "",
      "License #": l.licenseNumber || "", Issued: l.issuedDate || "",
      Expires: l.expirationDate || "", Notes: l.notes || "",
    }),
  },
  invoices: {
    label: "Invoices", dateField: "sentAt",
    row: i => ({
      Number: i.number || "", Total: i.totalAmount ?? "",
      Sent: String(i.sentAt || "").slice(0, 10), Paid: i.paidAt ? String(i.paidAt).slice(0, 10) : "",
    }),
  },
};

export const EXPORTABLE_SECTIONS = Object.keys(EXPORTS);

/** Filter + flatten one section. Dates compare as YYYY-MM-DD strings. */
export function buildExport(data, { section, dateFrom, dateTo }) {
  const spec = EXPORTS[section];
  if (!spec) throw new Error(`Exporting "${section}" isn't supported yet — case logs, CME, work log, licenses, and invoices are.`);
  let items = [...(data[section] || [])];
  if (dateFrom || dateTo) {
    items = items.filter(it => {
      const d = String(it[spec.dateField] || "").slice(0, 10);
      if (!d) return false;
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    });
  }
  items.sort((a, b) => String(a[spec.dateField] || "").localeCompare(String(b[spec.dateField] || "")));
  return { rows: items.map(spec.row), label: spec.label };
}

/** Rows → a real .xlsx (or .csv) File, built in the browser. */
export function makeSpreadsheetFile({ rows, label, format = "xlsx", filename }) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, label.slice(0, 31));
  const isCsv = format === "csv";
  const out = XLSX.write(wb, { bookType: isCsv ? "csv" : "xlsx", type: "array" });
  const mime = isCsv ? "text/csv"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return new File([out], filename, { type: mime });
}
