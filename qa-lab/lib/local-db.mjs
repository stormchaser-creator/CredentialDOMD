// The LOCAL QA-lab database (supabase start). Nothing here can reach production:
// the connection string is built from `supabase status`, and connectionUrl()
// rebuilds it from a checked host, port and database name, so no part of the
// caller's URL can point libpq anywhere else (see localConnection()).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { stackStatus } from './stack.mjs';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** The only query parameter a lab database URL may carry (libpq also reads host, hostaddr, port, service... from the query). */
const ALLOWED_PARAMS = new Set(['sslmode']);
const SSLMODES = new Set(['disable', 'allow', 'prefer', 'require']);

/** Status of the local stack as reported by the Supabase CLI (JSON), or null when it is not running. */
export function supabaseStatus() {
  return stackStatus();
}

/**
 * The parts of a local database URL, checked. libpq lets the query string
 * override the authority (…@127.0.0.1:54322/postgres?host=db.example.com or
 * ?hostaddr=…, ?service=…, ?port=…), and treats a comma in the host as a list
 * of hosts, so checking `new URL(base).hostname` alone proves nothing. This
 * accepts a URL only when every part is plain: scheme postgres(ql), a loopback
 * host, a numeric port, a simple database name, and no query parameter but sslmode.
 */
export function localConnection(base) {
  let u;
  try { u = new URL(base); } catch { throw new Error('refusing a database URL that does not parse'); }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw new Error(`refusing a database URL with scheme ${u.protocol}`);
  if (!LOCAL_HOSTS.has(u.hostname)) throw new Error(`refusing a non-local database host: ${u.hostname}`);
  if (!/^\d{1,5}$/.test(u.port)) throw new Error('refusing a database URL without a numeric port');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) throw new Error('refusing a database URL whose database name is not a plain identifier');
  const params = [...u.searchParams.keys()];
  const bad = params.filter((k) => !ALLOWED_PARAMS.has(k));
  if (bad.length) throw new Error(`refusing a database URL with query parameter(s) ${[...new Set(bad)].join(', ')}: libpq would let them override the host`);
  if (params.length !== new Set(params).size) throw new Error('refusing a database URL with a repeated query parameter');
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode !== null && !SSLMODES.has(sslmode)) throw new Error(`refusing sslmode=${sslmode}`);
  if (u.hash) throw new Error('refusing a database URL with a fragment');
  return { host: u.hostname, port: u.port, database, password: decodeURIComponent(u.password), sslmode };
}

/** Connection URL for the local database as `user` (default supabase_admin, the local superuser). */
let cachedBase = null;
export function connectionUrl(user = 'supabase_admin') {
  const base = cachedBase || (cachedBase = process.env.QA_LAB_DB_URL || supabaseStatus()?.DB_URL || null);
  if (!base) throw new Error('The local QA-lab stack is not running. Start it with `npm run qa:up`.');
  const c = localConnection(base);
  if (!/^[a-z_][a-z0-9_]*$/.test(user)) throw new Error(`refusing database user ${user}`);
  // Rebuilt from the checked parts: nothing of the caller's text is passed on as is.
  // The local image gives every login role the stack's database password.
  return `postgresql://${user}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}${c.sslmode ? `?sslmode=${c.sslmode}` : ''}`;
}

/**
 * The environment psql runs with: the caller's, minus every libpq connection
 * variable (PGHOST, PGHOSTADDR, PGPORT, PGSERVICE, PGSERVICEFILE, PGOPTIONS...),
 * which would otherwise fill in or redirect what the URL leaves unset.
 */
export function psqlEnv(base = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(base)) if (!/^PG[A-Z_]+$/.test(k)) out[k] = v;
  return { ...out, LC_ALL: 'C', PGCONNECT_TIMEOUT: '10' };
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

const env = () => psqlEnv();

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
