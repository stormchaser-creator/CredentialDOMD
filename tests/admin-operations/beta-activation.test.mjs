// The clerk-webhook half of the access fixes. An administrator decides Approve
// or Pause, never pending (the SQL half, admin_change_profile_access and
// claim_beta_access, runs against real Postgres in postgres-operations.py),
// so the webhook refuses only a revoked invitation or a revoked profile, and
// its two writes are ordered so a retry after a partial failure finishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';

const source = buildSync({
  entryPoints: [new URL('../../supabase/functions/clerk-webhook/betaActivation.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', source)(mod, mod.exports);
const { decideBetaActivation, applyBetaDecision } = mod.exports;

const NOW = '2026-09-25T12:00:00.000Z';
const PROFILE = '00000000-0000-4000-8000-000000000014';
const invite = over => ({ id: 'invite', email: 'member@example.invalid', status: 'invited', activated_at: null, profile_id: null, ...over });
const profile = status => ({ id: PROFILE, access_status: status });
const quiet = { log() {}, warn() {} };

test('a paused account is never activated, whatever invitation matches', () => {
  // What Pause leaves: the linked invitation revoked.
  assert.equal(decideBetaActivation(invite({ status: 'revoked', activated_at: '2026-09-20T00:00:00Z', profile_id: PROFILE }), profile('revoked'), NOW).action, 'none');
  // An unlinked invitation for the same address (send-invite for an account
  // that was already active), or for a second verified address the member
  // makes primary: the profile stays revoked.
  for (const match of [invite(), invite({ email: 'second@example.invalid' })]) {
    const decision = decideBetaActivation(match, profile('revoked'), NOW);
    assert.equal(decision.action, 'apply');
    assert.equal(decision.activateProfile, false);
  }
});

test('an invitation this profile stamped when its profile write failed still activates it', () => {
  // The first attempt linked and stamped the invitation, then the profile
  // update failed and Svix retried. Refusing a "consumed" invitation here
  // stranded a new invitee nobody had decided on.
  for (const status of ['active', 'invited']) {
    const decision = decideBetaActivation(invite({ status, activated_at: '2026-09-25T11:59:00Z', profile_id: PROFILE }), profile('pending'), NOW);
    assert.equal(decision.action, 'apply', status);
    assert.equal(decision.activateProfile, true, status);
  }
  assert.equal(decideBetaActivation(invite({ status: 'active', activated_at: NOW, profile_id: PROFILE }), profile(null), NOW).activateProfile, true);
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

// ─── The two writes, against a synthetic client ─────────────────────────
function database({ profileStatus = 'pending', failOnce = {} } = {}) {
  const rows = { profiles: { [PROFILE]: { id: PROFILE, access_status: profileStatus } }, beta_access: { invite: invite() } };
  const writes = [];
  const client = {
    from(table) {
      return { update(patch) {
        const filters = [];
        const run = async () => {
          writes.push({ table, patch, filters: [...filters] });
          if (failOnce[table]) { failOnce[table] = false; return { error: { message: `synthetic ${table} failure` } }; }
          const id = filters.find(f => f[0] === 'eq')[2];
          const row = rows[table][id];
          const revokedGuard = filters.some(f => f[0] === 'or');
          if (row && !(revokedGuard && row.access_status === 'revoked')) Object.assign(row, patch);
          return { error: null };
        };
        const q = { eq(column, value) { filters.push(['eq', column, value]); return q; }, or(filter) { filters.push(['or', filter]); return q; },
          then(resolve, reject) { return run().then(resolve, reject); } };
        return q;
      } };
    },
  };
  // One webhook delivery: read the current rows, decide, write.
  const deliver = async () => {
    const decision = decideBetaActivation({ ...rows.beta_access.invite }, { ...rows.profiles[PROFILE] }, NOW);
    if (decision.action === 'none') return { error: null };
    return applyBetaDecision(client, { ...rows.beta_access.invite }, { ...rows.profiles[PROFILE] }, decision, NOW, quiet);
  };
  return { rows, writes, deliver };
}

test('the profile is written before the invitation', async () => {
  const db = database();
  assert.deepEqual(await db.deliver(), { error: null });
  assert.deepEqual(db.writes.map(w => w.table), ['profiles', 'beta_access']);
  assert.deepEqual(db.writes[0].filters, [['eq', 'id', PROFILE], ['or', 'access_status.is.null,access_status.neq.revoked']]);
  assert.equal(db.rows.profiles[PROFILE].access_status, 'active');
  assert.equal(db.rows.beta_access.invite.profile_id, PROFILE);
});

test('a failed profile write leaves the invitation untouched, and the retry activates both', async () => {
  const db = database({ failOnce: { profiles: true } });
  const first = await db.deliver();
  assert.match(first.error, /update profiles\.access_status: synthetic profiles failure/);
  assert.deepEqual(db.rows.beta_access.invite, invite(), 'no stamp without an active profile');
  assert.deepEqual(await db.deliver(), { error: null });
  assert.equal(db.rows.profiles[PROFILE].access_status, 'active');
  assert.equal(db.rows.beta_access.invite.status, 'active');
  assert.equal(db.rows.beta_access.invite.profile_id, PROFILE);
});

test('a failed invitation write after the profile write: the retry links the invitation', async () => {
  const db = database({ failOnce: { beta_access: true } });
  assert.match((await db.deliver()).error, /update beta_access/);
  assert.equal(db.rows.profiles[PROFILE].access_status, 'active');
  assert.equal(db.rows.beta_access.invite.profile_id, null);
  assert.deepEqual(await db.deliver(), { error: null });
  assert.equal(db.rows.beta_access.invite.status, 'active');
  assert.equal(db.rows.beta_access.invite.activated_at, NOW);
  assert.equal(db.rows.beta_access.invite.profile_id, PROFILE);
});

test('the half-applied state the old order left behind (invitation stamped, profile pending) finishes on retry', async () => {
  const db = database();
  Object.assign(db.rows.beta_access.invite, { status: 'active', activated_at: '2026-09-25T11:59:00Z', profile_id: PROFILE });
  assert.deepEqual(await db.deliver(), { error: null });
  assert.equal(db.rows.profiles[PROFILE].access_status, 'active');
  assert.deepEqual(db.writes.map(w => w.table), ['profiles']);
});

test('a paused profile is never written active', async () => {
  const db = database({ profileStatus: 'revoked' });
  assert.deepEqual(await db.deliver(), { error: null });
  assert.equal(db.rows.profiles[PROFILE].access_status, 'revoked');
  assert.ok(db.writes.every(w => w.table !== 'profiles'));
});

test('the webhook routes every activation through the decision and the ordered writes', async () => {
  const { readFile } = await import('node:fs/promises');
  const webhook = await readFile(new URL('../../supabase/functions/clerk-webhook/index.ts', import.meta.url), 'utf8');
  const body = webhook.slice(webhook.indexOf('async function activateBetaAccess('), webhook.indexOf('serve(async'));
  assert.match(body, /decideBetaActivation\(match, profile, now\)/);
  assert.match(body, /decision\.action === "none"/);
  assert.match(body, /applyBetaDecision\(supabase, match, profile, decision, now\)/);
  // No write of its own outside the ordered helper.
  assert.doesNotMatch(body, /\.update\(/);
});
