// contacts@ end to end through supabase/functions/email-inbound/index.ts,
// with every network edge replaced (scripts/email-inbound-harness.mjs).
//
// A contact card emailed to contacts@ becomes a peer reference, and peer
// references reach credentialers (Vera's reference drafts, shares). So a card
// is written straight into the account only when the forward is POSITIVELY
// authenticated (dmarc=pass, or aligned SPF and DKIM), the rule docs@ and
// cme@ file by. A forward that merely fails to fail (no DMARC on the domain,
// SPF passing for an attacker's own envelope) is staged for the physician to
// add in the app instead of written (INTAKE-009). Synthetic people only.
// Run: node --test scripts/email-inbound-contacts.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadFunction, resetWorld, deliver, harness } from "./email-inbound-harness.mjs";

const PROFILE = "5c0e8d2a-7f41-4d4b-9a57-3f9e7d1c2b10";
const CLERK = "user_contactsSynthetic";
const ME = "rowan.testa@clinic.example";
const AUTH_PASS = "mx.resend.com; dmarc=pass header.from=clinic.example";
// What a forged From: on a domain with no DMARC looks like: nothing fails.
const AUTH_NONE = "mx.resend.com; spf=pass smtp.mailfrom=attacker.example; dkim=none; dmarc=none header.from=clinic.example";
const AUTH_FAIL = "mx.resend.com; dmarc=fail header.from=clinic.example";

const vcard = (...people) => people.map((p) => [
  "BEGIN:VCARD", "VERSION:3.0", `FN:${p.name}`, p.org ? `ORG:${p.org}` : null, p.email ? `EMAIL;TYPE=WORK:${p.email}` : null, p.phone ? `TEL;TYPE=CELL:${p.phone}` : null, "END:VCARD",
].filter(Boolean).join("\r\n")).join("\r\n");
const CASEY = { name: "Casey Example", org: "Osterly Example Hospital", email: "casey.example@osterly-health.example", phone: "555-0100" };
const JORDAN = { name: "Jordan Sample", org: "Quillfeather Example Clinic", email: "jordan.sample@quillfeather.example", phone: "555-0101" };

let n = 0;
const sendCard = (people, over = {}) => deliver({
  id: `c${++n}`, from: `Rowan Testa <${ME}>`, to: "contacts@credentialdomd.com", subject: "Contact", text: "",
  attachments: [{ filename: "contact.vcf", contentType: "text/vcard", bytes: new TextEncoder().encode(vcard(...people)) }],
  ...over,
});
const rows = (t) => harness.db.rows(t);
const toPhysician = () => harness.sent.filter((m) => m.to?.[0] === ME);

function seed() {
  rows("mailbox_claims").push({ address: ME, profile_id: PROFILE, proof: "verified", terminal_at: null });
  rows("profiles").push({ id: PROFILE, auth_user_id: CLERK, email: ME, access_status: "active", verified_email: ME, deleted_at: null, name: "Rowan Testa", degree_type: "MD" });
}

before(async () => { await loadFunction(); });
beforeEach(() => { resetWorld(); seed(); });

test("a positively authenticated card is added to peer references", async () => {
  harness.rawAuth = AUTH_PASS;
  const r = await sendCard([CASEY]);
  assert.equal(r.body.route, "contacts");
  const refs = rows("peer_references");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, "Casey Example");
  assert.equal(refs[0].user_id, PROFILE);
  assert.equal(rows("intake_proposals").length, 0);
  assert.match(toPhysician()[0].text, /^Added Casey Example to your peer references\./);
  // The app labels the screen Credentials > Peer References; "References"
  // alone matched nothing he could see (link audit, 2026-10-01).
  const text = toPhysician()[0].text;
  assert.match(text, /Open Credentials > Peer References and set the relationship/);
  assert.match(text, /\(Credentials > Peer References\)/);
  assert.ok(!/\(References\)|Open References/.test(text), text);
});

test("a forward that only fails to fail writes nothing to peer references; the card waits in the app", async () => {
  harness.rawAuth = AUTH_NONE;
  const r = await sendCard([CASEY, JORDAN]);
  assert.equal(r.body.route, "contacts");
  assert.equal(rows("peer_references").length, 0, "a spoof-shaped forward must not write references");
  const notes = rows("intake_proposals");
  assert.equal(notes.length, 1, "the cards are staged as a note to add from the app");
  const note = notes[0];
  assert.equal(note.user_id, PROFILE);
  assert.equal(note.verified, false);
  assert.equal(note.status, "new");
  const items = note.items.filter((i) => i.kind === "record");
  assert.deepEqual(items.map((i) => [i.section, i.state, i.fields.name]), [["peerReferences", "proposed", "Casey Example"], ["peerReferences", "proposed", "Jordan Sample"]]);
  assert.ok(new TextEncoder().encode(JSON.stringify(note.items)).length <= 4096, "within the table's 4 KB cap");
  const text = toPhysician()[0].text;
  assert.ok(!/^Added/.test(text), text);
  assert.match(text, /could not be verified/);
  assert.match(text, /waiting for you in the app/);
});

test("an explicit authentication failure is refused, as before", async () => {
  harness.rawAuth = AUTH_FAIL;
  const r = await sendCard([CASEY]);
  assert.equal(r.body.result, "rejected_auth");
  assert.equal(rows("peer_references").length, 0);
  assert.equal(rows("intake_proposals").length, 0);
});

// ── The app side: Add on a staged card ───────────────────────────────────────
// information_schema on production, read 2026-09-29 (SELECT only).
const PEER_REFERENCE_COLUMNS = ["id", "user_id", "name", "degree", "specialty", "institution", "relationship", "email", "phone", "years_known", "notes", "created_at", "updated_at", "custom_fields", "known_since", "favorite"];
const snake = (k) => k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());

test("Add on a staged card writes a peer reference the table accepts, and never a second copy of one on file", async () => {
  const { planAccept, itemLabel } = await import("../src/utils/intakeProposals.js");
  harness.rawAuth = AUTH_NONE;
  await sendCard([CASEY]);
  const item = rows("intake_proposals")[0].items[0];
  assert.equal(itemLabel(item), "Reference: Casey Example, Osterly Example Hospital");
  const plan = planAccept(item, { data: { peerReferences: [] }, newId: () => "ref-1" });
  assert.equal(plan.writes.length, 1);
  const [w] = plan.writes;
  assert.equal(w.op, "add");
  assert.equal(w.key, "peerReferences");
  assert.equal(w.record.relationship, "Other", "relationship is NOT NULL");
  assert.deepEqual(Object.keys(w.record).filter((k) => !PEER_REFERENCE_COLUMNS.includes(snake(k))), [], "every key is a column");
  assert.equal(plan.item.state, "added");
  const onFile = { id: "ref-0", name: "Casey Example", email: "casey.example@osterly-health.example", relationship: "Colleague" };
  const again = planAccept(item, { data: { peerReferences: [onFile] }, newId: () => "ref-2" });
  assert.ok(again.writes.every((x) => x.op !== "add"), "the same person on file is not added twice");
  assert.equal(again.item.recordId, "ref-0");
});


// ── The same card twice (INTAKE-009) ─────────────────────────────────────────
test("sending the same two cards again adds nobody twice, and the reply says they are already on file", async () => {
  harness.rawAuth = AUTH_PASS;
  await sendCard([CASEY, JORDAN]);
  assert.equal(rows("peer_references").length, 2);
  harness.sent.length = 0;
  const r = await sendCard([CASEY, JORDAN]);
  assert.equal(rows("peer_references").length, 2, "no duplicates");
  assert.equal(r.body.added, 0);
  const text = toPhysician()[0].text;
  assert.match(text, /Already in your references, not added again: Casey Example, Jordan Sample\./, text);
  assert.ok(!/No contact card was found/.test(text), text);
});

test("a colleague who shares a name but not an email or phone is still added", async () => {
  harness.rawAuth = AUTH_PASS;
  await sendCard([CASEY]);
  await sendCard([{ ...CASEY, email: "casey.other@elsewhere.example", phone: "555-0199" }]);
  assert.equal(rows("peer_references").length, 2);
});

test("an unverified card already on file is not staged again", async () => {
  harness.rawAuth = AUTH_PASS;
  await sendCard([CASEY]);
  harness.rawAuth = AUTH_NONE;
  harness.sent.length = 0;
  await sendCard([CASEY, JORDAN]);
  const items = rows("intake_proposals").flatMap((n) => n.items);
  assert.deepEqual(items.map((i) => i.fields.name), ["Jordan Sample"]);
  assert.match(toPhysician()[0].text, /Already in your references, not added again: Casey Example\./);
});

// ── One of several staging notes fails (INTAKE-009) ──────────────────────────
// A 25-card share splits into notes by the 4 KB cap. When the FIRST note's
// insert failed and a later one saved, the reply named the first cards (the
// ones NOT saved) as waiting in the app, and the ones to send again went
// unnamed: the physician resent the wrong cards.
test("when one staging note fails, the reply names the cards saved and the cards to send again", async () => {
  harness.rawAuth = AUTH_NONE;
  const people = Array.from({ length: 25 }, (_, i) => ({
    name: `Synthetic Person ${String(i + 1).padStart(2, "0")}`, org: "Example Teaching Hospital",
    email: `synthetic.person${i + 1}@hospital.example`, phone: `555-01${String(i).padStart(2, "0")}`,
  }));
  harness.failInsert = (table, list) => (table === "intake_proposals" && !String(list[0].message_id).includes("#") ? "boom" : null);
  const r = await sendCard(people);
  const notes = rows("intake_proposals");
  assert.ok(notes.length >= 1, "a later note saved");
  const saved = notes.flatMap((n) => n.items).map((i) => i.fields.name);
  const lost = people.map((p) => p.name).filter((nm) => !saved.includes(nm));
  assert.ok(saved.length > 0 && lost.length > 0, "the split left cards on both sides");
  assert.equal(r.body.staged, saved.length);
  const text = toPhysician()[0].text;
  const waiting = text.split("\n\n")[0];
  for (const nm of saved) assert.ok(waiting.includes(nm), `${nm} is named as waiting`);
  for (const nm of lost) assert.ok(!waiting.includes(nm), `${nm} was not saved, so it is not named as waiting`);
  const again = text.split("\n\n").find((p) => /could not be saved/.test(p));
  assert.ok(again, text);
  for (const nm of lost) assert.ok(again.includes(nm), `${nm} is named to send again`);
  assert.match(again, new RegExp(`^${lost.length} more cards \\(`));
});
