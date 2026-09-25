import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Drive real screens without a browser. Components are bundled with the
// device and cloud modules swapped for in-memory fixtures, and their hooks run
// on a small in-process runtime: every render calls the component function,
// handlers are invoked straight off the element tree, and every write lands in
// a recorder instead of the cloud. Used by the Work Log / Expenses tests.

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));

const STUBS = {
  'context/AppContext': 'export const useApp = () => globalThis.__screen.app;',
  'utils/storageScope': 'export const BASE_KEYS = { timer: "timer", lastContract: "lastContract" }; const m = () => globalThis.__screen.storage; export const lsGet = (k) => m()[k] ?? null; export const lsSet = (k, v) => { m()[k] = v; }; export const lsGetJSON = (k) => m()[k] ?? null; export const lsSetJSON = (k, v) => { m()[k] = v; }; export const lsRemove = (k) => { delete m()[k]; };',
  'utils/privateVault': 'const v = () => globalThis.__screen.vault; export const getPrivate = (s, id) => v()[s + ":" + id] || ""; export const setPrivate = (s, id, t) => { v()[s + ":" + id] = t; }; export const removePrivate = (s, id) => { delete v()[s + ":" + id]; }; export const looksLikePHI = () => null;',
  'lib/supabase': 'export const supabase = {}; export const downloadDocumentBlob = async () => null; export default {};',
  'hooks/useDeskKeys': 'export const useDeskAddShortcut = () => {};',
};

// A minimal hook runtime: state and refs persist by call order; memo and
// callback recompute every render (always correct, never stale); effects run
// after a render when their deps change.
let current = null;
function runtime() {
  const slots = []; let cursor = 0; const pending = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
  return {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { v: typeof initial === 'function' ? initial() : initial };
      const slot = slots[i]; return [slot.v, (next) => { slot.v = typeof next === 'function' ? next(slot.v) : next; }]; },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) { const i = cursor++; const prev = slots[i]; if (!prev || changed(prev.deps, deps)) { slots[i] = { deps }; pending.push(fn); } },
    useSyncExternalStore(subscribe, getSnapshot) { cursor++; return getSnapshot(); },
    begin() { cursor = 0; }, flush() { for (const fn of pending.splice(0)) fn(); },
  };
}
const reactStub = { ...React, memo: (c) => c };
for (const hook of ['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'useSyncExternalStore']) reactStub[hook] = (...args) => current[hook](...args);

/** Bundle `exportsSource` (an `export {...} from "./src/..."` line) once, before any window exists. */
export async function loadScreens(exportsSource) {
  const bundled = await build({
    stdin: { contents: exportsSource, resolveDir: root, loader: 'jsx' },
    bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'synthetic-device', setup(b) {
      const keys = Object.keys(STUBS);
      b.onResolve({ filter: /(context\/AppContext|utils\/storageScope|utils\/privateVault|lib\/supabase|hooks\/useDeskKeys)(\.js)?$/ }, ({ path }) => ({
        path: keys.find(k => path.replace(/\.js$/, '').endsWith(k)), namespace: 'fixture',
      }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: STUBS[path] }));
    } }],
  });
  const mod = { exports: {} };
  const req = (name) => (name === 'react' ? reactStub : require(name));
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(req, mod, mod.exports);
  return mod.exports;
}

export const THEME = { text: '#111', textMuted: '#666', textDim: '#888', border: '#aaa', card: '#fff', bg: '#eee', accent: '#2a7', accentDim: '#dfe', danger: '#c00', dangerDim: '#fee', warning: '#a60', warningDim: '#ffe', success: '#0a0', input: '#fafafa', inputBorder: '#ccc', shadow1: 'none' };

/** Mount a component with an account whose writes are recorded AND applied. */
export function mount(Component, { data: seed = {}, confirm = () => true, storage = {}, props = {} } = {}) {
  const h = runtime();
  const calls = [];
  const data = { settings: {}, locumContracts: [], workLog: [], invoices: [], documents: [], travelExpenses: [], ...seed };
  const apply = (key, fn) => { data[key] = fn(data[key] || []); };
  const app = {
    data, theme: THEME, isDesktop: false, setData: () => {},
    addItem: (key, item) => { calls.push(['add', key, item]); apply(key, l => [...l, item]); return true; },
    editItem: (key, item) => { calls.push(['edit', key, item]); apply(key, l => l.map(x => (x.id === item.id ? item : x))); return true; },
    deleteItem: (key, id) => { calls.push(['delete', key, id]); apply(key, l => l.filter(x => x.id !== id)); return true; },
  };
  const dialogs = [];
  globalThis.window = { confirm: (m) => { dialogs.push(['confirm', m]); return confirm(m); }, alert: (m) => { dialogs.push(['alert', m]); } };
  globalThis.__screen = { app, storage: { ...storage }, vault: {} };
  const render = () => { current = h; h.begin(); const tree = Component(props); h.flush(); return tree; };
  return { render, calls, dialogs, data, html: () => renderToStaticMarkup(render()) };
}

// Every element in a tree, including ones passed as a Modal's footer.
export const nodes = (n) => (Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === 'object' ? [n, ...nodes(n.props?.children), ...nodes(n.props?.footer)] : []);
export const textOf = (n) => (typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : n?.props ? textOf(n.props.children) : '');
export const find = (tree, pred, what) => { const hit = nodes(tree).find(pred); assert.ok(hit, `not found: ${what}`); return hit; };
export const button = (tree, label) => find(tree, n => n.type === 'button' && textOf(n).includes(label), label);
export const field = (tree, label) => find(tree, n => n.props?.label === label, label);
export const click = (m, label) => button(m.render(), label).props.onClick({ stopPropagation() {} });

/** Pin the zone and the clock; returns a setter for "now" and restores both after the file. */
export function pinClock(test, zone, now) {
  const originalTimezone = process.env.TZ;
  process.env.TZ = zone;
  const RealDate = globalThis.Date;
  let NOW = now;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return new RealDate(NOW).getTime(); }
  };
  // Notices clear themselves on a timer and a running timer ticks every
  // second; neither may hold the test process open.
  const realSetTimeout = globalThis.setTimeout, realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (...args) => { const t = realSetTimeout(...args); t?.unref?.(); return t; };
  globalThis.setInterval = (...args) => { const t = realSetInterval(...args); t?.unref?.(); return t; };
  test.after(() => {
    globalThis.Date = RealDate;
    globalThis.setTimeout = realSetTimeout; globalThis.setInterval = realSetInterval;
    delete globalThis.window;
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });
  return { setNow: (v) => { NOW = v; }, RealDate };
}
