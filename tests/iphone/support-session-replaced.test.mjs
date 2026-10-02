// IOS-SUPPORT-1 and IOS-SUPPORT-2 (QA lab, WebKit as the installed iPhone
// app, 2 runs each): a ticket or a reply sent as the app came back to the
// front was stored once, but Clerk had replaced window.Clerk.session with a
// new object for the same session (as it does on every focus), the sheet
// compared the objects, and it stayed on "Sending..." with the text still in
// it and the confirmation never shown. Sessions are now compared by id and
// user (utils/clerkSession.js). A real change of account still stops it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, openTicket, ID } from '../support/support-modal-harness.mjs';
import { sameClerkSession } from '../../src/utils/clerkSession.js';

const session = (id, user) => ({ id, user: { id: user } });

test('a ticket answered after Clerk replaced the session object is confirmed and the form is cleared', async () => {
  const f = fixture();
  f.window.Clerk.session = session('sess_1', 'user_A');
  f.edit('input', 'Synthetic subject');
  f.edit('textarea', 'Synthetic report sent as the app came back');
  const send = f.button('Send ticket').props.onClick();
  // The app goes to Mail and back while create-ticket answers.
  f.window.Clerk.session = session('sess_1', 'user_A');
  f.sends[0].resolve({ data: { ok: true, id: ID } });
  await send;
  const text = f.text(f.render());
  assert.match(text, /Ticket received\./);
  assert.doesNotMatch(text, /Sending\.\.\./);
  assert.equal(f.draft().read(), null);
});

test('a reply answered after Clerk replaced the session object is confirmed, and Send is free again', async () => {
  const f = fixture();
  f.window.Clerk.session = session('sess_1', 'user_A');
  await openTicket(f);
  f.edit('textarea', 'Synthetic reply sent as the app came back');
  const send = f.button('Send reply').props.onClick();
  f.window.Clerk.session = session('sess_1', 'user_A');
  f.sends[0].resolve({ data: { ok: true, id: '33333333-3333-4333-8333-333333333333' } });
  await send;
  const text = f.text(f.render());
  assert.match(text, /Reply received\./);
  assert.equal(f.nodes().find(n => n.type === 'textarea').props.value, '', 'the sent text is out of the box');
  assert.ok(f.findButton('Send reply'), 'Send reply is offered again, not "Sending..."');
});

test('must-pass: another account signed in meanwhile still stops the confirmation', async () => {
  const f = fixture();
  f.window.Clerk.session = session('sess_1', 'user_A');
  f.edit('textarea', 'Synthetic report for the first account');
  const send = f.button('Send ticket').props.onClick();
  f.window.Clerk.session = session('sess_2', 'user_B');
  f.window.Clerk.user = { id: 'user_B' };
  f.sends[0].resolve({ data: { ok: true, id: ID } });
  await send;
  assert.doesNotMatch(f.text(f.render()), /Ticket received\./);
});

test('sameClerkSession: the same object or the same id and user; never another session or account', () => {
  const a = session('sess_1', 'user_A');
  assert.equal(sameClerkSession(a, a), true);
  assert.equal(sameClerkSession(a, session('sess_1', 'user_A')), true);
  assert.equal(sameClerkSession(a, session('sess_2', 'user_A')), false);
  assert.equal(sameClerkSession(a, session('sess_1', 'user_B')), false);
  assert.equal(sameClerkSession(a, null), false);
  assert.equal(sameClerkSession({ user: { id: 'user_A' } }, { user: { id: 'user_A' } }), false, 'no id: only the same object');
});
