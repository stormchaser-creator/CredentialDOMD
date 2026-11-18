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
  const ui = await mountVera({ saved: OLD.map(m => ({ ...m })), device: { __session: {} } });
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
  const ui = await mountVera({ saved: [] });
  await settle(); ui.render();
  assert.deepEqual(plain(ui.store.archives), []);
});

test('coming back from a record Vera opened keeps the conversation', async () => {
  const device = { __session: { 'credentialdomd-vera-return': String(Date.now() + 60000) } };
  const ui = await mountVera({ saved: OLD.map(m => ({ ...m })), device, reopenedOnLoad: false });
  await settle(); ui.render();
  assert.equal(onScreen(ui, 'Synthetic old answer'), true, 'kept on screen');
  assert.deepEqual(plain(ui.store.archives), [], 'nothing filed');
  assert.equal('credentialdomd-vera-return' in device.__session, false, 'the mark is used once');
});

test('iOS reloading the app into Vera mid-task keeps the chat; opening Vera later from the menu does not', async () => {
  const recent = { __session: { 'credentialdomd-vera-active': String(Date.now() - 60000) } };
  const reloaded = await mountVera({ saved: OLD.map(m => ({ ...m })), device: recent, reopenedOnLoad: true });
  await settle(); reloaded.render();
  assert.equal(onScreen(reloaded, 'Synthetic old answer'), true, 'reload within minutes keeps it');

  const navigated = await mountVera({ saved: OLD.map(m => ({ ...m })), device: { __session: { 'credentialdomd-vera-active': String(Date.now() - 60000) } }, reopenedOnLoad: false });
  await settle(); navigated.render();
  assert.equal(onScreen(navigated, 'Synthetic old answer'), false, 'opened from the menu: new chat');

  const stale = await mountVera({ saved: OLD.map(m => ({ ...m })), device: { __session: { 'credentialdomd-vera-active': String(Date.now() - 11 * 60000) } }, reopenedOnLoad: true });
  await settle(); stale.render();
  assert.equal(onScreen(stale, 'Synthetic old answer'), false, 'app launched later into Vera: new chat');
});
