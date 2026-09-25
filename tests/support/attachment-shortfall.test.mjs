// Ticket 5f9b744d: create-ticket used to answer ok:true when a file failed to
// upload, and the sheet said "Ticket received." A physician who attached two
// files could not know one was gone. The function now counts what it stored,
// and the real SupportModal says how many to add again as a reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ID, fixture } from './support-modal-harness.mjs';

const attachTwo = f => {
  f.nodes().find(n => n.type === 'screenshot').props.onChange([
    { data: 'data:image/png;base64,AAAA', name: 'one.png' },
    { data: 'data:application/pdf;base64,JVBERg==', name: 'two.pdf' },
  ]);
  f.render();
};

test('a ticket saved without one of its files says so instead of the plain confirmation, and stays open', async () => {
  const f = fixture();
  f.edit('textarea', 'Synthetic report with two files attached');
  attachTwo(f);
  const send = f.button('Send ticket').props.onClick();
  assert.equal(f.sends[0].args.body.attachments.length, 2, 'both files go out');
  f.sends[0].resolve({ data: { ok: true, id: ID, attachments_stored: 1, attachments_failed: 1 } });
  await send;
  const shown = f.text(f.render());
  assert.match(shown, /Your ticket was sent, but 1 file did not attach\. Add it as a reply\./);
  assert.doesNotMatch(shown, /Ticket received\./, 'the plain confirmation is replaced');
  assert.equal(f.timers.length, 0, 'the sheet does not close itself before it can be read');
  assert.ok(f.findButton('Open Your tickets'));

  // The sent ticket is not left in the form to be sent twice.
  f.button('Open Your tickets').props.onClick();
  f.render();
  assert.ok(f.findButton('New ticket'), 'back on the tabs');
  f.button('New ticket').props.onClick();
  const form = f.nodes();
  assert.equal(form.find(n => n.type === 'textarea').props.value, '');
  assert.equal(form.find(n => n.type === 'screenshot').props.value.length, 0);
});

test('a ticket whose files all landed keeps the plain confirmation and closes itself', async () => {
  const f = fixture();
  f.edit('textarea', 'Synthetic report with two files attached');
  attachTwo(f);
  const send = f.button('Send ticket').props.onClick();
  f.sends[0].resolve({ data: { ok: true, id: ID, attachments_stored: 2, attachments_failed: 0 } });
  await send;
  assert.match(f.text(f.render()), /Ticket received\./);
  assert.equal(f.timers.length, 1);
});

test('a function that does not report counts yet keeps the old behaviour', async () => {
  const f = fixture();
  f.edit('textarea', 'Synthetic report with no count in the reply');
  const send = f.button('Send ticket').props.onClick();
  f.sends[0].resolve({ data: { ok: true, id: ID } });
  await send;
  assert.match(f.text(f.render()), /Ticket received\./);
});

test('the physician form says a file can be attached, not only a screenshot', () => {
  const f = fixture();
  assert.match(f.text(f.render()), /Screenshot or file \(optional\)/);
});
