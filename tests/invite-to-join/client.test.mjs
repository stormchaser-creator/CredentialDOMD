// The browser transport for invite-to-join: it pins the signed-in
// administrator, sends exactly the reviewed preview, and resolves a send only
// when the server confirmed the provider accepted it. Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInviteToJoinClient } from '../../src/utils/inviteToJoinClient.js';

const actor = 'user_syntheticAdmin';
const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-09-29T15:00:00.000Z';
const EMAIL = { from: '"Synthetic Owner, DO" <whit@credentialdomd.com>', to: 'a@example.com', replyTo: 'owner@example.invalid',
  subject: 'Synthetic Owner, DO invited you to join CredentialDOMD', text: 'Hello,\n\nSynthetic text.' };
const PREVIEW = { schemaVersion: 1, email: EMAIL, offer: { phase: 'founding', annualCents: 9900, availability: 'available' },
  history: { lastSentAt: null, lastStatus: null, cooldownUntil: null, sentInWindow: 2, dailyCap: 20, capResetsAt: null } };
const SENT = { schemaVersion: 1, state: 'sent', id: ID, to: 'a@example.com', providerId: 're_synthetic', sentAt: AT, recorded: true };

function setup(respond) {
  const calls = [];
  const session = { user: { id: actor }, getToken: async () => 'synthetic-token' };
  let current = session;
  const client = createInviteToJoinClient({ accountId: actor, url: 'https://synthetic.invalid', anonKey: 'synthetic-public-key',
    getSession: () => current, fetchImpl: async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, init, body }); return respond(body); } });
  return { client, calls, changeSession: value => { current = value; } };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('preview posts one private request with the normalized address and returns the exact message', async () => {
  const f = setup(() => json(PREVIEW));
  const preview = await f.client.preview({ email: '  A@Example.COM ', name: '  Jane   Synthetic ' });
  assert.deepEqual(preview.email, EMAIL);
  assert.equal(preview.name, 'Jane Synthetic');
  assert.deepEqual(preview.history, { lastSentAt: null, cooldownUntil: null, sentInWindow: 2, dailyCap: 20 });
  const [{ url, init, body }] = f.calls;
  assert.equal(url, 'https://synthetic.invalid/functions/v1/invite-to-join');
  assert.deepEqual(body, { action: 'preview', email: 'a@example.com', name: 'Jane Synthetic' });
  assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
});

test('send posts exactly the reviewed subject and text, with resend only when chosen', async () => {
  const f = setup(() => json(SENT));
  const preview = { email: EMAIL, name: 'Jane Synthetic' };
  assert.deepEqual(await f.client.send(preview), { id: ID, to: 'a@example.com', providerId: 're_synthetic', sentAt: AT });
  assert.deepEqual(f.calls[0].body, { action: 'send', email: 'a@example.com', name: 'Jane Synthetic', subject: EMAIL.subject, text: EMAIL.text });
  await f.client.send({ email: EMAIL }, { resend: true });
  assert.deepEqual(f.calls[1].body, { action: 'send', email: 'a@example.com', subject: EMAIL.subject, text: EMAIL.text, resend: true });
});

test('a send is a success only with a provider id; anything else is a failure', async () => {
  for (const reply of [{ ...SENT, providerId: null }, { ...SENT, providerId: '' }, { ...SENT, state: 'queued' }, { ...SENT, to: 'b@example.com' }, { ...SENT, id: 'x' }, { schemaVersion: 1 }]) {
    const f = setup(() => json(reply));
    await assert.rejects(f.client.send({ email: EMAIL }), error => error.code === 'invite_unavailable' && /Nothing is known to have been sent/.test(error.message));
  }
});

test('refusals carry their reason, and every message says whether anything was sent', async () => {
  const cases = [
    [403, { error: 'admin_required' }, /Nothing was sent/],
    [409, { error: 'recently_invited', lastSentAt: AT, cooldownUntil: '2026-09-30T15:00:00.000Z' }, /already invited on .*Nothing was sent/],
    [429, { error: 'daily_cap', dailyCap: 20, capResetsAt: '2026-09-30T15:00:00.000Z' }, /daily limit of 20 .*Nothing was sent/],
    [502, { error: 'provider_refused' }, /refused this invitation, so it was not sent/],
    [502, { error: 'provider_unconfirmed' }, /may or may not have gone out/],
    [503, { error: 'offer_unavailable' }, /price could not be confirmed.*Nothing was sent/],
    [422, { error: 'inviter_incomplete' }, /Profile & settings.*Nothing was sent/],
    [500, 'not json', /could not be confirmed/],
  ];
  for (const [status, body, pattern] of cases) {
    const f = setup(() => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
    await assert.rejects(f.client.send({ email: EMAIL }), error => pattern.test(error.message) && (typeof body === 'string' || error.code === body.error), JSON.stringify(body));
  }
  // Only a refusal of the message itself points at the address.
  for (const code of ['provider_not_configured', 'provider_busy']) {
    const f = setup(() => json({ error: code }, 502));
    await assert.rejects(f.client.send({ email: EMAIL }), error => error.code === code && /nothing was sent/i.test(error.message)
      && !/check the address/i.test(error.message) && !/could not be confirmed/.test(error.message), code);
  }
  await assert.rejects(setup(() => json({ error: 'provider_not_configured' }, 502)).client.send({ email: EMAIL }), error => /server problem, not the address/.test(error.message));
  await assert.rejects(setup(() => json({ error: 'provider_busy' }, 502)).client.send({ email: EMAIL }), error => /Try again in a minute/.test(error.message));
  const stale = setup(() => json({ error: 'preview_stale', email: { ...EMAIL, text: 'New text' } }, 409));
  await assert.rejects(stale.client.send({ email: EMAIL }), error => error.code === 'preview_stale' && error.extra.email.text === 'New text');
});

test('bad input and a changed sign-in never reach the server', async () => {
  const f = setup(() => json(PREVIEW));
  await assert.rejects(f.client.preview({ email: 'nope' }), error => error.code === 'invalid_email');
  await assert.rejects(f.client.send({}), error => error.code === 'invite_unavailable');
  f.changeSession({ user: { id: 'user_someoneElse' }, getToken: async () => 'x' });
  await assert.rejects(f.client.preview({ email: 'a@example.com' }), error => error.code === 'session_changed');
  assert.equal(f.calls.length, 0);
});

test('list returns only well-formed rows', async () => {
  const row = { id: ID, email: 'a@example.com', name: 'Jane', status: 'sent', explicitResend: false, createdAt: AT, sentAt: AT };
  assert.deepEqual(await setup(() => json({ schemaVersion: 1, sends: [row] })).client.list(), [row]);
  await assert.rejects(setup(() => json({ schemaVersion: 1, sends: [{ ...row, id: 'x' }] })).client.list());
});
