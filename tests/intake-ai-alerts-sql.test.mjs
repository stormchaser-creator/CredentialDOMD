import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from './credential-portal/postgresFixture.mjs';

// The intake AI alert claim (migration 20261117120000), proven against a real
// PostgreSQL: it applies twice, the first claim in 24 hours gets an id and the
// next gets null, a claim given back (deleted) frees the day, an alert older
// than 24 hours does not block, rows past 30 days are dropped, only the
// service role may claim or read, and the rollback removes it. Own port.
const PORT = '58951';
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL('../supabase/migrations/20261117120000_intake_ai_alerts.sql', import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL('../docs/rollback/20261117120000_intake_ai_alerts.rollback.sql', import.meta.url), 'utf8');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-ai-alerts-'));
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

const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
`;
const claim = `select coalesce(public.claim_intake_ai_alert('workers-ai', 'Workers AI answered 429')::text, 'null')`;
const asService = (body) => `begin; set local role service_role; ${body}; commit;`;

test('intake AI alerts: one claim a day, given back on a failed send, service role only, and a safe rollback', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);
  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION);

  const first = await pg.sql(asService(claim));
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(await pg.sql(asService(claim)), 'null', 'the day is claimed');

  // A send that failed gives the claim back; the next failure may alert.
  await pg.sql(asService(`delete from public.intake_ai_alerts where id = '${first}'`));
  const second = await pg.sql(asService(claim));
  assert.match(second, /^[0-9a-f-]{36}$/);
  await pg.sql(asService(`update public.intake_ai_alerts set sent_at = now() where id = '${second}'`));

  // An alert more than 24 hours old does not block; one past 30 days is dropped.
  await pg.sql(`update public.intake_ai_alerts set created_at = now() - interval '25 hours'`);
  await pg.sql(`insert into public.intake_ai_alerts (provider, created_at) values ('old', now() - interval '31 days')`);
  assert.match(await pg.sql(asService(claim)), /^[0-9a-f-]{36}$/);
  assert.equal(await pg.sql(`select count(*) from public.intake_ai_alerts where provider = 'old'`), '0');

  // Long text is clipped, never refused.
  await pg.sql(`delete from public.intake_ai_alerts`);
  await pg.sql(asService(`select public.claim_intake_ai_alert(repeat('p', 100), repeat('d', 2000))`));
  assert.equal(await pg.sql(`select length(provider) || ',' || length(detail) from public.intake_ai_alerts`), '40,500');

  for (const role of ['anon', 'authenticated']) {
    const c = await pg.tryRun(`begin; set local role ${role}; ${claim}; commit;`);
    assert.equal(c.ok, false, `${role} may not claim`);
    const r = await pg.tryRun(`begin; set local role ${role}; select count(*) from public.intake_ai_alerts; commit;`);
    assert.equal(r.ok, false, `${role} may not read`);
  }
  const ins = await pg.tryRun(asService(`insert into public.intake_ai_alerts (provider) values ('x')`));
  assert.equal(ins.ok, false, 'the service role claims through the function, never by insert');

  await pg.sql(ROLLBACK);
  assert.equal(await pg.sql(`select coalesce(to_regclass('public.intake_ai_alerts')::text, 'gone')`), 'gone');
  assert.equal(await pg.sql(`select count(*) from pg_proc where proname = 'claim_intake_ai_alert'`), '0');
});
