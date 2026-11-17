// End to end through supabase/functions/email-inbound/index.ts: Gemini Flash
// reads the email first, on the scanner's own shared key
// (_shared/geminiIntakeCall.mjs), then Cloudflare Workers AI when set, then
// Anthropic, then the rules. One owner alert a day on an answered error,
// switched on here (off by default).
//
// Why: Workers AI's free allowance holds about twenty readings a day.
// Run: node --test scripts/email-inbound-gemini.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { env, loadFunction, resetWorld, deliver, harness } from "./email-inbound-harness.mjs";
import { composeForward } from "./intake-eval.mjs";
import { OWNER_NOTIFY_TO } from "../supabase/functions/_shared/ownerNotify.mjs";
import { GEMINI_MODEL } from "../supabase/functions/_shared/app/utils/geminiModel.js";
import { UNDERSTANDING_SCHEMA } from "../supabase/functions/_shared/intakeUnderstanding.mjs";

const PROFILE = "0b7f1c2e-5a44-4d7e-9b1a-3c2d1e0f9a88";
const ME = "rowan.testa@clinic.example";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const AUTH_PASS = "mx.resend.com; dmarc=pass header.from=clinic.example";
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/intake/understanding/${name}.json`, import.meta.url), "utf8"));
const NO_ATTACHMENT = fixture("request-no-attachment");

const pdf = (s) => new TextEncoder().encode(`%PDF-1.4 ${s}`);
const rows = (t) => harness.db.rows(t);
const usage = (provider) => rows("ai_usage").filter((r) => r.provider === provider);
const toOwner = () => harness.sent.filter((m) => m.to?.[0] === OWNER_NOTIFY_TO);
const detail = () => rows("inbound_emails")[0].detail;

let n = 0;
function sendCase(c, { gemini = () => c.modelReply, workersAi = () => c.modelReply, anthropic = () => c.modelReply } = {}) {
  const scans = new Map(c.attachments.map((a) => [a.name, a.scan]));
  const bytes = new Map(c.attachments.map((a, i) => [a.name, pdf(`${c.id}-${i}`)]));
  harness.geminiReply = (body) => {
    const data = body.contents?.[0]?.parts?.[0]?.inlineData?.data;
    const text = data ? Buffer.from(data, "base64").toString("utf8") : "";
    for (const [name, b] of bytes) if (text === Buffer.from(b).toString("utf8")) return scans.get(name);
    return null;
  };
  harness.geminiIntakeReply = gemini;
  harness.workersAiReply = workersAi;
  harness.anthropicReply = anthropic;
  return deliver({
    id: `g${++n}`, from: `Rowan Testa <${ME}>`, to: "docs@credentialdomd.com", subject: `Fwd: ${c.subject}`, text: composeForward(c),
    attachments: c.attachments.map((a) => ({ filename: a.name, contentType: "application/pdf", bytes: bytes.get(a.name) })),
  });
}

function seed({ gemini = true, cf = true, anthropic = true, access = "active" } = {}) {
  rows("mailbox_claims").push({ address: ME, profile_id: PROFILE, proof: "verified", terminal_at: null });
  rows("profiles").push({ id: PROFILE, auth_user_id: "user_synthetic01", email: ME, access_status: access, verified_email: ME, deleted_at: null, name: "Rowan Testa", degree_type: "MD", ack_requests: true });
  if (gemini) rows("app_secrets").push({ name: "gemini_shared_key", value: "AIza-test" });
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
const EXHAUSTED = { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota)." } } };
const QUOTA = { status: 429, body: { success: false, errors: [{ code: 4006, message: "you have used up your daily free allocation of 10,000 neurons" }], result: null } };
const CREDIT = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } };

before(async () => {
  env.INTAKE_AI_FAILURE_ALERTS = "on";
  env.INTAKE_GEMINI_READER = "on";
  await loadFunction();
});
beforeEach(() => reset());

test("Gemini reads the email first, on the scanner's key and model, in structured-output mode; nothing else is called", async () => {
  const r = await sendCase(NO_ATTACHMENT);
  assert.equal(r.body.read, "model");
  assert.equal(r.body.one_tap, true, "Gemini's reading is checked and used exactly as Anthropic's");
  assert.equal(harness.geminiIntake.length, 1);
  const call = harness.geminiIntake[0];
  assert.equal(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
  assert.equal(call.headers["x-goog-api-key"], "AIza-test");
  assert.equal(call.body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(call.body.generationConfig.responseJsonSchema, UNDERSTANDING_SCHEMA);
  assert.equal(harness.workersAi.length + harness.anthropic.length, 0);
  assert.equal(harness.ledger.calls.filter((c) => c.name === "reserve_ai_call").length, 1, "one of the day's reads");
  assert.equal(harness.ledger.calls.filter((c) => c.name === "reserve_ai_spend").length, 0, "no dollar hold: Gemini is never capped");
  const reads = usage("gemini").filter((u) => u.path === `models/${GEMINI_MODEL}:generateContent` && u.input_tokens === 2300);
  assert.equal(reads.length, 1, "metered like a scan");
  assert.ok(reads[0].cost_usd > 0);
  assert.match(detail(), /read by model \(high\) via gemini/);
  assert.equal(toOwner().length, 0);
});

test("Gemini out of quota: Workers AI reads it next, and the owner gets one alert (alerts on here)", async () => {
  const r = await sendCase(NO_ATTACHMENT, { gemini: () => EXHAUSTED });
  assert.equal(r.body.read, "model");
  assert.equal(harness.geminiIntake.length, 1);
  assert.equal(harness.workersAi.length, 1);
  assert.equal(harness.anthropic.length, 0);
  assert.match(detail(), /via workers-ai/);
  assert.equal(toOwner().length, 1);
  assert.match(toOwner()[0].text, /- gemini: Gemini answered 429 \(RESOURCE_EXHAUSTED: Resource has been exhausted/);
  assert.doesNotMatch(toOwner()[0].text, /AIza-test/);
});

test("a Gemini reply that is not the JSON asked for goes to the next reader, with no alert", async () => {
  const r = await sendCase(NO_ATTACHMENT, { gemini: () => ({ response: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "This is a request." }] } }] } }) });
  assert.equal(r.body.read, "model");
  assert.match(detail(), /via workers-ai/);
  assert.equal(harness.aiAlerts.length, 0);
});

test("Gemini timing out falls through and is not an alert", async () => {
  const r = await sendCase(NO_ATTACHMENT, { gemini: () => ({ hang: true }) });
  assert.equal(r.body.read, "model");
  assert.match(detail(), /via workers-ai/);
  assert.equal(harness.aiAlerts.length, 0);
});

test("no Workers AI account: Gemini, then Anthropic", async () => {
  reset({ cf: false });
  const r = await sendCase(NO_ATTACHMENT, { gemini: () => EXHAUSTED });
  assert.equal(r.body.read, "model");
  assert.equal(harness.workersAi.length, 0);
  assert.equal(harness.anthropic.length, 1);
  assert.match(detail(), /via anthropic/);
});

test("every reader failing: the rules read it and the ledger names all three", async () => {
  const r = await sendCase(NO_ATTACHMENT, { gemini: () => EXHAUSTED, workersAi: () => QUOTA, anthropic: () => CREDIT });
  assert.equal(r.body.read, "rules");
  assert.match(detail(), /read by rules \(Gemini answered 429 .*; Workers AI answered 429 .*; the AI service answered 400 /);
  assert.equal(toOwner().length, 1);
  assert.match(toOwner()[0].text, /- gemini: .*\n- workers-ai: .*\n- anthropic: /);
});

test("Gemini alone, with no other reader set: the email is still read by a model", async () => {
  reset({ cf: false, anthropic: false });
  const r = await sendCase(NO_ATTACHMENT);
  assert.equal(r.body.read, "model");
  assert.match(detail(), /via gemini/);
});

test("no Gemini key: Workers AI reads as before", async () => {
  reset({ gemini: false });
  const r = await sendCase(NO_ATTACHMENT);
  assert.equal(r.body.read, "model");
  assert.equal(harness.geminiIntake.length, 0);
  assert.match(detail(), /via workers-ai/);
});

test("an inactive account may not use the shared Gemini key, so it is not read by Gemini", async () => {
  reset({ access: "pending", cf: false, anthropic: false });
  const r = await sendCase(NO_ATTACHMENT);
  assert.equal(r.body.read, "rules");
  assert.equal(harness.geminiIntake.length, 0);
});
