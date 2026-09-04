// The .vcf a phone actually shares, read into a peer reference.
// The card that matters is Apple's: iOS has no Contact Picker API, so
// "Share Contact" is the only route on an iPhone, and Contacts writes a group
// prefix on every property that carries a label. Matching on the property
// name alone missed all of them and landed a name-only reference, which is
// what a physician reported as "the button doesn't add contact info".
// Run: node scripts/contact-import.test.mjs
import { parseVCard } from "../src/utils/contactImport.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${g}\n   want ${w}`); }
};

// What iOS Contacts writes when the numbers carry labels.
const APPLE = [
  "BEGIN:VCARD", "VERSION:3.0",
  "N:Smith;Jane;;;", "FN:Jane Smith",
  "ORG:Memorial Hospital;Neurosurgery",
  "item1.TEL;type=CELL;type=pref:(555) 123-4567",
  "item1.X-ABLabel:mobile",
  "item2.EMAIL;type=INTERNET;type=pref:jsmith@hospital.org",
  "item2.X-ABLabel:work",
  "END:VCARD",
].join("\r\n");

eq("a labelled iPhone card keeps its email and phone", parseVCard(APPLE),
  { name: "Jane Smith", email: "jsmith@hospital.org", phone: "(555) 123-4567", institution: "Memorial Hospital" });

// The unlabelled shape, which always worked and must keep working.
const PLAIN = [
  "BEGIN:VCARD", "VERSION:3.0", "FN:Jane Smith",
  "EMAIL:jsmith@hospital.org", "TEL:(555) 123-4567",
  "ORG:Memorial Hospital;Neurosurgery", "END:VCARD",
].join("\n");
eq("and so does a plain card", parseVCard(PLAIN),
  { name: "Jane Smith", email: "jsmith@hospital.org", phone: "(555) 123-4567", institution: "Memorial Hospital" });

// Escapes: split on the real separators first, unescape after.
eq("an escaped semicolon inside an organisation survives",
  parseVCard("BEGIN:VCARD\nFN:A B\nORG:St. Mary\\;s Hospital;Neurosurgery\nEND:VCARD").institution,
  "St. Mary;s Hospital");
eq("an escaped comma survives too",
  parseVCard("BEGIN:VCARD\nFN:Smith\\, Jane\nEND:VCARD").name, "Smith, Jane");
eq("and the department after the unescaped separator is still dropped",
  parseVCard("BEGIN:VCARD\nFN:A B\nORG:Memorial Hospital;Neurosurgery;Spine\nEND:VCARD").institution,
  "Memorial Hospital");

// A card with no FN falls back to the structured name, which is family-first.
eq("no formatted name means the structured one is used",
  parseVCard("BEGIN:VCARD\nN:Logsdon;Daniel;;Dr.;MD\nTEL:(555) 000-1111\nEND:VCARD").name, "Daniel Logsdon");
eq("a group prefix on N is read too",
  parseVCard("BEGIN:VCARD\nitem1.N:Logsdon;Daniel;;;\nEND:VCARD").name, "Daniel Logsdon");

// Folding: a continuation line starts with a space.
eq("a folded line is rejoined",
  parseVCard("BEGIN:VCARD\r\nFN:Jane\r\n  Smith\r\nEND:VCARD").name, "Jane Smith");

// The first value wins, and a second one does not overwrite it.
eq("the first phone on the card is the one taken",
  parseVCard("BEGIN:VCARD\nFN:A B\nTEL;type=CELL:111\nTEL;type=WORK:222\nEND:VCARD").phone, "111");

// Nothing usable is null, not an empty record: the caller shows an error
// rather than filing a blank reference.
eq("a card with nothing on it is nothing", parseVCard("BEGIN:VCARD\nVERSION:3.0\nEND:VCARD"), null);
eq("empty text is nothing", parseVCard(""), null);
eq("null is nothing", parseVCard(null), null);
eq("a line with no colon does not throw", parseVCard("BEGIN:VCARD\nGARBAGE\nFN:A B\nEND:VCARD").name, "A B");

// The rule the setup board reads: a reference counts only with a way to
// reach the person, which is why losing the email and phone mattered.
{
  const c = parseVCard(APPLE);
  eq("a card read this way is reachable", !!(c.name && (c.email || c.phone)), true);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
