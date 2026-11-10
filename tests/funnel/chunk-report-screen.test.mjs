// Ticket 7bbd451d: a lost Clerk chunk could not be placed on the sign-in
// screen or AuthGate's wait view, because the report carried no screen. Now
// AuthGate tells the reporter which screen is up (setErrorScreen), and a
// report carries it in extra.screen, taken when the error happened, not when
// a held chunk failure is finally sent. The real src/lib/errorReport.js runs
// with a fake window, clock, timers and sendBeacon; nothing is reached.
// All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as chunkRecovery from '../../src/utils/chunkRecovery.js';

const source = await readFile(new URL('../../src/lib/errorReport.js', import.meta.url), 'utf8');

function page() {
  const sent = [], listeners = new Map(), timers = [];
  let clock = Date.parse('2026-10-31T18:13:50Z');
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
  const context = vm.createContext({
    module: { exports: {} }, Error, JSON, Set, Date: { now: () => clock }, location: new URL('https://app.invalid/app/'),
    navigator: { userAgent: 'Synthetic browser', sendBeacon: (_to, body) => { sent.push(JSON.parse(body)); return true; } },
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
  return {
    api, sent,
    lose: () => (listeners.get('unhandledrejection') || []).forEach(fn => fn({ reason: Object.assign(Error('Loading chunk 344 failed.'), { name: 'ChunkLoadError' }) })),
    advance: ms => { clock += ms; for (const t of timers.splice(0)) { if (t.at <= clock) t.fn(); else timers.push(t); } },
  };
}

test('a lost chunk on the wait view says so, even when it is sent after the screen changed', () => {
  const p = page();
  assert.equal(typeof p.api.setErrorScreen, 'function');
  p.api.setErrorScreen('wait');
  p.lose();
  p.api.setErrorScreen('sign-in');
  p.advance(60000);
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].extra.screen, 'wait');
});

test('an ordinary report carries the screen, and keeps a screen the caller gave', () => {
  const p = page();
  p.api.setErrorScreen('app');
  p.api.reportError('Synthetic failure one');
  p.api.reportError('Synthetic failure two', 'error', { screen: 'settings', step: 2 });
  assert.equal(p.sent[0].extra.screen, 'app');
  assert.deepEqual(p.sent[1].extra, { screen: 'settings', step: 2 });
});

test('no screen set, no screen sent', () => {
  const p = page();
  p.api.reportError('Synthetic failure');
  assert.deepEqual(p.sent[0].extra, {});
});
