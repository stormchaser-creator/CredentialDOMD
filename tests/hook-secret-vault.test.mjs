import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pgBin, pgSkip } from "./credential-portal/postgresFixture.mjs";

// No function body, cron command or SQL file in this repo may carry a literal
// hook secret. Until 20260925140000_hook_secret_vault.sql the x-hook-secret
// value sat in five SECURITY DEFINER bodies and the send-reminders-daily cron
// command, where any role that can read the catalog could read it. The
// migration moves it to Vault and every caller reads it at call time.
//
// The PostgreSQL half rebuilds the production shape from before the migration
// (pg_get_functiondef, 2026-09-25, with a synthetic value), proves the audit
// query finds every copy there, applies the migration twice, and checks the
// callers still send the right secret to the right function, and that
// notify_ticket_reply still skips a reply the ticket owner writes.
//
// Own port: node --test runs files in parallel.
const PORT = "58241";
const run = promisify(execFile);
const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const MIGRATION = read("supabase/migrations/20260925140000_hook_secret_vault.sql");
const ROLLBACK = read("docs/rollback/20260925140000_hook_secret_vault.rollback.sql");
const AUDIT = read("scripts/sql/hook-secret-audit.sql");

// A header built from a quoted value: 'x-hook-secret', '...' in SQL or
// "x-hook-secret": "..." in JSON. %L and a variable are not quoted, so they
// do not match; the one placeholder an old migration uses is allowed.
const HEADER_LITERAL = /['"]x-hook-secret['"]\s*[,:]\s*['"]([^'"]+)['"]/g;
const PLACEHOLDERS = new Set(["__HOOK_SECRET__"]);

function sqlAndFunctionFiles() {
  const root = new URL("../", import.meta.url).pathname;
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(sql|ts|mjs|js)$/.test(entry.name)) out.push(full);
    }
  };
  for (const dir of ["supabase/migrations", "supabase/functions", "docs/rollback", "scripts/sql"]) walk(path.join(root, dir));
  return out.map(full => ({ file: path.relative(root, full), text: fs.readFileSync(full, "utf8") }));
}

test("no migration, rollback, SQL script or edge function writes a hook secret literal", () => {
  const files = sqlAndFunctionFiles();
  assert.ok(files.some(f => f.file.endsWith("20260925140000_hook_secret_vault.sql")), "the scan reaches the migrations");
  const found = files.flatMap(({ file, text }) =>
    [...text.matchAll(HEADER_LITERAL)].filter(m => !PLACEHOLDERS.has(m[1])).map(m => `${file}: ${m[0].slice(0, 40)}`));
  assert.deepEqual(found, []);
});

test("the literal check catches both header forms and lets a variable through", () => {
  const hits = text => [...text.matchAll(HEADER_LITERAL)].map(m => m[1]);
  assert.deepEqual(hits(`jsonb_build_object('Content-Type','application/json','x-hook-secret','abc123')`), ["abc123"]);
  assert.deepEqual(hits(`jsonb_build_object('x-hook-secret', 'abc123')`), ["abc123"]);
  assert.deepEqual(hits(`'{"x-hook-secret": "abc123"}'::jsonb`), ["abc123"]);
  assert.deepEqual(hits(`jsonb_build_object('x-hook-secret', hook_secret)`), []);
  assert.deepEqual(hits(`jsonb_build_object('x-hook-secret',%L)`), []);
  // A CORS allow-list names the header without quoting it on its own.
  assert.deepEqual(hits(`"Access-Control-Allow-Headers": "content-type, x-hook-secret",\n  "Access-Control-Allow-Methods": "POST"`), []);
});

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-secret-"));
  const socket = path.join(root, "socket"); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PG"))), LC_ALL: "C" };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  await exec("initdb", ["-D", path.join(root, "data"), "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  await exec("pg_ctl", ["-D", path.join(root, "data"), "-l", path.join(root, "pg.log"), "-o", `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, "-w", "start"]);
  const full = (query, { user = "postgres", db = "postgres" } = {}) =>
    exec("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", PORT, "-U", user, "-d", db, "-c", query]);
  const sql = async (query, opts) => (await full(query, opts)).stdout.trim();
  const tryRun = async (query, opts) => { try { const r = await full(query, opts); return { ok: true, out: r.stdout.trim(), err: r.stderr }; } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; } };
  const close = async () => { await exec("pg_ctl", ["-D", path.join(root, "data"), "-m", "fast", "-w", "stop"]); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, close };
}

const LIT = "synthetic-hook-secret-0123456789abcdefghijklmnop";
const ROTATED = "rotated-synthetic-hook-secret-QRSTUVWXYZ0123456";
const URL_BASE = "https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/";

const ROLES = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create role app_user login; grant authenticated to app_user;
`;

// Vault, pg_net and pg_cron reduced to what the callers touch, with Vault's
// production grants: service_role reads, anon and authenticated have nothing.
// net.http_post records the call instead of sending it.
const PLATFORM = `
  create schema vault;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text not null default '',
    secret text not null, key_id uuid, nonce bytea, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create unique index secrets_name_idx on vault.secrets (name) where name is not null;
  create view vault.decrypted_secrets as
    select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at, updated_at from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
    returns uuid language sql as $$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
    returns void language sql as $$ update vault.secrets s set secret = coalesce(new_secret, s.secret), updated_at = now() where s.id = secret_id $$;
  revoke all on schema vault from public;
  grant usage on schema vault to service_role;
  grant select on vault.secrets, vault.decrypted_secrets to service_role;

  create schema net;
  create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds integer);
  create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
    headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
    returns bigint language sql as $$ insert into net.calls (url, body, headers, timeout_milliseconds) values (url, body, headers, timeout_milliseconds) returning id $$;

  create schema cron;
  create table cron.job (jobid bigserial primary key, schedule text not null, command text not null, username text not null default current_user,
    active boolean not null default true, jobname text);
  create function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null,
    username text default null, active boolean default null) returns void language sql as $$
    update cron.job j set schedule = coalesce(alter_job.schedule, j.schedule), command = coalesce(alter_job.command, j.command),
      active = coalesce(alter_job.active, j.active) where j.jobid = job_id $$;

  create table public.profiles (id uuid primary key, email text, access_status text not null default 'pending', backup_monthly boolean,
    data_deletion_date timestamptz, deleted_at timestamptz, created_at timestamptz not null default now());
  create table public.app_admins (profile_id uuid primary key references public.profiles(id));
  create function public.is_admin(user_id uuid) returns boolean language sql stable security definer set search_path = public
    as $$ select exists (select 1 from app_admins a where a.profile_id = user_id) $$;
  create table public.support_tickets (id uuid primary key, user_id uuid not null references public.profiles(id), subject text not null,
    body text not null, category text not null default 'other', status text not null default 'open');
  create table public.support_messages (id uuid primary key default gen_random_uuid(), ticket_id uuid not null references public.support_tickets(id),
    author_id uuid not null references public.profiles(id), body text not null, is_admin_reply boolean default false,
    created_at timestamptz default now(), attachment_path text);
  create table public.early_access_leads (id uuid primary key default gen_random_uuid(), email text, note text, created_at timestamptz default now());
  grant usage on schema public to anon, authenticated, service_role;
  grant select, insert on public.support_messages, public.support_tickets to authenticated;
`;

// Production before the migration: the five bodies as pg_get_functiondef
// printed them, and the reminders cron command, each carrying the literal.
const preState = (lit, guideLit = lit) => `
  create or replace function public.welcome_new_lead() returns trigger language plpgsql security definer set search_path to 'public' as $function$
    begin
      if NEW.note = 'guide' or NEW.note like 'guide-email %' then
        return NEW;
      end if;
      perform net.http_post(
        url := '${URL_BASE}send-welcome',
        headers := jsonb_build_object('Content-Type','application/json','x-hook-secret','${lit}'),
        body := jsonb_build_object('record', to_jsonb(NEW))
      );
      return NEW;
    end
    $function$;
  create or replace function public.notify_ticket_reply() returns trigger language plpgsql security definer set search_path to 'public' as $function$
    declare
      owner_id uuid;
    begin
      if not public.is_admin(new.author_id) then
        return new;
      end if;
      select user_id into owner_id from public.support_tickets where id = new.ticket_id;
      if owner_id is null or owner_id = new.author_id then
        return new;
      end if;
      perform net.http_post(
        url := '${URL_BASE}send-ticket-reply',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', '${lit}'),
        body := jsonb_build_object('record', to_jsonb(new))
      );
      return new;
    end
    $function$;
  create or replace function public.dispatch_monthly_backups() returns integer language plpgsql security definer set search_path to 'public' as $function$
    declare
      r     record;
      fired integer := 0;
    begin
      for r in select p.id from public.profiles p where p.backup_monthly is true and p.access_status = 'active' order by p.created_at
      loop
        perform net.http_post(
          url     := '${URL_BASE}build-backup',
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', '${lit}'),
          body    := jsonb_build_object('profile_id', r.id)
        );
        fired := fired + 1;
      end loop;
      return fired;
    end
    $function$;
  create or replace function public.dispatch_guide_emails() returns void language plpgsql security definer set search_path to 'public' as $function$
    begin
      perform net.http_post(
        url     := '${URL_BASE}send-guide',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', '${guideLit}'),
        body    := '{}'::jsonb
      );
    end
    $function$;
  create or replace function public.dispatch_account_deletions() returns integer language plpgsql security definer set search_path to 'public' as $function$
    declare
      r     record;
      fired integer := 0;
    begin
      for r in
        select p.id from public.profiles p
         where p.data_deletion_date is not null and p.data_deletion_date < now()
           and (p.deleted_at is null or p.deleted_at < p.data_deletion_date)
         order by p.data_deletion_date
      loop
        perform net.http_post(
          url     := '${URL_BASE}delete-account',
          headers := jsonb_build_object('Content-Type','application/json','x-hook-secret','${lit}'),
          body    := jsonb_build_object('profile_id', r.id, 'dry_run', false, 'requested_by', 'scheduled'),
          timeout_milliseconds := 120000
        );
        fired := fired + 1;
      end loop;
      return fired;
    end
    $function$;
  do $$ declare f text; begin
    foreach f in array array['welcome_new_lead()','notify_ticket_reply()','dispatch_monthly_backups()','dispatch_guide_emails()','dispatch_account_deletions()'] loop
      execute format('revoke all on function public.%s from public', f);
      execute format('grant execute on function public.%s to postgres, service_role', f);
    end loop;
  end $$;
  create trigger trg_notify_ticket_reply after insert on public.support_messages for each row execute function public.notify_ticket_reply();
  create trigger trg_welcome_lead after insert on public.early_access_leads for each row execute function public.welcome_new_lead();
  insert into cron.job (jobname, schedule, command) values
    ('send-reminders-daily', '0 13 * * *', E'\\n  select net.http_post(\\n    url := ''${URL_BASE}send-reminders'',\\n    headers := jsonb_build_object(''Content-Type'',''application/json'',''x-hook-secret'',''${lit}''),\\n    body := ''{}''::jsonb\\n  );\\n  '),
    ('send-guide-sweep', '*/10 * * * *', ' select public.dispatch_guide_emails(); ');
`;

const ADMIN = "00000000-0000-4000-8000-00000000ad01";
const MEMBER = "00000000-0000-4000-8000-00000000be01";
const BACKER = "00000000-0000-4000-8000-00000000be02";
const LEAVER = "00000000-0000-4000-8000-00000000be03";
const MEMBER_TICKET = "00000000-0000-4000-8000-00000000c001";
const ADMIN_TICKET = "00000000-0000-4000-8000-00000000c002";
const FIVE = ["dispatch_account_deletions()", "dispatch_guide_emails()", "dispatch_monthly_backups()", "notify_ticket_reply()", "welcome_new_lead()"];

test("hook secret vault migration: the audit finds every copy, then none; callers read the vault at call time", { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(ROLES);
  await pg.sql(PLATFORM);
  await pg.sql(preState(LIT));
  await pg.sql(`insert into public.profiles (id, email, access_status) values
      ('${ADMIN}', 'admin@example.test', 'active'), ('${MEMBER}', 'member@example.test', 'active');
    insert into public.app_admins values ('${ADMIN}');
    insert into public.support_tickets (id, user_id, subject, body) values
      ('${MEMBER_TICKET}', '${MEMBER}', 'Member question', 'Help'), ('${ADMIN_TICKET}', '${ADMIN}', 'Owner note', 'Mine');`);

  const audit = async () => (await pg.sql(AUDIT)).split("\n").filter(Boolean);
  let mark = 0;
  const calls = async () => {
    const rows = JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('id', id, 'url', url, 'secret', headers->>'x-hook-secret',
      'body', body, 'timeout', timeout_milliseconds) order by id), '[]') from net.calls where id > ${mark}`));
    if (rows.length) mark = rows.at(-1).id;
    return rows;
  };
  const adminReply = async (ticket, body = "Here is the answer") =>
    pg.sql(`set role authenticated; insert into public.support_messages (ticket_id, author_id, body, is_admin_reply)
      values ('${ticket}', '${ADMIN}', '${body}', true) returning id`, { user: "app_user" });

  await t.test("before: the audit finds the five bodies and the cron command", async () => {
    const rows = await audit();
    assert.deepEqual(rows, [
      "cron|cron job send-reminders-daily|x-hook-secret header literal",
      ...FIVE.map(f => `function|${f}|x-hook-secret header literal`),
    ]);
  });

  await t.test("applies twice; seeds the vault from the bodies; the audit then finds nothing", async () => {
    const jobBefore = await pg.sql(`select jobid || '|' || schedule || '|' || username || '|' || active from cron.job where jobname = 'send-reminders-daily'`);
    await pg.sql(MIGRATION);
    const bodies = await pg.sql(`select md5(string_agg(prosrc, '' order by proname)) from pg_proc where pronamespace = 'public'::regnamespace`);
    await pg.sql(MIGRATION);
    assert.equal(await pg.sql(`select md5(string_agg(prosrc, '' order by proname)) from pg_proc where pronamespace = 'public'::regnamespace`), bodies, "a second run changes nothing");
    assert.equal(await pg.sql(`select count(*) || '|' || (min(decrypted_secret) = '${LIT}') from vault.decrypted_secrets where name = 'welcome_hook_secret'`), "1|true");
    assert.deepEqual(await audit(), []);
    assert.equal(await pg.sql(`select count(*) from pg_proc where strpos(prosrc, '${LIT}') > 0`), "0");
    assert.equal(await pg.sql(`select count(*) from cron.job where strpos(command, '${LIT}') > 0`), "0");
    // Same job, same schedule and owner; only the command moved.
    assert.equal(await pg.sql(`select jobid || '|' || schedule || '|' || username || '|' || active from cron.job where jobname = 'send-reminders-daily'`), jobBefore);
    assert.equal(await pg.sql(`select command from cron.job where jobname = 'send-reminders-daily'`), "select public.dispatch_daily_reminders()");
    assert.equal(await pg.sql(`select command from cron.job where jobname = 'send-guide-sweep'`), "select public.dispatch_guide_emails();");
    for (const f of [...FIVE, "dispatch_daily_reminders()"]) {
      assert.match(await pg.sql(`select prosrc from pg_proc where oid = 'public.${f}'::regprocedure`), /vault\.decrypted_secrets where name = 'welcome_hook_secret'/, f);
    }
  });

  await t.test("an admin reply on a member's ticket calls send-ticket-reply with the vault secret, from a browser role that cannot read the vault", async () => {
    await calls();
    const denied = await pg.tryRun(`set role authenticated; select decrypted_secret from vault.decrypted_secrets`, { user: "app_user" });
    assert.equal(denied.ok, false);
    assert.match(denied.err, /permission denied for schema vault/);
    const id = await adminReply(MEMBER_TICKET);
    const sent = await calls();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, `${URL_BASE}send-ticket-reply`);
    assert.equal(sent[0].secret, LIT);
    assert.equal(sent[0].body.record.id, id);
    assert.equal(sent[0].body.record.ticket_id, MEMBER_TICKET);
    assert.equal(sent[0].body.record.author_id, ADMIN);
  });

  await t.test("recipients unchanged: the owner's own messages and a non-admin's reply send nothing", async () => {
    await calls();
    await adminReply(ADMIN_TICKET, "Note on my own ticket");
    await pg.sql(`set role authenticated; insert into public.support_messages (ticket_id, author_id, body) values ('${MEMBER_TICKET}', '${MEMBER}', 'Thanks')`, { user: "app_user" });
    await pg.sql(`set role authenticated; insert into public.support_messages (ticket_id, author_id, body) values ('${ADMIN_TICKET}', '${MEMBER}', 'Not an admin')`, { user: "app_user" });
    assert.deepEqual(await calls(), []);
    assert.equal(await pg.sql(`select count(*) from public.support_messages`), "4", "every message was saved");
  });

  await t.test("a rotation in the vault reaches the next call with no function rewritten", async () => {
    const bodies = await pg.sql(`select md5(string_agg(prosrc, '' order by proname)) from pg_proc where pronamespace = 'public'::regnamespace`);
    await pg.sql(`select vault.update_secret(id, '${ROTATED}') from vault.secrets where name = 'welcome_hook_secret'`);
    await calls();
    await adminReply(MEMBER_TICKET, "After rotation");
    assert.deepEqual((await calls()).map(c => c.secret), [ROTATED]);
    assert.equal(await pg.sql(`select md5(string_agg(prosrc, '' order by proname)) from pg_proc where pronamespace = 'public'::regnamespace`), bodies);
    assert.deepEqual(await audit(), []);
  });

  await t.test("every other caller sends the same secret to its own function", async () => {
    await pg.sql(`insert into public.profiles (id, email, access_status, backup_monthly) values ('${BACKER}', 'b@example.test', 'active', true);
      insert into public.profiles (id, email, access_status, data_deletion_date) values ('${LEAVER}', 'l@example.test', 'active', now() - interval '1 day');`);
    await calls();
    await pg.sql(`insert into public.early_access_leads (email, note) values ('lead@example.test', null), ('guide@example.test', 'guide-email TX')`);
    assert.equal(await pg.sql(`select public.dispatch_monthly_backups()`), "1");
    assert.equal(await pg.sql(`select public.dispatch_account_deletions()`), "1");
    await pg.sql(`select public.dispatch_guide_emails()`);
    await pg.sql(`do $$ begin execute (select command from cron.job where jobname = 'send-reminders-daily'); end $$`);
    const sent = await calls();
    assert.deepEqual(sent.map(c => c.url.replace(URL_BASE, "")), ["send-welcome", "build-backup", "delete-account", "send-guide", "send-reminders"], "the guide lead is not welcomed");
    assert.ok(sent.every(c => c.secret === ROTATED));
    assert.equal(sent[0].body.record.email, "lead@example.test");
    assert.equal(sent[1].body.profile_id, BACKER);
    assert.deepEqual({ ...sent[2].body, timeout: sent[2].timeout }, { profile_id: LEAVER, dry_run: false, requested_by: "scheduled", timeout: 120000 });
  });

  await t.test("with the vault secret gone a reply is still saved and skips the email; the cron dispatchers fail loudly", async () => {
    await pg.sql(`delete from vault.secrets where name = 'welcome_hook_secret'`);
    await calls();
    const saved = await pg.tryRun(`set role authenticated; insert into public.support_messages (ticket_id, author_id, body, is_admin_reply)
      values ('${MEMBER_TICKET}', '${ADMIN}', 'No secret', true)`, { user: "app_user" });
    assert.equal(saved.ok, true);
    assert.match(saved.err, /WARNING:.*welcome_hook_secret is missing; reply .* saved but not emailed/);
    assert.equal(await pg.sql(`select count(*) from public.support_messages where body = 'No secret'`), "1");
    for (const f of ["dispatch_guide_emails", "dispatch_monthly_backups", "dispatch_account_deletions", "dispatch_daily_reminders"]) {
      const r = await pg.tryRun(`select public.${f}()`);
      assert.equal(r.ok, false, f);
      assert.match(r.err, new RegExp(`${f}: vault secret welcome_hook_secret is missing`));
    }
    assert.deepEqual(await calls(), []);
    await pg.sql(`select vault.create_secret('${ROTATED}', 'welcome_hook_secret')`);
  });

  await t.test("only the owner and service_role may run the callers", async () => {
    for (const f of [...FIVE, "dispatch_daily_reminders()"]) {
      const acl = await pg.sql(`select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = 'public.${f}'::regprocedure`);
      assert.doesNotMatch(acl, /(^|,)=X/, `${f}: no PUBLIC execute`);
      assert.doesNotMatch(acl, /(^|,)(anon|authenticated)=/, f);
      assert.match(acl, /service_role=X/, f);
    }
    const r = await pg.tryRun(`set role authenticated; select public.dispatch_guide_emails()`, { user: "app_user" });
    assert.equal(r.ok, false);
    assert.match(r.err, /permission denied for function dispatch_guide_emails/);
  });

  await t.test("the guarded rollback refuses by default, restores literal bodies the audit catches, and the migration undoes it", async () => {
    const refused = await pg.tryRun(ROLLBACK);
    assert.equal(refused.ok, false);
    assert.match(refused.err, /refusing/);
    assert.deepEqual(await audit(), [], "a refused rollback wrote nothing");
    await pg.sql(`set hook_secret_vault.confirm_rollback = 'write the secret into the catalog'; ${ROLLBACK}`);
    const objects = [...new Set((await audit()).map(row => row.split("|").slice(0, 2).join("|")))];
    assert.deepEqual(objects, ["cron|cron job send-reminders-daily", ...FIVE.map(f => `function|${f}`)]);
    await calls();
    await adminReply(MEMBER_TICKET, "Rolled back");
    assert.deepEqual((await calls()).map(c => c.secret), [ROTATED], "the rolled-back trigger still sends");
    await pg.sql(MIGRATION);
    assert.deepEqual(await audit(), []);
  });

  await t.test("refuses on a database with no literal and no vault secret, and on disagreeing literals", async () => {
    for (const [db, state, message] of [
      ["empty", "", /no welcome_hook_secret in the vault and no literal left/],
      ["split", preState(LIT, "a-different-synthetic-secret"), /carry 2 different hook secrets/],
    ]) {
      await pg.sql(`create database ${db}`);
      await pg.sql(PLATFORM, { db });
      if (state) await pg.sql(state, { db });
      const r = await pg.tryRun(MIGRATION, { db });
      assert.equal(r.ok, false, db);
      assert.match(r.err, message, db);
      assert.equal(await pg.sql(`select count(*) from vault.secrets`, { db }), "0", `${db}: nothing seeded`);
    }
  });
});
