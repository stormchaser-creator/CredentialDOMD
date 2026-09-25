// A minimal zip writer for tests: enough to build a .docx or .xlsx whose
// parts are real deflated (or stored) entries, so the server-side reader in
// supabase/functions/_shared/officeText.mjs is tested on the format it will
// meet, not on a stub.
import { deflateRawSync, crc32 } from "node:zlib";

/** entries: [{ name, text, store? }] -> Uint8Array zip. */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.text, "utf8");
    const comp = e.store ? data : deflateRawSync(data);
    const method = e.store ? 0 : 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A .docx whose body is these paragraphs. */
export function makeDocx(paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("");
  return makeZip([
    { name: "[Content_Types].xml", text: "<?xml version=\"1.0\"?><Types/>" },
    { name: "word/document.xml", text: `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>` },
  ]);
}

/** An .xlsx whose shared strings are these cells. */
export function makeXlsx(cells) {
  const strings = cells.map((c) => `<si><t>${esc(c)}</t></si>`).join("");
  return makeZip([
    { name: "xl/sharedStrings.xml", text: `<?xml version="1.0"?><sst>${strings}</sst>` },
    { name: "xl/worksheets/sheet1.xml", text: `<?xml version="1.0"?><worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>481234</v></c></row></sheetData></worksheet>` },
  ]);
}
