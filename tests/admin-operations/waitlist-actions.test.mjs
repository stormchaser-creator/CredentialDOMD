// QA ADMIN-003: the Waitlist and Fields actions in the real Admin screen.
//   * Adding or removing a lead, or approving or dismissing a field, left the
//     tab label on its old count ("Waitlist (3)") until another tab was
//     opened, although the list itself had changed.
//   * Add failed silently: a duplicate address (unique on lower(email)) or a
//     malformed one (CHECK lead_email_shape) left the fields filled and said
//     nothing.
// Executes AdminDashboard.jsx with synthetic hooks and a synthetic database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as adminData from '../../src/utils/adminData.js';
import * as adminTicketDraft from '../../src/utils/adminTicketDraft.js';
import * as adminWaitlist from '../../src/utils/adminWaitlist.js';
import * as adminLabels from '../../src/utils/adminLabels.js';
import * as adminButton from '../../src/components/shared/adminButton.js';

const source = await readFile(new URL('../../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');
const tick = () => new Promise(done => setImmediate(done));
const nodes = tree => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n && typeof n === 'object' && n.props) { out.push(n); visit(n.props.children); } }; visit(tree); return out; };
const text = n => (Array.isArray(n) ? n : [n]).map(c => typeof c === 'string' || typeof c === 'number' ? String(c) : c?.props ? text(c.props.children) : '').join('');

function load(db) {
  const hooks = [], effects = [];
  let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++; if (!hooks[i] || !deps || !same(hooks[i].deps, deps)) { const old = hooks[i]; hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = effect(); }); } },
  };
  const app = { theme: {}, user: { id: 'synthetic-owner' }, data: { settings: {} }, userIdRef: { current: 'owner' }, updateSettings() {} };
  const imports = { react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) },
    '../../context/AppContext': { useApp: () => app }, '../../lib/supabase': { supabase: db }, '../../lib/admin': { useIsAdmin: () => true },
    '../../utils/adminData': adminData, '../../utils/adminTicketDraft': adminTicketDraft,
    '../../utils/adminWaitlist': adminWaitlist, '../../utils/adminLabels': adminLabels, '../shared/adminButton': adminButton };
  const module = { exports: {} };
  const ctx = vm.createContext({ module, exports: module.exports, require: name => imports[name] || {}, console, setTimeout: () => 0,
    window: { confirm: () => true }, navigator: { clipboard: { writeText() {} } } });
  vm.runInContext(transformSync(source + '\nexport {AdminDashboardContent, WaitlistList, FieldProposals};', { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, ctx);
  // Renders one component; its effects run, and it renders again, until quiet.
  const mount = (Component, props) => async () => {
    for (let round = 0; round < 6; round++) { cursor = 0; Component(props()); if (!effects.length) break; effects.splice(0).forEach(run => run()); await tick(); }
    cursor = 0; return Component(props());
  };
  return { exports: module.exports, mount };
}

// ─── The tab labels follow the actions ───────────────────────────────────
function dashboardDb(counts) {
  const rpcs = [];
  return {
    rpcs,
    async rpc(name) { rpcs.push(name); return { data: { ...counts } }; },
    from() { const q = { select: () => q, order: () => q, is: () => q, not: () => q, eq: () => q, range: async () => ({ data: [], count: 0 }) }; return q; },
  };
}

test('adding or removing a lead, or settling a field, re-reads the tab counts', async () => {
  const counts = { unread_replies: 0, new_errors_since_seen: 0, waitlist_waiting: 3, fields_pending: 2 };
  const db = dashboardDb(counts);
  const { exports, mount } = load(db);
  const render = mount(exports.AdminDashboardContent, () => ({}));
  const tabLabel = (tree, pattern) => nodes(tree).filter(n => n.type === 'button').map(n => text(n.props.children)).find(t => pattern.test(t));
  let tree = await render();
  assert.equal(tabLabel(tree, /^Waitlist/), 'Waitlist (3)');
  nodes(tree).find(n => n.type === 'button' && text(n.props.children) === 'Waitlist (3)').props.onClick();
  tree = await render();
  const list = nodes(tree).find(n => n.type === exports.WaitlistList);
  assert.ok(list, 'the Waitlist tab renders its list');
  assert.equal(typeof list.props.onChanged, 'function', 'the list can tell the dashboard its counts changed');
  const reads = db.rpcs.length;
  counts.waitlist_waiting = 4;
  list.props.onChanged();
  tree = await render();
  assert.equal(db.rpcs.length, reads + 1, 'one count read, not a section reload');
  assert.equal(tabLabel(tree, /^Waitlist/), 'Waitlist (4)');

  nodes(tree).find(n => n.type === 'button' && /^Fields/.test(text(n.props.children))).props.onClick();
  tree = await render();
  const fields = nodes(tree).find(n => n.type === exports.FieldProposals);
  assert.equal(typeof fields.props.onChanged, 'function');
  counts.fields_pending = 1;
  fields.props.onChanged();
  tree = await render();
  assert.equal(tabLabel(tree, /^Fields/), 'Fields (1 pending)');
});

// ─── The Waitlist list's own actions ──────────────────────────────────────
function listDb({ insert = null, remove = null, update = null } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      let op = null, row = null;
      const q = {
        insert(value) { op = 'insert'; row = value; return q; },
        delete() { op = 'delete'; return q; },
        update(value) { op = 'update'; row = value; return q; },
        eq() { return q; },
        select() { return q; },
        async single() { writes.push({ table, op, row }); return insert || { data: { id: 'new-lead', created_at: '2026-09-29T12:00:00Z', ...row }, error: null }; },
        then(resolve) { writes.push({ table, op, row }); resolve((op === 'delete' ? remove : update) || { data: [{ id: 'x' }], error: null }); },
      };
      return q;
    },
  };
}

function waitlist(db, extra = {}) {
  const { exports, mount } = load(db);
  let rows = [{ id: 'lead-1', name: 'Synthetic Lead', email: 'lead@example.test', waitlist: true, created_at: '2026-09-20T00:00:00Z' }];
  let changed = 0;
  const props = () => ({ rows, setRows: v => { rows = typeof v === 'function' ? v(rows) : v; }, attempts: [], setAttempts() {}, users: [], invites: [], T: {}, onChanged: () => changed++, ...extra });
  const render = mount(exports.WaitlistList, props);
  const inputs = tree => nodes(tree).filter(n => n.type === 'input');
  const status = tree => text(nodes(tree).find(n => n.props.role === 'status').props.children);
  return { render, inputs, status, get rows() { return rows; }, get changed() { return changed; } };
}

async function typeAndAdd(w, name, email) {
  let tree = await w.render();
  const [nameInput, emailInput] = w.inputs(tree);
  nameInput.props.onChange({ target: { value: name } });
  emailInput.props.onChange({ target: { value: email } });
  tree = await w.render();
  await nodes(tree).find(n => n.type === 'button' && text(n.props.children) === 'Add').props.onClick();
  return w.render();
}

test('Add: a new lead joins the list, the fields clear and the counts are re-read', async () => {
  const w = waitlist(listDb());
  const tree = await typeAndAdd(w, 'New Physician', 'new@example.test');
  assert.equal(w.rows.length, 2);
  assert.equal(w.changed, 1);
  assert.deepEqual(w.inputs(tree).map(i => i.props.value), ['', '']);
});

test('Add: an address already on the list says so and keeps what was typed', async () => {
  const w = waitlist(listDb({ insert: { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "early_access_leads_email_key"' } } }));
  const tree = await typeAndAdd(w, 'Synthetic Lead', 'LEAD@example.test');
  assert.match(w.status(tree), /^Could not add LEAD@example\.test: that address is already on the list/);
  assert.equal(w.rows.length, 1);
  assert.equal(w.changed, 0);
  assert.deepEqual(w.inputs(tree).map(i => i.props.value), ['Synthetic Lead', 'LEAD@example.test']);
});

test('Add: a malformed address or any other refusal is reported, never silent', async () => {
  const shape = waitlist(listDb({ insert: { data: null, error: { code: '23514', message: 'new row violates check constraint "lead_email_shape"' } } }));
  assert.match(shape.status(await typeAndAdd(shape, 'Synthetic', 'not-an-email')), /^Could not add not-an-email: the email address or name is not valid\.$/);
  const other = waitlist(listDb({ insert: { data: null, error: { code: '42501', message: 'permission denied for table early_access_leads' } } }));
  assert.match(other.status(await typeAndAdd(other, 'Synthetic', 'x@example.test')), /^Could not add x@example\.test: permission denied for table early_access_leads\.$/);
  const silent = waitlist(listDb({ insert: { data: null, error: null } }));
  assert.match(silent.status(await typeAndAdd(silent, 'Synthetic', 'y@example.test')), /^Could not add y@example\.test: the server did not confirm it\.$/);
});

test('Remove: a confirmed removal re-reads the counts; a refused one does not', async () => {
  const w = waitlist(listDb());
  let tree = await w.render();
  await nodes(tree).find(n => n.type === 'button' && text(n.props.children) === 'Remove').props.onClick();
  tree = await w.render();
  assert.equal(w.rows.length, 0);
  assert.equal(w.changed, 1);
  const refused = waitlist(listDb({ remove: { data: [], error: null } }));
  tree = await refused.render();
  await nodes(tree).find(n => n.type === 'button' && text(n.props.children) === 'Remove').props.onClick();
  assert.equal(refused.changed, 0);
});

test('Fields: approving or dismissing re-reads the counts only once the server confirms', async () => {
  for (const [update, expected] of [[null, 1], [{ data: [], error: null }, 0]]) {
    const { exports, mount } = load(listDb({ update }));
    let rows = [{ id: 'f1', label: 'Synthetic field', section: 'licenses', sample: 'x', status: 'pending', created_at: '2026-09-20T00:00:00Z' }];
    let changed = 0;
    const render = mount(exports.FieldProposals, () => ({ rows, setRows: v => { rows = typeof v === 'function' ? v(rows) : v; }, T: {}, onChanged: () => changed++ }));
    const tree = await render();
    await nodes(tree).find(n => n.type === 'button' && text(n.props.children) === 'Dismiss').props.onClick();
    assert.equal(changed, expected);
  }
});
