import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  // useNotifications and AppProvider are for App.jsx; a test that renders the
  // app shell sets globalThis.__screen.notifications to change the answer.
  'context/AppContext': 'export const useApp = () => globalThis.__screen.app; export const useNotifications = () => globalThis.__screen.notifications ?? { browserPermission: "default", requestPermission: async () => "default", checkAndNotify() {} }; export const AppProvider = ({ children }) => children;',
  'utils/storageScope': 'export const BASE_KEYS = { timer: "timer", lastContract: "lastContract", contractPick: "contractPick", unrecordedInvoices: "unrecordedInvoices" }; const m = () => globalThis.__screen.storage; const full = () => globalThis.__screen.storageFull === true; export const lsGet = (k) => m()[k] ?? null; export const lsSet = (k, v) => { if (full()) return false; m()[k] = v; return true; }; export const lsGetJSON = (k) => m()[k] ?? null; export const lsSetJSON = (k, v) => { if (full()) return false; m()[k] = v; return true; }; export const lsRemove = (k) => { delete m()[k]; }; export const offlineCopyUnread = () => globalThis.__screen?.offlineCopyUnread === true;',
  'utils/privateVault': 'const v = () => globalThis.__screen.vault; export const getPrivate = (s, id) => v()[s + ":" + id] || ""; export const setPrivate = (s, id, t) => { v()[s + ":" + id] = t; }; export const removePrivate = (s, id) => { delete v()[s + ":" + id]; }; export const looksLikePHI = () => null;',
  // A stored file comes back as null (not reachable) unless a test sets
  // globalThis.__screen.download to hand one back.
  // Invoice numbers are worked out on the device (no server) unless a test
  // sets globalThis.__screen.allocate to answer allocate_invoice_number.
  // The share stamps (mark_invoice_number_shared, list_shared_invoice_numbers)
  // go nowhere unless a test sets globalThis.__screen.markShared / listShared.
  'lib/supabase': 'export const supabase = {}; export const downloadDocumentBlob = async (p) => (globalThis.__screen?.download ? globalThis.__screen.download(p) : null); export const downloadDocumentFile = async (p, o) => (globalThis.__screen?.downloadFile ? globalThis.__screen.downloadFile(p, o) : (o?.detail ? { failed: true } : null)); export const allocateInvoiceNumberRpc = (...a) => (globalThis.__screen?.allocate ? globalThis.__screen.allocate(...a) : null); export const markInvoiceNumberSharedRpc = (...a) => (globalThis.__screen?.markShared ? globalThis.__screen.markShared(...a) : null); export const listSharedInvoiceNumbersRpc = () => (globalThis.__screen?.listShared ? globalThis.__screen.listShared() : null); export const uploadDocumentFile = async () => globalThis.__screen?.uploadDocumentFile?.() ?? null; export default {};',
  'hooks/useDeskKeys': 'export const useDeskAddShortcut = () => {}; export const useDeskKeyboard = () => {};',
};
// Sign-in (Clerk) for screens that read the signed-in user, such as Settings.
// Only bundled in by a test that asks for it: loadScreens(src, { clerk: true }).
const CLERK = 'const u = () => globalThis.__screen.clerkUser ?? null; export const useUser = () => ({ isLoaded: true, isSignedIn: !!u(), user: u() }); export const useClerk = () => ({ user: u(), signOut: async () => {}, openUserProfile() {} }); export const useAuth = () => ({ isLoaded: true, userId: u()?.id ?? null, getToken: async () => null }); export const SignedIn = ({ children }) => children; export const SignedOut = () => null; export const SignIn = () => null; export const ClerkProvider = ({ children }) => children;';

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
// With no mounted runtime (renderScreen), React's own hooks run: a plain
// server render, state at its first value and no effects.
const real = { ...React, useSyncExternalStore: (subscribe, get, server) => React.useSyncExternalStore(subscribe, get, server ?? get) };
for (const hook of ['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'useSyncExternalStore']) reactStub[hook] = (...args) => (current ? current[hook](...args) : real[hook](...args));

/**
 * Bundle `exportsSource` (an `export {...} from "./src/..."` line) once, before any window exists.
 * `expose` names module-private functions to export as well ({ 'src/App.jsx': ['AppInner'] });
 * `real` lists fixtures to leave out, so that module is bundled as it is ('lib/supabase').
 */
export async function loadScreens(exportsSource, { expose = {}, real: keep = [], clerk = false } = {}) {
  const stubbed = Object.keys(STUBS).filter(k => !keep.includes(k));
  const pattern = new RegExp(`(${stubbed.map(k => k.replace('/', '\\/')).join('|')})(\\.js)?$`);
  const exposed = Object.entries(expose).map(([file, names]) => [fileURLToPath(new URL(`../../${file}`, import.meta.url)), names]);
  const bundled = await build({
    stdin: { contents: exportsSource, resolveDir: root, loader: 'jsx' },
    bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'synthetic-device', setup(b) {
      b.onResolve({ filter: pattern }, ({ path }) => ({
        path: stubbed.find(k => path.replace(/\.js$/, '').endsWith(k)), namespace: 'fixture',
      }));
      if (clerk) b.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'clerk', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'clerk' ? CLERK : STUBS[path] }));
      for (const [file, names] of exposed) {
        b.onLoad({ filter: new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }, async ({ path }) => ({
          contents: `${await readFile(path, 'utf8')}\nexport { ${names.join(', ')} };`, loader: 'jsx',
        }));
      }
    } }],
  });
  const mod = { exports: {} };
  const req = (name) => (name === 'react' ? reactStub : require(name));
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(req, mod, mod.exports);
  return mod.exports;
}

export const THEME = { text: '#111', textMuted: '#666', textDim: '#888', border: '#aaa', card: '#fff', bg: '#eee', accent: '#2a7', accentDim: '#dfe', danger: '#c00', dangerDim: '#fee', warning: '#a60', warningDim: '#ffe', success: '#0a0', input: '#fafafa', inputBorder: '#ccc', shadow1: 'none' };

/**
 * Mount a component with an account whose writes are recorded AND applied.
 * `refuse(op, key)` returning true makes that write come back false, as
 * AppContext's do when the access authority refuses them (a membership
 * check in progress); a refused write is recorded as ['refused', op, key].
 */
export function mount(Component, { data: seed = {}, confirm = () => true, storage = {}, props = {}, refuse = () => false } = {}) {
  const h = runtime();
  const calls = [];
  const data = { settings: {}, locumContracts: [], workLog: [], invoices: [], documents: [], travelExpenses: [], ...seed };
  const apply = (key, fn) => { data[key] = fn(data[key] || []); };
  const refused = (op, key) => { if (!refuse(op, key)) return false; calls.push(['refused', op, key]); return true; };
  const app = {
    data, theme: THEME, isDesktop: false, setData: () => {},
    addItem: (key, item) => { if (refused('add', key)) return false; calls.push(['add', key, item]); apply(key, l => [...l, item]); return true; },
    // Whether an add would be accepted, without adding (AppContext canAddItem).
    canAddItem: (key) => !refused('add', key),
    editItem: (key, item) => { if (refused('edit', key)) return false; calls.push(['edit', key, item]); apply(key, l => l.map(x => (x.id === item.id ? item : x))); return true; },
    deleteItem: (key, id) => { if (refused('delete', key)) return false; calls.push(['delete', key, id]); apply(key, l => l.filter(x => x.id !== id)); return true; },
  };
  const dialogs = [];
  globalThis.window = { confirm: (m) => { dialogs.push(['confirm', m]); return confirm(m); }, alert: (m) => { dialogs.push(['alert', m]); } };
  globalThis.__screen = { app, storage: { ...storage }, vault: {} };
  const render = () => { current = h; h.begin(); const tree = Component(props); h.flush(); return tree; };
  return { render, calls, dialogs, data, storage: globalThis.__screen.storage, html: () => renderToStaticMarkup(render()) };
}

/**
 * One server render of a screen as React itself runs it (no hook runtime):
 * the markup a physician would first see, with `app` as the account.
 */
export function renderScreen(Component, { app, props = {}, storage = {}, vault = {}, notifications, clerkUser } = {}) {
  current = null;
  globalThis.__screen = { app, storage: { ...storage }, vault: { ...vault }, notifications, clerkUser };
  return renderToStaticMarkup(React.createElement(Component, props));
}

// Every element in a tree, including ones passed as a Modal's footer.
export const nodes = (n) => (Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === 'object' ? [n, ...nodes(n.props?.children), ...nodes(n.props?.footer)] : []);
export const textOf = (n) => (typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : n?.props ? textOf(n.props.children) : '');
export const find = (tree, pred, what) => { const hit = nodes(tree).find(pred); assert.ok(hit, `not found: ${what}`); return hit; };
export const button = (tree, label) => find(tree, n => n.type === 'button' && textOf(n).includes(label), label);
export const field = (tree, label) => find(tree, n => n.props?.label === label, label);
// A disabled button does nothing when tapped, as in a browser: pressing one
// here throws, so a test can never pass on a tap no physician could make.
export const click = (m, label) => {
  const b = button(m.render(), label);
  assert.ok(!b.props.disabled, `"${label}" is disabled`);
  return b.props.onClick({ stopPropagation() {} });
};

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
