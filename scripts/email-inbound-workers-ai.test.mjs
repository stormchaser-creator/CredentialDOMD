// End to end through supabase/functions/email-inbound/index.ts: the free
// reader first (Cloudflare Workers AI, _shared/workersAiCall.mjs), then
// Anthropic, then the rules, and one alert to the owner a day when a reader
// answers with an error (_shared/intakeAiAlert.mjs), switched on here.
//
// Why: the Anthropic intake key ran out of credit on 2026-11-05 and every
// forward was read by the keyword rules, silently, for twelve days.
// Run: node --test scripts/email-inbound-workers-ai.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { env, loadFunction, resetWorld, deliver, harness } from "./email-inbound-harness.mjs";
import { composeForward } from "./intake-eval.mjs";
import { OWNER_NOTIFY_TO } from "../supabase/functions/_shared/ownerNotify.mjs";

const PROFILE = "0b7f1c2e-5a44-4d7e-9b1a-3c2d1e0f9a88";
const ME = "rowan.testa@clinic.example";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const AUTH_PASS = "mx.resend.com; dmarc=pass header.from=clinic.example";
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/intake/understanding/${name}.json`, import.meta.url), "utf8"));
const NO_ATTACHMENT = fixture("request-no-attachment");
const DELIVERY = fixture("delivery-approval");

const pdf = (s) => new TextEncoder().encode(`%PDF-1.4 ${s}`);
const rows = (t) => harness.db.rows(t);
const usage = (provider) => rows("ai_usage").filter((r) => r.provider === provider);
const toOwner = () => harness.sent.filter((m) => m.to?.[0] === OWNER_NOTIFY_TO);
const detail = () => rows("inbound_emails")[0].detail;

let n = 0;
function sendCase(c, { workersAi = () => c.modelReply, anthropic = () => c.modelReply } = {}) {
  const scans = new Map(c.attachments.map((a) => [a.name, a.scan]));
  const bytes = new Map(c.attachments.map((a, i) => [a.name, pdf(`${c.id}-${i}`)]));
  harness.geminiReply = (body) => {
    const data = body.contents?.[0]?.parts?.[0]?.inlineData?.data;
    const text = data ? Buffer.from(data, "base64").toString("utf8") : "";
    for (const [name, b] of bytes) if (text === Buffer.from(b).toString("utf8")) return scans.get(name);
    return null;
  };
  harness.workersAiReply = workersAi;
  harness.anthropicReply = anthropic;
  return deliver({
    id: `w${++n}`, from: `Rowan Testa <${ME}>`, to: "docs@credentialdomd.com", subject: `Fwd: ${c.subject}`, text: composeForward(c),
    attachments: c.attachments.map((a) => ({ filename: a.name, contentType: "application/pdf", bytes: bytes.get(a.name) })),
  });
}

function seed({ cf = true, anthropic = true } = {}) {
  rows("mailbox_claims").push({ address: ME, profile_id: PROFILE, proof: "verified", terminal_at: null });
  rows("profiles").push({ id: PROFILE, auth_user_id: "user_synthetic01", email: ME, access_status: "active", verified_email: ME, deleted_at: null, name: "Rowan Testa", degree_type: "MD", ack_requests: true });
  rows("app_secrets").push({ name: "gemini_shared_key", value: "AIza-test" });
  if (anthropic) rows("app_secrets").push({ name: "anthropic_shared_key", value: "sk-ant-test" });
  if (cf) rows("app_secrets").push({ name: "cf_ai_account_id", value: ACCOUNT }, { name: "cf_ai_token", value: "cf-test-token" });
  rows("licenses").push(
    { id: "lic-board", user_id: PROFILE, type: "Board Certification", name: "Board Certification (ABMS)", expiration_date: "2031-12-31" },
    { id: "lic-bls", user_id: PROFILE, type: "BLS", name: "BLS Certification", expiration_date: "2027-06-30" },
  );
  rows("documents").push(
    { id: "doc-board", user_id: PROFILE, name: "board.pdf", mime_type: null, type: "application/pdf", linked_to: "licenses:lic-board", uploaded_at: "2026-01-02T10:00:00Z", size_bytes: 11 },
    { id: "doc-bls", user_id: PROFILE, name: "bls.pdf", mime_type: null, type: "application/pdf", linked_to: "licenses:lic-bls", uploaded_at: "2026-01-02T10:00:00Z", size_bytes: 12 },
  );
}

const reset = (opts) => { resetWorld(); harness.rawAuth = AUTH_PASS; seed(opts); };
const CREDIT = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } };
const QUOTA = { status: 429, body: { success: false, errors: [{ code: 4006, message: "you have used up your daily free allocation of 10,000 neurons" }], result: null } };

before(async () => { env.INTAKE_AI_FAILURE_ALERTS = "on"; await loadFunction(); });
beforeEach(() => reset());

test("Workers AI reads the email first; Anthropic is not called and nothing is held against the month", async () => {
  const r = await sendCase(NO_ATTACHMENT);
  assert.equal(r.body.read, "model");
  assert.equal(r.body.one_tap, true, "the free reader's reading is checked and used exactly as Anthropic's");
  assert.equal(harness.workersAi.length, 1);
  assert.equal(harness.workersAi[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`);
  assert.equal(harness.workersAi[0].headers.Authorization, "Bearer cf-test-token");
  assert.equal(harness.workersAi[0].body.response_format.type, "json_schema");
  assert.equal(harness.anthropic.length, 0);
  assert.equal(harness.ledger.calls.filter((c) => c.name === "reserve_ai_call").length, 1, "one of the day's reads");
  assert.equal(harness.ledger.calls.filter((c) => c.name === "reserve_ai_spend").length, 0, "no dollar hold for the free reader");
  assert.deepEqual(usage("cloudflare").map((u) => [u.ok, u.status, u.path]), [[true, 200, "ai/run"]]);
  assert.match(detail(), /read by model \(high\) via workers-ai/);
  assert.equal(toOwner().length, 0, "no failure, no alert");
});

test("Workers AI out of its daily allowance: Anthropic reads it, and the owner gets one alert", async () => {
  const r = await sendCase(NO_ATTACHMENT, { workersAi: () => QUOTA });
  assert.equal(r.body.read, "model");
  assert.equal(harness.workersAi.length, 1);
  assert.equal(harness.anthropic.length, 1);
  assert.match(detail(), /read by model \(high\) via anthropic/);
  assert.equal(toOwner().length, 1);
  assert.match(toOwner()[0].text, /workers-ai: Workers AI answered 429 \(4006: you have used up your daily free allocation/);
  assert.ok(rows("intake_ai_alerts")[0].sent_at, "marked sent");
});

test("a Workers AI reply that is not the JSON asked for goes to Anthropic, with no alert (nothing answered with an error)", async () => {
  const r = await sendCase(NO_ATTACHMENT, { workersAi: () => ({ result: { response: "I think this is a request." } }) });
  assert.equal(r.body.read, "model");
  assert.equal(harness.anthropic.length, 1);
  assert.equal(harness.aiAlerts.length, 0);
  assert.equal(toOwner().length, 0);
});

test("both readers failing: the rules read it, the ledger says why, and the owner hears once in 24 hours", async () => {
  let r = await sendCase(NO_ATTACHMENT, { workersAi: () => QUOTA, anthropic: () => CREDIT });
  assert.equal(r.body.read, "rules");
  assert.match(detail(), /read by rules \(Workers AI answered 429 \(4006: .*\); the AI service answered 400 \(invalid_request_error: Your credit balance is too low/);
  assert.equal(toOwner().length, 1);
  const alert = toOwner()[0];
  assert.equal(alert.subject, "CredentialDOMD: email intake AI is failing");
  assert.match(alert.text, /- workers-ai: .*\n- anthropic: .*credit balance is too low/);
  assert.doesNotMatch(alert.text, /cf-test-token|sk-ant-test/);

  // A second failing forward within the day: no second alert.
  rows("inbound_emails").length = 0;
  r = await sendCase(DELIVERY, { workersAi: () => QUOTA, anthropic: () => CREDIT });
  assert.equal(r.body.read, "rules");
  assert.equal(harness.aiAlerts.length, 2, "asked the database");
  assert.equal(toOwner().length, 1, "still one alert");
});

test("a Workers AI timeout falls through to Anthropic and is not an alert", async () => {
  const r = await sendCase(NO_ATTACHMENT, { workersAi: () => ({ hang: true }) });
  assert.equal(r.body.read, "model");
  assert.equal(harness.anthropic.length, 1);
  assert.deepEqual(usage("cloudflare").map((u) => [u.ok, u.status]), [[false, null]]);
  assert.equal(toOwner().length, 0);
});

test("Workers AI alone, with no Anthropic key: the email is still read by a model", async () => {
  reset({ anthropic: false });
  const r = await sendCase(NO_ATTACHMENT);
  assert.equal(r.body.read, "model");
  assert.equal(harness.anthropic.length, 0);
  assert.match(detail(), /via workers-ai/);
});

test("no Workers AI account set: Anthropic reads as before, and the free reader is never called", async () => {
  reset({ cf: false });
  const r = await sendCase(NO_ATTACHMENT);
  assert.equal(r.body.read, "model");
  assert.equal(harness.workersAi.length, 0);
  assert.equal(harness.anthropic.length, 1);
  assert.match(detail(), /via anthropic/);
});

test("neither reader set: the rules, no call and no alert", async () => {
  reset({ cf: false, anthropic: false });
  const r = await sendCase(NO_ATTACHMENT);
  assert.equal(r.body.read, "rules");
  assert.equal(harness.workersAi.length + harness.anthropic.length, 0);
  assert.equal(harness.aiAlerts.length, 0);
});
