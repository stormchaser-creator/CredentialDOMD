// An invite sent from Admin > Accounts > Invite to join must be addressed to
// the invited person and only reported as delivered on a confirmed provider
// send; any other outcome must come back with a specific, distinguishable
// reason an administrator (and, through the client, the UI) can act on.
// Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInviteToJoinHandler } from '../../supabase/functions/_shared/inviteToJoin.mjs';
import { createInviteToJoinClient } from '../../src/utils/inviteToJoinClient.js';

const ADMIN = { profileId: '00000000-0000-4000-8000-000000000001', clerkSubject: 'user_Admin1', isAdmin: true };
const INVITER = { id: ADMIN.profileId, name: 'Synthetic Owner', degree_type: 'DO', email: 'typed@example.invalid', verified_email: 'owner@example.invalid' };
const RESERVATION = '11111111-1111-4111-8111-111111111111';
const AT = '2026-09-29T15:00:00.000Z';
const FOUNDING = { schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available', bundleAvailable: false };
const READY = { state: 'ready', lastStatus: null, lastSentAt: null, cooldownUntil: null, sentInWindow: 1, dailyCap: 20, capResetsAt: null };

const post = (body) => new Request('https://x.test/functions/v1/invite-to-join', {
  method: 'POST', headers: { origin: 'https://credentialdomd.com' }, body: JSON.stringify(body),
});
const read = async response => ({ status: response.status, body: await response.json() });

function makeHandler({ sendMail } = {}) {
  const calls = [];
  const note = (name, fn) => async (...args) => { calls.push([name, ...args]); return fn(...args); };
  const handler = createInviteToJoinHandler({
    origin: 'https://credentialdomd.com', configured: () => true, authenticate: async () => ADMIN, log: { error() {} },
    store: {
      inviter: note('inviter', async () => INVITER),
      offer: note('offer', async () => FOUNDING),
      status: note('status', async () => READY),
      reserve: note('reserve', async (_actor, email) => ({ state: 'reserved', id: RESERVATION, email, createdAt: AT })),
      finish: note('finish', async (id, status, providerId) => ({ state: 'finished', id, status, sentAt: status === 'sent' ? AT : null, providerId })),
      list: note('list', async () => ({ state: 'ready', sends: [] })),
    },
    sendMail: note('sendMail', sendMail || (async () => ({ state: 'sent', providerId: 're_synthetic123' }))),
  });
  return { handler, calls };
}

test('AC-1: a send reaches the provider addressed to the exact person invited, and only reports success with a confirmed provider id', async () => {
  const invited = 'new.doctor@example.com';
  const h = makeHandler();
  const preview = await read(await h.handler(post({ action: 'preview', email: invited, name: 'Jane Synthetic' })));
  assert.equal(preview.status, 200);
  const { email } = preview.body;
  assert.equal(email.to, invited, 'the composed message is addressed to the person who was invited, not the admin');

  const sent = await read(await h.handler(post({ action: 'send', email: email.to, name: 'Jane Synthetic', subject: email.subject, text: email.text })));
  assert.equal(sent.status, 200);
  assert.equal(sent.body.state, 'sent');
  assert.equal(sent.body.to, invited);
  assert.ok(sent.body.providerId, 'delivery is only reported once the provider confirmed it with an id');

  const mailCall = h.calls.find(c => c[0] === 'sendMail');
  assert.deepEqual(mailCall[1].to, [invited], 'the outbound mail payload is addressed to the invited person');
});

test('AC-2: when an invite does not arrive, the admin gets a specific reason, not a generic failure or a false success', async () => {
  const cases = [
    { mail: async () => ({ state: 'failed', reason: 'address' }), code: 'provider_refused', pattern: /refused this invitation, so it was not sent\. Check the address/ },
    { mail: async () => ({ state: 'failed', reason: 'setup' }), code: 'provider_not_configured', pattern: /server problem, not the address/ },
    { mail: async () => ({ state: 'failed', reason: 'busy' }), code: 'provider_busy', pattern: /Try again in a minute/ },
    { mail: async () => ({ state: 'unknown' }), code: 'provider_unconfirmed', pattern: /may or may not have gone out/ },
  ];
  const seen = new Set();
  for (const { mail, code, pattern } of cases) {
    const h = makeHandler({ sendMail: mail });
    const preview = await read(await h.handler(post({ action: 'preview', email: 'new.doctor@example.com' })));
    const { email } = preview.body;
    const sent = await read(await h.handler(post({ action: 'send', email: email.to, subject: email.subject, text: email.text })));
    assert.equal(sent.status, 502);
    assert.equal(sent.body.error, code);
    seen.add(code);

    const session = { user: { id: 'user_syntheticAdmin' }, getToken: async () => 'synthetic-token' };
    const client = createInviteToJoinClient({
      accountId: 'user_syntheticAdmin', url: 'https://synthetic.invalid', anonKey: 'synthetic-public-key',
      getSession: () => session,
      fetchImpl: async () => new Response(JSON.stringify(sent.body), { status: 502 }),
    });
    await assert.rejects(client.send({ email }), error => error.code === code && pattern.test(error.message), code);
  }
  // Every failure mode is reported with its own distinguishable reason: none
  // collapses into a single "something went wrong" the admin cannot act on.
  assert.equal(seen.size, cases.length);
});
