// Opt-in fixture only. Reuses pinned local images, owns uniquely named
// containers/network, and exposes only its synthetic REST port on loopback.
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const images = { database: 'public.ecr.aws/supabase/postgres:17.6.1.143', rest: 'public.ecr.aws/supabase/postgrest:v14.14' };
const docker = async (...args) => (await exec('docker', args, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function startIsolatedPostgrest(schema, jwtSecret) {
  for (const image of Object.values(images)) await docker('image', 'inspect', image);
  const prefix = `codex-operational-json-check-${process.pid}-${randomUUID().slice(0, 8)}`;
  const database = `${prefix}-db`, rest = `${prefix}-rest`, network = `${prefix}-net`;
  const cleanup = async () => {
    for (const container of [rest, database]) await docker('rm', '-f', '-v', container).catch(() => {});
    await docker('network', 'rm', network).catch(() => {});
  };
  const sql = query => {
    const result = spawnSync('docker', ['exec', '-i', database, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
      { input: query, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Disposable fixture SQL failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    await docker('network', 'create', network);
    await docker('run', '--detach', '--pull', 'never', '--name', database, '--network', network,
      '--env', 'POSTGRES_PASSWORD=synthetic-fixture-only', images.database);
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await docker('exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'); ready = true; break; } catch { await pause(250); }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready.');
    sql(schema);
    await docker('run', '--detach', '--pull', 'never', '--name', rest, '--network', network,
      '--publish', '127.0.0.1::3000', '--env', `PGRST_DB_URI=postgres://postgres:synthetic-fixture-only@${database}:5432/postgres`,
      '--env', 'PGRST_DB_SCHEMAS=public', '--env', 'PGRST_DB_ANON_ROLE=authenticated', '--env', `PGRST_JWT_SECRET=${jwtSecret}`, images.rest);
    const binding = await docker('port', rest, '3000/tcp');
    if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('Disposable REST binding is not loopback-only.');
    const url = `http://${binding}`;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return { url, sql, cleanup }; } catch { /* startup */ }
      await pause(250);
    }
    throw new Error('Disposable PostgREST did not become ready.');
  } catch (error) {
    const logs = await Promise.all([database, rest].map(name => docker('logs', '--tail', '20', name).catch(() => 'No fixture logs')));
    await cleanup(); throw new Error(`${error.message}\nDisposable REST logs: ${logs}`);
  }
}
