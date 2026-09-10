// The contact card, read the same way on both sides.
//
// An iPhone cannot hand a contact to a web app (no Contact Picker API, and
// Safari ignores the Web Share Target manifest), so the share sheet route a
// physician asked for is Mail: Share Contact > Mail > contacts@credentialdomd
// .com. That means the vCard is now parsed in two places, and two parsers that
// drift are two different answers to "who did I just add". Every fixture below
// runs through both.
// Run: node scripts/vcard-shared.test.mjs
import { parseVCard as clientParse } from "../src/utils/contactImport.js";
import {
  parseVCard as serverParse, parseVCards, isVCardAttachment, looksLikeVCardText,
} from "../supabase/functions/_shared/vcard.ts";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${g}\n   want ${w}`); }
};
const ok = (n, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${n} ${extra}`); } };

const card = (lines) => ["BEGIN:VCARD", "VERSION:3.0", ...lines, "END:VCARD"].join("\r\n");

// What iOS Contacts writes when the numbers carry labels: a group prefix on
// every labelled property. Matching on the property name alone missed all of
// them, which is the bug a physician reported as "it doesn't add contact info".
const APPLE = card([
  "N:Smith;Jane;;;", "FN:Jane Smith",
  "ORG:Memorial Hospital;Neurosurgery",
  "item1.TEL;type=CELL;type=pref:(555) 123-4567",
  "item1.X-ABLabel:mobile",
  "item2.EMAIL;type=INTERNET;type=pref:jsmith@hospital.org",
  "item2.X-ABLabel:work",
]);
const PLAIN = card(["FN:John Doe", "EMAIL:jd@clinic.org", "TEL:5551112222", "ORG:City Clinic;Spine"]);
const ESCAPED = card(["FN:A B", "ORG:St. Mary\\;s Hospital;Neurosurgery", "EMAIL:ab@x.org"]);
const N_ONLY = card(["N:Patel;Ajay;;;", "TEL:5553334444"]);
const FIXTURES = { APPLE, PLAIN, ESCAPED, N_ONLY };

// ── The two parsers agree, card for card ──────────────────────────────────
for (const [name, text] of Object.entries(FIXTURES)) {
  eq(`${name}: the server reads what the client reads`, serverParse(text), clientParse(text));
  eq(`${name}: and the first of many is that same card`, parseVCards(text)[0], clientParse(text));
}
eq("the labelled iPhone card is fully read", serverParse(APPLE),
  { name: "Jane Smith", email: "jsmith@hospital.org", phone: "(555) 123-4567", institution: "Memorial Hospital" });
eq("an escaped semicolon is kept, not cut", serverParse(ESCAPED).institution, "St. Mary;s Hospital");
eq("a card with no FN is named from N, given name first", serverParse(N_ONLY).name, "Ajay Patel");
eq("nothing usable is null on both sides",
  [serverParse("hello"), clientParse("hello")], [null, null]);
eq("and so is empty", serverParse(""), null);

// ── Several people in one file, which is what a multi-select shares ───────
{
  const many = [APPLE, PLAIN, N_ONLY].join("\r\n");
  const list = parseVCards(many);
  eq("three cards in one file are three references", list.length, 3);
  eq("in the order they were shared", list.map((c) => c.name), ["Jane Smith", "John Doe", "Ajay Patel"]);
  eq("the client's single-card read is still the first", clientParse(many), list[0]);

  eq("the same person shared twice is one reference", parseVCards([APPLE, APPLE].join("\n")).length, 1);
  eq("a card with no END line is still read", parseVCards("BEGIN:VCARD\nFN:Half Card\nTEL:5550000").length, 1);
  eq("a body with no BEGIN line at all is read as one card",
    parseVCards("FN:Inline Person\nEMAIL:ip@x.org")[0].name, "Inline Person");
  eq("a file of nothing yields nothing", parseVCards("just some words"), []);
  ok("the count is capped, so one email cannot write a thousand rows",
    parseVCards(Array.from({ length: 40 }, (_, i) => card([`FN:P${i}`, `TEL:555000${i}`])).join("\n")).length === 25);
  eq("and the cap is settable", parseVCards([APPLE, PLAIN].join("\n"), 1).length, 1);
}

// ── Recognising the attachment, and the inline case ──────────────────────
ok("an iPhone .vcf is recognised", isVCardAttachment("Jane Smith.vcf", "text/vcard"));
ok("by extension alone when the type is missing", isVCardAttachment("contact.VCF", ""));
ok("by type alone when the name is missing", isVCardAttachment("", "text/x-vcard; charset=utf-8"));
ok("a PDF is not a contact card", !isVCardAttachment("certificate.pdf", "application/pdf"));
ok("and neither is a photo", !isVCardAttachment("IMG_1.jpg", "image/jpeg"));
ok("a body carrying a card is spotted", looksLikeVCardText("see below\nBEGIN:VCARD\nFN:X\nEND:VCARD"));
ok("an ordinary email body is not", !looksLikeVCardText("Here is Dr. Smith's number, 555 1234"));

// ── House rules ──────────────────────────────────────────────────────────
ok("no em dash in anything these produce",
  Object.values(FIXTURES).every((t) => !JSON.stringify(serverParse(t)).includes("—")));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
