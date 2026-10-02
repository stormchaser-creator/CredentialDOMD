// Lab, release goal2: after a weak-network launch, Credentials showed "Trying
// again on its own" and directly below it "Showing this device's copy. Reload
// to reconnect your account", although the app reconnects with no tap. The
// read-only records under them added "Membership expiry does not delete your
// data" (no membership had ended), the gate offered a Reload button under
// "Trying again on its own", and a record added just before the page was
// left read "No saved records in this section".
//
// Now one message says what is true: it is retrying by itself, what is on
// screen is this device's copy, read only, and there is nothing to tap; and
// a copy that may lack the latest change says so instead of "No saved
// records". Renders the real components with a synthetic account and no
// network or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { accessGateStatus } from '../../src/utils/accessGateStatus.js';
import { membershipReadOnly } from '../../src/utils/limitedLaunchAccess.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default as Waiting} from "./src/components/shared/IdentityWaitingNotice.jsx"; export {default as Notice} from "./src/components/shared/LaunchAccessNotice.jsx"; export {default as Archive} from "./src/components/features/ReadOnlyRecords.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'synthetic-account', setup(builder) {
    builder.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    builder.onResolve({ filter: /utils\/(credentialExport|invoicePdf)$/ }, () => ({ path: 'downloads', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context'
      ? 'export const useApp = () => globalThis.__weakNetworkFixture;'
      : path === 'database' ? 'export const COLLECTION_KEYS = ["licenses","invoices","documents","workLog"]; export const downloadDocumentFile = () => {throw Error("No network in render");};'
        : 'export const downloadBlob = () => {throw Error("No download during render");}; export const invoicePdfFile = downloadBlob; export const invoiceTextPdfFile = downloadBlob;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { Waiting, Notice, Archive } = mod.exports;
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

// What AppContext and useLimitedLaunchAccess give the screen after a launch
// whose identity check had no answer: this device's copy ("local"), no
// membership answer this session or remembered, no ready profile.
function weakLaunch({ licenses = [], behind = false } = {}) {
  return {
    user: { id: 'user_syntheticWeakOne' },
    theme: { text: '#111', textMuted: '#666', border: '#aaa', card: '#fff', bg: '#eee', warning: '#a60', warningDim: '#fea', accent: '#06c' },
    navigate() { throw Error('No navigation during render'); },
    isDesktop: false, offlineMode: false,
    data: { settings: {}, licenses },
    loadedFrom: 'local', deviceCopyBehind: behind,
    identityWaiting: { accountId: 'user_syntheticWeakOne', supportReference: 'ID-INIT-UNAVAILABLE-TIMEOUT-NETWORK' },
    limitedLaunch: { enabled: true, status: 'loading', error: null, access: null, remembered: { credential: null, practice: null },
      checking: false, reconnecting: true, outdated: false, profileReady: false, identityWaiting: true, refresh() {} },
  };
}
// The Credentials tab as App.jsx lays it out then: the identity notice, the
// launch notice (App renders it while reconnecting), and the read-only records.
function credentialsTab(value) {
  globalThis.__weakNetworkFixture = value;
  assert.equal(membershipReadOnly(value.limitedLaunch.access, 'credential', value.limitedLaunch.remembered), true, 'precondition: the records view App shows');
  return { waiting: render(Waiting), notice: render(Notice), archive: render(Archive, { scope: 'credential' }) };
}

test('after a weak-network launch the screen gives one message: retrying by itself, this device\'s copy, read only, nothing to tap', () => {
  const { waiting, notice, archive } = credentialsTab(weakLaunch({ licenses: [{ id: 'lic-1', name: 'Synthetic license' }] }));
  const all = text(waiting + notice + archive);
  assert.match(text(waiting), /keeps trying on its own/);
  assert.match(text(waiting), /copy saved on this device, read only/);
  assert.match(text(waiting), /nothing to tap/);
  assert.equal(notice, '', 'no second notice under it');
  assert.doesNotMatch(all, /Reload|reconnect your account|Try again|Check again/i, 'nothing asks for a tap');
  assert.doesNotMatch(waiting + notice, /<button/, 'no button in the notices');
  assert.doesNotMatch(all, /Membership expiry|membership ended|has ended/i, 'no membership verdict without an answer');
  assert.match(text(archive), /Synthetic license/, 'the copy is on screen');
  assert.equal((all.match(/on its own/g) || []).length, 1, 'said once');
});

test('the gate, when this device holds no membership answer to open on, says it is trying again and offers no Reload', () => {
  const gate = accessGateStatus({ enabled: true, identityWaiting: true, profileReady: false });
  assert.match(gate.lines.join(' '), /Trying again on its own\./);
  assert.equal(gate.action, null);
  // A real stop (the account load said why) still asks for the reload that helps.
  assert.equal(accessGateStatus({ enabled: true, initializationError: 'Your account identity could not be verified. Reload to try again.' }).action, 'reload');
});

test('a section empty in this device\'s copy is never called "No saved records"', () => {
  const { archive } = credentialsTab(weakLaunch());
  assert.doesNotMatch(text(archive), /No saved records in this section/);
  assert.match(text(archive), /This device has no saved copy of records in this section\. Your records show here once your account connects\./);
});

test('a copy left by a page whose last save never landed says it may lack the latest change, in the notice and in the empty section', () => {
  const { waiting, archive } = credentialsTab(weakLaunch({ behind: true }));
  assert.match(text(waiting), /Your latest changes may not be in this copy yet\./);
  assert.match(text(archive), /Your latest changes may not be in this device's copy yet\./);
  assert.doesNotMatch(text(archive), /No saved records/);
  // With records on screen the notice still says it.
  const shown = credentialsTab(weakLaunch({ behind: true, licenses: [{ id: 'lic-1', name: 'Synthetic license' }] }));
  assert.match(text(shown.waiting), /latest changes may not be in this copy yet/);
});

test('records read from the account itself keep "No saved records in this section" and the membership line', () => {
  const value = weakLaunch();
  value.loadedFrom = 'cloud';
  value.identityWaiting = null;
  Object.assign(value.limitedLaunch, { identityWaiting: false, reconnecting: false, profileReady: true, status: 'ready',
    access: { lifetime: { credential: false, practice: false }, purchasedOfferId: null, freeBeta: { state: 'expired', endsAt: '2026-09-01T00:00:00Z' },
      practiceTrial: { state: 'none' }, capabilities: { credential: { read: true, write: false, export: true }, practice: { read: true, write: false, export: true } } } });
  globalThis.__weakNetworkFixture = value;
  const archive = text(render(Archive, { scope: 'credential' }));
  assert.match(archive, /No saved records in this section\./);
  assert.match(archive, /Membership expiry does not delete your data\./);
  assert.equal(render(Waiting), '');
});
