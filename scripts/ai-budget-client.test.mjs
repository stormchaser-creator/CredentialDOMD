// Unit-style checks for the client side of the monthly AI budget
// (src/utils/aiClient.js): the Settings copy, the Opus routing verdict and
// the error mapping for the proxy's 429 { error: "budget" }. No network.
// aiClient seeds its status from localStorage at import time, so each case
// stubs localStorage and imports a fresh copy of the module. The routing
// verdict is read through usesSharedOpus()/usesSharedAi(), which look at the
// cached status without kicking off the status fetch (under node there is
// no proxy URL, so that fetch would flip the shared keys off).
// Run: node scripts/ai-budget-client.test.mjs   (pure node, no test runner)
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.join(here, "../src/utils/aiClient.js")).href;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

let seq = 0;
async function loadWith(status) {
  const store = { "credentialdomd-ai-shared": JSON.stringify(status) };
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  // A unique query string defeats the ESM module cache so the seed is re-read.
  return import(`${MODULE}?case=${++seq}`);
}

const BASE = {
  shared: true, used: 3, limit: 200, reason: null,
  anthropicShared: true, anthropicUsed: 2, anthropicLimit: 60, unlimited: false,
  monthSpentUsd: 3.1234, budgetSoftUsd: 8, budgetHardUsd: 15, overSoft: false, overHard: false,
  checkedAt: Date.now(),
};

// ── Under the soft line: an informational line, no warning ───────────────────
{
  const m = await loadWith(BASE);
  eq("status carries the budget fields", [m.sharedAiStatus.monthSpentUsd, m.sharedAiStatus.budgetSoftUsd, m.sharedAiStatus.budgetHardUsd, m.sharedAiStatus.overSoft, m.sharedAiStatus.overHard], [3.1234, 8, 15, false, false]);
  eq("settings line", m.describeAiBudget({}), { line: "About $3.12 of $15.00 this month on the shared keys.", warning: null });
  ok("opus is open", m.usesSharedOpus({}) === true);
  eq("opus status line", m.describeOpusStatus({}), "Shared Opus: on, 2 of 60 calls used today");
  eq("nothing to say with own keys for both", m.describeAiBudget({ apiKey: "k", anthropicApiKey: "k" }), null);
  ok("one own key still shows the shared spend", m.describeAiBudget({ apiKey: "k" }) !== null);
}

// ── Past the soft line: the plain warning ────────────────────────────────────
{
  const m = await loadWith({ ...BASE, monthSpentUsd: 9.5, overSoft: true });
  const b = m.describeAiBudget({});
  eq("soft line", b.line, "About $9.50 of $15.00 this month on the shared keys.");
  eq("soft warning", b.warning, "Past the $8.00 soft line for this month. At $15.00, Vera, the RVU coder and case dictation switch to Gemini until the first of next month.");
  ok("opus still open past the soft line", m.usesSharedOpus({}) === true);
  ok("no em dash in the copy", !/—/.test(b.warning + b.line));
}

// ── Past the hard line: Opus closed, Gemini on, the sentence both surfaces use ─
{
  const m = await loadWith({ ...BASE, monthSpentUsd: 15.2, overSoft: true, overHard: true });
  const b = m.describeAiBudget({});
  eq("hard warning", b.warning, "The monthly AI budget is used up. Vera, the RVU coder and case dictation answer on Gemini until the first of next month; document scanning, CME import and work-log dictation keep working.");
  ok("opus closed past the hard line", m.usesSharedOpus({}) === false);
  ok("own Anthropic key is unaffected", m.anthropicAvailable({ anthropicApiKey: "k" }) === true);
  ok("Gemini stays available", m.usesSharedAi({}) === true);
  eq("opus status line", m.describeOpusStatus({}), "Shared Opus: the monthly AI budget ($15.00) is used up. Vera answers on Gemini until the first of next month.");
  eq("coder reason is the budget sentence", m.opusUnavailableReason(), m.AI_MESSAGES.budget);
  eq("the budget sentence", m.AI_MESSAGES.budget, "The monthly AI budget is used up, so Gemini answered.");
  ok("no em dash in the copy", !/—/.test(b.warning + b.line + m.AI_MESSAGES.budget + m.describeOpusStatus({})));
}

// ── The daily cap still reads as the daily cap ───────────────────────────────
{
  const m = await loadWith({ ...BASE, anthropicUsed: 60 });
  ok("opus closed at the daily cap", m.usesSharedOpus({}) === false);
  ok("coder reason names the daily quota", /Shared Opus quota reached for today \(60 calls\)/.test(m.opusUnavailableReason()));
  ok("daily cap line unchanged", /daily limit reached \(60 calls\)/.test(m.describeOpusStatus({})));
}

// ── Admins: spend shown, never a warning, never closed ───────────────────────
{
  const m = await loadWith({ ...BASE, unlimited: true, monthSpentUsd: 40, overSoft: false, overHard: false });
  eq("admin line", m.describeAiBudget({}), { line: "About $40.00 this month on the shared keys (no budget on admin accounts).", warning: null });
  ok("admin opus open", m.usesSharedOpus({}) === true);
}

// ── An older proxy deploy reports no budget: nothing shown, nothing closed ──
{
  const m = await loadWith({ ...BASE, monthSpentUsd: 0, budgetSoftUsd: 0, budgetHardUsd: 0 });
  eq("no budget line without a budget", m.describeAiBudget({}), null);
  ok("opus open", m.usesSharedOpus({}) === true);
  const off = await loadWith({ ...BASE, anthropicShared: false });
  eq("not enabled reason when the shared key is off", off.opusUnavailableReason(), "Opus is not enabled on this account yet.");
  eq("no budget line when the shared keys are off for this account", (await loadWith({ ...BASE, shared: false, anthropicShared: false })).describeAiBudget({}), null);
}

// ── Error mapping for the SDK's thrown error on a proxy refusal ─────────────
{
  const m = await loadWith(BASE);
  const err = (status, body) => ({ status, error: body });
  eq("budget 429", m.anthropicErrorMessage(err(429, { error: "budget", spent_usd: 15.2, budget_usd: 15, provider: "anthropic" })), m.AI_MESSAGES.budget);
  ok("quota 429", /Shared Opus quota reached for today/.test(m.anthropicErrorMessage(err(429, { error: "quota", used: 60, limit: 60 }))));
  eq("Anthropic's own 429 is not a proxy refusal", m.anthropicErrorMessage(err(429, { type: "error", error: { type: "rate_limit_error" } })), null);
  eq("Anthropic's own 529 is not a proxy refusal", m.anthropicErrorMessage(err(529, { type: "error", error: { type: "overloaded_error" } })), null);
  eq("proxy 503", m.anthropicErrorMessage(err(503, { error: "shared_key_not_configured", provider: "anthropic" })), "Opus is not enabled on this account yet.");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
