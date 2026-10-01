// PUBLIC-002: a second state's renewal guide must actually be sent. The
// one-hour "do not send the same guide twice" guard in waitlist_signup also
// held back a DIFFERENT state's guide, and two requests before a sweep
// overwrote each other, while the page said "The guide is on its way".
// 20261001052000_guide_second_state fixes both without touching send-guide.
//
// Disposable PostgreSQL on a Unix socket, synthetic addresses only. The sweep
// is played by the same statements send-guide runs: select unsent
// guide-email rows, stamp guide_sent_at only where it is still null.
//
// waitlist_signup is reachable with the public anon key and the global
// throttle counts only new rows, so the second-state fix must also bound mail
// to ONE existing address: each state once per 24 hours and at most 3 guides
// per address per 24 hours (HTTP 403 past that), or an anonymous caller could
// alternate TX/FL, or queue every state, and send a guide every sweep.
//
// The 403 is set through PostgREST's response.status, not raised: a RAISE
// rolled back the waitlist answer recorded in the same call, so a physician
// asking for a fourth guide with "join the waitlist" stayed off the waitlist,
// and the page read the PT429 as "Busy right now. Try again in a few minutes"
// for a refusal that lasts a day.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pgSkip, withSlotWait } from './credential-portal/postgresFixture.mjs';
import { startPostgres } from './ops/pg.mjs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const MIGRATION_PATH = 'supabase/migrations/20261001052000_guide_second_state.sql';
const ROLLBACK_PATH = 'docs/rollback/20261001052000_guide_second_state.rollback.sql';
const exists = rel => fs.existsSync(new URL(`../${rel}`, import.meta.url));
const OPTIN = read('supabase/migrations/20260902_guide_waitlist_optin.sql');

// early_access_leads as production has it, trimmed to what these paths read.
const BASE = `
  create role anon; create role service_role;
  create table public.early_access_leads (
    id uuid primary key default gen_random_uuid(), email text not null, name text, source text,
    note text, status text, invited_at timestamptz, created_at timestamptz not null default now(),
    guide_sent_at timestamptz, guide_attempts integer not null default 0);
  create unique index early_access_leads_email_key on public.early_access_leads (lower(email));
`;

const ask = (pg, email, abbr) => pg.sql(`select public.waitlist_signup(null, '${email}', '/states/x', 'guide-email ${abbr} inline', 'guide', false)`);
// One send-guide sweep: every unsent guide row under the cap is "sent".
async function sweep(pg) {
  const rows = await pg.rows(`select id, note from public.early_access_leads
    where note ilike 'guide-email %' and guide_sent_at is null and guide_attempts < 5 order by created_at`);
  for (const r of rows) await pg.sql(`update public.early_access_leads set guide_sent_at = now() where id = '${r.id}' and guide_sent_at is null`);
  return rows.map(r => r.note.split(' ')[1]);
}
// The HTTP status PostgREST would answer: the function's response.status
// setting, read in the same transaction the call ran in (200 when unset).
const askStatus = async (pg, email, abbr, waitlist = false) => {
  const out = await pg.sql(`with r as materialized (
      select public.waitlist_signup(null, '${email}', '/states/x', 'guide-email ${abbr} inline', 'guide', ${waitlist}) id)
    select coalesce(nullif(current_setting('response.status', true), ''), '200') from r`);
  return Number(out);
};
const row = async (pg, email) => (await pg.rows(`select note, guide_sent_at, guide_attempts from public.early_access_leads where email = '${email}'`))[0];

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(exists(MIGRATION_PATH), `${MIGRATION_PATH} is missing`);
  assert.ok(exists(ROLLBACK_PATH), `${ROLLBACK_PATH} is missing`);
  for (const rel of [MIGRATION_PATH, ROLLBACK_PATH]) assert.doesNotMatch(read(rel), /^\s*(begin|commit)\s*;/im, `${rel} has a top-level begin/commit`);
});

test('a second state is sent, queued requests are all sent, the same guide is not repeated', { skip: pgSkip(), timeout: withSlotWait(120000) }, async t => {
  const pg = await startPostgres(57187, 'guide-second-state');
  t.after(() => pg.close());
  await pg.sql(BASE);
  await pg.sql(OPTIN);
  // A guide sent before the migration: it must count toward the bound.
  await pg.sql(`insert into public.early_access_leads (email, note, guide_sent_at)
    values ('legacy@example.invalid', 'guide-email TX inline', now() - interval '2 hours')`);
  if (exists(MIGRATION_PATH)) { await pg.sql(read(MIGRATION_PATH)); await pg.sql(read(MIGRATION_PATH)); }

  await t.test('Texas went out 20 minutes ago; Florida asked for now is still sent', async () => {
    const a = 'second-state@example.invalid';
    await ask(pg, a, 'TX');
    assert.deepEqual(await sweep(pg), ['TX']);
    await pg.sql(`update public.early_access_leads set guide_sent_at = now() - interval '20 minutes' where email = '${a}'`);
    await ask(pg, a, 'FL');
    const r = await row(pg, a);
    assert.equal(r.note, 'guide-email FL inline');
    assert.equal(r.guide_sent_at, null, 'the Florida guide is pending, not marked sent');
    assert.deepEqual(await sweep(pg), ['FL']);
  });

  await t.test('the same state asked for again within the hour is not sent twice', async () => {
    const a = 'same-state@example.invalid';
    await ask(pg, a, 'TX');
    await sweep(pg);
    await ask(pg, a, 'TX');
    assert.notEqual((await row(pg, a)).guide_sent_at, null);
    assert.deepEqual(await sweep(pg), []);
  });

  await t.test('the same state asked for again later in the day answers 208, not the 200 the page reads as on its way', async () => {
    // Texas went out at 09:10 and landed in spam; Texas is asked for again at
    // 11:00. Nothing is sent (each state once per 24 hours), so the answer must
    // not be the plain 200 the state page shows as "on its way". 208 is a 2xx,
    // so an older page still reads it as accepted.
    const a = 'same-state-later@example.invalid';
    assert.equal(await askStatus(pg, a, 'TX'), 200);
    await sweep(pg);
    await pg.sql(`update public.early_access_leads set guide_sent_at = now() - interval '2 hours',
      guide_sent_log = jsonb_build_object('TX', now() - interval '2 hours') where email = '${a}'`);
    assert.equal(await askStatus(pg, a, 'TX', true), 208, 'already sent today: its own status');
    assert.deepEqual(await sweep(pg), [], 'and nothing is sent');
    assert.equal((await pg.rows(`select waitlist from public.early_access_leads where email = '${a}'`))[0].waitlist, true, 'the waitlist answer is kept');
    // A guide still waiting for the sweep really is on its way: plain 200.
    const b = 'same-state-pending@example.invalid';
    await ask(pg, b, 'OH');
    assert.equal(await askStatus(pg, b, 'OH'), 200);
    assert.deepEqual(await sweep(pg), ['OH']);
  });

  await t.test('Texas then Florida before any sweep: both guides go out, once each', async () => {
    const a = 'two-before-sweep@example.invalid';
    await ask(pg, a, 'TX');
    await ask(pg, a, 'FL');
    await ask(pg, a, 'FL');
    await ask(pg, a, 'TX');
    const sent = [...await sweep(pg), ...await sweep(pg), ...await sweep(pg)];
    assert.deepEqual(sent, ['TX', 'FL']);
    const r = await row(pg, a);
    assert.equal(r.note, 'guide-email FL inline');
    assert.notEqual(r.guide_sent_at, null);
  });

  await t.test('a guide given up at the attempt cap hands over to the next one', async () => {
    const a = 'capped@example.invalid';
    await ask(pg, a, 'TX');
    await ask(pg, a, 'OH');
    await pg.sql(`update public.early_access_leads set guide_attempts = 5 where email = '${a}'`);
    assert.deepEqual(await sweep(pg), ['OH']);
  });

  await t.test('an address alternating TX and FL every sweep gets each state once', async () => {
    const a = 'alternating@example.invalid';
    const sent = [];
    for (let i = 0; i < 12; i++) { await ask(pg, a, i % 2 ? 'FL' : 'TX'); sent.push(...await sweep(pg)); }
    assert.deepEqual(sent, ['TX', 'FL']);
  });

  await t.test('a burst of states sends at most 3 guides a day; the rest are refused, not dropped', async () => {
    const a = 'burst@example.invalid';
    const refused = [];
    for (const s of ['CA', 'NY', 'WA', 'OR', 'NV', 'AZ', 'UT', 'CO', 'NM', 'OK']) {
      const status = await askStatus(pg, a, s);
      if (status !== 200) { assert.equal(status, 403); refused.push(s); }
    }
    assert.equal(refused.length, 7, 'every request past the third is refused (HTTP 403 on the page)');
    const sent = [];
    for (let i = 0; i < 12; i++) sent.push(...await sweep(pg));
    assert.deepEqual(sent, ['CA', 'NY', 'WA']);
    assert.equal(await askStatus(pg, a, 'OK'), 403, 'three sent today: a fourth state is still refused after they go out');
    // A day later the address may ask again, and a state sent then is sent again.
    await pg.sql(`update public.early_access_leads
      set guide_sent_log = (select jsonb_object_agg(k, now() - interval '25 hours') from jsonb_object_keys(guide_sent_log) k)
      where email = '${a}'`);
    await ask(pg, a, 'CA');
    assert.deepEqual(await sweep(pg), ['CA']);
  });

  await t.test('a fourth guide refused for the day still puts the requester on the waitlist', async () => {
    const a = 'fourth-with-waitlist@example.invalid';
    for (const s of ['TX', 'FL', 'CA']) { assert.equal(await askStatus(pg, a, s), 200); await sweep(pg); }
    const before = await pg.rows(`select waitlist from public.early_access_leads where email = '${a}'`);
    assert.equal(before[0].waitlist, false, 'guide only so far');
    const status = await askStatus(pg, a, 'NY', true);
    assert.equal(status, 403, 'the refusal is its own status, not the 429 the page reads as busy for a few minutes');
    const after = await pg.rows(`select waitlist, note, guide_queue from public.early_access_leads where email = '${a}'`);
    assert.equal(after[0].waitlist, true, 'the waitlist answer on the refused request is kept');
    assert.equal(after[0].note, 'guide-email CA inline', 'the refused guide is not queued or sent');
    assert.deepEqual(after[0].guide_queue, []);
    assert.deepEqual(await sweep(pg), []);
  });

  await t.test('the per address limit is never raised as an error', () => {
    assert.doesNotMatch(read(MIGRATION_PATH), /raise[^;]*guide limit/i, 'a RAISE rolls back the waitlist answer recorded in the same call');
  });

  await t.test('a guide sent before the migration is not sent again within the day', async () => {
    await ask(pg, 'legacy@example.invalid', 'TX');
    assert.deepEqual(await sweep(pg), []);
  });

  await t.test('a request with no state leaves the queued guides alone', async () => {
    const a = 'stateless@example.invalid';
    await ask(pg, a, 'TX');
    await ask(pg, a, 'FL');
    await pg.sql(`select public.waitlist_signup(null, '${a}', '/x', 'guide', 'guide', true)`);
    const sent = [...await sweep(pg), ...await sweep(pg)];
    assert.deepEqual(sent, ['TX', 'FL']);
    assert.equal((await pg.rows(`select waitlist from public.early_access_leads where email = '${a}'`))[0].waitlist, true);
  });

  if (exists(ROLLBACK_PATH)) {
    await t.test('the rollback restores the previous function and runs twice', async () => {
      await pg.sql(read(ROLLBACK_PATH));
      await pg.sql(read(ROLLBACK_PATH));
      const cols = await pg.sql(`select count(*) from information_schema.columns where table_name = 'early_access_leads' and column_name = 'guide_queue'`);
      assert.equal(cols, '0');
      assert.equal(await pg.sql(`select count(*) from information_schema.columns where table_name = 'early_access_leads' and column_name = 'guide_sent_log'`), '0');
      assert.equal(await pg.sql(`select count(*) from pg_trigger where tgname = 'trg_next_guide'`), '0');
      await ask(pg, 'after-rollback@example.invalid', 'TX');
    });
  }
});
