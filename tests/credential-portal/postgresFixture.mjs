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

const migration = name => fs.readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
function extract(source, pattern, label) {
  const found = source.match(pattern);
  if (!found) throw new Error(`fixture could not find ${label} in its migration; the production definition moved`);
  return found[0];
}

// The production definitions of the two prerequisites every access check
// leans on, read out of their real migrations rather than restated here, so a
// change to either reaches these tests: account_is_closed (tombstones OR
// profiles.deleted_at) and clerk_storage_subjects (current subject plus the
// bound legacy one).
const accountEvents = migration('20260918a_mailbox_account_events.sql');
const continuity = migration('20260920120000_clerk_identity_continuity.sql');
const PREREQUISITES = [
  extract(accountEvents, /create table if not exists public\.account_tombstones \([\s\S]*?\n\);/, 'account_tombstones'),
  extract(accountEvents, /create or replace function public\.account_is_closed\(p_profile uuid\)[\s\S]*?\$\$;/, 'account_is_closed'),
  'revoke all on function public.account_is_closed(uuid) from public; grant execute on function public.account_is_closed(uuid) to postgres, service_role;',
  extract(continuity, /create table if not exists public\.clerk_continuity_runs \([\s\S]*?\n\);/, 'clerk_continuity_runs'),
  extract(continuity, /create table if not exists public\.clerk_continuity_accounts \([\s\S]*?\n\);/, 'clerk_continuity_accounts'),
  extract(continuity, /create or replace function public\.clerk_storage_subjects\(p_profile uuid\)[\s\S]*?\$\$;/, 'clerk_storage_subjects'),
  'revoke all on function public.clerk_storage_subjects(uuid) from public,anon,authenticated; grant execute on function public.clerk_storage_subjects(uuid) to service_role;',
].join('\n');

// Production column shapes (information_schema, 2026-09-25) for every table the
// portal reads: NOT NULL where production has it, linked_to on documents, both
// work_history current columns, jsonb where production stores jsonb. The first
// columns keep the order older positional inserts in these tests rely on.
const PRODUCTION_SHAPE = `
create table profiles(id uuid primary key, auth_user_id text unique, access_status text not null default 'active',
  name text, npi text, degree_type text, primary_state text, phone text, email text, specialties jsonb, address text,
  website text, languages text, additional_states jsonb, tax_prep jsonb, notes text, verified_email text, deleted_at timestamptz);
create table documents(id uuid primary key, user_id uuid not null references profiles(id), name text not null, mime_type text not null,
  size_bytes integer, storage_path text not null, linked_to text, uploaded_at timestamptz, created_at timestamptz default now(), type text,
  size bigint, updated_at timestamptz, favorite boolean);
create table licenses(id uuid primary key, user_id uuid not null, type text not null, name text, license_number text, state text,
  issued_date date, expiration_date date, notes text, npi_imported boolean, created_at timestamptz, updated_at timestamptz,
  custom_fields jsonb, renewal_cost numeric, cme_cycle_start date, favorite boolean);
create table cme(id uuid primary key, user_id uuid not null, title text, category text not null, hours numeric, date date, provider text,
  certificate_number text, topics jsonb, notes text, created_at timestamptz, updated_at timestamptz, custom_fields jsonb, favorite boolean);
create table privileges(id uuid primary key, user_id uuid not null, type text not null, name text, facility text, state text,
  appointment_date date, expiration_date date, notes text, created_at timestamptz, updated_at timestamptz, custom_fields jsonb,
  city text, portal_url text, login_username text, login_secret text, favorite boolean);
create table insurance(id uuid primary key, user_id uuid not null, type text not null, name text, provider text, policy_number text,
  coverage_per_claim text, coverage_aggregate text, effective_date date, expiration_date date, notes text, created_at timestamptz,
  updated_at timestamptz, custom_fields jsonb, favorite boolean);
create table health_records(id uuid primary key, user_id uuid not null, category text not null, type text, name text,
  date_administered date, expiration_date date, result text, lot_number text, facility text, doses jsonb, notes text,
  created_at timestamptz, updated_at timestamptz, result_value text, result_units text, reference_range text, collected_date date,
  reported_date date, lab text, specimen_id text, ordered_by text, custom_fields jsonb, favorite boolean);
create table education(id uuid primary key, user_id uuid not null, type text not null, name text, institution text,
  graduation_date date, field_of_study text, honors text, notes text, created_at timestamptz, updated_at timestamptz,
  custom_fields jsonb, start_date date, favorite boolean);
create table work_history(id uuid primary key, user_id uuid not null, type text not null, position text, employer text, city text,
  state text, start_date date, end_date date, is_current boolean, description text, reason_for_leaving text, notes text,
  created_at timestamptz, updated_at timestamptz, current boolean, custom_fields jsonb, favorite boolean);
create table screenings(id uuid primary key, user_id uuid not null, type text, name text, agency text, requested_by text,
  assignment text, file_number text, order_date date, report_date date, result text, expiration_date date, components jsonb,
  notes text, created_at timestamptz, updated_at timestamptz, custom_fields jsonb, favorite boolean);
create table professional_photos(id uuid primary key, user_id uuid not null, name text, date_taken date, notes text,
  custom_fields jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), favorite boolean);
create table publications(id uuid primary key, user_id uuid not null, name text, citation text, year text, doi text, pmid text,
  url text, sort_order integer, notes text, custom_fields jsonb, created_at timestamptz, updated_at timestamptz, favorite boolean);
create table professional_memberships(id uuid primary key, user_id uuid not null, name text, organization text, role text,
  start_date date, end_date date, notes text, custom_fields jsonb, created_at timestamptz, updated_at timestamptz, cost numeric,
  expiration_date date, favorite boolean);
create table malpractice_history(id uuid primary key, user_id uuid not null, date_of_incident date, date_filed date, state text,
  outcome text, settlement_amount text, description text, facility text, insurance_carrier text, date_resolved date, notes text,
  created_at timestamptz, updated_at timestamptz, custom_fields jsonb, favorite boolean);
create table peer_references(id uuid primary key, user_id uuid not null, name text, degree text, specialty text, institution text,
  relationship text not null, email text, phone text, years_known text, notes text, created_at timestamptz, updated_at timestamptz,
  custom_fields jsonb, known_since text, favorite boolean);
create table case_logs(id uuid primary key, user_id uuid not null, category text not null, title text, date date, facility text,
  role text, cpt_codes text, notes text, created_at timestamptz, updated_at timestamptz, custom_fields jsonb, w_rvu numeric,
  attending text, complication text, source text, favorite boolean);
create table custom_categories(id uuid primary key, user_id uuid not null, name text, slug text, icon text, description text,
  fields jsonb, aliases jsonb, origin text, sort_order integer, archived_at timestamptz, custom_fields jsonb, favorite boolean,
  created_at timestamptz, updated_at timestamptz);
create table custom_records(id uuid primary key, user_id uuid not null, category_id uuid, category_name text, field_labels jsonb,
  name text, issuer text, number text, issued_date date, expiration_date date, field_values jsonb, custom_fields jsonb, notes text,
  document_ids jsonb, favorite boolean, created_at timestamptz, updated_at timestamptz);
create table travel_docs(id uuid primary key, user_id uuid not null, type text, name text, number text, expiration_date date, notes text);
create table travel_expenses(id uuid primary key, user_id uuid not null, name text, amount numeric, notes text);
create table locum_contracts(id uuid primary key, user_id uuid not null, facility text, day_rate numeric, notes text);
`;

export async function postgresFixture({ port = 56441 } = {}) {
  const bin = pgBin();
  // os.tmpdir(), not a hardcoded /private/tmp: that path is macOS only and
  // does not exist on a Linux CI runner.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-portal-')); const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  // LC_ALL is required, not cosmetic: on macOS the postmaster aborts at
  // startup with "postmaster became multithreaded during startup" unless a
  // valid locale is set, so without this the fixture cannot start at all.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  await run('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await run('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket} -p ${port} -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off`, '-w', 'start']);
  const sql = async (query, user = 'service_role') => {
    const { stdout } = await run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', String(port), '-U', user, '-d', 'postgres', '-c', query]); return stdout.trim();
  };
  await sql(`create role anon login; create role authenticated login; create role service_role login bypassrls;
    ${PRODUCTION_SHAPE}
    ${PREREQUISITES}
    do $$ declare t text; begin
      for t in select tablename from pg_tables where schemaname='public' loop
        execute format('alter table public.%I enable row level security', t);
        execute format('grant select on public.%I to service_role', t);
      end loop;
    end $$;
    grant update on profiles to service_role;`, 'postgres');
  // Both portal migrations, each applied twice: the follow-on must apply on
  // top of the original and be idempotent.
  const portal = migration('20260918091000_credential_portal.sql');
  const administratorAccess = migration('20260925040000_credential_portal_admin_access.sql');
  await sql(portal, 'postgres'); await sql(portal, 'postgres');
  await sql(administratorAccess, 'postgres'); await sql(administratorAccess, 'postgres');
  return {
    root, sql,
    rows: async (query, user) => JSON.parse(await sql(`select coalesce(json_agg(q),'[]'::json) from (${query}) q`, user)),
    rpc: async (name, args, user) => JSON.parse(await sql(`select to_json(public.credential_portal_${name}(${args.map(quote).join(',')}))`, user) || 'null'),
    async close() { await run('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
