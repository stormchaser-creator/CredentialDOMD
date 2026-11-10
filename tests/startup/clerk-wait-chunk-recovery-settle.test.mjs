// AuthGate's wait-screen reload (tests/startup/clerk-wait-chunk-recovery.test.mjs)
// defers the chunk failure it is reloading to fix instead of resolving it,
// since it cannot know yet whether the reload will work (src/lib/errorReport.js
// deferChunkFailure). This file pins what has to happen across that reload,
// in the same tab: the guard that stops a reload loop is read back on the
// next page, and once Clerk answers it is cleared and the fix is reported,
// so a failure the reload fixed is not silently left unresolved, and a later,
// unrelated failure on the same build still gets its own reload. All data here
// is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

const built = await build({
  entryPoints: [`${root}src/AuthGate.jsx`], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'gate-settle-fixture', setup(b) {
    const stub = { '@clerk/clerk-react': 'clerk', './components/pages/AuthPage.jsx': 'auth', './components/shared/UpdatePrompt': 'update', './utils/offlineSession': 'offline', './utils/supportDeepLink.js': 'link', './App.jsx': 'app', './lib/errorReport.js': 'errors' };
    b.onResolve({ filter: /.*/ }, args => (stub[args.path] ? { path: stub[args.path], namespace: 'fixture' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      clerk: 'export const useAuth = () => globalThis.__gate.auth;',
      auth: 'import React from "react"; export default () => React.createElement("main", { "data-sign-in": "" });',
      update: 'import React from "react"; export default props => React.createElement("aside", { "data-update": String(props.allowAutomaticUpdates) });',
      offline: 'export const readLastIdentity = () => globalThis.__gate.identity;',
      link: 'export const takeAppDeepLink = () => null; export const stashAppDeepLink = () => {};',
      app: 'import React from "react"; export default () => React.createElement("div", { "data-app": "" });',
      errors: 'export const setErrorScreen = () => {}; export const deferChunkFailure = () => globalThis.__gateCalls.push("defer"); export const reportError = (message, kind) => globalThis.__gateCalls.push(["report", message, kind]);',
    }[path], loader: 'jsx', resolveDir: root }));
  } }],
});

// One shared fake sessionStorage, the way a real tab keeps it across a
// reload; everything else (window, timers, React hooks) is fresh per page,
// the way a real reload replaces them.
function sharedSessionStorage() {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
}

function page(auth, identity, storage, calls) {
  globalThis.__gate = { auth, identity };
  globalThis.__gateCalls = calls;
  const listeners = new Map();
  let reloads = 0;
  const timers = new Map();
  let nextTimer = 0;
  globalThis.window = {
    location: { reload: () => { reloads += 1; } },
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    removeEventListener: (name, fn) => { const arr = listeners.get(name); if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); } },
  };
  globalThis.setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.sessionStorage = storage;

  const effects = [], cleanups = [], states = [];
  let si = 0;
  const react = {
    ...React,
    useEffect: fn => effects.push(fn),
    useRef: initial => ({ current: typeof initial === 'function' ? initial() : initial }),
    useState: initial => {
      const i = si++;
      states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => (name === 'react' ? react : require(name)), mod, mod.exports);
  renderToStaticMarkup(React.createElement(mod.exports.default));
  for (const fx of effects) { const cleanup = fx(); if (typeof cleanup === 'function') cleanups.push(cleanup); }

  return {
    reloads: () => reloads,
    fail(message = 'Loading chunk 586 failed.') {
      const err = Object.assign(new Error(message), { name: 'ChunkLoadError' });
      (listeners.get('error') || []).forEach(fn => fn({ error: err, message }));
      (listeners.get('unhandledrejection') || []).forEach(fn => fn({ reason: err }));
    },
    advance() {
      for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); }
    },
    close() {
      for (const cleanup of cleanups) cleanup();
      delete globalThis.__gate; delete globalThis.__gateCalls; delete globalThis.window; delete globalThis.setTimeout; delete globalThis.clearTimeout; delete globalThis.sessionStorage;
    },
  };
}

test('the wait screen defers before reloading, and settles the guard and the report once Clerk answers next page', () => {
  const storage = sharedSessionStorage();
  const calls = [];

  const page1 = page({ isLoaded: false, userId: null }, null, storage, calls);
  try {
    page1.fail();
    page1.advance();
    assert.ok(page1.reloads() >= 1, 'this page reloads itself, as the other frozen test pins');
    assert.deepEqual(calls, ['defer'], 'the failure is deferred, not resolved, before the reload: the outcome is not known yet');
  } finally { page1.close(); }

  // The reload lands here: same tab, same build, Clerk still loading at first.
  const page2 = page({ isLoaded: false, userId: null }, null, storage, calls);
  try {
    assert.deepEqual(calls, ['defer'], 'nothing is reported yet: Clerk has not answered on this page either');
    page2.advance(); // nothing scheduled until Clerk answers; a no-op here
  } finally { page2.close(); }

  // Clerk answers on a third page (e.g. after another retry of its own): now settle.
  const page3 = page({ isLoaded: true, userId: null }, null, storage, calls);
  try {
    assert.deepEqual(calls, ['defer', ['report', 'Fixed by itself: the sign-in library loaded after a piece of it was lost on the connection, following a reload.', 'info']], 'Clerk answering settles the deferred failure as fixed, not silence');
    assert.equal(storage.getItem('credentialdomd-wait-chunk-reload'), null, 'the loop guard is cleared once Clerk has answered');
  } finally { page3.close(); }
});

test('a later, unrelated failure on the same build gets its own reload once the guard is cleared', () => {
  const storage = sharedSessionStorage();
  const calls = [];

  const page1 = page({ isLoaded: false, userId: null }, null, storage, calls);
  try { page1.fail(); page1.advance(); assert.ok(page1.reloads() >= 1); } finally { page1.close(); }

  const settled = page({ isLoaded: true, userId: null }, null, storage, calls);
  try { assert.equal(storage.getItem('credentialdomd-wait-chunk-reload'), null); } finally { settled.close(); }

  // Signed out again later, same build, a fresh chunk loss: the guard being
  // clear means this is not treated as the same still-unresolved failure.
  const page2 = page({ isLoaded: false, userId: null }, null, storage, calls);
  try {
    page2.fail();
    page2.advance();
    assert.ok(page2.reloads() >= 1, 'a new failure after the guard was cleared still reloads');
  } finally { page2.close(); }
});
