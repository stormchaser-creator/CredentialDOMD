import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, click, pinClock, THEME } from '../harness/component-harness.mjs';

// Practice on a phone (the QA lab's 375 and 390 px journeys, 32 px floor):
//   PRAC-015 the sub-tab strip cut "Invoices" and "Contracts" to "Invoi..." and
//            "Cont...": every tab was forced to 45 px (flex 1, min-width 0,
//            overflow hidden, ellipsis). A flex item's minimum is now its
//            label, and a screen too narrow for all seven scrolls the strip.
//   PRAC-001 Add Agreement: "Use a document already uploaded" was 16 px tall
//            (padding 0), the split-calls checkbox row 21 px.
//   PRAC-017 agreement card: edit, Archive and delete were 29 px tall.
//   PRAC-011 work log entry: edit and delete were 30 x 26 and 28 x 24.
//   PRAC-002 invoice day picker: "All days" and "None" were 31 px tall.
//   PRAC-020 To do: the tap-to-edit task text was a 20 px line.
// The render harness has no layout engine, so each control's box is worked
// out from its own style the way the browser does (content + padding +
// border, or its min-height). Measured in Chromium at 375 and 390 px after
// the change: tabs 40-59 x 32 with no label cut, 32 x 32 icons, 216 x 32,
// 67 x 32, 73 x 32 / 57 x 32 and a 34 px task target. Synthetic data only.

pinClock(test, 'America/Chicago', '2026-09-28T12:00:00-05:00');
// LocumDashboard reaches the Practice archive (ReadOnlyRecords), which needs
// the real cloud module's exports; it is bundled on its own for that.
const stored = new Map();
globalThis.localStorage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: k => stored.delete(k) };
const { LocumDashboard } = await loadScreens('export {default as LocumDashboard} from "./src/components/features/locum/LocumDashboard.jsx";', { real: ['lib/supabase', 'utils/storageScope', 'utils/privateVault'] });
delete globalThis.localStorage;
const { Contracts, DocAttach, WorkLog, InvoiceDayPicker, TaskNotes } = await loadScreens([
  'export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";',
  'export {default as DocAttach} from "./src/components/features/DocAttach.jsx";',
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as InvoiceDayPicker} from "./src/components/shared/InvoiceDayPicker.jsx";',
  'export {default as TaskNotes} from "./src/components/features/locum/TaskNotes.jsx";',
].join('\n'));

const MIN_TAP = 32;
// A div or label inherits base.css's body line-height (1.5). A <button> does
// not: the browser's own button font resets it to "normal", which for Inter
// is 1.21 (so 12 px text at 7 px padding is the 31 px the lab measured).
const BODY_LINE_HEIGHT = 1.5;
const BUTTON_LINE_HEIGHT = 1.21;
const ICON = 14; // EditIcon and TrashIcon (src/components/shared/Icons.jsx)
/** CSS shorthand ("6px 8px", 5, "-11px -13px -3px") as [top, right, bottom, left] px. */
const sides = (v) => {
  if (v == null) return [0, 0, 0, 0];
  const p = String(v).trim().split(/\s+/).map(x => parseFloat(x) || 0);
  const [t, r = t, b = t, l = r] = p;
  return [t, r, b, l];
};
const border = (s) => (s.border && s.border !== 'none' ? parseFloat(String(s.border)) || 0 : 0);
/** A control's border-box height and width as the browser lays it out. */
const box = (el, { content, width = 0 } = {}) => {
  const s = el.props.style || {};
  const line = s.lineHeight || (el.type === 'button' ? BUTTON_LINE_HEIGHT : BODY_LINE_HEIGHT);
  content ??= (s.fontSize || 15) * line;
  const [t, r, b, l] = sides(s.padding);
  return {
    h: Math.max(s.minHeight || 0, content + t + b + 2 * border(s)),
    w: Math.max(s.minWidth || 0, width + l + r + 2 * border(s)),
  };
};
const phone = (m, extra = {}) => { Object.assign(globalThis.__screen.app, { isDesktop: false, plan: 'locum', isDevMode: false, limitedLaunch: { enabled: false }, practiceReadOnly: false }, extra); return m; };

const AGREEMENT = { id: 'k1', facility: 'Synthetic Regional', agency: 'Synthetic Staffing', payModel: 'hourly', hourlyRate: 200, incrementMinutes: 15,
  coveragePeriods: [{ start: '2026-09-01', end: '2026-10-30' }], startDate: '2026-09-01', endDate: '2026-10-30' };

test('PRAC-015: no sub-tab label can be cut; each tab is at least its label wide and 32 px tall; a narrow phone scrolls the strip', () => {
  const m = phone(mount(LocumDashboard, { data: { locumContracts: [AGREEMENT] } }));
  const tabs = nodes(m.render()).filter(n => n.type === 'button' && 'aria-pressed' in n.props);
  assert.deepEqual(tabs.map(textOf), ['Work', 'RVUs', 'Sched.', 'Invoices', 'Contracts', 'Exp.', 'To do'], 'the labels are spelled out, not shortened to fit');
  for (const t of tabs) {
    const s = t.props.style;
    assert.equal(s.flex, 1, 'equal widths where they fit (the desk design)');
    // min-width 0, or overflow other than visible (which zeroes a flex
    // item's automatic minimum), let the row squeeze a label under its width.
    assert.equal(s.minWidth, undefined, `${textOf(t)}: no min-width 0`);
    assert.equal(s.overflow, undefined, `${textOf(t)}: no overflow hidden`);
    assert.equal(s.textOverflow, undefined, `${textOf(t)}: no ellipsis`);
    assert.equal(s.whiteSpace, 'nowrap');
    assert.ok(box(t).h >= MIN_TAP, `${textOf(t)} is ${box(t).h} px tall`);
  }
  const strip = find(m.render(), n => n.type === 'div' && Array.isArray(n.props.children) && n.props.children.length === 7, 'the strip');
  assert.equal(strip.props.style.overflowX, 'auto', 'too narrow for seven labels: the strip scrolls, the page does not');
});

test('PRAC-017: the agreement card\'s edit, Archive and delete are at least 32 x 32, 6 px apart', () => {
  const m = phone(mount(Contracts, { data: { locumContracts: [AGREEMENT] } }));
  const tree = m.render();
  const edit = find(tree, n => n.type === 'button' && n.props['aria-label'] === 'Edit', 'edit');
  const archive = find(tree, n => n.type === 'button' && textOf(n).trim() === 'Archive', 'Archive');
  const del = find(tree, n => n.type === 'button' && n.props['aria-label'] === 'Delete agreement', 'delete');
  for (const [name, el, opts] of [['edit', edit, { content: ICON, width: ICON }], ['Archive', archive, {}], ['delete', del, { content: ICON, width: ICON }]]) {
    const b = box(el, opts);
    assert.ok(b.h >= MIN_TAP, `${name} is ${b.h} px tall`);
    if (opts.width) assert.ok(b.w >= MIN_TAP, `${name} is ${b.w} px wide`);
  }
  const row = find(tree, n => n.type === 'div' && nodes(n.props.children).includes(archive) && n.props.style?.gap != null, 'button row');
  assert.ok(row.props.style.gap >= 6, 'a tap meant for edit does not land on Archive');
});

test('PRAC-001: the Add Agreement split-calls checkbox row is at least 32 px tall', () => {
  const m = phone(mount(Contracts, { data: { locumContracts: [] } }));
  click(m, 'Add');
  const label = find(m.render(), n => n.type === 'label' && /Split calls that cross the start of the call day/.test(textOf(n)), 'split-calls row');
  const b = box(label);
  assert.ok(b.h >= MIN_TAP, `the row is ${b.h} px tall`);
});

test('PRAC-001: "Use a document already uploaded" is a 32 px tall target, not a 16 px line', () => {
  const doc = { id: 'd1', name: 'synthetic-agreement.pdf', type: 'application/pdf', uploadedAt: '2026-09-01T00:00:00Z' };
  const m = phone(mount(DocAttach, { data: { documents: [doc] }, props: { setForm() {}, attachedDocs: [], setAttachedDocs() {}, existingDocs: [{ doc, ready: true }] } }));
  const toggle = find(m.render(), n => n.type === 'button' && textOf(n) === 'Use a document already uploaded', 'toggle');
  assert.ok(box(toggle).h >= MIN_TAP, `the toggle is ${box(toggle).h} px tall`);
  assert.equal(toggle.props.style.display, 'inline-flex', 'the words sit in the middle of the target');
});

test('PRAC-011: a work log entry\'s edit and delete are at least 32 x 32 on a phone', () => {
  const entry = { id: 'w1', contractId: 'k1', type: 'Call', date: '2026-09-27', startTime: '2026-09-27T14:00:00.000Z', endTime: '2026-09-27T16:00:00.000Z', durationMin: 120, billedMin: 120 };
  const m = phone(mount(WorkLog, { data: { locumContracts: [AGREEMENT], workLog: [entry] }, storage: { lastContract: 'k1' } }));
  const tree = m.render();
  for (const label of ['Edit entry', 'Delete entry']) {
    const b = box(find(tree, n => n.type === 'button' && n.props['aria-label'] === label, label), { content: ICON, width: ICON });
    assert.ok(b.h >= MIN_TAP && b.w >= MIN_TAP, `${label} is ${b.w} x ${b.h}`);
  }
});

test('PRAC-002: the invoice day picker\'s "All days" and "None" are at least 32 px tall', () => {
  const days = [{ key: '2026-09-27', amount: 400 }, { key: '2026-09-28', amount: 200 }];
  const m = phone(mount(InvoiceDayPicker, { props: { days, selected: new Set(['2026-09-27']), onChange() {}, T: THEME } }));
  for (const label of ['All days', 'None']) {
    const b = box(find(m.render(), n => n.type === 'button' && textOf(n) === label, label));
    assert.ok(b.h >= MIN_TAP, `${label} is ${b.h} px tall`);
  }
});

test('PRAC-020: a one-line task\'s tap-to-edit target is at least 32 px tall, and nothing on the card moves', () => {
  const m = phone(mount(TaskNotes, { data: { locumContracts: [AGREEMENT], taskNotes: [{ id: 't1', text: 'Synthetic follow-up', capturedAt: '2026-09-28T12:00:00Z' }] } }));
  const row = find(m.render(), n => typeof n.type === 'function' && n.props?.t?.id === 't1', 'task row');
  const text = find(row.type(row.props), n => n.props?.role === 'button' && textOf(n) === 'Synthetic follow-up', 'task text');
  const s = text.props.style;
  const b = box(text);
  assert.ok(b.h >= MIN_TAP, `the target is ${b.h} px tall`);
  // Negative margins equal to the added padding: the words and the lines
  // under them stay where they were.
  const [mt, mr, mb, ml] = sides(s.margin), [pt, pr, pb, pl] = sides(s.padding);
  assert.deepEqual([mt + pt, mr + pr, mb + pb, ml + pl], [0, 0, 0, 0]);
  assert.equal(typeof text.props.onClick, 'function', 'still the button that opens the editor');
});
