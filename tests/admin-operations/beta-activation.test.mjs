// The clerk-webhook half of the invitation rules. Owner decision, 2026-09-29:
// an invitation is an invite to JOIN, never access. A pending account stays
// pending whatever invitation matches its verified email (it signs up and
// pays like anyone else); an account that already has access, or is paused,
// only gets its matching invitation linked, so a later Pause revokes it with
// the account. The profile is never written here. (The SQL half,
// claim_beta_access, runs against real Postgres in
// tests/invite-to-join/sql.test.mjs.)
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';

const source = buildSync({
  entryPoints: [fileURLToPath(new URL('../../supabase/functions/clerk-webhook/betaActivation.ts', import.meta.url))],
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

test('an invitation never activates a pending account, fresh, consumed or used by an earlier profile', () => {
  for (const match of [
    invite(),
    invite({ status: 'active', activated_at: '2026-09-25T11:59:00Z', profile_id: PROFILE }),
    invite({ status: 'active', activated_at: '2026-09-01T00:00:00Z', profile_id: 'older-profile' }),
  ]) {
    for (const status of ['pending', null, 'PENDING ']) {
      const decision = decideBetaActivation(match, profile(status), NOW);
      assert.equal(decision.action, 'none', `${JSON.stringify(match)} / ${status}`);
      assert.equal('activateProfile' in decision, false);
      assert.match(decision.log, /invitation to join, not access/);
    }
  }
});

test('a paused account is never activated, and its matching invitation is only linked', () => {
  // What Pause leaves: the linked invitation revoked.
  assert.equal(decideBetaActivation(invite({ status: 'revoked', activated_at: '2026-09-20T00:00:00Z', profile_id: PROFILE }), profile('revoked'), NOW).action, 'none');
  for (const match of [invite(), invite({ email: 'second@example.invalid' })]) {
    const decision = decideBetaActivation(match, profile('revoked'), NOW);
    assert.equal(decision.action, 'apply');
    assert.equal(decision.warn, true);
    assert.equal('activateProfile' in decision, false);
  }
});

test('an active account has its invitation linked and stamped once', () => {
  const fresh = decideBetaActivation(invite(), profile('active'), NOW);
  assert.equal(fresh.action, 'apply');
  assert.deepEqual(fresh.betaPatch, { status: 'active', activated_at: NOW, profile_id: PROFILE });
  const linked = decideBetaActivation(invite({ status: 'active', activated_at: NOW, profile_id: PROFILE }), profile('active'), NOW);
  assert.equal(linked.action, 'apply'); assert.deepEqual(linked.betaPatch, {});
});

test('revoked and unknown invitations are left alone', () => {
  for (const status of ['pending', 'active']) {
    assert.equal(decideBetaActivation(invite({ status: 'revoked' }), profile(status), NOW).action, 'none');
    const unknown = decideBetaActivation(invite({ status: 'expired' }), profile(status), NOW);
    assert.equal(unknown.action, 'none'); assert.equal(unknown.warn, true);
  }
});

// ─── The link write, against a synthetic client ─────────────────────────
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
          const row = rows[table][filters.find(f => f[0] === 'eq')[2]];
          if (row) Object.assign(row, patch);
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

test('a pending account with an invitation: no write at all, and it stays pending on every retry', async () => {
  const db = database();
  for (let i = 0; i < 3; i++) assert.deepEqual(await db.deliver(), { error: null });
  assert.deepEqual(db.writes, []);
  assert.equal(db.rows.profiles[PROFILE].access_status, 'pending');
  assert.deepEqual(db.rows.beta_access.invite, invite());
});

test('an active account: only the invitation is written, never the profile', async () => {
  const db = database({ profileStatus: 'active' });
  assert.deepEqual(await db.deliver(), { error: null });
  assert.deepEqual(db.writes.map(w => w.table), ['beta_access']);
  assert.equal(db.rows.beta_access.invite.profile_id, PROFILE);
  assert.equal(db.rows.beta_access.invite.status, 'active');
});

test('a failed link write is reported and the retry finishes it', async () => {
  const db = database({ profileStatus: 'active', failOnce: { beta_access: true } });
  assert.match((await db.deliver()).error, /update beta_access: synthetic beta_access failure/);
  assert.equal(db.rows.beta_access.invite.profile_id, null);
  assert.deepEqual(await db.deliver(), { error: null });
  assert.equal(db.rows.beta_access.invite.profile_id, PROFILE);
  assert.ok(db.writes.every(w => w.table === 'beta_access'));
});

test('a paused account is never written active', async () => {
  const db = database({ profileStatus: 'revoked' });
  assert.deepEqual(await db.deliver(), { error: null });
  assert.equal(db.rows.profiles[PROFILE].access_status, 'revoked');
  assert.ok(db.writes.every(w => w.table !== 'profiles'));
});

test('neither the webhook nor its helper can write profiles.access_status', async () => {
  const { readFile } = await import('node:fs/promises');
  const webhook = await readFile(new URL('../../supabase/functions/clerk-webhook/index.ts', import.meta.url), 'utf8');
  const body = webhook.slice(webhook.indexOf('async function linkBetaInvitation('), webhook.indexOf('serve(async'));
  assert.match(body, /decideBetaActivation\(match, profile, now\)/);
  assert.match(body, /decision\.action === "none"/);
  assert.match(body, /applyBetaDecision\(supabase, match, profile, decision, now\)/);
  assert.doesNotMatch(body, /\.update\(/);
  const helper = await readFile(new URL('../../supabase/functions/clerk-webhook/betaActivation.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /from\("profiles"\)/);
  assert.doesNotMatch(helper, /access_status: "active"/);
  // The invite-to-join ledger is not an access record anywhere in the webhook.
  assert.doesNotMatch(webhook + helper, /from\("invite_to_join|rpc\("[a-z_]*invite_to_join/);
});
