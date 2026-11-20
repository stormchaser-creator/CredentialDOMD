// Admin > Home: the payments and Founder spots summary (owner, 2026-11-20).
// Member counts come from the profiles list and membership facts People >
// Accounts already reads, counted the same way; Founder spots left comes from
// the public offer the homepage reads. Anything unreadable shows "—" and never
// breaks Home. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as adminData from '../../src/utils/adminData.js';
import * as summary from '../../src/utils/adminMembershipSummary.js';
import * as reportHelpers from '../../src/utils/adminOperationsReport.js';
import * as adminButton from '../../src/components/shared/adminButton.js';

const { summarizeMembers, founderSpotsFromOffer, loadFounderSpotsLeft } = summary;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const facts = (over = {}) => ({ paid_active: false, paid_status: null, founding: false, lifetime: false, beta_until: null, checkout_expired: false, guide_requests: 0, ...over });
const person = (id, over = {}) => ({ id, email: `${id}@example.invalid`, access_status: 'active', ...over });

// Two paying (one a paid founder), a lifetime gift, an unexpired beta, an
// ended beta, a pre-launch founder who never paid, someone with no facts at
// all, a closed founder, and an empty account record.
const USERS = [
  person('paid-founder'), person('paid'), person('lifetime'), person('beta'), person('beta-ended'),
  person('prelaunch', { founding_number: 7 }), person('no-facts'),
  person('closed', { deleted_at: '2026-11-01T00:00:00Z', founding_number: 2 }),
  { id: 'empty', email: null, name: null, npi: null, last_seen_at: null, access_status: 'pending' },
];
const MEMBERSHIPS = new Map([
  ['paid-founder', facts({ paid_active: true, founding: true })],
  ['paid', facts({ paid_active: true })],
  ['lifetime', facts({ lifetime: true })],
  ['beta', facts({ beta_until: '2026-12-31T00:00:00Z' })],
  ['beta-ended', facts({ beta_until: '2026-10-01T00:00:00Z' })],
  ['prelaunch', facts()],
  ['closed', facts({ paid_active: true })],
]);

test('members are counted as People > Accounts groups them', () => {
  assert.deepEqual(summarizeMembers(USERS, MEMBERSHIPS, NOW), { paying: 2, founding: 2, free: 2, unpaid: 3 });
});

test('the counts match the Accounts groups and founding count computed directly', () => {
  const groups = adminData.groupAdminAccounts(adminData.filterAdminUsers(USERS), MEMBERSHIPS, NOW);
  const founding = USERS.filter(u => !u.deleted_at && adminData.isFoundingAccount(u, MEMBERSHIPS.get(u.id))).length;
  assert.deepEqual(summarizeMembers(USERS, MEMBERSHIPS, NOW), { paying: groups.paying.length, founding, free: groups.free.length, unpaid: groups.unpaid.length });
});

test('a closed account and an empty account record are in no group; a closed founder is not a founding member', () => {
  const only = summarizeMembers([USERS[7], USERS[8]], MEMBERSHIPS, NOW);
  assert.deepEqual(only, { paying: 0, founding: 0, free: 0, unpaid: 0 });
});

test('no membership facts (not deployed, failed, or not a list) is unavailable, never zero', () => {
  assert.equal(summarizeMembers(USERS, null, NOW), null);
  assert.equal(summarizeMembers(USERS, { error: 'permission denied' }, NOW), null);
  assert.equal(summarizeMembers(null, MEMBERSHIPS, NOW), null);
  assert.deepEqual(summarizeMembers([], new Map(), NOW), { paying: 0, founding: 0, free: 0, unpaid: 0 });
});

// The public offer, through the homepage's own module.
const importer = () => import('../../public/membership-offer.js');
const reply = body => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const base = { origin: 'https://credentialdomd.com', supabaseUrl: 'https://hkpnnsjcwprrwobmpqyy.supabase.co', importer };
const founding = { schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available' };

test('Founder spots left is the number the public offer sends while founding is open', async () => {
  assert.equal(await loadFounderSpotsLeft({ ...base, fetchImpl: reply({ ...founding, founderSpotsLeft: 97 }) }), 97);
  assert.equal(await loadFounderSpotsLeft({ ...base, fetchImpl: reply({ ...founding, founderSpotsLeft: 1 }) }), 1);
});

test('Founder spots left is unavailable when the field is absent, founding is full or over, or the reply is refused', async () => {
  assert.equal(await loadFounderSpotsLeft({ ...base, fetchImpl: reply(founding) }), null);
  assert.equal(await loadFounderSpotsLeft({ ...base, fetchImpl: reply({ ...founding, founderSpotsLeft: 0 }) }), null);
  assert.equal(await loadFounderSpotsLeft({ ...base, fetchImpl: reply({ ...founding, founderSpotsLeft: 'many' }) }), null);
  assert.equal(await loadFounderSpotsLeft({ ...base, fetchImpl: reply({ ...founding, availability: 'temporarily_full', founderSpotsLeft: 3 }) }), null);
  assert.equal(await loadFounderSpotsLeft({ ...base, fetchImpl: reply({ ...founding, phase: 'earlybird', annualCents: 14900, founderSpotsLeft: 3 }) }), null);
  assert.equal(await loadFounderSpotsLeft({ ...base, fetchImpl: reply({ ...founding, annualCents: 100, founderSpotsLeft: 3 }) }), null);
});

test('a failed offer call resolves to null, never throws', async () => {
  assert.equal(await loadFounderSpotsLeft({ ...base, fetchImpl: async () => { throw Error('network'); } }), null);
  assert.equal(await loadFounderSpotsLeft({ ...base, fetchImpl: async () => new Response('nope', { status: 500 }) }), null);
  assert.equal(await loadFounderSpotsLeft({ ...base, supabaseUrl: undefined, fetchImpl: reply(founding) }), null);
  assert.equal(await loadFounderSpotsLeft({ ...base, importer: async () => { throw Error('module missing'); } }), null);
  assert.equal(founderSpotsFromOffer(null), null);
  assert.equal(founderSpotsFromOffer({ phaseKey: 'founding', spots: '' }), null);
});

// The card itself, executed with synthetic hooks and I/O.
const source = await readFile(new URL('../../src/components/pages/AdminHomeSummary.jsx', import.meta.url), 'utf8');
const tick = () => new Promise(done => setImmediate(done));
function card({ users = USERS, memberships = MEMBERSHIPS, spots = async () => 97, listError = null, membershipError = null } = {}) {
  const hooks = [], effects = [], navigation = [];
  let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useEffect(effect, deps) { const i = cursor++; if (!hooks[i] || !same(hooks[i].deps, deps)) { const old = hooks[i]; hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = effect(); }); } },
  };
  const db = {
    rpc: async () => membershipError ? { data: null, error: { code: '42501', message: membershipError } } : { data: [...memberships].map(([profile_id, f]) => ({ profile_id, ...f })), error: null },
    from() { const q = { select: () => q, order: () => q, range: async () => listError ? { data: null, error: { message: listError } } : { data: users, count: users.length } }; return q; },
  };
  const imports = { react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) },
    '../../lib/supabase': { supabase: db }, '../../utils/adminData': adminData, '../../utils/adminMembershipSummary': summary,
    '../../utils/adminOperationsReport': reportHelpers, '../shared/adminButton': adminButton };
  const module = { exports: {} };
  vm.runInContext(transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, vm.createContext({ module, exports: module.exports, require: name => imports[name], console, Map, Promise }));
  const props = { T: {}, onNavigate: (tab, filters) => navigation.push([tab, filters]), loadSpots: spots };
  const render = async () => {
    for (let round = 0; round < 4; round++) { cursor = 0; module.exports.default(props); if (!effects.length) break; effects.splice(0).forEach(run => run()); await tick(); await tick(); }
    cursor = 0; return module.exports.default(props);
  };
  const text = node => { if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return node?.props ? text(node.props.children) : ''; };
  const nodes = tree => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n?.props) { out.push(n); visit(n.props.children); } }; visit(tree); return out; };
  return { render, text, nodes, navigation };
}
const tiles = (f, tree) => Object.fromEntries(f.nodes(tree).filter(n => n.props.title && (n.type === 'button' || n.type === 'div')).map(n => { const [value, label] = [].concat(n.props.children).flatMap(c => c?.props?.children ?? []).map(f.text); return [label, value]; }));

test('the card shows Founder spots left and each member count, and a count opens People', async () => {
  const f = card();
  const tree = await f.render();
  assert.deepEqual(tiles(f, tree), { 'Founder spots left': '97', 'Paying members': '2', 'Founding members': '2', 'Free or gifted': '2', 'Unpaid accounts': '3' });
  f.nodes(tree).find(n => n.type === 'button' && f.text(n).endsWith('Paying members')).props.onClick();
  assert.deepEqual(f.navigation, [['users', undefined]]);
  assert.doesNotMatch(f.text(tree), /\$\d|revenue of|refund(ed|s) \d/i, 'no dollar amounts');
});

test('a failed or empty offer shows "—" for spots and keeps the member counts', async () => {
  for (const spots of [async () => null, async () => { throw Error('offline'); }, () => undefined]) {
    const f = card({ spots });
    const shown = tiles(f, await f.render());
    assert.equal(shown['Founder spots left'], '—');
    assert.equal(shown['Paying members'], '2');
  }
});

test('failed membership facts or a failed account list show "—" for every member count and say so', async () => {
  for (const options of [{ membershipError: 'permission denied' }, { listError: 'timeout' }]) {
    const f = card(options);
    const tree = await f.render();
    const shown = tiles(f, tree);
    assert.equal(shown['Founder spots left'], '97');
    for (const label of ['Paying members', 'Founding members', 'Free or gifted', 'Unpaid accounts']) assert.equal(shown[label], '—', label);
    assert.match(f.text(tree), /Payment details could not be loaded/);
  }
});
