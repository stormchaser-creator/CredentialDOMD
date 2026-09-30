// A disposable PostgreSQL for the ops tests: initdb into a temp folder, one
// port per test file (node --test runs files in parallel), psql for every
// statement. Not a test file itself. Honours PG_BIN like the other fixtures.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, acquirePgSlot } from '../credential-portal/postgresFixture.mjs';

const run = promisify(execFile);

export async function startPostgres(port, label = 'ops') {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args, opts = {}) => run(path.join(bin, name), args, { env, maxBuffer: 16 * 1024 * 1024, ...opts });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${port} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const psqlArgs = (db, user) => ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', String(port), '-U', user, '-d', db];
  const sql = async (query, { user = 'postgres', db = 'postgres' } = {}) => (await exec('psql', [...psqlArgs(db, user), '-c', query])).stdout.trim();
  const tryRun = async (query, opts) => { try { return { ok: true, out: await sql(query, opts) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const rows = async (query, opts) => JSON.parse(await sql(`select coalesce(json_agg(q), '[]'::json) from (${query}) q`, opts));
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, socket, port, bin, env, exec, sql, tryRun, rows, close };
}
