// OPS-005: the monthly AI spend a member sees in Settings ("About $X of $15.00
// this month on the shared keys") left out Gemini. ai-proxy's status summed
// ai_spend_holds alone, and only the Anthropic path takes a hold. The figure
// now comes from public.ai_month_spend_usd (migration 20260930040000), proven
// here against a real PostgreSQL, and monthSpendFigures in the proxy, loaded
// from the real file. The cap and its verdicts are unchanged. Synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';
import { pgSkip } from './credential-portal/postgresFixture.mjs';
import { startPostgres } from './ops/pg.mjs';

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const PROXY = read('../supabase/functions/ai-proxy/index.ts');
const MIGRATION = read('../supabase/migrations/20260930040000_ai_month_spend_display.sql');
const ROLLBACK = read('../docs/rollback/20260930040000_ai_month_spend_display.rollback.sql');
const A = '00000000-0000-4000-8000-0000000005a1';
const B = '00000000-0000-4000-8000-0000000005b2';

async function proxyModule() {
  const noop = () => {};
  const names = { serve: noop, Deno: { env: { get: () => '' } }, clerkProfile: noop, accessWriteDecision: noop, meterUsage: () => ({}), priceFor: noop };
  const limits = await import('../supabase/functions/ai-proxy/limits.ts');
  Object.assign(names, limits);
  globalThis.__aiMonthSpendTest = names;
  const source = `const { ${Object.keys(names).join(', ')} } = globalThis.__aiMonthSpendTest;\n${PROXY.replace(/^import .*;\n/gm, '').replace(/^export \{[^}]*\};\n/gm, '')}`;
  const js = transformSync(source, { loader: 'ts', format: 'esm' }).code;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}

test('the status figure adds metered Gemini to the Anthropic holds; the verdicts stay on the holds', async () => {
  const { monthSpendFigures } = await proxyModule();
  // A metered Vera question and a Smart Scan on Gemini, no Opus: the QA run's $0.000436.
  assert.deepEqual(monthSpendFigures(false, { held_usd: '0', gemini_usd: '0.000436', anthropic_usd: '0' }), { spent: 0.000436, capped: 0, gemini: 0.000436 });
  assert.deepEqual(monthSpendFigures(false, { held_usd: '2.5', gemini_usd: '0.75', anthropic_usd: '2.1' }), { spent: 3.25, capped: 2.5, gemini: 0.75 });
  // An administrator takes no holds: the metered cost of both providers, and
  // the Anthropic part as the Opus figure (never a verdict: over_* are false).
  assert.deepEqual(monthSpendFigures(true, { held_usd: '0', gemini_usd: '0.25', anthropic_usd: '4' }), { spent: 4.25, capped: 4, gemini: 0.25 });
  for (const junk of [null, undefined, {}, { held_usd: 'NaN', gemini_usd: -3, anthropic_usd: 'x' }]) assert.deepEqual(monthSpendFigures(false, junk), { spent: 0, capped: 0, gemini: 0 });
});

test('the status answer shows month.spent and decides over_soft / over_hard on month.capped, with the old read as fallback', () => {
  assert.match(PROXY, /db\.rpc\("ai_month_spend_usd", \{ p_user: user\.profileId \}\)/);
  assert.match(PROXY, /month_spent_usd: month\.spent,/);
  assert.match(PROXY, /over_soft: !user\.isAdmin && month\.capped >= BUDGET_SOFT_USD,/);
  assert.match(PROXY, /over_hard: !user\.isAdmin && month\.capped >= BUDGET_HARD_USD,/);
  // The two parts go out too, so Settings sets the budget against the figure the verdicts use (the review of OPS-005).
  assert.match(PROXY, /month_capped_usd: month\.capped,/);
  assert.match(PROXY, /month_gemini_usd: month\.gemini,/);
  // The fallback knows no Gemini figure, and says so with null rather than $0.00.
  assert.match(PROXY, /const held = await monthSpentUsd\(\);\s*return \{ spent: held, capped: held, gemini: null \};/);
  // The cap itself is untouched: Gemini still never takes a hold.
  assert.doesNotMatch(PROXY.slice(PROXY.indexOf('---- POST: forward one Gemini call ----')), /holdSpend|ai_month_spend_usd/);
});

test('ai_month_spend_usd: this month only, by provider, per user, service role only, idempotent, rollback', { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres(57611, 'ai-month-spend');
  t.after(() => pg.close());
  await pg.sql(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.ai_usage (id bigserial primary key, user_id uuid not null, provider text, cost_usd numeric, created_at timestamptz not null default now());
    create table public.ai_spend_holds (id uuid primary key default gen_random_uuid(), user_id uuid not null, month_start timestamptz not null, amount_usd numeric not null);
    grant select on public.ai_usage, public.ai_spend_holds to service_role;
  `);
  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION);
  const month = `date_trunc('month', now() at time zone 'utc') at time zone 'utc'`;
  await pg.sql(`
    insert into public.ai_spend_holds (user_id, month_start, amount_usd) values
      ('${A}', ${month}, 1.25), ('${A}', ${month}, 0.5), ('${A}', ${month} - interval '1 month', 9), ('${B}', ${month}, 7);
    insert into public.ai_usage (user_id, provider, cost_usd, created_at) values
      ('${A}', 'gemini', 0.000436, now()), ('${A}', 'gemini', 0.1, now()), ('${A}', 'gemini', null, now()),
      ('${A}', 'gemini', 5, ${month} - interval '1 second'), ('${A}', 'anthropic', 1.6, now()), ('${B}', 'gemini', 3, now());
  `);
  const [row] = await pg.rows(`select public.ai_month_spend_usd('${A}') as r`, { user: 'postgres' });
  assert.equal(Number(row.r.held_usd), 1.75);
  assert.equal(Number(row.r.gemini_usd), 0.100436);
  assert.equal(Number(row.r.anthropic_usd), 1.6);
  const [none] = await pg.rows(`select public.ai_month_spend_usd('00000000-0000-4000-8000-000000000000') as r`);
  assert.deepEqual([none.r.held_usd, none.r.gemini_usd, none.r.anthropic_usd].map(Number), [0, 0, 0]);
  const asRole = role => pg.tryRun(`begin; set local role ${role}; select public.ai_month_spend_usd('${A}'); commit;`);
  assert.equal((await asRole('service_role')).ok, true);
  for (const role of ['authenticated', 'anon']) assert.match((await asRole(role)).err, /permission denied/, role);
  await pg.sql(ROLLBACK);
  await pg.sql(ROLLBACK);
  assert.equal(await pg.sql(`select count(*) from pg_proc where proname = 'ai_month_spend_usd'`), '0');
  // No top-level transaction control in either file.
  for (const text of [MIGRATION, ROLLBACK]) assert.doesNotMatch(text.replace(/--.*$/gm, ''), /^\s*(begin|commit)\s*;/im);
});
