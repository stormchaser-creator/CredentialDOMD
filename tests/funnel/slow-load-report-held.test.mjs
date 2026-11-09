// Ticket ebf25bf0 (2026-11-08): the first screen reported an account load
// "still waiting after 15 s" at once, even though the load's own retries
// (lib/supabase.js, up to 34 s) were still in flight and went on to succeed a
// moment later -- the owner was told "not fixed by itself" about a load that,
// in fact, recovered on its own. The report is now held the same way as a
// lost script chunk (lib/errorReport.js holdChunkFailure): a report of its
// recovery (hooks/useSlowLoad.js) resolves it "fixed", dropping the held
// report and sending a "Fixed by itself" event instead. The real
// lib/errorReport.js runs here with a fake window, clock, timers and
// sendBeacon; no endpoint, account or provider is reached. All data is
// synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as chunkRecovery from '../../src/utils/chunkRecovery.js';

const source = await readFile(new URL('../../src/lib/errorReport.js', import.meta.url), 'utf8');

function page() {
  const sent = [], listeners = new Map(), timers = [];
  let clock = Date.parse('2026-11-08T13:36:00Z');
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
  const context = vm.createContext({
    module: { exports: {} }, Error, JSON, Set, Date: { now: () => clock }, location: new URL('https://app.invalid/app/'),
    navigator: { userAgent: 'Synthetic browser', sendBeacon: (_to, body) => { const p = JSON.parse(body); sent.push({ kind: p.kind, message: p.message }); return true; } },
    window: { addEventListener: on }, document: { visibilityState: 'visible', addEventListener: on },
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
    console: { warn() {}, error() {} },
    require: name => {
      if (name === 'react') return { Component: class {}, createElement: () => null };
      if (name === '../utils/launchInvitation.js') return { redactLaunchInvitation: s => s };
      if (name === '../utils/chunkRecovery.js') return chunkRecovery;
      throw Error(`Unexpected dependency: ${name}`);
    },
  });
  context.exports = context.module.exports;
  vm.runInContext(transformSync(source, { loader: 'js', format: 'cjs', define: {
    'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://report.invalid', DEV: false }), '__APP_BUILD_ID__': '"synthetic"',
  } }).code, context);
  const api = context.module.exports;
  api.install();
  return { api, sent, fire: (name, event = {}) => (listeners.get(name) || []).forEach(fn => fn(event)), advance: ms => { clock += ms; for (const t of timers.splice(0)) { if (t.at <= clock) t.fn(); else timers.push(t); } } };
}

const errors = p => p.sent.filter(s => s.kind !== 'info');
const infos = p => p.sent.filter(s => s.kind === 'info');

test('a slow-load report resolved "fixed" sends no error, only one "Fixed by itself" event', () => {
  const p = page();
  p.api.reportSlowLoad('Account load still waiting after 15 s (account).', { event: 'load_slow', stage: 'account', seconds: 15 });
  p.advance(1000);
  assert.deepEqual(p.sent, [], 'nothing goes while the report is held');
  p.api.reportSlowLoad('Account load finished on its own after being reported slow.', { event: 'load_recovered' });
  p.advance(60000);
  assert.equal(errors(p).length, 0);
  assert.equal(infos(p).length, 1);
  assert.match(infos(p)[0].message, /^Fixed by itself: the account load finished/);
});

test('a slow-load report nobody resolves is still sent once after the hold', () => {
  const p = page();
  p.api.reportSlowLoad('Account load still waiting after 15 s (account).', { event: 'load_slow', stage: 'account', seconds: 15 });
  p.advance(44000);
  assert.deepEqual(p.sent, [], 'held past the load\'s own retries, a minute from the start of the wait');
  p.advance(2000);
  assert.equal(errors(p).length, 1);
  p.advance(60000);
  assert.equal(p.sent.length, 1);
});

test('a page hidden while the slow-load report is held sends it at once', () => {
  const p = page();
  p.api.reportSlowLoad('Account load still waiting after 15 s (account).', { event: 'load_slow', stage: 'account', seconds: 15 });
  p.fire('pagehide');
  assert.equal(errors(p).length, 1, 'pagehide sends the held report by beacon');
  p.advance(60000);
  assert.equal(p.sent.length, 1);
});

test('a slow load that ended on an error screen or a read-only device copy sends the held report, not "Fixed by itself"', () => {
  const p = page();
  p.api.reportSlowLoad('Account load still waiting after 15 s (account).', { event: 'load_slow', stage: 'account', seconds: 15 });
  p.api.reportSlowLoad('Account load ended without loading after being reported slow.', { event: 'load_failed' });
  assert.equal(errors(p).length, 1, 'the held slow-load error goes at once');
  assert.match(errors(p)[0].message, /still waiting after 15 s/);
  p.advance(60000);
  assert.equal(infos(p).length, 0, 'no "Fixed by itself" about a load that did not load');
  assert.equal(p.sent.length, 1);
});
