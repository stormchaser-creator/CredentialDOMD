import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import * as deepLinks from '../src/utils/supportDeepLink.js';

const ticket = '#support/0f0f0f0f-1111-4222-8333-444444444444';
async function existingTab() {
  const data = new Map(), listeners = new Map();
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  const location = { pathname: '/app/', search: '?source=email', hash: '' };
  const history = { state: null, replaceState: (_s, _t, path) => { location.hash = new URL(path, 'https://credentialdomd.com').hash; } };
  const window = { location, history, sessionStorage: storage, navigator: {}, matchMedia: () => ({ matches: false }), addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } };
  globalThis.window = window;
  const app = await mountComponent('src/App.jsx', {
    modules: { 'clerk-react': { useUser: () => ({ isLoaded: true }), useAuth: () => ({ userId: 'user_syntheticLink' }) }, supportDeepLink: deepLinks },
    globals: { window, navigator: { onLine: true } },
  });
  const inner = () => app.nodes().find(n => n.type?.name === 'AppInner').props;
  inner();
  return { app, inner, location, listeners, open(hash) { location.hash = hash; listeners.get('hashchange')?.(); return inner(); } };
}

test('an existing tab opens backup and request links, then accepts another email link', async () => {
  const t = await existingTab();
  assert.equal(t.inner().tab, 'home');
  for (const [hash, screen] of [['#backups', 'export'], ['#requests', 'requests'], ['#backups', 'export']]) {
    const view = t.open(hash);
    assert.equal(view.tab, 'more');
    assert.equal(view.subPage, screen);
    assert.equal(view.deepLink, hash);
    assert.equal(t.location.hash, '', 'consumed link leaves a clean address');
    view.settleDeepLink();
    t.inner();
  }
  t.app.unmount();
  assert.equal(t.listeners.has('hashchange'), false, 'listener removed on unmount');
});

test('existing-tab support links reach the support sheet without treating auth or unknown hashes as app links', async () => {
  const t = await existingTab();
  assert.equal(t.open(ticket).deepLink, ticket);
  for (const hash of ['#/factor-one', '#support/not-a-ticket', '#settings']) {
    assert.equal(t.open(hash).deepLink, ticket, 'unrecognized fragment does not change pending destination');
    assert.equal(t.location.hash, hash, 'auth/unknown fragment untouched');
  }
  t.app.unmount();
});

test('a link arriving at an existing sign-in screen survives Clerk hash steps and the post-sign-in reload', async () => {
  const { readFile } = await import('node:fs/promises');
  const { transformSync } = await import('esbuild');
  const t = await existingTab();
  t.app.unmount();
  const effects = [];
  const react = { lazy: () => () => null, useState: init => [typeof init === 'function' ? init() : init, () => {}], useEffect: fn => effects.push(fn) };
  const mod = { exports: {} };
  const src = await readFile(new URL('../src/AuthGate.jsx', import.meta.url), 'utf8');
  const code = transformSync(src, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const window = globalThis.window;
  const modules = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@clerk/clerk-react': { useAuth: () => ({ isLoaded: true, userId: null }) },
    './utils/offlineSession': { readLastIdentity: () => null },
    './utils/supportDeepLink.js': deepLinks,
  };
  new Function('require', 'module', 'exports', 'window', 'setTimeout', 'clearTimeout', code)(name => modules[name] || { default: () => null }, mod, mod.exports, window, () => 1, () => {});
  mod.exports.default();
  const cleanups = effects.map(fn => fn());
  for (const hash of ['#backups', '#requests', ticket]) {
    t.location.hash = hash;
    t.listeners.get('hashchange')();
    assert.equal(t.location.hash, '', 'recognized destination leaves Clerk a clean route');
    t.location.hash = '#/factor-one';
    t.listeners.get('hashchange')();
    assert.equal(t.location.hash, '#/factor-one', 'Clerk route unchanged');
    t.location.hash = '';
    assert.equal(deepLinks.takeAppDeepLink(), hash, 'destination survives sign-in page load');
  }
  cleanups.forEach(fn => fn?.());
  assert.equal(t.listeners.has('hashchange'), false, 'listener removed when leaving sign-in');
});
