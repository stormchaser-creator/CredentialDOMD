// Free renewal reminders asked for on a state guide page (migration
// 20261119120000, send-guide-reminders, the form in landing/state-template).
//
// What must hold:
//   * the signup is bounded: bad input refused, a honeypot hit stored nowhere,
//     12 states per address, a second ask updates the same row;
//   * nothing is claimed while the owner has not turned sending on;
//   * the stage is the tightest of 90, 30 and 7 days, each sent once, and a row
//     is never mailed twice inside 6 days whatever is posted to it;
//   * the unsubscribe link stops every reminder to that address, and asking
//     again for a state lifts it for that state only;
//   * the product line goes only to a reader who ticked the box, and only
//     with a real postal address; the plain reminder needs neither;
//   * the page asks for product news with a separate, unticked box.
//
// Disposable PostgreSQL on a Unix socket, synthetic addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pgSkip, withSlotWait } from './credential-portal/postgresFixture.mjs';
import { startPostgres } from './ops/pg.mjs';
import { buildGuideReminderEmail, guideReminderKey, longDate, MAILING_ADDRESS_PLACEHOLDER } from '../supabase/functions/_shared/guideReminderEmail.mjs';
import { GUIDE_REMINDERS, OPT_OUT_LISTS, mintUnsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl, createEmailUnsubscribeHandler } from '../supabase/functions/_shared/emailUnsubscribe.mjs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const MIGRATION_PATH = 'supabase/migrations/20261119120000_guide_renewal_reminders.sql';
const ROLLBACK_PATH = 'docs/rollback/20261119120000_guide_renewal_reminders.rollback.sql';
const PROFESSIONS_PATH = 'supabase/migrations/20261119180000_guide_reminder_professions.sql';
const PROFESSIONS_ROLLBACK_PATH = 'docs/rollback/20261119180000_guide_reminder_professions.rollback.sql';
const PROFESSION_GUIDES = JSON.parse(read('supabase/functions/send-guide-reminders/professionGuides.json'));
const GUIDES = JSON.parse(read('supabase/functions/send-guide/stateGuides.json'));
const SECRET = 'test-secret-test-secret-test-secret-0123';
const ID = '11111111-2222-4333-8444-555555555555';

test('the migration and its rollback follow the deploy rules, and sending starts off', () => {
  for (const rel of [MIGRATION_PATH, ROLLBACK_PATH]) assert.doesNotMatch(read(rel), /^\s*(begin|commit|rollback)\s*;/im, `${rel} has a top-level transaction statement`);
  const sql = read(MIGRATION_PATH);
  assert.match(sql, /enabled\s+boolean not null default false/);
  assert.doesNotMatch(sql, /^\s*update public\.guide_reminder_settings set enabled = true/m, 'the migration must not turn sending on');
  assert.match(sql, /grant execute on function public\.guide_reminder_signup\(text, text, date, boolean, text, text\) to anon, service_role/);
  assert.match(read(ROLLBACK_PATH), /LEFT IN PLACE/);
});

test('every state the signup accepts has a guide to mail, and the reverse', () => {
  const list = /v_state <> all \(array\[([^\]]+)\]/.exec(read(MIGRATION_PATH))[1].match(/[A-Z]{2}/g).sort();
  assert.deepEqual(list, Object.keys(GUIDES).sort());
  assert.equal(list.length, 51);
});

test('the reminder email: plain by default, product line only with consent and a postal address', () => {
  const base = { to: 'reader@example.invalid', stage: 30, renewalDate: '2027-04-30', guide: GUIDES.CO, unsubscribeUrl: 'https://credentialdomd.com/api/unsubscribe?t=abc' };
  const plain = buildGuideReminderEmail(base);
  assert.equal(plain.subject, 'Your Colorado license renews April 30, 2027');
  assert.match(plain.text, /renews on April 30, 2027, which is within the next month\./);
  assert.match(plain.text, /https:\/\/credentialdomd\.com\/states\/colorado/);
  assert.match(plain.text, /Stop these reminders: https:\/\/credentialdomd\.com\/api\/unsubscribe\?t=abc/);
  assert.doesNotMatch(plain.text, /You also asked to hear/);
  assert.doesNotMatch(plain.html, /You also asked to hear/);

  // Ticked the box, but no postal address is set: still the plain reminder.
  for (const mailingAddress of [undefined, '', MAILING_ADDRESS_PLACEHOLDER, '[address]']) {
    const m = buildGuideReminderEmail({ ...base, productUpdates: true, mailingAddress });
    assert.doesNotMatch(m.text, /You also asked to hear/);
    assert.doesNotMatch(m.text, /\[/);
  }
  // A postal address but no consent: the address may show, the product line may not.
  assert.doesNotMatch(buildGuideReminderEmail({ ...base, mailingAddress: '1 Example Way, Springfield, CA 90000' }).text, /You also asked to hear/);

  const promo = buildGuideReminderEmail({ ...base, productUpdates: true, mailingAddress: '1 Example Way, Springfield, CA 90000' });
  assert.match(promo.text, /You also asked to hear about CredentialDOMD/);
  assert.match(promo.text, /CredentialDOMD, 1 Example Way, Springfield, CA 90000/);
  assert.match(promo.html, /You also asked to hear about CredentialDOMD/);

  // Owner rules for anything sent: no dashes, no compliance or price claims.
  for (const m of [plain, promo]) {
    assert.doesNotMatch(m.text.replace(/https?:\/\/\S+/g, ''), /[–—]/);
    assert.doesNotMatch(m.text, /HIPAA|SOC 2|\$\d/);
  }
  // The same claim retried on a later day is the same bytes.
  assert.deepEqual(buildGuideReminderEmail(base), plain);
  assert.equal(guideReminderKey({ id: ID, renewalDate: '2027-04-30', stage: 30 }), `guide-reminder/${ID}/2027-04-30/30`);
});

test('the reminder email refuses a half configured send', () => {
  const ok = { to: 'reader@example.invalid', stage: 7, renewalDate: '2027-01-31', guide: GUIDES.TX, unsubscribeUrl: 'https://credentialdomd.com/api/unsubscribe?t=abc' };
  assert.throws(() => buildGuideReminderEmail({ ...ok, unsubscribeUrl: '[UNSUBSCRIBE LINK]' }), /unsubscribe/);
  assert.throws(() => buildGuideReminderEmail({ ...ok, unsubscribeUrl: undefined }), /unsubscribe/);
  assert.throws(() => buildGuideReminderEmail({ ...ok, guide: undefined }), /state guide/);
  assert.throws(() => buildGuideReminderEmail({ ...ok, stage: 14 }), /stage/);
  assert.throws(() => buildGuideReminderEmail({ ...ok, renewalDate: '2027-02-30' }), /renewal date/);
  assert.equal(longDate('2028-02-29'), 'February 29, 2028');
  assert.equal(longDate('2027-02-29'), null);
  // Every state builds, at every stage.
  for (const abbr of Object.keys(GUIDES)) for (const stage of [90, 30, 7]) buildGuideReminderEmail({ ...ok, stage, guide: GUIDES[abbr] });
});

test('the unsubscribe link for a reminder row is its own list and cannot be swapped for another', async () => {
  assert.equal(OPT_OUT_LISTS[GUIDE_REMINDERS].code, 'gr');
  const token = await mintUnsubscribeToken({ profileId: ID, list: GUIDE_REMINDERS, secret: SECRET });
  assert.deepEqual(await verifyUnsubscribeToken(token, [SECRET]), { profileId: ID, list: GUIDE_REMINDERS });
  // The same id on the account list is a different token, and neither passes as the other.
  const account = await mintUnsubscribeToken({ profileId: ID, secret: SECRET });
  assert.notEqual(token, account);
  assert.equal(await verifyUnsubscribeToken(token.replace('.gr.', '.sr.'), [SECRET]), null);
  assert.equal(await verifyUnsubscribeToken(account.replace('.sr.', '.gr.'), [SECRET]), null);

  const recorded = [];
  const handle = createEmailUnsubscribeHandler({ secrets: () => [SECRET], store: { record: async (id, list, source) => { recorded.push([id, list, source]); return true; } }, log: { error() {} } });
  const url = await unsubscribeUrl({ profileId: ID, list: GUIDE_REMINDERS, secret: SECRET });
  const page = await handle(new Request(url));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Stop the license renewal reminders\?/);
  assert.deepEqual(recorded, [], 'a GET records nothing');
  const oneClick = await handle(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }));
  assert.equal(oneClick.status, 200);
  assert.deepEqual(recorded, [[ID, GUIDE_REMINDERS, 'one_click']]);
});

test('the unsubscribe function sends a reminder opt out to its own table', () => {
  const fn = read('supabase/functions/email-unsubscribe/index.ts');
  assert.match(fn, /if \(list === GUIDE_REMINDERS\) \{[\s\S]*?rpc\('guide_reminder_unsubscribe', \{ p_id: profileId, p_source: source \}\)/);
});

test('the sender fails closed and never puts an address in its answer', () => {
  const fn = read('supabase/functions/send-guide-reminders/index.ts');
  assert.match(fn, /if \(!HOOK \|\| req\.headers\.get\("x-hook-secret"\) !== HOOK\) return json\(401/);
  assert.ok(fn.indexOf('if (!configured) return json(503') < fn.indexOf('db.rpc("guide_reminder_claim"'), 'configuration is checked before anything is claimed');
  assert.match(fn, /secret\.length >= 32/);
  assert.match(fn, /return json\(200, \{ claimed: rows\.length, sent, failed, refused, deferred \}\)/);
  assert.match(fn, /"Idempotency-Key": guideReminderKey\(/);
  assert.match(fn, /headers: listUnsubscribeHeaders\(url\)/);
});

test('every state guide carries the reminder form with a separate, unticked product news box', () => {
  const template = read('landing/state-template.html');
  const dir = new URL('../landing/states/', import.meta.url);
  const pages = fs.readdirSync(dir).filter(f => f.endsWith('.html') && f !== 'index.html');
  assert.equal(pages.length, 51);
  for (const f of pages) {
    const html = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.equal((html.match(/<form class="reminder-form"/g) || []).length, 1, `${f}: one reminder form`);
    const box = /<input type="checkbox" name="updates"[^>]*>/.exec(html);
    assert.ok(box, `${f}: product news box`);
    assert.doesNotMatch(box[0], /checked/, `${f}: the box starts unticked`);
    const abbr = /p_state: ABBR/.test(html) && /rpc\/guide_reminder_signup/.test(html) && (html.match(/var ABBR = '([A-Z]{2})'/g) || []);
    assert.ok(abbr && abbr.length === 2 && abbr[0] === abbr[1], `${f}: the form posts this page's state`);
    assert.ok(GUIDES[/var ABBR = '([A-Z]{2})'/.exec(html)[1]], `${f}: a state the sender knows`);
  }
  // The existing guide forms are untouched: four per page, as before.
  assert.equal((template.match(/<form class="guide-form"/g) || []).length, 4);
  // Public copy rule: no dashes in what the reader sees in this block.
  const block = /<div class="guide-capture" id="renewal-reminder">[\s\S]*?<\/div>/.exec(template)[0].replace(/<[^>]+>/g, ' ').replace(/you@hospital\.org/g, '');
  assert.doesNotMatch(block, /[-–—]/, 'no hyphens or dashes in the reminder copy');
});

const BASE = `
  create role anon; create role authenticated; create role service_role;
`;
const sqlText = v => v === null ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
const signup = (pg, email, state, date, updates = false, flags = null) =>
  pg.sql(`select public.guide_reminder_signup(${sqlText(email)}, ${sqlText(state)}, ${date === null ? 'null' : `(${date})::date`}, ${updates}, '/states/x', ${sqlText(flags)})`);
const signupStatus = async (pg, email, state, date) => Number(await pg.sql(`with r as materialized (
    select public.guide_reminder_signup(${sqlText(email)}, ${sqlText(state)}, (${date})::date, false, '/states/x', null) id)
  select coalesce(nullif(current_setting('response.status', true), ''), '200') from r`));
const claim = async pg => JSON.parse(await pg.sql(`select public.guide_reminder_claim(50)`));
const finish = (pg, row, outcome) => pg.sql(`select public.guide_reminder_finish('${row.id}', '${row.token}', '${outcome}')`);
const rowsOf = (pg, email) => pg.rows(`select state, renewal_date::text, product_updates, last_stage, attempts, unsubscribed_at is not null as stopped, last_sent_at is not null as mailed from public.guide_renewal_reminders where lower(email) = lower(${sqlText(email)}) order by state`);

test('signup bounds, claim stages, the 6 day bound and unsubscribe', { skip: pgSkip(), timeout: withSlotWait(180000) }, async t => {
  const pg = await startPostgres(57219, 'guide-reminders');
  t.after(() => pg.close());
  await pg.sql(BASE);
  await pg.sql(read(MIGRATION_PATH));

  // ── Grants: anon may sign up and nothing else; the tables are closed.
  for (const fn of ['guide_reminder_claim(50)', `guide_reminder_finish('${ID}', '${ID}', 'sent')`, `guide_reminder_unsubscribe('${ID}', 'page')`, 'dispatch_guide_reminders()']) {
    assert.equal((await pg.tryRun(`set role anon; select public.${fn}`)).ok, false, `anon must not run ${fn}`);
  }
  assert.equal((await pg.tryRun(`set role anon; select count(*) from public.guide_renewal_reminders`)).ok, false);
  assert.equal((await pg.tryRun(`set role authenticated; select count(*) from public.guide_renewal_reminders`)).ok, false);
  assert.equal((await pg.tryRun(`set role service_role; insert into public.guide_renewal_reminders (email, state, renewal_date) values ('x@example.invalid', 'TX', current_date)`)).ok, false);
  assert.ok((await pg.tryRun(`set role anon; select public.guide_reminder_signup('anon@example.invalid', 'tx', current_date + 200, false, '/states/texas', null)`)).ok);

  // ── Bad input.
  for (const [email, state, date] of [
    ['not-an-address', 'TX', 'current_date + 100'], [null, 'TX', 'current_date + 100'],
    ['a@example.invalid', 'ZZ', 'current_date + 100'], ['a@example.invalid', null, 'current_date + 100'], ['a@example.invalid', 'Texas', 'current_date + 100'],
    ['a@example.invalid', 'TX', 'current_date - 1'], ['a@example.invalid', 'TX', `current_date + interval '6 years 1 day'`], ['a@example.invalid', 'TX', null],
  ]) {
    assert.equal((await pg.tryRun(`select public.guide_reminder_signup(${sqlText(email)}, ${sqlText(state)}, ${date === null ? 'null' : `(${date})::date`}, false, null, null)`)).ok, false, `${email} ${state} ${date}`);
  }
  // ── A filled honeypot answers and stores nothing.
  assert.match(await signup(pg, 'bot@example.invalid', 'TX', 'current_date + 100', true, 'honeypot,fast-submit'), /^[0-9a-f-]{36}$/);
  assert.deepEqual(await rowsOf(pg, 'bot@example.invalid'), []);

  // ── One row per address and state; asking again takes the new date and answer.
  const first = await signup(pg, 'Reader@Example.invalid', 'co', 'current_date + 200', true);
  const again = await signup(pg, 'reader@example.invalid', 'CO', 'current_date + 100', false);
  assert.equal(first, again);
  const [co] = await rowsOf(pg, 'reader@example.invalid');
  assert.equal(co.state, 'CO'); assert.equal(co.product_updates, false);

  // ── Nothing is claimed while sending is off, whatever is due.
  await signup(pg, 'due@example.invalid', 'TX', 'current_date + 20');
  assert.deepEqual(await claim(pg), []);
  assert.equal((await pg.tryRun(`select public.dispatch_guide_reminders()`)).ok, true, 'the dispatcher returns quietly while off');
  await pg.sql(`update public.guide_reminder_settings set enabled = true`);

  // ── Stages. 100 days out: nothing. 20 days out: the 30 day reminder, once.
  let got = await claim(pg);
  assert.deepEqual(got.map(r => [r.email, r.state, r.stage]), [['due@example.invalid', 'TX', 30]]);
  assert.deepEqual(await claim(pg), [], 'a claimed row is not handed out twice');
  assert.equal(await finish(pg, { ...got[0], token: ID }, 'sent'), 'f', 'a wrong token finishes nothing');
  assert.equal(await finish(pg, got[0], 'sent'), 't');
  assert.deepEqual(await claim(pg), [], 'the 30 day reminder is sent once');
  // Six days later it is 14 days out: still inside the 30 day stage, nothing new.
  await pg.sql(`update public.guide_renewal_reminders set last_sent_at = now() - interval '7 days', renewal_date = current_date + 14 where email = 'due@example.invalid'`);
  assert.deepEqual(await claim(pg), []);
  // Inside the last week: the 7 day reminder, once, and then nothing more.
  await pg.sql(`update public.guide_renewal_reminders set renewal_date = current_date + 5 where email = 'due@example.invalid'`);
  got = await claim(pg);
  assert.deepEqual(got.map(r => r.stage), [7]);
  assert.equal(await finish(pg, got[0], 'sent'), 't');
  await pg.sql(`update public.guide_renewal_reminders set last_sent_at = now() - interval '7 days' where email = 'due@example.invalid'`);
  assert.deepEqual(await claim(pg), []);
  // A date that has passed is never mailed.
  await pg.sql(`insert into public.guide_renewal_reminders (email, state, renewal_date) values ('past@example.invalid', 'NY', current_date - 1)`);
  assert.deepEqual(await claim(pg), []);

  // ── The 90 day stage, then a retry, then a refusal.
  await signup(pg, 'ninety@example.invalid', 'NY', 'current_date + 90');
  got = await claim(pg);
  assert.deepEqual(got.map(r => [r.state, r.stage]), [['NY', 90]]);
  assert.equal(await finish(pg, got[0], 'retry'), 't');
  const retry = await claim(pg);
  assert.deepEqual(retry.map(r => [r.id, r.stage]), [[got[0].id, 90]], 'a retry is the same row and stage, so the same idempotency key');
  assert.equal(await finish(pg, retry[0], 'refused'), 't');
  assert.deepEqual(await claim(pg), [], 'a refused address is parked for that stage');
  assert.equal((await rowsOf(pg, 'ninety@example.invalid'))[0].attempts, 5);
  // Five unconfirmed attempts park the stage too.
  await signup(pg, 'flaky@example.invalid', 'NY', 'current_date + 60');
  for (let i = 0; i < 5; i++) { got = await claim(pg); assert.equal(got.length, 1, `attempt ${i + 1}`); await finish(pg, got[0], 'retry'); }
  assert.deepEqual(await claim(pg), []);
  // An expired claim (the function died mid send) is handed out again.
  await signup(pg, 'lost@example.invalid', 'NY', 'current_date + 60');
  got = await claim(pg);
  await pg.sql(`update public.guide_renewal_reminders set claim_until = now() - interval '1 minute' where email = 'lost@example.invalid'`);
  const second = await claim(pg);
  assert.deepEqual(second.map(r => r.id), [got[0].id]);
  assert.equal(await finish(pg, got[0], 'sent'), 'f', 'the stale claim cannot finish');
  assert.equal(await finish(pg, second[0], 'sent'), 't');

  // ── The 6 day bound: re-posting a new date cannot mail the same row again.
  await signup(pg, 'victim@example.invalid', 'TX', 'current_date + 3');
  got = await claim(pg);
  assert.equal(await finish(pg, got[0], 'sent'), 't');
  for (const days of [4, 5, 6, 25, 80]) {
    await signup(pg, 'victim@example.invalid', 'TX', `current_date + ${days}`);
    assert.deepEqual(await claim(pg), [], `no second reminder inside 6 days (${days})`);
  }
  // ── At most 2 rows for one address in a sweep, and 12 states per address.
  const states = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI'];
  for (const s of states) assert.equal(await signupStatus(pg, 'many@example.invalid', s, 'current_date + 3'), 200);
  assert.equal(await signupStatus(pg, 'many@example.invalid', 'ID', 'current_date + 3'), 403);
  assert.equal(await signupStatus(pg, 'many@example.invalid', 'AL', 'current_date + 4'), 200, 'an existing state can still be updated at the cap');
  assert.equal((await rowsOf(pg, 'many@example.invalid')).length, 12);
  got = await claim(pg);
  assert.equal(got.filter(r => r.email === 'many@example.invalid').length, 2);
  for (const r of got) await finish(pg, r, 'sent');

  // ── Unsubscribe stops every reminder to that address; asking again lifts it for that state.
  assert.equal(await pg.sql(`select public.guide_reminder_unsubscribe('${got[0].id}', 'one_click')`), 't');
  assert.equal(await pg.sql(`select public.guide_reminder_unsubscribe('${got[0].id}', 'page')`), 't', 'pressing it again is the same answer');
  assert.equal(await pg.sql(`select public.guide_reminder_unsubscribe('${ID}', 'page')`), 'f');
  assert.ok((await rowsOf(pg, 'many@example.invalid')).every(r => r.stopped));
  await pg.sql(`update public.guide_renewal_reminders set last_sent_at = null where email = 'many@example.invalid'`);
  assert.deepEqual((await claim(pg)).filter(r => r.email === 'many@example.invalid'), []);
  // A state whose reminder has not gone out yet (the sweep above sent two of the twelve).
  const fresh = states.find(s => !got.some(r => r.email === 'many@example.invalid' && r.state === s));
  await signup(pg, 'many@example.invalid', fresh, 'current_date + 3');
  const lifted = (await rowsOf(pg, 'many@example.invalid')).filter(r => !r.stopped).map(r => r.state);
  assert.deepEqual(lifted, [fresh]);
  assert.deepEqual((await claim(pg)).filter(r => r.email === 'many@example.invalid').map(r => r.state), [fresh]);

  // ── The global throttle: 20 new rows in 10 minutes, then PT429; old rows do not count.
  await pg.sql(`update public.guide_renewal_reminders set created_at = now() - interval '1 hour'`);
  for (let i = 0; i < 20; i++) await signup(pg, `burst${i}@example.invalid`, 'TX', 'current_date + 300');
  const refused = await pg.tryRun(`select public.guide_reminder_signup('burst20@example.invalid', 'TX', current_date + 300, false, null, null)`);
  assert.equal(refused.ok, false);
  assert.match(refused.err, /busy/);

  // ── Turning it off stops claims at once.
  await pg.sql(`update public.guide_reminder_settings set enabled = false`);
  await signup(pg, 'burst0@example.invalid', 'TX', 'current_date + 2');
  assert.deepEqual(await claim(pg), []);

  // ── The rollback removes the functions and keeps the rows.
  const before = Number(await pg.sql(`select count(*) from public.guide_renewal_reminders`));
  await pg.sql(read(ROLLBACK_PATH));
  assert.equal((await pg.tryRun(`select public.guide_reminder_signup('z@example.invalid', 'TX', current_date + 30, false, null, null)`)).ok, false);
  assert.equal(Number(await pg.sql(`select count(*) from public.guide_renewal_reminders`)), before);
});

test('the PA and NP reminder email is the approved wording, built only from verified facts', () => {
  const base = { to: 'reader@example.invalid', stage: 90, renewalDate: '2029-04-30', unsubscribeUrl: 'https://credentialdomd.com/api/unsubscribe?t=abc' };
  const pa = buildGuideReminderEmail({ ...base, profession: 'pa', guide: PROFESSION_GUIDES.pa.TX });
  assert.equal(pa.subject, 'Your Texas physician assistant license renews April 30, 2029');
  assert.equal(pa.text, [
    'You asked for a reminder about your Texas physician assistant license. You told us it renews on April 30, 2029, which is about three months from now.',
    '',
    'License renews: every 2 years',
    'Continuing education: 40 hours every 2 years',
    'Board: Texas Physician Assistant Board (administered by the Texas Medical Board)',
    PROFESSION_GUIDES.pa.TX.boardUrl,
    '',
    "The full Texas physician assistant guide has the required topics, the certification and practice rules and the board's own sources, checked October 2026:",
    'https://credentialdomd.com/states/physician-assistant/texas',
    '',
    'Eric Whitney, DO',
    'CredentialDOMD',
    '',
    'You are receiving this because you asked for a Texas renewal reminder at credentialdomd.com. Stop these reminders: https://credentialdomd.com/api/unsubscribe?t=abc',
  ].join('\n'));
  const np = buildGuideReminderEmail({ ...base, profession: 'np', guide: PROFESSION_GUIDES.np.TX });
  assert.equal(np.subject, 'Your Texas nurse practitioner license renews April 30, 2029');
  assert.match(np.text, /about your Texas nurse practitioner license\./);
  assert.match(np.text, /APRN license renews: every 2 years\nAPRN continuing education: 20 contact hours every 2 years\nRN license renews: every 2 years\nRN continuing education: 20 contact hours every 2 years\nBoard: Texas Board of Nursing\n/);
  assert.match(np.text, /The full Texas nurse practitioner guide has the required topics/);
  // A value that is not verified is left out, never printed as such.
  const ca = buildGuideReminderEmail({ ...base, profession: 'np', guide: PROFESSION_GUIDES.np.CA });
  assert.doesNotMatch(ca.text, /APRN license renews/);
  assert.match(ca.text, /RN license renews: every 2 years/);
  // Every PA and NP entry builds at every stage, with no fee, no unverified wording and no physician wording.
  for (const profession of ['pa', 'np']) {
    assert.equal(Object.keys(PROFESSION_GUIDES[profession]).length, 51);
    for (const [st, guide] of Object.entries(PROFESSION_GUIDES[profession])) for (const stage of [90, 30, 7]) {
      const m = buildGuideReminderEmail({ ...base, stage, profession, guide, productUpdates: true, mailingAddress: '1 Example Way, Springfield, CA 90000' });
      assert.doesNotMatch(m.text, /not yet verified|medical license|Fee:|Renew at:|undefined|null/i, `${profession} ${st}`);
      assert.doesNotMatch(m.text.replace(/https?:\/\/\S+/g, ''), /[\u2013\u2014]/, `${profession} ${st}`);
      assert.match(m.html, /Stop these reminders/, `${profession} ${st}`);
    }
  }
  assert.throws(() => buildGuideReminderEmail({ ...base, profession: 'dentist', guide: PROFESSION_GUIDES.pa.TX }), /profession/);
  assert.throws(() => buildGuideReminderEmail({ ...base, profession: 'pa', guide: GUIDES.TX }), /state guide/, 'a physician entry is not a PA guide');
  assert.match(read('supabase/functions/send-guide-reminders/index.ts'), /profession === "physician" \? \(stateGuides as Record<string, any>\)\[row\.state\] : \(professionGuides as Record<string, any>\)\[profession\]\?\.\[row\.state\]/);
});

test('a PA or NP signup is its own row; physician pages that send no profession still work', { skip: pgSkip(), timeout: withSlotWait(180000) }, async t => {
  for (const rel of [PROFESSIONS_PATH, PROFESSIONS_ROLLBACK_PATH]) assert.doesNotMatch(read(rel), /^\s*(begin|commit|rollback)\s*;/im, `${rel} has a top-level transaction statement`);
  const pg = await startPostgres(57223, 'gr-prof') // a longer label makes the socket path too long to bind;
  t.after(() => pg.close());
  await pg.sql(BASE);
  // What the migration restates and this file does not exercise.
  await pg.sql(`create table public.owner_notify_stub(); create or replace function public.owner_notify_rows(p_since timestamptz) returns void language sql as 'select'`);
  await pg.sql(read(MIGRATION_PATH));
  await signup(pg, 'old@example.invalid', 'CO', 'current_date + 200', true);
  const applied = await pg.tryRun(read(PROFESSIONS_PATH).replace(/create or replace function public\.owner_notify_rows[\s\S]*?end \$fn\$;/, '').replace(/revoke all on function public\.owner_notify_rows[^;]*;/, ''));
  assert.equal(applied.ok, true, applied.err);
  assert.equal(await pg.sql(`select count(*) from pg_proc where proname = 'guide_reminder_signup'`), '1', 'one signup function, so a call by name is never ambiguous');
  const named = (email, extra = '') => pg.tryRun(`set role anon; select public.guide_reminder_signup(p_email => '${email}', p_state => 'CO', p_renewal_date => current_date + 30, p_product_updates => false, p_source => '/states/x', p_flags => null${extra})`);
  // A physician guide sends six named arguments and no profession.
  assert.equal((await named('old@example.invalid')).ok, true);
  assert.equal((await named('same@example.invalid')).ok, true);
  assert.equal((await named('same@example.invalid', ", p_profession => 'pa'")).ok, true);
  assert.equal((await named('same@example.invalid', ", p_profession => 'NP'")).ok, true);
  assert.equal((await named('same@example.invalid', ", p_profession => 'dentist'")).ok, false);
  assert.deepEqual(await pg.rows(`select profession, count(*)::int n from public.guide_renewal_reminders group by 1 order by 1`), [{ profession: 'np', n: 1 }, { profession: 'pa', n: 1 }, { profession: 'physician', n: 2 }]);
  // The existing row was updated, not duplicated, and the claim hands the profession to the sender.
  assert.equal((await rowsOf(pg, 'old@example.invalid')).length, 1);
  await pg.sql(`update public.guide_reminder_settings set enabled = true`);
  const got = await claim(pg);
  assert.ok(got.every(r => ['physician', 'pa', 'np'].includes(r.profession)));
  assert.equal(got.filter(r => r.email === 'same@example.invalid').length, 2, 'at most two rows for one address in a sweep');
  // Unsubscribing stops every profession's reminders to that address.
  await pg.sql(`select public.guide_reminder_unsubscribe('${got.find(r => r.email === 'same@example.invalid').id}', 'page')`);
  assert.ok((await rowsOf(pg, 'same@example.invalid')).every(r => r.stopped));
  // The rollback restores the six argument signup and keeps the rows.
  const rolled = await pg.tryRun(read(PROFESSIONS_ROLLBACK_PATH).replace(/create or replace function public\.owner_notify_rows[\s\S]*?end \$fn\$;/, '').replace(/revoke all on function public\.owner_notify_rows[^;]*;/, ''));
  assert.equal(rolled.ok, true, rolled.err);
  assert.equal((await named('after@example.invalid')).ok, true);
  assert.equal((await named('after@example.invalid', ", p_profession => 'pa'")).ok, false);
  assert.equal(Number(await pg.sql(`select count(*) from public.guide_renewal_reminders where profession <> 'physician'`)), 2);
});
