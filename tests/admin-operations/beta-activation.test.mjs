// The clerk-webhook half of the "Back to pending" re-grant fix. The SQL half
// (admin_change_profile_access + claim_beta_access) runs against real
// Postgres in postgres-operations.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';

const source = buildSync({
  entryPoints: [new URL('../../supabase/functions/clerk-webhook/betaActivation.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', source)(mod, mod.exports);
const { decideBetaActivation } = mod.exports;

const NOW = '2026-09-25T12:00:00.000Z';
const PROFILE = '00000000-0000-4000-8000-000000000014';
const invite = over => ({ id: 'invite', email: 'member@example.invalid', status: 'invited', activated_at: null, profile_id: null, ...over });
const profile = status => ({ id: PROFILE, access_status: status });

// What admin_change_profile_access leaves behind, per the new migration.
const afterAdmin = { status: 'revoked', activated_at: '2026-09-20T00:00:00Z', profile_id: PROFILE };

test('revoke then pending: the next Clerk event leaves the account pending and writes nothing', () => {
  const decision = decideBetaActivation(invite(afterAdmin), profile('pending'), NOW);
  assert.equal(decision.action, 'none');
});

test('active then pending: same result', () => {
  const decision = decideBetaActivation(invite(afterAdmin), profile('pending'), NOW);
  assert.equal(decision.action, 'none');
  assert.equal(decideBetaActivation(invite(afterAdmin), profile('revoked'), NOW).action, 'none');
});

test('a consumed invitation left active or invited by any older path cannot re-grant a pending profile', () => {
  for (const status of ['active', 'invited', 'ACTIVE ']) {
    const decision = decideBetaActivation(invite({ ...afterAdmin, status }), profile('pending'), NOW);
    assert.equal(decision.action, 'none', status);
    assert.match(decision.log, /only an audited Approve/);
  }
  // A null status reads as pending, which is not active either.
  assert.equal(decideBetaActivation(invite({ ...afterAdmin, status: 'active' }), profile(null), NOW).action, 'none');
});

test('a fresh invitation still activates a pending profile on first sign-in', () => {
  const decision = decideBetaActivation(invite(), profile('pending'), NOW);
  assert.equal(decision.action, 'apply');
  assert.equal(decision.activateProfile, true);
  assert.deepEqual(decision.betaPatch, { status: 'active', activated_at: NOW, profile_id: PROFILE });
});

test('an invitation used by a different, earlier profile can still link a new account for the same verified email', () => {
  const decision = decideBetaActivation(invite({ status: 'active', activated_at: '2026-09-01T00:00:00Z', profile_id: 'older-profile' }), profile('pending'), NOW);
  assert.equal(decision.action, 'apply');
  assert.equal(decision.activateProfile, true);
  assert.deepEqual(decision.betaPatch, { profile_id: PROFILE });
});

test('existing outcomes are unchanged: revoked invite, unknown status, active and paused profiles', () => {
  assert.equal(decideBetaActivation(invite({ status: 'revoked' }), profile('pending'), NOW).action, 'none');
  const unknown = decideBetaActivation(invite({ status: 'expired' }), profile('pending'), NOW);
  assert.equal(unknown.action, 'none'); assert.equal(unknown.warn, true);
  const active = decideBetaActivation(invite({ status: 'active', activated_at: NOW, profile_id: PROFILE }), profile('active'), NOW);
  assert.equal(active.action, 'apply'); assert.equal(active.activateProfile, false); assert.deepEqual(active.betaPatch, {});
  const paused = decideBetaActivation(invite(), profile('revoked'), NOW);
  assert.equal(paused.action, 'apply'); assert.equal(paused.activateProfile, false);
});

test('the webhook routes every activation through the decision', async () => {
  const { readFile } = await import('node:fs/promises');
  const webhook = await readFile(new URL('../../supabase/functions/clerk-webhook/index.ts', import.meta.url), 'utf8');
  const body = webhook.slice(webhook.indexOf('async function activateBetaAccess('), webhook.indexOf('serve(async'));
  assert.match(body, /decideBetaActivation\(match, profile, now\)/);
  assert.match(body, /decision\.action === "none"/);
  assert.match(body, /if \(!decision\.activateProfile\)/);
  // The profile update keeps its own revoked guard as a second check.
  assert.match(body, /\.or\("access_status\.is\.null,access_status\.neq\.revoked"\)/);
});
