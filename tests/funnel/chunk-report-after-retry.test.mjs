// Ticket 7bbd451d (2026-10-31): an iPhone on the sign-in screen lost one of
// Clerk's script chunks ("Loading chunk 344 failed"). The screen remounts its
// form by itself 1.2 s later, but the error reporter had already sent the
// error, so a ticket said the app had not fixed it. Now the report is held
// until the screen says how it ended, and is never lost: a timeout or a page
// that goes sends it. The real src/lib/errorReport.js runs with a fake window,
// clock, timers and sendBeacon, and the real AuthPage with a stub Clerk; no
// endpoint, account or provider is reached. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, transformSync } from 'esbuild';
import vm from 'node:vm';
import * as chunkRecovery from '../../src/utils/chunkRecovery.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = await readFile(new URL('../../src/lib/errorReport.js', import.meta.url), 'utf8');

function page() {
  const sent = [], listeners = new Map(), timers = [];
  let clock = Date.parse('2026-10-31T18:13:50Z');
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
  const doc = { visibilityState: 'visible', addEventListener: on };
  const context = vm.createContext({
    module: { exports: {} }, Error, JSON, Set, Date: { now: () => clock }, location: new URL('https://app.invalid/app/'),
    navigator: { userAgent: 'Synthetic browser', sendBeacon: (_to, body) => { const p = JSON.parse(body); sent.push({ kind: p.kind, message: p.message }); return true; } },
    window: { addEventListener: on }, document: doc,
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
    api, sent, doc,
    fire: (name, event = {}) => (listeners.get(name) || []).forEach(fn => fn(event)),
    lose: () => (listeners.get('unhandledrejection') || []).forEach(fn => fn({ reason: Object.assign(Error('Loading chunk 344 failed.\n(error: https://clerk.example.invalid/npm/@clerk/clerk-js@5.128.0/dist/framework_clerk.browser_5.128.0.js)'), { name: 'ChunkLoadError' }) })),
    advance: ms => { clock += ms; for (const t of timers.splice(0)) { if (t.at <= clock) t.fn(); else timers.push(t); } },
  };
}

const errors = p => p.sent.filter(s => s.kind !== 'info');
const infos = p => p.sent.filter(s => s.kind === 'info');

test('a lost chunk the sign-in screen recovers from sends no error, only one "Fixed by itself" event', () => {
  const p = page();
  p.lose();
  p.advance(1200);
  assert.deepEqual(p.sent, [], 'nothing goes before the retry has run');
  p.api.resolveChunkFailure('fixed');
  p.advance(60000);
  assert.equal(errors(p).length, 0);
  assert.equal(infos(p).length, 1);
  assert.match(infos(p)[0].message, /^Fixed by itself: the sign-in form loaded/);
});

test('a lost chunk the retry did not fix is sent once, as it was', () => {
  const p = page();
  p.lose();
  p.api.resolveChunkFailure('failed');
  p.advance(60000);
  assert.deepEqual(p.sent.map(s => s.kind), ['unhandledrejection']);
  assert.match(p.sent[0].message, /Loading chunk 344 failed/);
});

test('a lost chunk nobody resolves (outside the sign-in screen) is still sent once after the hold', () => {
  const p = page();
  p.lose();
  p.advance(14000);
  assert.deepEqual(p.sent, []);
  p.advance(2000);
  assert.equal(errors(p).length, 1);
  p.advance(60000);
  assert.equal(p.sent.length, 1);
});

test('a page hidden or left while the report is held sends it at once', () => {
  const p = page();
  p.lose();
  p.fire('pagehide');
  assert.equal(errors(p).length, 1, 'pagehide sends the held error by beacon');
  p.advance(60000);
  assert.equal(p.sent.length, 1);
  const q = page();
  q.lose();
  q.doc.visibilityState = 'hidden';
  q.fire('visibilitychange');
  assert.equal(errors(q).length, 1, 'switching away on an iPhone sends it too');
});

test('other errors are still sent at once', () => {
  const p = page();
  p.fire('unhandledrejection', { reason: Error('Synthetic failure') });
  assert.equal(errors(p).length, 1);
});

// The real AuthPage, with Clerk and the reporter stubbed.
const built = await build({entryPoints:[`${root}src/components/pages/AuthPage.jsx`],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime'],define:{'import.meta.env':JSON.stringify({VITE_CLERK_PUBLISHABLE_KEY:'pk_live_synthetic'})},plugins:[{name:'auth-report-fixture',setup(b){
  b.onResolve({filter:/^@clerk\/clerk-react$|visitBeacon|authOffer|lib\/errorReport\.js$/},a=>({path:a.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path.includes('clerk-react')?'import React from "react";export const SignIn=()=>React.createElement("div",{"data-clerk-widget":""});export const useClerk=()=>null;export const useSignIn=()=>({isLoaded:false,signIn:null});export const useSignUp=()=>({isLoaded:false,signUp:null});':path.includes('errorReport')?'export const resolveChunkFailure=o=>globalThis.__chunkOutcomes.push(o);':path.includes('visitBeacon')?'export const sendAuthVisit=()=>{};':'export const loadAuthOffer=async()=>null;',loader:'jsx',resolveDir:root}));
}}]});

function authPage() {
  const saved = { window: globalThis.window, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, MutationObserver: globalThis.MutationObserver };
  const outcomes = globalThis.__chunkOutcomes = [];
  const listeners = new Map(), timers = new Map(), effects = [], cleanups = [], states = [], refs = [], observers = [];
  let fieldShown = false, next = 0, si = 0, ri = 0;
  const element = { querySelector: () => fieldShown ? { value: '' } : null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; this.on = false; observers.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } };
  globalThis.window = { location: { hash: '', pathname: '/app/' }, innerWidth: 393, history: { replaceState() {} }, addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n) };
  globalThis.setTimeout = (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }; globalThis.clearTimeout = id => timers.delete(id);
  const react = { ...React, useEffect: fn => effects.push(fn), useRef: initial => { const i = ri++; return refs[i] ??= (i === 0 ? { current: element } : { current: initial }); }, useState: initial => { const i = si++; states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; } };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'react' ? react : require(name), mod, mod.exports);
  renderToStaticMarkup(React.createElement(mod.exports.default));
  for (const fx of effects) { const cleanup = fx(); if (typeof cleanup === 'function') cleanups.push(cleanup); }
  return {
    outcomes, states,
    fail() { listeners.get('unhandledrejection')({ reason: Error('Loading chunk 344 failed.') }); },
    fireRetry() { for (const [id, t] of [...timers]) if (t.ms === 1200) { timers.delete(id); t.fn(); } },
    // Clerk mounts the remounted form a moment later: the DOM changes, then a field is there.
    mutate() { for (const o of observers) if (o.on) o.fn([]); },
    showFields() { fieldShown = true; },
    close() { for (const cleanup of cleanups) cleanup(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } delete globalThis.__chunkOutcomes; },
  };
}

test('AuthPage says "fixed" once the remounted form shows a field, even when Clerk mounts it later', () => {
  const f = authPage();
  try {
    f.fail();
    f.fireRetry();
    assert.equal(f.states[0].version, 1, 'the form was remounted');
    assert.deepEqual(f.outcomes, [], 'nothing is decided at the remount itself');
    f.mutate();
    assert.deepEqual(f.outcomes, [], 'a change with no field yet is not the form');
    f.showFields();
    f.mutate();
    f.mutate();
    assert.deepEqual(f.outcomes, ['fixed']);
  } finally { f.close(); }
});

test('AuthPage says "failed" when the retry fails too, and not "fixed" after it', () => {
  const f = authPage();
  try {
    f.fail();
    f.fireRetry();
    f.fail();
    assert.equal(f.states[2], true, 'the notice shows');
    assert.deepEqual(f.outcomes, ['failed']);
    f.showFields();
    f.mutate();
    assert.deepEqual(f.outcomes, ['failed']);
  } finally { f.close(); }
});
