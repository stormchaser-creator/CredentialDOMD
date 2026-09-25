// Older Admin panels used to show a failed read as an empty list and a failed
// or RLS-refused delete as done. Runs the real panels with synthetic I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as adminWaitlist from '../../src/utils/adminWaitlist.js';
import * as adminLabels from '../../src/utils/adminLabels.js';

const source = await readFile(new URL('../../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');

function load(responses) {
  const hooks = []; let cursor = 0;
  const calls = [];
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; },
    useEffect() {},
  };
  const db = { from(table) {
    const call = { table, op: 'select', filters: [] };
    const q = {
      select(columns) { call.returning = columns; return q; }, delete() { call.op = 'delete'; return q; },
      update(patch) { call.op = 'update'; call.patch = patch; return q; }, insert(row) { call.op = 'insert'; call.row = row; return q; },
      eq(column, value) { call.filters.push([column, value]); return q; }, order() { return q; }, limit() { return q; },
      then(resolve) { calls.push(call); resolve(responses.shift() ?? { data: [], error: null }); },
    };
    return q;
  } };
  const imports = { react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }, '../../lib/supabase': { supabase: db },
    '../../utils/adminWaitlist': adminWaitlist, '../../utils/adminLabels': adminLabels };
  const module = { exports: {} };
  const ctx = vm.createContext({ module, exports: module.exports, require: n => imports[n] || {}, console, window: { confirm: () => true } });
  vm.runInContext(transformSync(source + '\nexport { MessagesPanel, WaitlistList, FieldProposals, SignupsList };', { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, ctx);
  const render = (component, props) => { cursor = 0; return module.exports[component](props); };
  return { render, calls };
}
const nodes = tree => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n && typeof n === 'object' && n.props) { out.push(n); visit(n.props.children); } }; visit(tree); return out; };
const text = tree => nodes(tree).map(n => [n.props.text, ...[].concat(n.props.children).filter(c => typeof c === 'string' || typeof c === 'number')].join(' ')).join(' ');
const T = {};

test('a failed reply-thread read says so instead of "No one has replied yet."', async () => {
  const f = load([{ data: null, error: { message: 'JWT expired' } }]);
  const broadcast = { id: 'm1', recipient_id: null, subject: 'Hello all', body: 'Synthetic', created_at: '2026-09-25T00:00:00Z', reply_count: 3 };
  const props = { messages: [broadcast], users: [], myProfileId: 'admin', repliesSince: null, T, onRefresh() {} };
  const row = nodes(f.render('MessagesPanel', props)).find(n => n.props.role === 'button' && n.props.onClick);
  await row.props.onClick();
  const html = text(f.render('MessagesPanel', props));
  assert.doesNotMatch(html, /No one has replied yet/);
  assert.match(html, /Could not load the replies/);
});

test('a direct thread read failure is shown too; a successful empty read still says no replies', async () => {
  const direct = { id: 'm2', recipient_id: 'p2', subject: 'One to one', body: 'Synthetic', created_at: '2026-09-25T00:00:00Z', reply_count: 1 };
  const failing = load([{ data: null, error: { message: 'offline' } }]);
  const props = { messages: [direct], users: [], myProfileId: 'admin', repliesSince: null, T, onRefresh() {} };
  await nodes(failing.render('MessagesPanel', props)).find(n => n.props.role === 'button').props.onClick();
  assert.match(text(failing.render('MessagesPanel', props)), /Could not load the replies/);
  const empty = load([{ data: [], error: null }]);
  const broadcast = { ...direct, recipient_id: null };
  await nodes(empty.render('MessagesPanel', { ...props, messages: [broadcast] })).find(n => n.props.role === 'button').props.onClick();
  assert.match(text(empty.render('MessagesPanel', { ...props, messages: [broadcast] })), /No one has replied yet/);
});

test('sending a message re-reads through the section loader instead of overwriting the list', async () => {
  let refreshed = 0;
  const f = load([{ error: null }]);
  const props = { messages: [], users: [], myProfileId: 'admin', repliesSince: null, T, onRefresh() { refreshed++; } };
  let tree = f.render('MessagesPanel', props);
  nodes(tree).find(n => n.type === 'button' && [].concat(n.props.children).join('') === '+ New message').props.onClick();
  tree = f.render('MessagesPanel', props);
  nodes(tree).find(n => n.type === 'textarea').props.onChange({ target: { value: 'Synthetic broadcast' } });
  tree = f.render('MessagesPanel', props);
  await nodes(tree).find(n => n.type === 'button' && [].concat(n.props.children).join('') === 'Send').props.onClick();
  assert.equal(refreshed, 1);
  assert.equal(f.calls[0].op, 'insert');
  assert.equal(f.calls.length, 1, 'no separate list read that could fail into an empty list');
});

const lead = { id: 'lead-1', email: 'waiting@example.invalid', waitlist: true, created_at: '2026-09-20T00:00:00Z' };
const attempt = { id: 'attempt-1', email: 'orphan@example.invalid', stage: 'normal' };
const waitlistProps = (rows, attempts) => ({ rows: rows.value, setRows: fn => { rows.value = fn(rows.value); }, attempts: attempts.value, setAttempts: fn => { attempts.value = fn(attempts.value); }, users: [], invites: [], T });

for (const [label, response] of [['RLS refusal (zero rows)', { data: [], error: null }], ['an error', { data: null, error: { message: 'permission denied' } }]]) {
  test(`a waitlist removal refused by ${label} keeps the row and says so`, async () => {
    const rows = { value: [lead] }, attempts = { value: [attempt] };
    const f = load([response, structuredClone(response)]);
    const tree = f.render('WaitlistList', waitlistProps(rows, attempts));
    await nodes(tree).find(n => n.type === 'button' && n.props.children === 'Remove').props.onClick();
    assert.deepEqual(rows.value, [lead]);
    assert.match(text(f.render('WaitlistList', waitlistProps(rows, attempts))), /Could not remove waiting@example\.invalid/);
    await nodes(f.render('WaitlistList', waitlistProps(rows, attempts))).find(n => n.type === 'button' && n.props.children === 'dismiss').props.onClick();
    assert.deepEqual(attempts.value, [attempt]);
    assert.match(text(f.render('WaitlistList', waitlistProps(rows, attempts))), /Could not dismiss orphan@example\.invalid/);
    assert.deepEqual(f.calls.map(c => [c.table, c.op, c.returning]), [['early_access_leads', 'delete', 'id'], ['waitlist_attempts', 'delete', 'id']]);
  });
}

test('a confirmed waitlist removal takes the row away', async () => {
  const rows = { value: [lead] }, attempts = { value: [attempt] };
  const f = load([{ data: [{ id: 'lead-1' }], error: null }, { data: [{ id: 'attempt-1' }], error: null }]);
  await nodes(f.render('WaitlistList', waitlistProps(rows, attempts))).find(n => n.type === 'button' && n.props.children === 'Remove').props.onClick();
  await nodes(f.render('WaitlistList', waitlistProps(rows, attempts))).find(n => n.type === 'button' && n.props.children === 'dismiss').props.onClick();
  assert.deepEqual(rows.value, []);
  assert.deepEqual(attempts.value, []);
});

test('a field proposal status changes only after the server confirms one row', async () => {
  const proposal = { id: 'f1', label: 'Badge number', section: 'licenses', sample: 'PX-1', status: 'pending', created_at: '2026-09-20T00:00:00Z' };
  const rows = { value: [proposal] };
  const props = () => ({ rows: rows.value, setRows: fn => { rows.value = fn(rows.value); }, T });
  const f = load([{ data: [], error: null }, { data: [{ id: 'f1' }], error: null }]);
  const approve = () => nodes(f.render('FieldProposals', props())).find(n => n.type === 'button' && n.props.children === 'Approve');
  await approve().props.onClick();
  assert.equal(rows.value[0].status, 'pending');
  assert.match(text(f.render('FieldProposals', props())), /Could not approve "Badge number"/);
  await approve().props.onClick();
  assert.equal(rows.value[0].status, 'approved');
  assert.equal(f.calls[0].returning, 'id');
});

test('the Traffic "New accounts" total states its 90-day window and how it differs from the Overview', () => {
  const f = load([]);
  const shown = text(f.render('SignupsList', { rows: [{ day: '2026-09-24T00:00:00Z', signups: 2 }, { day: '2026-09-23T00:00:00Z', signups: 1 }], T }));
  assert.match(shown, /Last 90 days \(rolling; server view limit\)/);
  assert.match(shown, /Includes deleted and closed accounts/);
  assert.match(shown, /New signup profiles/);
  assert.match(text(f.render('SignupsList', { rows: [], T })), /No new accounts in the last 90 days/);
});
