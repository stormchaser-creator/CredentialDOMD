// The understanding step's model call runs INSIDE email-inbound's scan
// budget. Before 2026-09-28 (evening) the scans could spend the whole budget
// and the call then ran after it (a token count of up to ten seconds and a
// call of up to thirty), which on a slow day put the function near its
// wall-clock limit; a killed run left its ledger row "processing", and the
// webhook's retry paid for every scan and the call again.
//
// Run with the budget shortened (INTAKE_SCAN_BUDGET_MS, which may only
// shorten it) so the test takes seconds: every scan and the model call hang
// until their own timeouts, and the handler must still finish inside the
// budget. Its own process, because the function reads its environment once.
// Every email here is synthetic.
// Run: node --test scripts/email-inbound-time-budget.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { env, loadFunction, resetWorld, deliver, harness } from "./email-inbound-harness.mjs";
import { composeForward } from "./intake-eval.mjs";

const BUDGET_MS = 9_000;
env.INTAKE_SCAN_BUDGET_MS = String(BUDGET_MS);

const PROFILE = "0b7f1c2e-5a44-4d7e-9b1a-3c2d1e0f9a88";
const ME = "rowan.testa@clinic.example";
const pdf = (s) => new TextEncoder().encode(`%PDF-1.4 ${s}`);

function seed() {
  const rows = (t) => harness.db.rows(t);
  rows("mailbox_claims").push({ address: ME, profile_id: PROFILE, proof: "verified", terminal_at: null });
  rows("profiles").push({ id: PROFILE, auth_user_id: "user_synthetic01", email: ME, access_status: "active", verified_email: ME, deleted_at: null, name: "Rowan Testa", degree_type: "MD", ack_requests: true });
  rows("app_secrets").push({ name: "gemini_shared_key", value: "AIza-test" }, { name: "anthropic_shared_key", value: "sk-ant-test" });
}

before(async () => { await loadFunction(); });

test("scans that hang leave the model call its time, and the whole email is handled inside the budget", async () => {
  resetWorld();
  harness.rawAuth = "mx.resend.com; dmarc=pass header.from=clinic.example";
  seed();
  harness.geminiReply = () => ({ hang: true });
  harness.anthropicReply = () => ({ hang: true });
  const c = {
    subject: "Forms", from: { name: "Morgan Placeholder", address: "morgan@ridgeway-locums.example" },
    body: "Hi Dr. Testa,\n\nPlease complete the three attached forms and send your DEA.\n\nMorgan",
  };
  const started = Date.now();
  const r = await deliver({
    id: "slow-1", from: `Rowan Testa <${ME}>`, to: "docs@credentialdomd.com", subject: `Fwd: ${c.subject}`, text: composeForward(c),
    attachments: [1, 2, 3].map((i) => ({ filename: `Form_${i}.pdf`, contentType: "application/pdf", bytes: pdf(`form-${i}`) })),
  });
  const took = Date.now() - started;
  assert.equal(r.status, 200);
  assert.equal(harness.gemini.length, 3, "every attachment was sent to be read");
  assert.equal(harness.anthropic.length, 1, "the model call was still made, inside the budget");
  assert.equal(r.body.read, "rules", "and when it timed out the rules read the email");
  assert.ok(took < BUDGET_MS, `the email took ${took} ms, past the ${BUDGET_MS} ms budget`);
});

test("a call with too little time left is not made, and nothing is held or metered for it", async () => {
  const { callUnderstanding } = await import("../supabase/functions/_shared/intakeModelCall.ts");
  const calls = [];
  const db = { rpc: async (name) => { calls.push(name); return { data: null, error: null }; }, from: () => ({ insert: async () => { calls.push("insert"); return { error: null }; } }) };
  const before = harness.anthropic.length + harness.anthropicCounts.length;
  const r = await callUnderstanding({
    db, profileId: PROFILE, admission: { ok: true, uncapped: false, scope: "anthropic_intake" }, key: "sk-ant-test",
    request: { model: "claude-opus-5", max_tokens: 100, messages: [{ role: "user", content: "x" }] },
    budgetHardUsd: 15, timeoutMs: 400, deadline: Date.now() + 100, minMs: 400,
  });
  assert.deepEqual(r, { ok: false, why: "time budget spent" });
  assert.deepEqual(calls, []);
  assert.equal(harness.anthropic.length + harness.anthropicCounts.length, before);
});
