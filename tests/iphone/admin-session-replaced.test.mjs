// Admin tools on the owner's iPhone (2026-10-01 review, reproduced against
// the real modules): each client compared Clerk session objects by identity,
// so a call in flight as the app came back to the front, or a lifetime grant
// after a trip to another app, failed with "session changed" (and the invite
// message could say "Nothing was sent" when the email had gone). Clerk builds
// a new Session object for the same session on every focus. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInviteToJoinClient } from '../../src/utils/inviteToJoinClient.js';
import { createAdminLifetimeAccessClient } from '../../src/utils/adminLifetimeAccessClient.js';
import { readFileSync } from 'node:fs';

const UID = 'user_admin';
const mk = (user = UID, id = 'sess_1') => ({ id, userId: user, user: { id: user }, getToken: async () => 'synthetic-token' });

test('an invite list answered after Clerk replaced the session object is read, not refused', async () => {
  let cur = mk();
  const client = createInviteToJoinClient({ accountId: UID, url: 'https://synthetic.invalid', anonKey: 'a', getSession: () => cur,
    fetchImpl: async () => { cur = mk(); return new Response(JSON.stringify({ schemaVersion: 1, sends: [] }), { status: 200 }); } });
  await client.list();
});

test('must-pass: another account signed in during the request still stops it', async () => {
  let cur = mk();
  const client = createInviteToJoinClient({ accountId: UID, url: 'https://synthetic.invalid', anonKey: 'a', getSession: () => cur,
    fetchImpl: async () => { cur = mk('user_other', 'sess_2'); return new Response(JSON.stringify({ schemaVersion: 1, sends: [] }), { status: 200 }); } });
  await assert.rejects(client.list(), e => e.code === 'session_changed');
});

test('a lifetime grant after the owner left the app and came back goes through', async () => {
  let s = mk();
  const calls = [];
  const target = { profileId: '00000000-0000-4000-8000-0000000000aa', clerkSubject: 'user_member', name: 'Synthetic Member', verifiedPrimaryEmail: 'member@example.test' };
  const client = createAdminLifetimeAccessClient({ accountId: UID, url: 'https://synthetic.invalid', anonKey: 'a', getSession: () => s, fetchImpl: async (_u, init) => {
    const b = JSON.parse(init.body); calls.push(b.action);
    const v = b.action === 'review'
      ? { schemaVersion: 1, reviewId: '00000000-0000-4000-8000-0000000000bb', expiresAt: new Date(Date.now() + 6e5).toISOString(), target, lifetime: { credential: false, practice: false }, canGrant: true, billing: { hasExistingSubscription: false, status: 'none', notice: 'none' } }
      : { schemaVersion: 1, target, grantId: '00000000-0000-4000-8000-0000000000cc', grantedAt: new Date().toISOString(), lifetime: { credential: true, practice: true }, cardRequired: false, subscriptionCreated: false, emailSent: false };
    return new Response(JSON.stringify(v), { status: 200 });
  } });
  const review = await client.review({ profileId: target.profileId, clerkSubject: target.clerkSubject });
  s = mk(); // back from another app: a new Session object, same session
  await client.grant(review, { reason: 'Synthetic founding member gift', confirmed: true });
  assert.deepEqual(calls, ['review', 'grant']);
  // A different session (signed out and in again) is still refused before the server is asked.
  const review2 = await client.review({ profileId: target.profileId, clerkSubject: target.clerkSubject });
  s = mk(UID, 'sess_9');
  await assert.rejects(client.grant(review2, { reason: 'Synthetic founding member gift', confirmed: true }), e => e.code === 'session_changed');
  assert.deepEqual(calls, ['review', 'grant', 'review']);
});

test('no client compares Clerk session objects by identity any more', () => {
  for (const f of ['memberViewClient', 'inviteToJoinClient', 'mailboxRepairClient', 'lifetimeGiftClient', 'adminLifetimeAccessClient', 'supportOperationsClient']) {
    const src = readFileSync(new URL(`../../src/utils/${f}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /getSession\(\) [!=]== session|expectedSession !== session/, f);
    assert.match(src, /sameClerkSession\(/, f);
  }
});
