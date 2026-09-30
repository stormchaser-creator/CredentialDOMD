// INTAKE-004: an administrator's Home banner, badge and Requests inbox must
// list only the administrator's own document requests. RLS does not scope
// them: document_requests_admin_select lets an administrator read every
// member's rows, so the reads themselves filter on the caller's profile id.
// The fake client below answers like that admin policy (every row visible)
// and applies whatever filters the code asks for. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import { mountComponent, settle } from './component-harness.mjs';

const OWN = '10000000-0000-4000-8000-0000000000a1';
const OTHER = '10000000-0000-4000-8000-0000000000b2';
const ROWS = [
  { id: 'req-own', user_id: OWN, status: 'new', from_addr: 'office@example.invalid', from_name: 'Example Credentialing Office', subject: 'License copy', received_at: '2026-09-29T10:00:00Z' },
  { id: 'req-other', user_id: OTHER, status: 'new', from_addr: 'desk@example.invalid', from_name: 'Other Member Office', subject: 'Board certificate', received_at: '2026-09-29T11:00:00Z' },
  { id: 'req-other-2', user_id: OTHER, status: 'replied', from_addr: 'desk@example.invalid', from_name: 'Other Member Office', subject: 'DEA', received_at: '2026-09-28T11:00:00Z' },
];

/** A PostgREST-shaped query builder over ROWS with the admin's view (no RLS narrowing). */
function adminClient() {
  const reads = [];
  const from = (table) => {
    const filters = [];
    let head = false;
    const builder = {
      select(_cols, opts) { head = !!opts?.head; return builder; },
      eq(col, val) { filters.push([col, val]); return builder; },
      order() { return builder; },
      then(resolve, reject) {
        reads.push({ table, filters: [...filters] });
        const data = ROWS.filter(r => filters.every(([c, v]) => r[c] === v));
        return Promise.resolve(head ? { count: data.length, error: null } : { data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  };
  return { client: { from }, reads };
}

async function loadHookModule(client) {
  const source = await readFile(new URL('../src/hooks/useNewRequestCount.js', import.meta.url), 'utf8');
  const code = transformSync(source, { format: 'cjs' }).code;
  const cells = []; const effects = [];
  let index = 0;
  const react = {
    useRef(v) { const at = index++; cells[at] ??= { current: v }; return cells[at]; },
    useState(v) { const at = index++; if (!(at in cells)) cells[at] = v; return [cells[at], n => { cells[at] = typeof n === 'function' ? n(cells[at]) : n; }]; },
    useCallback: fn => fn, useMemo: fn => fn(), useEffect: fn => effects.push(fn),
  };
  const imports = {
    react,
    '../lib/supabase': { supabase: client },
    '../components/features/EmailPacketModal': { REQUEST_REPLIED_EVENT: 'synthetic-replied' },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: n => imports[n], window: { addEventListener() {}, removeEventListener() {} } });
  const render = (...args) => { index = 0; effects.length = 0; const out = module.exports.useOpenRequests(...args); effects.splice(0).forEach(fn => fn()); return out; };
  return { mod: module.exports, render };
}

test('the open-request read and the badge count ask for the caller\'s own rows only', async () => {
  const { client, reads } = adminClient();
  const { mod } = await loadHookModule(client);
  const rows = await mod.fetchOpenRequests(OWN);
  assert.deepEqual([...rows.map(r => r.id)], ['req-own']);
  assert.deepEqual(JSON.parse(JSON.stringify(reads.at(-1).filters)), [['user_id', OWN], ['status', 'new']]);
  assert.equal(await mod.fetchNewRequestCount(OWN), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(reads.at(-1).filters)), [['user_id', OWN], ['status', 'new']]);
});

test('without a loaded profile id nothing is read, so no other member\'s row can appear', async () => {
  const { client, reads } = adminClient();
  const { mod } = await loadHookModule(client);
  assert.equal(await mod.fetchOpenRequests(null), null);
  assert.equal(await mod.fetchNewRequestCount(undefined), null);
  assert.equal(reads.length, 0);
});

test('useOpenRequests: Home banner rows are the owner\'s own, and none before the account loads', async () => {
  const { client, reads } = adminClient();
  const { render } = await loadHookModule(client);
  const ref = { current: null };
  assert.equal(render(ref, false).rows.length, 0);
  await settle();
  assert.equal(reads.length, 0);
  ref.current = OWN;
  render(ref, true);
  await settle();
  const out = render(ref, true);
  assert.deepEqual([...out.rows.map(r => r.id)], ['req-own']);
  assert.equal(out.count, 1);
  assert.ok(reads.every(r => r.filters.some(([c, v]) => c === 'user_id' && v === OWN)));
});

test('Requests inbox lists only the owner\'s own requests although the admin policy returns every member\'s', async () => {
  const { client, reads } = adminClient();
  const T = new Proxy({}, { get: () => '#123456' });
  const app = { data: { settings: {} }, loaded: true, user: { email: 'owner@example.invalid' }, theme: T, navigate() {}, userIdRef: { current: OWN }, isDesktop: true, addItem() {}, editItem() {}, deleteItem() {} };
  const view = await mountComponent('src/components/features/RequestsInbox.jsx', {
    app,
    modules: {
      supabase: { supabase: client },
      useRequestProposals: { useRequestProposals: rows => rows },
      useIntakeNotes: { useIntakeNotes: () => ({ notes: [], replace() {} }) },
      useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
      forwardingAddresses: { forwardingSenders: () => [], routableSenders: () => [], joinAddresses: () => '', accountMailboxVerified: () => false, CONFIRM_FIRST_SENTENCE: '' },
    },
    globals: { window: { addEventListener() {}, removeEventListener() {}, navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true } },
  });
  view.render();
  await settle();
  const page = view.pageText();
  assert.match(page, /Example Credentialing Office|License copy|office@example\.invalid/);
  assert.doesNotMatch(page, /Other Member Office|Board certificate|desk@example\.invalid/);
  const inboxRead = reads.find(r => r.table === 'document_requests');
  assert.ok(inboxRead, 'the inbox read document_requests');
  assert.deepEqual(inboxRead.filters, [['user_id', OWN]]);
});

test('INTAKE-004: a forward of the physician\'s own message reads "Requester not found" in the inbox, never their name', async () => {
  const selfRow = { id: 'req-self', user_id: OWN, status: 'new', from_addr: 'owner@example.invalid', from_name: 'Harper Example', forwarded_by: 'owner@example.invalid', subject: 'BLS card', received_at: '2026-09-29T12:00:00Z' };
  const client = { from: () => { const b = { select: () => b, eq: () => b, order: () => b, then: (res) => Promise.resolve({ data: [selfRow], error: null }).then(res) }; return b; } };
  const T = new Proxy({}, { get: () => '#123456' });
  const packet = await import('../src/components/features/RequestPacket.js');
  const app = { data: { settings: {} }, loaded: true, user: { email: 'owner@example.invalid' }, theme: T, navigate() {}, userIdRef: { current: OWN }, isDesktop: true, addItem() {}, editItem() {}, deleteItem() {} };
  const view = await mountComponent('src/components/features/RequestsInbox.jsx', {
    app,
    modules: {
      supabase: { supabase: client },
      RequestPacket: { requesterMissing: packet.requesterMissing, requesterName: packet.requesterName },
      useRequestProposals: { useRequestProposals: rows => rows },
      useIntakeNotes: { useIntakeNotes: () => ({ notes: [], replace() {} }) },
      useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
      forwardingAddresses: { forwardingSenders: () => ['owner@example.invalid'], routableSenders: () => [], joinAddresses: () => '', accountMailboxVerified: () => false, CONFIRM_FIRST_SENTENCE: '' },
    },
    globals: { window: { addEventListener() {}, removeEventListener() {}, navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true } },
  });
  view.render();
  await settle();
  const list = view.pageText();
  assert.match(list, /Requester not found/);
  assert.doesNotMatch(list, /Harper Example/);
});
