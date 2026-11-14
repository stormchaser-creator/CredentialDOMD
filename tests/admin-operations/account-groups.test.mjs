// Admin > Accounts sorting: paying, free access, signed in without paying,
// closed. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountGroup, groupAdminAccounts, accountMembershipNote, isFoundingAccount, readAccountMemberships } from '../../src/utils/adminData.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const facts = (over = {}) => ({ paid_active: false, paid_status: null, paid_through: null, cancel_at_period_end: false, founding: false, lifetime: false, beta_until: null, checkout_expired: false, guide_requests: 0, ...over });

test('a paid membership is paying, even with a guide request', () => {
  assert.equal(accountGroup({ id: 'a' }, facts({ paid_active: true, guide_requests: 1 }), NOW), 'paying');
});

test('lifetime and an unexpired beta grant are free access; an ended beta is not', () => {
  assert.equal(accountGroup({ id: 'a' }, facts({ lifetime: true }), NOW), 'free');
  assert.equal(accountGroup({ id: 'a' }, facts({ beta_until: '2026-12-01T00:00:00Z' }), NOW), 'free');
  assert.equal(accountGroup({ id: 'a' }, facts({ beta_until: '2026-10-23T00:00:00Z' }), NOW), 'unpaid');
});

test('signed in with nothing paid is unpaid; a deleted account is closed whatever it paid', () => {
  assert.equal(accountGroup({ id: 'a', access_status: 'active' }, facts(), NOW), 'unpaid');
  assert.equal(accountGroup({ id: 'a', deleted_at: '2026-11-01T00:00:00Z' }, facts({ paid_active: true }), NOW), 'closed');
});

test('groupAdminAccounts places every row exactly once', () => {
  const rows = [{ id: 'p' }, { id: 'f' }, { id: 'u' }, { id: 'missing' }];
  const map = new Map([['p', facts({ paid_active: true })], ['f', facts({ lifetime: true })], ['u', facts()]]);
  const g = groupAdminAccounts(rows, map, NOW);
  assert.deepEqual(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map(r => r.id)])),
    { paying: ['p'], free: ['f'], unpaid: ['u', 'missing'], closed: [] });
});

test('founding: a paid founding place, the flag, or a pre-launch number', () => {
  assert.equal(isFoundingAccount({}, facts({ founding: true })), true);
  assert.equal(isFoundingAccount({ is_founding_member: true }, null), true);
  assert.equal(isFoundingAccount({ founding_number: 3 }, null), true);
  assert.equal(isFoundingAccount({ founding_number: null, is_founding_member: false }, facts()), false);
});

test('notes say what is on record in plain words', () => {
  assert.match(accountMembershipNote({}, facts({ paid_active: true, paid_through: '2027-10-01T00:00:00Z' }), NOW), /^Paid, renews /);
  assert.match(accountMembershipNote({}, facts({ paid_active: true, paid_through: '2027-10-01T00:00:00Z', cancel_at_period_end: true }), NOW), /^Paid, ends /);
  assert.equal(accountMembershipNote({}, facts(), NOW), 'No payment on record');
  assert.equal(accountMembershipNote({}, facts({ checkout_expired: true }), NOW), 'started checkout, did not finish');
  assert.match(accountMembershipNote({}, facts({ beta_until: '2026-10-23T00:00:00Z' }), NOW), /^Beta access ended /);
  assert.match(accountMembershipNote({}, facts({ guide_requests: 1 }), NOW), /also requested a state guide$/);
  assert.equal(accountMembershipNote({}, undefined, NOW), '');
  assert.ok(!/—/.test(accountMembershipNote({}, facts({ paid_active: true, guide_requests: 2 }), NOW)));
});

test('readAccountMemberships keeps "not deployed" and "failed" apart from an empty answer', async () => {
  const client = answer => ({ rpc: async () => answer });
  assert.equal(await readAccountMemberships(client({ data: null, error: { code: 'PGRST202' } })), null);
  assert.deepEqual(await readAccountMemberships(client({ data: null, error: { code: '42501', message: 'Administrator access required' } })), { error: 'Administrator access required' });
  assert.ok((await readAccountMemberships(client({ data: {}, error: null }))).error);
  const map = await readAccountMemberships(client({ data: [{ profile_id: 'x', paid_active: true }], error: null }));
  assert.equal(map.get('x').paid_active, true);
});
