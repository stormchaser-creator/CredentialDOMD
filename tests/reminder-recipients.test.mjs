import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from './credential-portal/postgresFixture.mjs';
import {
  emailRemindersOn, reminderLeadDays, notifyFreqDays, DEFAULT_REMINDER_LEAD_DAYS, DEFAULT_NOTIFY_FREQ_DAYS,
} from '../src/utils/reminderPreferences.js';
import { DEFAULT_SETTINGS } from '../src/constants/defaults.js';
import { reminderRecipientsQuery, isReminderRecipient, RECIPIENT_COLUMNS } from '../supabase/functions/_shared/reminderRecipients.mjs';
import { shapeSnapshot } from '../supabase/functions/_shared/memberView.mjs';
import { TASK_DEFS } from '../src/utils/setupTasks.js';

// Owner decision 2026-09-29: a blank email-reminder setting means ON.
// send-reminders used to mail only notify_email = true while Settings showed
// a blank as ON, so 7 of 8 active accounts were told reminders were on and
// never got one. These tests hold the server's recipient query, its JS twin,
// the migration's default and every app reader to the one rule: blank and
// true are on, only false is off.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('blank means on; only an explicit false is off', () => {
  assert.equal(emailRemindersOn(true), true);
  assert.equal(emailRemindersOn(null), true, 'a blank profile column is on');
  assert.equal(emailRemindersOn(undefined), true, 'a setting never written is on');
  assert.equal(emailRemindersOn(false), false, 'the member turned it off');
});

test('a blank lead is the 90 days Settings shows, the old clamps unchanged', () => {
  assert.equal(DEFAULT_SETTINGS.reminderLeadDays, DEFAULT_REMINDER_LEAD_DAYS, 'Settings and send-reminders read one default');
  assert.equal(DEFAULT_SETTINGS.notifyFreqDays, DEFAULT_NOTIFY_FREQ_DAYS);
  assert.equal(DEFAULT_SETTINGS.notifyEmail, true);
  for (const blank of [null, undefined, '', 0, 'soon']) assert.equal(reminderLeadDays(blank), 90, `lead ${String(blank)}`);
  assert.equal(reminderLeadDays(30), 30);
  assert.equal(reminderLeadDays('120'), 120);
  assert.equal(reminderLeadDays(3), 7, 'clamped up to a week');
  assert.equal(reminderLeadDays(-5), 7, 'a negative lead clamps as it always did');
  assert.equal(reminderLeadDays(999), 365, 'clamped down to a year');
  for (const blank of [null, undefined, '', 0]) assert.equal(notifyFreqDays(blank), 7, `freq ${String(blank)}`);
  assert.equal(notifyFreqDays(1), 1);
  assert.equal(notifyFreqDays(90), 60);
});

// A stand-in for the supabase-js builder that records every call, so the test
// sees the exact PostgREST filters send-reminders sends.
function recordingDb() {
  const calls = [];
  const builder = new Proxy({}, {
    get: (_, method) => method === 'then' ? undefined : (...args) => { calls.push([method, ...args]); return builder; },
  });
  return { calls, db: { from: table => { calls.push(['from', table]); return builder; } } };
}

test('the recipient query sends NOT (notify_email IS FALSE), never eq true', () => {
  const { calls, db } = recordingDb();
  reminderRecipientsQuery(db);
  assert.deepEqual(calls, [
    ['from', 'profiles'],
    ['select', RECIPIENT_COLUMNS],
    ['not', 'notify_email', 'is', false],
    ['not', 'email', 'is', null],
    ['neq', 'email', ''],
    ['eq', 'access_status', 'active'],
  ]);
  const one = recordingDb();
  reminderRecipientsQuery(one.db, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(one.calls.at(-1), ['eq', 'id', '00000000-0000-4000-8000-000000000001'], 'a manual run narrows, the rules still apply');
  const fn = read('supabase/functions/send-reminders/index.ts');
  assert.match(fn, /reminderRecipientsQuery\(db, body\.profile_id\)/, 'send-reminders reads its recipients through the shared query');
  assert.doesNotMatch(fn, /notify_email["']\s*,\s*true/, 'the old eq true filter is gone');
  assert.match(fn, /reminderLeadDays\(p\.reminder_lead_days\)/);
  assert.match(fn, /notifyFreqDays\(p\.notify_freq_days\)/);
});

test('isReminderRecipient: the same rule for one row', () => {
  const base = { email: 'a@example.test', access_status: 'active' };
  assert.equal(isReminderRecipient({ ...base, notify_email: null }), true, 'blank is mailed');
  assert.equal(isReminderRecipient({ ...base }), true, 'missing column is mailed');
  assert.equal(isReminderRecipient({ ...base, notify_email: true }), true);
  assert.equal(isReminderRecipient({ ...base, notify_email: false }), false, 'an explicit off is never mailed');
  assert.equal(isReminderRecipient({ ...base, notify_email: null, email: null }), false, 'no address');
  assert.equal(isReminderRecipient({ ...base, notify_email: null, email: '' }), false, 'empty address');
  assert.equal(isReminderRecipient({ ...base, notify_email: null, access_status: 'pending' }), false, 'not active');
  assert.equal(isReminderRecipient(null), false);
});

// Every app reader of the setting goes through emailRemindersOn, so no screen
// can show a state the server does not act on. A bare `s.notifyEmail` read
// (truthy test, !s.notifyEmail toggle) is what showed OFF, or flipped the
// wrong way, for a blank.
test('every app and function reader of the setting uses the one rule', () => {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (rel !== path.join('supabase', 'functions', '_shared', 'app')) walk(rel); }
      else if (/\.(jsx?|mjs|ts)$/.test(entry.name)) files.push(rel);
    }
  };
  walk('src'); walk(path.join('supabase', 'functions'));
  let readers = 0;
  for (const rel of files) {
    // Comments name the columns freely; only code is held to the rule.
    const text = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const all = text.match(/\.notifyEmail\b|\.notify_email\b/g) || [];
    const wrapped = text.match(/emailRemindersOn\([\w?.]*\.(?:notifyEmail|notify_email)\)/g) || [];
    readers += wrapped.length;
    assert.equal(all.length, wrapped.length, `${rel} reads the email reminder setting without emailRemindersOn`);
    assert.doesNotMatch(text, /\.eq\(\s*["']notify_email["']/, `${rel} filters notify_email with eq`);
  }
  assert.ok(readers >= 6, `found ${readers} readers; the scan is looking in the right place`);
});

test('the setup board counts blank email reminders as a channel on', () => {
  const reminders = TASK_DEFS.find(t => t.id === 'reminders');
  const s = { email: 'a@example.test', reminderLeadDays: 90 };
  assert.equal(reminders.doneWhen({ s }), true, 'blank');
  assert.equal(reminders.doneWhen({ s: { ...s, notifyEmail: null } }), true, 'null');
  assert.equal(reminders.doneWhen({ s: { ...s, notifyEmail: false } }), false, 'off, and no other channel');
});

test('the administrator view shows the reminder settings the member sees and the server obeys', () => {
  const profile = { id: '00000000-0000-4000-8000-000000000001', name: 'Alex Sample', email: 'a@example.test',
    notify_email: null, reminder_lead_days: null, notify_freq_days: null };
  const blank = shapeSnapshot({ profile, collections: {} }).member;
  assert.equal(blank.notifyEmail, true, 'blank reads Yes, as the switch shows it');
  assert.equal(blank.reminderLeadDays, 90);
  assert.equal(blank.notifyFreqDays, 7);
  const set = shapeSnapshot({ profile: { ...profile, notify_email: false, reminder_lead_days: 30, notify_freq_days: 14 }, collections: {} }).member;
  assert.equal(set.notifyEmail, false, 'an explicit off stays off');
  assert.equal(set.reminderLeadDays, 30);
  assert.equal(set.notifyFreqDays, 14);
});

// ── A real PostgreSQL: the filter, the migration and the rollback ──────────

const PORT = '58953';
const run = promisify(execFile);
const MIGRATION = read('supabase/migrations/20260929130000_notify_email_default_on.sql');
const ROLLBACK = read('docs/rollback/20260929130000_notify_email_default_on.rollback.sql');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-recipients-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, close };
}

// Production's shape for these columns (information_schema, 2026-09-29):
// notify_email boolean, nullable, no default; access_status text not null
// default 'pending'; updated_at default now().
const PROFILES = `
  create table public.profiles (id uuid primary key, auth_user_id text unique, name text, email text,
    access_status text not null default 'pending', notify_email boolean, reminder_lead_days integer,
    notify_freq_days integer, last_notified timestamptz, alerts_fingerprint text, deleted_at timestamptz,
    updated_at timestamptz default now());
`;

// The PostgREST translation of exactly the filters the query sends; anything
// else throws, so a new filter has to be taught here before it can pass.
function toWhere(calls) {
  const lit = v => v === null ? 'null' : typeof v === 'boolean' ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
  return calls.filter(([m]) => !['from', 'select'].includes(m)).map(([method, column, ...rest]) => {
    const col = `"${column}"`;
    if (method === 'not' && rest[0] === 'is') return `not ${col} is ${lit(rest[1])}`;
    if (method === 'is') return `${col} is ${lit(rest[0])}`;
    if (method === 'eq') return `${col} = ${lit(rest[0])}`;
    if (method === 'neq') return `${col} <> ${lit(rest[0])}`;
    throw new Error(`teach toWhere the filter ${method}`);
  }).join(' and ');
}

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROWS = [
  // [n, notify_email, email, access_status]
  [1, null, 'blank@example.test', 'active'],
  [2, true, 'on@example.test', 'active'],
  [3, false, 'off@example.test', 'active'],
  [4, null, null, 'active'],
  [5, null, '', 'active'],
  [6, null, 'pending@example.test', 'pending'],
  [7, true, 'pending-on@example.test', 'pending'],
  [8, false, null, 'active'],
];

test('recipients, migration and rollback on a real PostgreSQL', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(PROFILES);
  const lit = v => v === null ? 'null' : typeof v === 'boolean' ? String(v) : `'${v}'`;
  await pg.sql(`insert into public.profiles (id, notify_email, email, access_status, updated_at) values ${ROWS.map(([n, ne, em, st]) =>
    `('${id(n)}', ${lit(ne)}, ${lit(em)}, '${st}', '2026-09-01T00:00:00Z')`).join(', ')}`);

  await t.test('the query selects blank and true, never false, and matches isReminderRecipient', async () => {
    const { calls, db } = recordingDb();
    reminderRecipientsQuery(db);
    const got = (await pg.sql(`select id from public.profiles where ${toWhere(calls)} order by id`)).split('\n').filter(Boolean);
    assert.deepEqual(got, [id(1), id(2)], 'the blank and the explicit-on active accounts with an address');
    const js = ROWS.filter(([, ne, em, st]) => isReminderRecipient({ notify_email: ne, email: em, access_status: st })).map(([n]) => id(n));
    assert.deepEqual(got, js, 'SQL and JavaScript agree row for row');
    const before = (await pg.sql(`select id from public.profiles where notify_email = true and email is not null and email <> '' and access_status = 'active' order by id`)).split('\n').filter(Boolean);
    assert.deepEqual(before, [id(2)], 'the old filter left the blank account out');
  });

  await t.test('the migration applies twice and new profiles start on', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION);
    assert.equal(await pg.sql(`select column_default from information_schema.columns where table_name = 'profiles' and column_name = 'notify_email'`), 'true');
    await pg.sql(`insert into public.profiles (id, auth_user_id) values ('${id(20)}', 'user_new')`);
    assert.equal(await pg.sql(`select notify_email from public.profiles where id = '${id(20)}'`), 't', 'a signup that names no setting is on');
    await pg.sql(`insert into public.profiles (id, auth_user_id, notify_email) values ('${id(21)}', 'user_off', false)`);
    assert.equal(await pg.sql(`select notify_email from public.profiles where id = '${id(21)}'`), 'f', 'an explicit false is kept');
  });

  await t.test('existing rows are not rewritten', async () => {
    const rows = await pg.sql(`select id, coalesce(notify_email::text, 'blank'), updated_at = '2026-09-01T00:00:00Z' from public.profiles where id <= '${id(8)}' order by id`);
    assert.deepEqual(rows.split('\n'), ROWS.map(([n, ne]) => `${id(n)}|${ne === null ? 'blank' : String(ne)}|t`));
  });

  await t.test('the migration carries no top-level transaction lines', () => {
    assert.doesNotMatch(MIGRATION, /^\s*(begin|commit)\s*;/im);
    assert.doesNotMatch(ROLLBACK, /^\s*(begin|commit)\s*;/im);
  });

  await t.test('the rollback restores no default and no comment, twice, and keeps every row', async () => {
    await pg.sql(ROLLBACK);
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select coalesce(column_default, 'none') from information_schema.columns where table_name = 'profiles' and column_name = 'notify_email'`), 'none');
    assert.equal(await pg.sql(`select coalesce(col_description('public.profiles'::regclass, attnum), 'none') from pg_attribute where attrelid = 'public.profiles'::regclass and attname = 'notify_email'`), 'none');
    assert.equal(await pg.sql(`select count(*) from public.profiles where notify_email is true and id = '${id(20)}'`), '1', 'a profile created on the default keeps it');
    await pg.sql(MIGRATION);
  });
});
