import test from 'node:test';
import assert from 'node:assert/strict';
import { createCredentialPortalHandler } from '../../supabase/functions/_shared/credentialPortalHandler.mjs';
import { CREDENTIAL_PORTAL_POLICY, createPortalCrypto, digest, token, safeInlineMime } from '../../supabase/functions/_shared/credentialPortalCrypto.mjs';
import { postgresFixture, quote as q } from './postgresFixture.mjs';

test('private credential portal: actual migration, two recipients, atomic redemption, revocation and adversarial cases', { timeout: 120000 }, async t => {
  const db = await postgresFixture();
  t.after(() => db.close());
  const alice = { id: '10000000-0000-4000-8000-000000000001', subject: 'user_alice', email: 'alice-admin@example.com' };
  const bob = { id: '10000000-0000-4000-8000-000000000002', subject: 'user_bob', email: 'bob-admin@example.com' };
  const aDoc = '20000000-0000-4000-8000-000000000001', bDoc = '20000000-0000-4000-8000-000000000002', htmlDoc = '20000000-0000-4000-8000-000000000003';
  const files = new Map([[`${alice.subject}/${aDoc}`, new TextEncoder().encode('%PDF-1.7\nSynthetic credential A')], [`${bob.subject}/${bDoc}`, new TextEncoder().encode('%PDF-1.7\nSynthetic credential B')], [`${alice.subject}/${htmlDoc}`, new TextEncoder().encode('<script>syntheticOnly()</script>')]]);
  await db.sql(`insert into profiles values(${q(alice.id)},${q(alice.subject)},'active'),(${q(bob.id)},${q(bob.subject)},'active');
    insert into documents values(${q(aDoc)},${q(alice.id)},'Credential A.pdf','application/pdf',30,${q(`${alice.subject}/${aDoc}`)}),(${q(bDoc)},${q(bob.id)},'Credential B.pdf','application/pdf',30,${q(`${bob.subject}/${bDoc}`)}),(${q(htmlDoc)},${q(alice.id)},'Credential.html','text/html',30,${q(`${alice.subject}/${htmlDoc}`)});`, 'postgres');
  const row = async query => (await db.rows(query))[0] || null;
  const mails = []; let mailState = 'sent', mailIdOverride, fileReads = 0, duringRead = null;
  const box = createPortalCrypto('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); // Public synthetic fixture, never a runtime secret.
  const store = {
    profile: id => row(`select * from profiles where id=${q(id)}`),
    creationCapacity: (...args) => db.rpc('creation_capacity', args),
    ownerDocuments: (id, ids) => db.rows(`select * from documents where user_id=${q(id)} and id in (${ids.map(q).join(',')})`),
    ownerRequest: (id, req) => row(`select * from credential_portal_invites where owner_profile_id=${q(id)} and request_id=${q(req)}`),
    ownerInvite: (id, subject, invite) => row(`select id,recipient_email as "recipientEmail",expires_at as "expiresAt",case when revoked_at is not null then 'revoked' when redeemed_at is not null then 'redeemed' else 'pending' end as status,(select state from credential_portal_outbox where invite_id=i.id and kind='invite') as "deliveryState" from credential_portal_invites i where id=${q(invite)} and owner_profile_id=${q(id)} and owner_subject=${q(subject)}`),
    ownerInvites: (id, subject) => db.rows(`select id from credential_portal_invites where owner_profile_id=${q(id)} and owner_subject=${q(subject)}`),
    inviteMailId: async id => (await row(`select id from credential_portal_outbox where invite_id=${q(id)} and kind='invite'`))?.id,
    inviteByToken: (token, email) => row(`select id,otp_version from credential_portal_invites where token_digest=${q(token)} and recipient_email=${q(email)}`),
    createInvite: p => db.rpc('create', [p.id, p.owner, p.subject, p.email, p.request, p.fingerprint, p.tokenDigest, p.documents, p.mailId, p.encrypted]),
    claimOtp: p => db.rpc('claim_otp', [p.tokenDigest, p.email, p.version, p.otpDigest, p.mailId, p.encrypted, p.recipientLimitKey]),
    claimMail: (...args) => db.rpc('claim_mail', args), finishMail: (...args) => db.rpc('finish_mail', args),
    redeem: (...args) => db.rpc('redeem', args), access: (...args) => db.rpc('access', args), record: (...args) => db.rpc('record', args), revoke: (...args) => db.rpc('revoke', args),
    manifest: id => db.rows(`select * from credential_portal_documents where invite_id=${q(id)}`),
  };
  const deps = {
    crypto: box, store,
    authenticateOwner: async req => req.headers.get('x-owner') === 'alice' ? { profileId: alice.id, subject: alice.subject } : req.headers.get('x-owner') === 'bob' ? { profileId: bob.id, subject: bob.subject } : null,
    readFile: async (path, limit) => { fileReads++; const bytes = files.get(path); if (duringRead) await duringRead(); if (!bytes || bytes.length > limit) throw Error('unavailable'); return bytes.slice(); },
    sendMail: async (payload, key) => { mails.push({ payload: structuredClone(payload), key }); await new Promise(r => setTimeout(r, 15)); return { state: mailState, providerId: mailIdOverride !== undefined ? mailIdOverride : mailState === 'sent' ? 'synthetic-provider-id' : undefined }; },
  };
  const handler = createCredentialPortalHandler(deps, { ...CREDENTIAL_PORTAL_POLICY, enabled: true });
  const request = (input, owner, session) => new Request('https://functions.example/credential-portal', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-owner': owner } : {}), ...(session ? { Authorization: `Bearer ${session}` } : {}) }, body: JSON.stringify(input) });
  const call = async (input, owner, session) => { const response = await handler(request(input, owner, session)); return { status: response.status, body: await response.json(), headers: response.headers }; };
  const create = async (who = 'alice', recipient = alice.email, docs = [aDoc], requestId = crypto.randomUUID()) => {
    const result = await call({ action: 'create', recipientEmail: recipient, documentIds: docs, requestId }, who);
    assert.equal(result.status, 201); const invite = result.body.invite;
    const mail = mails.findLast(m => m.payload.to === recipient && m.payload.text.includes('#invite='));
    return { ...invite, token: mail.payload.text.match(/#invite=([A-Za-z0-9_-]{43})/)[1], email: recipient, requestId };
  };
  const codeFor = async invite => {
    assert.equal((await call({ action: 'request-code', inviteToken: invite.token, email: invite.email })).status, 202);
    return mails.findLast(m => m.payload.to === invite.email && m.payload.subject.includes('code')).payload.text.match(/code is (\d{6})/)[1];
  };
  const verify = (invite, code, email = invite.email) => call({ action: 'verify', inviteToken: invite.token, email, code });
  const enter = async (recipient, docs = [aDoc]) => { const invite = await create('alice', recipient, docs); const result = await verify(invite, await codeFor(invite)); assert.equal(result.status, 200); return { invite, session: result.body.sessionToken }; };

  await t.test('default disabled policy and GET previews perform no authentication, DB or mail work', async () => {
    const disabled = createCredentialPortalHandler({ authenticateOwner: () => { throw Error('must not run'); } });
    const response = await disabled(request({ action: 'create' }, 'alice')); assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal((await handler(new Request('https://functions.example/credential-portal?token=preview'))).status, 405);
    assert.equal(mails.length, 0);
  });
  await t.test('wrong owner, forged fields, unsynced metadata and traversal fail before file access', async () => {
    const count = fileReads;
    assert.equal((await call({ action: 'create', recipientEmail: alice.email, documentIds: [bDoc], requestId: crypto.randomUUID() }, 'alice')).status, 409);
    assert.equal((await call({ action: 'create', recipientEmail: alice.email, documentIds: [aDoc], requestId: crypto.randomUUID(), ownerId: bob.id }, 'alice')).status, 400);
    for (const path of [null, `${alice.subject}/../${bob.subject}/${bDoc}`, `${alice.subject}/${bDoc}`]) {
      await db.sql(`update documents set storage_path=${q(path)} where id=${q(aDoc)}`, 'postgres');
      assert.equal((await call({ action: 'create', recipientEmail: alice.email, documentIds: [aDoc], requestId: crypto.randomUUID() }, 'alice')).status, 409);
    }
    await db.sql(`update documents set storage_path=${q(`${alice.subject}/${aDoc}`)} where id=${q(aDoc)}`, 'postgres'); assert.equal(fileReads, count);
  });
  let a, b, aSession, bSession;
  await t.test('two independent recipients require exact invited mailbox and never leak invite token to owner response', async () => {
    a = await create(); b = await create('bob', bob.email, [bDoc]);
    const before = mails.length;
    assert.equal((await call({ action: 'request-code', inviteToken: a.token, email: bob.email })).status, 202); assert.equal(mails.length, before);
    const ac = await codeFor(a), bc = await codeFor(b);
    assert.equal((await verify(a, ac, bob.email)).status, 401);
    assert.equal((await verify(b, ac === bc ? (bc === '999999' ? '000000' : '999999') : ac)).status, 401);
    const av = await verify(a, ac), bv = await verify(b, bc); assert.equal(av.status, 200); assert.equal(bv.status, 200);
    aSession = av.body.sessionToken; bSession = bv.body.sessionToken;
    assert.deepEqual(av.body.documents.map(d => d.id), [aDoc]); assert.deepEqual(bv.body.documents.map(d => d.id), [bDoc]);
    const ownerResponse = await call({ action: 'list' }, 'alice'); assert.equal(JSON.stringify(ownerResponse.body).includes(a.token), false);
    assert.equal((await verify(a, ac)).status, 401); // Link consumed only after successful verification.
  });
  await t.test('verified sessions cannot list, view, download or revoke another owner or recipient selection', async () => {
    const count = fileReads;
    assert.deepEqual((await call({ action: 'documents' }, null, aSession)).body.documents.map(d => d.id), [aDoc]);
    for (const action of ['view', 'download']) assert.equal((await handler(request({ action, documentId: bDoc }, null, aSession))).status, 401);
    assert.equal((await handler(request({ action: 'download', documentId: aDoc }, null, bSession))).status, 401);
    assert.equal((await call({ action: 'revoke', inviteId: b.id }, 'alice')).status, 404);
    assert.equal(fileReads, count);
  });
  await t.test('safe view is bytes only, no storage URL; audit records response preparation, not a human read', async () => {
    const response = await handler(request({ action: 'view', documentId: aDoc }, null, aSession));
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/pdf'); assert.match(response.headers.get('content-disposition'), /^inline;/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), files.get(`${alice.subject}/${aDoc}`));
    const audit = await db.rows(`select event,bytes_prepared from credential_portal_audit where invite_id=${q(a.id)}`);
    assert.ok(audit.some(e => e.event === 'document_response_prepared' && e.bytes_prepared > 0)); assert.equal(audit.some(e => /read|viewed/.test(e.event)), false);
  });
  await t.test('replaced bytes and changed storage metadata stop an existing recipient session', async () => {
    const path = `${alice.subject}/${aDoc}`, original = files.get(path); const changed = original.slice(); changed[changed.length - 1] ^= 1; files.set(path, changed);
    assert.equal((await handler(request({ action: 'download', documentId: aDoc }, null, aSession))).status, 409); files.set(path, original);
    await db.sql(`update documents set storage_path=${q(`${alice.subject}/${htmlDoc}`)} where id=${q(aDoc)}`, 'postgres');
    const count = fileReads; assert.equal((await handler(request({ action: 'download', documentId: aDoc }, null, aSession))).status, 401); assert.equal(fileReads, count);
    await db.sql(`update documents set storage_path=${q(path)} where id=${q(aDoc)}`, 'postgres');
  });
  await t.test('revocation during storage fetch prevents response; subsequent reads/listing stop immediately', async () => {
    duringRead = async () => { assert.equal((await call({ action: 'revoke', inviteId: a.id }, 'alice')).status, 200); };
    assert.equal((await handler(request({ action: 'download', documentId: aDoc }, null, aSession))).status, 401); duringRead = null;
    const count = fileReads; assert.equal((await call({ action: 'documents' }, null, aSession)).status, 401); assert.equal((await handler(request({ action: 'download', documentId: aDoc }, null, aSession))).status, 401); assert.equal(fileReads, count);
    assert.equal((await call({ action: 'documents' }, null, bSession)).status, 200);
  });
  await t.test('twelve concurrent correct redemptions create exactly one session', async () => {
    const invite = await create('alice', 'race@example.com'); const code = await codeFor(invite);
    const attempts = await Promise.all(Array.from({ length: 12 }, () => verify(invite, code)));
    assert.equal(attempts.filter(r => r.status === 200).length, 1); assert.equal(attempts.filter(r => r.status === 401).length, 11);
    assert.equal((await db.rows(`select * from credential_portal_sessions where invite_id=${q(invite.id)}`)).length, 1);
  });
  await t.test('concurrent guesses stop at five attempts and resends cannot reset the budget', async () => {
    const invite = await create('alice', 'attempts@example.com'); const code = await codeFor(invite); const wrong = code === '999999' ? '000000' : '999999';
    const attempts = await Promise.all(Array.from({ length: 12 }, () => verify(invite, wrong))); assert.ok(attempts.every(r => r.status === 401));
    assert.equal((await row(`select otp_attempts from credential_portal_invites where id=${q(invite.id)}`)).otp_attempts, 5);
    const before = mails.length; await call({ action: 'request-code', inviteToken: invite.token, email: invite.email }); assert.equal(mails.length, before); assert.equal((await verify(invite, code)).status, 401);
  });
  await t.test('OTP version change invalidates the prior code and respects atomic send spacing', async () => {
    const invite = await create('alice', 'resend@example.com'); const oldCode = await codeFor(invite); const before = mails.length;
    await Promise.all(Array.from({ length: 8 }, () => call({ action: 'request-code', inviteToken: invite.token, email: invite.email }))); assert.equal(mails.length, before);
    await db.sql(`update credential_portal_invites set otp_last_sent_at=clock_timestamp()-interval '61 seconds' where id=${q(invite.id)}`);
    const newCode = await codeFor(invite); assert.equal(mails.length, before + 1);
    // Even if random six digits repeat, the MAC is independently bound to a fresh version.
    const stored = await row(`select otp_version,otp_digest from credential_portal_invites where id=${q(invite.id)}`);
    assert.equal(stored.otp_digest, await box.otpDigest(invite.id, stored.otp_version, newCode));
    if (newCode !== oldCode) assert.equal((await verify(invite, oldCode)).status, 401);
    assert.equal((await verify(invite, newCode)).status, 200);
  });
  await t.test('ambiguous provider outcome retries one encrypted payload with the same idempotency key', async () => {
    mailState = 'unknown'; const invite = await create('alice', 'unknown@example.com'); const original = mails.at(-1);
    const pending = await row(`select * from credential_portal_outbox where invite_id=${q(invite.id)} and kind='invite'`);
    assert.equal(pending.state, 'unknown'); assert.ok(pending.encrypted_payload.startsWith('v1.')); assert.equal(pending.encrypted_payload.includes(invite.token), false);
    mailState = 'sent'; const before = mails.length;
    assert.equal((await call({ action: 'create', recipientEmail: invite.email, documentIds: [aDoc], requestId: invite.requestId }, 'alice')).status, 200);
    assert.equal(mails.length, before); // Unknown outcomes have an atomic retry backoff.
    await db.sql(`update credential_portal_outbox set next_attempt_at=clock_timestamp()-interval '1 second' where id=${q(pending.id)}`);
    const retry = await call({ action: 'create', recipientEmail: invite.email, documentIds: [aDoc], requestId: invite.requestId }, 'alice');
    assert.equal(retry.status, 200); assert.equal(mails.length, before + 1); assert.deepEqual(mails.at(-1), original);
    assert.equal((await row(`select encrypted_payload from credential_portal_outbox where id=${q(pending.id)}`)).encrypted_payload, null);
    assert.equal((await call({ action: 'create', recipientEmail: 'changed@example.com', documentIds: [aDoc], requestId: invite.requestId }, 'alice')).status, 409);
  });
  await t.test('token/OTP rows store digests and ciphertext cannot be transplanted between outbox rows', async () => {
    const envelope = await box.seal('mail-a', { token: 'synthetic', code: '123456' });
    await assert.rejects(box.open('mail-b', envelope));
    assert.notEqual(await box.otpDigest('a', 'v1', '123456'), await box.otpDigest('a', 'v2', '123456'));
    const rows = await db.rows('select token_digest,otp_digest from credential_portal_invites');
    for (const row of rows) { assert.match(row.token_digest, /^[a-f0-9]{64}$/); if (row.otp_digest) assert.match(row.otp_digest, /^[a-f0-9]{64}$/); }
    assert.equal(JSON.stringify(rows).includes(a.token), false);
  });
  await t.test('empty provider success remains unknown; exhausted unknown is never relabeled as definitive failure', async () => {
    mailIdOverride = ''; const invite = await create('alice', 'malformed-provider@example.com'); mailIdOverride = undefined;
    const mail = await row(`select * from credential_portal_outbox where invite_id=${q(invite.id)} and kind='invite'`);
    assert.equal(mail.state, 'unknown');
    await db.sql(`update credential_portal_outbox set attempts=5,next_attempt_at=clock_timestamp()-interval '1 second' where id=${q(mail.id)}`);
    assert.equal(await store.claimMail(mail.id, crypto.randomUUID()), null);
    const exhausted = await row(`select state,encrypted_payload from credential_portal_outbox where id=${q(mail.id)}`);
    assert.equal(exhausted.state, 'unknown'); assert.ok(exhausted.encrypted_payload);
    await assert.rejects(db.rpc('finish_mail', [mail.id, crypto.randomUUID(), 'sent', '']));
    await db.sql(`update credential_portal_outbox set expires_at=clock_timestamp()-interval '1 second' where id=${q(mail.id)}`);
    await db.rpc('prune', []);
    const pruned = await row(`select state,encrypted_payload from credential_portal_outbox where id=${q(mail.id)}`);
    assert.equal(pruned.state, 'unknown'); assert.equal(pruned.encrypted_payload, null);
  });
  await t.test('pruning, redemption and revocation use a consistent lock order under contention', async () => {
    mailState = 'unknown'; const invite = await create('alice', 'maintenance@example.com'); mailState = 'sent'; const code = await codeFor(invite);
    await db.sql(`update credential_portal_outbox set expires_at=clock_timestamp()-interval '1 second' where invite_id=${q(invite.id)} and kind='invite'`);
    const results = await Promise.all([verify(invite, code), store.revoke(alice.id, alice.subject, invite.id), ...Array.from({ length: 12 }, () => db.rpc('prune', []))]);
    assert.ok([200, 401].includes(results[0].status)); assert.equal(results[1], true);
    if (results[0].status === 200) assert.equal((await call({ action: 'documents' }, null, results[0].body.sessionToken)).status, 401);
    assert.equal((await row(`select count(*)::int as total from credential_portal_outbox where invite_id=${q(invite.id)} and encrypted_payload is not null`)).total, 0);
  });
  await t.test('over-quota creation is rejected before any storage reads', async () => {
    const old = await row(`select used from credential_portal_limits where scope='owner_invites' and key=${q(alice.id)} and window_start=date_trunc('day',clock_timestamp())`);
    await db.sql(`update credential_portal_limits set used=20 where scope='owner_invites' and key=${q(alice.id)}`);
    const count = fileReads;
    assert.equal((await call({ action: 'create', recipientEmail: 'limited@example.com', documentIds: [aDoc], requestId: crypto.randomUUID() }, 'alice')).status, 429);
    assert.equal(fileReads, count);
    await db.sql(`update credential_portal_limits set used=${old.used} where scope='owner_invites' and key=${q(alice.id)}`);
  });
  await t.test('HTML, SVG and mismatched magic are forced to download; legitimate text is inert plaintext', async () => {
    const { session } = await enter('html@example.com', [htmlDoc]); const response = await handler(request({ action: 'view', documentId: htmlDoc }, null, session));
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.equal(safeInlineMime(new TextEncoder().encode('<svg/>'), 'image/svg+xml'), null);
    assert.equal(safeInlineMime(new TextEncoder().encode('<script/>'), 'application/pdf'), null);
    assert.equal(safeInlineMime(new TextEncoder().encode('<script/>'), 'text/plain'), 'text/plain; charset=utf-8');
  });
  await t.test('expired session, expired invitation and revoked owner stop access', async () => {
    const { invite, session } = await enter('expiry@example.com'); const hashed = await digest(session);
    await db.sql(`update credential_portal_sessions set expires_at=clock_timestamp()-interval '1 second' where token_digest=${q(hashed)}`); assert.equal((await call({ action: 'documents' }, null, session)).status, 401);
    const pending = await create('alice', 'expired-invite@example.com'); const code = await codeFor(pending);
    await db.sql(`update credential_portal_invites set expires_at=clock_timestamp()-interval '1 second' where id=${q(pending.id)}`); assert.equal((await verify(pending, code)).status, 401);
    await db.sql(`update profiles set access_status='revoked' where id=${q(bob.id)}`, 'postgres'); assert.equal((await call({ action: 'documents' }, null, bSession)).status, 401);
    assert.ok(invite.id);
  });
  await t.test('request quota permits the final authorized response and refuses further access', async () => {
    const { session } = await enter('quota@example.com'); const hashed = await digest(session);
    await db.sql(`update credential_portal_sessions set request_count=99 where token_digest=${q(hashed)}`);
    assert.equal((await call({ action: 'documents' }, null, session)).status, 200);
    assert.equal((await call({ action: 'documents' }, null, session)).status, 401);
  });
  await t.test('anonymous and authenticated database roles cannot read tables, decrypt outbox, redeem or bypass ownership via RPC', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['credential_portal_invites', 'credential_portal_documents', 'credential_portal_sessions', 'credential_portal_outbox', 'credential_portal_audit']) await assert.rejects(db.sql(`select * from ${table}`, role));
      await assert.rejects(db.rpc('access', [await digest(aSession), aDoc, false], role));
      await assert.rejects(db.rpc('revoke', [alice.id, alice.subject, a.id], role));
    }
  });
  await t.test('body streaming and exact request fields reject oversized or forged recipient parameters', async () => {
    let canceled = false;
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(9000)); }, cancel() { canceled = true; } });
    const response = await handler(new Request('https://functions.example/credential-portal', { method: 'POST', body: stream, duplex: 'half' })); assert.equal(response.status, 413); assert.equal(canceled, true);
    assert.equal((await call({ action: 'documents', inviteId: b.id }, null, bSession)).status, 400);
    assert.equal((await call({ action: 'verify', inviteToken: token(), email: 'x\r\n@example.com', code: '123456' })).status, 401);
  });
});
