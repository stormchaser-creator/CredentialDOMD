// QA OPS-001: the monthly backup prune must remove ZIPs through the Storage
// API. prune_old_backups() used to DELETE FROM storage.objects, which removes
// the metadata row only and leaves the bytes in the bucket, billed and
// invisible to the app, to storage-orphans.mjs and to delete-account.
//
// Three parts: the newest migration's definition never deletes from
// storage.objects; on a disposable PostgreSQL the dispatcher fires the
// prune-backups edge function with the vault secret and the ranking is
// unchanged; and the edge function's rules (lib.ts) delete a row only once
// its file is gone. Synthetic ids and paths only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { startPostgres } from './pg.mjs';
import { pruneBackups, REMOVE_BATCH } from '../../supabase/functions/prune-backups/lib.ts';

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, MIGRATIONS), 'utf8');
const MIGRATION = '20260930010000_prune_backups_storage_api.sql';
const ROLLBACK = fs.readFileSync(new URL('../../docs/rollback/20260930010000_prune_backups_storage_api.rollback.sql', import.meta.url), 'utf8');

// The last migration (in apply order) that defines prune_old_backups().
function latestPruneDefinition() {
  const names = fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  const defining = names.filter((n) => /create or replace function public\.prune_old_backups\(\)/i.test(read(n)));
  const name = defining.at(-1);
  const body = read(name).match(/create or replace function public\.prune_old_backups\(\)[\s\S]*?\n(end \$\$;|end\n\$\$;)/i)[0];
  return { name, body };
}

test('the prune that production runs never deletes backup ZIPs with SQL on storage.objects', () => {
  const { name, body } = latestPruneDefinition();
  const code = body.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /delete\s+from\s+storage\.objects/i, `${name}: a SQL delete orphans the file bytes`);
  assert.doesNotMatch(code, /allow_delete_query/i, `${name}: no opt-in to the storage delete guard`);
  assert.match(code, /functions\/v1\/prune-backups/, `${name}: the Storage API removal runs in the prune-backups edge function`);
});

test('the migration has no top-level transaction control and a rollback', () => {
  const sql = read(MIGRATION);
  assert.doesNotMatch(sql, /^\s*(begin|commit)\s*;/im);
  assert.match(ROLLBACK, /drop function if exists public\.backups_due_for_prune\(\)/);
});

const LIT = 'synthetic-hook-secret-prune-0123456789';
const PLATFORM = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create role app_user login; grant authenticated to app_user;
  create schema vault;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text not null);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  create schema net;
  create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds integer);
  create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
    headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
    returns bigint language sql as $$ insert into net.calls (url, body, headers, timeout_milliseconds) values (url, body, headers, timeout_milliseconds) returning id $$;
  create schema storage;
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create table public.profiles (id uuid primary key);
  create table public.backups (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
    period text, storage_path text, part int default 1, parts int default 1, status text not null default 'pending', created_at timestamptz default now());
  grant usage on schema public to anon, authenticated, service_role;
`;

const U1 = '00000000-0000-4000-8000-0000000000e1';
const U2 = '00000000-0000-4000-8000-0000000000e2';

test('on PostgreSQL: the dispatcher fires prune-backups with the vault secret and touches no storage row; the ranking keeps 3 periods per user', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres(58471, 'prune-backups');
  t.after(() => pg.close());
  await pg.sql(PLATFORM);
  // Production today: 20260902f's body, then this migration on top, twice.
  await pg.sql(read('20260902f_prune_backups_delete_guard.sql'));
  await pg.sql(read(MIGRATION));
  await pg.sql(read(MIGRATION));

  const periods = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  await pg.sql(`insert into public.profiles values ('${U1}'), ('${U2}');
    insert into public.backups (user_id, period, storage_path, part, parts)
      select '${U1}', p, 'user_1/' || p || '/CredentialDOMD-backup-' || p || '-part-' || n || '.zip', n, 2
        from unnest(array['${periods.join("','")}']) p, generate_series(1, 2) n;
    insert into public.backups (user_id, period, storage_path, status) values ('${U1}', '2026-04', null, 'failed');
    insert into public.backups (user_id, period, storage_path)
      select '${U2}', p, 'user_2/' || p || '/CredentialDOMD-backup-' || p || '.zip' from unnest(array['2026-07','2026-08','2026-09']) p;
    insert into storage.objects (bucket_id, name) select 'backups', storage_path from public.backups where storage_path is not null;
    insert into vault.secrets (name, secret) values ('welcome_hook_secret', '${LIT}');`);

  const due = await pg.rows(`select storage_path from public.backups_due_for_prune() order by storage_path nulls first`);
  assert.deepEqual(due.map((r) => r.storage_path), [
    null,
    'user_1/2026-05/CredentialDOMD-backup-2026-05-part-1.zip', 'user_1/2026-05/CredentialDOMD-backup-2026-05-part-2.zip',
    'user_1/2026-06/CredentialDOMD-backup-2026-06-part-1.zip', 'user_1/2026-06/CredentialDOMD-backup-2026-06-part-2.zip',
  ], 'the two oldest periods and the failed build of user 1, every part of a period together; user 2 keeps all 3');

  const objectsBefore = await pg.sql(`select count(*) from storage.objects`);
  assert.equal(await pg.sql(`select public.prune_old_backups()`), '1');
  assert.equal(await pg.sql(`select count(*) from storage.objects`), objectsBefore, 'no storage metadata row is deleted in SQL');
  assert.equal(await pg.sql(`select count(*) from public.backups`), '14', 'rows stay until the edge function has removed their files');
  const calls = await pg.rows(`select url, headers, body from net.calls`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/prune-backups');
  assert.equal(calls[0].headers['x-hook-secret'], LIT);

  // Nobody but postgres and service_role can run either function.
  for (const fn of ['prune_old_backups()', 'backups_due_for_prune()']) {
    const denied = await pg.tryRun(`select public.${fn}`, { user: 'app_user' });
    assert.equal(denied.ok, false, fn);
    assert.match(denied.err, /permission denied/, fn);
  }
  assert.doesNotMatch(await pg.sql(`select prosrc from pg_proc where proname = 'prune_old_backups'`), new RegExp(LIT), 'the secret is read at call time, not stored');

  // A missing vault secret fails the cron run loudly instead of calling without one.
  await pg.sql(`delete from vault.secrets`);
  const missing = await pg.tryRun(`select public.prune_old_backups()`);
  assert.equal(missing.ok, false);
  assert.match(missing.err, /welcome_hook_secret is missing/);

  // The rollback restores the old body and drops the helper; the fix re-applies on top.
  await pg.sql(ROLLBACK);
  assert.equal(await pg.sql(`select count(*) from pg_proc where proname = 'backups_due_for_prune'`), '0');
  assert.match(await pg.sql(`select prosrc from pg_proc where proname = 'prune_old_backups'`), /delete from storage\.objects/);
  await pg.sql(read(MIGRATION));
  assert.match(await pg.sql(`select prosrc from pg_proc where proname = 'prune_old_backups'`), /prune-backups/);
});

// ─── The edge function's rules ───────────────────────────────────────────
function world({ due, present, failRemove = () => null, failDelete = null, dueError = null }) {
  const bucket = new Set(present), rows = new Map(due.map((r) => [r.id, r]));
  const removes = [], deletes = [];
  const db = {
    async rpc(name) { assert.equal(name, 'backups_due_for_prune'); return dueError ? { data: null, error: dueError } : { data: [...rows.values()], error: null }; },
    from(table) {
      assert.equal(table, 'backups');
      return { delete: () => ({ async in(column, ids) {
        assert.equal(column, 'id'); deletes.push(ids);
        if (failDelete) return { error: failDelete };
        ids.forEach((id) => rows.delete(id)); return { error: null };
      } }) };
    },
    storage: { from(name) {
      assert.equal(name, 'backups');
      return { async remove(paths) {
        removes.push(paths);
        const error = failRemove(paths);
        if (error) return { data: null, error };
        const gone = paths.filter((p) => bucket.has(p)); gone.forEach((p) => bucket.delete(p));
        return { data: gone.map((name) => ({ name })), error: null };
      } };
    } },
  };
  return { db, bucket, rows, removes, deletes };
}
const row = (i, path = `user_1/2026-0${1 + (i % 5)}/part-${i}.zip`) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, storage_path: path });

test('prune-backups: files go through Storage, then only the rows whose files are gone', async () => {
  const due = [row(1), row(2), row(3, null)];
  const w = world({ due, present: [due[0].storage_path, due[1].storage_path, 'user_1/2026-09/keep.zip'] });
  const report = await pruneBackups(w.db);
  assert.equal(report.ok, true);
  assert.deepEqual(w.removes, [[due[0].storage_path, due[1].storage_path]]);
  assert.deepEqual([...w.bucket], ['user_1/2026-09/keep.zip'], 'the kept month is untouched');
  assert.equal(w.rows.size, 0);
  assert.deepEqual({ removed: report.files_removed, absent: report.files_already_absent, deleted: report.rows_deleted, kept: report.rows_kept }, { removed: 2, absent: 0, deleted: 3, kept: 0 });
});

test('prune-backups: a failed Storage batch keeps its rows for next month; other batches still finish', async () => {
  const due = Array.from({ length: REMOVE_BATCH + 5 }, (_, i) => row(i + 1, `user_1/old/part-${i + 1}.zip`));
  const w = world({ due, present: due.map((r) => r.storage_path), failRemove: (paths) => (paths.length === REMOVE_BATCH ? { message: 'Synthetic storage outage' } : null) });
  const report = await pruneBackups(w.db);
  assert.equal(report.ok, false);
  assert.equal(w.removes.length, 2);
  assert.ok(w.removes.every((b) => b.length <= REMOVE_BATCH));
  assert.equal(report.rows_deleted, 5);
  assert.equal(w.rows.size, REMOVE_BATCH, 'the rows of the failed batch stay, and their files');
  assert.equal(w.bucket.size, REMOVE_BATCH);
  assert.match(report.errors[0], /Synthetic storage outage/);
});

test('prune-backups: a file Storage no longer has is counted absent and its row goes, so it is not retried forever', async () => {
  const due = [row(1)];
  const w = world({ due, present: [] });
  const report = await pruneBackups(w.db);
  assert.equal(report.files_already_absent, 1);
  assert.equal(w.rows.size, 0);
});

test('prune-backups: a failed row delete is reported and the files stay removed; dry run and a failed read touch nothing', async () => {
  const due = [row(1)];
  const failed = world({ due, present: [due[0].storage_path], failDelete: { message: 'Synthetic delete failure' } });
  const report = await pruneBackups(failed.db);
  assert.equal(report.ok, false);
  assert.equal(report.rows_kept, 1);

  const dry = world({ due, present: [due[0].storage_path] });
  const dryReport = await pruneBackups(dry.db, { dryRun: true });
  assert.equal(dryReport.due, 1);
  assert.equal(dry.removes.length + dry.deletes.length, 0);

  const unread = world({ due, present: [], dueError: { message: 'Synthetic read failure' } });
  const unreadReport = await pruneBackups(unread.db);
  assert.equal(unreadReport.ok, false);
  assert.equal(unread.removes.length + unread.deletes.length, 0);
});
