// Continuing an archived chat while Vera is answering (VERA-010). New chat
// was disabled while busy, but Continue this chat was not: restoreArchive
// archived the chat holding the unanswered question and brought the old one
// back, and Vera's reply, with any action cards, was appended to the old
// conversation it does not belong to. Synthetic text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';

test('Continue this chat waits while Vera is answering, and her reply stays with its question', async () => {
  let n = 0, answer;
  const supabase = { from: () => ({ insert: () => ({ then: (a) => a({}) }) }) };
  const v = await mountVera({
    modules: { supabase: { supabase } },
    turn: () => {
      n += 1;
      if (n === 1) return Promise.resolve({ reply: 'Older answer.', actions: [] });
      return new Promise(r => { answer = () => r({ reply: 'Answer to the new question.', actions: [] }); });
    },
  });
  await v.ask('an older question');
  v.buttons().find(b => v.text(b) === 'New chat').props.onClick();
  v.render();
  assert.equal(v.store.archives.length, 1);

  v.nodes().find(n2 => n2.type === 'textarea').props.onChange({ target: { value: 'what expires next month?' } });
  v.render();
  const sending = v.button('Send').props.onClick();
  await settle();
  v.render();
  const continues = v.buttons().filter(b => v.text(b) === 'Continue this chat');
  assert.ok(continues.length >= 1);
  for (const b of continues) assert.equal(b.props.disabled, true, 'Continue this chat is disabled while Vera answers');
  continues[0].props.onClick(); // a tap that gets through anyway changes nothing
  v.render();

  answer();
  await sending;
  await settle();
  v.render();
  const chat = Array.from(v.store.chat, m => m.text);
  assert.deepEqual(chat, ['what expires next month?', 'Answer to the new question.'], 'the reply is in the conversation that asked');
  assert.equal(v.store.archives.length, 1);
  assert.deepEqual(Array.from(v.store.archives[0].msgs, m => m.text), ['an older question', 'Older answer.'], 'the archived chat is untouched');
});
