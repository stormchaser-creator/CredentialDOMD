// Vera opens on a new chat; the previous conversation is filed under
// Archived, never lost and never sent as history. Coming back from a record
// Vera opened keeps the conversation. Mounted with the Vera harness;
// every message here is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';

const OLD = [
  { id: 'm1', role: 'user', text: 'Synthetic old question' },
  { id: 'm2', role: 'assistant', text: 'Synthetic old answer' },
];
const plain = v => JSON.parse(JSON.stringify(v));
const onScreen = (ui, text) => ui.nodes().some(n => typeof n.props?.children === 'string' && n.props.children.includes(text)) || JSON.stringify(ui.nodes().map(n => ui.text(n))).includes(text);

test('opening Vera starts a new chat and files the last one under Archived', async () => {
  const ui = await mountVera({ saved: OLD.map(m => ({ ...m })), visitKind: 'open' });
  await settle(); ui.render(); await settle(); ui.render();
  assert.equal(onScreen(ui, 'Synthetic old answer'), false, 'the old conversation is not on screen');
  assert.ok(Array.isArray(ui.store.archives) && ui.store.archives.length === 1, 'filed once under Archived');
  assert.equal(ui.store.archives[0].title, 'Synthetic old question');
  assert.deepEqual(plain(ui.store.archives[0].msgs.map(m => m.id)), ['m1', 'm2']);
  assert.deepEqual(plain(ui.store.chat), [], 'the stored chat is the new, empty one');
  await ui.ask('Whats my EIN');
  const history = ui.turns.at(-1).history.map(h => h.text);
  assert.ok(!history.some(t => /Synthetic old/.test(t || '')), 'the old chat is never sent as history');
});

test('an empty chat files nothing', async () => {
  const ui = await mountVera({ saved: [], visitKind: 'open' });
  await settle(); ui.render();
  assert.deepEqual(plain(ui.store.archives), []);
});

test('a kept visit (back from her record, or the app reopening on her) keeps the conversation', async () => {
  for (const visitKind of ['return', 'reload']) {
    const ui = await mountVera({ saved: OLD.map(m => ({ ...m })), visitKind });
    await settle(); ui.render();
    assert.equal(onScreen(ui, 'Synthetic old answer'), true, visitKind);
    assert.deepEqual(plain(ui.store.archives), [], visitKind);
  }
});

test('a question handed to Vera on a kept visit still starts a new chat and never carries the old one', async () => {
  const ui = await mountVera({ saved: OLD.map(m => ({ ...m })), visitKind: 'return', props: { initialQuestion: 'Synthetic handed-in question' } });
  await settle(); ui.render(); await settle(); ui.render();
  assert.ok(ui.turns.length >= 1, 'the handed-in question was sent');
  const history = ui.turns[0].history.map(h => h.text || '');
  assert.ok(!history.some(t => /Synthetic old/.test(t)), 'no old history');
  assert.equal(ui.store.archives.length, 1, 'the old chat is filed');
});

test('a fresh open whose store is read late files the old chat once and never files the chat in use', async () => {
  // Stands in for IndexedDB that answers after Vera opened: the first read
  // is empty, the late merge brings the old conversation.
  let merged = null;
  const late = { chat: [], archives: [] };
  const ui = await mountVera({ saved: [], visitKind: 'open', modules: {
    storageScope: {
      BASE_KEYS: { chat: 'chat', archives: 'archives', veraProfessionLater: 'veraProfessionLater' },
      largeGetJSON: k => late[k], largeSetJSON: (k, v) => { late[k] = v; },
      lsGet: () => null, lsSet: () => true,
      onLargeStoreMerged: fn => { merged = fn; return () => {}; },
      mergeLargeList: (_b, stored, current) => [...stored, ...current.filter(c => !stored.some(s => s.id === c.id))],
      rereadLargeStore: () => undefined,
    },
  } });
  await settle(); ui.render();
  await ui.ask('Synthetic new question');
  const onScreenIds = () => plain(late.chat).map(m => m.id);
  const mine = onScreenIds();
  assert.ok(mine.length >= 1, 'the new conversation is stored');
  // The late merge: the old conversation plus what this session wrote.
  late.chat = [...OLD.map(m => ({ ...m })), ...plain(late.chat)];
  merged('chat'); await settle(); ui.render();
  assert.equal(late.archives.length, 1, 'old chat filed once');
  assert.deepEqual(plain(late.archives[0].msgs.map(m => m.id)), ['m1', 'm2']);
  assert.deepEqual(onScreenIds(), mine, 'the chat key holds the chat in use, not the old one');
  merged('chat'); await settle(); ui.render();
  assert.equal(late.archives.length, 1, 'a second merge files nothing more');
});
