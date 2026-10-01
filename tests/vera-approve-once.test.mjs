// Approving a Vera feedback card files one ticket (VERA-008). runAction
// marked nothing in flight, so a second tap while create-ticket was still
// answering ran the whole action again, and the card sent no
// client_request_id, so "Approve again to retry" after a lost reply filed a
// second ticket too. Synthetic text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const feedbackTurn = async () => ({
  reply: 'I can pass that to the developer.',
  actions: [{ kind: 'feedback', category: 'bug', summary: 'Export shows the wrong year', text: 'The export shows the wrong year on every row.' }],
});

async function mount(invoke) {
  const calls = [];
  const supabase = {
    functions: { invoke: async (name, opts) => { calls.push([name, opts.body]); return invoke(calls.length); } },
    from: () => ({ insert: () => ({ then: (a) => a({}) }) }),
  };
  const v = await mountVera({ turn: feedbackTurn, modules: { supabase: { supabase } }, globals: { crypto: globalThis.crypto } });
  await v.ask('this is a bug: export shows the wrong year');
  return { v, calls: () => calls.filter(c => c[0] === 'create-ticket'), card: () => v.store.chat.at(-1).actions[0] };
}

test('a second tap while the first is still sending files nothing more', async () => {
  let release;
  const { v, calls, card } = await mount(() => new Promise(r => { release = () => r({ data: { ok: true, id: 't-1' } }); }));
  const approve = v.button('Approve');
  const first = approve.props.onClick();
  await settle();
  v.render();
  const second = v.buttons().find(b => /Approve|Working/.test(v.text(b)));
  assert.equal(second.props.disabled, true, 'Approve is disabled while the ticket is sending');
  await approve.props.onClick(); // the same tap handler again, as a quick double tap delivers it
  await second.props.onClick();
  release();
  await first;
  await settle();
  v.render();
  assert.equal(calls().length, 1, 'one create-ticket call');
  assert.equal(card().done, true);
});

test('Approve again after a lost reply sends the same request key', async () => {
  const { v, calls, card } = await mount(n => (n === 1
    ? { error: { message: 'Failed to send a request to the Edge Function' } }
    : { data: { ok: true, id: 't-1', duplicate: true } }));
  await v.button('Approve').props.onClick();
  await settle();
  v.render();
  assert.notEqual(card().done, true);
  await v.button('Approve').props.onClick();
  await settle();
  v.render();
  const [a, b] = calls().map(c => c[1].client_request_id);
  assert.match(String(a), UUID, 'the first send carries a request key');
  assert.equal(b, a, 'the retry carries the same key, so create-ticket answers with the first ticket');
  assert.equal(card().done, true);
});
