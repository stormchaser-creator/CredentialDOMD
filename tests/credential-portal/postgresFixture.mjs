import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Where the PostgreSQL binaries are, and whether they are there at all. */
export const pgBin = () => process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
/** A machine without PostgreSQL should skip these, not fail a deploy. */
export const pgSkip = () => fs.existsSync(path.join(pgBin(), 'initdb')) ? false : `PostgreSQL not found at ${pgBin()}; set PG_BIN`;
const exec = promisify(execFile);
export const quote = value => value === null || value === undefined ? 'null' : typeof value === 'boolean' || typeof value === 'number' ? String(value) : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'`;
export async function postgresFixture() {
  const bin = pgBin();
  // os.tmpdir(), not a hardcoded /private/tmp: that path is macOS only and
  // does not exist on a Linux CI runner.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-portal-')); const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  // LC_ALL is required, not cosmetic: on macOS the postmaster aborts at
  // startup with "postmaster became multithreaded during startup" unless a
  // valid locale is set, so without this the fixture cannot start at all.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(bin, name), args, { env, maxBuffer: 2 * 1024 * 1024 });
  await run('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await run('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket} -p 56441 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off`, '-w', 'start']);
  const sql = async (query, user = 'service_role') => {
    const { stdout } = await run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '56441', '-U', user, '-d', 'postgres', '-c', query]); return stdout.trim();
  };
  await sql(`create role anon login; create role authenticated login; create role service_role login bypassrls;
    create table profiles(id uuid primary key,auth_user_id text unique,access_status text);
    create table documents(id uuid primary key,user_id uuid not null references profiles(id),name text,mime_type text,size_bytes integer,storage_path text);
    alter table profiles enable row level security; alter table documents enable row level security;
    grant select on documents to service_role; grant select,update on profiles to service_role;`, 'postgres');
  const migration = fs.readFileSync(new URL('../../supabase/migrations/20260918091000_credential_portal.sql', import.meta.url), 'utf8');
  await sql(migration, 'postgres'); await sql(migration, 'postgres');
  return {
    root, sql,
    rows: async (query, user) => JSON.parse(await sql(`select coalesce(json_agg(q),'[]'::json) from (${query}) q`, user)),
    rpc: async (name, args, user) => JSON.parse(await sql(`select to_json(public.credential_portal_${name}(${args.map(quote).join(',')}))`, user) || 'null'),
    async close() { await run('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
