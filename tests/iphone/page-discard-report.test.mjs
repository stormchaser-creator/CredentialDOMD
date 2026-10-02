// The owner's iPhone, 2026-10-02: iOS discarded the installed app's page
// while he was in Gmail, between the share and its answer, and nothing said
// so. A page that finds its predecessor's alive marker reports it once
// (page_discarded, with share_in_flight and preview_open flags only); a page
// that left normally (pagehide) leaves none. Synthetic state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPageDiscardWatch, notePageState, _resetPageDiscardWatch, PAGE_ALIVE_KEY } from '../../src/utils/pageDiscard.js';

function webStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
function page() {
  const listeners = new Map();
  return {
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    fire: (t) => { for (const fn of listeners.get(t) || []) fn({}); },
  };
}

test('a page discarded with an invoice at the share sheet is reported once by the next page in the tab', () => {
  const session = webStorage();
  const reports = [];
  _resetPageDiscardWatch();
  assert.equal(startPageDiscardWatch({ report: (m, e) => reports.push(e), storage: session, win: page() }), null, 'a first page finds nothing');
  notePageState({ previewOpen: true });
  notePageState({ shareInFlight: true });
  // iOS discards it in Gmail: no pagehide. The tab loads again.
  _resetPageDiscardWatch();
  startPageDiscardWatch({ report: (m, e) => reports.push(e), storage: session, win: page() });
  assert.deepEqual(reports, [{ event: 'page_discarded', share_in_flight: true, preview_open: true }]);
  assert.ok(session.getItem(PAGE_ALIVE_KEY), 'this page is marked alive in turn');
});

test('a page that leaves normally (reload, update) reports nothing', () => {
  const session = webStorage();
  const reports = [];
  _resetPageDiscardWatch();
  const win = page();
  startPageDiscardWatch({ report: (m, e) => reports.push(e), storage: session, win });
  notePageState({ shareInFlight: true });
  win.fire('pagehide');
  _resetPageDiscardWatch();
  startPageDiscardWatch({ report: (m, e) => reports.push(e), storage: session, win: page() });
  assert.deepEqual(reports, []);
});

test('back from the back-forward cache, the page is marked alive again', () => {
  const session = webStorage();
  _resetPageDiscardWatch();
  const win = page();
  startPageDiscardWatch({ report: () => {}, storage: session, win });
  win.fire('pagehide');
  assert.equal(session.getItem(PAGE_ALIVE_KEY), null);
  win.fire('pageshow');
  assert.ok(session.getItem(PAGE_ALIVE_KEY));
});
