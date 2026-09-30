// OPS-008: a signed-in member reloading while the account loads aborts the
// page's own reads. "Account load stopped", "Account records load stopped" and
// "Membership check failed (network:...)" then reached the owner's Admin >
// Errors and notifier although nothing failed. The real src/lib/errorReport.js
// runs here with a fake window, clock, timers and sendBeacon; no endpoint,
// account or provider is reached. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const source = await read('src/lib/errorReport.js');

function page() {
  const sent = [], listeners = new Map(), timers = [];
  let clock = Date.parse('2026-09-30T12:00:00Z');
  const context = vm.createContext({
    module: { exports: {} }, Error, JSON, Set, Date: { now: () => clock }, location: new URL('https://app.invalid/app/'),
    navigator: { userAgent: 'Synthetic browser', sendBeacon: (_to, body) => { sent.push(JSON.parse(body).message); return true; } },
    window: { addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } },
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; },
    console: { warn() {}, error() {} },
    require: name => {
      if (name === 'react') return { Component: class {}, createElement: () => null };
      if (name === '../utils/launchInvitation.js') return { redactLaunchInvitation: s => s };
      throw Error(`Unexpected dependency: ${name}`);
    },
  });
  context.exports = context.module.exports;
  vm.runInContext(transformSync(source, { loader: 'js', format: 'cjs', define: {
    'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://report.invalid', DEV: false }), '__APP_BUILD_ID__': '"synthetic"',
  } }).code, context);
  const api = context.module.exports;
  api.install();
  return {
    api, sent,
    fire: name => (listeners.get(name) || []).forEach(fn => fn({})),
    // Advance the clock and run the timers that are due, as the browser would
    // on a page that is still open, including timers those timers set that
    // are already due.
    advance: ms => {
      clock += ms;
      for (let ran = true; ran;) {
        ran = false;
        for (const t of timers.splice(0)) { if (t.at <= clock) { t.fn(); ran = true; } else timers.push(t); }
      }
    },
  };
}

const LOAD = 'Account records load stopped (DATA-LOAD-UNAVAILABLE).';
const IDENTITY = 'Account load stopped (ID-PROFILE-UNKNOWN).';
const MEMBERSHIP = 'Membership enrollment failed (network:membership_information_unavailable)';

test('a reload that aborts the account load and the membership check reports nothing', () => {
  // The reload: beforeunload, then the old page's reads abort as it goes.
  const p = page();
  p.fire('beforeunload');
  for (const message of [LOAD, IDENTITY, MEMBERSHIP]) p.api.reportUnlessLeaving(message, 'error', { event: 'access_enrollment_failed' });
  p.advance(5000);
  assert.deepEqual(p.sent, []);
  // Aborts that land after pagehide (Chromium ends the old document's fetches then).
  const q = page();
  q.fire('pagehide');
  q.api.reportUnlessLeaving(IDENTITY);
  q.advance(60000);
  assert.deepEqual(q.sent, []);
});

test('a stop reported just before the reload began is dropped with the page', () => {
  const p = page();
  p.api.reportUnlessLeaving(MEMBERSHIP);
  p.advance(300);
  p.fire('beforeunload');
  p.advance(5000);
  assert.deepEqual(p.sent, []);
});

test('a load that stops on a page that stays is still reported, once, with its fixed text', () => {
  const p = page();
  p.api.reportUnlessLeaving(LOAD);
  p.api.reportUnlessLeaving(LOAD);
  assert.deepEqual(p.sent, [], 'held for a moment');
  p.advance(1500);
  assert.deepEqual(p.sent, [LOAD]);
});

test('Stay on a leave prompt, or a back-forward-cache return, reports again', () => {
  const stay = page();
  stay.fire('beforeunload');
  stay.advance(11000);
  stay.api.reportUnlessLeaving(IDENTITY);
  stay.advance(1500);
  assert.deepEqual(stay.sent, [IDENTITY]);
  const back = page();
  back.fire('pagehide');
  back.fire('pageshow');
  back.api.reportUnlessLeaving(LOAD);
  back.advance(1500);
  assert.deepEqual(back.sent, [LOAD]);
});

// The review of the first fix (OPS-008): a report dropped while the page was
// being left left its code marked as sent in createAccessRefreshReporter, so
// the next real failure with that code was never reported; and a Stay on a
// "Leave site?" prompt kept dropping reports for ten seconds.
const CHECK = 'Membership check failed (network:membership_information_unavailable)';
const failure = () => Object.assign(new Error('Synthetic membership read stopped'), { phase: 'network', code: 'membership_information_unavailable' });

test('a stop on a page kept by Stay on a leave prompt is held for the leave window, then reported', () => {
  const stay = page();
  stay.fire('beforeunload');        // "Leave site?" (unrecorded invoices), answered Stay
  stay.advance(3000);
  stay.api.reportUnlessLeaving(IDENTITY);
  stay.advance(5000);
  assert.deepEqual(stay.sent, [], 'held while the page may still go');
  stay.advance(3000);
  assert.deepEqual(stay.sent, [IDENTITY], 'the page stayed: reported');
  // The same stop on a page that then goes is never sent.
  const leave = page();
  leave.fire('beforeunload');
  leave.api.reportUnlessLeaving(IDENTITY);
  leave.advance(2000);
  leave.fire('pagehide');
  leave.advance(60000);
  assert.deepEqual(leave.sent, []);
  // Nor on one that goes into the back-forward cache and comes back.
  const back = page();
  back.fire('beforeunload');
  back.api.reportUnlessLeaving(LOAD);
  back.fire('pagehide');
  back.advance(30000);
  back.fire('pageshow');
  back.advance(30000);
  assert.deepEqual(back.sent, []);
});

test('a membership code dropped as the page was left is not counted as sent: the next real failure with it is reported', async () => {
  const { createAccessRefreshReporter } = await import('../src/utils/accessRefreshFailure.js');
  // Back-forward cache: the abort lands after pagehide and is dropped; the
  // page is restored, and the membership read then really fails.
  const p = page();
  const reportCheck = createAccessRefreshReporter(p.api.reportUnlessLeaving);
  p.fire('pagehide');
  reportCheck(failure());
  p.fire('pageshow');
  p.advance(60000);
  assert.deepEqual(p.sent, [], 'the abort is not reported');
  assert.equal(reportCheck(failure()), true, 'the code was never sent, so it is not suppressed');
  p.advance(1500);
  assert.deepEqual(p.sent, [CHECK]);
  assert.equal(reportCheck(failure()), false, 'and once sent, it is sent once');
  p.advance(1500);
  assert.deepEqual(p.sent, [CHECK]);
  // A failure inside the leave window, dropped when the page then hides and
  // is restored; the next failure with the code is still reported.
  const q = page();
  const reportAgain = createAccessRefreshReporter(q.api.reportUnlessLeaving);
  q.fire('beforeunload');
  reportAgain(failure());
  q.advance(500);
  q.fire('pagehide');
  q.fire('pageshow');
  q.advance(60000);
  assert.deepEqual(q.sent, []);
  reportAgain(failure());
  q.advance(1500);
  assert.deepEqual(q.sent, [CHECK]);
  // Stay on a leave prompt, then a real failure within the window: reported
  // when the window has passed, not dropped and suppressed for the session.
  const r = page();
  const reportStay = createAccessRefreshReporter(r.api.reportUnlessLeaving);
  r.fire('beforeunload');
  r.advance(2000);
  reportStay(failure());
  r.advance(9000);
  assert.deepEqual(r.sent, [CHECK]);
});

test('the reporter forgets a code only when its report says it was dropped', async () => {
  const { createAccessRefreshReporter } = await import('../src/utils/accessRefreshFailure.js');
  const calls = [];
  const report = createAccessRefreshReporter((message, kind, extra, options) => calls.push({ message, options }));
  assert.equal(report(failure()), true);
  assert.equal(report(failure()), false, 'pending or sent: not sent twice');
  calls[0].options.onDropped();
  assert.equal(report(failure()), true, 'dropped: the next failure is reported');
  assert.deepEqual(calls.map(c => c.message), [CHECK, CHECK]);
});

test('a render crash is still reported at once, leaving or not', () => {
  const p = page();
  p.fire('beforeunload');
  p.api.reportError(new Error('Synthetic render crash'), 'react');
  assert.deepEqual(p.sent, ['Synthetic render crash']);
});

test('the account load and the membership check report through reportUnlessLeaving', async () => {
  const app = await read('src/context/AppContext.jsx');
  for (const message of ['Account records load stopped (', 'Account load stopped (', "Account load used this device's copy ("]) {
    const at = app.indexOf(message);
    assert.ok(at > 0, message);
    assert.match(app.slice(Math.max(0, at - 40), at), /reportUnlessLeaving\(`$/, `${message} is reported unless the page is being left`);
  }
  const hook = await read('src/hooks/useLimitedLaunchAccess.js');
  assert.match(hook, /createAccessRefreshReporter\(reportUnlessLeaving\)/);
  assert.match(hook, /createAccessRefreshReporter\(reportUnlessLeaving, \{ label: "Membership enrollment failed"/);
  assert.doesNotMatch(hook, /createAccessRefreshReporter\(reportError/);
});
