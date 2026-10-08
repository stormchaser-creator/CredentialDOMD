// Signup review 2026-10-07 (QA lab journey SIGNUP-RESUME): a pending account
// on the membership page still read its requests, request proposals and
// forwarding addresses and intake notes on load and on every return to the front. The three
// hooks read nothing while the account is pending (App.jsx passes it), and
// read as before once it is not. The real hooks, with the database stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const built = await build({
  stdin: { contents: 'export { useOpenRequests } from "./src/hooks/useNewRequestCount.js"; export { useForwardingAddresses } from "./src/hooks/useForwardingAddresses.js"; export { useIntakeNotes } from "./src/hooks/useIntakeNotes.js";', resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react'], define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'db-stub', setup(b) {
    b.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'db', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/edgeError$/ }, () => ({ path: 'edge', namespace: 'fixture' }));
    b.onResolve({ filter: /features\/EmailPacketModal$/ }, () => ({ path: 'modal', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      // Any query: recorded, answered with no rows.
      db: 'const chain = (table) => new Proxy(function () {}, { get: (_, k) => k === "then" ? (ok) => { globalThis.__reads.push(table); return Promise.resolve({ data: [], error: null }).then(ok); } : () => chain(table), apply: () => chain(table) }); export const supabase = { from: (t) => chain(t), rpc: (t) => chain(t) };',
      edge: 'export const invokeFn = async () => { globalThis.__reads.push("fn"); return { data: [] }; };',
      modal: 'export const REQUEST_REPLIED_EVENT = "synthetic-replied";',
    }[path] }));
  } }],
});
function runtime() {
  const cells = [], pending = [];
  let index = 0;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(v) { const at = index++; if (!(at in cells)) cells[at] = { value: typeof v === 'function' ? v() : v }; const c = cells[at]; return [c.value, n => { c.value = typeof n === 'function' ? n(c.value) : n; }]; },
    useRef(v) { const at = index++; return cells[at] ??= { current: v }; },
    useCallback(fn, deps) { const at = index++; if (cells[at] && same(cells[at].deps, deps)) return cells[at].value; cells[at] = { deps, value: fn }; return fn; },
    useMemo(fn, deps) { const at = index++; if (cells[at] && same(cells[at].deps, deps)) return cells[at].value; cells[at] = { deps, value: fn() }; return cells[at].value; },
    useEffect(fn, deps) { const at = index++; const prev = cells[at]; if (prev && deps && same(prev.deps, deps)) return; const cell = cells[at] = { deps, cleanup: prev?.cleanup ?? null }; pending.push(() => { cell.cleanup?.(); const c = fn(); cell.cleanup = typeof c === 'function' ? c : null; }); },
  };
  return { hooks, begin() { index = 0; }, flush() { pending.splice(0).forEach(r => r()); } };
}
let active = runtime();
const mod = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(n => (n === 'react' ? new Proxy({}, { get: (_, k) => active.hooks[k] }) : require(n)), mod, mod.exports);
const { useOpenRequests, useForwardingAddresses, useIntakeNotes } = mod.exports;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

function page() {
  const listeners = {};
  globalThis.window = { addEventListener: (t, f) => { (listeners[t] ||= new Set()).add(f); }, removeEventListener: (t, f) => listeners[t]?.delete(f), dispatchEvent() {} };
  globalThis.__reads = [];
  return { focus: () => [...(listeners.focus || [])].forEach(f => f()) };
}

test('pending: the request and forwarding panels read nothing, on load or on focus; once active they read as before', async () => {
  const p = page();
  active = runtime();
  const userIdRef = { current: 'profile-synthetic' };
  const render = (pending) => { active.begin(); useOpenRequests(userIdRef, !pending); useForwardingAddresses({ enabled: !pending }); useIntakeNotes({ enabled: !pending }); active.flush(); };
  render(true);
  p.focus();
  await settle();
  assert.deepEqual(globalThis.__reads, [], 'nothing read for a pending account');
  render(false);
  await settle();
  assert.ok(globalThis.__reads.length >= 3, `read once active: ${globalThis.__reads}`);
  assert.ok(globalThis.__reads.includes('intake_proposals'), 'the intake notes too');
  const after = globalThis.__reads.length;
  p.focus();
  await settle();
  assert.ok(globalThis.__reads.length > after, 'and again on focus, as before');
});

test('App.jsx passes the pending state to both panels', async () => {
  const app = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const pendingMember = limitedLaunch\.enabled === true && limitedLaunch\.access\?\.accessStatus === "pending";/);
  assert.match(app, /useOpenRequests\(userIdRef, loaded && !pendingMember\)/);
  assert.match(app, /useForwardingAddresses\(\{ enabled: !pendingMember \}\)/);
  assert.match(app, /useIntakeNotes\(\{ enabled: !pendingMember \}\)/);
});
