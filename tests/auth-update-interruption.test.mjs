import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const bundled = await build({
  entryPoints: [`${root}src/components/shared/UpdatePrompt.jsx`], bundle: true, write: false,
  format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  define: { 'import.meta.env.BASE_URL': '"/app/"', __APP_BUILD_ID__: '"old-build"' },
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function fixture(run, options = {}) {
  const originals = new Map();
  const setGlobal = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const listeners = new Map(), workerListeners = new Map(), timers = [], intervals = [], values = new Map();
  const observed = { reloads: 0, cacheDeletes: [], workerMessages: [], registrations: 0 };
  const registration = { update: async () => {}, addEventListener() {}, waiting: options.waiting ? {
    postMessage: message => { observed.workerMessages.push(message); },
  } : null };
  const caches = {
    keys: () => options.cacheKeys?.promise || Promise.resolve(['synthetic-public-app-cache']),
    delete: async key => { observed.cacheDeletes.push(key); },
  };
  setGlobal('window', { location: { reload: () => { observed.reloads++; } }, caches,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) });
  setGlobal('document', { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });
  setGlobal('navigator', { serviceWorker: {
    getRegistration: async () => { observed.registrations++; return registration; },
    addEventListener: (name, fn) => workerListeners.set(name, fn),
  } });
  setGlobal('caches', caches);
  setGlobal('sessionStorage', { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  setGlobal('fetch', async () => options.fetch?.promise || { ok: true, json: async () => ({ build: 'new-build' }) });
  setGlobal('setTimeout', (fn, delay) => { timers.push({ fn, delay }); return timers.length; });
  setGlobal('setInterval', (fn, delay) => { intervals.push({ fn, delay }); return intervals.length; });
  setGlobal('clearInterval', () => {});

  const hooks = [], effects = [];
  let cursor = 0;
  const runtime = { ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useCallback(fn) { return fn; },
    useLayoutEffect(fn) { fn(); },
    useEffect(fn) { effects.push(fn); },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
    name => name === 'react' ? runtime : require(name), mod, mod.exports);
  const Page = mod.exports.default.type;
  const render = allowed => { cursor = 0; return Page({ allowAutomaticUpdates: allowed }); };
  const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  try {
    render(options.allowed ?? false);
    const mountedEffects = effects.splice(0);
    let cleanups = mountedEffects.map(fn => fn()).filter(Boolean);
    if (options.strictMode) {
      cleanups.forEach(fn => fn());
      cleanups = mountedEffects.map(fn => fn()).filter(Boolean);
    }
    await run({ observed, render, flush, timers, intervals, listeners, workerListeners, values });
    cleanups.forEach(fn => fn());
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

test('new build during sign-in keeps caches and form intact, with a working manual update', async () => {
  await fixture(async ({ observed, render, flush, timers, listeners, values }) => {
    await flush();
    listeners.get('focus')(); await flush();
    assert.equal(observed.reloads, 0);
    assert.deepEqual(observed.cacheDeletes, []);
    assert.equal(values.size, 0, 'no automatic-attempt marker is consumed during authentication');
    const button = render(false);
    assert.equal(button.props['aria-label'], 'Update app to the new version');
    await button.props.onClick(); await flush();
    assert.deepEqual(observed.cacheDeletes, ['synthetic-public-app-cache']);
    timers.find(timer => timer.delay === 600).fn();
    assert.equal(observed.reloads, 1, 'explicit manual update remains available');
  });
});

test('signed-in application retains automatic update behavior', async () => {
  await fixture(async ({ observed, flush, timers }) => {
    await flush();
    assert.deepEqual(observed.cacheDeletes, ['synthetic-public-app-cache']);
    timers.find(timer => timer.delay === 600).fn();
    assert.equal(observed.reloads, 1);
  }, { allowed: true });
});

test('auth starting during the async version check prevents automatic cache deletion and reload', async () => {
  const response = deferred();
  await fixture(async ({ observed, render, flush, timers }) => {
    await flush(); render(false);
    response.resolve({ ok: true, json: async () => ({ build: 'new-build' }) }); await flush();
    assert.deepEqual(observed.cacheDeletes, []);
    assert.equal(timers.length, 0);
    assert.equal(observed.reloads, 0);
    assert.equal(render(false).props['aria-label'], 'Update app to the new version');
  }, { allowed: true, fetch: response });
});

test('auth starting while cache enumeration waits prevents deletion', async () => {
  const keys = deferred();
  await fixture(async ({ observed, render, flush, timers }) => {
    await flush(); render(false); keys.resolve(['synthetic-public-app-cache']); await flush();
    assert.deepEqual(observed.cacheDeletes, []);
    assert.equal(timers.length, 0);
    assert.equal(observed.reloads, 0);
  }, { allowed: true, cacheKeys: keys });
});

test('auth starting after update scheduling blocks both delayed and service-worker reloads', async () => {
  await fixture(async ({ observed, render, flush, timers, workerListeners }) => {
    await flush();
    assert.equal(observed.workerMessages.length, 1);
    render(false);
    workerListeners.get('controllerchange')();
    timers.find(timer => timer.delay === 600).fn();
    assert.equal(observed.reloads, 0);
    assert.equal(render(false).props['aria-label'], 'Update app to the new version');
  }, { allowed: true, waiting: true });
});

test('a waiting service worker during auth stays waiting until a manual update', async () => {
  await fixture(async ({ observed, render, flush, workerListeners }) => {
    await flush();
    assert.deepEqual(observed.workerMessages, []);
    assert.deepEqual(observed.cacheDeletes, []);
    await render(false).props.onClick(); await flush();
    assert.equal(observed.workerMessages.length, 1);
    workerListeners.get('controllerchange')();
    assert.equal(observed.reloads, 1);
  }, { waiting: true });
});

test('Strict Mode setup-cleanup-setup leaves auth updates manual', async () => {
  await fixture(async ({ observed, render, flush, timers, values }) => {
    await flush();
    assert.deepEqual(observed.cacheDeletes, []);
    assert.deepEqual(observed.workerMessages, []);
    assert.equal(observed.reloads, 0);
    assert.equal(values.size, 0);
    assert.equal(timers.length, 0);
    assert.equal(render(false).props['aria-label'], 'Update app to the new version');
  }, { strictMode: true, waiting: true });
});
