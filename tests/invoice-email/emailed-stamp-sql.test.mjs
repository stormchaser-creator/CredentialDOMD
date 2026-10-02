import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from "../credential-portal/postgresFixture.mjs";

// Review of release/goal2 (2026-10-01): an invoice sent with "Email it for
// me" is recorded only once the send is confirmed, and its row arrived with
// last_emailed_at / last_emailed_to forced to null, so "Emailed <date> to
// <address>" never showed. Migration 20261002040000 stamps the row from the
// sent-once ledger as it is inserted. On a real, disposable PostgreSQL,
// never production. Synthetic ids and addresses only.

const PORT = "58247";
const run = promisify(execFile);
const LEDGER = fs.readFileSync(new URL("../../supabase/migrations/20260925130000_invoice_email_sends.sql", import.meta.url), "utf8");
const MIGRATION = fs.readFileSync(new URL("../../supabase/migrations/20261002040000_invoice_emailed_stamp_on_record.sql", import.meta.url), "utf8");
const ROLLBACK = fs.readFileSync(new URL("../../docs/rollback/20261002040000_invoice_emailed_stamp_on_record.rollback.sql", import.meta.url), "utf8");

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-emailed-stamp-"));
  const socket = path.join(root, "socket"); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PG"))), LC_ALL: "C" };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, "data"));
  await exec("initdb", ["-D", path.join(root, "data"), "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  await exec("pg_ctl", ["-D", path.join(root, "data"), "-l", path.join(root, "pg.log"), "-o", `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, "-w", "start"]);
  const sql = async (query, user = "postgres") => (await exec("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", PORT, "-U", user, "-d", "postgres", "-c", query])).stdout.trim();
  const close = async () => { await exec("pg_ctl", ["-D", path.join(root, "data"), "-m", "fast", "-w", "stop"]); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, close };
}

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
  insert into public.profiles values ('00000000-0000-4000-8000-0000000000a1', 'Synthetic Physician'), ('00000000-0000-4000-8000-0000000000a2', 'Other Physician');
`;
const P = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const DRAFT = "00000000-0000-4000-8000-0000000000d1";
const PLAIN = "00000000-0000-4000-8000-0000000000d2";
const send = (invoice, request, status, sentAt, to, user = P) => `insert into public.invoice_email_sends
  (user_id, invoice_id, client_request_id, status, recipient, subject, sent_at)
  values ('${user}', '${invoice}', '${request}', '${status}', '${to}', 'Invoice', ${sentAt ? `'${sentAt}'` : "null"})`;
const stampOf = (pg, id) => pg.sql(`select coalesce(to_char(last_emailed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI'), 'null') || '|' || coalesce(last_emailed_to, 'null') from public.invoices where id = '${id}'`);

test("an invoice emailed before it was recorded is stamped from the ledger as its row arrives", { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE);
  await pg.sql(LEDGER);
  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION); // a second run changes nothing

  await t.test("the app's insert (a user token, the stamp forced to null) lands stamped with the latest confirmed send", async () => {
    await pg.sql(send(DRAFT, "00000000-0000-4000-8000-0000000000c1", "sent", "2026-09-30T15:00:00Z", "billing@agency.example"));
    await pg.sql(send(DRAFT, "00000000-0000-4000-8000-0000000000c2", "sent", "2026-10-01T09:30:00Z", "ap@agency.example"));
    // A later attempt that never went, and another account's send of the same id, count for nothing.
    await pg.sql(send(DRAFT, "00000000-0000-4000-8000-0000000000c3", "unknown", null, "maybe@agency.example"));
    await pg.sql(send(DRAFT, "00000000-0000-4000-8000-0000000000c4", "sent", "2026-10-01T12:00:00Z", "someone@else.example", OTHER));
    await pg.sql(`set role authenticated; insert into public.invoices (id, user_id, number, total_amount, last_emailed_at, last_emailed_to)
      values ('${DRAFT}', '${P}', 'INV-20261001-03', 6000, '2020-01-01T00:00:00Z', 'forged@example.test')`, "app_user");
    assert.equal(await stampOf(pg, DRAFT), "2026-10-01T09:30|ap@agency.example");
  });

  await t.test("the self-heal's upsert of the same row keeps it; an invoice never emailed stays unstamped", async () => {
    await pg.sql(`set role authenticated; insert into public.invoices (id, user_id, number, total_amount, last_emailed_at, last_emailed_to)
      values ('${DRAFT}', '${P}', 'INV-20261001-03', 6000, null, null)
      on conflict (id) do update set total_amount = excluded.total_amount, last_emailed_at = excluded.last_emailed_at, last_emailed_to = excluded.last_emailed_to`, "app_user");
    assert.equal(await stampOf(pg, DRAFT), "2026-10-01T09:30|ap@agency.example");
    await pg.sql(`set role authenticated; insert into public.invoices (id, user_id, number) values ('${PLAIN}', '${P}', 'INV-20261001-04')`, "app_user");
    assert.equal(await stampOf(pg, PLAIN), "null|null");
  });

  await t.test("nobody but postgres and service_role may execute the trigger function", async () => {
    const acl = await pg.sql(`select coalesce(array_to_string(proacl, ','), '') from pg_proc where proname = 'invoices_stamp_from_email_ledger'`);
    assert.doesNotMatch(acl, /(^|,)=X/, "no PUBLIC execute");
    assert.doesNotMatch(acl, /anon=|authenticated=/);
  });

  await t.test("the rollback drops it and leaves the stamps it wrote", async () => {
    await pg.sql(ROLLBACK);
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select count(*) from pg_trigger where tgname = 'invoices_stamp_from_email_ledger'`), "0");
    assert.equal(await stampOf(pg, DRAFT), "2026-10-01T09:30|ap@agency.example");
    await pg.sql(`delete from public.invoices where id = '${PLAIN}'`);
    await pg.sql(`set role authenticated; insert into public.invoices (id, user_id, number) values ('${PLAIN}', '${P}', 'INV-20261001-04')`, "app_user");
    assert.equal(await stampOf(pg, PLAIN), "null|null");
  });
});
