// SETTINGS-013: at desk width on a 1280px laptop the Licenses table showed
// the license number as "QA…" in a 60px column and the expiration as
// "Jun 30, …" at the default text size M; at XL the number column was 25px
// and at XXL 0px. Five columns had fixed percentages (55% of the table), the
// status and actions cells took 162px more, and Type and Number split what
// was left, beside the 240px side nav and the 240px Credentials rail.
// DeskTable's fixed layout then cut every cell short with an ellipsis.
//
// Now each Licenses column says the room it needs, the number and the
// expiration are always shown with enough of it (and wrap rather than cut),
// and State, Status, Issued and Cost step aside when the table is narrow
// (src/components/shared/deskTableFit.js, src/components/features/
// licenseDeskColumns.js). Measured in Chromium with Inter at 13.5px: the
// widest date, "May 30, 2028" in tabular figures, is 89px, 113px with the
// cell's padding; "QA-THEME-AZ1" is 99px, 123px.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { fitDeskColumns, adaptsToWidth, DESK_STATUS_WIDTH } from '../src/components/shared/deskTableFit.js';
import { licenseDeskColumns } from '../src/components/features/licenseDeskColumns.js';
import { installLiveDom } from './harness/live-dom.mjs';
import { loadScreens, THEME } from './harness/component-harness.mjs';

const T = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? `#${k}` : undefined) });
const keys = cols => cols.map(c => c.key);
const FULL = Object.fromEntries(licenseDeskColumns(T).map(c => [c.key, c.width]));
const PADDING = 24;
const WIDEST_DATE = 89, NUMBER_TEXT = 99;

// ─── The desk geometry, read from the source that sets it ───────────
const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8');
const crud = await readFile(new URL('../src/components/features/CrudSection.jsx', import.meta.url), 'utf8');
const FONT_ZOOM = Function(`return (${/const FONT_ZOOM = (\{[^}]+\});/.exec(app)[1]})`)();
const SIDE_NAV = Number(/\.cmd-content-area \{[^}]*margin-left: (\d+)px/.exec(css)[1]);
const [, INNER_MAX, INNER_PAD] = /\.cmd-content-inner \{[^}]*max-width: (\d+)px;[^}]*padding: \d+px (\d+)px/.exec(css).map(Number);
const [, RAIL_GAP, RAIL] = /gap: (\d+), alignItems: "flex-start" \} : undefined\}>\s*\{isDesktop \? <nav style=\{\{ \.\.\.deskRailStyle\((\d+)\)/.exec(app).map(Number);
const ACTIONS = Number(/actionsWidth=\{favoritable \? (\d+) : \d+\}/.exec(crud)[1]);
const COMPACT = Number(/compactActionsWidth=\{(\d+)\}/.exec(crud)[1]);
assert.match(app, /deskColumns=\{licenseDeskColumns\(T, reminderLeadDays\(data\.settings\.reminderLeadDays\)\)\}/, 'the Licenses page uses these columns, graded on the member\'s lead time');

/** The Licenses table's own CSS pixels on a `screen`-wide desk at a text size (inside the zoom, less its 2px border). */
function tableWidth(screen, size) {
  const content = (screen - SIDE_NAV) / FONT_ZOOM[size];
  return Math.min(content, INNER_MAX) - 2 * INNER_PAD - RAIL - RAIL_GAP - 2;
}
const fitLicenses = width => fitDeskColumns(licenseDeskColumns(T), width, { status: true, actionsWidth: ACTIONS, compactActionsWidth: COMPACT });
const widthOf = (fit, key, width) => {
  const col = fit.columns.find(c => c.key === key);
  if (!col) return 0;
  if (typeof col.width === 'number') return col.width;
  const fixed = fit.columns.filter(c => typeof c.width === 'number').reduce((n, c) => n + c.width, 0);
  return width - DESK_STATUS_WIDTH - fit.actionsWidth - fixed;
};

test('the geometry this test reads is the one the QA lab measured (about 700px at M on 1280)', () => {
  assert.deepEqual(FONT_ZOOM, { S: 0.88, M: 1, L: 1.1, XL: 1.2, XXL: 1.35 });
  assert.ok(Math.abs(tableWidth(1280, 'M') - 700) < 8, `${tableWidth(1280, 'M')}`);
  assert.ok(tableWidth(1280, 'XXL') < 440);
});

for (const screen of [1280, 1440, 1920]) {
  for (const size of Object.keys(FONT_ZOOM)) {
    test(`${screen}px desk at text size ${size}: the number and the expiration are shown whole and the table fits`, () => {
      const width = tableWidth(screen, size);
      const fit = fitLicenses(width);
      assert.ok(keys(fit.columns).includes('licenseNumber') && keys(fit.columns).includes('expirationDate'), keys(fit.columns).join(','));
      const used = DESK_STATUS_WIDTH + fit.actionsWidth + fit.columns.reduce((n, c) => n + (typeof c.width === 'number' ? c.width : c.minWidth || 0), 0);
      assert.ok(used <= width, `needs ${used}px of ${width}`);
      const number = widthOf(fit, 'licenseNumber', width), expires = widthOf(fit, 'expirationDate', width);
      if (number === FULL.licenseNumber) {
        // Not shrunk to its minWidth: a whole date on one line, the
        // synthetic number on one line.
        assert.ok(expires >= WIDEST_DATE + PADDING, `Expires ${expires}px`);
        assert.ok(number >= NUMBER_TEXT + PADDING, `Number ${number}px`);
      }
      // Always: wide enough that wrapping shows every character ("Jun 30," /
      // "2028"), never the 60px, 25px or 0px the lab found.
      assert.ok(number >= 92 && expires >= 92, `Number ${number}px, Expires ${expires}px`);
      assert.ok(widthOf(fit, 'type', width) >= 100, `Type ${widthOf(fit, 'type', width)}px`);
    });
  }
}

// Review of SETTINGS-013: the actions cell stayed on one line (160px) while
// Status stepped aside, so at the default size on the lab's 1280px laptop a
// provisional or pending-confirmation license read like an active one, and
// Type had 194px to spare. Status and State outrank one-line actions: the
// buttons wrap two by two before either goes.
test('at the default size on a 1280px laptop the table keeps State and Status, the actions wrapping instead', () => {
  const fit = fitLicenses(tableWidth(1280, 'M'));
  assert.deepEqual(keys(fit.columns), ['type', 'state', 'licenseNumber', 'expirationDate', 'lifecycleStatus']);
  assert.equal(fit.compact, true);
  assert.equal(fit.actionsWidth, COMPACT);
  // The number and the date keep their one-line widths.
  assert.equal(widthOf(fit, 'licenseNumber', tableWidth(1280, 'M')), FULL.licenseNumber);
  assert.equal(widthOf(fit, 'expirationDate', tableWidth(1280, 'M')), FULL.expirationDate);
});

test('Cost and Issued still give way before the actions wrap, and nothing wraps that need not', () => {
  // The widest desk at M (content capped at 1140px) has room for Status and
  // State with one-line actions.
  const wide = fitLicenses(tableWidth(1920, 'M'));
  assert.deepEqual([keys(wide.columns), wide.compact], [['type', 'state', 'licenseNumber', 'expirationDate', 'lifecycleStatus'], false]);
  const cols = Object.fromEntries(licenseDeskColumns(T).map(c => [c.key, c]));
  assert.equal(cols.lifecycleStatus.outranksActions, true);
  assert.equal(cols.state.outranksActions, true);
  assert.equal(cols.renewalCost.outranksActions, undefined);
  assert.equal(cols.issuedDate.outranksActions, undefined);
});

test('the columns that must never be cut wrap instead', () => {
  const cols = Object.fromEntries(licenseDeskColumns(T).map(c => [c.key, c]));
  for (const key of ['type', 'licenseNumber', 'expirationDate']) assert.equal(cols[key].wrap, true, key);
  for (const key of ['licenseNumber', 'expirationDate', 'type']) assert.equal(cols[key].priority, undefined, `${key} is never left out`);
});

// ─── fitDeskColumns itself ─────────────────────────────────────────
const cols = [
  { key: 'a', minWidth: 100 },
  { key: 'b', width: 50, priority: 2 },
  { key: 'c', width: 100, minWidth: 60 },
  { key: 'd', width: 80, priority: 1 },
  { key: 'e', width: 80, priority: 1 },
];
test('fitting: everything shows when there is room, or when the width is not known yet', () => {
  assert.deepEqual(keys(fitDeskColumns(cols, 1000, { actionsWidth: 100 }).columns), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(keys(fitDeskColumns(cols, null, { actionsWidth: 100 }).columns), ['a', 'b', 'c', 'd', 'e']);
});
test('fitting: the lowest priority leaves first, the one further right among equals', () => {
  // 100 + 50 + 100 + 80 + 80 = 410, plus 100 for actions.
  assert.deepEqual(keys(fitDeskColumns(cols, 500, { actionsWidth: 100 }).columns), ['a', 'b', 'c', 'd']);
  assert.deepEqual(keys(fitDeskColumns(cols, 400, { actionsWidth: 100 }).columns), ['a', 'b', 'c']);
  assert.deepEqual(keys(fitDeskColumns(cols, 300, { actionsWidth: 100 }).columns), ['a', 'c']);
});
test('fitting: then the actions cell goes compact, then the kept columns shrink to their minWidth', () => {
  const compact = fitDeskColumns(cols, 260, { actionsWidth: 100, compactActionsWidth: 50 });
  assert.deepEqual([keys(compact.columns), compact.actionsWidth, compact.compact], [['a', 'c'], 50, true]);
  assert.equal(compact.columns[1].width, 100);
  const tight = fitDeskColumns(cols, 220, { actionsWidth: 100, compactActionsWidth: 50 });
  assert.deepEqual([keys(tight.columns), tight.actionsWidth, tight.columns[1].width], [['a', 'c'], 50, 60]);
  assert.equal(tight.columns[0].width, undefined, 'the flexible column still takes what is left');
});
test('fitting: before a column that outranks the actions is left out, the actions cell goes compact', () => {
  const ranked = cols.map(c => (c.key === 'b' ? { ...c, outranksActions: true } : c));
  // d and e (priority 1) still go first with the actions whole: 100 + 50 + 100 + 100.
  assert.deepEqual([keys(fitDeskColumns(ranked, 350, { actionsWidth: 100, compactActionsWidth: 50 }).columns), fitDeskColumns(ranked, 350, { actionsWidth: 100, compactActionsWidth: 50 }).compact], [['a', 'b', 'c'], false]);
  // Then b stays and the actions go compact (without the flag b went: see above).
  const kept = fitDeskColumns(ranked, 300, { actionsWidth: 100, compactActionsWidth: 50 });
  assert.deepEqual([keys(kept.columns), kept.actionsWidth, kept.compact], [['a', 'b', 'c'], 50, true]);
  assert.deepEqual(keys(fitDeskColumns(cols, 300, { actionsWidth: 100, compactActionsWidth: 50 }).columns), ['a', 'c']);
  // Narrower still, b goes and the actions stay compact.
  const gone = fitDeskColumns(ranked, 260, { actionsWidth: 100, compactActionsWidth: 50 });
  assert.deepEqual([keys(gone.columns), gone.actionsWidth], [['a', 'c'], 50]);
});

test('fitting: a table whose columns ask for nothing keeps its layout', () => {
  const plain = [{ key: 'x', width: '20%' }, { key: 'y' }];
  assert.equal(adaptsToWidth(plain), false);
  const fit = fitDeskColumns(plain, 100, { actionsWidth: 122 });
  assert.equal(fit.columns, plain);
  assert.equal(fit.actionsWidth, 122);
});

// ─── DeskTable measuring and rendering, with React's own commit ────
const { doc } = installLiveDom();
const { DeskTable } = await loadScreens('export { default as DeskTable } from "./src/components/shared/DeskTable.jsx";');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
globalThis.__screen = { app: { theme: THEME, isDesktop: true, data: { settings: {} } } };

// The browser's answer for a box `box` CSS px wide inside a zoom of `zoom`:
// getBoundingClientRect reports both the box and the 100px probe scaled.
let box = 0, zoom = 1.35;
const Element = Object.getPrototypeOf(doc.createElement('div'));
const plainRect = Element.getBoundingClientRect;
Element.getBoundingClientRect = function () {
  const r = plainRect.call(this);
  if (this.getAttribute('aria-hidden') === 'true' && this.style.width === '100px') return { ...r, width: 100 * zoom };
  if (this.children.some(c => c.tagName === 'TABLE')) return { ...r, width: box * zoom };
  return r;
};
const observers = [];
globalThis.ResizeObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() {} };

const records = [{ id: 'l1', type: 'State Medical License', state: 'CO', licenseNumber: 'QA-THEME-AZ1', expirationDate: '2028-06-30', issuedDate: '2024-06-30', renewalCost: '450' }];
function mountTable(width) {
  box = width;
  const host = doc.body.appendChild(doc.createElement('div'));
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(DeskTable, {
    columns: licenseDeskColumns(T), items: records, status: () => null, actions: () => null,
    actionsWidth: ACTIONS, compactActionsWidth: COMPACT, defaultSort: { key: 'expirationDate', dir: 'asc' },
  })));
  const heads = () => doc.all(n => n.tagName === 'TH', host).map(th => [th.textContent.replace(/[▲▼]/g, ''), th.style.width]);
  const cell = label => { const i = heads().findIndex(([t]) => t === label); return doc.all(n => n.tagName === 'TD', host)[i]; };
  return { host, root, heads, cell };
}

test('DeskTable measures its own CSS pixels whatever the zoom, and renders the columns that fit', () => {
  const t = mountTable(Math.floor(tableWidth(1280, 'M')) + 2);
  assert.deepEqual(t.heads(), [['', '40px'], ['Type', ''], ['State', '64px'], ['Number', '128px'], ['Expires', '116px'], ['Status', '104px'], ['Actions', `${COMPACT}px`]]);
  for (const label of ['Type', 'Number', 'Expires']) assert.equal(t.cell(label).style.whiteSpace, 'normal', `${label} wraps`);
  assert.match(t.cell('Number').textContent, /^QA-THEME-AZ1$/);
  // The text size goes to XXL: the same box now holds fewer CSS pixels.
  box = Math.floor(tableWidth(1280, 'XXL')) + 2;
  flushSync(() => observers.forEach(cb => cb([])));
  assert.deepEqual(t.heads().map(([label]) => label), ['', 'Type', 'Number', 'Expires', 'Actions']);
  assert.equal(t.heads().at(-1)[1], `${COMPACT}px`, 'the actions cell went compact');
  assert.ok(parseFloat(t.heads()[2][1]) >= 92 && parseFloat(t.heads()[3][1]) >= 92);
  flushSync(() => t.root.unmount());
});

test('before it can measure (or with no ResizeObserver) DeskTable shows every column, as before', () => {
  const saved = globalThis.ResizeObserver;
  delete globalThis.ResizeObserver;
  try {
    const t = mountTable(300);
    assert.deepEqual(t.heads().map(([label]) => label), ['', 'Type', 'State', 'Number', 'Issued', 'Expires', 'Status', 'Cost', 'Actions']);
    flushSync(() => t.root.unmount());
  } finally { globalThis.ResizeObserver = saved; }
});
