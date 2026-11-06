// A plain transaction abort (idbLost false) reports reason
// "indexeddb_unavailable,localstorage_reserved", which storageRefusalKind
// sorts as "unavailable" -- the same state the on-screen notice already
// explains while a change from that write is still unsent. Synthetic data
// only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount } from '../harness/component-harness.mjs';
import { storageRefusalKind } from '../../src/utils/storageScope.js';

const { SyncIssuesNotice } = await loadScreens('export { SavedWriteIssuesNotice as SyncIssuesNotice } from "./src/components/shared/SyncIssuesNotice.jsx";', {
  expose: { 'src/components/shared/SyncIssuesNotice.jsx': ['SavedWriteIssuesNotice'] },
});

test('a transaction-abort refusal explains itself on the device that saw it', () => {
  const reason = 'indexeddb_unavailable,localstorage_reserved';
  assert.equal(storageRefusalKind(reason), 'unavailable', 'the reason this ticket reported sorts as "unavailable"');

  const m = mount(SyncIssuesNotice, { data: {} });
  Object.assign(globalThis.__screen.app, { syncIssues: [], pendingWrites: 1, offlineMode: false, offlineCopyStale: 'unavailable', navigate() {} });
  const html = m.html();
  assert.match(html, /offline storage could not be opened/, 'the member sees why the write was refused while it is still unsent');
  assert.match(html, /records could not be updated/, 'and that the copy on the device is behind');
  assert.match(html, /Reload the app to open it again\./, 'and what to do about it');
});
