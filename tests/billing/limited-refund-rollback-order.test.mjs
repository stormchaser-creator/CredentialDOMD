// Rolling back Cancel and get a refund must never break live checkout (review
// 2026-09-30): the ledger rollback drops limited_refund_for_subscription,
// which the new limited-checkout calls on every checkout. Its header has to
// say to revert the app, redeploy every edge function built from the changed
// shared modules and delete limited-refund BEFORE the SQL runs, and the new
// limited-checkout reads a missing function as "no unfinished refund" so an
// out-of-order rollback still cannot stop checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8');
const SHARED = /_shared\/(limitedLaunchHandlers\.mjs|limitedLaunchDependencies\.ts)['"]/;
// Every deployed entrypoint built from the shared modules this change edits.
const entrypoints = fs.readdirSync(new URL('supabase/functions/', root), { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== '_shared' && fs.existsSync(new URL(`supabase/functions/${d.name}/index.ts`, root)))
  .map(d => d.name).filter(name => SHARED.test(read(`supabase/functions/${name}/index.ts`))).sort();

test('the ledger rollback says what to undo first: the app, every function built from the shared modules, then limited-refund', () => {
  assert.deepEqual(entrypoints, ['activate-billing-invitation', 'billing-quote', 'limited-checkout', 'limited-customer-portal', 'limited-refund', 'limited-stripe-webhook']);
  const rollback = read('docs/rollback/20260930070000_limited_refunds.rollback.sql');
  const header = rollback.split('\n').filter(line => line.startsWith('--')).join('\n');
  const at = phrase => { const i = header.indexOf(phrase); assert.ok(i >= 0, `the header names: ${phrase}`); return i; };
  const revert = at('Revert the app');
  const remove = at('Delete the limited-refund edge function');
  assert.ok(revert < remove);
  const redeploy = header.slice(revert, remove);
  for (const name of entrypoints.filter(n => n !== 'limited-refund')) assert.ok(redeploy.includes(name), `${name} is redeployed after the app is reverted and before limited-refund goes`);
  assert.ok(at('Only then run this file') > remove);
  assert.ok(rollback.indexOf('drop function if exists public.limited_refund_for_subscription') > rollback.lastIndexOf('-- '), 'the SQL comes after the header');
});

test('limited-checkout reads a missing refund function (PGRST202) as no unfinished refund, and any other error still stops it', () => {
  const deps = read('supabase/functions/_shared/limitedLaunchDependencies.ts');
  const body = deps.slice(deps.indexOf('unfinishedRefund:'), deps.indexOf('stalledRefunds:'));
  assert.match(body, /code === 'PGRST202'\) return null;/);
  assert.match(body, /throw Error\('Limited billing database operation failed'\)/);
});
