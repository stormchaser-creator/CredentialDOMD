// A feedback card says done only when the ticket exists (VERA-008). The
// create-ticket call was fired and forgotten, so offline, with an expired
// session, or with a summary under three characters (a 400), the card still
// showed "done" and no ticket was ever filed. Synthetic text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';

const feedbackTurn = (summary = 'The CME export skips my ACLS entry') => async () => ({
  reply: 'I can pass that to the developer.',
  actions: [{ kind: 'feedback', category: 'bug', summary, text: 'The CME export skips my ACLS entry when I pick last year.' }],
});

async function approveWith(invoke, summary) {
  const calls = [];
  const supabase = {
    functions: { invoke: async (name, opts) => { calls.push([name, opts.body]); return invoke(); } },
    from: () => ({ insert: () => ({ then: (a) => a({}) }) }),
  };
  const v = await mountVera({ turn: feedbackTurn(summary), modules: { supabase: { supabase } } });
  await v.ask('the export is broken');
  await v.button('Approve').props.onClick();
  await settle();
  v.render();
  return { v, calls, card: () => v.store.chat.at(-1).actions[0] };
}

test('a refused ticket leaves the card with its error and Approve available', async () => {
  const { v, card } = await approveWith(async () => ({ error: { message: 'Edge Function returned a non-2xx status code', context: { json: async () => ({ error: 'Not signed in' }) } } }));
  assert.notEqual(card().done, true, 'not marked done');
  assert.match(String(card().error || ''), /Could not send this to the developer \(Not signed in\)\. Approve again to retry\./);
  assert.ok(v.button('Approve'), 'Approve is still there');
});

test('a ticket that comes back with an id marks the card done', async () => {
  const { card } = await approveWith(async () => ({ data: { ok: true, id: 't-1' } }));
  assert.equal(card().done, true);
  assert.equal(card().ticketId, 't-1');
});

test('a summary too short for a subject is sent with a real one', async () => {
  const { calls } = await approveWith(async () => ({ data: { ok: true, id: 't-2' } }), 'ok');
  const body = calls.find(c => c[0] === 'create-ticket')[1];
  assert.ok(body.subject.length >= 3, body.subject);
  assert.ok(!body.body.includes('\u2014'), 'no em dash in what the owner and the member read');
});
