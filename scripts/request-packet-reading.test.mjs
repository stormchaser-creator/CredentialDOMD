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
    assert.deepEqual([it.kind, it.ruleKind, it.status], ["photo_id", "unknown", "found"]);
    assert.ok(it.labels.some((l) => /driver/i.test(l)), "the licence on file matches");
    assert.equal(m.oneTapReady(p), false, "a government ID is never sent on the model's word alone");
    assert.match(m.reviewReason(p), /Named by the reading alone: ".*" as photo ID\. Check that is what they meant\./);
  });

  test(`${name}: when the words and the model agree, a matched ask may still go on one tap`, () => {
    const p = m.buildProposal(REQ, catalogue, PHYSICIAN, NOW, read([{ quote: "a copy of your board certificate", kind: "board_cert" }]));
    assert.deepEqual([p.items[0].kind, p.items[0].ruleKind, p.items[0].modelKind], ["board_cert", "board_cert", undefined]);
    assert.equal(m.oneTapReady(p), true);
    assert.equal(m.reviewReason(p), "");
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
