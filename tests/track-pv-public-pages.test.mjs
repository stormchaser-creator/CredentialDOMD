import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from './credential-portal/postgresFixture.mjs';

// Signup review 2026-10-07: the CME, help, privacy, security and terms pages
// sent no visit beacon. They do now (scripts/visit-beacon.mjs), and track_pv
// must count their paths, which were not on its whitelist. Proven against a
// real PostgreSQL with the real migrations. Own port: node --test runs files
// in parallel.
const PORT = '57447';
const run = promisify(execFile);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const BASE = read('supabase/migrations/20260827_page_views.sql');
const REQUIRE_PATH = read('supabase/migrations/20260827b_track_pv_require_path.sql');
const STATES_HUB = read('supabase/migrations/20260929200000_track_pv_states_hub.sql');
const MIGRATION = read('supabase/migrations/20261007120000_track_pv_public_pages.sql');
const ROLLBACK = read('docs/rollback/20261007120000_track_pv_public_pages.rollback.sql');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'track-pv-pages-'));
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

// What the beacon sends (it drops .html itself); index.html is normalized here.
const PAGES = ['/cme/', '/help/', '/privacy', '/security', '/terms', '/cme/index.html'];
test('track_pv counts the CME, help, privacy, security and terms pages', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql('create role anon; create role authenticated; create role service_role;');
  await pg.sql(BASE);
  await pg.sql(REQUIRE_PATH);
  await pg.sql(STATES_HUB);
  const hit = (p) => pg.tryRun(`select public.track_pv('${p}', '')`);

  await t.test('before: each of the five is refused', async () => {
    for (const p of PAGES) {
      const refused = await hit(p);
      assert.equal(refused.ok, false, p);
      assert.match(refused.err, /path not tracked/);
    }
  });

  await t.test('after: the five count under their own path; the rest is unchanged', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION); // idempotent
    for (const p of PAGES) assert.equal((await hit(p)).ok, true, p);
    for (const p of ['/', '/locums', '/states', '/states/texas', '/app/auth']) assert.equal((await hit(p)).ok, true, p);
    for (const p of ['/cmex', '/help/locum-invoice/', '/helpdesk', '/privacy-policy', '/admin', '/terms/old', '']) assert.equal((await hit(p)).ok, false, p);
    assert.equal(await pg.sql("select string_agg(path || '=' || hits, ',' order by path) from public.page_views where path in ('/cme','/help','/privacy','/security','/terms')"),
      '/cme=2,/help=1,/privacy=1,/security=1,/terms=1');
    assert.equal(await pg.sql("select has_function_privilege('anon', 'public.track_pv(text,text)', 'execute')"), 't');
    assert.equal(await pg.sql("select has_function_privilege('authenticated', 'public.track_pv(text,text)', 'execute')"), 'f');
  });

  await t.test('the rollback puts the previous whitelist back', async () => {
    await pg.sql(ROLLBACK);
    await pg.sql(ROLLBACK);
    assert.equal((await hit('/cme/')).ok, false);
    assert.equal((await hit('/states/')).ok, true);
  });
});

test('the migration and its rollback have no top-level transaction lines', () => {
  for (const sql of [MIGRATION, ROLLBACK]) assert.doesNotMatch(sql, /^\s*(begin|commit)\s*;/im);
});
