// Third review of the IndexedDB offline copy (7bdca10b). Six findings, each
// reproduced here against the REAL storageScope.js and offlineStore.js (and
// the real Assistant, where the finding is about what it writes) over a 5 MB
// localStorage mock and an in-memory IndexedDB.
//
// A tab is one copy of storageScope.js and offlineStore.js with its own
// module state (the in-memory transcript, the purge epoch, the connection,
// writes in flight), written to node_modules/.cache and imported separately;
// the tabs share one localStorage and one IndexedDB, as two tabs of the
// installed app do. Each tab opens IndexedDB through its own factory, so one
// tab's open can be held, failed, or left with transactions that never
// answer, while the other's works.
//
// Synthetic accounts only: no real names, numbers or records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const ls = new QuotaLocalStorage(5 * 1024 * 1024);
globalThis.localStorage = ls;
globalThis.window = globalThis.window || {};
let idb = createMemoryIndexedDB();
globalThis.indexedDB = idb;

const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 60) => { for (let i = 0; i < n; i += 1) await tick(); };
const stored = key => idb.dump().get(key) ?? null;

function freshDevice() {
  ls.clear(); ls.failAll = false;
  idb = createMemoryIndexedDB();
  globalThis.indexedDB = idb;
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

const tabCache = resolve(root, `node_modules/.cache/credentialdomd-offline-tabs3-${process.pid}`);
let tabCount = 0;
async function openTab() {
  const dir = join(tabCache, `tab${tabCount += 1}`);
  mkdirSync(dir, { recursive: true });
  const abs = rel => JSON.stringify(pathToFileURL(resolve(root, 'src/utils', rel)).href);
  const scopeSource = readFileSync(resolve(root, 'src/utils/storageScope.js'), 'utf8')
    .replace('from "../constants/defaults.js"', `from ${abs('../constants/defaults.js')}`)
    .replace('from "./supportTextDrafts.js"', `from ${abs('./supportTextDrafts.js')}`)
    .replace('from "./pausedApplicationRecords.js"', `from ${abs('./pausedApplicationRecords.js')}`)
    .replace('from "./heldChanges.js"', `from ${abs('./heldChanges.js')}`)
    .replace('from "./loadRebase.js"', `from ${abs('./loadRebase.js')}`);
  writeFileSync(join(dir, 'storageScope.js'), scopeSource);
  writeFileSync(join(dir, 'offlineStore.js'), readFileSync(resolve(root, 'src/utils/offlineStore.js'), 'utf8'));
  const scope = await import(pathToFileURL(join(dir, 'storageScope.js')).href);
  const store = await import(pathToFileURL(join(dir, 'offlineStore.js')).href);
  // "pass" opens at once, "hold" waits for release(ok), "fail" fails the open,
  // "hang" opens but no transaction on the connection ever answers.
  const fac = { mode: 'pass', held: [] };
  fac.open = (name, version) => {
    if (fac.mode === 'pass') return idb.open(name, version);
    const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    if (fac.mode === 'hang') {
      const real = idb.open(name, version);
      real.onupgradeneeded = (e) => { req.result = real.result; req.onupgradeneeded?.(e); };
      real.onsuccess = (e) => {
        const db = real.result;
        req.result = { objectStoreNames: db.objectStoreNames, close() {},
          transaction: () => ({ objectStore: () => ({ get: () => ({}), put: () => ({}), delete: () => ({}) }) }) };
        req.onsuccess?.(e);
      };
      real.onerror = (e) => { req.error = real.error; req.onerror?.(e); };
      return req;
    }
    const answerOpen = (ok) => {
      if (!ok) { req.error = new Error('InvalidStateError'); req.onerror?.({ target: req }); return; }
      const real = idb.open(name, version);
      real.onupgradeneeded = (e) => { req.result = real.result; req.onupgradeneeded?.(e); };
      real.onsuccess = (e) => { req.result = real.result; req.onsuccess?.(e); };
      real.onerror = (e) => { req.error = real.error; req.onerror?.(e); };
    };
    if (fac.mode === 'fail') setImmediate(() => answerOpen(false));
    else fac.held.push(answerOpen);
    return req;
  };
  fac.release = (ok) => { for (const answerOpen of fac.held.splice(0)) answerOpen(ok); };
  // A new connection from here on (the old one is dropped, as a backgrounded tab's is).
  const reconnect = (mode) => { fac.mode = mode; store.setOfflineStoreFactory(fac); };
  reconnect('pass');
  const K = scope.BASE_KEYS;
  const key = (base, id) => scope.scopedKey(base, id);
  return { scope, store, fac, reconnect, K, key };
}

const fullFile = (extra = {}) => JSON.stringify({
  settings: { name: 'Dr. Synthetic Physician' },
  licenses: [{ id: 'license-synthetic-3r', state: 'TX', number: 'SYN-0000' }],
  identityVault: [{ id: 'identity-synthetic-3r', label: 'Synthetic application', ssn: 'enc1:SYNTHETIC' }],
  ...extra,
});

// ─── Finding 1: Delete All My Data in another tab, and this tab's memory ─────

test('a transcript deleted in another tab is not handed to the Assistant from this tab\'s memory, nor written back', async () => {
  freshDevice();
  const U = 'user_syntheticMirrorResurrect';
  const a = await openTab(), b = await openTab();
  const chatKey = a.key(a.K.chat, U), archivesKey = a.key(a.K.archives, U);
  const transcript = [{ id: 'm1', role: 'user', text: 'synthetic deleted question' }, { id: 'm2', role: 'assistant', text: 'synthetic deleted answer' }];
  const archived = [{ id: 'arc-deleted', title: 'Synthetic deleted chat', msgs: [] }];
  // Tab A signs in, loads, and Vera writes the transcript and an archive.
  a.scope.setActiveUserId(U);
  await settle();
  a.scope.adoptLocalFence(U);
  a.scope.largeSetJSON(a.K.chat, transcript, U);
  a.scope.largeSetJSON(a.K.archives, archived, U);
  await settle();
  assert.ok(stored(chatKey) && stored(archivesKey), 'precondition: both are in IndexedDB');

  // Tab B runs Delete All My Data (LegalSection, then honorAccountDataDeletion).
  b.scope.setActiveUserId(U);
  await settle();
  for (let i = 0; i < 2; i += 1) { b.scope.advanceLocalFence(U); assert.equal(await b.scope.purgeForSignOut(U), true); }
  b.scope.lsSet(b.scope.WIPE_SEEN_KEY, '2026-09-30T00:00:00.000Z', U);
  await settle();
  assert.equal(stored(chatKey), null);
  assert.equal(stored(archivesKey), null);

  // Tab A sees the fence move and loads again (AppContext purgedHere -> loadAgain -> readCachedData).
  assert.equal(a.scope.localCopyCurrent(U), false, 'precondition: tab A is fenced');
  await a.scope.hydrateOfflineStores(U);
  await a.scope.readOfflineFile(U);
  a.scope.adoptLocalFence(U);
  assert.equal(a.scope.largeGetJSON(a.K.chat, U), null, 'the deleted transcript is not in tab A\'s memory any more');
  assert.equal(a.scope.largeGetJSON(a.K.archives, U), null, 'nor the deleted archives');

  // The Assistant mounts in tab A.
  const { mountVera } = await import('../assistant-harness.mjs');
  const vera = await mountVera({ modules: { storageScope: a.scope } });
  assert.doesNotMatch(vera.pageText(), /synthetic deleted question/, 'nothing deleted on screen');
  await settle();
  vera.render();
  await settle();
  assert.equal(JSON.parse(stored(chatKey) ?? '[]').length, 0, 'the deleted transcript is not back on the device');
  assert.equal(JSON.parse(stored(archivesKey) ?? '[]').length, 0, 'nor the deleted archives');
  assert.equal(ls.getItem(chatKey), null);
  a.scope.setActiveUserId(null);
});

test('the memory tie to the fence: a store read under the old fence is read again, what is stored now is what is held', async () => {
  freshDevice();
  const U = 'user_syntheticMirrorFence';
  const a = await openTab(), b = await openTab();
  const chatKey = a.key(a.K.chat, U);
  const older = [{ id: 'o1', role: 'user', text: 'synthetic before the deletion' }];
  const after = [{ id: 'n1', role: 'user', text: 'synthetic after the deletion' }];
  a.scope.setActiveUserId(U);
  await settle();
  a.scope.adoptLocalFence(U);
  a.scope.largeSetJSON(a.K.chat, older, U);
  await settle();
  // Tab B deletes, then its fresh session stores a new transcript.
  b.scope.advanceLocalFence(U);
  await b.scope.purgeForSignOut(U);
  b.scope.adoptLocalFence(U);
  b.scope.setActiveUserId(U);
  await settle();
  b.scope.largeSetJSON(b.K.chat, after, U);
  await settle();
  assert.deepEqual(JSON.parse(stored(chatKey)), after);
  // Tab A, without any load yet: its memory is not taken for what is stored.
  assert.equal(a.scope.largeGetJSON(a.K.chat, U), null, 'the old transcript is dropped, not shown');
  assert.equal(a.scope.largeSetJSON(a.K.chat, older, U), false, 'and a write from before the deletion is refused');
  await a.scope.hydrateOfflineStores(U);
  assert.deepEqual(a.scope.largeGetJSON(a.K.chat, U), after, 'read again: what tab B stored after the deletion');
  a.scope.setActiveUserId(null);
  b.scope.setActiveUserId(null);
});

// ─── Finding 2: opening Vera in a tab hydrated earlier ───────────────────────

test('opening Vera in a tab that read the stores earlier keeps the archive and the transcript another tab stored since', async () => {
  freshDevice();
  const U = 'user_syntheticCrossTabVera';
  const a = await openTab(), b = await openTab();
  const chatKey = a.key(a.K.chat, U), archivesKey = a.key(a.K.archives, U);
  const earlier = [{ id: 'e1', role: 'user', text: 'synthetic earlier question' }, { id: 'e2', role: 'assistant', text: 'synthetic earlier answer' }];
  for (const t of [a, b]) { t.scope.adoptLocalFence(U); t.scope.setActiveUserId(U); await t.scope.hydrateOfflineStores(U); }
  b.scope.largeSetJSON(b.K.chat, earlier, U);
  await settle();
  // Tab A read the transcript before tab B wrote it; its memory is older.
  await a.scope.hydrateOfflineStores(U);
  assert.equal(a.scope.largeGetJSON(a.K.chat, U), null, 'precondition: tab A holds the older copy');

  // In tab B the member archives the conversation and asks something new.
  const archived = [{ id: 'arch-1', title: 'Synthetic archived chat', archivedAt: '2026-09-30T00:00:00.000Z', msgs: earlier }];
  const newer = [{ id: 'b1', role: 'user', text: 'synthetic question from tab B' }, { id: 'b2', role: 'assistant', text: 'synthetic answer in tab B' }];
  b.scope.largeSetJSON(b.K.archives, archived, U);
  b.scope.largeSetJSON(b.K.chat, newer, U);
  await settle();
  assert.equal(stored(archivesKey), JSON.stringify(archived), 'precondition: tab B stored them');

  // The member switches to tab A and opens Vera.
  const { mountVera } = await import('../assistant-harness.mjs');
  const vera = await mountVera({ modules: { storageScope: a.scope }, turn: async () => ({ reply: 'synthetic reply in tab A', actions: [] }) });
  vera.pageText();
  await settle();
  assert.equal(stored(archivesKey), JSON.stringify(archived), 'tab B\'s archived conversation survives Vera opening in tab A');
  assert.deepEqual(JSON.parse(stored(chatKey)), newer, 'and so does its transcript');
  const page = vera.pageText();
  assert.match(page, /synthetic question from tab B/, 'tab A shows what tab B stored');
  assert.match(page, /🗂 1/, 'and its archive');

  // What tab A adds keeps both.
  await vera.ask('synthetic question in tab A');
  await settle();
  vera.render();
  await settle();
  const texts = JSON.parse(stored(chatKey)).map(m => m.text);
  assert.ok(texts.includes('synthetic question from tab B') && texts.includes('synthetic question in tab A'));
  vera.button('New chat').props.onClick();
  vera.render();
  await settle();
  vera.render();
  await settle();
  assert.deepEqual(JSON.parse(stored(archivesKey)).map(x => x.id).slice(1), ['arch-1'], 'a new archive goes on top of tab B\'s');
  a.scope.setActiveUserId(null);
  b.scope.setActiveUserId(null);
});

test('Vera opened with nothing changed writes nothing back', async () => {
  freshDevice();
  const U = 'user_syntheticVeraNoWriteBack';
  const a = await openTab();
  const saved = [{ id: 's1', role: 'user', text: 'synthetic stored question' }, { id: 's2', role: 'assistant', text: 'synthetic stored answer' }];
  a.scope.adoptLocalFence(U);
  a.scope.setActiveUserId(U);
  await settle();
  a.scope.largeSetJSON(a.K.chat, saved, U);
  await settle();
  const writes = idb.writes.length;
  const { mountVera } = await import('../assistant-harness.mjs');
  const vera = await mountVera({ modules: { storageScope: a.scope } });
  assert.match(vera.pageText(), /synthetic stored question/);
  await settle();
  vera.render();
  await settle();
  assert.equal(idb.writes.length, writes, 'opening Vera writes neither the transcript nor the archives');
  a.scope.setActiveUserId(null);
});

// ─── Finding 3: localStorage too full for the home record ────────────────────

function fillLocalStorage(a, U, leaveBytes) {
  const qKey = a.key(a.K.pendingOps, U);
  ls.setItem(qKey, '[]');
  const shell = JSON.stringify([{ id: 'op-synthetic', table: 'caseLogs', payload: '' }]);
  const free = ls.quotaBytes - ls.usedBytes();
  const pad = 'x'.repeat(Math.floor((free - leaveBytes) / 2) - shell.length + 2);
  ls.setItem(qKey, JSON.stringify([{ id: 'op-synthetic', table: 'caseLogs', payload: pad }]));
  return ls.quotaBytes - ls.usedBytes();
}

test('an older build\'s copy moves to IndexedDB even when localStorage has no room left for the home record', async () => {
  freshDevice();
  const U = 'user_syntheticBrimFull';
  const a = await openTab();
  const dataKey = a.key(a.K.data, U);
  const file = JSON.stringify({ settings: { name: 'Dr. Synthetic' },
    caseLogs: Array.from({ length: 9000 }, (_, i) => ({ id: `case-${i}`, cpt: '61510' })),
    identityVault: [{ id: 'identity-brim', label: 'Synthetic' }] });
  ls.setItem(dataKey, file);
  const free = fillLocalStorage(a, U, 2);
  assert.ok(free < 128, `precondition: ${free} bytes free, less than the home record takes`);
  a.scope.adoptLocalFence(U);
  a.scope.setActiveUserId(U);
  await a.scope.hydrateOfflineStores(U);
  await settle();
  assert.equal(stored(dataKey), file, 'IndexedDB took the copy');
  assert.equal(ls.getItem(dataKey), null, 'localStorage is freed');
  assert.equal(ls.getItem(`${a.scope.OFFLINE_HOME_BASE}:${U}`), '1', 'and the home record is in the room it freed');
  const next = file.replace('Dr. Synthetic', 'Dr. Synthetic II');
  const saved = await a.scope.writeOfflineText(dataKey, next, a.scope.localWriteGuard(U));
  assert.equal(saved.saved, true, 'saves land again');
  assert.deepEqual(saved.refused, []);
  assert.equal(stored(dataKey), next);
  a.scope.setActiveUserId(null);
});

test('a write refused for want of room for the home record is named "full", not "could not be opened"', async () => {
  const a = await openTab();
  assert.equal(a.scope.storageRefusalKind(['indexeddb_unmarked', 'localstorage_quota']), 'full');
  assert.equal(a.scope.storageRefusalKind(['indexeddb_unmarked', 'localstorage_error']), 'unavailable');
});

test('a copy put in IndexedDB before its home record is purged by a Sign out that runs meanwhile', async () => {
  freshDevice();
  const U = 'user_syntheticUnmarkedPurge';
  const a = await openTab();
  const dataKey = a.key(a.K.data, U);
  // The moment inside a move with no room for the record: IndexedDB holds the
  // copy, localStorage still holds it too, and there is no home record yet.
  ls.setItem(dataKey, fullFile());
  assert.equal(await a.store.offlineWrite(dataKey, fullFile()), true);
  assert.equal(ls.getItem(`${a.scope.OFFLINE_HOME_BASE}:${U}`), null, 'precondition: no home record');
  assert.equal(await a.scope.purgeForSignOut(U), true);
  assert.equal(stored(dataKey), null, 'the IndexedDB copy is gone with the localStorage one');
  assert.equal(ls.getItem(dataKey), null);
  assert.equal(ls.getItem(`${a.scope.OFFLINE_PURGE_BASE}:${U}`), null, 'the purge committed');
});

test('a move with no room for the home record that is overtaken by a Sign out leaves nothing behind', async () => {
  for (let delay = 0; delay <= 12; delay += 1) {
    freshDevice();
    const U = `user_syntheticUnmarkedRace${delay}`;
    const a = await openTab(), b = await openTab();
    const dataKey = a.key(a.K.data, U);
    ls.setItem(dataKey, fullFile());
    fillLocalStorage(a, U, 2);
    const move = a.scope.moveToOfflineStore(dataKey, a.scope.localWriteGuard(U, { adopted: false }));
    for (let i = 0; i < delay; i += 1) await tick();
    assert.equal(await b.scope.purgeForSignOut(U), true);
    await move;
    await settle();
    await b.scope.sweepPendingOfflinePurges();
    assert.equal(stored(dataKey), null, `delay ${delay}: nothing of the account in IndexedDB after Sign out`);
    assert.equal(ls.getItem(dataKey), null, `delay ${delay}: nor in localStorage`);
  }
});

// ─── Finding 4: a transaction that never answers ────────────────────────────

test('an IndexedDB whose transactions never answer does not hold up the load, Sign out or a purge', async () => {
  freshDevice();
  const U = 'user_syntheticHangingTx';
  const a = await openTab();
  const dataKey = a.key(a.K.data, U);
  assert.equal((await a.scope.writeOfflineText(dataKey, fullFile(), () => true)).saved, true);
  assert.equal(ls.getItem(`${a.scope.OFFLINE_HOME_BASE}:${U}`), '1', 'precondition: the account has a copy there');
  a.store.setOfflineTransactionTimeout(150);
  a.reconnect('hang');
  const within = (promise, ms, what) => Promise.race([promise.then(v => ({ v })),
    new Promise(r => setTimeout(() => r(null), ms))]).then((r) => { assert.ok(r, `${what} did not finish`); return r.v; });
  await within(a.scope.hydrateOfflineStores(U), 3000, 'the hydration');
  assert.equal(await within(a.scope.readOfflineFile(U), 3000, 'the load\'s read'), null);
  assert.equal(a.scope.offlineCopyUnread(U), true, 'could not look, and says so');
  const counts = await within(a.scope.deviceOnlyRecordCounts(U), 3000, 'Sign out\'s count');
  assert.equal(counts.unread, true, 'Sign out is told it could not count');
  const save = await within(a.scope.writeOfflineText(dataKey, fullFile({ settings: { name: 'v2' } }), () => true), 3000, 'a save');
  assert.equal(save.refused[0], 'indexeddb_unread');
  assert.equal(await within(a.scope.purgeUserStorage(U), 3000, 'the purge'), true, 'the purge is durable: recorded as owed');
  assert.ok(ls.getItem(`${a.scope.OFFLINE_PURGE_BASE}:${U}`), 'and finished at the next chance');
  a.store.setOfflineTransactionTimeout();
  a.reconnect('pass');
  await a.scope.sweepPendingOfflinePurges();
  assert.equal(stored(dataKey), null, 'IndexedDB answers again: the purge is finished');
  assert.equal(ls.getItem(`${a.scope.OFFLINE_PURGE_BASE}:${U}`), null);
});

// ─── Finding 5: a move in one tab and a write in another ─────────────────────

test('another tab\'s move of an older localStorage copy never lands over a newer write, in any interleaving', async () => {
  const T1 = JSON.stringify({ settings: {}, identityVault: [{ id: 'r1', label: 'Synthetic one' }] });
  const T2 = JSON.stringify({ settings: {}, identityVault: [{ id: 'r1', label: 'Synthetic one' }, { id: 'r2', label: 'Synthetic two' }] });
  for (const path of ['move', 'load']) {
    for (let delay = 0; delay <= 12; delay += 1) {
      freshDevice();
      const U = `user_syntheticMoveRace${path}${delay}`;
      const a = await openTab(), b = await openTab();
      a.scope.adoptLocalFence(U); b.scope.adoptLocalFence(U);
      const dataKey = a.key(a.K.data, U);
      assert.equal((await b.scope.writeOfflineText(dataKey, JSON.stringify({ settings: {}, identityVault: [] }), b.scope.localWriteGuard(U))).saved, true);
      // Tab B's connection is lost: its save of r1 falls back to localStorage.
      b.reconnect('fail');
      assert.deepEqual((await b.scope.writeOfflineText(dataKey, T1, b.scope.localWriteGuard(U))).refused, ['indexeddb_unavailable']);
      // Reconnected, the member adds r2 in tab B, while tab A opens.
      b.reconnect('pass');
      const writeB = b.scope.writeOfflineText(dataKey, T2, b.scope.localWriteGuard(U));
      for (let i = 0; i < delay; i += 1) await tick();
      const inA = path === 'move'
        ? a.scope.moveToOfflineStore(dataKey, a.scope.localWriteGuard(U, { adopted: false }))
        : a.scope.hydrateOfflineStores(U).then(() => a.scope.readOfflineFile(U));
      const [resultB, resultA] = await Promise.all([writeB, inA]);
      await settle();
      assert.equal(resultB.saved, true);
      const where = ls.getItem(dataKey) ?? stored(dataKey);
      assert.equal(where, T2, `${path}, delay ${delay}: r2 is what the device holds`);
      if (ls.getItem(dataKey) == null) assert.equal(stored(dataKey), T2);
      if (path === 'load') assert.equal(resultA.text, T2, `${path}, delay ${delay}: tab A's load reads r2`);
    }
  }
});

// ─── Finding 6: a write in flight across another tab's finished Sign out ─────

test('a write waiting on its open across another tab\'s finished Sign out does not fall back to localStorage', async () => {
  freshDevice();
  const U = 'user_syntheticAbaFallback';
  const a = await openTab(), b = await openTab();
  const dataKey = a.key(a.K.data, U);
  a.scope.adoptLocalFence(U); b.scope.adoptLocalFence(U);
  assert.equal((await b.scope.writeOfflineText(dataKey, fullFile(), b.scope.localWriteGuard(U))).saved, true);
  a.reconnect('hold');
  const late = a.scope.writeOfflineText(dataKey, fullFile({ settings: { name: 'tab A later' } }), a.scope.localWriteGuard(U));
  await settle(10);
  assert.equal(await b.scope.purgeForSignOut(U), true);
  assert.equal(ls.getItem(`${a.scope.OFFLINE_PURGE_BASE}:${U}`), null, 'precondition: the purge record came and went');
  assert.equal(ls.getItem(`${a.scope.OFFLINE_HOME_BASE}:${U}`), null, 'and the home record went');
  a.fac.mode = 'fail';
  a.fac.release(false);
  const result = await late;
  assert.equal(result.saved, false);
  assert.equal(result.stopped, true, 'the write predates the Sign out');
  assert.equal(ls.getItem(dataKey), null, 'the file is not in localStorage after Sign out');
  assert.equal(stored(dataKey), null);
});

test('an account\'s first write waiting on its open across another tab\'s Sign out does not land in IndexedDB', async () => {
  freshDevice();
  const U = 'user_syntheticAbaFirstWrite';
  const a = await openTab(), b = await openTab(), c = await openTab();
  const dataKey = a.key(a.K.data, U);
  a.scope.adoptLocalFence(U); b.scope.adoptLocalFence(U);
  a.reconnect('hold');
  const late = a.scope.writeOfflineText(dataKey, fullFile(), a.scope.localWriteGuard(U)); // no home record yet
  await settle(10);
  assert.equal(await b.scope.purgeForSignOut(U), true);
  a.fac.mode = 'pass';
  a.fac.release(true);
  const result = await late;
  assert.equal(result.saved, false);
  assert.equal(result.stopped, true);
  // No listener in tab A runs (an offline-mode tab, or one killed first); a fresh tab boots.
  await c.scope.sweepPendingOfflinePurges();
  assert.equal(stored(dataKey), null, 'nothing of the account in IndexedDB after Sign out');
  assert.equal(ls.getItem(`${a.scope.OFFLINE_HOME_BASE}:${U}`), null);
  assert.equal(ls.getItem(dataKey), null);
});

test('a purge still stops a write in flight when localStorage refused the generation at first', async () => {
  freshDevice();
  const U = 'user_syntheticGenerationFull';
  const a = await openTab(), b = await openTab();
  const dataKey = a.key(a.K.data, U);
  a.scope.adoptLocalFence(U); b.scope.adoptLocalFence(U);
  // The account's first write (no home record to vanish), with localStorage
  // full until the purge removes the account's keys.
  fillLocalStorage(a, U, 0);
  a.reconnect('hold');
  const late = a.scope.writeOfflineText(dataKey, fullFile({ settings: { name: 'tab A later' } }), a.scope.localWriteGuard(U));
  await settle(10);
  assert.equal(await b.scope.purgeForSignOut(U), true, 'the purge frees the room it needs');
  a.fac.mode = 'pass';
  a.fac.release(true);
  const result = await late;
  assert.equal(result.stopped, true);
  assert.equal(stored(dataKey), null);
  assert.equal(ls.getItem(dataKey), null);
});
