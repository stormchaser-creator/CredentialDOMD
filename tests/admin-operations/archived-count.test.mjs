// QA ADMIN-007: the Tickets tab's "Archived (n)" button. The count came from
// the archive list's coverage, which loads only while the archive is open:
// on first view the button read plain "Archived", and after archiving a
// ticket from the active list it kept the old n. Executes the real
// AdminDashboardContent with synthetic I/O (synthetic ids only).
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
const ARCHIVED_AT = '2026-09-01T00:00:00Z';

function fixture({ archived = 3, active = 2, failCount = false } = {}) {
  const tickets = [
    ...Array.from({ length: archived }, (_, n) => ({ id: `a-${n}`, status: 'resolved', archived_at: ARCHIVED_AT, updated_at: ARCHIVED_AT, subject: `Archived ${n}` })),
    ...Array.from({ length: active }, (_, n) => ({ id: `o-${n}`, status: 'open', archived_at: null, updated_at: ARCHIVED_AT, subject: `Open ${n}` })),
  ];
  const hooks = [], effects = [];
  let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++; if (!hooks[i] || !deps || !same(hooks[i].deps, deps)) { const old = hooks[i]; hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = effect(); }); } },
  };
  const app = { theme: {}, user: { id: 'synthetic-owner' }, data: { settings: {} }, userIdRef: { current: 'owner' }, updateSettings() {} };
  const db = {
    async rpc() { return { data: { unread_replies: 0, new_errors_since_seen: 0, waitlist_waiting: 0, fields_pending: 0 } }; },
    from(table) {
      const filters = []; let head = false; let patch = null;
      const rows = () => tickets.filter(t => filters.every(([kind, column, value]) => kind === 'is' ? t[column] === value : kind === 'not' ? t[column] !== null : t[column] === value));
      const q = {
        select(_columns, options) { head = !!options?.head; return q; },
        is(column, value) { filters.push(['is', column, value]); return q; },
        not(column) { filters.push(['not', column]); return q; },
        eq(column, value) { filters.push(['eq', column, value]); return q; },
        order: () => q,
        update(next) { patch = next; return q; },
        async range(start, end) { if (table !== 'admin_tickets_open') return { data: [], count: 0 }; const all = rows(); return { data: all.slice(start, end + 1), count: all.length }; },
        then(resolve, reject) {
          if (patch) { for (const t of rows()) Object.assign(t, patch); return Promise.resolve({ error: null }).then(resolve, reject); }
          if (head && failCount) return Promise.resolve({ data: null, count: null, error: { message: 'Synthetic outage' } }).then(resolve, reject);
          return Promise.resolve({ data: head ? null : rows(), count: rows().length, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
    functions: { async invoke() { return { data: {} }; } },
  };
  const imports = { react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) },
    '../../context/AppContext': { useApp: () => app }, '../../lib/supabase': { supabase: db }, '../../lib/admin': { useIsAdmin: () => true },
    '../../utils/adminData': adminData, '../../utils/adminTicketDraft': adminTicketDraft, '../shared/adminButton': adminButton };
  const module = { exports: {} };
  const ctx = vm.createContext({ module, exports: module.exports, require: name => imports[name] || {}, console, setTimeout: () => 0 });
  const injected = source.replace('  const activeTickets = tickets.filter(t => !t.archived_at);', '  globalThis.current = { selectTab, setArchived, setShowArchived, showArchived }; const activeTickets = tickets.filter(t => !t.archived_at);') + '\nexport {AdminDashboardContent};';
  assert.notEqual(injected, source + '\nexport {AdminDashboardContent};', 'anchor moved');
  vm.runInContext(transformSync(injected, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, ctx);
  const render = async () => {
    for (let round = 0; round < 6; round++) { cursor = 0; module.exports.AdminDashboardContent(); if (!effects.length) break; effects.splice(0).forEach(run => run()); await tick(); await tick(); }
    cursor = 0; const tree = module.exports.AdminDashboardContent(); return { tree, view: ctx.current };
  };
  return { render, tickets };
}
const nodes = tree => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n && typeof n === 'object' && n.props) { out.push(n); visit(n.props.children); } }; visit(tree); return out; };
const archiveButton = tree => nodes(tree).find(n => n.type === 'button' && /^(Archived|Back to active)/.test([].concat(n.props.children).join('')));
const label = tree => [].concat(archiveButton(tree)?.props.children).join('');

test('the Tickets tab shows "Archived (n)" on first view, before the archive is opened', async () => {
  const f = fixture({ archived: 3 });
  let { view } = await f.render();
  view.selectTab('tickets');
  const { tree } = await f.render();
  assert.equal(label(tree), 'Archived (3)');
});

test('archiving a ticket from the active list moves the count, after the archive was visited', async () => {
  const f = fixture({ archived: 3 });
  let { view } = await f.render();
  view.selectTab('tickets');
  ({ view } = await f.render());
  archiveButton((await f.render()).tree).props.onClick();
  let { tree } = await f.render();
  assert.equal(label(tree), 'Back to active');
  archiveButton(tree).props.onClick();
  ({ tree, view } = await f.render());
  assert.equal(label(tree), 'Archived (3)');
  await view.setArchived(f.tickets.find(t => t.id === 'o-0'), true);
  ({ tree } = await f.render());
  assert.equal(label(tree), 'Archived (4)', 'the count follows the archive, not the last visit');
});

test('a failed count read leaves the plain label, never a number', async () => {
  const f = fixture({ archived: 3, failCount: true });
  const { view } = await f.render();
  view.selectTab('tickets');
  const { tree } = await f.render();
  assert.equal(label(tree), 'Archived');
});

test('readArchivedTicketCount asks for a count of archived rows without loading them', async () => {
  const steps = [];
  const client = { from(table) { steps.push(['from', table]); const q = {
    select(columns, options) { steps.push(['select', columns, options]); return q; },
    not(...args) { steps.push(['not', ...args]); return q; },
    then(resolve) { resolve({ data: null, count: 7, error: null }); },
  }; return q; } };
  assert.equal(await adminData.readArchivedTicketCount(client), 7);
  assert.deepEqual(steps, [['from', 'admin_tickets_open'], ['select', 'id', { count: 'exact', head: true }], ['not', 'archived_at', 'is', null]]);
  assert.equal(await adminData.readArchivedTicketCount({ from() { throw new Error('offline'); } }), null);
});
