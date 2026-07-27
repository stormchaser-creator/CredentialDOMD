/**
 * Text extraction for Word / Excel / CSV uploads. Gemini can't ingest
 * Office binaries directly, so we extract the text client-side and feed
 * it to the same analyzers as plain text. Parsers are lazy-loaded so the
 * main bundle doesn't carry them.
 */

/**
 * Shared file-picker accept list. iOS grays out files unless the exact
 * MIME type is listed, so extensions AND MIMEs both appear here.
 */
export const UPLOAD_ACCEPT = [
  "image/*",
  ".pdf", "application/pdf",
  ".doc", "application/msword",
  ".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls", "application/vnd.ms-excel",
  ".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv", "text/csv",
].join(",");

export function officeKind(name = "", mime = "") {
  const n = (name || "").toLowerCase();
  const m = (mime || "").toLowerCase();
  if (n.endsWith(".docx") || m.includes("wordprocessingml")) return "docx";
  if (n.endsWith(".doc") || m === "application/msword") return "doc";
  if (n.endsWith(".xlsx") || n.endsWith(".xls") || m.includes("spreadsheetml") || m === "application/vnd.ms-excel") return "excel";
  if (n.endsWith(".csv") || m === "text/csv") return "csv";
  return null;
}

export function isOfficeFile(fileLike) {
  return !!officeKind(fileLike?.name, fileLike?.type);
}

const MAX_CHARS = 100000;

async function toArrayBuffer({ arrayBuffer, dataUrl, file }) {
  if (arrayBuffer) return arrayBuffer;
  if (file) return file.arrayBuffer();
  const res = await fetch(dataUrl);
  return res.arrayBuffer();
}

/**
 * Extract readable text. Accepts { name, type } plus one of:
 * file (File), arrayBuffer, or dataUrl (stored document).
 */
export async function extractOfficeText(src) {
  const kind = officeKind(src.name, src.type);
  if (kind === "doc") {
    throw new Error("Old-format .doc files can't be read — save it as PDF or .docx and upload that.");
  }
  const buf = await toArrayBuffer(src);
  if (kind === "docx") {
    const mammoth = await import("mammoth/mammoth.browser");
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    if (!value?.trim()) throw new Error("No readable text found in this Word document.");
    return value.slice(0, MAX_CHARS);
  }
  if (kind === "excel" || kind === "csv") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "array" });
    const text = wb.SheetNames
      .map(n => `--- Sheet: ${n} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`)
      .join("\n\n");
    if (!text.trim()) throw new Error("No readable cells found in this spreadsheet.");
    return text.slice(0, MAX_CHARS);
  }
  throw new Error("Unsupported file type for text extraction.");
}
