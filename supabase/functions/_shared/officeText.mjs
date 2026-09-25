/**
 * The text of a Word, Excel, CSV, text or RTF attachment, read on the server
 * so it can be screened BEFORE it is stored.
 *
 * The app screens these files before upload (DocumentsSection.handleFiles:
 * extractOfficeText, then screenDocument, and "a patient chart must never
 * reach the server, so refusing beats deleting"). Email must hold the same
 * line: a case-log export forwarded to docs@ with patient names and MRNs is
 * exactly how 1,380 MRNs reached case logs in August 2026. So email-inbound
 * reads each office attachment here, screens the text with the app's own
 * screenDocument, and stores only what passes. A file this cannot read (an
 * old binary .doc or .xls, a damaged or encrypted archive) cannot be
 * screened, so it is not stored either, and the reply says so.
 *
 * .docx and .xlsx are zip archives of XML. The reader below finds the parts
 * that hold text (word/document.xml with its headers, footers and notes;
 * xl/sharedStrings.xml and the worksheets) through the zip's central
 * directory and inflates them with DecompressionStream("deflate-raw"), which
 * Deno and node both have, so no library is bundled and node tests it as is
 * (scripts/office-text.test.mjs). Every inflated part is capped, so a zip
 * bomb costs at most MAX_PART_BYTES per part and MAX_TOTAL_BYTES in all.
 */

export const MAX_PART_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;

/** "docx" | "xlsx" | "doc" | "xls" | "csv" | "text" | "rtf" | null, as the app's officeKind reads a name and type. */
export function officeKind(name = "", mime = "") {
  const n = String(name || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (n.endsWith(".docx") || m.includes("wordprocessingml")) return "docx";
  if (n.endsWith(".xlsx") || m.includes("spreadsheetml")) return "xlsx";
  if (n.endsWith(".doc") || m === "application/msword") return "doc";
  if (n.endsWith(".xls") || m === "application/vnd.ms-excel") return "xls";
  if (n.endsWith(".csv") || m === "text/csv" || m === "application/csv") return "csv";
  if (n.endsWith(".rtf") || m.includes("rtf")) return "rtf";
  if (n.endsWith(".txt") || m === "text/plain") return "text";
  return null;
}

// --- Zip ---------------------------------------------------------------------

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** The central directory of a zip: [{ name, method, compSize, size, offset, flags }], or null when it is not a readable zip. */
export function zipEntries(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // End of central directory: 22 bytes plus a comment of up to 65535.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  if (p >= b.length) return null;   // a ZIP64 archive or a damaged one
  const out = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) return null;
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const compSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const offset = u32(b, p + 42);
    const name = decoder.decode(b.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, compSize, size, offset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** One entry's bytes, inflated and capped at `max`; null when it cannot be read (encrypted, an unknown method, damaged). */
async function readEntry(b, e, max) {
  if (e.flags & 1) return null;                         // encrypted
  if (e.compSize === 0xffffffff || e.offset === 0xffffffff) return null;   // ZIP64
  const h = e.offset;
  if (h + 30 > b.length || u32(b, h) !== 0x04034b50) return null;
  const start = h + 30 + u16(b, h + 26) + u16(b, h + 28);
  const end = start + e.compSize;
  if (end > b.length) return null;
  const raw = b.subarray(start, end);
  if (e.method === 0) return raw.subarray(0, max);
  if (e.method !== 8) return null;
  try {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks = [];
    let got = 0;
    while (got < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* already closed */ }
    const out = new Uint8Array(Math.min(got, max));
    let o = 0;
    for (const c of chunks) {
      const take = Math.min(c.byteLength, out.length - o);
      out.set(c.subarray(0, take), o);
      o += take;
      if (o >= out.length) break;
    }
    return out;
  } catch {
    return null;
  }
}

// --- XML to text -------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Word XML: paragraphs, breaks and cells become line breaks and tabs, every tag goes. */
function wordXmlText(xml) {
  return decodeEntities(xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>|<w:cr\/>|<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, ""));
}

/** Excel XML: the text of every shared string, inline string and cell value, one per line. */
function sheetXmlText(xml) {
  const out = [];
  const re = /<(t|v)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) out.push(decodeEntities(m[2]));
  return out.join("\n");
}

const WORD_PARTS = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/i;
const SHEET_PARTS = /^xl\/(?:sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/i;

async function zipText(bytes, kind) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const entries = zipEntries(b);
  if (!entries) return null;
  const want = kind === "docx" ? WORD_PARTS : SHEET_PARTS;
  const parts = entries.filter((e) => want.test(e.name));
  // The part that must be there: a .docx without word/document.xml, or an
  // .xlsx without a single sheet, is not the file its name says.
  if (kind === "docx" && !parts.some((e) => /^word\/document\.xml$/i.test(e.name))) return null;
  if (kind === "xlsx" && !parts.some((e) => /worksheets\//i.test(e.name))) return null;
  const decoder = new TextDecoder();
  const texts = [];
  let total = 0;
  for (const e of parts) {
    const budget = Math.min(MAX_PART_BYTES, MAX_TOTAL_BYTES - total);
    if (budget <= 0) return null;   // more text than the cap: not screened, so not kept
    const data = await readEntry(b, e, budget + 1);
    if (!data) return null;
    if (data.byteLength > budget) return null;
    total += data.byteLength;
    const xml = decoder.decode(data);
    texts.push(kind === "docx" ? wordXmlText(xml) : sheetXmlText(xml));
  }
  return texts.join("\n");
}

// --- The entry point ---------------------------------------------------------

/**
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {string} mime
 * @returns {Promise<{ kind: string | null, text: string | null }>}
 *   kind null: not an office file (screen it some other way).
 *   text null: an office file whose text could not be read, so it cannot be
 *   screened and must not be stored.
 */
export async function officeText(bytes, name, mime) {
  const kind = officeKind(name, mime);
  if (!kind) return { kind: null, text: null };
  if (kind === "doc" || kind === "xls") return { kind, text: null };
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let text = null;
  if (kind === "docx" || kind === "xlsx") {
    text = await zipText(b, kind);
  } else {
    text = new TextDecoder("utf-8").decode(b);
    // RTF: control words and groups out, so the screen reads the prose.
    if (kind === "rtf") text = text.replace(/\\'[0-9a-f]{2}/gi, " ").replace(/\\[a-z]+-?\d* ?/gi, " ").replace(/[{}]/g, "");
  }
  if (text == null) return { kind, text: null };
  return { kind, text: text.replace(/[ \t]+/g, " ").slice(0, MAX_TEXT_CHARS) };
}
