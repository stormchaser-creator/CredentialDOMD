import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot } from './credential-portal/postgresFixture.mjs';
import { itemsBytes } from '../supabase/functions/_shared/intakeFacts.mjs';

// The informational-mail notes table (migration 20260928170000), proven
// against a real PostgreSQL: it applies twice, the owner reads their own
// rows and may change only a note's status and items, never who sent it,
// what it said or whether it was verified; only the service role inserts;
// items stay under 4 KB; one row per email; the corrections table takes the
// three new answers; and the rollback removes it all. Own port, because
// node --test runs files in parallel and the other PostgreSQL suites hold
// theirs.
const PORT = '58941';
const run = promisify(execFile);
const CORRECTIONS = fs.readFileSync(new URL('../supabase/migrations/20260928160000_intake_corrections.sql', import.meta.url), 'utf8');
const MIGRATION = fs.readFileSync(new URL('../supabase/migrations/20260928170000_intake_proposals.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../docs/rollback/20260928170000_intake_proposals.rollback.sql', import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-proposals-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const tryRun = async (query) => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const as = (profile, body) => `begin; set local role authenticated; set local app.profile = '${profile}'; ${body}; commit;`;
  const service = (body) => `begin; set local role service_role; ${body}; commit;`;
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, as, service, close };
}

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key);
  create table public.document_requests (id uuid primary key, user_id uuid not null references public.profiles(id) on delete cascade);
  create function public.current_profile_id() returns uuid language sql stable
    as $$ select nullif(current_setting('app.profile', true), '')::uuid $$;
  grant execute on function public.current_profile_id() to authenticated;
  grant select on public.document_requests to authenticated;
  insert into public.profiles values ('${A}'), ('${B}');
`;

const ITEMS = `'[{"key":"r1","kind":"record","section":"insurance","op":"add","fields":{"coveragePerClaim":"1000000"},"state":"proposed"}]'`;
const note = (user, message, extra = '') => `insert into public.intake_proposals (user_id, message_id, sender, summary, items${extra ? ', verified' : ''})
  values ('${user}', '${message}', 'Jordan Sample', 'how the policy covers emergency care', ${ITEMS}${extra ? `, ${extra}` : ''})`;

test('intake proposals: owner reads and answers, only the service role writes, bounded rows, and a safe rollback', { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);
  await pg.sql(CORRECTIONS);

  await t.test('applies cleanly, twice', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION);
  });

  await t.test('the columns email-inbound and the app use, with the right types, RLS on', async () => {
    const cols = JSON.parse(await pg.sql(`select json_object_agg(column_name, data_type) from information_schema.columns
      where table_schema = 'public' and table_name = 'intake_proposals'`));
    assert.deepEqual(cols, {
      id: 'uuid', user_id: 'uuid', inbound_email_id: 'uuid', message_id: 'text', sender: 'text', summary: 'text',
      verified: 'boolean', status: 'text', items: 'jsonb', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone',
    });
    assert.equal(await pg.sql(`select relrowsecurity from pg_class where relname = 'intake_proposals'`), 't');
  });

  await t.test('the service role inserts; the owner cannot', async () => {
    await pg.sql(pg.service(note(A, '<m1@mail.test>', 'true')));
    await pg.sql(pg.service(note(B, '<m2@mail.test>')));
    const own = await pg.tryRun(pg.as(A, note(A, '<m3@mail.test>')));
    assert.equal(own.ok, false);
    assert.match(own.err, /permission denied/);
  });

  await t.test('one row per email: a redelivered webhook cannot add a second', async () => {
    const again = await pg.tryRun(pg.service(note(A, '<m1@mail.test>')));
    assert.equal(again.ok, false);
    assert.match(again.err, /idx_intake_proposals_user_message/);
  });

  await t.test('the owner sees only their own rows', async () => {
    assert.equal(await pg.sql(pg.as(A, 'select count(*) from public.intake_proposals')), '1');
    assert.equal(await pg.sql(pg.as(B, 'select count(*) from public.intake_proposals')), '1');
    assert.equal(await pg.sql(pg.as(A, 'select sender from public.intake_proposals')), 'Jordan Sample');
  });

  await t.test('the owner answers a note (status and items) and nothing else, and never another account\'s', async () => {
    await pg.sql(pg.as(A, `update public.intake_proposals set items = jsonb_set(items, '{0,state}', '"added"'), status = 'done', updated_at = now()`));
    assert.equal(await pg.sql(`select items->0->>'state' || ' ' || status from public.intake_proposals where user_id = '${A}'`), 'added done');
    for (const col of [`sender = 'someone else'`, `summary = 'x'`, `verified = true`, `user_id = '${B}'`, `message_id = 'x'`]) {
      const r = await pg.tryRun(pg.as(A, `update public.intake_proposals set ${col}`));
      assert.equal(r.ok, false, col);
      assert.match(r.err, /permission denied/, col);
    }
    await pg.sql(pg.as(A, `update public.intake_proposals set status = 'dismissed' where user_id = '${B}'`));
    assert.equal(await pg.sql(`select status from public.intake_proposals where user_id = '${B}'`), 'new', 'A cannot touch B\'s note');
    const del = await pg.tryRun(pg.as(A, `delete from public.intake_proposals`));
    assert.equal(del.ok, false);
    assert.match(del.err, /permission denied/);
  });

  await t.test('only the three statuses, an array of items, and nothing large, from anyone', async () => {
    const odd = await pg.tryRun(pg.as(A, `update public.intake_proposals set status = 'archived'`));
    assert.match(odd.err, /intake_proposals_status_check/);
    const obj = await pg.tryRun(pg.as(A, `update public.intake_proposals set items = '{}'`));
    assert.match(obj.err, /intake_proposals_shape_check/);
    const big = await pg.tryRun(pg.as(A, `update public.intake_proposals set items = jsonb_build_array(repeat(md5(random()::text), 400))`));
    assert.match(big.err, /intake_proposals_shape_check/);
    const bigInsert = await pg.tryRun(pg.service(`insert into public.intake_proposals (user_id, message_id, items) values ('${A}', '<m9@mail.test>', jsonb_build_array(repeat(md5(random()::text), 400)))`));
    assert.match(bigInsert.err, /intake_proposals_shape_check/, 'the cap holds for the service role too');
  });

  await t.test('the 4 KB cap measures what email-inbound measures: a note it fitted is never refused', async () => {
    // Many short fields: the shape whose binary size ran furthest over its text.
    const card = (i) => ({ key: `r${i}`, kind: 'record', section: 'cme', op: 'add', recordId: `c${i}`, fields: { title: 'Spine', category: 'Other', hours: '2', date: '2026-09-12' }, sources: { title: 'x', hours: 'y' }, state: 'written' });
    let items = [];
    while (itemsBytes([...items, card(items.length)]) <= 4096) items.push(card(items.length));
    const json = JSON.stringify(items);
    assert.equal(await pg.sql(`select octet_length('${json}'::jsonb::text)`), String(itemsBytes(items)), 'the same count on both sides');
    assert.ok(Number(await pg.sql(`select pg_column_size('${json}'::jsonb)`)) > 4096, 'the binary size would have refused it');
    await pg.sql(pg.service(`insert into public.intake_proposals (user_id, message_id, items) values ('${A}', '<fit@mail.test>', '${json}')`));
    const over = JSON.stringify([...items, card(items.length)]);
    const refused = await pg.tryRun(pg.service(`insert into public.intake_proposals (user_id, message_id, items) values ('${A}', '<over@mail.test>', '${over}')`));
    assert.match(refused.err, /intake_proposals_shape_check/, 'one card more is over');
    await pg.sql(`delete from public.intake_proposals where message_id in ('<fit@mail.test>', '<over@mail.test>')`);
  });

  await t.test('anon has nothing', async () => {
    const anon = await pg.tryRun(`begin; set local role anon; select count(*) from public.intake_proposals; commit;`);
    assert.equal(anon.ok, false);
  });

  await t.test('the corrections table takes the three answers to a proposal', async () => {
    for (const action of ['dismiss_record', 'edit_record', 'undo_record']) {
      await pg.sql(pg.as(A, `insert into public.intake_corrections (user_id, action, before, after) values ('${A}', '${action}', '{"kind":"Insurance"}', '{}')`));
    }
    const odd = await pg.tryRun(pg.as(A, `insert into public.intake_corrections (user_id, action) values ('${A}', 'anything')`));
    assert.match(odd.err, /intake_corrections_action_check/);
  });

  await t.test('a deleted account takes its notes', async () => {
    await pg.sql(`delete from public.profiles where id = '${B}'`);
    assert.equal(await pg.sql(`select count(*) from public.intake_proposals where user_id = '${B}'`), '0');
  });

  await t.test('the rollback removes the table and narrows the corrections back, and the migration applies again after it', async () => {
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select count(*) from information_schema.tables where table_name = 'intake_proposals'`), '0');
    assert.equal(await pg.sql(`select count(*) from public.intake_corrections where action like '%_record'`), '0');
    const odd = await pg.tryRun(pg.as(A, `insert into public.intake_corrections (user_id, action) values ('${A}', 'undo_record')`));
    assert.match(odd.err, /intake_corrections_action_check/);
    await pg.sql(MIGRATION);
    assert.equal(await pg.sql(`select count(*) from information_schema.tables where table_name = 'intake_proposals'`), '1');
  });
});
