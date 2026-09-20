// Checks for how src/utils/aiClient.js reads the proxy's own refusals, across
// all three paths that read them: the status GET (fetchSharedAiStatus), the
// Gemini POST (geminiCall) and the Opus SDK route (sharedOpusFetch ->
// noteOpusRefusal, plus anthropicErrorMessage).
//
// WHAT WENT WRONG. Every 503 from the proxy meant one thing: the operator has
// not configured a shared key. The client acted on that by switching shared AI
// off in its cached status, which persists in localStorage, so the physician
// stayed switched off until they cleared site storage. Then the proxy grew a
// second reason to answer 503 -- its admission ledger could not answer, which
// lasts seconds -- and a review reproduced the consequence in all three paths
// at once. A status code is not a reason. The code in the body is, and only
// shared_key_not_configured may disable anything.
//
// The proxy was fixed as well, and the two fixes do different jobs. The proxy
// now answers the transient refusal with 429, so an ALREADY-INSTALLED bundle
// (this is a PWA with a precache service worker: the old bundle keeps running
// after the functions are deployed) cannot act on it at all. The client fix
// below is what makes the pair safe in the other direction, for any 503 this
// client meets that is not really a missing key. Both halves are checked
// here: the transient codes are tested at 429, which is what the proxy sends,
// AND at 503, which is what a client must survive regardless.
//
// aiClient seeds its cached status from localStorage at import time, so each
// case stubs localStorage and fetch and imports a fresh copy of the module.
// Run: node scripts/ai-client-errors.test.mjs

import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "../src/utils/aiClient.js");

// aiClient reads import.meta.env, which Vite fills at build time and node
// leaves undefined, so under plain node PROXY_URL is null and every call
// short-circuits to "shared_key_not_configured" before it reaches fetch --
// which would make every check below pass for the wrong reason. The module is
// therefore copied with that one expression replaced by a literal. It is
// written under node_modules/.cache so its bare `react` import still resolves
// from the project, and removed when the run ends.
const CACHE = path.join(here, "../node_modules/.cache/credentialdomd-ai-client-test");
mkdirSync(CACHE, { recursive: true });
process.on("exit", () => { try { rmSync(CACHE, { recursive: true, force: true }); } catch { /* best effort */ } });

const SUPABASE_URL = "https://test.supabase.invalid";
const patched = readFileSync(SRC, "utf8")
  .replace("const ENV = import.meta.env || {};", `const ENV = { VITE_SUPABASE_URL: ${JSON.stringify(SUPABASE_URL)} };`);
if (!patched.includes(SUPABASE_URL)) {
  console.log("FAIL  the import.meta.env line in aiClient.js changed shape; this test is not testing what it thinks");
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};

const SHARED_ON = {
  shared: true, used: 3, limit: 200, reason: null,
  anthropicShared: true, anthropicUsed: 2, anthropicLimit: 60, unlimited: false,
  monthSpentUsd: 1, budgetSoftUsd: 8, budgetHardUsd: 15, overSoft: false, overHard: false,
  checkedAt: Date.now(),
};

let seq = 0;
async function load(status = SHARED_ON, fetchStub = null) {
  // The stub goes in BEFORE the import. aiClient kicks off a status fetch at
  // module scope, so a stub installed afterwards is installed too late and the
  // case silently measures the previous case's response.
  if (fetchStub) globalThis.fetch = fetchStub;
  const store = { "credentialdomd-ai-shared": JSON.stringify(status) };
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  // A fresh file per case, so the seeded status is re-read rather than served
  // from the ESM module cache.
  const file = path.join(CACHE, `aiClient.${++seq}.mjs`);
  writeFileSync(file, patched);
  return import(pathToFileURL(file).href);
}

// Clerk is not here; the token fetch has to succeed or every call stops at 401.
globalThis.window = globalThis.window || {};
globalThis.window.Clerk = { session: { getToken: async () => "test-token" } };

/** A fetch Response shaped like the proxy's, with headers that behave. */
const proxyResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => headers[h] ?? headers[h.toLowerCase()] ?? null },
  json: async () => body,
  clone() { return proxyResponse(status, body, headers); },
});

// ══ The codes themselves ═══════════════════════════════════════════════════
{
  const m = await load();
  eq("the not-configured code is spelled the way the proxy spells it", m.PROXY_CODES.notConfigured, "shared_key_not_configured");
  eq("the accounting code matches the proxy's", m.PROXY_CODES.accounting, "ai_accounting_unavailable");
  eq("the burst code matches the proxy's", m.PROXY_CODES.rateLimited, "ai_rate_limited");
  ok("an accounting failure is transient", m.isTransientProxyCode("ai_accounting_unavailable"));
  ok("a burst refusal is transient", m.isTransientProxyCode("ai_rate_limited"));
  ok("a missing key is NOT transient", !m.isTransientProxyCode("shared_key_not_configured"));
  for (const code of ["quota", "budget", "forbidden", "unauthorized", null, undefined, "", "anything else"]) {
    ok(`${JSON.stringify(code)} is not transient`, !m.isTransientProxyCode(code));
  }
  ok("both transient codes have their own message",
    !!m.AI_MESSAGES.ai_accounting_unavailable && !!m.AI_MESSAGES.ai_rate_limited);
  ok("neither transient message tells the physician a feature is off",
    !/not switched on|not enabled|not configured/i.test(m.AI_MESSAGES.ai_accounting_unavailable + m.AI_MESSAGES.ai_rate_limited));
  ok("both transient messages say to try again",
    /try again/i.test(m.AI_MESSAGES.ai_accounting_unavailable) && /try again/i.test(m.AI_MESSAGES.ai_rate_limited));
  ok("the accounting message says nothing was sent",
    /nothing was sent/i.test(m.AI_MESSAGES.ai_accounting_unavailable));
}

// ══ Path 1: the status GET ═════════════════════════════════════════════════
// The status GET takes no reservation, so the proxy never answers it with a
// transient code today. Both are still checked here, at the status the client
// must survive rather than at the one the proxy sends: this is the path that
// seeds the cache for the whole session, and a code-blind branch here would
// strand a physician on a condition that had already passed.
for (const [name, body, shouldDisable] of [
  ["a missing shared key", { error: "shared_key_not_configured" }, true],
  ["an unreadable body", null, true],
  ["an accounting failure", { error: "ai_accounting_unavailable", retry_after: 30 }, false],
  ["a burst refusal", { error: "ai_rate_limited" }, false],
]) {
  const stub = body
    ? async () => proxyResponse(503, body)
    : async () => ({ ...proxyResponse(503, null), json: async () => { throw new Error("no body"); } });
  const m = await load(SHARED_ON, stub);
  await m.fetchSharedAiStatus({ force: true });
  // The public read is aiAvailable(), which consults the cached status.
  const stillShared = m.aiAvailable({});
  if (shouldDisable) {
    ok(`status 503, ${name}: shared AI is switched off`, stillShared === false);
  } else {
    ok(`status 503, ${name}: shared AI is LEFT ON`, stillShared === true);
  }
}
{
  // The ordinary success path must be untouched by any of this.
  const m = await load({ ...SHARED_ON, shared: false }, async () => proxyResponse(200, {
    shared: true, allowed: true, configured: true, used_today: 5, limit: 200,
    anthropic_shared: true, anthropic_configured: true, anthropic_used_today: 1, anthropic_limit: 60,
    month_spent_usd: 2, budget_soft_usd: 8, budget_hard_usd: 15,
  }));
  await m.fetchSharedAiStatus({ force: true });
  ok("status 200 still turns shared AI on", m.aiAvailable({}) === true);
}
{
  const m = await load(SHARED_ON, async () => proxyResponse(403, { error: "forbidden" }));
  await m.fetchSharedAiStatus({ force: true });
  ok("status 403 still reads as a pending account", m.aiAvailable({}) === false);
}

// ══ Path 2: the Gemini POST ════════════════════════════════════════════════
const geminiBody = { contents: [{ parts: [{ text: "hi" }] }] };
async function geminiWith(status, body, headers) {
  const m = await load(SHARED_ON, async () => proxyResponse(status, body, headers));
  const res = await m.geminiCall({ settings: {}, path: "models/gemini-2.5-flash:generateContent", body: geminiBody });
  return { m, res };
}
{
  // 429 is what the proxy actually sends for this (ai-proxy/limits.ts
  // aiAdmissionVerdict), chosen so a stale bundle cannot read it as a missing
  // key. This is the live case.
  const { m, res } = await geminiWith(429, { error: "ai_accounting_unavailable", retry_after: 30 }, { "Retry-After": "30" });
  eq("gemini 429 accounting: the code reaches the caller", res.proxyError, "ai_accounting_unavailable");
  ok("gemini 429 accounting: it is marked transient", res.transient === true);
  eq("gemini 429 accounting: the wait is carried", res.retryAfter, 30);
  ok("gemini 429 accounting: shared AI is LEFT ON", m.aiAvailable({}) === true);
  ok("gemini 429 accounting: the message says to try again", /try again/i.test(res.message));
  ok("gemini 429 accounting: it is not confused with the daily quota", !/quota/i.test(res.message));
}
{
  // And the same code at 503, which is the shape that caused the defect. The
  // proxy does not send this today; the client must survive it if anything
  // ever does, because the body code is the reason and the status is not.
  const { m, res } = await geminiWith(503, { error: "ai_accounting_unavailable", retry_after: 30 }, { "Retry-After": "30" });
  eq("gemini 503 accounting: the code still reaches the caller", res.proxyError, "ai_accounting_unavailable");
  ok("gemini 503 accounting: it is still marked transient", res.transient === true);
  ok("gemini 503 accounting: shared AI is LEFT ON even at 503", m.aiAvailable({}) === true);
}
{
  const { m, res } = await geminiWith(503, { error: "shared_key_not_configured" });
  eq("gemini 503 no key: the code reaches the caller", res.proxyError, "shared_key_not_configured");
  ok("gemini 503 no key: NOT marked transient", !res.transient);
  ok("gemini 503 no key: shared AI is switched off, as it always was", m.aiAvailable({}) === false);
}
{
  const { m, res } = await geminiWith(429, { error: "ai_rate_limited", limit: 20, window_seconds: 60, retry_after: 60 }, { "Retry-After": "60" });
  eq("gemini 429 burst: the code reaches the caller", res.proxyError, "ai_rate_limited");
  ok("gemini 429 burst: it is marked transient", res.transient === true);
  eq("gemini 429 burst: the wait is carried", res.retryAfter, 60);
  ok("gemini 429 burst: shared AI is LEFT ON", m.aiAvailable({}) === true);
  ok("gemini 429 burst: it is not confused with the daily quota",
    !/quota/i.test(res.message) && !/Add your own/i.test(res.message));
}
{
  const { res } = await geminiWith(429, { error: "quota", used: 200, limit: 200 });
  eq("gemini 429 quota: still the quota code", res.proxyError, "quota");
  ok("gemini 429 quota: still the quota message", /quota/i.test(res.message));
  ok("gemini 429 quota: not transient, because tomorrow is not a retry", !res.transient);
}
{
  // Gemini's own errors are objects, not strings, and must still pass through.
  const { m, res } = await geminiWith(503, { error: { code: 503, message: "model overloaded" } });
  ok("a 503 from Gemini itself is not read as a proxy code", res.proxyError === null);
  ok("and it does not switch shared AI off", m.aiAvailable({}) === true);
}
{
  const { m } = await geminiWith(403, { error: "forbidden" });
  ok("gemini 403 still reads as a pending account", m.aiAvailable({}) === false);
}

// ══ Path 3: the Opus SDK route ═════════════════════════════════════════════
{
  const m = await load();
  eq("opus: an accounting failure gets the transient message",
    m.anthropicErrorMessage({ status: 429, error: { error: "ai_accounting_unavailable" } }),
    m.AI_MESSAGES.ai_accounting_unavailable);
  eq("opus: and the same message even if it ever arrives as a 503",
    m.anthropicErrorMessage({ status: 503, error: { error: "ai_accounting_unavailable" } }),
    m.AI_MESSAGES.ai_accounting_unavailable);
  eq("opus: a burst refusal gets the transient message",
    m.anthropicErrorMessage({ status: 429, error: { error: "ai_rate_limited" } }),
    m.AI_MESSAGES.ai_rate_limited);
  eq("opus: a missing key still reads as Opus not enabled",
    m.anthropicErrorMessage({ status: 503, error: { error: "shared_key_not_configured" } }),
    m.AI_MESSAGES.opus_not_enabled);
  eq("opus: the daily quota message is unchanged in shape",
    typeof m.anthropicErrorMessage({ status: 429, error: { error: "quota", limit: 60 } }), "string");
  eq("opus: the budget message is unchanged",
    m.anthropicErrorMessage({ status: 429, error: { error: "budget" } }), m.AI_MESSAGES.budget);
  eq("opus: Anthropic's own error shape still falls through to the caller",
    m.anthropicErrorMessage({ status: 529, error: { type: "error", error: { type: "overloaded_error" } } }), null);
}
{
  // sharedOpusFetch is private, so the disabling behaviour is checked where it
  // is decided: noteOpusRefusal only acts on a non-transient code. Read from
  // the source, because the alternative is exporting a function for a test.
  const src = readFileSync(SRC, "utf8");
  const note = src.slice(src.indexOf("function noteOpusRefusal("), src.indexOf("async function sharedOpusFetch("));
  ok("noteOpusRefusal returns early on a transient code",
    /if \(isTransientProxyCode\(code\)\) return;/.test(note));
  ok("and it returns BEFORE anything is switched off",
    note.indexOf("isTransientProxyCode") < note.indexOf("anthropicShared: false"));
  ok("the 503 branch that disables Opus is still there for a real missing key",
    /status === 503[\s\S]{0,120}anthropicShared: false/.test(note));
}

// ══ Retry-After parsing ════════════════════════════════════════════════════
{
  const m = await load();
  const r = (headers, body) => m.retryAfterSeconds({ headers: { get: (h) => headers?.[h] ?? null } }, body);
  eq("the header wins", r({ "Retry-After": "45" }, { retry_after: 9 }), 45);
  eq("the body stands in", r({}, { retry_after: 12 }), 12);
  eq("neither means null", r({}, {}), null);
  eq("a junk header falls back to the body", r({ "Retry-After": "soon" }, { retry_after: 7 }), 7);
  eq("zero is not a wait", r({ "Retry-After": "0" }, null), null);
  eq("a negative is not a wait", r({ "Retry-After": "-5" }, null), null);
  eq("a fractional wait rounds up", r({ "Retry-After": "1.2" }, null), 2);
  eq("an absurd wait is capped, so a bad header cannot park the caller", r({ "Retry-After": "99999" }, null), 300);
  eq("a missing response is survivable", m.retryAfterSeconds(null, { retry_after: 3 }), 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
