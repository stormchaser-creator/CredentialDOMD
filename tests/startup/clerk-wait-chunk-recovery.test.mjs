// AuthGate's "wait" view (shown before Clerk's isLoaded answers, with no
// recorded member on this device) renders nothing but UpdatePrompt and has no
// listener at all for a lost script chunk. AuthPage's already-mounted sign-in
// screen recovers from the same class of failure (src/utils/chunkRecovery.js);
// the wait screen, reached first on every cold start, does not. All data here
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
  plugins: [{ name: 'gate-fixture', setup(b) {
    const stub = { '@clerk/clerk-react': 'clerk', './components/pages/AuthPage.jsx': 'auth', './components/shared/UpdatePrompt': 'update', './utils/offlineSession': 'offline', './utils/supportDeepLink.js': 'link', './App.jsx': 'app' };
    b.onResolve({ filter: /.*/ }, args => (stub[args.path] ? { path: stub[args.path], namespace: 'fixture' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      clerk: 'export const useAuth = () => globalThis.__gate.auth;',
      auth: 'import React from "react"; export default () => React.createElement("main", { "data-sign-in": "" });',
      update: 'import React from "react"; export default props => React.createElement("aside", { "data-update": String(props.allowAutomaticUpdates) });',
      offline: 'export const readLastIdentity = () => globalThis.__gate.identity;',
      link: 'export const takeAppDeepLink = () => null; export const stashAppDeepLink = () => {};',
      app: 'import React from "react"; export default () => React.createElement("div", { "data-app": "" });',
    }[path], loader: 'jsx', resolveDir: root }));
  } }],
});

// Renders AuthGate with real useEffect/useState/useRef, so the wait screen's
// own effects actually run against a fake window we control, instead of the
// no-op renderToStaticMarkup normally gives hooks.
function gate(auth, identity = null) {
  globalThis.__gate = { auth, identity };
  const listeners = new Map();
  let reloads = 0;
  const timers = new Map();
  let nextTimer = 0;
  const savedWindow = globalThis.window, savedSetTimeout = globalThis.setTimeout, savedClearTimeout = globalThis.clearTimeout, savedSessionStorage = globalThis.sessionStorage;
  globalThis.window = {
    location: { reload: () => { reloads += 1; } },
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    removeEventListener: (name, fn) => { const arr = listeners.get(name); if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); } },
  };
  globalThis.setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.sessionStorage = { map: new Map(), getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }, setItem(k, v) { this.map.set(k, v); } };

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
  const html = renderToStaticMarkup(React.createElement(mod.exports.default));
  for (const fx of effects) { const cleanup = fx(); if (typeof cleanup === 'function') cleanups.push(cleanup); }

  return {
    html,
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
      globalThis.window = savedWindow; globalThis.setTimeout = savedSetTimeout; globalThis.clearTimeout = savedClearTimeout; globalThis.sessionStorage = savedSessionStorage;
      delete globalThis.__gate;
    },
  };
}

test('a Clerk script chunk lost while the wait screen is up (Clerk not loaded yet, no recorded member) is recovered, not left stuck forever', () => {
  const g = gate({ isLoaded: false, userId: null });
  try {
    assert.match(g.html, /data-update="false"/, 'the wait screen, as today: nothing but the update prompt');
    assert.equal(g.reloads(), 0, 'nothing reloads before any failure');
    g.fail();
    g.advance();
    if (g.reloads() === 0) { g.fail(); g.advance(); }
    assert.ok(g.reloads() >= 1, 'the wait screen should recover itself (e.g. reload) once a Clerk script chunk is lost, the same way the sign-in and app screens already recover from this failure');
  } finally { g.close(); }
});
