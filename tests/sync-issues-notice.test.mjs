import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, button } from './harness/component-harness.mjs';
import { describeSyncIssues } from '../src/utils/syncIssues.js';
import { classifyWriteError, describeWriteError } from '../src/utils/syncRules.js';

// SYNC-001: a record the cloud refused must not look saved. The notice names
// each one, says why in plain words, and opens it. Synthetic records only.

const { SyncIssuesNotice } = await loadScreens('export { default as SyncIssuesNotice } from "./src/components/shared/SyncIssuesNotice.jsx";');

function show({ issues = [], pending = 0, offline = false, data = {} } = {}) {
  const m = mount(SyncIssuesNotice, { data });
  const navigations = [];
  Object.assign(globalThis.__screen.app, { syncIssues: issues, pendingWrites: pending, offlineMode: offline,
    navigate: (...args) => navigations.push(args) });
  return { m, navigations };
}

test('SYNC-001: codes sort into permanent, denied and transient', () => {
  for (const code of ['23502', '22P02', '22007', '23514', 'PGRST204']) assert.equal(classifyWriteError({ code }), 'permanent', code);
  assert.equal(classifyWriteError({ code: '42501' }), 'denied');
  for (const error of [{ message: 'Failed to fetch' }, { code: 'PGRST301' }, { code: '57014' }, { code: '40001' }]) assert.equal(classifyWriteError(error), 'transient');
  assert.equal(describeWriteError('23502'), 'a required field is blank');
});

test('SYNC-001: only refused records that still exist are listed, with a plain reason', () => {
  const data = { settings: {}, cme: [{ id: 'c1', title: 'Synthetic Course' }], licenses: [] };
  const lines = describeSyncIssues([{ collectionKey: 'cme', id: 'c1', code: '23502' }, { collectionKey: 'licenses', id: 'gone', code: '22P02' }], data);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].title, 'Synthetic Course');
  assert.equal(lines[0].reason, 'a required field is blank');
  assert.deepEqual([lines[0].tab, lines[0].sub], ['credentials', 'cme']);
});

test('SYNC-001: nothing refused and nothing waiting shows nothing', () => {
  const { m } = show({ data: { cme: [] } });
  assert.equal(m.html(), '');
});

test('SYNC-001: a refused record is named as not saved, and Open goes to it', () => {
  const { m, navigations } = show({ issues: [{ collectionKey: 'cme', id: 'c1', code: '23502' }], pending: 1,
    data: { cme: [{ id: 'c1', title: 'Synthetic Course' }] } });
  const html = m.html();
  assert.match(html, /Not saved to your account/);
  assert.match(html, /Synthetic Course/);
  assert.match(html, /a required field is blank/);
  assert.doesNotMatch(html, /—/, 'no em dashes in the copy');
  button(m.render(), 'Open').props.onClick();
  assert.deepEqual(navigations, [['credentials', 'cme', { sec: 'cme', id: 'c1' }]]);
});

test('SYNC-001: writes still waiting are counted; offline, the offline banner says it instead', () => {
  assert.match(show({ pending: 2, data: {} }).m.html(), /2 changes have not reached your account yet/);
  assert.equal(show({ pending: 2, offline: true, data: {} }).m.html(), '');
});

test('SYNC-017: a full device storage is said, because the offline copy is older than the screen', () => {
  const m = mount(SyncIssuesNotice, { data: {} });
  Object.assign(globalThis.__screen.app, { syncIssues: [], pendingWrites: 0, offlineMode: false, offlineCopyStale: true, navigate() {} });
  assert.match(m.html(), /storage is full, so its offline copy of your records could not be updated/);
});

test('QA3: saves kept on this device for want of a membership answer say they will sync', () => {
  const m = mount(SyncIssuesNotice, { data: {} });
  Object.assign(globalThis.__screen.app, { syncIssues: [], pendingWrites: 3, awaitingAccessWrites: 2, offlineMode: false, navigate() {} });
  const html = m.html();
  assert.match(html, /2 changes are saved on this device and will sync to your account when the app reconnects\./);
  assert.match(html, /1 change has not reached your account yet/, 'the other queued write keeps its own line');
  assert.doesNotMatch(html, /—/, 'no em dashes in the copy');
  Object.assign(globalThis.__screen.app, { pendingWrites: 1, awaitingAccessWrites: 1 });
  assert.match(m.html(), /1 change is saved on this device and will sync/);
  assert.doesNotMatch(m.html(), /not reached your account/);
});

test('QA3: saves kept for want of an answer that the answer then refused say so, and are not promised a sync on reconnect', () => {
  const m = mount(SyncIssuesNotice, { data: {} });
  // Queued under a failed check; the next check answered read-only (lib/supabase.js accessRefused).
  Object.assign(globalThis.__screen.app, { syncIssues: [], pendingWrites: 1, awaitingAccessWrites: 1, accessRefusedWrites: 1, offlineMode: false, navigate() {} });
  let html = m.html();
  assert.match(html, /1 change on this device could not be saved to your account because your membership no longer allows changes\. It stays on this device and will sync if your membership allows changes again\./);
  assert.doesNotMatch(html, /when the app reconnects/, 'the app is connected; reconnecting would not send it');
  assert.doesNotMatch(html, /not reached your account yet/);
  assert.doesNotMatch(html, /—/, 'no em dashes in the copy');
  // With others still waiting for an answer, and one plain unsent write, each keeps its own line.
  Object.assign(globalThis.__screen.app, { pendingWrites: 5, awaitingAccessWrites: 4, accessRefusedWrites: 2 });
  html = m.html();
  assert.match(html, /2 changes on this device could not be saved to your account/);
  assert.match(html, /They stay on this device/);
  assert.match(html, /2 changes are saved on this device and will sync to your account when the app reconnects\./);
  assert.match(html, /1 change has not reached your account yet/);
  // Beside records the cloud refused, it is its own line.
  Object.assign(globalThis.__screen.app, { syncIssues: [{ collectionKey: 'cme', id: 'c1', code: '23502' }], pendingWrites: 2, awaitingAccessWrites: 1, accessRefusedWrites: 1 });
  globalThis.__screen.app.data = { cme: [{ id: 'c1', title: 'Synthetic Course' }] };
  html = m.html();
  assert.match(html, /Not saved to your account/);
  assert.match(html, /data-sync-refused/);
});
