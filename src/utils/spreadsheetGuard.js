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
 * Only header cells are read. A data cell that says "Passport" in a Document
 * column is a record type, not an identifier column.
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

export function spreadsheetRefusal(column) {
  return `This spreadsheet has a "${column}" column. CredentialDOMD does not store patient identifiers. Delete that column and upload it again.`;
}

const cellText = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/**
 * The rows of one sheet that can be its header: the first row with anything
 * in it, and the first row with two or more cells (a report often opens with
 * a one-cell title such as "Case log 2025" above the real headers).
 */
export function headerRows(rows) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r.map(cellText) : []));
  const filled = (r) => r.filter(Boolean).length;
  const first = list.find((r) => filled(r) > 0);
  const wide = list.find((r) => filled(r) > 1);
  return [first, wide].filter((r, i, all) => r && all.indexOf(r) === i);
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
        const reason = identifierReason(cell, "");
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
  if (!isSpreadsheet(src)) return null;
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
