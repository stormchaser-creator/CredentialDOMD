// Older Admin panels used to show a failed read as an empty list and a failed
// or RLS-refused delete as done. Runs the real panels with synthetic I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as adminData from '../../src/utils/adminData.js';
import * as setupTasks from '../../src/utils/setupTasks.js';

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
    '../../utils/adminData': adminData,
    '../../utils/setupTasks': setupTasks };
  const module = { exports: {} };
  const ctx = vm.createContext({ module, exports: module.exports, require: n => imports[n] || {}, console, window: { confirm: () => true } });
  vm.runInContext(transformSync(source + '\nexport { MessagesPanel, FieldProposals, SignupsList, TicketsList, UsersPanel };', { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, ctx);
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

test('the Activity "New accounts" total states its 90-day window and how it differs from Home', () => {
  const f = load([]);
  const tree = f.render('SignupsList', { rows: [{ day: '2026-09-24T00:00:00Z', signups: 2 }, { day: '2026-09-23T00:00:00Z', signups: 1 }], T });
  const shown = text(tree);
  // The window label sits right above the total (the lab reads the number after it);
  // one line under it; the full wording behind Details.
  assert.match(shown, /Last 90 days \(rolling; server view limit\)\s*3\b/);
  assert.match(shown, /Including closed accounts\. Home's "New signups" can differ\./);
  const details = text(nodes(tree).find(n => n.type === 'details'));
  assert.match(details, /excluding administrators/);
  assert.match(details, /Includes deleted and closed accounts/);
  assert.match(details, /"New signups" on Home leaves those out/);
  assert.match(text(f.render('SignupsList', { rows: [], T })), /No new accounts in the last 90 days/);
});

test('ticket and account filters are 16px so iPhone Safari does not zoom the page on focus', () => {
  const f = load([]);
  for (const [component, props] of [['TicketsList', { rows: [], T, onOpen() {} }], ['UsersPanel', { users: [], setUsers() {}, invites: [], T, onRefresh() {} }]]) {
    const controls = nodes(f.render(component, props)).filter(n => ['select', 'textarea'].includes(n.type) || (n.type === 'input' && n.props.type === 'search'));
    assert.ok(controls.length >= 2, component);
    for (const control of controls) assert.ok(control.props.style?.fontSize >= 16, `${component} ${control.type} ${control.props.placeholder || ''}`);
  }
});
