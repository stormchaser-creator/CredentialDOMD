// Vera's packet card after a download goes wrong (VERA-003 follow-up).
// - A cloud file whose download failed once (no Clerk token yet, a network
//   blip) was cached as failed for as long as Vera stayed open: Approve read
//   the same failure, and the packet went out short or not at all.
// - Every open packet card in the saved transcript downloaded all its files
//   on each visit to Vera, with no timeout and no abort when Vera was left.
// - A file kept out because it is linked to Protected Identity was called
//   "Not on this device".
// Synthetic files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as inboxDocs from '../src/utils/inboxDocs.js';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';
import { mergeLargeList } from '../src/utils/storageScope.js';

const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF synthetic a').toString('base64');
const blob = (t = '%PDF synthetic') => ({ blob: new Blob([t], { type: 'application/pdf' }) });
const DOCS = [
  { id: 'doc-a', name: 'a-license.pdf', type: 'application/pdf', data: PDF, linkedTo: 'licenses:l-1' },
  { id: 'doc-b', name: 'b-diploma.pdf', type: 'application/pdf', storagePath: 'u/doc-b.pdf', linkedTo: 'education:e-1' },
  { id: 'doc-c', name: 'c-dea.pdf', type: 'application/pdf', storagePath: 'u/doc-c.pdf', linkedTo: 'licenses:l-2' },
  { id: 'doc-p', name: 'p-passport.pdf', type: 'application/pdf', data: PDF, linkedTo: 'identityVault:iv-1' },
];
const packet = (docIds) => ({ kind: 'send_packet', docIds, coverNote: 'Enclosed: the documents.', summary: 'To the agency' });

async function mount(download, { docIds = ['doc-a', 'doc-b', 'doc-c'], saved, listeners = {}, globals = {} } = {}) {
  const shared = [], calls = [];
  const supabase = { from: () => ({ insert: () => ({ then: (a) => a({}) }) }) };
  const v = await mountVera({
    data: { documents: DOCS },
    saved,
    modules: { inboxDocs, supabase: { supabase, downloadDocumentBlob: (path, opts) => { calls.push({ path, opts }); return download(path, opts, calls); } } },
    turn: async () => ({ reply: 'Here is the packet.', actions: [packet(docIds)] }),
    globals: {
      window: {
        navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true, innerHeight: 800,
        addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: (type) => { delete listeners[type]; },
      },
      navigator: { userAgent: 'Synthetic', clipboard: { writeText: async () => {} }, canShare: () => true, share: async ({ files }) => { shared.push(...files); } },
      ...globals,
    },
  });
  if (!saved) {
    await v.ask('send my packet to the agency');
    await settle();
    v.render();
  }
  return { v, shared, calls, listeners };
}
const approve = async (v, label = 'Approve') => {
  const b = v.button(label);
  assert.ok(b, `a "${label}" button (have: ${v.buttons().map(x => v.text(x).trim()).join(' | ')})`);
  await b.props.onClick();
  // The harness renders only when asked: once for the tap, once for the
  // downloads the tap started.
  await settle();
  v.render();
  await settle();
  v.render();
};

test('a download that failed once is tried again on Approve, and the packet then carries every file', async () => {
  const { v, shared, calls } = await mount(async (path, _o, calls) => (
    path === 'u/doc-c.pdf' && calls.filter(c => c.path === path).length === 1 ? { failed: true } : blob(path)));
  assert.match(v.pageText(), /Could not download right now: c-dea\.pdf\. Tap Approve to try again\./);
  assert.doesNotMatch(v.pageText(), /Not on this device/, 'a passing failure is not "not on this device"');
  assert.equal(v.button('Share 2 of 3'), undefined, 'not offered short while a retry can still bring the file');
  await v.button('Approve').props.onClick();
  await settle();
  v.render();
  assert.equal(shared.length, 0, 'the retry runs before anything is shared');
  assert.match(v.pageText(), /Downloading 1 of 3 files again\. Approve again in a moment\./);
  await settle();
  v.render();
  assert.doesNotMatch(v.pageText(), /Downloading 1 of 3 files again/, 'not left on the card once the file is in');
  assert.equal(calls.filter(c => c.path === 'u/doc-c.pdf').length, 2, 'asked for again');
  assert.equal(calls[0].opts.detail, true, 'a missing file and a failed download are told apart');
  assert.ok(calls[0].opts.signal, 'every download can be stopped');
  await approve(v);
  assert.deepEqual(shared.map(f => f.name), ['a-license.pdf', 'b-diploma.pdf', 'c-dea.pdf']);
});

test('a file that still fails after the retry is named, and Share 2 of 3 then sends the rest', async () => {
  const { v, shared } = await mount(async (path) => (path === 'u/doc-c.pdf' ? { failed: true } : blob(path)));
  await approve(v);
  assert.match(v.pageText(), /Still could not download, so not shared: c-dea\.pdf\./);
  await approve(v, 'Share 2 of 3');
  assert.deepEqual(shared.map(f => f.name), ['a-license.pdf', 'b-diploma.pdf']);
  assert.match(v.pageText(), /Sent 2 of 3\. Not sent: c-dea\.pdf\./);
});

test('when nothing downloaded, every Approve tries again rather than sending the member to Files', async () => {
  let up = false;
  const { v, shared, calls } = await mount(async (path) => (up ? blob(path) : { failed: true }), { docIds: ['doc-b', 'doc-c'] });
  await approve(v);
  await approve(v);
  assert.equal(calls.length, 6, 'each Approve asked for both files again');
  assert.match(v.pageText(), /Still could not download, so not shared: b-diploma\.pdf, c-dea\.pdf/);
  assert.doesNotMatch(v.pageText(), /Open Files/);
  up = true;
  await approve(v);
  await approve(v);
  assert.deepEqual(shared.map(f => f.name), ['b-diploma.pdf', 'c-dea.pdf']);
});

test('coming back online fetches the failed files again', async () => {
  let up = false;
  const { v, shared, listeners } = await mount(async (path) => (up ? blob(path) : { failed: true }));
  assert.match(v.pageText(), /Could not download right now: b-diploma\.pdf, c-dea\.pdf/);
  up = true;
  assert.equal(typeof listeners.online, 'function', 'Vera listens for the phone coming back online');
  listeners.online();
  v.render();
  await settle();
  v.render();
  assert.doesNotMatch(v.pageText(), /Could not download/);
  await approve(v);
  assert.equal(shared.length, 3);
});

test('a download that stalls ends as a failure that can be retried, and leaving Vera stops it', async () => {
  const signals = [];
  const { v } = await mount((path, opts) => { signals.push(opts.signal); return new Promise(() => {}); });
  assert.match(v.pageText(), /Getting 2 files ready/);
  for (const t of v.timers.splice(0)) t();
  await settle();
  v.render();
  assert.match(v.pageText(), /Could not download right now: b-diploma\.pdf, c-dea\.pdf/, 'not "Getting files ready" for good');
  assert.ok(signals.every(s => s.aborted));

  const left = await mount((path, opts) => { signals.push(opts.signal); return new Promise(() => {}); });
  const before = signals.length;
  left.v.unmount();
  assert.ok(signals.slice(before - 2).every(s => s.aborted), 'leaving Vera aborts the downloads still running');
});

test('only the newest open packet card downloads on a visit; an older one downloads when Approve is tapped', async () => {
  const saved = [
    { id: 'm-1', role: 'user', text: 'old packet' },
    { id: 'm-2', role: 'assistant', text: 'Here.', actions: [packet(['doc-b'])] },
    { id: 'm-3', role: 'user', text: 'new packet' },
    { id: 'm-4', role: 'assistant', text: 'Here.', actions: [packet(['doc-c'])] },
  ];
  const { v, calls, shared } = await mount(async (path) => blob(path), { saved });
  await settle();
  v.render();
  assert.deepEqual(calls.map(c => c.path), ['u/doc-c.pdf'], 'the older card stays put');
  assert.match(v.pageText(), /1 file will download when you tap Approve\./);
  const older = v.buttons().filter(b => v.text(b).trim() === 'Approve')[0];
  await older.props.onClick();
  await settle();
  v.render();
  assert.match(v.pageText(), /Getting 1 of 1 files ready\. Approve again in a moment\./);
  assert.deepEqual(calls.map(c => c.path), ['u/doc-c.pdf', 'u/doc-b.pdf']);
  assert.equal(shared.length, 0);
  await settle();
  v.render();
  await v.buttons().filter(b => v.text(b).trim() === 'Approve')[0].props.onClick();
  await settle();
  assert.deepEqual(shared.map(f => f.name), ['b-diploma.pdf']);
});

test('a file linked to Protected Identity is said to be kept out on purpose, not missing', async () => {
  const { v, shared } = await mount(async (path) => blob(path), { docIds: ['doc-a', 'doc-p'] });
  const page = v.pageText();
  assert.match(page, /Kept out on purpose because it is linked to Protected Identity: p-passport\.pdf\./);
  assert.doesNotMatch(page, /Not on this device/);
  await approve(v, 'Share 1 of 2');
  assert.deepEqual(shared.map(f => f.name), ['a-license.pdf']);
  assert.match(v.pageText(), /Sent 1 of 2\. Kept out on purpose \(Protected Identity\): p-passport\.pdf\./);
  assert.doesNotMatch(v.pageText(), /Not sent/);
});

test('a packet of Protected Identity files only says why, and never points at Files', async () => {
  const { v, shared } = await mount(async (path) => blob(path), { docIds: ['doc-p'] });
  await approve(v);
  assert.equal(shared.length, 0);
  assert.match(v.pageText(), /Those documents are linked to Protected Identity, so they are never shared from this app\./);
  assert.doesNotMatch(v.pageText(), /downloaded on this device|Open Files/);
  // Protected Identity has no file or share control, so the card never
  // sends the member there to share them.
  assert.doesNotMatch(v.pageText(), /Send them yourself|from Protected Identity\./);
});

// ── Review follow-ups ──

/** A clock the test moves: timers fire when their time comes, and a cleared one never does. */
function clock() {
  let now = 0;
  const live = [];
  return {
    setTimeout: (fn, ms = 0) => { const t = { fn, at: now + ms }; live.push(t); return t; },
    clearTimeout: (t) => { const i = live.indexOf(t); if (i >= 0) live.splice(i, 1); },
    advance(ms) {
      now += ms;
      for (const t of live.filter(x => x.at <= now).sort((a, b) => a.at - b.at)) { live.splice(live.indexOf(t), 1); t.fn(); }
    },
  };
}
const OLD_AND_NEW = [
  { id: 'm-1', role: 'user', text: 'old packet' },
  { id: 'm-2', role: 'assistant', text: 'Here.', actions: [packet(['doc-b'])] },
  { id: 'm-3', role: 'user', text: 'new packet' },
  { id: 'm-4', role: 'assistant', text: 'Here.', actions: [packet(['doc-c'])] },
];
const tick = async (v) => { await settle(); v.render(); await settle(); v.render(); };

test('a large file still arriving after 45 seconds is left to finish, and the packet carries it', async () => {
  // A 9 MB scan on a slow link: bytes keep coming, the whole transfer takes 90 s.
  const time = clock();
  let progress, finish, signal;
  const { v, shared } = await mount((path, opts) => {
    if (path !== 'u/doc-c.pdf') return blob(path);
    progress = opts.onProgress; signal = opts.signal;
    return new Promise((resolve) => { finish = () => resolve(blob('%PDF synthetic large scan')); });
  }, { globals: { setTimeout: time.setTimeout, clearTimeout: time.clearTimeout } });
  assert.equal(typeof progress, 'function', 'the download reports its bytes arriving');
  for (let s = 1; s <= 9; s++) { time.advance(10000); progress(s * 1024 * 1024); }
  assert.equal(signal.aborted, false, 'not cut off at 45 s while bytes are arriving');
  finish();
  await tick(v);
  assert.doesNotMatch(v.pageText(), /Could not download|Still could not download/);
  await approve(v);
  assert.deepEqual(shared.map(f => f.name), ['a-license.pdf', 'b-diploma.pdf', 'c-dea.pdf']);
});

test('a download that stops receiving bytes still ends 45 seconds after the last chunk', async () => {
  const time = clock();
  let progress, signal;
  const { v } = await mount((path, opts) => {
    if (path !== 'u/doc-c.pdf') return blob(path);
    progress = opts.onProgress; signal = opts.signal;
    return new Promise(() => {});
  }, { globals: { setTimeout: time.setTimeout, clearTimeout: time.clearTimeout } });
  time.advance(30000);
  progress(512 * 1024);
  time.advance(44000);
  assert.equal(signal.aborted, false, 'still inside the stall window');
  time.advance(1000);
  assert.equal(signal.aborted, true, 'stalled for 45 s');
  await tick(v);
  assert.match(v.pageText(), /Could not download right now: c-dea\.pdf/);
});

test('sharing the newest packet card does not start the older card downloading', async () => {
  const { v, calls, shared } = await mount(async (path) => blob(path), { saved: OLD_AND_NEW });
  await tick(v);
  assert.deepEqual(calls.map(c => c.path), ['u/doc-c.pdf']);
  const approves = v.buttons().filter(b => v.text(b).trim() === 'Approve');
  await approves[approves.length - 1].props.onClick();
  await tick(v);
  assert.deepEqual(shared.map(f => f.name), ['c-dea.pdf']);
  assert.deepEqual(calls.map(c => c.path), ['u/doc-c.pdf'], 'the older card waits for its own Approve');
  assert.match(v.pageText(), /1 file will download when you tap Approve\./);
});

test('dismissing the newest packet card does not start the older card downloading, and a new reply\'s card still does', async () => {
  const { v, calls } = await mount(async (path) => blob(path), { saved: OLD_AND_NEW, docIds: ['doc-b'] });
  await tick(v);
  const dismiss = v.buttons().filter(b => v.text(b).trim() === 'Dismiss');
  assert.equal(dismiss.length, 2, v.buttons().map(b => v.text(b).trim()).join(' | '));
  dismiss[1].props.onClick();
  await tick(v);
  assert.deepEqual(calls.map(c => c.path), ['u/doc-c.pdf']);
  await v.ask('send my diploma');
  await tick(v);
  assert.deepEqual(calls.map(c => c.path), ['u/doc-c.pdf', 'u/doc-b.pdf'], 'the card a new reply brings is the newest');
});

test('"Getting files ready" is not left on the card once the files arrive, and is never saved with it', async () => {
  const { v } = await mount(async (path) => blob(path), { saved: OLD_AND_NEW });
  const { store } = v;
  await tick(v);
  const older = v.buttons().filter(b => v.text(b).trim() === 'Approve')[0];
  await older.props.onClick();
  await settle();
  v.render();
  assert.match(v.pageText(), /Getting 1 of 1 files ready\. Approve again in a moment\./, 'said while the file is on its way');
  await tick(v);
  assert.doesNotMatch(v.pageText(), /Getting 1 of 1 files ready/, 'gone once the file is ready');
  const savedCard = store.chat.find(m => m.id === 'm-2').actions[0];
  assert.equal(savedCard.error, undefined, 'the transcript keeps no progress notice as an error');

  // Reopened before the next tap: no red notice next to "will download when you tap Approve".
  const again = await mount(async (path) => blob(path), { saved: store.chat });
  await tick(again.v);
  assert.match(again.v.pageText(), /1 file will download when you tap Approve\./);
  assert.doesNotMatch(again.v.pageText(), /Getting 1 of 1 files ready/);
});

test('"Downloading again" is not left next to "Still could not download" after the retry fails', async () => {
  const { v } = await mount(async (path) => (path === 'u/doc-c.pdf' ? { failed: true } : blob(path)));
  const b = v.button('Approve');
  await b.props.onClick();
  await settle();
  v.render();
  assert.match(v.pageText(), /Downloading 1 of 3 files again\. Approve again in a moment\./);
  await tick(v);
  assert.match(v.pageText(), /Still could not download, so not shared: c-dea\.pdf\./);
  assert.doesNotMatch(v.pageText(), /Downloading 1 of 3 files again/);
  assert.ok(v.button('Share 2 of 3'));
});

test('a card that can share nothing never says the cover note still names them all', async () => {
  const pi = await mount(async (path) => blob(path), { docIds: ['doc-p'] });
  assert.doesNotMatch(pi.v.pageText(), /The cover note still names/);
  assert.match(pi.v.pageText(), /So nothing on this card can be shared from here\./);

  const gone = await mount(async () => ({ missing: true }), { docIds: ['doc-b', 'doc-c'] });
  assert.match(gone.v.pageText(), /Not on this device, so not shared: b-diploma\.pdf, c-dea\.pdf\./);
  assert.doesNotMatch(gone.v.pageText(), /The cover note still names/);

  const failing = await mount(async () => ({ failed: true }), { docIds: ['doc-b', 'doc-c'] });
  await approve(failing.v);
  assert.match(failing.v.pageText(), /Still could not download, so not shared: b-diploma\.pdf, c-dea\.pdf/);
  assert.doesNotMatch(failing.v.pageText(), /The cover note still names|nothing on this card/, 'Approve tries these again');

  const some = await mount(async (path) => blob(path), { docIds: ['doc-a', 'doc-p'] });
  assert.match(some.v.pageText(), /The cover note still names all 2\./, 'still said when part of the packet goes');
});

test('the stored transcript merged in after a failed read does not pin its older open card over the reply\'s card', async () => {
  // Vera opened while the stored transcript could not be read, so the screen
  // holds this session only. The reply brings a packet card; then the stored
  // transcript is read and merged above it (storageScope.js
  // hydrateOfflineStores, mergeLargeList), carrying an older open card.
  let merged = null;
  const store = { chat: [], archives: [] };
  const storageScope = {
    BASE_KEYS: { chat: 'chat', archives: 'archives' }, largeGetJSON: k => store[k], largeSetJSON: (k, val) => { store[k] = val; },
    mergeLargeList, onLargeStoreMerged: (fn) => { merged = fn; return () => {}; },
  };
  const calls = [];
  let replies = 0;
  const supabase = { from: () => ({ insert: () => ({ then: (a) => a({}) }) }) };
  const v = await mountVera({
    data: { documents: [...DOCS, { id: 'doc-d', name: 'd-board.pdf', type: 'application/pdf', storagePath: 'u/doc-d.pdf', linkedTo: 'licenses:l-3' }] },
    modules: { inboxDocs, storageScope, supabase: { supabase, downloadDocumentBlob: (path) => { calls.push(path); return new Promise(() => {}); } } },
    turn: async () => ({ reply: 'Here is the packet.', actions: [packet([replies++ ? 'doc-d' : 'doc-c'])] }),
  });
  await tick(v);
  await v.ask('send my DEA certificate');
  await tick(v);
  assert.deepEqual(calls, ['u/doc-c.pdf'], 'the reply\'s card downloads');
  store.chat = [
    { id: 'old-1', role: 'user', text: 'old packet' },
    { id: 'old-2', role: 'assistant', text: 'Here.', actions: [packet(['doc-b'])] },
  ];
  assert.ok(merged, 'Vera listens for the merge');
  merged('chat');
  await tick(v);
  assert.match(v.pageText(), /old packet/, 'the stored transcript is merged in');
  assert.deepEqual(calls, ['u/doc-c.pdf'], 'the older stored card waits for its own Approve');
  assert.match(v.pageText(), /1 file will download when you tap Approve\./);
  await v.ask('and my board certificate');
  await tick(v);
  assert.deepEqual(calls, ['u/doc-c.pdf', 'u/doc-d.pdf'], 'a later reply\'s card still takes the pin');
});
