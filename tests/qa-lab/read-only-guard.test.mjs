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

// The LOCAL lab database guard (qa-lab/lib/local-db.mjs). The schema apply runs
// as the local superuser in one transaction, so a URL that sends libpq anywhere
// but this machine must never get through.
import { connectionUrl, localConnection, psqlEnv } from '../../qa-lab/lib/local-db.mjs';

test('a local database URL is accepted only when every part is plain and local', () => {
  assert.deepEqual(localConnection('postgresql://postgres:postgres@127.0.0.1:54322/postgres'), { host: '127.0.0.1', port: '54322', database: 'postgres', password: 'postgres', sslmode: null });
  assert.equal(localConnection('postgres://postgres:postgres@localhost:54322/postgres?sslmode=disable').sslmode, 'disable');
  const refused = [
    // libpq reads these from the query string and they override the authority part.
    ['postgresql://supabase_admin:pw@127.0.0.1:54322/postgres?host=db.remote.example.co', /host/],
    ['postgresql://supabase_admin:pw@127.0.0.1:54322/postgres?hostaddr=203.0.113.9', /hostaddr/],
    ['postgresql://supabase_admin:pw@127.0.0.1:54322/postgres?service=prod', /service/],
    ['postgresql://supabase_admin:pw@127.0.0.1:54322/postgres?port=6543', /port/],
    ['postgresql://supabase_admin:pw@127.0.0.1:54322/postgres?sslmode=disable&host=evil.example', /host/],
    ['postgresql://supabase_admin:pw@127.0.0.1:54322/postgres?options=-c%20role%3Dx', /options/],
    ['postgresql://supabase_admin:pw@127.0.0.1:54322/postgres?sslmode=verify-full&sslmode=disable', /repeated|sslmode/],
    // A host list, a remote host, no port, an odd database name, another scheme.
    ['postgresql://supabase_admin:pw@127.0.0.1,db.remote.example.co:54322/postgres', /non-local/],
    ['postgresql://supabase_admin:pw@db.remote.example.co:5432/postgres', /non-local/],
    ['postgresql://supabase_admin:pw@127.0.0.1/postgres', /numeric port/],
    ['postgresql://supabase_admin:pw@127.0.0.1:54322/postgres%3Fhost%3Devil', /plain identifier/],
    ['http://127.0.0.1:54322/postgres', /scheme/],
  ];
  for (const [url, why] of refused) assert.throws(() => localConnection(url), why, url);
});

test('connectionUrl rebuilds the URL from the checked parts, and psql gets no libpq connection variables', () => {
  process.env.QA_LAB_DB_URL = 'postgresql://postgres:p%40ss@127.0.0.1:54322/postgres?sslmode=disable';
  assert.equal(connectionUrl('postgres'), 'postgresql://postgres:p%40ss@127.0.0.1:54322/postgres?sslmode=disable');
  assert.equal(connectionUrl(), 'postgresql://supabase_admin:p%40ss@127.0.0.1:54322/postgres?sslmode=disable');
  assert.throws(() => connectionUrl('x@evil.example'), /refusing database user/);
  const env = psqlEnv({ PATH: '/bin', PGHOST: 'db.remote.example.co', PGHOSTADDR: '203.0.113.9', PGPORT: '6543', PGSERVICE: 'prod', PGSERVICEFILE: '/tmp/s', PGOPTIONS: '-c role=x', PG_BIN: '/opt/pg' });
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('PG')), ['PGCONNECT_TIMEOUT']);
  assert.equal(env.PATH, '/bin');
});
