import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
// Real subscription derivation, Practice route, and record archive. Leaf
// Practice editors are inert probes; no browser state, provider or writes.
const bundle = await build({
  stdin: { contents: 'export {useSubscription} from "./src/hooks/useSubscription.js"; export {default as Practice} from "./src/components/features/locum/LocumDashboard.jsx"; export {default as Archive} from "./src/components/features/ReadOnlyRecords.jsx";', resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': JSON.stringify({ DEV: false, VITE_LIMITED_LAUNCH_ACCESS_ENABLED: 'true' }) },
  plugins: [{ name: 'synthetic-access', setup(builder) {
    builder.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    builder.onResolve({ filter: /useLimitedLaunchAccess\.js$/ }, () => ({ path: 'access', namespace: 'fixture' }));
    builder.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'clerk', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/admin$/ }, () => ({ path: 'admin', namespace: 'fixture' }));
    builder.onResolve({ filter: /utils\/(credentialExport|invoicePdf)$/ }, () => ({ path: 'downloads', namespace: 'fixture' }));
    builder.onResolve({ filter: /^\.\/(TaskNotes|WorkLog|Contracts|Expenses|Schedule|Invoices|RVULog)$/ }, args => ({ path: args.path, namespace: 'editor' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: ({
      context: 'export const useApp = () => globalThis.__entitlementRenderAccount;',
      access: 'export const useLimitedLaunchAccess = () => globalThis.__entitlementRenderAccount.limitedLaunch;',
      clerk: 'export const useUser = () => ({isSignedIn:true,user:{id:"user_Synthetic"}});',
      database: 'export const supabase=null; export const COLLECTION_KEYS=["workLog","licenses","cme","caseLogs"]; export const downloadDocumentFile=()=>{throw Error("No download");};',
      admin: 'export const isAdminUser=()=>false; export const useAdminPreviewRefresh=()=>{};',
      downloads: 'export const downloadBlob=()=>{throw Error("No download");}; export const invoicePdfFile=downloadBlob; export const invoiceTextPdfFile=downloadBlob;',
    })[path] }));
    builder.onLoad({ filter: /.*/, namespace: 'editor' }, ({ path }) => ({ loader: 'jsx', contents:
      `export default function Editor(){ return <section data-editor=${JSON.stringify(path)}>{globalThis.__entitlementRenderAccount.data.workLog.map(row=><p key={row.id}>{row.notes}</p>)}</section>; }` }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports);
const { useSubscription, Practice, Archive } = mod.exports;
let derived;
function Screen() {
  derived = useSubscription({ id: 'user_Synthetic' }, { profileReady: true });
  Object.assign(globalThis.__entitlementRenderAccount, derived);
  return React.createElement(Practice);
}

const savedRecords = () => ({ settings: { accessStatus: 'active' },
  workLog: [{ id: 'work', notes: 'Synthetic saved work entry', date: '2026-09-20' }],
  cme: [{ id: 'cme', title: 'Synthetic saved CME' }], caseLogs: [{ id: 'case', title: 'Synthetic saved case' }],
  licenses: [{ id: 'license', name: 'Synthetic saved license' }], documents: [],
});
const capability = write => ({ read: true, write, export: true });
const lifetime = (over = {}) => ({
  accessStatus: 'active', lifetime: { credential: true, practice: true }, purchasedOfferId: null,
  freeBeta: { state: 'none' }, practiceTrial: { state: 'none', endsAt: null },
  capabilities: { credential: capability(true), practice: capability(true) }, ...over,
});

// Ticket fe321c16: a phone resumed from the background showed the Practice
// archive and "Checking membership" to a lifetime member, because an old or
// unanswered check turned every write off and the screens read that as expiry.
test('a failed membership lookup keeps the Practice screen with writes refused, and deletes nothing', () => {
  const data = savedRecords(), original = structuredClone(data);
  globalThis.__entitlementRenderAccount = { data, theme: {}, navigate() {},
    limitedLaunch: { enabled: true, status: 'error', access: null, error: 'Membership information could not load.' } };
  const failed = renderToStaticMarkup(React.createElement(Screen));
  assert.equal(derived.plan, 'locum');
  assert.equal(derived.canWriteCredential, false);
  assert.equal(derived.canWritePractice, false);
  assert.equal(derived.credentialReadOnly, false);
  assert.equal(derived.practiceReadOnly, false);
  assert.match(failed, /data-editor="\.\/WorkLog"/);
  assert.match(failed, /Synthetic saved work entry/);
  assert.doesNotMatch(failed, /Practice saved records/);
  assert.deepEqual(data, original);
  delete globalThis.__entitlementRenderAccount;
});

test('a stale snapshot on resume keeps the normal Practice screen while writes stay refused', () => {
  const data = savedRecords();
  globalThis.__entitlementRenderAccount = { data, theme: {}, navigate() {},
    limitedLaunch: { enabled: true, status: 'ready', error: null, access: lifetime({
      needsRefresh: true, entitled: { credential: true, practice: true },
      capabilities: { credential: capability(false), practice: capability(false) },
    }) } };
  const stale = renderToStaticMarkup(React.createElement(Screen));
  assert.equal(derived.canWritePractice, false);
  assert.equal(derived.canWriteCredential, false);
  assert.equal(derived.practiceReadOnly, false);
  assert.match(stale, /data-editor="\.\/WorkLog"/);
  assert.doesNotMatch(stale, /Practice saved records/);
  delete globalThis.__entitlementRenderAccount;
});

test('a fresh snapshot that denies Practice write shows the archive with every saved record', () => {
  const data = savedRecords(), original = structuredClone(data);
  for (const access of [
    lifetime({ lifetime: { credential: false, practice: false }, purchasedOfferId: 'core', entitled: { credential: true, practice: false },
      capabilities: { credential: capability(true), practice: capability(false) } }),
    // A snapshot built without the entitlement field reads its capabilities.
    lifetime({ lifetime: { credential: false, practice: false }, purchasedOfferId: 'core',
      capabilities: { credential: capability(true), practice: capability(false) } }),
  ]) {
    globalThis.__entitlementRenderAccount = { data, theme: {}, navigate() {}, limitedLaunch: { enabled: true, status: 'ready', error: null, access } };
    const denied = renderToStaticMarkup(React.createElement(Screen));
    assert.equal(derived.canWritePractice, false);
    assert.equal(derived.practiceReadOnly, true);
    assert.equal(derived.credentialReadOnly, false);
    assert.match(denied, /Practice saved records/);
    assert.match(denied, /Synthetic saved work entry/);
    assert.doesNotMatch(denied, /data-editor|>RVUs<|>Sched\.</);
  }
  const credentialArchive = renderToStaticMarkup(React.createElement(Archive, { scope: 'credential' }));
  assert.match(credentialArchive, /Synthetic saved CME/);
  assert.match(credentialArchive, /Synthetic saved case/);
  assert.deepEqual(data, original);
  delete globalThis.__entitlementRenderAccount;
});

test('a lifetime snapshot gives the full Practice screen and writes', () => {
  const data = savedRecords(), original = structuredClone(data);
  globalThis.__entitlementRenderAccount = { data, theme: {}, navigate() {},
    limitedLaunch: { enabled: true, status: 'ready', error: null, access: lifetime() } };
  const ready = renderToStaticMarkup(React.createElement(Screen));
  assert.equal(derived.isPro, true);
  assert.equal(derived.isLifetime, true);
  assert.equal(derived.canWriteCredential, true);
  assert.equal(derived.canWritePractice, true);
  assert.match(ready, /data-editor="\.\/WorkLog"/);
  assert.match(ready, /Synthetic saved work entry/);
  assert.match(ready, />RVUs<|>Sched\.</);
  assert.doesNotMatch(ready, /Practice saved records/);
  assert.deepEqual(data, original);
  delete globalThis.__entitlementRenderAccount;
});
