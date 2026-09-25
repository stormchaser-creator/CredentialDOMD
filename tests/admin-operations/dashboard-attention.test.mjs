// The Admin tab labels regained their counts without loading any list, and
// Overview cards stopped leaving their filters on for later tab clicks.
// Executes the real AdminDashboardContent with synthetic I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as adminData from '../../src/utils/adminData.js';
import * as adminTicketDraft from '../../src/utils/adminTicketDraft.js';

const source = await readFile(new URL('../../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');
const tick = () => new Promise(done => setImmediate(done));
const anchor = '    { id: "preview", label: "Preview as" },\n  ];\n';
assert.ok(source.includes(anchor), 'TABS anchor moved');

function fixture({ counts = { unread_replies: 2, new_errors_since_seen: 3, waitlist_waiting: 7, fields_pending: 1 }, response = null, full = false } = {}) {
  const hooks = [], effects = [], rpcs = [], settingsWrites = [];
  let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++; if (!hooks[i] || !deps || !same(hooks[i].deps, deps)) { const old = hooks[i]; hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = effect(); }); } },
  };
  const app = { theme: {}, user: { id: 'synthetic-owner' }, data: { settings: {} }, userIdRef: { current: 'owner' },
    updateSettings(patch) { settingsWrites.push(patch); app.data = { ...app.data, settings: { ...app.data.settings, ...patch } }; } };
  const db = {
    async rpc(name, args) { rpcs.push({ name, args }); return response || { data: counts }; },
    from() { const q = { select: () => q, order: () => q, is: () => q, not: () => q, range: async () => ({ data: [], count: 0 }) }; return q; },
  };
  const imports = { react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) },
    '../../context/AppContext': { useApp: () => app }, '../../lib/supabase': { supabase: db }, '../../lib/admin': { useIsAdmin: () => true },
    '../../utils/adminData': adminData, '../../utils/adminTicketDraft': adminTicketDraft };
  const injected = (full ? source : source.replace(anchor, anchor + '  globalThis.current = { TABS, selectTab, navigateReport, tab, ticketPreset, accountPreset, showArchived, setShowArchived, repliesSince }; return null;\n')) + '\nexport {AdminDashboardContent};';
  const module = { exports: {} };
  const ctx = vm.createContext({ module, exports: module.exports, require: name => imports[name] || {}, console, setTimeout: () => 0 });
  vm.runInContext(transformSync(injected, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, ctx);
  const render = async () => {
    for (let round = 0; round < 4; round++) { cursor = 0; module.exports.AdminDashboardContent(); if (!effects.length) break; effects.splice(0).forEach(run => run()); await tick(); }
    cursor = 0; const tree = module.exports.AdminDashboardContent(); return full ? tree : ctx.current;
  };
  return { render, rpcs, settingsWrites, app };
}
const label = (view, id) => view.TABS.find(t => t.id === id).label;

test('tab labels show unread replies, new errors, waiting leads and pending fields on first load', async () => {
  const f = fixture();
  const view = await f.render();
  assert.equal(label(view, 'messages'), 'Messages (2)');
  assert.equal(label(view, 'errors'), 'Errors (3)');
  assert.equal(label(view, 'waitlist'), 'Waitlist (7)');
  assert.equal(label(view, 'fields'), 'Fields (1 pending)');
  assert.equal(f.rpcs[0].name, 'admin_attention_counts');
});

test('zero counts and a server without the count function leave plain labels', async () => {
  const quiet = await fixture({ counts: { unread_replies: 0, new_errors_since_seen: 0, waitlist_waiting: 0, fields_pending: 0 } }).render();
  assert.deepEqual(['messages', 'errors', 'fields'].map(id => label(quiet, id)), ['Messages', 'Errors', 'Fields']);
  const notDeployed = await fixture({ response: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } }).render();
  assert.deepEqual(['messages', 'errors', 'waitlist', 'fields'].map(id => label(notDeployed, id)), ['Messages', 'Errors', 'Waitlist', 'Fields']);
});

test('a failed count read is marked on the labels, never shown the same as zero', async () => {
  const zero = await fixture({ counts: { unread_replies: 0, new_errors_since_seen: 0, waitlist_waiting: 0, fields_pending: 0 } }).render();
  for (const response of [{ data: null, error: { code: '42501', message: 'permission denied' } }, { data: null }, { data: { unread_replies: 1 } }]) {
    const view = await fixture({ response }).render();
    assert.deepEqual(['messages', 'errors', 'waitlist', 'fields'].map(id => label(view, id)), ['Messages (?)', 'Errors (?)', 'Waitlist (?)', 'Fields (?)']);
    for (const id of ['messages', 'errors', 'fields']) assert.notEqual(label(view, id), label(zero, id));
    assert.equal(view.TABS.find(t => t.id === 'messages').title, 'Unread count unavailable, open to check');
  }
});

test('the tab button carries the unavailable-count title', async () => {
  const f = fixture({ full: true, response: { data: null, error: { code: '42501', message: 'permission denied' } } });
  const nodes = tree => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n && typeof n === 'object' && n.props) { out.push(n); visit(n.props.children); } }; visit(tree); return out; };
  const tree = await f.render();
  const messages = nodes(tree).find(n => n.type === 'button' && n.props.children === 'Messages (?)');
  assert.equal(messages.props.title, 'Unread count unavailable, open to check');
});

test('opening Messages marks it seen, keeps the old stamp for NEW REPLY badges, and re-reads with the new stamp', async () => {
  const f = fixture();
  f.app.data = { settings: { adminInboxSeenAt: '2026-09-20T00:00:00.000Z' } };
  let view = await f.render();
  view.selectTab('messages');
  view = await f.render();
  assert.equal(view.tab, 'messages');
  assert.equal(view.repliesSince, '2026-09-20T00:00:00.000Z');
  assert.ok(f.settingsWrites.some(w => w.adminInboxSeenAt));
  assert.equal(f.rpcs.at(-1).args.p_messages_seen_at, f.app.data.settings.adminInboxSeenAt);
  view.selectTab('errors'); await f.render();
  assert.ok(f.settingsWrites.some(w => w.adminErrorsSeenAt));
});

test('an Overview card filter lasts for that drill-down only; tab clicks reset it', async () => {
  const f = fixture();
  let view = await f.render();
  view.navigateReport('users', { access: 'active' });
  view = await f.render();
  assert.equal(view.accountPreset, 'active');
  view.selectTab('reports'); view = await f.render();
  view.selectTab('users'); view = await f.render();
  assert.equal(view.accountPreset, 'all');
  view.navigateReport('tickets', { status: 'unresolved', priority: 'urgent' });
  view = await f.render();
  assert.deepEqual({ ...view.ticketPreset }, { status: 'unresolved', priority: 'urgent' });
  view.setShowArchived(true); view = await f.render();
  view.selectTab('tickets'); view = await f.render();
  assert.deepEqual({ ...view.ticketPreset }, {});
  assert.equal(view.showArchived, false);
});

test('the Archived toggle opens archived tickets without the card filter that hid resolved ones', async () => {
  const f = fixture({ full: true });
  const nodes = tree => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n && typeof n === 'object' && n.props) { out.push(n); visit(n.props.children); } }; visit(tree); return out; };
  const button = (tree, pattern) => nodes(tree).find(n => n.type === 'button' && pattern.test([].concat(n.props.children).join('')));
  let tree = await f.render();
  assert.ok(button(tree, /^Overview & reports$/));
  // Drill in from the Overview "Open tickets" card, then open the archive.
  const nav = nodes(tree).find(n => n.props.onNavigate);
  nav.props.onNavigate('tickets', { status: 'unresolved' });
  tree = await f.render();
  const list = t => nodes(t).find(n => n.props.initialFilters && n.props.onOpen);
  assert.deepEqual({ ...list(tree).props.initialFilters }, { status: 'unresolved' });
  const activeKey = list(tree).key;
  button(tree, /^Archived/).props.onClick();
  tree = await f.render();
  assert.deepEqual({ ...list(tree).props.initialFilters }, {});
  assert.notEqual(list(tree).key, activeKey, 'the list remounts so its filters reset');
});
