// OPS-005, the review of the first fix: the monthly AI spend in Settings >
// AI grew to include Gemini, but the budget's verdicts (over_soft, over_hard)
// stayed on the Opus holds the cap counts. A member with $14.90 of Opus holds
// and $0.50 of metered Gemini then read "About $15.40 of $15.00 this month on
// the shared keys." with no warning while Opus kept answering, and a budget
// refusal (429 { error: "budget", spent_usd }) replaced the figure with the
// holds alone, so it dropped by the Gemini amount until the next status read.
//
// Here the proxy's own monthSpendFigures (loaded from the real file) makes
// the status answer the way the proxy's GET does, and the real
// src/utils/aiClient.js reads it through a stubbed fetch and writes the
// Settings line. The budget is set against the figure its verdicts are
// decided on, and Gemini is named beside it. Enforcement is unchanged.
// No endpoint, account or provider is reached; all data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY = fs.readFileSync(path.join(ROOT, 'supabase/functions/ai-proxy/index.ts'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'src/utils/aiClient.js'), 'utf8');

// aiClient reads import.meta.env, which node leaves undefined (no proxy URL,
// so nothing would be fetched). The copy gets a literal instead, and lives
// under node_modules/.cache so its bare imports still resolve.
const SUPABASE_URL = 'https://budget-basis.supabase.invalid';
const PATCHED = CLIENT.replace('const ENV = import.meta.env || {};', `const ENV = { VITE_SUPABASE_URL: ${JSON.stringify(SUPABASE_URL)} };`);
const CACHE = path.join(ROOT, 'node_modules/.cache', `credentialdomd-ai-budget-basis-${process.pid}`);
fs.mkdirSync(CACHE, { recursive: true });
process.on('exit', () => { try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch { /* best effort */ } });

globalThis.window = { Clerk: { session: { getToken: async () => 'synthetic-clerk-token' } } };

async function proxyFigures() {
  const noop = () => {};
  const names = { serve: noop, Deno: { env: { get: () => '' } }, clerkProfile: noop, accessWriteDecision: noop, meterUsage: () => ({}), priceFor: noop };
  Object.assign(names, await import('../supabase/functions/ai-proxy/limits.ts'));
  globalThis.__aiBudgetBasisTest = names;
  const source = `const { ${Object.keys(names).join(', ')} } = globalThis.__aiBudgetBasisTest;\n${PROXY.replace(/^import .*;\n/gm, '').replace(/^export \{[^}]*\};\n/gm, '')}`;
  const js = transformSync(source, { loader: 'ts', format: 'esm' }).code;
  return (await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))).monthSpendFigures;
}
const monthSpendFigures = await proxyFigures();

const SOFT = 8, HARD = 15;
// The proxy's GET answer for a member, built as ai-proxy/index.ts builds it
// (the source checks below hold it to that).
function statusBody({ isAdmin = false, sums, month = monthSpendFigures(isAdmin, sums) }) {
  return {
    shared: true, allowed: true, configured: true, used_today: 4, limit: 200, unlimited: isAdmin,
    anthropic_shared: true, anthropic_configured: true, anthropic_used_today: 3, anthropic_limit: 60,
    month_spent_usd: month.spent, month_capped_usd: month.capped, month_gemini_usd: month.gemini,
    budget_soft_usd: SOFT, budget_hard_usd: HARD,
    over_soft: !isAdmin && month.capped >= SOFT, over_hard: !isAdmin && month.capped >= HARD,
  };
}

const response = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let seq = 0;
async function client(status, opus = null) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || 'GET' });
    if ((init.method || 'GET') === 'GET') return response(200, status);
    return opus ? opus() : response(500, { error: 'unexpected' });
  };
  const store = {};
  globalThis.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const file = path.join(CACHE, `aiClient.${++seq}.mjs`);
  fs.writeFileSync(file, PATCHED);
  const m = await import(pathToFileURL(file).href);
  await m.fetchSharedAiStatus({ force: true });
  return { m, requests };
}

// The dollar figure the line sets against the budget.
const budgeted = line => Number(/^About \$(\d+\.\d\d) of \$/.exec(line)?.[1]);

test('the copy of aiClient reaches the stubbed proxy', () => {
  assert.ok(PATCHED.includes(SUPABASE_URL), 'the import.meta.env line changed shape');
});

test('$14.90 of Opus holds and $0.50 of Gemini: the line sets $14.90 against $15.00, names Gemini, and agrees with the verdict', async () => {
  const body = statusBody({ sums: { held_usd: '14.9', gemini_usd: '0.5', anthropic_usd: '14.2' } });
  assert.equal(body.month_spent_usd, 15.4, 'the month total still includes Gemini');
  assert.equal(body.over_hard, false, 'the cap has not refused: Opus keeps answering');
  const { m, requests } = await client(body);
  assert.ok(requests.some(r => r.url.endsWith('/functions/v1/ai-proxy') && r.method === 'GET'));
  const b = m.describeAiBudget({});
  assert.equal(b.line, 'About $14.90 of $15.00 this month on shared Opus, plus $0.50 on Gemini, which the budget does not cap.');
  assert.doesNotMatch(b.line, /\$15\.40 of \$15\.00/);
  assert.match(b.warning, /^Past the \$8\.00 soft line/, 'past the soft line, and it says so');
  assert.equal(m.usesSharedOpus({}), true);
  assert.doesNotMatch(b.line + b.warning, /—/);
});

test('whatever the month holds, the figure set against the budget is past a line exactly when the verdict says so', async () => {
  const months = [
    { held_usd: '7.8', gemini_usd: '0.4' },     // both providers past $8, the holds not
    { held_usd: '8', gemini_usd: '0' },
    { held_usd: '14.99', gemini_usd: '3' },     // both providers past $15, the holds not
    { held_usd: '15', gemini_usd: '0.25' },
    { held_usd: '0', gemini_usd: '0.000436' },  // Gemini only (the shared Opus key paused)
    { held_usd: '2.5', gemini_usd: '0.75' },
  ];
  for (const sums of months) {
    const body = statusBody({ sums });
    const { m } = await client(body);
    const b = m.describeAiBudget({});
    const figure = budgeted(b.line);
    assert.equal(figure >= SOFT, body.over_soft, `${JSON.stringify(sums)}: ${b.line}`);
    assert.equal(figure >= HARD, body.over_hard, `${JSON.stringify(sums)}: ${b.line}`);
    assert.equal(b.warning !== null, body.over_soft, `${JSON.stringify(sums)}: a warning exactly when past the soft line`);
    const gemini = Number(sums.gemini_usd);
    assert.equal(/on Gemini, which the budget does not cap\.$/.test(b.line), gemini >= 0.005, `${JSON.stringify(sums)}: Gemini named when it rounds to a cent`);
  }
});

test('a budget refusal keeps Gemini in the month total and sets its own figure against the budget', async () => {
  const body = statusBody({ sums: { held_usd: '14.9', gemini_usd: '0.5' } });
  const { m } = await client(body, () => response(429, { error: 'budget', spent_usd: 14.95, budget_usd: 15, would_add_usd: 0.2, provider: 'anthropic' }, { 'x-should-retry': 'false' }));
  const anthropic = await m.anthropicClientFor({});
  const err = await anthropic.messages.create({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'Synthetic question' }] }).then(() => null, e => e);
  assert.ok(err, 'the proxy refused');
  assert.equal(m.anthropicErrorMessage(err), m.AI_MESSAGES.budget);
  assert.equal(m.sharedAiStatus.overHard, true);
  assert.equal(m.sharedAiStatus.monthSpentUsd, 15.45, 'the total keeps the $0.50 of Gemini, not the holds alone');
  assert.equal(m.sharedAiStatus.monthCappedUsd, 14.95);
  const b = m.describeAiBudget({});
  assert.equal(b.line, 'About $14.95 of $15.00 this month on shared Opus, plus $0.50 on Gemini, which the budget does not cap.');
  assert.match(b.warning, /^The monthly AI budget is used up\./);
  assert.equal(m.usesSharedOpus({}), false, 'Vera answers on Gemini');
});

test('a proxy that sends no split (the deployed one) or no Gemini figure (its fallback): the line is the budget\'s own figure', async () => {
  const old = statusBody({ month: { spent: 3.1234, capped: 0, gemini: 0 } });
  delete old.month_capped_usd; delete old.month_gemini_usd;
  old.over_soft = false; old.over_hard = false;
  const before = await client(old);
  assert.equal(before.m.sharedAiStatus.monthCappedUsd, null);
  assert.equal(before.m.describeAiBudget({}).line, 'About $3.12 of $15.00 this month on shared Opus.');
  const fallback = await client(statusBody({ month: { spent: 2, capped: 2, gemini: null } }));
  assert.equal(fallback.m.sharedAiStatus.monthGeminiUsd, null);
  assert.equal(fallback.m.describeAiBudget({}).line, 'About $2.00 of $15.00 this month on shared Opus.');
});

test('an administrator reads the month total; previewing a member, their own Opus figure against the budget', async () => {
  const { m } = await client(statusBody({ isAdmin: true, sums: { held_usd: '0', gemini_usd: '0.25', anthropic_usd: '4' } }));
  assert.deepEqual(m.describeAiBudget({}), { line: 'About $4.25 this month on the shared keys (no budget on admin accounts).', warning: null });
  m.setAiStatusDisplay(status => ({ ...status, unlimited: false }));
  assert.deepEqual(m.describeAiBudget({}), { line: 'About $4.00 of $15.00 this month on shared Opus, plus $0.25 on Gemini, which the budget does not cap.', warning: null });
});

test('the proxy sends the parts the client reads, and decides the verdicts on the part it sets against the budget', () => {
  const get = PROXY.slice(PROXY.indexOf('if (req.method === "GET") {'));
  for (const line of ['month_spent_usd: month.spent,', 'month_capped_usd: month.capped,', 'month_gemini_usd: month.gemini,',
    'over_soft: !user.isAdmin && month.capped >= BUDGET_SOFT_USD,', 'over_hard: !user.isAdmin && month.capped >= BUDGET_HARD_USD,']) {
    assert.ok(get.includes(line), line);
  }
  // The cap is untouched: the budget refusal still reports the holds.
  assert.match(PROXY, /error: "budget", spent_usd: spend\.spent_usd, budget_usd: BUDGET_HARD_USD,/);
});
