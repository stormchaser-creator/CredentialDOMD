// Administrator access (standing grants) against the real migrations on a
// production-shaped PostgreSQL. Synthetic owners, records and bytes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCredentialPortalHandler } from '../../supabase/functions/_shared/credentialPortalHandler.mjs';
import { CREDENTIAL_PORTAL_POLICY, createPortalCrypto, digest } from '../../supabase/functions/_shared/credentialPortalCrypto.mjs';
import { ADMIN_ACCESS_SECTION_KEYS, ADMIN_ACCESS_DENIED, standingInvitationEmail, ownerAllowed } from '../../supabase/functions/_shared/credentialPortalView.mjs';
import { parseStandingView, documentActions } from '../../public/credential-access/portal.mjs';
import { postgresFixture, pgSkip, quote as q } from './postgresFixture.mjs';

const MIGRATION = fs.readFileSync(new URL('../../supabase/migrations/20260925040000_credential_portal_admin_access.sql', import.meta.url), 'utf8');
const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pdf = label => new TextEncoder().encode(`%PDF-1.7\nSynthetic ${label}`);
// Keys and values that must never reach an administrator.
const FORBIDDEN_KEYS = ['notes', 'customFields', 'custom_fields', 'favorite', 'userId', 'user_id', 'storagePath', 'storage_path', 'renewalCost', 'renewal_cost',
  'portalUrl', 'loginUsername', 'loginSecret', 'cost', 'settlementAmount', 'settlement_amount', 'reasonForLeaving', 'specimenId', 'orderedBy',
  'requestedBy', 'assignment', 'title_secret', 'complication', 'wRvu', 'source', 'address', 'phone_personal', 'taxPrep'];
function allKeys(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); allKeys(v, out); }
  return out;
}

test('administrator access: standing grants on the real migrations', { timeout: 240000, skip: pgSkip() }, async t => {
  const db = await postgresFixture({ port: 57419 });
  t.after(() => db.close());
  const alice = { id: id(1), subject: 'user_alicenew', legacy: 'user_alicelegacy', email: 'alice@example.test' };
  const bob = { id: id(2), subject: 'user_bobnew', legacy: 'user_boblegacy' };
  const R = {
    L1: id(101), L2: id(102), L3: id(103), L4: id(104), I1: id(111), I2: id(112), P1: id(121), H1: id(131), H2: id(132), H3: id(133), H4: id(134),
    W1: id(141), S1: id(151), M1: id(161), MH1: id(171), PR1: id(181), C1: id(191), E1: id(201), CC1: id(211), CC2: id(212), CR1: id(221), CR2: id(222),
    T1: id(231), X1: id(241), BL1: id(251), PH1: id(261), PB1: id(271), ED1: id(281), CM1: id(291),
  };
  const D = {
    lic: id(501), licLegacy: id(502), driver: id(503), travel: id(504), expense: id(505), unfiled: id(506), inbox: id(507), caseFile: id(508),
    healthIns: id(509), custom: id(510), custom2: id(511), foreign: id(512), wrongId: id(513), bobLegacy: id(514), vaccine: id(515), bls: id(516), otherId: id(517),
  };
  const files = new Map();
  const doc = (docId, owner, subject, linked, name, extra = {}) => {
    const path = extra.path ?? `${subject}/${docId}`;
    files.set(path, pdf(name));
    return `(${q(docId)},${q(owner)},${q(name)},'application/pdf',${pdf(name).length},${q(path)},${q(linked)},${q(extra.type ?? 'application/pdf')})`;
  };
  await db.sql(`
    insert into profiles(id,auth_user_id,access_status,name,degree_type,npi,specialties,primary_state,additional_states,verified_email,address,phone,tax_prep,notes)
     values(${q(alice.id)},${q(alice.subject)},'active','Alice Example','DO','1234567890','["Neurosurgery"]','CO','["ND","CA"]',${q(alice.email)},'SECRET-STREET','SECRET-PHONE','{"secret":"SECRET-TAX"}','SECRET-PROFILE-NOTE'),
     (${q(bob.id)},${q(bob.subject)},'active','Bob Example','MD','1234567891',null,'TX',null,'bob@example.test',null,null,null,null);
    insert into clerk_continuity_runs(id,source_issuer,target_issuer,manifest_sha256,observed_at,enabled) values(${q(id(900))},'https://dev.example','https://clerk.example',repeat('a',64),now(),true);
    insert into clerk_continuity_accounts(run_id,profile_id,source_subject,verified_primary_email,source_user_created_ms,lifetime_eligible,source_user_updated_ms,state,target_subject,target_user_updated_ms,bound_at)
     values(${q(id(900))},${q(alice.id)},${q(alice.legacy)},${q(alice.email)},1,true,1,'bound',${q(alice.subject)},1,now());
    insert into licenses(id,user_id,type,name,license_number,state,issued_date,expiration_date,notes,custom_fields,renewal_cost) values
     (${q(R.L1)},${q(alice.id)},'State Medical License (DO)','Colorado medical license','DR.0001','CO','2020-01-01','2027-01-31','SECRET-NOTE-L1','{"Secret":"SECRET-CF"}',500),
     (${q(R.L2)},${q(alice.id)},'Driver License','Colorado driver license','SECRET-DL-NUMBER','CO',null,'2030-01-01',null,'{"Date of Birth":"SECRET-DOB"}',null),
     (${q(R.L3)},${q(alice.id)},'DEA Registration',null,'enc1:SECRET-SEALED','CO',null,'2027-06-30',null,null,null),
     (${q(R.L4)},${q(alice.id)},'Other','SECRET-OTHER-LICENSE',null,null,null,null,null,null,null),
     (${q(R.BL1)},${q(bob.id)},'State Medical License','Texas',null,'TX',null,null,null,null,null);
    insert into insurance(id,user_id,type,provider,policy_number,expiration_date,notes) values
     (${q(R.I1)},${q(alice.id)},'Professional Liability - Claims Made','Synthetic Mutual','POL-1','2027-01-01','SECRET-INS-NOTE'),
     (${q(R.I2)},${q(alice.id)},'Health Insurance (personal)','SECRET-HEALTH-CARRIER','SECRET-MEMBER-ID',null,null);
    insert into privileges(id,user_id,type,name,facility,state,expiration_date,portal_url,login_username,login_secret) values
     (${q(R.P1)},${q(alice.id)},'Surgical Privileges','Neurosurgery','Synthetic General','CO','2027-03-01','https://SECRET-PORTAL.example','SECRET-LOGIN','enc1:SECRET-PASSWORD');
    insert into health_records(id,user_id,category,type,name,date_administered,result,specimen_id,ordered_by,doses,custom_fields,notes) values
     (${q(R.H1)},${q(alice.id)},'Vaccination','Hepatitis B',null,'2020-01-01',null,null,null,'[{"doseNumber":1,"date":"2019-01-01","lotNumber":"LOT1","secret":"SECRET-DOSE"}]','{"RX Number":"SECRET-RX"}',null),
     (${q(R.H2)},${q(alice.id)},'Drug Screen','10-Panel Urine','SECRET-DRUG-SCREEN',null,'Negative',null,null,null,null,null),
     (${q(R.H3)},${q(alice.id)},'Titer / Immunity','Hepatitis C Antibody','SECRET-HCV',null,'Negative',null,null,null,null,null),
     (${q(R.H4)},${q(alice.id)},'TB Test','QuantiFERON-TB Gold',null,'2026-01-01','Negative','SECRET-SPECIMEN','SECRET-ORDERER',null,null,null);
    insert into work_history(id,user_id,type,position,employer,start_date,reason_for_leaving,notes) values
     (${q(R.W1)},${q(alice.id)},'Full-Time Employed','Attending','Synthetic Health','2019-07-01','SECRET-REASON','SECRET-WORK-NOTE');
    insert into screenings(id,user_id,type,agency,requested_by,assignment,result) values
     (${q(R.S1)},${q(alice.id)},'Background Screening Report','Synthetic Screening','SECRET-REQUESTER','SECRET-ASSIGNMENT','Clear');
    insert into professional_memberships(id,user_id,name,organization,role,cost) values (${q(R.M1)},${q(alice.id)},'Member','Synthetic Society','Member',999);
    insert into malpractice_history(id,user_id,date_filed,state,outcome,settlement_amount,facility,notes) values
     (${q(R.MH1)},${q(alice.id)},'2018-01-01','CO','Dismissed','SECRET-SETTLEMENT','Synthetic General','SECRET-MAL-NOTE');
    insert into peer_references(id,user_id,name,relationship,email,notes) values (${q(R.PR1)},${q(alice.id)},'Dr Reference','Colleague','ref@example.test','SECRET-REF-NOTE');
    insert into case_logs(id,user_id,category,title,date,facility,role,cpt_codes,complication,w_rvu,source,notes) values
     (${q(R.C1)},${q(alice.id)},'Cranial: Tumor','SECRET-CASE-TITLE','2026-01-02','Synthetic General','Primary','61510','SECRET-COMPLICATION',30,'SECRET-SOURCE','SECRET-CASE-NOTE');
    insert into professional_photos(id,user_id,name) values (${q(R.PH1)},${q(alice.id)},'Headshot');
    insert into publications(id,user_id,name,citation) values (${q(R.PB1)},${q(alice.id)},'Synthetic paper','Synthetic J 2020');
    insert into education(id,user_id,type,institution) values (${q(R.ED1)},${q(alice.id)},'Doctor of Osteopathic Medicine (DO)','Synthetic College');
    insert into cme(id,user_id,title,category,hours,date,topics,notes) values (${q(R.CM1)},${q(alice.id)},'Synthetic course','AOA Category 1-A',2,'2026-02-01','["Opioids"]','SECRET-CME-NOTE');
    insert into custom_categories(id,user_id,name,fields,archived_at,custom_fields) values
     (${q(R.CC1)},${q(alice.id)},'Hospital badges','[{"key":"badgeColor","label":"Badge color","type":"text"},{"key":"oldField","label":"Old","type":"text","removedAt":"2026-01-01"},{"key":"sealed","label":"Sealed","type":"text"}]',null,'{"s":"SECRET-CAT"}'),
     (${q(R.CC2)},${q(alice.id)},'Other stuff','[]',null,null),
     (${q(id(213))},${q(bob.id)},'Bob category','[]',null,null);
    insert into custom_records(id,user_id,category_id,category_name,name,field_values,custom_fields,notes) values
     (${q(R.CR1)},${q(alice.id)},${q(R.CC1)},'Hospital badges','Main badge','{"badgeColor":"Blue","oldField":"SECRET-REMOVED","sealed":"enc1:SECRET-SEAL"}','{"x":"SECRET-FACT"}','SECRET-CUSTOM-NOTE'),
     (${q(R.CR2)},${q(alice.id)},${q(R.CC2)},'Other stuff','SECRET-OTHER-RECORD',null,null,null);
    insert into travel_docs(id,user_id,type,name) values (${q(R.T1)},${q(alice.id)},'Passport','SECRET-PASSPORT');
    insert into travel_expenses(id,user_id,name) values (${q(R.E1)},${q(alice.id)},'SECRET-RECEIPT');
    insert into documents(id,user_id,name,mime_type,size_bytes,storage_path,linked_to,type) values
     ${doc(D.lic, alice.id, alice.subject, `licenses:${R.L1}`, 'Colorado license.pdf')},
     ${doc(D.licLegacy, alice.id, alice.legacy, `licenses:${R.L3}`, 'DEA certificate.pdf')},
     ${doc(D.driver, alice.id, alice.subject, `licenses:${R.L2}`, 'SECRET driver license.pdf')},
     ${doc(D.travel, alice.id, alice.subject, `travelDocs:${R.T1}`, 'SECRET passport.pdf')},
     ${doc(D.expense, alice.id, alice.subject, `travelExpenses:${R.E1}`, 'SECRET receipt.pdf')},
     ${doc(D.unfiled, alice.id, alice.subject, null, 'SECRET unfiled.pdf')},
     ${doc(D.inbox, alice.id, alice.subject, `licenses:${R.L1}`, 'SECRET inbox.pdf', { type: 'request-attachment-inbox' })},
     ${doc(D.caseFile, alice.id, alice.subject, `caseLogs:${R.C1}`, 'SECRET op note.pdf')},
     ${doc(D.healthIns, alice.id, alice.subject, `insurance:${R.I2}`, 'SECRET health card.pdf')},
     ${doc(D.custom, alice.id, alice.subject, `customRecords:${R.CR1}`, 'Badge.pdf')},
     ${doc(D.custom2, alice.id, alice.subject, `customRecords:${R.CR2}`, 'SECRET other.pdf')},
     ${doc(D.foreign, alice.id, bob.subject, `licenses:${R.L1}`, 'SECRET foreign path.pdf')},
     ${doc(D.wrongId, alice.id, alice.subject, `licenses:${R.L1}`, 'SECRET wrong id.pdf', { path: `${alice.subject}/${D.otherId}` })},
     ${doc(D.bobLegacy, bob.id, bob.legacy, `licenses:${R.BL1}`, 'Bob legacy.pdf')},
     ${doc(D.vaccine, alice.id, alice.subject, `healthRecords:${R.H1}`, 'Vaccine card.pdf')};
  `, 'postgres');

  const row = async query => (await db.rows(query))[0] || null;
  const mails = []; let fileReads = 0, duringRead = null, ownerSetting = alice.id;
  const pending = [];
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const box = createPortalCrypto('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); // Public synthetic fixture, never a runtime secret.
  const store = {
    profile: id => row(`select id,auth_user_id,access_status,deleted_at from profiles where id=${q(id)}`),
    ownerProfile: id => row(`select name,degree_type,verified_email from profiles where id=${q(id)}`),
    storageSubjects: async id => JSON.parse(await db.sql(`select to_json(public.clerk_storage_subjects(${q(id)}))`)),
    ownerReady: (...args) => db.rpc('owner_ready', args),
    limit: (...args) => db.rpc('limit', args),
    creationCapacity: (...args) => db.rpc('creation_capacity', args),
    ownerDocuments: (id, ids) => db.rows(`select * from documents where user_id=${q(id)} and id in (${ids.map(q).join(',')})`),
    ownerRequest: (id, req) => row(`select * from credential_portal_invites where owner_profile_id=${q(id)} and request_id=${q(req)}`),
    ownerGrant: async (o, s, invite) => (await db.rpc('owner_grants', [o, s, invite]))[0] || null,
    ownerGrants: (o, s) => db.rpc('owner_grants', [o, s, null]),
    inviteMailId: async id => (await row(`select id from credential_portal_outbox where invite_id=${q(id)} and kind='invite'`))?.id,
    inviteByToken: (token, email) => row(`select id,otp_version,kind,owner_profile_id from credential_portal_invites where token_digest=${q(token)} and recipient_email=${q(email)}`),
    createInvite: p => db.rpc('create', [p.id, p.owner, p.subject, p.email, p.request, p.fingerprint, p.tokenDigest, p.documents, p.mailId, p.encrypted]),
    createStanding: p => db.rpc('create_standing', [p.id, p.owner, p.subject, p.email, p.request, p.fingerprint, p.tokenDigest, p.purpose, p.days, p.allowDownload, p.scope, p.mailId, p.encrypted]),
    update: p => db.rpc('update', [p.owner, p.subject, p.invite, p.days, p.allowDownload, p.scope]),
    resendLink: p => db.rpc('resend_link', [p.owner, p.subject, p.invite, p.tokenDigest, p.mailId, p.encrypted]),
    preview: p => db.rpc('preview', [p.owner, p.subject, p.scope ?? null, p.invite ?? null]),
    sessionView: (...args) => db.rpc('session_view', args),
    claimOtp: p => db.rpc('claim_otp', [p.tokenDigest, p.email, p.version, p.otpDigest, p.mailId, p.encrypted, p.recipientLimitKey]),
    claimMail: (...args) => db.rpc('claim_mail', args), finishMail: (...args) => db.rpc('finish_mail', args),
    redeem: (...args) => db.rpc('redeem', args), access: (...args) => db.rpc('access', args), record: (...args) => db.rpc('record', args), revoke: (...args) => db.rpc('revoke', args),
    manifest: id => db.rows(`select * from credential_portal_documents where invite_id=${q(id)}`),
  };
  const deps = {
    crypto: box, store, waitUntil: work => pending.push(work), ownerProfiles: () => ownerSetting,
    authenticateOwner: async req => ({ alice: { profileId: alice.id, subject: alice.subject }, bob: { profileId: bob.id, subject: bob.subject } })[req.headers.get('x-owner')] || null,
    readFile: async (path, limit) => { fileReads++; const bytes = files.get(path); if (duringRead) await duringRead(); if (!bytes || bytes.length > limit) throw Error('unavailable'); return bytes.slice(); },
    sendMail: async (payload, key) => { mails.push({ payload: structuredClone(payload), key }); return { state: 'sent', providerId: `synthetic-${mails.length}` }; },
  };
  const handler = createCredentialPortalHandler(deps, CREDENTIAL_PORTAL_POLICY);
  const request = (input, owner, session) => new Request('https://functions.example/credential-portal', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-owner': owner } : {}), ...(session ? { Authorization: `Bearer ${session}` } : {}) }, body: JSON.stringify(input) });
  const call = async (input, owner, session) => { const response = await handler(request(input, owner, session)); return { status: response.status, body: await response.json(), headers: response.headers }; };
  const file = async (action, documentId, session) => { const response = await handler(request({ action, documentId }, null, session)); return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) }; };
  const DEFAULT = ['cme', 'education', 'healthRecords', 'insurance', 'licenses', 'memberships', 'privileges', 'professionalPhotos', 'publications', 'screenings', 'workHistory'];
  const grant = async (overrides = {}, owner = 'alice') => {
    const recipient = overrides.recipientEmail || `admin-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const input = { action: 'create', kind: 'standing', recipientEmail: recipient, purpose: 'Reappointment, Synthetic General', accessDays: 30, allowDownload: true, sections: DEFAULT, customCategories: [], requestId: crypto.randomUUID(), ...overrides };
    const result = await call(input, owner);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    await settle();
    const mail = mails.findLast(m => m.payload.to === recipient && m.payload.text.includes('#invite='));
    return { ...result.body.invite, token: mail.payload.text.match(/#invite=([A-Za-z0-9_-]{43})/)[1], email: recipient, mail, input };
  };
  const requestCode = async g => {
    // Clear the 60-second spacing so each test can ask for a fresh code.
    await db.sql(`update credential_portal_invites set otp_last_sent_at=clock_timestamp()-interval '61 seconds' where id=${q(g.id)}`);
    const before = mails.length;
    assert.equal((await call({ action: 'request-code', inviteToken: g.token, email: g.email })).status, 202);
    await settle();
    return mails.length > before ? mails.at(-1).payload.text.match(/code is (\d{6})/)?.[1] : null;
  };
  const verify = (g, code, token = g.token) => call({ action: 'verify', inviteToken: token, email: g.email, code });
  const visit = async g => { const code = await requestCode(g); assert.ok(code, 'a code was sent'); const v = await verify(g, code); assert.equal(v.status, 200); return v.body.sessionToken; };
  const summary = async session => call({ action: 'summary' }, null, session);
  const docIds = view => view.sections.flatMap(s => s.records.flatMap(r => r.documents.map(d => d.id)));
  const recordIds = view => view.sections.flatMap(s => s.records.map(r => r.id));

  await t.test('the SQL allowlist is exactly the catalog the owner is offered, and never a denied collection', () => {
    const sql = MIGRATION.match(/credential_portal_shareable_sections\(\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/)[1];
    const keys = [...sql.matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]);
    assert.deepEqual([...keys].sort(), [...ADMIN_ACCESS_SECTION_KEYS].sort());
    for (const denied of ADMIN_ACCESS_DENIED) assert.ok(!keys.includes(denied), denied);
  });

  await t.test('status is available only to an allowlisted, active owner', async () => {
    assert.deepEqual((await call({ action: 'status' }, 'alice')).body.available, true);
    const bobStatus = await call({ action: 'status' }, 'bob');
    assert.equal(bobStatus.status, 200); assert.equal(bobStatus.body.available, false);
    assert.equal((await call({ action: 'create', kind: 'standing', recipientEmail: 'x@example.test', purpose: 'X', accessDays: 30, allowDownload: true, sections: ['licenses'], customCategories: [], requestId: crypto.randomUUID() }, 'bob')).status, 403);
    assert.equal((await call({ action: 'status' })).status, 401);
    ownerSetting = '*'; assert.equal((await call({ action: 'status' }, 'bob')).body.available, true);
    ownerSetting = undefined; assert.equal((await call({ action: 'status' }, 'bob')).body.available, true);
    ownerSetting = 'not-a-uuid'; assert.equal((await call({ action: 'status' }, 'alice')).body.available, false);
    ownerSetting = alice.id;
    assert.equal(ownerAllowed(` ${alice.id.toUpperCase()} , ${bob.id}`, alice.id), true);
  });

  let main, mainSession;
  await t.test('the invitation names the physician, the purpose and the end date, replies to the physician, and is sent after the response', async () => {
    main = await grant({ recipientEmail: 'office@example.test' });
    assert.equal(main.kind, 'standing'); assert.equal(main.status, 'active'); assert.equal(main.allowDownload, true);
    const { payload } = main.mail;
    assert.equal(payload.replyTo, alice.email);
    assert.match(payload.text, /^Alice Example, DO has given you view access to their credential file\.\n\nPurpose: Reappointment, Synthetic General\nAccess ends: [A-Z][a-z]+ \d{1,2}, \d{4}\n/);
    assert.match(payload.subject, /Alice Example, DO/);
    assert.ok(!/[\u{2013}\u{2014}]/u.test(payload.text + payload.subject), 'no en or em dashes');
    assert.ok(!payload.text.includes('\\n'));
    const listed = (await call({ action: 'list' }, 'alice')).body.invites.find(i => i.id === main.id);
    assert.equal(listed.deliveryState, 'sent'); assert.equal(listed.purpose, 'Reappointment, Synthetic General');
    assert.ok(Math.abs(Date.parse(listed.expiresAt) - (Date.now() + 30 * 86400000)) < 120000);
    // A name is required: administrators treat an unnamed invitation as phishing.
    await db.sql(`update profiles set name=null where id=${q(alice.id)}`, 'postgres');
    const unnamed = await call({ ...main.input, requestId: crypto.randomUUID(), recipientEmail: 'unnamed@example.test' }, 'alice');
    assert.equal(unnamed.status, 409); assert.equal(unnamed.body.error, 'profile_name_required');
    await db.sql(`update profiles set name='Alice Example' where id=${q(alice.id)}`, 'postgres');
    // Retrying the same request returns the same grant; a changed body is a conflict.
    assert.equal((await call(main.input, 'alice')).status, 200);
    assert.equal((await call({ ...main.input, purpose: 'Changed' }, 'alice')).status, 409);
    const text = standingInvitationEmail({ physician: { name: 'Eric Whitney', degreeType: 'DO' }, purpose: 'Synthetic', accessEndsAt: '2026-10-25T12:00:00Z', allowDownload: false, link: 'https://credentialdomd.com/credential-access/#invite=x', replyTo: null }).text;
    assert.match(text, /^Eric Whitney, DO has given you view access to their credential file\.\n/); assert.match(text, /Downloads are turned off/); assert.ok(text.split('\n').length > 10);
  });

  await t.test('request-code answers before any lookup or mail work, identically for a match and a mismatch', async () => {
    let release; const gate = new Promise(done => { release = done; });
    const original = store.inviteByToken; let lookups = 0;
    store.inviteByToken = async (...args) => { lookups++; await gate; return original(...args); };
    try {
      await db.sql(`update credential_portal_invites set otp_last_sent_at=null where id=${q(main.id)}`);
      const before = mails.length;
      const matched = await call({ action: 'request-code', inviteToken: main.token, email: main.email });
      const mismatched = await call({ action: 'request-code', inviteToken: main.token, email: 'someone-else@example.test' });
      assert.equal(matched.status, 202); assert.deepEqual(matched.body, mismatched.body);
      // Both answered while the lookup is still blocked: no code, no mail yet.
      assert.equal(mails.length, before);
      assert.ok(lookups <= 2);
      release(); await settle();
      assert.equal(lookups, 2);
      assert.match(mails.at(-1).payload.text, /code is \d{6}/); assert.match(mails.at(-1).payload.text, /Alice Example, DO/);
      assert.equal(mails.at(-1).payload.to, main.email);
    } finally { store.inviteByToken = original; }
  });

  await t.test('verify makes the same database calls for a wrong address as for the invited one, and changes nothing', async () => {
    const counts = { lookups: 0, redeems: 0 };
    const lookup = store.inviteByToken, redeem = store.redeem;
    store.inviteByToken = (...args) => { counts.lookups++; return lookup(...args); };
    store.redeem = (...args) => { counts.redeems++; return redeem(...args); };
    try {
      const before = await row(`select otp_attempts,otp_failures_total from credential_portal_invites where id=${q(main.id)}`);
      assert.equal((await call({ action: 'verify', inviteToken: main.token, email: 'not-invited@example.test', code: '123456' })).status, 401);
      assert.deepEqual(counts, { lookups: 1, redeems: 1 });
      ownerSetting = bob.id;
      assert.equal((await call({ action: 'verify', inviteToken: main.token, email: main.email, code: '123456' })).status, 401);
      assert.deepEqual(counts, { lookups: 2, redeems: 2 });
      ownerSetting = alice.id;
      assert.deepEqual(await row(`select otp_attempts,otp_failures_total from credential_portal_invites where id=${q(main.id)}`), before, 'nothing was counted against the grant');
    } finally { store.inviteByToken = lookup; store.redeem = redeem; ownerSetting = alice.id; }
  });

  await t.test('a verified visit shows the header, allowed sections and their files, and nothing else', async () => {
    mainSession = await visit(main);
    const { status, body } = await summary(mainSession);
    assert.equal(status, 200);
    assert.deepEqual(body.physician, { name: 'Alice Example', degreeType: 'DO', npi: '1234567890', specialties: ['Neurosurgery'], primaryState: 'CO', additionalStates: ['ND', 'CA'], email: alice.email });
    assert.deepEqual(body.grant, { purpose: 'Reappointment, Synthetic General', accessEndsAt: body.grant.accessEndsAt, allowDownload: true });
    assert.deepEqual(body.sections.map(s => s.key), ['licenses', 'cme', 'privileges', 'insurance', 'education', 'workHistory', 'healthRecords', 'screenings', 'professionalPhotos', 'publications', 'memberships']);
    assert.deepEqual(new Set(recordIds(body)), new Set([R.L1, R.L3, R.CM1, R.P1, R.I1, R.ED1, R.W1, R.H1, R.H4, R.S1, R.PH1, R.PB1, R.M1]));
    // The legacy-prefix file is served for the bound account; excluded, unfiled, inbox, case and foreign-path files never appear.
    assert.deepEqual(new Set(docIds(body)), new Set([D.lic, D.licLegacy, D.vaccine]));
    const json = JSON.stringify(body);
    assert.ok(!json.includes('SECRET'), json.match(/.{40}SECRET.{40}/)?.[0]);
    assert.ok(!json.includes('enc1:'));
    for (const key of allKeys(body)) assert.ok(!FORBIDDEN_KEYS.includes(key), key);
    // The recipient page accepts exactly what the server sends.
    const parsed = parseStandingView(body);
    assert.equal(parsed.documentCount, 3); assert.equal(parsed.sections.length, body.sections.length);
    const dea = body.sections[0].records.find(r => r.id === R.L3);
    assert.equal(dea.title, 'DEA Registration'); assert.ok(!dea.fields.some(f => f.label === 'Number'));
    const vaccine = body.sections.find(s => s.key === 'healthRecords').records.find(r => r.id === R.H1);
    assert.deepEqual(vaccine.fields.find(f => f.label === 'Doses'), { label: 'Doses', value: 'Dose 1: 2019-01-01, lot LOT1' });
    // The raw SQL payload is also free of excluded columns.
    const raw = await db.rpc('view', [alice.id, { sections: ADMIN_ACCESS_SECTION_KEYS, customCategories: [R.CC1] }]);
    for (const key of allKeys(raw)) assert.ok(!FORBIDDEN_KEYS.includes(key), `raw ${key}`);
    assert.ok(!JSON.stringify(raw).includes('SECRET-SETTLEMENT') && !JSON.stringify(raw).includes('SECRET-CASE-TITLE') && !JSON.stringify(raw).includes('SECRET-REMOVED'));
  });

  await t.test('files in scope open; every excluded file is refused even when its id is requested directly, before any storage read', async () => {
    const legacy = await file('view', D.licLegacy, mainSession);
    assert.equal(legacy.status, 200); assert.deepEqual(legacy.bytes, files.get(`${alice.legacy}/${D.licLegacy}`));
    assert.equal((await file('download', D.lic, mainSession)).status, 200);
    const count = fileReads;
    for (const denied of [D.driver, D.travel, D.expense, D.unfiled, D.inbox, D.caseFile, D.healthIns, D.custom, D.custom2, D.foreign, D.wrongId, D.bobLegacy]) {
      for (const action of ['view', 'download']) assert.equal((await file(action, denied, mainSession)).status, 401, `${action} ${denied}`);
    }
    assert.equal(fileReads, count);
    const audit = await db.rows(`select event,intent,content_digest from credential_portal_audit where invite_id=${q(main.id)} and event='document_response_prepared'`);
    assert.ok(audit.length >= 2 && audit.every(a => /^[a-f0-9]{64}$/.test(a.content_digest)));
  });

  await t.test('scope is live: re-filing to travel, re-typing to a driver license, or deleting the record removes it mid-visit; a new license appears', async () => {
    await db.sql(`update documents set linked_to=${q(`travelDocs:${R.T1}`)} where id=${q(D.lic)}`, 'postgres');
    assert.equal((await file('view', D.lic, mainSession)).status, 401);
    assert.ok(!docIds((await summary(mainSession)).body).includes(D.lic));
    await db.sql(`update documents set linked_to=${q(`licenses:${R.L1}`)} where id=${q(D.lic)}`, 'postgres');
    await db.sql(`update licenses set type='Driver License' where id=${q(R.L1)}`, 'postgres');
    let view = (await summary(mainSession)).body;
    assert.ok(!recordIds(view).includes(R.L1)); assert.ok(!docIds(view).includes(D.lic));
    assert.equal((await file('download', D.lic, mainSession)).status, 401);
    await db.sql(`update licenses set type='State Medical License (DO)' where id=${q(R.L1)}`, 'postgres');
    const blsId = id(301);
    await db.sql(`insert into licenses(id,user_id,type,state,expiration_date) values(${q(blsId)},${q(alice.id)},'BLS Certification',null,'2027-05-01');
      insert into documents(id,user_id,name,mime_type,size_bytes,storage_path,linked_to) values(${q(D.bls)},${q(alice.id)},'BLS card.pdf','application/pdf',10,${q(`${alice.subject}/${D.bls}`)},${q(`licenses:${blsId}`)});`, 'postgres');
    files.set(`${alice.subject}/${D.bls}`, pdf('bls'));
    view = (await summary(mainSession)).body;
    assert.ok(recordIds(view).includes(blsId) && docIds(view).includes(D.bls) && docIds(view).includes(D.lic));
    assert.equal((await file('view', D.bls, mainSession)).status, 200);
    await db.sql(`delete from licenses where id=${q(blsId)}`, 'postgres');
    assert.equal((await file('view', D.bls, mainSession)).status, 401);
  });

  await t.test('the owner preview is exactly what the administrator receives', async () => {
    const fromSession = (await summary(mainSession)).body;
    const preview = await call({ action: 'preview', inviteId: main.id }, 'alice');
    assert.equal(preview.status, 200);
    const { expiresAt, ...administratorView } = fromSession;
    assert.ok(expiresAt);
    assert.deepEqual(preview.body, administratorView);
    const proposed = await call({ action: 'preview', sections: main.input.sections, customCategories: [] }, 'alice');
    const { grant: _grant, ...content } = administratorView;
    assert.deepEqual(proposed.body, content);
    assert.equal((await call({ action: 'preview', inviteId: main.id }, 'bob')).status, 403);
    assert.equal((await call({ action: 'preview', sections: ['travelDocs'] }, 'alice')).status, 400);
  });

  await t.test('downloads off: download is refused with 403 and audited, view still works, and turning it back on needs a new grant', async () => {
    assert.equal((await call({ action: 'update', inviteId: main.id, allowDownload: false }, 'alice')).status, 200);
    assert.equal((await file('download', D.lic, mainSession)).status, 403);
    assert.equal((await file('view', D.lic, mainSession)).status, 200);
    const offView = parseStandingView((await summary(mainSession)).body);
    assert.equal(offView.grant.allowDownload, false);
    assert.ok(offView.sections.flatMap(s => s.records.flatMap(r => r.documents)).every(d => !documentActions(d, offView.grant.allowDownload).includes('download')));
    const events = (await call({ action: 'list' }, 'alice')).body.invites.find(i => i.id === main.id).audit;
    assert.ok(events.some(e => e.event === 'download_refused' && e.documentName === 'Colorado license.pdf'));
    assert.ok(events.some(e => e.event === 'document_response_prepared' && e.documentName === 'Colorado license.pdf'));
    const widen = await call({ action: 'update', inviteId: main.id, allowDownload: true }, 'alice');
    assert.equal(widen.status, 409); assert.equal(widen.body.error, 'widening_requires_new_grant');
  });

  await t.test('narrowing removes a section at once; adding one back or an opt-in section needs a new grant; the end date moves within 180 days', async () => {
    assert.equal((await call({ action: 'update', inviteId: main.id, sections: DEFAULT.filter(k => k !== 'licenses') }, 'alice')).status, 200);
    const view = (await summary(mainSession)).body;
    assert.ok(!view.sections.some(s => s.key === 'licenses')); assert.equal((await file('view', D.lic, mainSession)).status, 401);
    assert.equal((await call({ action: 'update', inviteId: main.id, sections: DEFAULT }, 'alice')).status, 409);
    assert.equal((await call({ action: 'update', inviteId: main.id, sections: [...DEFAULT, 'malpracticeHistory'] }, 'alice')).status, 409);
    assert.equal((await call({ action: 'update', inviteId: main.id, accessDays: 45 }, 'alice')).status, 400);
    const extended = await call({ action: 'update', inviteId: main.id, accessDays: 180 }, 'alice');
    assert.equal(extended.status, 200);
    assert.ok(Math.abs(Date.parse(extended.body.invite.expiresAt) - (Date.now() + 180 * 86400000)) < 120000);
    await assert.rejects(db.sql(`update credential_portal_invites set expires_at=expires_at+interval '2 days' where id=${q(main.id)}`, 'postgres'), /standing_check/);
    assert.equal((await call({ action: 'update', inviteId: main.id, accessDays: 30 }, 'alice')).status, 200);
  });

  await t.test('custom categories appear only when named on the grant, with live field labels and no removed, sealed or free-text values', async () => {
    const g = await grant({ sections: [], customCategories: [R.CC1] });
    const session = await visit(g);
    const view = (await summary(session)).body;
    assert.deepEqual(view.sections.map(s => [s.key, s.label]), [[`custom:${R.CC1}`, 'Hospital badges']]);
    assert.deepEqual(view.sections[0].records[0].fields, [{ label: 'Badge color', value: 'Blue' }]);
    assert.deepEqual(docIds(view), [D.custom]);
    assert.ok(!JSON.stringify(view).includes('SECRET'));
    assert.equal((await file('view', D.custom, session)).status, 200);
    assert.equal((await file('view', D.custom2, session)).status, 401);
    await db.sql(`update custom_categories set archived_at=now() where id=${q(R.CC1)}`, 'postgres');
    assert.equal((await summary(session)).body.sections.length, 0);
    assert.equal((await file('view', D.custom, session)).status, 401);
    await db.sql(`update custom_categories set archived_at=null where id=${q(R.CC1)}`, 'postgres');
    // Another owner's category, an archived one or a made-up id is refused at creation.
    const foreign = await call({ ...g.input, requestId: crypto.randomUUID(), recipientEmail: 'foreign@example.test', customCategories: [id(213)] }, 'alice');
    assert.ok(foreign.status >= 400);
    assert.equal((await call({ ...g.input, requestId: crypto.randomUUID(), sections: ['travelDocs'] }, 'alice')).status, 400);
  });

  await t.test('opt-in sections show summary columns only; case files are never served; settlement amounts never appear', async () => {
    const g = await grant({ sections: ['malpracticeHistory', 'peerReferences', 'caseLogs'] });
    const session = await visit(g);
    const view = (await summary(session)).body;
    assert.deepEqual(view.sections.map(s => s.key), ['malpracticeHistory', 'peerReferences', 'caseLogs']);
    const caseRecord = view.sections[2].records[0];
    assert.equal(caseRecord.title, 'Cranial: Tumor');
    assert.deepEqual(caseRecord.fields.map(f => f.label), ['Date', 'Facility', 'Role', 'CPT codes']);
    assert.ok(!JSON.stringify(view).includes('SECRET'));
    assert.equal((await file('view', D.caseFile, session)).status, 401);
  });

  await t.test('every visit gets a fresh code and its own session until the end date; a new visit replaces the last; then 401', async () => {
    const g = await grant({ sections: ['licenses'] });
    const first = await visit(g);
    assert.equal((await summary(first)).status, 200);
    const second = await visit(g);
    assert.equal((await summary(second)).status, 200);
    assert.equal((await summary(first)).status, 401);
    const stored = await row(`select redeemed_at,last_verified_at from credential_portal_invites where id=${q(g.id)}`);
    assert.equal(stored.redeemed_at, null); assert.ok(stored.last_verified_at);
    const session = await row(`select expires_at from credential_portal_sessions where invite_id=${q(g.id)}`);
    assert.ok(Date.parse(session.expires_at) - Date.now() <= 60 * 60000 + 5000 && Date.parse(session.expires_at) - Date.now() > 59 * 60000);
    await db.sql(`update credential_portal_invites set expires_at=clock_timestamp()-interval '1 second' where id=${q(g.id)}`, 'postgres');
    assert.equal((await summary(second)).status, 401);
    assert.equal(await requestCode(g), null);
    assert.equal((await call({ action: 'list' }, 'alice')).body.invites.find(i => i.id === g.id).status, 'expired');
  });

  await t.test('code limits: five wrong guesses per code, fifteen in total locks the grant, ten codes per day', async () => {
    const g = await grant({ sections: ['licenses'] });
    let code = await requestCode(g); const wrong = c => c === '999999' ? '000000' : '999999';
    for (let i = 0; i < 5; i++) assert.equal((await verify(g, wrong(code))).status, 401);
    assert.equal((await verify(g, code)).status, 401, 'the sixth try on one code fails even when right');
    code = await requestCode(g);
    assert.equal((await verify(g, code)).status, 200, 'a new code has its own five tries');
    for (let round = 0; round < 2; round++) {
      code = await requestCode(g); assert.ok(code);
      for (let i = 0; i < 5; i++) await verify(g, wrong(code));
    }
    const locked = await row(`select otp_failures_total from credential_portal_invites where id=${q(g.id)}`);
    assert.equal(locked.otp_failures_total, 15);
    assert.equal(await requestCode(g), null, 'a locked grant sends no more codes');
    assert.equal((await call({ action: 'list' }, 'alice')).body.invites.find(i => i.id === g.id).status, 'locked');
    // The owner's new link unlocks it and kills the old one.
    const resent = await call({ action: 'resend-link', inviteId: g.id }, 'alice');
    assert.equal(resent.status, 200); await settle();
    const fresh = { ...g, token: mails.findLast(m => m.payload.to === g.email && m.payload.text.includes('#invite=')).payload.text.match(/#invite=([A-Za-z0-9_-]{43})/)[1] };
    assert.notEqual(fresh.token, g.token);
    assert.ok(await visit(fresh));
    // Daily cap: the tenth code of the day goes out, the eleventh does not.
    await db.sql(`delete from credential_portal_limits where scope='recipient_otp'`);
    await db.sql(`update credential_portal_limits set used=9 where scope='grant_otp_day' and key=${q(g.id)}`);
    assert.ok(await requestCode(fresh));
    assert.equal(await requestCode(fresh), null);
  });

  await t.test('resend-link: the old link and its open visit stop; the new link works and names the physician', async () => {
    const g = await grant({ sections: ['licenses'] });
    const session = await visit(g);
    assert.equal((await call({ action: 'resend-link', inviteId: g.id }, 'alice')).status, 200); await settle();
    const mail = mails.findLast(m => m.payload.to === g.email && m.payload.text.includes('#invite='));
    const newToken = mail.payload.text.match(/#invite=([A-Za-z0-9_-]{43})/)[1];
    assert.match(mail.payload.text, /^Alice Example, DO has given you view access/);
    assert.equal((await summary(session)).status, 401);
    assert.equal(await requestCode(g), null, 'the old link sends nothing');
    assert.ok(await visit({ ...g, token: newToken }));
    const events = (await call({ action: 'list' }, 'alice')).body.invites.find(i => i.id === g.id).audit.map(e => e.event);
    assert.ok(events.includes('link_resent'));
    assert.equal((await call({ action: 'resend-link', inviteId: g.id }, 'bob')).status, 403);
  });

  await t.test('revocation during a file read fails closed and stops everything after', async () => {
    const g = await grant({ sections: ['licenses'] });
    const session = await visit(g);
    duringRead = async () => { assert.equal((await call({ action: 'revoke', inviteId: g.id }, 'alice')).status, 200); };
    assert.equal((await file('download', D.lic, session)).status, 401); duringRead = null;
    assert.equal((await summary(session)).status, 401);
    assert.equal(await requestCode(g), null);
    assert.equal((await call({ action: 'update', inviteId: g.id, accessDays: 14 }, 'alice')).status, 409);
  });

  await t.test('a closed account stops access at once and prune removes its grants; an owner outside the allowlist stops too', async () => {
    const g = await grant({ sections: ['licenses'] });
    const session = await visit(g);
    ownerSetting = bob.id;
    assert.equal((await summary(session)).status, 401);
    assert.equal((await file('view', D.lic, session)).status, 401);
    assert.equal(await requestCode(g), null);
    assert.equal((await call({ action: 'list' }, 'alice')).status, 200, 'the owner can still review');
    ownerSetting = alice.id;
    assert.equal((await summary(session)).status, 200);
    await db.sql(`insert into account_tombstones(profile_id) values(${q(alice.id)})`, 'postgres');
    assert.equal((await summary(session)).status, 401);
    assert.equal(await requestCode(g), null);
    assert.equal((await call({ action: 'status' }, 'alice')).body.available, false);
    assert.equal((await call({ ...g.input, requestId: crypto.randomUUID() }, 'alice')).status, 403);
    await db.sql(`delete from account_tombstones where profile_id=${q(alice.id)}`, 'postgres');
    await db.sql(`update profiles set deleted_at=now() where id=${q(alice.id)}`, 'postgres');
    assert.equal((await summary(session)).status, 401);
    assert.equal((await call({ action: 'status' }, 'alice')).body.available, false);
    await db.rpc('prune', []);
    assert.equal((await db.rows(`select id from credential_portal_invites where owner_profile_id=${q(alice.id)}`)).length, 0, 'closed-account grants are purged');
    assert.equal((await db.rows(`select * from credential_portal_audit a where not exists(select 1 from credential_portal_invites i where i.id=a.invite_id)`)).length, 0);
    await db.sql(`update profiles set deleted_at=null where id=${q(alice.id)}`, 'postgres');
  });

  await t.test('prune clears expired mail payloads and the migration re-applies over live grants', async () => {
    const g = await grant({ sections: ['licenses'] });
    await db.sql(`update credential_portal_outbox set state='unknown',encrypted_payload='v1.x.y',expires_at=clock_timestamp()-interval '1 second' where invite_id=${q(g.id)} and kind='invite'`);
    await db.rpc('prune', []);
    assert.equal((await row(`select encrypted_payload from credential_portal_outbox where invite_id=${q(g.id)} and kind='invite'`)).encrypted_payload, null);
    await db.sql(MIGRATION, 'postgres');
    const session = await visit(g);
    assert.equal((await summary(session)).status, 200);
    assert.equal((await db.rows(`select 1 from credential_portal_outbox where expires_at > created_at + interval '61 minutes' and invite_id=${q(g.id)}`)).length, 0, 'outbox payloads live at most an hour');
  });

  await t.test('anonymous and signed-in database roles cannot call the new functions or read grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(db.rpc('view', [alice.id, { sections: ['licenses'] }], role));
      await assert.rejects(db.rpc('owner_grants', [alice.id, alice.subject, null], role));
      await assert.rejects(db.rpc('session_view', ['x', 'summary_listed'], role));
      await assert.rejects(db.rpc('update', [alice.id, alice.subject, main.id, 180, null, null], role));
      await assert.rejects(db.sql('select scope from credential_portal_invites', role));
    }
  });

  await t.test('deleting a grant row removes its sessions, outbox and audit (the delete-account purge relies on this)', async () => {
    const g = await grant({ sections: ['licenses'] });
    await visit(g);
    await db.sql(`delete from credential_portal_invites where owner_profile_id=${q(alice.id)}`, 'postgres');
    for (const table of ['credential_portal_sessions', 'credential_portal_outbox', 'credential_portal_audit']) {
      assert.equal((await db.rows(`select 1 from ${table} where invite_id=${q(g.id)}`)).length, 0, table);
    }
  });

  await t.test('a standing grant never lists or serves a legacy-prefix file for an account with no bound legacy subject', async () => {
    ownerSetting = `${alice.id},${bob.id}`;
    try {
      const g = await grant({ sections: ['licenses'] }, 'bob');
      const session = await visit(g);
      const view = (await summary(session)).body;
      assert.deepEqual(recordIds(view), [R.BL1]);
      assert.deepEqual(docIds(view), []);
      assert.equal((await file('view', D.bobLegacy, session)).status, 401);
    } finally { ownerSetting = alice.id; }
  });

  await t.test('selection invitations also accept a bound legacy subject and refuse an unbound one', async () => {
    const created = await call({ action: 'create', recipientEmail: 'legacy@example.test', documentIds: [D.licLegacy], requestId: crypto.randomUUID() }, 'alice');
    assert.equal(created.status, 201);
    const refused = await call({ action: 'create', recipientEmail: 'legacy@example.test', documentIds: [D.bobLegacy], requestId: crypto.randomUUID() }, 'bob');
    assert.equal(refused.status, 409);
    const sqlOwned = await db.sql(`select public.credential_portal_owned_path(${q(bob.id)}, ${q(`${bob.legacy}/${D.bobLegacy}`)}, ${q(D.bobLegacy)})`);
    assert.equal(sqlOwned, 'f');
    assert.equal(await db.sql(`select public.credential_portal_owned_path(${q(alice.id)}, ${q(`${alice.legacy}/${D.licLegacy}`)}, ${q(D.licLegacy)})`), 't');
    assert.ok(await digest('x'));
  });
});
