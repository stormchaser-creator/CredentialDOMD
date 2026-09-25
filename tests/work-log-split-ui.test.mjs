import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The three Work Log save paths (timer, new entry, edit), the group edit and
// delete, and the contract form's call-day settings, driven through the real
// components. Hooks run on a small in-process harness (every render calls the
// component function; handlers are invoked straight off the element tree), and
// every write lands in a recorder instead of the cloud. Synthetic data only.

const originalTimezone = process.env.TZ;
process.env.TZ = 'America/Denver';
const RealDate = globalThis.Date;
let NOW = '2026-08-12T12:00:00-06:00';
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return new RealDate(NOW).getTime(); }
};
test.after(() => {
  globalThis.Date = RealDate;
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'], logLevel: 'silent',
  plugins: [{ name: 'synthetic-device', setup(b) {
    const stub = { 'context/AppContext': 'app', 'utils/storageScope': 'storage', 'utils/privateVault': 'vault', 'lib/supabase': 'db', 'hooks/useDeskKeys': 'desk' };
    b.onResolve({ filter: /(context\/AppContext|utils\/storageScope|utils\/privateVault|lib\/supabase|hooks\/useDeskKeys)(\.js)?$/ }, ({ path }) => {
      const key = Object.keys(stub).find(k => path.replace(/\.js$/, '').endsWith(k));
      return { path: stub[key], namespace: 'fixture' };
    });
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      app: 'export const useApp = () => globalThis.__work.app;',
      storage: 'export const BASE_KEYS = { timer: "timer", lastContract: "lastContract" }; const m = () => globalThis.__work.storage; export const lsGet = (k) => m()[k] ?? null; export const lsSet = (k, v) => { m()[k] = v; }; export const lsGetJSON = (k) => m()[k] ?? null; export const lsSetJSON = (k, v) => { m()[k] = v; }; export const lsRemove = (k) => { delete m()[k]; };',
      vault: 'const v = () => globalThis.__work.vault; export const getPrivate = (s, id) => v()[s + ":" + id] || ""; export const setPrivate = (s, id, t) => { v()[s + ":" + id] = t; }; export const removePrivate = (s, id) => { delete v()[s + ":" + id]; }; export const looksLikePHI = () => null;',
      db: 'export const supabase = {}; export const downloadDocumentBlob = async () => null; export default {};',
      desk: 'export const useDeskAddShortcut = () => {};',
    }[path] }));
  } }],
});

// A minimal hook runtime: state and refs persist by call order; memo and
// callback recompute every render (always correct, never stale); effects run
// after a render when their deps change. The bundle is loaded once, before any
// window exists (as in a browser's first import), and its React calls go to
// whichever component is mounted.
let current = null;
function harness() {
  const slots = []; let cursor = 0; const pending = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
  return {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { v: typeof initial === 'function' ? initial() : initial };
      const slot = slots[i]; return [slot.v, (next) => { slot.v = typeof next === 'function' ? next(slot.v) : next; }]; },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) { const i = cursor++; const prev = slots[i]; if (!prev || changed(prev.deps, deps)) { slots[i] = { deps }; pending.push(fn); } },
    begin() { cursor = 0; }, flush() { for (const fn of pending.splice(0)) fn(); },
  };
}
const reactStub = { ...React, memo: (c) => c };
for (const hook of ['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect']) reactStub[hook] = (...args) => current[hook](...args);
const loaded = (() => {
  const mod = { exports: {} };
  const req = (name) => (name === 'react' ? reactStub : require(name));
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(req, mod, mod.exports);
  return mod.exports;
})();
// Notices clear themselves on a timer and a running timer ticks every second;
// neither may hold the test process open.
const realSetTimeout = globalThis.setTimeout, realSetInterval = globalThis.setInterval;
globalThis.setTimeout = (...args) => { const t = realSetTimeout(...args); t?.unref?.(); return t; };
globalThis.setInterval = (...args) => { const t = realSetInterval(...args); t?.unref?.(); return t; };
test.after(() => { globalThis.setTimeout = realSetTimeout; globalThis.setInterval = realSetInterval; });

const THEME = { text: '#111', textMuted: '#666', textDim: '#888', border: '#aaa', card: '#fff', bg: '#eee', accent: '#2a7', accentDim: '#dfe', danger: '#c00', dangerDim: '#fee', warning: '#a60', warningDim: '#ffe', success: '#0a0', input: '#fafafa', inputBorder: '#ccc', shadow1: 'none' };
const CONTRACT = { id: 'c1', facility: 'Synthetic General', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-07-28', end: '2026-08-09' }], startDate: '2026-07-28', endDate: '2026-08-09' };

function mount(Component, { contracts, workLog = [], invoices = [], confirm = () => true, storage = {}, props = {} } = {}) {
  const h = harness();
  const calls = [];
  const data = { settings: {}, locumContracts: contracts, workLog: [...workLog], invoices, documents: [] };
  // Writes are recorded AND applied, so a second render sees them like the app would.
  const apply = (key, fn) => { data[key] = fn(data[key] || []); };
  const app = {
    data, theme: THEME, isDesktop: false, setData: () => {},
    addItem: (key, item) => { calls.push(['add', key, item]); apply(key, l => [...l, item]); return true; },
    editItem: (key, item) => { calls.push(['edit', key, item]); apply(key, l => l.map(x => (x.id === item.id ? item : x))); return true; },
    deleteItem: (key, id) => { calls.push(['delete', key, id]); apply(key, l => l.filter(x => x.id !== id)); return true; },
  };
  const dialogs = [];
  globalThis.window = { confirm: (m) => { dialogs.push(['confirm', m]); return confirm(m); }, alert: (m) => { dialogs.push(['alert', m]); } };
  globalThis.__work = { app, storage: { ...storage }, vault: {} };
  const C = loaded[Component];
  const render = () => { current = h; h.begin(); const tree = C(props); h.flush(); return tree; };
  return { render, calls, dialogs, data, html: () => renderToStaticMarkup(render()) };
}

// Every element in a tree, including ones passed as a Modal's footer.
const nodes = (n) => (Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === 'object' ? [n, ...nodes(n.props?.children), ...nodes(n.props?.footer)] : []);
const textOf = (n) => (typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : n?.props ? textOf(n.props.children) : '');
const find = (tree, pred, what) => { const hit = nodes(tree).find(pred); assert.ok(hit, `not found: ${what}`); return hit; };
const button = (tree, label) => find(tree, n => n.type === 'button' && textOf(n).includes(label), label);
const field = (tree, label) => find(tree, n => n.props?.label === label, label);
const click = (m, label) => button(m.render(), label).props.onClick({ stopPropagation() {} });
// Save, answering the "Check the date" schedule question with yes when it
// asks (Aug 10 is past these synthetic coverage dates).
const save = (m, label) => {
  click(m, label);
  const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
  if (yes) yes.props.onClick();
};
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// Log 06:45 to 07:15 on Aug 10 through the "Log past time" form.
function logPastTime(m, date, start, end) {
  click(m, 'Log past time');
  let tree = m.render();
  find(tree, n => n.type === 'button' && textOf(n) === 'Other…' && n.props.onClick && String(n.props.onClick).includes('pickDate'), 'date Other').props.onClick();
  tree = m.render();
  find(tree, n => n.type === 'input' && n.props.type === 'date', 'date input').props.onChange({ target: { value: date } });
  field(m.render(), 'Start time').props.onCommit(start);
  field(m.render(), 'End time').props.onCommit(end);
  save(m, 'Log it');
}

const adds = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'workLog').map(c => c[2]);
const LEGACY_KEYS = ['id', 'createdAt', 'contractId', 'type', 'date', 'callDay', 'startTime', 'endTime', 'durationMin', 'billedMin', 'description', 'privateNote', 'invoiceId'];

test('new entry, splitting off: one row with exactly the keys it always had, whole under Aug 9', () => {
  const m = mount('WorkLog', { contracts: [CONTRACT] });
  logPastTime(m, '2026-08-10', '06:45', '07:15');
  const rows = adds(m);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), LEGACY_KEYS);
  assert.equal(rows[0].callDay, '2026-08-09');
  assert.equal(rows[0].billedMin, 30);
});

test('new entry, splitting on: one row per piece with a shared group id, and the notice says where each went', () => {
  const m = mount('WorkLog', { contracts: [{ ...CONTRACT, splitAtDayStart: true, dayStartHour: 7 }] });
  logPastTime(m, '2026-08-10', '06:45', '07:15');
  const rows = adds(m);
  assert.deepEqual(rows.map(r => `${hhmm(r.startTime)}-${hhmm(r.endTime)} ${r.callDay} ${r.billedMin}`), ['06:45-07:00 2026-08-09 15', '07:00-07:15 2026-08-10 15']);
  assert.ok(rows[0].splitGroupId && rows[0].splitGroupId === rows[1].splitGroupId);
  assert.notEqual(rows[0].id, rows[1].id);
  const html = m.html();
  assert.match(html, /crossed the 7:00 AM start of the call day, so it is split/);
  assert.match(html, /continues on the Aug 10, 2026 call day/);
  assert.match(html, /continued from the Aug 9, 2026 call day/);
});

test('timer, splitting on: Stop and Log writes the pieces too', () => {
  NOW = '2026-08-10T07:15:00-06:00';
  try {
    const m = mount('WorkLog', {
      contracts: [{ ...CONTRACT, splitAtDayStart: true }],
      storage: { timer: { contractId: 'c1', type: 'Call', startedAt: '2026-08-10T12:45:00.000Z' } },
    });
    click(m, 'Stop & Log');
    const rows = adds(m);
    assert.deepEqual(rows.map(r => `${hhmm(r.startTime)}-${hhmm(r.endTime)} ${r.callDay} ${r.billedMin}`), ['06:45-07:00 2026-08-09 15', '07:00-07:15 2026-08-10 15']);
    assert.equal(rows[0].splitGroupId, rows[1].splitGroupId);
  } finally { NOW = '2026-08-12T12:00:00-06:00'; }
});

test('timer, splitting off: the stamp and the row are unchanged', () => {
  NOW = '2026-08-10T07:15:00-06:00';
  try {
    const m = mount('WorkLog', { contracts: [CONTRACT], storage: { timer: { contractId: 'c1', type: 'Call', startedAt: '2026-08-10T12:45:00.000Z' } } });
    click(m, 'Stop & Log');
    const rows = adds(m);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]), LEGACY_KEYS);
    assert.equal(rows[0].callDay, '2026-08-09');
  } finally { NOW = '2026-08-12T12:00:00-06:00'; }
});

const PIECES = [
  { id: 'p1', createdAt: '2026-08-10T13:20:00Z', contractId: 'c1', type: 'Call', date: '2026-08-10', callDay: '2026-08-09', startTime: '2026-08-10T12:45:00.000Z', endTime: '2026-08-10T13:00:00.000Z', durationMin: 15, billedMin: 15, description: 'ED consult', privateNote: '', invoiceId: null, splitGroupId: 'g-old', favorite: true },
  { id: 'p2', createdAt: '2026-08-10T13:20:00Z', contractId: 'c1', type: 'Call', date: '2026-08-10', callDay: '2026-08-10', startTime: '2026-08-10T13:00:00.000Z', endTime: '2026-08-10T13:15:00.000Z', durationMin: 15, billedMin: 15, description: 'ED consult', privateNote: '', invoiceId: null, splitGroupId: 'g-old', favorite: false },
];
const editRow = (m, id) => {
  const tree = m.render();
  const row = find(tree, n => n.type === 'div' && n.key === id, `row ${id}`);
  find(row, n => n.type === 'button' && nodes(n).some(x => x.type?.name === 'EditIcon' || x.type === 'svg' || typeof x.type === 'function'), 'edit').props.onClick({ stopPropagation() {} });
};

test('editing a piece opens the whole entry and rewrites both pieces in place', () => {
  const m = mount('WorkLog', { contracts: [{ ...CONTRACT, splitAtDayStart: true }], workLog: PIECES });
  editRow(m, 'p2');
  assert.equal(field(m.render(), 'Start time').props.value, '06:45');
  assert.equal(field(m.render(), 'End time').props.value, '07:15');
  field(m.render(), 'End time').props.onCommit('07:30');
  save(m, 'Save changes');
  const edits = m.calls.filter(c => c[0] === 'edit').map(c => c[2]);
  assert.deepEqual(edits.map(r => `${r.id} ${hhmm(r.startTime)}-${hhmm(r.endTime)} ${r.callDay} ${r.billedMin}`), ['p1 06:45-07:00 2026-08-09 15', 'p2 07:00-07:30 2026-08-10 30']);
  assert.ok(edits[0].splitGroupId && edits[0].splitGroupId === edits[1].splitGroupId);
  assert.deepEqual(edits.map(r => r.favorite), [true, false], 'each piece keeps its own star');
  assert.equal(m.calls.filter(c => c[0] !== 'edit').length, 0);
});

test('editing a piece of a partly invoiced entry warns about the invoice first', () => {
  const pieces = PIECES.map((p, i) => (i === 0 ? { ...p, invoiceId: 'inv1' } : p));
  const m = mount('WorkLog', { contracts: [{ ...CONTRACT, splitAtDayStart: true }], workLog: pieces, invoices: [{ id: 'inv1', number: 'INV-SYN-1', contractId: 'c1' }], confirm: () => false });
  editRow(m, 'p2');
  save(m, 'Save changes');
  assert.match(m.dialogs.map(d => d[1]).join('\n'), /Part of this entry is already billed on INV-SYN-1/);
  assert.equal(m.calls.length, 0, 'declined: nothing written');
});

test('editing a split entry back under one day, with splitting now off, leaves one whole row', () => {
  const m = mount('WorkLog', { contracts: [CONTRACT], workLog: PIECES });
  editRow(m, 'p1');
  save(m, 'Save changes');
  const edits = m.calls.filter(c => c[0] === 'edit').map(c => c[2]);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].id, 'p1');
  assert.equal(edits[0].splitGroupId, null);
  assert.equal(`${hhmm(edits[0].startTime)}-${hhmm(edits[0].endTime)} ${edits[0].callDay} ${edits[0].billedMin}`, '06:45-07:15 2026-08-09 30');
  assert.deepEqual(m.calls.filter(c => c[0] === 'delete').map(c => c[2]), ['p2']);
});

test('deleting one piece asks once and deletes the whole entry', () => {
  const m = mount('WorkLog', { contracts: [{ ...CONTRACT, splitAtDayStart: true }], workLog: PIECES });
  const row = find(m.render(), n => n.type === 'div' && n.key === 'p2', 'row p2');
  const buttons = nodes(row).filter(n => n.type === 'button');
  buttons.at(-1).props.onClick({ stopPropagation() {} });
  assert.match(m.dialogs[0][1], /split at the start of the call day into 2 parts. Delete all 2\?/);
  assert.deepEqual(m.calls.map(c => `${c[0]} ${c[2]}`), ['delete p1', 'delete p2']);
});

test('a piece whose partner is invoiced cannot be deleted on its own', () => {
  const pieces = PIECES.map((p, i) => (i === 0 ? { ...p, invoiceId: 'inv1' } : p));
  const m = mount('WorkLog', { contracts: [{ ...CONTRACT, splitAtDayStart: true }], workLog: pieces, invoices: [{ id: 'inv1', number: 'INV-SYN-1', contractId: 'c1' }] });
  const row = find(m.render(), n => n.type === 'div' && n.key === 'p2', 'row p2');
  nodes(row).filter(n => n.type === 'button').at(-1).props.onClick({ stopPropagation() {} });
  assert.match(m.dialogs[0][1], /Part of this entry is on INV-SYN-1/);
  assert.equal(m.calls.length, 0);
});

// ── The contract form ────────────────────────────────────────────

const openContract = (m, facility) => {
  const tree = m.render();
  const card = find(tree, n => n.type === 'div' && n.key === 'c1', facility);
  nodes(card).filter(n => n.type === 'button')[0].props.onClick();
};

test('a contract saved without touching the call-day settings writes none of their keys', () => {
  const m = mount('Contracts', { contracts: [CONTRACT] });
  openContract(m, 'Synthetic General');
  click(m, 'Save');
  const saved = m.calls.find(c => c[0] === 'edit')[2];
  assert.equal('splitAtDayStart' in saved, false);
  assert.equal('dayStartHour' in saved, false);
});

test('the form sets both settings, and a contract loaded with them saves them back', () => {
  const m = mount('Contracts', { contracts: [CONTRACT] });
  openContract(m, 'Synthetic General');
  let tree = m.render();
  const setting = field(tree, 'Start of the call day');
  assert.match(textOf(setting), /Split calls that cross the start of the call day/);
  find(setting, n => n.type === 'input' && n.props.type === 'checkbox', 'checkbox').props.onChange({ target: { checked: true } });
  find(field(m.render(), 'Start of the call day'), n => n.type === 'select', 'hour').props.onChange({ target: { value: '8' } });
  tree = m.render();
  assert.match(field(tree, 'Coverage dates').props.hint, /An entry that runs past it is split/);
  assert.match(field(tree, 'Coverage dates').props.hint, /8:00 AM/);
  click(m, 'Save');
  const saved = m.calls.find(c => c[0] === 'edit')[2];
  assert.equal(saved.splitAtDayStart, true);
  assert.equal(saved.dayStartHour, 8);

  const again = mount('Contracts', { contracts: [{ ...CONTRACT, splitAtDayStart: false, dayStartHour: 7 }] });
  openContract(again, 'Synthetic General');
  click(again, 'Save');
  const back = again.calls.find(c => c[0] === 'edit')[2];
  assert.equal(back.splitAtDayStart, false);
  assert.equal(back.dayStartHour, 7);
});

test('the coverage hint no longer claims a crossing call bills hourly', () => {
  const m = mount('Contracts', { contracts: [CONTRACT] });
  openContract(m, 'Synthetic General');
  const hint = field(m.render(), 'Coverage dates').props.hint;
  assert.doesNotMatch(hint, /work after that final 7 AM bills hourly/);
  assert.match(hint, /Work that starts after that final 7:00 AM bills hourly with no stipend/);
  assert.match(hint, /counts whole toward Aug 9, inside the stipend, unless you turn on splitting below/);
  assert.doesNotMatch(hint, /\u{2014}/u, 'no em dash');
});
