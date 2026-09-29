// scripts/intake-eval-seed.mjs, the parts that decide what is read and what
// is written: the arguments, the one SELECT, the redaction, and the case
// shape intake-eval reads. Nothing here touches the network. Synthetic data.
// Run: node --test scripts/intake-eval-seed.test.mjs
import { test } from "node:test";
import { fileURLToPath } from 'node:url';
import assert from "node:assert/strict";
import { parseArgs, seedQuery, redactText, observed, suggestExpected, caseFrom } from "./intake-eval-seed.mjs";
import { scoreCase } from "./intake-eval.mjs";

const P = "0b7f1c2e-5a44-4d7e-9b1a-3c2d1e0f9a88";

test("the arguments: a profile uuid is required, the window is bounded, and the corpus may not live in the repository", () => {
  assert.match(parseArgs([]).error, /--profile/);
  assert.match(parseArgs(["--profile", "x'; drop table profiles; --"]).error, /uuid/);
  assert.match(parseArgs(["--profile", P, "--days", "400"]).error, /1 to 90/);
  assert.match(parseArgs(["--profile", P, "--out", fileURLToPath(new URL("./fixtures", import.meta.url))]).error, /outside this repository/);
  const ok = parseArgs(["--profile", P.toUpperCase(), "--days", "30", "--redact", "--dry-run"]);
  assert.deepEqual([ok.profile, ok.days, ok.redact, ok.dryRun], [P, 30, true, true]);
  assert.match(ok.out, /Application Support\/CredentialDOMD\/intake-eval$/);
});

test("the only statement is one SELECT over this profile's docs and cme mail", () => {
  const q = seedQuery(P, 30);
  assert.match(q, /^select /);
  assert.ok(!/\b(insert|update|delete|drop|alter|grant|create)\b/i.test(q));
  assert.match(q, new RegExp(`e\\.profile_id = '${P}'`));
  assert.match(q, /e\.route in \('docs', 'cme'\)/);
  assert.match(q, /interval '30 days'/);
  assert.throws(() => seedQuery("nope", 30));
});

test("redaction takes out addresses, links and phone numbers", () => {
  assert.equal(redactText("Write to jordan.sample@quillfeather.example or call (555) 201-3344, see https://x.example/a"),
    "Write to someone@quillfeather.example or call <phone>, see <link>");
});

test("what the system did, and the label it suggests", () => {
  const informational = { id: "a", route: "docs", detail: "informational, stored 1, duplicates 0, read by model (high)" };
  assert.equal(observed(informational).intent, "informational");
  const dismissed = { id: "b", route: "docs", request_id: "r", request_status: "dismissed", detail: "request r, ack skipped: x, intent request, from a@b", proposal: { items: [{ ask: "malpractice certificate", kind: "coi_malpractice", status: "found" }] } };
  assert.deepEqual(suggestExpected(observed(dismissed)), { intent: "informational", asks: [] }, "a dismissed request suggests it was not one");
  const replied = { ...dismissed, request_status: "replied", detail: "request r, ack sent, intent both, from a@b" };
  assert.deepEqual(suggestExpected(observed(replied)), { intent: "mixed", asks: [{ kind: "coi_malpractice" }] });
});

test("a seeded case is unlabelled, reads as intake-eval expects, and is not scored until labelled", () => {
  const row = { id: "11111111-2222-4333-8444-555555555555", route: "docs", created_at: "2026-09-28T12:00:00Z", subject: "Fwd: coverage", from_addr: "rowan@clinic.example", detail: "informational, stored 1", body_text: null };
  const c = caseFrom(row, { text: "Dr. Testa, the policy covers emergency care. Call 555-201-3344." }, [{ filename: "MSA.pdf" }], { redact: true });
  assert.equal(c.id, "2026-09-28-11111111");
  assert.equal(c.labelled, false);
  assert.equal(c.body, "Dr. Testa, the policy covers emergency care. Call <phone>.");
  assert.deepEqual(c.attachments, [{ name: "MSA.pdf", scan: null }]);
  assert.deepEqual(c.expected, { intent: "informational", asks: [] });
  assert.equal(scoreCase(c, { intent: "informational", asks: [] }), null);
  assert.ok(scoreCase({ ...c, labelled: true }, { intent: "informational", asks: [] }).intent);
  const noEmail = caseFrom({ ...row, body_text: "Please send your DEA." }, null, []);
  assert.equal(noEmail.body, "Please send your DEA.");
  assert.match(noEmail.about, /Body from the stored request/);
});
