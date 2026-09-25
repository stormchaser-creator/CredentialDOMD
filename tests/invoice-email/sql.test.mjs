import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pgBin, pgSkip } from "../credential-portal/postgresFixture.mjs";

// Migration 20260925130000_invoice_email_sends.sql against a real PostgreSQL:
// the two invoice columns the app will cache and write back, and the
// server-only sent-once ledger behind send-invoice-email's idempotency.
//
// Own port: node --test runs files in parallel and the other PostgreSQL
// suites hold their own.
const PORT = "58217";
const run = promisify(execFile);
const MIGRATION = fs.readFileSync(new URL("../../supabase/migrations/20260925130000_invoice_email_sends.sql", import.meta.url), "utf8");
const ROLLBACK = fs.readFileSync(new URL("../../docs/rollback/20260925130000_invoice_email_sends.rollback.sql", import.meta.url), "utf8");

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-email-"));
  const socket = path.join(root, "socket"); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PG"))), LC_ALL: "C" };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  await exec("initdb", ["-D", path.join(root, "data"), "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  await exec("pg_ctl", ["-D", path.join(root, "data"), "-l", path.join(root, "pg.log"), "-o", `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, "-w", "start"]);
  const sql = async (query, user = "postgres") => (await exec("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", PORT, "-U", user, "-d", "postgres", "-c", query])).stdout.trim();
  const tryRun = async (query, user) => { try { return { ok: true, out: await sql(query, user) }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const close = async () => { await exec("pg_ctl", ["-D", path.join(root, "data"), "-m", "fast", "-w", "stop"]); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, close };
}

// The Supabase roles, holding what a stock project hands them: every table
// privilege on new tables in public, through default privileges. The
// migration has to take that away from everyone but service_role.
const BASE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create role app_user login; grant authenticated to app_user;
  create role edge login; grant service_role to edge;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key, name text);
  create table public.invoices (id uuid primary key, user_id uuid not null references public.profiles(id), number text,
    total_amount numeric(12,2), terms text, payments jsonb, updated_at timestamptz);
  grant all on public.invoices to anon, authenticated, service_role;
  insert into public.profiles values ('00000000-0000-4000-8000-0000000000a1', 'Synthetic Physician');
  insert into public.invoices values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'INV-1', 700, 'Net 30', '[]', '2026-09-01T00:00:00Z');
`;
const P = "00000000-0000-4000-8000-0000000000a1";
const INV = "00000000-0000-4000-8000-0000000000b1";
const REQ = "00000000-0000-4000-8000-0000000000c1";
const insertRow = (status = "sending", request = REQ) => `insert into public.invoice_email_sends
  (user_id, invoice_id, client_request_id, status, recipient, subject) values ('${P}', '${INV}', '${request}', '${status}', 'billing@hospital.example', 'Invoice INV-1')`;

const shape = (pg) => pg.sql(`select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable, ' ' order by table_name, column_name)
  from information_schema.columns where table_schema = 'public'
  and (table_name = 'invoice_email_sends' or column_name in ('last_emailed_at', 'last_emailed_to'))`);

test("invoice email migration: shape, rerun, server-only ledger, one row per request, guarded rollback", { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);

  await t.test("applies cleanly, twice, with nullable invoice columns of the right types", async () => {
    await pg.sql(MIGRATION);
    const once = await shape(pg);
    await pg.sql(MIGRATION);
    assert.equal(await shape(pg), once, "a second run changes nothing");
    assert.match(once, /invoices\.last_emailed_at:timestamp with time zone:YES/);
    assert.match(once, /invoices\.last_emailed_to:text:YES/);
    assert.match(once, /invoice_email_sends\.client_request_id:uuid:NO/);
    assert.match(once, /invoice_email_sends\.status:text:NO/);
  });

  await t.test("the app's full-row invoice write, with the new keys null or set, still lands and changes no amount", async () => {
    await pg.sql(`update public.invoices set last_emailed_at = null, last_emailed_to = null, total_amount = 700, terms = 'Net 30' where id = '${INV}'`);
    await pg.sql(`update public.invoices set last_emailed_at = '2026-09-25T15:00:00Z', last_emailed_to = 'billing@hospital.example' where id = '${INV}'`);
    assert.equal(await pg.sql(`select total_amount || '|' || terms || '|' || (updated_at = '2026-09-01T00:00:00Z') from public.invoices`), "700.00|Net 30|true");
  });

  await t.test("the ledger is service_role only: RLS on, no policy, nothing for anon or authenticated", async () => {
    assert.equal(await pg.sql(`select relrowsecurity from pg_class where oid = 'public.invoice_email_sends'::regclass`), "t");
    assert.equal(await pg.sql(`select count(*) from pg_policy where polrelid = 'public.invoice_email_sends'::regclass`), "0");
    const grants = await pg.sql(`select string_agg(grantee || ':' || privilege_type, ' ' order by grantee, privilege_type)
      from information_schema.role_table_grants where table_name = 'invoice_email_sends' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`);
    assert.equal(grants, "service_role:DELETE service_role:INSERT service_role:SELECT service_role:UPDATE");
    const asUser = await pg.tryRun(`select count(*) from public.invoice_email_sends`, "app_user");
    assert.equal(asUser.ok, false);
    assert.match(asUser.err, /permission denied/);
    const writeAsUser = await pg.tryRun(insertRow(), "app_user");
    assert.equal(writeAsUser.ok, false);
    const asEdge = await pg.tryRun(`set role service_role; ${insertRow()}; select count(*) from public.invoice_email_sends;`, "edge");
    assert.ok(asEdge.ok, asEdge.err);
    const truncate = await pg.tryRun(`set role service_role; truncate public.invoice_email_sends;`, "edge");
    assert.equal(truncate.ok, false, "no TRUNCATE for the function's role");
  });

  await t.test("one row per (account, request id): a second claim of the same request conflicts", async () => {
    const dup = await pg.tryRun(insertRow());
    assert.equal(dup.ok, false);
    assert.match(dup.err, /invoice_email_sends_request_uniq/);
    const bad = await pg.tryRun(insertRow("mailed", "00000000-0000-4000-8000-0000000000c2"));
    assert.equal(bad.ok, false, "status is one of the four");
    // A failed attempt can be claimed again, once, conditionally.
    await pg.sql(`update public.invoice_email_sends set status = 'failed' where client_request_id = '${REQ}'`);
    const first = await pg.sql(`update public.invoice_email_sends set status = 'sending', attempts = attempts + 1 where client_request_id = '${REQ}' and status = 'failed' and attempts = 1 returning attempts`);
    const second = await pg.sql(`update public.invoice_email_sends set status = 'sending', attempts = attempts + 1 where client_request_id = '${REQ}' and status = 'failed' and attempts = 1 returning attempts`);
    assert.equal(first, "2");
    assert.equal(second, "", "the loser of the race gets nothing");
  });

  await t.test("rollback refuses once an invoice has been emailed, then drops cleanly once it has not", async () => {
    await pg.sql(`update public.invoice_email_sends set status = 'sent', sent_at = now()`);
    const refused = await pg.tryRun(ROLLBACK);
    assert.equal(refused.ok, false);
    assert.match(refused.err, /invoices have been emailed/);
    await pg.sql(`delete from public.invoice_email_sends`);
    const stamped = await pg.tryRun(ROLLBACK);
    assert.equal(stamped.ok, false);
    assert.match(stamped.err, /carries last_emailed_at/);
    await pg.sql(`update public.invoices set last_emailed_at = null, last_emailed_to = null`);
    await pg.sql(ROLLBACK);
    assert.equal(await shape(pg), "");
    await pg.sql(MIGRATION);
    assert.notEqual(await shape(pg), "", "and it applies again afterwards");
  });

  await t.test("a pre-existing column of the wrong type is refused, not accepted", async () => {
    await pg.sql(`alter table public.invoices drop column last_emailed_at; alter table public.invoices add column last_emailed_at text`);
    const res = await pg.tryRun(MIGRATION);
    assert.equal(res.ok, false);
    assert.match(res.err, /wrong column type: invoices\.last_emailed_at is text/);
  });
});
