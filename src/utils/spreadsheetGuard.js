import { identifierReason } from "./customCategories.js";

/**
 * The spreadsheet guard.
 *
 * A spreadsheet is the one upload whose column headers say what it holds
 * before anything is sent anywhere. A case log exported from a hospital
 * system, a billing report, an agency's call roster: each can carry an MRN, a
 * patient name or a date of birth in a column the physician never looked at,
 * and once uploaded the whole file sits in the cloud. CredentialDOMD keeps no
 * patient identifiers, so a spreadsheet whose header row names one is refused
 * here, on the device, with the column named so the physician knows exactly
 * what to delete.
 *
 * The test for a header is the same gate every other path uses
 * (identifierReason in customCategories.js): MRN, patient name or ID, date of
 * birth, SSN or TIN, account, encounter, driver's licence or passport number.
 * A few column names that only mean an identifier as a whole header cell
 * (FIN, CSN, HAR, Visit #, Subscriber ID) are added here, not to that gate.
 * Only header cells are read. A data cell that says "Passport" in a Document
 * column is a record type, not an identifier column.
 *
 * A plain-text file whose lines split on the same tab, comma, semicolon or
 * pipe is a spreadsheet too: that is how an Epic or Cerner report export
 * named export.txt arrives.
 */

const SHEET_EXT = /\.(csv|tsv|xlsx|xlsm|xlsb|xls|ods)$/i;
const SHEET_MIME = /^(text\/(csv|x-csv|comma-separated-values|tab-separated-values)|application\/(csv|x-csv|vnd\.ms-excel(\.[a-z0-9.]+)?|vnd\.openxmlformats-officedocument\.spreadsheetml\.[a-z]+|vnd\.oasis\.opendocument\.spreadsheet))$/i;

/** Rows read from the top of each sheet: enough to get past a title block. */
const HEADER_SCAN_ROWS = 25;
const MAX_COLUMN_SHOWN = 60;

export const UNREADABLE_SPREADSHEET =
  "This spreadsheet could not be opened to check its columns. Save it as .xlsx or .csv and upload it again.";

export function isSpreadsheet(file) {
  const name = String(file?.name || "");
  const type = String(file?.type || "").toLowerCase().split(";")[0].trim();
  return SHEET_EXT.test(name) || SHEET_MIME.test(type);
}

const TEXT_EXT = /\.(txt|text|tab)$/i;
/** A plain-text file that may be a delimited export. */
export function isPlainText(file) {
  const name = String(file?.name || "");
  const type = String(file?.type || "").toLowerCase().split(";")[0].trim();
  return TEXT_EXT.test(name) || type === "text/plain";
}

/** Bytes of a text file read to look for a header: far more than a title block. */
const TEXT_SCAN_BYTES = 64 * 1024;

/**
 * The rows of a plain-text file when its first lines split on one delimiter
 * the same number of times (at least two lines, at least once each), or null
 * when it reads as ordinary text.
 */
export function delimitedRows(text) {
  const lines = String(text || "").split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, HEADER_SCAN_ROWS);
  if (lines.length < 2) return null;
  for (const d of ["\t", ",", ";", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const most = Math.max(...counts);
    if (most < 1 || counts.filter((c) => c === most).length < 2) continue;
    return lines.map((l) => l.split(d).map((c) => c.replace(/^\s*"|"\s*$/g, "")));
  }
  return null;
}

export function spreadsheetRefusal(column) {
  return `This spreadsheet has a "${column}" column. CredentialDOMD does not store patient identifiers. Delete that column and upload it again.`;
}

/**
 * A pick of several files reports each refusal after the loop, ahead of what
 * the last file said. Without it, the refusal of caselog.xlsx is replaced by
 * the next file's "3 fields filled." before anyone can read it, and the
 * physician believes both went in. Returns a state updater for the message.
 */
export function withRefusals(refused) {
  return (current) => {
    const head = refused.join(" ");
    return !current || refused.includes(current) ? head : `${head} ${current}`;
  };
}

const cellText = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/**
 * The rows of one sheet that can be its header. The table's header is the
 * first row as wide as the widest row near the top; everything above it is a
 * title, a metadata block ("Date Range:" | "01/01/2025 - 12/31/2025") or a
 * merged group header ("Patient Info" over three columns), and all of it is
 * read. The data rows below the header are not, so a cell that says
 * "Passport" in a Document column is never judged as a column name.
 */
export function headerRows(rows) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, HEADER_SCAN_ROWS)
    .map((r) => (Array.isArray(r) ? r.map(cellText) : []));
  const filled = (r) => r.filter(Boolean).length;
  const widest = Math.max(0, ...list.map(filled));
  const out = [];
  for (const r of list) {
    const n = filled(r);
    if (!n) continue;
    out.push(r);
    if (n === widest) break;
  }
  return out;
}

// Whole-cell column names that mean a patient or encounter identifier in a
// hospital export, and something else (or nothing) in a sentence, so they
// live here and not in the general gate. "Member ID" is left out on purpose:
// a society member ID (AANS-4471) is the physician's own.
const SHEET_ONLY_LABELS = [
  [/^(fin|csn|har|visit\s*(?:#|no\.?|number|id))$/i, "an encounter number"],
  [/^subscriber\s*(?:#|no\.?|number|id)$/i, "a patient identifier"],
];

function columnReason(cell) {
  const reason = identifierReason(cell, "");
  if (reason) return reason;
  const bare = cell.replace(/[\s:]+$/, "");
  for (const [re, why] of SHEET_ONLY_LABELS) if (re.test(bare)) return why;
  return null;
}

/**
 * The first header, across every sheet, that names an identifier.
 * `sheets` is an array of row arrays (one per sheet), each row an array of cells.
 * Returns { column, reason } or null.
 */
export function identifierColumn(sheets) {
  for (const rows of Array.isArray(sheets) ? sheets : []) {
    for (const row of headerRows(rows)) {
      for (const cell of row) {
        if (!cell) continue;
        const reason = columnReason(cell);
        if (reason) {
          const column = cell.length > MAX_COLUMN_SHOWN ? `${cell.slice(0, MAX_COLUMN_SHOWN)}...` : cell;
          return { column, reason };
        }
      }
    }
  }
  return null;
}

/** The top rows of every sheet in a workbook (xlsx, xls, csv, ods). */
export async function readSheetHeads(buffer) {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buffer, { type: "array", sheetRows: HEADER_SCAN_ROWS });
  return wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "", blankrows: false }));
}

async function bytesOf(src) {
  if (src?.arrayBuffer) return src.arrayBuffer();
  if (src?.dataUrl) return (await fetch(src.dataUrl)).arrayBuffer();
  return null;
}

/**
 * Resolves to the sentence to show when this upload is refused, or null when
 * it may go ahead. Anything that is not a spreadsheet passes untouched. A
 * spreadsheet that cannot be opened is refused too: a file whose columns
 * cannot be read cannot be shown to be free of identifiers.
 *
 * `src` is a File, or { name, type, dataUrl } for a file already read.
 */
export async function spreadsheetGuard(src) {
  if (!isSpreadsheet(src)) {
    if (!isPlainText(src)) return null;
    // Ordinary text passes; a delimited export is judged like a CSV. Text
    // that cannot be read here is left to the upload path's own handling.
    let rows = null;
    try {
      const head = typeof src?.slice === "function" ? src.slice(0, TEXT_SCAN_BYTES) : src;
      const buffer = await bytesOf(head);
      if (buffer) rows = delimitedRows(new TextDecoder().decode(buffer.slice(0, TEXT_SCAN_BYTES)));
    } catch { return null; }
    const hit = rows && identifierColumn([rows]);
    return hit ? spreadsheetRefusal(hit.column) : null;
  }
  let sheets;
  try {
    const buffer = await bytesOf(src);
    if (!buffer) return UNREADABLE_SPREADSHEET;
    sheets = await readSheetHeads(buffer);
  } catch {
    return UNREADABLE_SPREADSHEET;
  }
  const hit = identifierColumn(sheets);
  return hit ? spreadsheetRefusal(hit.column) : null;
}
