// The Admin group labels carry their counts without loading any list, and
// Home numbers stop leaving their filters on for later tab clicks. Five
// groups (Home, Inbox, People, Activity, Tools) replaced the twelve tabs on
// 2026-11-20; each count moved with its section.
// Executes the real AdminDashboardContent with synthetic I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as adminData from '../../src/utils/adminData.js';
import * as adminTicketDraft from '../../src/utils/adminTicketDraft.js';
import * as adminButton from '../../src/components/shared/adminButton.js';

const source = await readFile(new URL('../../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');
const tick = () => new Promise(done => setImmediate(done));
const anchor = '" pending") },\n  ];\n';
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
  // Child screens are not executed here; named stand-ins let the tree say which one sits where.
  const stub = name => ({ __esModule: true, default: { [name]: function () { return null; } }[name] });
  const children = Object.fromEntries(['AdminOperationsReport', 'AdminHomeSummary', 'AdminErrorReports', 'AdminAccessChange', 'AdminControlHistory', 'AdminLifetimeAccess',
    'AdminLifetimeGift', 'AdminInviteToJoin', 'AdminMailboxRepair', 'AdminMemberView', 'AdminWelcomeEmail'].map(name => [`./${name}`, stub(name)]));
  children['./AdminPreview'] = { __esModule: true, AdminPreviewPicker: function AdminPreviewPicker() { return null; } };
  const imports = { ...children, react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) },
    '../../context/AppContext': { useApp: () => app }, '../../lib/supabase': { supabase: db }, '../../lib/admin': { useIsAdmin: () => true },
    '../../utils/adminData': adminData, '../../utils/adminTicketDraft': adminTicketDraft, '../shared/adminButton': adminButton };
  const injected = (full ? source : source.replace(anchor, anchor + '  globalThis.current = { TABS, selectTab, navigateReport, tab, ticketPreset, accountPreset, showArchived, setShowArchived, repliesSince, focusSection, openTools }; return null;\n')) + '\nexport {AdminDashboardContent};';
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

test('five groups, Home first; group labels show unread replies, waiting leads, new errors and pending fields on first load', async () => {
  const f = fixture();
  const view = await f.render();
  assert.deepEqual(Array.from(view.TABS, t => t.id), ['reports', 'inbox', 'people', 'activity', 'tools']);
  assert.equal(view.tab, 'reports');
  assert.equal(label(view, 'reports'), 'Home');
  assert.equal(label(view, 'inbox'), 'Inbox (2)');
  assert.equal(label(view, 'people'), 'People (7)');
  assert.equal(label(view, 'activity'), 'Activity (3)');
  assert.equal(label(view, 'tools'), 'Tools (1 pending)');
  assert.equal(view.TABS.find(t => t.id === 'inbox').title, '2 unread message replies');
  assert.equal(view.TABS.find(t => t.id === 'people').title, '7 waiting on the waitlist');
  assert.equal(f.rpcs[0].name, 'admin_attention_counts');
});

test('zero counts and a server without the count function leave plain labels', async () => {
  const quiet = await fixture({ counts: { unread_replies: 0, new_errors_since_seen: 0, waitlist_waiting: 0, fields_pending: 0 } }).render();
  assert.deepEqual(['inbox', 'people', 'activity', 'tools'].map(id => label(quiet, id)), ['Inbox', 'People', 'Activity', 'Tools']);
  const notDeployed = await fixture({ response: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } }).render();
  assert.deepEqual(['inbox', 'people', 'activity', 'tools'].map(id => label(notDeployed, id)), ['Inbox', 'People', 'Activity', 'Tools']);
});

test('a failed count read is marked on the labels, never shown the same as zero', async () => {
  const zero = await fixture({ counts: { unread_replies: 0, new_errors_since_seen: 0, waitlist_waiting: 0, fields_pending: 0 } }).render();
  for (const response of [{ data: null, error: { code: '42501', message: 'permission denied' } }, { data: null }, { data: { unread_replies: 1 } }]) {
    const view = await fixture({ response }).render();
    assert.deepEqual(['inbox', 'people', 'activity', 'tools'].map(id => label(view, id)), ['Inbox (?)', 'People (?)', 'Activity (?)', 'Tools (?)']);
    for (const id of ['inbox', 'people', 'activity', 'tools']) assert.notEqual(label(view, id), label(zero, id));
    assert.equal(view.TABS.find(t => t.id === 'inbox').title, 'Unread count unavailable, open to check');
    assert.equal(view.TABS.find(t => t.id === 'tools').title, 'Pending field count unavailable, open to check');
  }
});

test('the tab button carries the unavailable-count title', async () => {
  const f = fixture({ full: true, response: { data: null, error: { code: '42501', message: 'permission denied' } } });
  const nodes = tree => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n && typeof n === 'object' && n.props) { out.push(n); visit(n.props.children); } }; visit(tree); return out; };
  const tree = await f.render();
  const inbox = nodes(tree).find(n => n.type === 'button' && n.props.children === 'Inbox (?)');
  assert.equal(inbox.props.title, 'Unread count unavailable, open to check');
});

test('opening Inbox marks Messages seen, keeps the old stamp for NEW REPLY badges, and re-reads with the new stamp; Activity marks Errors seen', async () => {
  const f = fixture();
  f.app.data = { settings: { adminInboxSeenAt: '2026-09-20T00:00:00.000Z' } };
  let view = await f.render();
  view.selectTab('inbox');
  view = await f.render();
  assert.equal(view.tab, 'inbox');
  assert.equal(view.repliesSince, '2026-09-20T00:00:00.000Z');
  assert.ok(f.settingsWrites.some(w => w.adminInboxSeenAt));
  assert.ok(!f.settingsWrites.some(w => w.adminErrorsSeenAt), 'Inbox does not mark errors seen');
  assert.equal(f.rpcs.at(-1).args.p_messages_seen_at, f.app.data.settings.adminInboxSeenAt);
  view.selectTab('activity'); await f.render();
  assert.ok(f.settingsWrites.some(w => w.adminErrorsSeenAt));
  // A Home number for unread replies or new errors stamps the same way.
  const g = fixture();
  let other = await g.render();
  other.navigateReport('messages'); other = await g.render();
  assert.equal(other.tab, 'inbox'); assert.ok(g.settingsWrites.some(w => w.adminInboxSeenAt));
  other.navigateReport('errors'); other = await g.render();
  assert.equal(other.tab, 'activity'); assert.ok(g.settingsWrites.some(w => w.adminErrorsSeenAt));
});

test('a Home number opens its section in its group and focuses it; a Tools section opens its card', async () => {
  const f = fixture();
  let view = await f.render();
  for (const [section, group] of [['tickets', 'inbox'], ['messages', 'inbox'], ['users', 'people'], ['waitlist', 'people'], ['signups', 'activity'], ['errors', 'activity'], ['fields', 'tools']]) {
    view.navigateReport(section); view = await f.render();
    assert.equal(view.tab, group, section);
    assert.equal(view.focusSection, section, section);
  }
  assert.ok(view.openTools.has('fields'), 'Fields to review opens the Field proposals card');
  view.selectTab('people'); view = await f.render();
  assert.equal(view.focusSection, null, 'a plain tab tap focuses nothing');
});

test('a Home number filter lasts for that drill-down only; tab clicks reset it', async () => {
  const f = fixture();
  let view = await f.render();
  view.navigateReport('users', { access: 'active' });
  view = await f.render();
  assert.equal(view.tab, 'people');
  assert.equal(view.accountPreset, 'active');
  view.selectTab('reports'); view = await f.render();
  view.selectTab('people'); view = await f.render();
  assert.equal(view.accountPreset, 'all');
  view.navigateReport('tickets', { status: 'unresolved', priority: 'urgent' });
  view = await f.render();
  assert.equal(view.tab, 'inbox');
  assert.deepEqual({ ...view.ticketPreset }, { status: 'unresolved', priority: 'urgent' });
  view.setShowArchived(true); view = await f.render();
  view.selectTab('inbox'); view = await f.render();
  assert.deepEqual({ ...view.ticketPreset }, {});
  assert.equal(view.showArchived, false);
});

test('each group shows its sections in the briefed order and every former box is still mounted', async () => {
  const f = fixture({ full: true });
  const nodes = tree => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n && typeof n === 'object' && n.props) { out.push(n); visit(n.props.children); } }; visit(tree); return out; };
  const nav = tree => nodes(tree).find(n => n.props['aria-label'] === 'Administration sections');
  const open = async (tree, name) => { nodes(nav(tree)).find(n => n.type === 'button' && String(n.props.children).startsWith(name)).props.onClick(); return f.render(); };
  const headings = tree => nodes(tree).filter(n => n.type === 'h3' && String(n.props.id || '').startsWith('admin-section-')).map(n => n.props.children);
  const named = (tree, fn) => nodes(tree).filter(n => typeof n.type === 'function' && n.type.name === fn);
  let tree = await f.render();
  assert.equal(named(tree, 'AdminOperationsReport').length, 1);
  assert.equal(named(tree, 'AdminHomeSummary').length, 1, 'the payments and Founder spots summary is on Home');
  tree = await open(tree, 'Inbox');
  assert.deepEqual(headings(tree), ['Tickets', 'Messages']);
  assert.equal(named(tree, 'TicketsList').length, 1); assert.equal(named(tree, 'MessagesPanel').length, 1);
  assert.ok(nodes(tree).some(n => n.type === 'button' && n.props.children === '+ New ticket'));
  tree = await open(tree, 'People');
  const people = named(tree, 'UsersPanel')[0];
  assert.equal(people.props.heading.props.children, 'Accounts');
  assert.equal(named(people.props.children, 'WaitlistList').length, 1, 'the waitlist sits inside People, after the accounts directory');
  for (const moved of ['AdminLifetimeGift', 'AdminInviteToJoin', 'AdminMailboxRepair']) assert.equal(named(tree, moved).length, 0, `${moved} is no longer on People`);
  const users = source.slice(source.indexOf('function UsersPanel('), source.indexOf('function WaitlistList('));
  const at = text => { const i = users.indexOf(text); assert.ok(i > 0, text); return i; };
  assert.ok(at('Search loaded accounts') < at('{children}') && at('{children}') < at('Waiting on an invitation ('), 'accounts, then waitlist, then invitations');
  assert.ok(users.includes('chip("Give free lifetime access"'), 'the per-row lifetime button stays');
  tree = await open(tree, 'Activity');
  assert.deepEqual(headings(tree), ['Webpage visits', 'New accounts', 'Errors']);
  assert.equal(named(tree, 'SignupsList').length, 1); assert.equal(named(tree, 'AdminErrorReports').length, 1);
  tree = await open(tree, 'Tools');
  const cards = named(tree, 'ToolCard');
  assert.deepEqual(cards.map(c => c.props.id), ['invite', 'gift', 'mailbox', 'emails', 'ai', 'preview', 'audit', 'fields']);
  assert.deepEqual(cards.map(c => c.props.title), ['Invite to join', 'Gift lifetime access by email', 'Repair sign-in emails', 'Welcome email', 'AI', 'Preview as a member', 'Control history', 'Field proposals (1 pending)']);
  assert.ok(cards.every(c => c.props.open === false && typeof c.props.hint === 'string' && c.props.hint.length < 110), 'collapsed, with a one-line hint');
  assert.deepEqual(cards.map(c => c.props.children?.type?.name || c.props.children?.type), ['AdminInviteToJoin', 'AdminLifetimeGift', 'AdminMailboxRepair', 'AdminWelcomeEmail', 'AiPanel', 'AdminPreviewPicker', 'AdminControlHistory', 'FieldProposals']);
  cards[0].props.onToggle(); tree = await f.render();
  assert.equal(named(tree, 'ToolCard')[0].props.open, true);
});

test('the Archived toggle opens archived tickets without the card filter that hid resolved ones', async () => {
  const f = fixture({ full: true });
  const nodes = tree => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n && typeof n === 'object' && n.props) { out.push(n); visit(n.props.children); } }; visit(tree); return out; };
  const button = (tree, pattern) => nodes(tree).find(n => n.type === 'button' && pattern.test([].concat(n.props.children).join('')));
  let tree = await f.render();
  assert.ok(button(tree, /^Home$/));
  // Drill in from the Home "Open tickets" number, then open the archive.
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
