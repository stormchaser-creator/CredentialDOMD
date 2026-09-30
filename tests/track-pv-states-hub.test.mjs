import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from './credential-portal/postgresFixture.mjs';

// PUBLIC-006: the /states/ hub page sends p='/states/'. track_pv strips the
// trailing slash to '/states', which was not on its whitelist, so every hub
// visit was refused (PT400) and never counted. Proven against a real
// PostgreSQL with the real migrations. Own port: node --test runs files in
// parallel.
const PORT = '57443';
const run = promisify(execFile);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const BASE = read('supabase/migrations/20260827_page_views.sql');
const REQUIRE_PATH = read('supabase/migrations/20260827b_track_pv_require_path.sql');
const MIGRATION = read('supabase/migrations/20260929200000_track_pv_states_hub.sql');
const ROLLBACK = read('docs/rollback/20260929200000_track_pv_states_hub.rollback.sql');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'track-pv-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const tryRun = async (query) => { try { return { ok: true, out: await sql(query) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, close };
}

test('track_pv counts the /states/ hub page', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql('create role anon; create role authenticated; create role service_role;');
  await pg.sql(BASE);
  await pg.sql(REQUIRE_PATH);
  const hit = (p) => pg.tryRun(`select public.track_pv(${p === null ? 'null' : `'${p}'`}, '')`);

  await t.test('before: the hub page is refused', async () => {
    const refused = await hit('/states/');
    assert.equal(refused.ok, false);
    assert.match(refused.err, /path not tracked/);
  });

  await t.test('after: /states/, /states and /states/index.html count as /states; the rest is unchanged', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION); // idempotent
    for (const p of ['/states/', '/states', '/states/index.html', '/states/texas', '/', '/locums']) assert.equal((await hit(p)).ok, true, p);
    for (const p of ['/statesx', '/state', '/admin', '']) assert.equal((await hit(p)).ok, false, p);
    assert.equal(await pg.sql("select hits from public.page_views where path = '/states'"), '3');
    assert.equal(await pg.sql("select hits from public.page_views where path = '/states/texas'"), '1');
    assert.equal(await pg.sql("select has_function_privilege('anon', 'public.track_pv(text,text)', 'execute')"), 't');
    assert.equal(await pg.sql("select has_function_privilege('authenticated', 'public.track_pv(text,text)', 'execute')"), 'f');
  });

  await t.test('the rollback puts the old whitelist back', async () => {
    await pg.sql(ROLLBACK);
    assert.equal((await hit('/states/')).ok, false);
    assert.equal((await hit('/states/texas')).ok, true);
  });
});

test('the migration and its rollback have no top-level transaction lines', () => {
  for (const sql of [MIGRATION, ROLLBACK]) assert.doesNotMatch(sql, /^\s*(begin|commit)\s*;/im);
});
