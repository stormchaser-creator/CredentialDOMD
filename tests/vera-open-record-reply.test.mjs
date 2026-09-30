// Vera keeps her reply when she opens a record (VERA-005). open_record
// navigated before the reply was put in the chat. Navigating leaves Vera, so
// the screen unmounted with the reply unsaved: back in Vera the question
// showed "Not sent" with Try again (which asks the model again) and no
// "Opened Licenses" card. The navigation now waits until the reply is saved.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVera } from './assistant-harness.mjs';

const LICENSE = { id: 'lic-1', type: 'State Medical License', state: 'CO', number: 'QA-0001' };
const LICENSES = { key: 'licenses', label: 'Licenses', tab: 'credentials', sub: 'licenses' };
// The exchange log is a cloud insert that never answers here.
const supabase = { supabase: { from: () => ({ insert: () => new Promise(() => {}) }) } };
const HomeSearch = {
  findSection: key => (key === 'licenses' ? LICENSES : null),
  searchRecords: () => [{ sec: LICENSES, hits: [LICENSE] }],
};

// What is on the device at the moment Vera navigates away: all that survives
// the screen unmounting.
async function askToOpen() {
  const navs = [];
  let v;
  v = await mountVera({
    data: { licenses: [LICENSE] },
    modules: { HomeSearch, supabase },
    // JSON: the component runs in its own realm, and this is what the device keeps.
    app: { navigate: (...args) => navs.push({ args: JSON.parse(JSON.stringify(args)), saved: JSON.parse(JSON.stringify(v.store.chat)) }) },
    // The question is on screen (and saved) while the model answers.
    turn: async () => { v.render(); return { reply: 'Here is your Colorado license.', actions: [{ kind: 'open_record', section: 'licenses', id: 'lic-1', summary: 'Open the Colorado license' }] }; },
  });
  await v.ask('open my Colorado license');
  return navs;
}

test('the reply and the done Navigation card are saved before Vera navigates to the record', async () => {
  const navs = await askToOpen();
  assert.equal(navs.length, 1, 'navigates once');
  assert.deepEqual(navs[0].args, ['credentials', 'licenses', { sec: 'licenses', id: 'lic-1' }]);
  const saved = navs[0].saved;
  const last = saved.at(-1);
  assert.equal(last.role, 'model', 'the reply is saved under the question');
  assert.equal(last.text, 'Here is your Colorado license.');
  assert.deepEqual(last.actions.map(a => [a.kind, a.done, a.summary]), [['open_record', true, 'Opened Licenses']]);
  assert.equal(saved.at(-2).role, 'user');
  assert.ok(!saved.some(m => m.failed), 'no message is marked failed');
});

test('back in Vera, the question has its reply and card, not "Not sent"', async () => {
  const [{ saved }] = await askToOpen();
  const back = await mountVera({ saved, modules: { HomeSearch, supabase } });
  const page = back.pageText();
  assert.match(page, /open my Colorado license/);
  assert.match(page, /Here is your Colorado license\./);
  assert.match(page, /Navigation ✓ done/);
  assert.match(page, /Opened Licenses/);
  assert.doesNotMatch(page, /Not sent/);
  assert.equal(back.button('Try again'), undefined);
});
