// The LOCAL QA-lab database (supabase start). Nothing here can reach production:
// the connection string is built from `supabase status`, and connectionUrl()
// refuses any host that is not this machine.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.mjs';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Status of the local stack as reported by the Supabase CLI (JSON), or null when it is not running. */
export function supabaseStatus() {
  const r = spawnSync('supabase', ['status', '-o', 'json', '--workdir', REPO_ROOT], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const start = r.stdout.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(r.stdout.slice(start)); } catch { return null; }
}

/** Connection URL for the local database as `user` (default supabase_admin, the local superuser). */
let cachedBase = null;
export function connectionUrl(user = 'supabase_admin') {
  const base = cachedBase || (cachedBase = process.env.QA_LAB_DB_URL || supabaseStatus()?.DB_URL || null);
  if (!base) throw new Error('The local QA-lab stack is not running. Start it with `npm run qa:up`.');
  const u = new URL(base);
  if (!LOCAL_HOSTS.has(u.hostname)) throw new Error(`refusing a non-local database host: ${u.hostname}`);
  u.username = user;
  // The local image gives every login role the stack's database password.
  return u.toString();
}

/** Absolute path of psql: $PSQL, $PG_BIN/psql, `pg_config --bindir`/psql, or Homebrew's postgresql@17. */
export function psqlPath() {
  if (process.env.PSQL) return process.env.PSQL;
  const candidates = [];
  if (process.env.PG_BIN) candidates.push(path.join(process.env.PG_BIN, 'psql'));
  try { candidates.push(path.join(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(), 'psql')); } catch { /* not installed */ }
  candidates.push('/opt/homebrew/opt/postgresql@17/bin/psql', '/usr/local/opt/postgresql@17/bin/psql');
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('psql not found: set PSQL or PG_BIN (PostgreSQL 17 client tools).');
  return found;
}

const env = () => ({ ...process.env, LC_ALL: 'C', PGCONNECT_TIMEOUT: '10' });

/** Runs a SQL file in ONE transaction, stopping at the first error. */
export function runSqlFile(file, { user = 'supabase_admin', quiet = true } = {}) {
  const args = ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', file, connectionUrl(user)];
  if (quiet) args.unshift('-q');
  const r = spawnSync(psqlPath(), args, { encoding: 'utf8', env: env(), maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

/** Runs one read-only query whose single row has one JSON column; returns the parsed value. */
export function localJson(sql, { user = 'supabase_admin' } = {}) {
  const wrapped = `begin transaction read only; set local search_path = pg_catalog; ${sql.trim().replace(/;\s*$/, '')}\n; commit;`;
  const r = spawnSync(psqlPath(), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', wrapped, connectionUrl(user)], { encoding: 'utf8', env: env(), maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`local query failed: ${r.stderr.trim()}`);
  const out = r.stdout.trim().split('\n').filter((l) => l && l !== 'BEGIN' && l !== 'COMMIT' && l !== 'SET').join('\n');
  return JSON.parse(out);
}

/** Runs a statement (or several) and returns psql's tuples-only output. */
export function localExec(sql, { user = 'supabase_admin' } = {}) {
  const r = spawnSync(psqlPath(), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql, connectionUrl(user)], { encoding: 'utf8', env: env() });
  if (r.status !== 0) throw new Error(`local statement failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
