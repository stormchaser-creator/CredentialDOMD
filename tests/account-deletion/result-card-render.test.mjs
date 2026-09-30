// SETTINGS-005 after the SYNC-012 merge: an answered Delete All My Data
// reopens the account (AppContext.reopenAfterAccountDeletion), and the app
// shows its loading screen while the account loads again. That unmounts the
// Data Rights page, so the "deleted from this device and from our servers"
// card was set on a page that was already gone and never seen. The real
// LegalSection, rendered as it mounts again after that reload, shows it.
//
// Real component, synthetic account; no network, storage or deletion runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundled = await build({
  // One bundle, so the test remembers a result in the same module instance
  // the page reads it from.
  stdin: { contents: 'export {default as LegalSection} from "./src/components/pages/LegalSection.jsx"; export { rememberDeletionResult } from "./src/utils/accountDeletionResult.js";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'synthetic-account', setup(builder) {
    builder.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    builder.onResolve({ filter: /utils\/storageScope$/ }, () => ({ path: 'storage', namespace: 'fixture' }));
    builder.onResolve({ filter: /utils\/dataDeletion\.js$/ }, () => ({ path: 'deletion', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      context: 'export const useApp = () => globalThis.__deletionCardFixture;',
      database: 'const no = () => { throw Error("No deletion during render"); }; export const deleteAllData = no, requestAccountDeletion = no, readAccountDataDeletion = no, clearDeviceKeys = no;',
      storage: 'const no = () => { throw Error("No storage during render"); }; export const purgeUserStorage = no, advanceLocalFence = no, lsGet = no; export const WIPE_SEEN_KEY = "synthetic";',
      deletion: 'const no = () => { throw Error("No purge during render"); }; export const honorAccountDataDeletion = no, recordDataDeletionSeen = no, sameDeletionStamp = no;',
    }[path] }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { LegalSection, rememberDeletionResult } = mod.exports;

const render = accountId => {
  globalThis.__deletionCardFixture = {
    user: { id: accountId }, data: { settings: { theme: 'dark' } },
    theme: { text: '#111', textMuted: '#666', textDim: '#888', border: '#aaa', card: '#fff', danger: '#c00', dangerDim: '#fee', input: '#fff', shadow1: 'none' },
    beginAccountDeletion() { throw Error('No deletion during render'); },
    resetAfterAccountDeletion() {}, reopenAfterAccountDeletion() {}, holdAfterUnconfirmedDeletion() {},
  };
  return renderToStaticMarkup(React.createElement(LegalSection, { page: 'data-rights' }));
};

test('after the reopen reloads the account, Data Rights mounts again showing that the deletion finished', () => {
  rememberDeletionResult('user_syntheticA', { state: 'done' });
  const html = render('user_syntheticA');
  assert.match(html, /role="status"/);
  assert.match(html, /All your data was deleted from this device and from our servers\./);
  assert.match(html, /Your sign-in account stays open\./);
  assert.doesNotMatch(html, /Try again/, 'no retry button on the page');
});

test('another account on the same page session sees no card, and a cleared result shows none', () => {
  rememberDeletionResult('user_syntheticA', { state: 'done' });
  assert.doesNotMatch(render('user_syntheticB'), /All your data was deleted/);
  rememberDeletionResult('user_syntheticA', null);
  assert.doesNotMatch(render('user_syntheticA'), /role="(status|alert)"/);
});

test('a device-only deletion is still shown as not reaching the servers', () => {
  rememberDeletionResult('user_syntheticA', { state: 'local' });
  const html = render('user_syntheticA');
  assert.match(html, /role="alert"/);
  assert.match(html, /deleted from this device only/);
});
