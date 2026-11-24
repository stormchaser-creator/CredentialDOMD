// payFirstSignup.mjs: start, provisioning, refusals, the payer's status and
// sign-in token, the owner's button and docs@ proof. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, sha, newNonce } from './payFirstWorld.mjs';
import { EMAILED_SIGN_IN_LINK } from '../../supabase/functions/_shared/payFirstSignup.mjs';

const status = (w, s, nonce) => w.post(w.payFirst.status, { sessionId: s, nonce });

test('Sign up opens a founding Checkout with no account; the Terms tick was ours, not Stripe\'s', async () => {
  const w = world();
  const s = await w.start();
  assert.match(s.url, /^https:\/\/checkout\.stripe\.com\//);
  const [, args, opts] = w.calls.find(c => c[0] === 'stripe.session.create');
  assert.equal(args.mode, 'subscription');
  assert.deepEqual(args.line_items, [{ price: 'price_Founding', quantity: 1 }]);
  assert.equal(args.payment_method_collection, 'always');
  assert.deepEqual(args.payment_method_types, ['card', 'link']);
  // No Stripe Dashboard Terms URL is needed (owner, 2026-11-24): Checkout
  // asks for no Terms tick; the reviewed renewal terms stay by the pay button.
  assert.equal(args.consent_collection, undefined);
  assert.deepEqual(Object.keys(args.custom_text), ['submit']);
  assert.match(args.custom_text.submit.message, /^Credential: USD 99 due now, then USD 99 each year/);
  // The hold keeps the reviewed consent the Sign up page's tick agreed to.
  assert.match(w.rows.get(s.signupId).consent_text, /^Credential: USD 99 due now/);
  assert.equal(args.success_url, 'https://credentialdomd.com/app/?signup={CHECKOUT_SESSION_ID}');
  assert.equal(args.cancel_url, 'https://credentialdomd.com/?signup=canceled#pricing');
  assert.equal(args.metadata.flow, 'pay_first');
  assert.equal(args.metadata.pay_first_signup_id, s.signupId);
  assert.equal(args.metadata.profile_id, undefined);
  assert.deepEqual(args.subscription_data.metadata, args.metadata);
  assert.equal(args.after_expiration, undefined, 'no recovery link for a founding place');
  assert.equal(args.expires_at, Math.floor((w.now() + 7200000) / 1000));
  assert.equal(opts.idempotencyKey, `credentialdomd:payfirst:${s.signupId}`);
  assert.equal(w.rows.get(s.signupId).state, 'open');
  assert.equal(w.rows.get(s.signupId).nonce_digest, sha(s.nonce), 'only the digest leaves the browser');
  assert.equal(w.count('clerk.find') + w.count('clerk.create'), 0);
});

test('Sign up refuses while off, full or malformed', async () => {
  const w = world();
  w.store.disabled = true;
  assert.equal((await w.post(w.payFirst.start, { nonceDigest: sha(newNonce()), terms: 'accepted' })).status, 503);
  w.store.disabled = false; w.store.full = true;
  const full = await w.post(w.payFirst.start, { nonceDigest: sha(newNonce()), terms: 'accepted' });
  assert.equal(full.status, 409);
  assert.equal((await full.json()).error, 'founding_full');
  assert.equal((await w.post(w.payFirst.start, { nonceDigest: 'nope', terms: 'accepted' })).status, 400);
  assert.equal((await w.post(w.payFirst.start, { nonceDigest: sha('x'), terms: 'accepted', email: 'a@b.co' })).status, 400);
  assert.equal(w.count('stripe.session.create'), 0);
});

test('Sign up without the Terms tick on our page holds nothing and opens no Checkout', async () => {
  const w = world();
  for (const body of [{ nonceDigest: sha(newNonce()) }, { nonceDigest: sha(newNonce()), terms: true }, { nonceDigest: sha(newNonce()), terms: 'declined' }]) {
    const r = await w.post(w.payFirst.start, body);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'terms_required');
  }
  assert.equal(w.rows.size, 0, 'no place held');
  assert.equal(w.count('stripe.session.create'), 0);
});

test('a new buyer: one Clerk user, one profile, adopted, settled, signed in on the paying browser', async () => {
  const w = world();
  const s = await w.start();
  w.pay(s.sessionId);
  const first = await status(w, s.sessionId, s.nonce);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.state, 'ready');
  assert.match(body.ticket, /^ticket_user_/);
  const tokenCall = w.calls.find(c => c[0] === 'clerk.token');
  assert.equal(tokenCall[2], 600, 'single use, 10 minutes');
  assert.equal(w.count('clerk.create'), 1);
  const [, email, external] = w.calls.find(c => c[0] === 'clerk.create');
  assert.equal(email, 'new.buyer@example.org', 'normalized: case and spaces');
  assert.equal(external, s.signupId);
  const row = w.rows.get(s.signupId);
  assert.equal(row.state, 'provisioned');
  assert.equal(row.created_user, true);
  assert.equal(w.slots.get(row.attempt_id), 'paid');
  assert.equal(w.settled.length, 1);
  assert.equal(w.settled[0].proof.initial, true);
  assert.deepEqual(w.calls.filter(c => c[0] === 'welcome').length, 1);
  // Stripe now carries what settlement checks, set once under idempotency keys.
  const sub = w.subs.get(row.subscription_id);
  assert.equal(sub.metadata.profile_id, row.profile_id);
  assert.equal(sub.metadata.checkout_attempt_id, row.attempt_id);
  assert.equal(sub.metadata.flow, 'pay_first');
  const [, , , custOpts] = w.calls.find(c => c[0] === 'stripe.customer.update');
  assert.equal(custOpts.idempotencyKey, `credentialdomd:payfirst:${s.signupId}:customer`);
  // Again: nothing repeats, a new token within 15 minutes.
  const again = await (await status(w, s.sessionId, s.nonce)).json();
  assert.equal(again.state, 'ready');
  assert.equal(w.count('clerk.create'), 1);
  assert.equal(w.count('profile.init'), 1);
  assert.equal(w.settled.length, 1);
  // After 15 minutes: Log in with the email code instead.
  w.tick(16 * 60000);
  assert.deepEqual(await (await status(w, s.sessionId, s.nonce)).json(), { state: 'login' });
});

test('the token is only for the browser holding the nonce', async () => {
  const w = world();
  const s = await w.start();
  w.pay(s.sessionId);
  const wrong = await status(w, s.sessionId, newNonce());
  assert.equal(wrong.status, 403);
  assert.equal(w.count('clerk.find'), 0, 'refused before any provider call');
  assert.equal((await status(w, 'cs_test_unknown', s.nonce)).status, 404);
  assert.equal((await status(w, s.sessionId, 'short')).status, 400);
});

test('not paid yet: 202 setting up, with no Clerk call', async () => {
  const w = world();
  const s = await w.start();
  const r = await status(w, s.sessionId, s.nonce);
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { state: 'setting_up' });
  assert.equal(w.count('clerk.find'), 0);
  assert.equal(w.rows.get(s.signupId).state, 'open');
});

test('refusals before any Clerk call: unpaid, wrong mode, catalog or app', async () => {
  const cases = [
    ['payment not paid', (w, sid) => w.pay(sid, { paid: false }), 'not_paid'],
    ['wrong livemode', (w, sid) => { w.pay(sid); w.sessions.get(sid).livemode = true; }, 'mismatch'],
    ['catalog mismatch', (w, sid) => { w.pay(sid); w.sessions.get(sid).metadata.catalog_version = 'other'; }, 'mismatch'],
    ['app mismatch', (w, sid) => { w.pay(sid); w.sessions.get(sid).metadata.app = 'other'; }, 'mismatch'],
    ['another hold', (w, sid) => { w.pay(sid); w.sessions.get(sid).metadata.pay_first_signup_id = '00000000-0000-4000-8000-000000000000'; }, 'mismatch'],
  ];
  for (const [label, alter, expected] of cases) {
    const w = world();
    const s = await w.start();
    alter(w, s.sessionId);
    const result = await w.payFirst.provision({ sessionId: s.sessionId, signupId: s.signupId, via: 'webhook' });
    assert.equal(result.state, expected, label);
    assert.equal(w.count('clerk.find') + w.count('clerk.create'), 0, label);
    assert.equal(w.settled.length, 0, label);
  }
});

test('a paid Checkout with no Stripe Terms tick (none is asked for) is provisioned', async () => {
  const w = world();
  const s = await w.start();
  w.pay(s.sessionId, { terms: null });
  const result = await w.payFirst.provision({ sessionId: s.sessionId, signupId: s.signupId, via: 'webhook' });
  assert.equal(result.state, 'provisioned');
  assert.equal(w.rows.get(s.signupId).state, 'provisioned');
});

test('a Clerk create whose answer was lost: the retry finds the user, no duplicate', async () => {
  const w = world();
  const s = await w.start();
  w.pay(s.sessionId);
  w.clerk.fail.createAnswerLost = true;
  const result = await w.payFirst.provision({ sessionId: s.sessionId, signupId: s.signupId, via: 'webhook' });
  assert.equal(result.state, 'provisioned');
  assert.equal(w.users.size, 1);
  assert.equal(w.count('clerk.create'), 1);
});

test('Stripe metadata updates repeat under the same idempotency key', async () => {
  const w = world();
  const s = await w.start();
  w.pay(s.sessionId);
  // Settlement is busy (another event for the account) after the metadata was written.
  w.reconcileBusy(2);
  const first = await w.payFirst.provision({ sessionId: s.sessionId, signupId: s.signupId, via: 'return' });
  assert.equal(first.state, 'failed');
  assert.equal(w.rows.get(s.signupId).state, 'provisioning', 'adopted, waiting for settlement');
  const second = await w.payFirst.provision({ sessionId: s.sessionId, signupId: s.signupId, via: 'sweep' });
  assert.equal(second.state, 'provisioned');
  const keys = w.calls.filter(c => c[0] === 'stripe.key' && c[1] === 'subscription').map(c => c[2]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'the retry sends the same key');
  assert.match(keys[0], new RegExp(`^credentialdomd:payfirst:${s.signupId}:subscription:`));
  assert.equal(w.count('db.adopt'), 2, 'the second adopt is the no-op for an adopted hold');
  assert.equal(w.settled.length, 1);
});

test('an existing unpaid lead: the payment attaches to that account', async () => {
  const w = world();
  const lead = w.addUser('lead@example.org');
  const s = await w.start();
  w.pay(s.sessionId, { email: 'LEAD@example.org' });
  // The lead left a login-first Checkout open: it is expired first, then adopted with the proof.
  let asked = 0;
  w.setAdopt((a) => {
    if (!a.priorAttempt && asked++ === 0) return { state: 'prior_attempt', prior: { attempt_id: '11111111-1111-4111-8111-111111111111', state: 'open', session_id: 'cs_test_lead', created_at: new Date(w.now() - 3600000).toISOString(), customer_id: 'cus_lead' } };
    return null;
  });
  w.sessions.set('cs_test_lead', { id: 'cs_test_lead', status: 'open', customer: 'cus_lead', livemode: false, subscription: null, metadata: { checkout_attempt_id: '11111111-1111-4111-8111-111111111111' } });
  const result = await w.payFirst.provision({ sessionId: s.sessionId, signupId: s.signupId, via: 'webhook' });
  assert.equal(result.state, 'provisioned');
  assert.equal(w.count('clerk.create'), 0, 'no new user');
  assert.equal(w.rows.get(s.signupId).clerk_subject, lead.id);
  assert.equal(w.rows.get(s.signupId).created_user, false, 'docs@ is not held back for an account that proved its email');
  assert.equal(w.sessions.get('cs_test_lead').status, 'expired');
  const adopts = w.calls.filter(c => c[0] === 'db.adopt');
  assert.equal(adopts.at(-1)[3], '11111111-1111-4111-8111-111111111111');
});

test('an existing lead without a login-first Checkout is adopted directly', async () => {
  const w = world();
  w.addUser('lead2@example.org');
  const s = await w.start();
  w.pay(s.sessionId, { email: 'lead2@example.org' });
  assert.equal((await w.payFirst.provision({ sessionId: s.sessionId, signupId: s.signupId, via: 'webhook' })).state, 'provisioned');
  assert.equal(w.count('clerk.create'), 0);
});

test('a paid, lifetime or beta member: duplicate_member, the success page says Log in', async () => {
  const w = world();
  w.addUser('member@example.org');
  w.setAdopt({ state: 'duplicate_member', reason: 'already_member' });
  const s = await w.start();
  w.pay(s.sessionId, { email: 'member@example.org' });
  assert.deepEqual(await (await status(w, s.sessionId, s.nonce)).json(), { state: 'already_member' });
  assert.equal(w.rows.get(s.signupId).state, 'duplicate_member');
  assert.equal(w.settled.length, 0, 'nothing settled: the owner refunds by hand');
  assert.equal(w.count('clerk.token'), 0);
});

test('a deleted account, a secondary address, a different customer: the owner looks', async () => {
  for (const [label, prepare, reason] of [
    ['deleted account', w => w.addUser('gone@example.org', { deleted: true }), 'account_unavailable'],
    ['secondary address', w => w.addUser('gone@example.org', { primary: 'other@example.org' }), 'email_not_primary'],
    ['unverified address', w => w.addUser('gone@example.org', { verified: false }), 'verified_primary_required'],
    ['different customer', w => { w.addUser('gone@example.org'); w.setAdopt({ state: 'needs_owner', reason: 'customer_conflict' }); }, 'customer_conflict'],
  ]) {
    const w = world();
    prepare(w);
    const s = await w.start();
    w.pay(s.sessionId, { email: 'gone@example.org' });
    const result = await w.payFirst.provision({ sessionId: s.sessionId, signupId: s.signupId, via: 'webhook' });
    assert.equal(result.state, 'needs_owner', label);
    assert.equal(w.rows.get(s.signupId).state, 'needs_owner', label);
    assert.equal(w.rows.get(s.signupId).owner_reason, reason, label);
    assert.equal(w.count('clerk.create'), 0, label);
    assert.deepEqual(await (await status(w, s.sessionId, s.nonce)).json(), { state: 'delayed' }, label);
    // Only the owner's button runs it again.
    assert.equal((await w.payFirst.provision({ sessionId: s.sessionId, signupId: s.signupId, via: 'sweep' })).state, 'needs_owner', label);
  }
});

test('Finish paid sign-up: admins only', async () => {
  const w = world();
  w.setAdopt({ state: 'needs_owner', reason: 'founding_full' });
  const s = await w.start();
  w.pay(s.sessionId);
  await w.payFirst.provision({ sessionId: s.sessionId, signupId: s.signupId, via: 'webhook' });
  const as = who => ({ 'x-test-who': JSON.stringify(who) });
  assert.equal((await w.post(w.payFirst.status, { action: 'finish', signupId: s.signupId })).status, 401);
  assert.equal((await w.post(w.payFirst.status, { action: 'finish', signupId: s.signupId }, as({ profileId: 'p', isAdmin: false }))).status, 403);
  w.setAdopt(null); // The owner made room (honoured above the cap).
  const r = await w.post(w.payFirst.status, { action: 'finish', signupId: s.signupId }, as({ profileId: 'p', isAdmin: true }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).state, 'provisioned');
});

test('docs@ turns on at the first sign-in that was not the instant one', async () => {
  const w = world();
  const s = await w.start();
  w.pay(s.sessionId);
  await (await status(w, s.sessionId, s.nonce)).json();
  const row = w.rows.get(s.signupId);
  const user = w.users.get(row.clerk_subject);
  const issued = Date.parse(row.token_issued_at);
  user.sessions = [{ id: 'sess_ticket', created_at: issued + 2000 }];
  const as = sessionId => ({ 'x-test-who': JSON.stringify({ profileId: row.profile_id, clerkSubject: row.clerk_subject, sessionId }) });
  assert.equal(await w.store.emailUnproven(row.profile_id), true);
  assert.deepEqual(await (await w.post(w.payFirst.status, { action: 'prove' }, as('sess_ticket'))).json(), { state: 'unproven' });
  user.sessions.push({ id: 'sess_emailcode', created_at: issued + 86400000 });
  assert.deepEqual(await (await w.post(w.payFirst.status, { action: 'prove' }, as('sess_emailcode'))).json(), { state: 'proven' });
  assert.equal(await w.store.emailUnproven(row.profile_id), false);
});

test('the sweep needs the hook secret and finishes what the webhooks missed', async () => {
  const w = world();
  const s = await w.start();
  w.pay(s.sessionId);
  await w.store.claim(s.signupId, s.sessionId, 'webhook'); // A webhook worker died holding the lease.
  w.rows.get(s.signupId).state = 'paid';
  assert.equal((await w.post(w.payFirst.status, { action: 'sweep' }, { 'x-hook-secret': 'wrong' })).status, 401);
  w.tick(6 * 60000);
  const r = await (await w.post(w.payFirst.status, { action: 'sweep' }, { 'x-hook-secret': 'hook-secret' })).json();
  assert.deepEqual(r.outcomes, { provisioned: 1 });
  assert.equal(w.rows.get(s.signupId).state, 'provisioned');
});

test('the emailed sign-in link is built OFF: nothing is sent, and its draft claims only what is built', async () => {
  assert.equal(EMAILED_SIGN_IN_LINK.enabled, false);
  assert.equal(EMAILED_SIGN_IN_LINK.text('https://credentialdomd.com/app/?signin=t'), `Your CredentialDOMD membership is set up.

Log in: https://credentialdomd.com/app/?signin=t

This link works once, for 24 hours. You can always log in with the email you used at checkout and the code we send.

CredentialDOMD
https://credentialdomd.com`);
  const w = world();
  const sent = [];
  const s = await w.start();
  w.pay(s.sessionId);
  await w.webhook('checkout.session.completed', structuredClone(w.sessions.get(s.sessionId)));
  w.tick(11 * 60000);
  w.store.linkDue = async () => [{ signup_id: s.signupId, clerk_subject: w.rows.get(s.signupId).clerk_subject, email: 'new.buyer@example.org' }];
  w.store.markLinkEmailed = async () => true;
  const off = await (await w.post(w.statusRoute({ deliverLink: async m => sent.push(m) }), { action: 'sweep' }, { 'x-hook-secret': 'hook-secret' })).json();
  assert.equal(off.linksEmailed, undefined);
  assert.equal(sent.length, 0);
  // Turned on (only by a reviewed change): one link per sign-up, under its own key.
  const marks = new Set();
  w.store.markLinkEmailed = async id => !marks.has(id) && !!marks.add(id);
  const on = w.statusRoute({ deliverLink: async m => sent.push(m), emailedLink: { ...EMAILED_SIGN_IN_LINK, enabled: true } });
  for (let i = 0; i < 2; i++) await w.post(on, { action: 'sweep' }, { 'x-hook-secret': 'hook-secret' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'new.buyer@example.org');
  assert.match(sent[0].text, /\/app\/\?signin=ticket_user_/);
  assert.equal(sent[0].idempotencyKey, `credentialdomd:payfirst-link:${s.signupId}`);
  assert.equal(w.calls.filter(c => c[0] === 'clerk.token').at(-1)[2], 86400);
});

test('the sweep releases an abandoned Checkout once Stripe says it expired unpaid', async () => {
  const w = world();
  const s = await w.start();
  w.tick(2 * 3600000 + 16 * 60000);
  w.sessions.get(s.sessionId).status = 'expired';
  const r = await (await w.post(w.payFirst.status, { action: 'sweep' }, { 'x-hook-secret': 'hook-secret' })).json();
  assert.deepEqual(r.outcomes, { released: 1 });
  assert.equal(w.rows.get(s.signupId).state, 'expired');
});
