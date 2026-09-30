// Ticket 292fcbce ("Logging against"), under React's own renderer
// (react-dom/client over the in-memory DOM in harness/live-dom.mjs). The Work
// Log holds the agreement on screen while a form is open by setting state
// during render, and Days & call reports what it has open from an effect in
// the child; both depend on React's real render and commit order, which the
// hand-driven hook runtime in component-harness cannot show. Synthetic
// contracts and dates only.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { installLiveDom } from './harness/live-dom.mjs';
import { loadScreens } from './harness/component-harness.mjs';
import { THEMES } from '../src/constants/themes.js';

// The clock and zone, pinned. The DOM stays installed to the end of the file:
// React finishes scheduled work after the last test, and it reads window.
const originalTimezone = process.env.TZ;
process.env.TZ = 'America/Denver';
const RealDate = globalThis.Date;
let NOW = '2026-09-29T10:00:00-06:00';
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return new RealDate(NOW).getTime(); }
};
// The Work Log's minute check (and a running timer's tick) may not hold the
// process open, even when a failed test leaves its page mounted.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => { const t = realSetInterval(...args); t?.unref?.(); return t; };
test.after(() => {
  globalThis.Date = RealDate;
  globalThis.setInterval = realSetInterval;
  if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone;
});

// Bundled before the DOM exists (jspdf, which the invoice export pulls in,
// takes a browser path when it sees a window); react-dom/client is loaded
// after, since it decides at load time whether it has a DOM.
const { WorkLog } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');
const { doc, win } = installLiveDom();
win.confirm = () => true;
win.alert = () => {};
// React reads a <select>'s options to mark the chosen one; the in-memory DOM
// keeps only elements, so they are its <option> children here.
const makeElement = doc.createElement.bind(doc);
doc.createElement = (tag) => {
  const el = makeElement(tag);
  if (tag === 'select') Object.defineProperty(el, 'options', { get: () => doc.all(n => n.tagName === 'OPTION', el) });
  return el;
};
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const h = React.createElement;
const TODAY = '2026-09-29';

const hourly = (id, facility) => ({ id, facility, payModel: 'hourly', hourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15, callStipend: 0, startDate: '2026-01-01', endDate: '2026-12-31' });
const NORTH = hourly('c-north', 'Synthetic North Hospital');
const SOUTH = hourly('c-south', 'Synthetic South Hospital');
const GROUP = { id: 'c-group', facility: 'Synthetic Valley Neurosurgical Group', payModel: 'daily', dayRate: 2000, callStipend: 1000, startDate: '2026-01-01', endDate: '2028-12-31' };
const row = (contractId, date = TODAY) => ({ id: `s-${contractId}-${date}`, contractId, date, kind: 'call', expected: 1000 });

// One Work Log on the page, over a synthetic account whose writes land in
// `data`; `refresh` re-renders it the way a records update does.
let mounted = null;
function page({ contracts, scheduleDays = [], storage = {}, props = {} }) {
  mounted?.unmount(); // one page at a time, even after a failed test
  const data = { settings: {}, locumContracts: contracts, workLog: [], dutyDays: [], invoices: [], taskNotes: [], scheduleDays };
  const write = (key, fn) => { data[key] = fn(data[key] || []); return true; };
  globalThis.__screen = {
    storage: { ...storage }, vault: {},
    app: {
      data, theme: THEMES.light, isDesktop: false, user: null, userIdRef: { current: null },
      addItem: (key, item) => write(key, l => [...l, item]),
      canAddItem: () => true,
      editItem: (key, item) => write(key, l => l.map(x => (x.id === item.id ? item : x))),
      deleteItem: (key, id) => write(key, l => l.filter(x => x.id !== id)),
    },
  };
  let force;
  function Page() {
    const [, setTick] = React.useState(0);
    force = () => setTick(n => n + 1);
    return h(WorkLog, props);
  }
  const host = doc.body.appendChild(doc.createElement('div'));
  const root = createRoot(host);
  flushSync(() => root.render(h(Page)));
  let gone = false;
  mounted = {
    data,
    refresh: () => flushSync(() => force()),
    unmount: () => {
      if (gone) return;
      gone = true;
      flushSync(() => root.unmount());
      for (const c of [...doc.body.childNodes]) doc.body.removeChild(c); // the page and any dialog it left open
    },
  };
  return mounted;
}
test.afterEach(() => mounted?.unmount());

const propsOf = (el) => el[Object.keys(el).find(k => k.startsWith('__reactProps$'))];
const picker = () => doc.all(n => n.tagName === 'SELECT' && n.getAttribute('aria-labelledby') === 'work-log-contract')[0];
const shown = () => propsOf(picker()).value;
const press = (text) => {
  const b = doc.all(n => n.tagName === 'BUTTON' && n.textContent.includes(text))[0];
  assert.ok(b, `button: ${text}`);
  flushSync(() => propsOf(b).onClick({ stopPropagation() {}, preventDefault() {} }));
};
const closeDialog = () => press('Cancel');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('live: the schedule sets the default, and a pick changes it', async () => {
  const p = page({ contracts: [NORTH, SOUTH], scheduleDays: [row(SOUTH.id)], storage: { lastContract: NORTH.id } });
  assert.equal(shown(), SOUTH.id);
  assert.ok(doc.body.textContent.includes('On your schedule today'));
  flushSync(() => propsOf(picker()).onChange({ target: { value: NORTH.id } }));
  assert.equal(shown(), NORTH.id);
  await settle();
  assert.equal(shown(), NORTH.id);
});

test('live: a schedule that lands while Log past time is open waits until it closes', async () => {
  const p = page({ contracts: [NORTH, SOUTH], storage: { lastContract: NORTH.id } });
  assert.equal(shown(), NORTH.id);
  press('Log past time');
  p.data.scheduleDays = [row(SOUTH.id)];
  p.refresh();
  await settle();
  assert.equal(shown(), NORTH.id, 'held while the form is open');
  closeDialog();
  await settle();
  assert.equal(shown(), SOUTH.id, 'closed: the schedule default applies');
});

test('live: Days & call holds its agreement while a day is open in it', async () => {
  const p = page({ contracts: [NORTH, GROUP], storage: { lastContract: GROUP.id } });
  assert.equal(shown(), GROUP.id);
  press('+ Log a day');
  await settle();
  p.data.scheduleDays = [row(NORTH.id)];
  p.refresh();
  await settle();
  assert.equal(shown(), GROUP.id, 'the day being logged stays on its agreement');
  assert.ok(doc.all(n => n.getAttribute('role') === 'dialog' && n.getAttribute('aria-label') === 'Log a day').length === 1, 'and its form is still open');
  closeDialog();
  await settle();
  assert.equal(shown(), NORTH.id, 'closed: the schedule default applies');
});

test('live: stopping a restored timer leaves the picker where it was', async () => {
  const timer = { contractId: NORTH.id, type: 'Call', startedAt: '2026-09-29T12:40:00.000Z' };
  const p = page({ contracts: [NORTH, SOUTH], scheduleDays: [row(SOUTH.id)], storage: { timer } });
  assert.equal(shown(), NORTH.id);
  press('Stop & Log');
  await settle();
  assert.equal(p.data.workLog.at(-1)?.contractId, NORTH.id, "logged on the timer's contract");
  assert.equal(shown(), NORTH.id, 'no flip to the schedule');
});

test('live: the call day turning over while Work is open moves the default', async () => {
  NOW = '2026-09-29T06:50:00-06:00';
  const p = page({ contracts: [NORTH, SOUTH], scheduleDays: [row(NORTH.id, '2026-09-28'), row(SOUTH.id)] });
  assert.equal(shown(), NORTH.id);
  NOW = '2026-09-29T07:01:00-06:00';
  // Coming back to the app runs the same check the minute timer does.
  const onShow = doc.listeners.filter(([type]) => type === 'visibilitychange').map(([, fn]) => fn);
  assert.ok(onShow.length > 0, 'Work listens for coming back to the app');
  doc.visibilityState = 'visible';
  flushSync(() => onShow.forEach(fn => fn()));
  await settle();
  assert.equal(shown(), SOUTH.id);
  NOW = '2026-09-29T10:00:00-06:00';
});
