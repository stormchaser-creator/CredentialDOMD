// The packet matcher's side of a model reading (requestPacket.ts and the
// app's requestPacket.js, which must agree): the kind the rules read in the
// quoted words against the kind the model named, when one tap may send, what
// the physician is asked to check, and which sentences are in an asking form
// at all. Run against the committed catalogue from request-packet.test.mjs.
// Every sentence here is synthetic.
// Run: node --test scripts/request-packet-reading.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as client from "../src/utils/requestPacket.js";
import * as server from "../supabase/functions/_shared/requestPacket.ts";
import { DOCS, RECORDS, PHYSICIAN, NOW } from "./request-packet.test.mjs";

const COPIES = [["server", server], ["app", client]];
const REQ = { subject: "Documents", body: "", fromName: "Morgan Placeholder", fromAddr: "morgan@ridgeway-locums.example" };
const read = (asks, confidence = "high", extra = {}) => ({ asks, confidence, ...extra });

for (const [name, m] of COPIES) {
  const catalogue = m.catalogueFromRows(DOCS, RECORDS);

  test(`${name}: the quoted words name the document; a model kind that disagrees goes to Review with the words' match`, () => {
    const p = m.buildProposal(REQ, catalogue, PHYSICIAN, NOW, read([{ quote: "Could you send a copy of your current BLS card?", kind: "coi_malpractice" }]));
    const [it] = p.items;
    assert.equal(it.kind, "bls");
    assert.equal(it.ruleKind, "bls");
    assert.equal(it.modelKind, "coi_malpractice");
    assert.equal(it.confidence, "medium");
    assert.ok(!it.labels.some((l) => /liability|malpractice/i.test(l)), JSON.stringify(it.labels));
    assert.equal(m.oneTapReady(p), false);
    assert.match(m.reviewReason(p), /Read two ways: ".*BLS card.*" \(BLS card by its words, malpractice certificate by the reading\)\./);
  });

  test(`${name}: a kind only the model names (an attestation as a photo ID) matches, but is never one tap`, () => {
    const p = m.buildProposal(REQ, catalogue, PHYSICIAN, NOW, read([{ quote: "Please sign and return the attached attestation", kind: "photo_id" }]));
    const [it] = p.items;
    assert.deepEqual([it.kind, it.ruleKind, it.status, it.confidence], ["photo_id", "unknown", "found", "medium"]);
    assert.ok(it.labels.some((l) => /driver/i.test(l)), "the licence on file matches");
    assert.equal(m.oneTapReady(p), false, "a government ID is never sent on the model's word alone");
    assert.match(m.reviewReason(p), /Named by the reading alone: ".*" as photo ID\. Check that is what they meant\./);
  });

  test(`${name}: when the words and the model agree, a matched ask may still go on one tap`, () => {
    // email-inbound stamps verified from the forward's authentication.
    const p = { ...m.buildProposal(REQ, catalogue, PHYSICIAN, NOW, read([{ quote: "a copy of your board certificate", kind: "board_cert" }])), verified: true };
    assert.deepEqual([p.items[0].kind, p.items[0].ruleKind, p.items[0].modelKind], ["board_cert", "board_cert", undefined]);
    assert.equal(m.oneTapReady(p), true);
    assert.equal(m.reviewReason(p), "");
    // The same proposal from a forward that was not authenticated is not.
    assert.equal(m.oneTapReady({ ...p, verified: false }), false);
    // A proposal from before ruleKind existed is not one tap.
    const legacy = { ...p, items: p.items.map(({ ruleKind: _r, ...it }) => it) };
    assert.equal(m.oneTapReady(legacy), false);
  });

  test(`${name}: an unclear email is never one tap, says so, and its draft does not tell the sender they asked`, () => {
    for (const reading of [read([], "medium", { unclear: true }), { unclear: true }]) {
      const body = "The credentialing committee reviewed your file last week, and your coverage is provided through the group policy.";
      const p = m.buildProposal({ ...REQ, body }, catalogue, PHYSICIAN, NOW, reading);
      assert.equal(p.unclear, true);
      assert.deepEqual(p.items, []);
      assert.equal(m.oneTapReady(p), false);
      assert.equal(m.reviewReason(p), "It is not clear whether this email asks you for anything. Read it before you reply.");
      assert.ok(!/request|asked for/i.test(p.coverNote), p.coverNote);
      assert.match(p.coverNote, /Thank you for your email\./);
    }
    // Without the flag, an empty proposal keeps its old wording.
    assert.ok(!("unclear" in m.buildProposal({ ...REQ, body: "Board certificate" }, catalogue, PHYSICIAN, NOW)));
  });

  test(`${name}: a requirement on the reader's own file is an asking form; the same words for everyone are not`, () => {
    for (const s of [
      "To complete your reappointment, a copy of your current DEA registration is required by October 15.",
      "A current TB test is required before your start date.",
      "We will require the renewed card.",
      "The credentials committee requires an updated CV and two peer references.",
      "Your file is incomplete until we receive your BLS card.",
      "The last thing holding up your privileges is the hepatitis B titer.",
      "Your file cannot be finalized until we have it.",
      "The hospital requires a copy of your DEA registration before privileges can be granted.",
      "Your reappointment file is still incomplete without the malpractice certificate of insurance.",
      "We cannot schedule your orientation until your TB test results are on file.",
      "Please note that we still need your DEA.",
      "Please do not send originals, send a copy of your DEA.",
    ]) assert.equal(m.hasAskForm(s), true, s);
    for (const s of [
      "Proof of malpractice coverage is required for every provider on our panel, and our group policy provides that coverage for emergency care.",
      "Proof of malpractice coverage is required for every provider on our panel, including you.",
      "The policy covers emergency department encounters documented under your name, so no separate certificate is required from you.",
      "Please note that proof of malpractice coverage is required for every provider on our panel.",
      "Please be advised that our group policy provides that coverage for emergency care.",
      "Please keep this letter for your records.",
      "Please do not reply to this email.",
      "Please consider the environment before printing this email.",
      "For urgent matters, please contact the credentialing desk.",
      "Thanks, we have everything we need now and your file is complete.",
      "Your coverage remains in force until we receive notice of cancellation.",
      "Please do not send originals.",
    ]) assert.equal(m.hasAskForm(s), false, s);
    assert.equal(m.asksInSubject("Fwd: Documents needed"), true);
    assert.equal(m.asksInSubject("Malpractice coverage for your emergency shifts"), false);
    assert.equal(m.isListItem("- Board certificate"), true);
    assert.equal(m.isListItem("Board certificate"), false);
  });

  // The owner's real letter of 2026-09-28, with the model out of the picture,
  // became a request with one ask the rules could not name: a clause of the
  // form "This means that if you are required to ..., that care is treated as
  // covered". These keep its constructions in other words; the genuine
  // requests beside them must still ask.
  test(`${name}: a clause in a condition or an explanation asks for nothing; a main clause beside it still asks`, () => {
    for (const s of [
      "This means that if you are required to provide urgent surgical care, that care is treated as insured work.",
      "This means that if you are required to provide urgent care\u2014say, a procedure the facility has not granted you\u2014while you are practicing within your licence, that care is covered.",
      "Even if you are NOT credentialed at the hospital for pediatric trauma, if an emergency circumstance comes up, those services fall within the policy.",
      "Should you need to provide emergency care outside that list, the policy still applies.",
      "In the event you are asked to provide urgent treatment outside your usual case mix, that treatment is covered too.",
      "Whether or not you are credentialed for that procedure, emergency care you provide is covered.",
      "This means that the urgent care you provide within your licence is treated as covered.",
      "When on call you are required to render emergency care, which means those cases are insured.",
      "The agency carries malpractice insurance at $2,000,000 per claim and $4,000,000 aggregate, raised where required by state law.",
      "The coverage required by the hospital is already in place under your agreement.",
      "Riley and I are taking this up with the hospital, and it should not come up again.",
    ]) assert.equal(m.hasAskForm(s), false, s);
    for (const s of [
      "You are required to submit your updated COI by Friday.",
      "Please note we require a copy of your DEA before your start date.",
      "Required: current CV and two references",
      "Even if you sent it last year, please send your current BLS card.",
      "If you are required to carry your own policy, send your COI by Friday.",
      "Whether or not you are prescribing there, we need your DEA.",
      "We need your DEA even if you are not prescribing.",
      "Please send your COI if required by your facility.",
      "In the event your licence is renewed, please forward the new copy.",
      "This means we still need your updated COI before your start date.",
      "This means that you will need to submit a new application.",
      "This means that your COI is required before your start date.",
      "You are required to provide proof of coverage by Friday.",
      "Please provide proof of coverage.",
      "Should you need to reschedule, send your new dates and the updated COI.",
      // A condition with no comma before the main clause that asks.
      "If required we need a copy of your DEA.",
      "Even if you already sent it we need your updated COI.",
      "If required send your COI to the medical staff office.",
      "In the event your licence is renewed can you forward the new copy",
    ]) assert.equal(m.hasAskForm(s), true, s);
    // No comma: the condition is kept, and the care duty and the explanation
    // that does not ask still come out.
    assert.equal(m.hasAskForm("This means that if you are required to provide urgent care that care is insured work."), false);
    assert.equal(m.askingPart("Even if you sent it already, please resend your BLS card."), ", please resend your BLS card.");
  });

  // Review of 2026-09-29: cutting a condition with no comma to the stop took
  // the main clause with it, an explanation lost its imperative and its "you
  // must", and "coverage" counted as care. Each of these asked on main and
  // read as nothing on the first version of askingPart, which also dropped
  // the model's own quote of it ("not worded as an ask").
  test(`${name}: a condition with no comma keeps its main clause; an explanation that tells the reader to act, or insurance to provide, still asks`, () => {
    for (const s of [
      "Whether or not you plan to renew the hospital needs your signed release form.",
      "Even if you sent it last year the credentialing office still needs your current BLS card.",
      "Should you accept the offer the signed agreement must be returned by Friday.",
      "If you are required to carry your own policy your certificate must reach us by Friday.",
      "If an emergency delays your arrival our office needs your updated ETA.",
      "In case you missed my last note the hospital still needs your TB results by Friday",
      "If you are asked to provide immunization records they must reach us by 10/5 so the hospital needs your flu shot record and hepatitis B titer",
      "Also even if you sent it last year the credentialing office still needs your current BLS card.",
      "This means that even if you sent it before the office needs your BLS card.",
      "In other words, send us the renewed COI before your next shift.",
      "This means that you must submit your updated CV by October 1.",
      "In other words, you are required to return the signed attestation before your start date.",
      "You are required to provide malpractice coverage of $1,000,000/$3,000,000 before your start date of 11/2.",
      "This means you are required to provide professional liability coverage before your first shift.",
    ]) assert.equal(m.hasAskForm(s), true, s);
    for (const s of [
      // A condition after its main clause still comes out to the stop.
      "Emergency care is covered should you need to provide it.",
      "Your cover still applies even if you are required to provide urgent surgery there.",
      // Care is still not a document, call coverage included.
      "Whether or not you are on the call list, the call coverage you provide is insured.",
      "When on call you are expected to give trauma coverage, which means those nights are insured.",
      // An explanation of what is covered still asks for nothing.
      "In other words, complete protection applies to emergency cases.",
      // A need denied asks for nothing.
      "In other words, you will not need to buy tail coverage when the assignment ends.",
      "You won't need to resend the application.",
      "The physician no longer needs a separate certificate for this site.",
    ]) assert.equal(m.hasAskForm(s), false, s);
    // A denied need beside one that asks still asks.
    assert.equal(m.hasAskForm("You will not need to buy tail coverage, but we need your updated COI."), true);
    assert.equal(m.askingPart("Whether or not you plan to renew the hospital needs your signed release form."), "Whether or not you plan to renew the hospital needs your signed release form.");
    assert.equal(m.askingPart("The agency carries malpractice insurance, raised where required by state law."), "The agency carries malpractice insurance, raised .");
  });

  test(`${name}: kindName reads every kind`, () => {
    for (const k of m.KINDS) assert.ok(m.kindName(k) && !m.kindName(k).includes("_"), k);
  });
}

test("both copies read the same words the same way", () => {
  const catalogue = [client.catalogueFromRows(DOCS, RECORDS), server.catalogueFromRows(DOCS, RECORDS)];
  for (const r of [
    read([{ quote: "Could you send a copy of your current BLS card?", kind: "coi_malpractice" }]),
    read([{ quote: "Please sign and return the attached attestation", kind: "photo_id" }]),
    read([], "medium", { unclear: true }),
    { unclear: true },
  ]) {
    const a = client.buildProposal(REQ, catalogue[0], PHYSICIAN, NOW, r);
    const b = server.buildProposal(REQ, catalogue[1], PHYSICIAN, NOW, r);
    assert.deepEqual(b, a);
    assert.equal(server.reviewReason(b), client.reviewReason(a));
  }
});
