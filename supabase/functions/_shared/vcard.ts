/**
 * The vCard a phone shares, read on the server.
 *
 * An iPhone cannot hand a contact to a web app: iOS has no Contact Picker API
 * and Safari ignores the Web Share Target manifest, so the share sheet has no
 * way to reach this app. What the share sheet DOES have is Mail, and what Mail
 * sends is the same .vcf the app already reads on the client. So the route a
 * physician asked for, "share a contact straight into references the way I
 * share to text or email", is email: Share Contact > Mail > contacts@.
 *
 * This is the client parser (src/utils/contactImport.js) ported, plus the one
 * thing the client never needed: a .vcf shared from a multi-select carries
 * SEVERAL cards in one file, and dropping all but the first would silently lose
 * four of five people. scripts/vcard-shared.test.mjs runs both files over the
 * same fixtures and fails if they ever disagree on a single card.
 *
 * Pure by design (no Deno, no Supabase): the test imports it under plain node.
 */

export interface VCardContact {
  name: string;
  email: string;
  phone: string;
  institution: string;
}

/** "item1.TEL;type=CELL" -> "TEL". The group and the parameters both go. */
function propertyName(head: string): string {
  const semi = head.indexOf(";");
  const prop = semi === -1 ? head : head.slice(0, semi);
  const dot = prop.lastIndexOf(".");
  return (dot === -1 ? prop : prop.slice(dot + 1)).trim().toUpperCase();
}

/** Split a structured value on its separators, leaving escaped ones alone. */
function splitStructured(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) { cur += c + raw[i + 1]; i += 1; continue; }
    if (c === ";") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** The characters vCard escapes, put back. */
function unescapeValue(v: string): string {
  return String(v)
    .replace(/\\n/gi, "\n")
    .replace(/\\([,;\\])/g, "$1")
    .trim();
}

/** Unfold: a line starting with a space or tab continues the one before it. */
function linesOf(text: string): string[] {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function cardFrom(lines: string[]): VCardContact | null {
  let name = "", email = "", phone = "", org = "";
  let structuredName: string[] | null = null;
  for (const ln of lines) {
    const i = ln.indexOf(":");
    if (i === -1) continue;
    const prop = propertyName(ln.slice(0, i));
    const raw = ln.slice(i + 1);
    if (prop === "FN" && !name) name = unescapeValue(raw);
    else if (prop === "EMAIL" && !email) email = unescapeValue(raw);
    else if (prop === "TEL" && !phone) phone = unescapeValue(raw);
    else if (prop === "ORG" && !org) org = unescapeValue(splitStructured(raw)[0]);
    else if (prop === "N" && !structuredName) structuredName = splitStructured(raw).map(unescapeValue);
  }
  // No formatted name on the card: build one from the structured N property,
  // which is given family-first.
  if (!name && structuredName) {
    name = [structuredName[1], structuredName[0]].filter(Boolean).join(" ").trim();
  }
  if (!name && !email && !phone) return null;
  return { name, email, phone, institution: org };
}

/** One card, the first one. Identical to the client's parseVCard. */
export function parseVCard(text: string): VCardContact | null {
  return cardFrom(linesOf(text));
}

/**
 * Every card in the file, in order.
 *
 * A .vcf shared from a multi-select holds one BEGIN:VCARD / END:VCARD block per
 * person. A file with no BEGIN line at all is still read as a single card,
 * because some clients strip them when they inline the card in a message body.
 */
export function parseVCards(text: string, limit = 25): VCardContact[] {
  const lines = linesOf(text);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const ln of lines) {
    const t = ln.trim().toUpperCase();
    if (t === "BEGIN:VCARD") { current = []; continue; }
    if (t === "END:VCARD") { if (current) blocks.push(current); current = null; continue; }
    if (current) current.push(ln);
  }
  if (current?.length) blocks.push(current);       // unterminated last card
  if (!blocks.length) blocks.push(lines);          // no BEGIN line at all

  const out: VCardContact[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const card = cardFrom(block);
    if (!card) continue;
    // The same person shared twice is one reference, not two.
    const key = `${card.name.toLowerCase()}|${card.email.toLowerCase()}|${card.phone.replace(/\D/g, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
    if (out.length >= limit) break;
  }
  return out;
}

/** Whether an attachment looks like a contact card. */
export function isVCardAttachment(filename: string, contentType: string): boolean {
  const n = String(filename || "").toLowerCase();
  const t = String(contentType || "").toLowerCase();
  return n.endsWith(".vcf") || n.endsWith(".vcard")
    || t.startsWith("text/vcard") || t.startsWith("text/x-vcard") || t.startsWith("text/directory");
}

/** Whether a message body carries a card inline rather than as a file. */
export function looksLikeVCardText(text: string): boolean {
  return /BEGIN:VCARD/i.test(String(text || ""));
}
