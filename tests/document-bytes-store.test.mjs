// utils/documentBytes.js: a stored file's bytes, fetched while a screen shows
// it, for the account rather than for one load, tried again on a weak link,
// said truthfully offline, and held in memory only within a bound. The
// owner's iPhone (iOS 18.7, about 58 stored files, 74 MB) is why each rule is
// here. Synthetic documents only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentBytes, storedFileOf, fileWaitText, fileWaitLine, fileWaitTag, RETRY_MS, STALL_MS } from '../src/utils/documentBytes.js';

const OWNER = 'user_syntheticBytes';
const doc = (id, extra = {}) => ({ id, name: `${id}.pdf`, type: 'application/pdf', size: 10, storagePath: `${OWNER}/${id}`, ...extra });
const bytes = (n, ch = 'A') => `data:application/pdf;base64,${ch.repeat(n)}`;

/** A store over a screen's documents, a fake clock and timers, and downloads the test answers. */
function store({ docs = [], keepChars, atOnce, online = true, canFetch = true } = {}) {
  let now = 1000;
  const timers = [];
  const net = { online, canFetch };
  const s = { documents: docs, account: OWNER, downloads: [], updates: 0, missing: new Set() };
  s.bytes = createDocumentBytes({
    documents: () => s.documents,
    account: () => s.account,
    fetch: (path, { signal, onProgress } = {}) => new Promise((resolve) => {
      const d = { path, resolve, signal, onProgress, aborted: false };
      signal?.addEventListener?.('abort', () => { d.aborted = true; resolve({ failed: true }); });
      s.downloads.push(d);
    }),
    update: (fn, account) => { if (account !== s.account) return; s.updates += 1; s.documents = fn(s.documents); },
    online: () => net.online, canFetch: () => net.canFetch,
    missing: { has: (p) => s.missing.has(p), add: (p) => s.missing.add(p), delete: (p) => s.missing.delete(p) },
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, done: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.done = true; },
    defer: (fn) => queueMicrotask(fn),
    ...(keepChars != null ? { keepChars } : {}), ...(atOnce != null ? { atOnce } : {}),
  });
  s.net = net;
  s.advance = async (ms) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => !t.done && t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.done = true;
      due.fn();
      await settle();
    }
    await settle();
  };
  s.doc = (id) => s.documents.find((d) => d.id === id);
  s.open = () => s.downloads.filter((d) => !d.settled && !d.aborted);
  s.answer = async (i, value) => { s.downloads[i].settled = true; s.downloads[i].resolve(value); await settle(); };
  return s;
}
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

test('a download that lands after a load replaced the records goes on the document on screen now', async () => {
  const s = store({ docs: [doc('a')] });
  s.bytes.want(['a']);
  await settle();
  assert.equal(s.downloads.length, 1);
  s.documents = [doc('a')];   // a load: the same row, read again, no bytes
  s.bytes.pump();
  await settle();
  assert.equal(s.downloads.length, 1, 'still the one download, not a second');
  await s.answer(0, { dataUrl: bytes(8) });
  assert.equal(s.doc('a').data, bytes(8));
  assert.equal(s.bytes.status(s.doc('a')), null);
});

test('a download for a file replaced meanwhile (another size) is not put on the new file, which is fetched itself', async () => {
  const s = store({ docs: [doc('a')] });
  s.bytes.want(['a']);
  await settle();
  s.documents = [doc('a', { size: 99 })];
  s.bytes.pump();
  await settle();
  assert.equal(s.downloads[0].aborted, true, 'the old file\'s download is stopped');
  assert.equal(s.downloads.length, 2);
  await s.answer(1, { dataUrl: bytes(4, 'B') });
  assert.equal(s.doc('a').data, bytes(4, 'B'));
});

test('a download that lands after another account signed in puts nothing on its documents', async () => {
  const s = store({ docs: [doc('a')] });
  s.bytes.want(['a']);
  await settle();
  s.account = 'user_syntheticOther';
  s.documents = [doc('a', { storagePath: 'user_syntheticOther/a' })];
  await s.answer(0, { dataUrl: bytes(8) });
  assert.equal(s.doc('a').data, undefined);
  assert.equal(s.updates, 0);
});

test('a file Storage does not have is marked missing on screen, never as an edit, and not asked for again', async () => {
  const s = store({ docs: [doc('m')] });
  s.bytes.want(['m']);
  await settle();
  await s.answer(0, { missing: true });
  assert.equal(s.doc('m').fileMissing, true);
  assert.equal(s.bytes.status(s.doc('m')), null, 'not "loading": the card says it is missing');
  s.documents = [doc('m')];   // a load brings the row back without the note
  s.bytes.pump();
  s.bytes.unwant(['m']); s.bytes.want(['m']);
  await settle();
  assert.equal(s.downloads.length, 1, 'asked once this session');
  assert.equal(s.doc('m').fileMissing, true, 'and said again on the row the load put back, never "Fetching" for good');
});

// Review of release/goal2 (2026-10-02): the missing list was keyed by path
// alone and never emptied. "Upload it again" writes the new file to the same
// path (<account>/<doc id>); once its bytes were let go (Mail, or the screen
// left) the next visit read "Missing from your account" for a file in Storage.
test('a file given again with "Upload it again" under the same path is fetched again once its bytes are let go', async () => {
  for (const stamp of ['2026-10-02T12:00:00Z', undefined]) {
    const s = store({ docs: [doc('m', { updatedAt: '2026-08-01T00:00:00Z' })] });
    s.bytes.want(['m']);
    await settle();
    await s.answer(0, { missing: true });
    assert.equal(s.doc('m').fileMissing, true);
    // Given again as reuploadFile does: the same path, the same size and type
    // (often the very same file), stamped (or, the must-pass case, not).
    const given = { ...doc('m', { updatedAt: stamp ?? '2026-08-01T00:00:00Z' }), data: bytes(8) };
    s.documents = [given];
    s.bytes.pump();
    s.bytes.unwant(['m']);
    s.bytes.hidden();
    await settle();
    assert.equal(s.doc('m').data, undefined, 'its bytes are let go while the page is hidden');
    s.bytes.visible();
    s.bytes.want(['m']);
    await settle();
    assert.equal(s.doc('m').fileMissing, undefined, `not said missing again (stamp ${stamp ?? 'unchanged'})`);
    assert.equal(s.bytes.status(s.doc('m')), 'loading');
    assert.equal(s.downloads.length, 2, 'fetched from the account');
    await s.answer(1, { dataUrl: bytes(8) });
    assert.equal(s.doc('m').data, bytes(8));
  }
});

test('a file found missing here and given again on another device (the row stamped) is fetched on the next load', async () => {
  const s = store({ docs: [doc('m', { updatedAt: '2026-08-01T00:00:00Z' })] });
  s.bytes.want(['m']);
  await settle();
  await s.answer(0, { missing: true });
  s.documents = [doc('m', { updatedAt: '2026-08-01T00:00:00Z' })];   // a load: unchanged
  s.bytes.pump();
  await settle();
  assert.equal(s.downloads.length, 1, 'the same row is not asked for again');
  assert.equal(s.doc('m').fileMissing, true);
  s.documents = [doc('m', { updatedAt: '2026-10-02T12:00:00Z' })];   // the Mac gave it again
  s.bytes.pump();
  await settle();
  assert.equal(s.downloads.length, 2);
  assert.equal(s.bytes.status(s.doc('m')), 'loading');
});

// Review of release/goal2 (2026-10-02): filing an emailed document rewrites
// its type from the inbox marker to its MIME type; the identity read the raw
// type, so a download in flight was stopped as stale and fetched again from
// the start, on the owner's weak iPhone link.
test('an emailed file filed while it downloads is not fetched a second time', async () => {
  const inbox = doc('e1', { type: 'cme-certificate-inbox', mimeType: 'application/pdf' });
  const s = store({ docs: [inbox] });
  s.bytes.want(['e1']);
  await settle();
  assert.equal(s.downloads.length, 1);
  s.documents = [{ ...inbox, type: 'application/pdf', linkedTo: 'cme:c1' }];   // leaveInbox
  s.bytes.pump();
  await settle();
  assert.equal(s.downloads[0].aborted, false, 'the download goes on');
  assert.equal(s.downloads.length, 1);
  await s.answer(0, { dataUrl: bytes(8) });
  assert.equal(s.doc('e1').data, bytes(8));
  assert.equal(storedFileOf(inbox), storedFileOf({ ...inbox, type: 'application/pdf' }));
  // Must pass: a file given again with another type is another file.
  assert.notEqual(storedFileOf(doc('a')), storedFileOf(doc('a', { type: 'image/jpeg' })));
});

test('a failed download is tried again on its own, sooner when the connection comes back, and says so meanwhile', async () => {
  const s = store({ docs: [doc('a')] });
  s.bytes.want(['a']);
  await settle();
  await s.answer(0, { failed: true });
  assert.equal(s.bytes.status(s.doc('a')), 'failed');
  assert.equal(s.downloads.length, 1);
  await s.advance(RETRY_MS[0] - 1);
  assert.equal(s.downloads.length, 1, 'not before its time');
  await s.advance(1);
  assert.equal(s.downloads.length, 2, 'tried again');
  assert.equal(s.bytes.status(s.doc('a')), 'loading');
  await s.answer(1, { failed: true });
  // The next wait is longer, but the connection coming back (or the app
  // back in front) asks at once.
  s.bytes.retryNow();
  await settle();
  assert.equal(s.downloads.length, 3);
  await s.answer(2, { dataUrl: bytes(8) });
  assert.equal(s.doc('a').data, bytes(8));
});

test('offline nothing is asked and the file says so; back online it is fetched', async () => {
  const s = store({ docs: [doc('a')], online: false });
  s.bytes.want(['a']);
  await settle();
  assert.equal(s.downloads.length, 0);
  assert.equal(s.bytes.status(s.doc('a')), 'offline');
  assert.match(fileWaitText('offline'), /You are offline\. The file opens here once you are back online\./);
  s.net.online = true;
  s.bytes.retryNow();
  await settle();
  assert.equal(s.downloads.length, 1);
  assert.equal(s.bytes.status(s.doc('a')), 'loading');
});

test('an offline session (no cloud client) asks for nothing', async () => {
  const s = store({ docs: [doc('a')], canFetch: false });
  s.bytes.want(['a']);
  await settle();
  assert.equal(s.downloads.length, 0);
  assert.equal(s.bytes.status(s.doc('a')), 'offline');
});

test('a download that stalls on a weak link is stopped and tried again; one whose bytes keep arriving goes on', async () => {
  const s = store({ docs: [doc('slow'), doc('stuck')], atOnce: 2 });
  s.bytes.want(['slow', 'stuck']);
  await settle();
  const slow = s.downloads.find((d) => d.path.endsWith('/slow'));
  const stuck = s.downloads.find((d) => d.path.endsWith('/stuck'));
  await s.advance(STALL_MS - 1000);
  slow.onProgress(1000);
  await s.advance(1000);
  assert.equal(stuck.aborted, true, 'no bytes for STALL_MS: stopped');
  assert.equal(s.bytes.status(s.doc('stuck')), 'failed');
  for (let i = 2; i < 6; i += 1) { await s.advance(STALL_MS / 2); slow.onProgress(1000 * i); }
  assert.equal(slow.aborted, false, 'a large scan whose bytes keep arriving is never stopped');
  assert.ok(s.downloads.filter((d) => d.path.endsWith('/stuck')).length >= 2, 'the stalled one is tried again');
});

test('two at a time, what was wanted last first', async () => {
  const s = store({ docs: ['a', 'b', 'c', 'd'].map((id) => doc(id)), atOnce: 2 });
  s.bytes.want(['a', 'b']);
  await settle();
  s.bytes.want(['c', 'd']);
  await settle();
  assert.deepEqual(s.downloads.map((d) => d.path.split('/')[1]).sort(), ['a', 'b']);
  await s.answer(0, { dataUrl: bytes(2) });
  assert.equal(s.downloads.length, 3);
  assert.ok(['c', 'd'].includes(s.downloads[2].path.split('/')[1]), 'the newer screen\'s files come next');
});

test('bytes no screen shows are kept within the bound, the least recently shown dropped first; hidden, none are kept', async () => {
  const s = store({ docs: ['a', 'b', 'c'].map((id) => doc(id)), keepChars: 80 });
  for (const [i, id] of ['a', 'b', 'c'].entries()) {
    s.bytes.want([id]);
    await settle();
    await s.answer(i, { dataUrl: bytes(10, id.toUpperCase()) });
    s.bytes.unwant([id]);
    await settle();
  }
  // Each data URL is 38 characters: two fit in 80, the third (the oldest) goes.
  assert.equal(s.doc('a').data, undefined, 'the least recently shown is let go');
  assert.ok(s.doc('b').data && s.doc('c').data, 'the two most recent are kept: back to them is instant');
  s.bytes.hidden();
  await settle();
  assert.ok(['a', 'b', 'c'].every((id) => !s.doc(id).data), 'hidden (the iPhone in Mail): none kept');
});

test('a file a screen shows is never let go, and one not yet in the account never is', async () => {
  const s = store({ docs: [doc('shown'), { id: 'local', name: 'local.pdf', data: bytes(30, 'L') }, doc('again', { data: bytes(30, 'P'), pendingUpload: true })], keepChars: 0 });
  s.bytes.want(['shown']);
  await settle();
  await s.answer(0, { dataUrl: bytes(30, 'S') });
  s.bytes.hidden();
  await settle();
  assert.equal(s.doc('shown').data, bytes(30, 'S'), 'on screen: kept');
  assert.equal(s.doc('local').data, bytes(30, 'L'), 'never uploaded: its only copy');
  assert.equal(s.doc('again').data, bytes(30, 'P'), 'given again and not in Storage yet: its only copy');
});

test('a screen that lets its files go and asks for them again in the same pass keeps their bytes', async () => {
  const s = store({ docs: [doc('a')], keepChars: 0 });
  s.bytes.want(['a']);
  await settle();
  await s.answer(0, { dataUrl: bytes(8) });
  s.bytes.unwant(['a']);
  s.bytes.want(['a']);
  await settle();
  assert.equal(s.doc('a').data, bytes(8));
  assert.equal(s.downloads.length, 1, 'not downloaded again');
});

test('a record closed while its file downloads lets it finish: opened again (on a weak link), the file is there', async () => {
  const s = store({ docs: [doc('a')] });
  s.bytes.want(['a']);
  await settle();
  s.bytes.unwant(['a']);
  await settle();
  assert.equal(s.downloads[0].aborted, false, 'not thrown away');
  await s.answer(0, { dataUrl: bytes(8) });
  assert.equal(s.doc('a').data, bytes(8), 'kept within the bound');
  s.bytes.want(['a']);
  await settle();
  assert.equal(s.downloads.length, 1, 'not downloaded again');
});

test('a download no screen wants gives its place up to a file a screen shows', async () => {
  const s = store({ docs: ['a', 'b', 'c'].map((id) => doc(id)), atOnce: 2 });
  s.bytes.want(['a', 'b']);
  await settle();
  s.bytes.unwant(['a', 'b']);   // scrolled past
  await settle();
  s.bytes.want(['c']);
  await settle();
  assert.equal(s.downloads.find((d) => d.path.endsWith('/c')) != null, true, 'the file on screen is fetched at once');
  assert.equal(s.downloads.filter((d) => d.aborted).length, 1, 'one let-go download gave its place up');
});

test('hidden, a download no screen wants stops; one a screen shows goes on', async () => {
  const s = store({ docs: ['a', 'b'].map((id) => doc(id)) });
  s.bytes.want(['a', 'b']);
  await settle();
  s.bytes.unwant(['a']);
  await settle();
  s.bytes.hidden();
  await settle();
  assert.equal(s.downloads.find((d) => d.path.endsWith('/a')).aborted, true);
  assert.equal(s.downloads.find((d) => d.path.endsWith('/b')).aborted, false);
  s.bytes.visible();
  await settle();
});

test('two screens showing one file keep it until both close', async () => {
  const s = store({ docs: [doc('a')], keepChars: 0 });
  s.bytes.want(['a']); s.bytes.want(['a']);
  await settle();
  assert.equal(s.downloads.length, 1);
  await s.answer(0, { dataUrl: bytes(8) });
  s.bytes.unwant(['a']);
  await settle();
  assert.equal(s.doc('a').data, bytes(8), 'the other screen still shows it');
  s.bytes.unwant(['a']);
  await settle();
  assert.equal(s.doc('a').data, undefined);
});

test('another account: downloads in flight stop and nothing failed is carried over', async () => {
  const s = store({ docs: [doc('a')] });
  s.bytes.want(['a']);
  await settle();
  s.bytes.reset();
  assert.equal(s.downloads[0].aborted, true);
  assert.deepEqual(s.bytes.inFlight(), []);
});

test('what a card and a record say while the file is not here: no em dash, the reason in plain words', () => {
  assert.equal(fileWaitText('loading'), 'Fetching the file from your account.');
  assert.equal(fileWaitText('loading', { unlinked: true }), 'Fetching the file from your account. File with AI appears when it is here.');
  assert.equal(fileWaitText('failed'), 'The file could not be fetched from your account yet. Trying again.');
  assert.equal(fileWaitLine('card.pdf', 'loading'), 'card.pdf is downloading from the cloud; check back shortly');
  assert.equal(fileWaitLine('card.pdf', 'offline'), 'card.pdf: you are offline. It opens here once you are back online.');
  assert.equal(fileWaitTag('failed'), 'retrying');
  for (const text of [fileWaitText('offline'), fileWaitText('failed'), fileWaitLine('x', 'failed'), fileWaitLine('x', 'offline')]) assert.doesNotMatch(text, /—/);
  assert.notEqual(storedFileOf(doc('a')), storedFileOf(doc('a', { size: 11 })), 'a file given again under the same path is another file');
});
