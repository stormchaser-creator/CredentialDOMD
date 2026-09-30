import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { pgBin, pgSkip } from './credential-portal/postgresFixture.mjs';
import {
  reminderEmailDecision, reminderFingerprint, reminderSnoozed, utcDaysBetween, REMINDER_STATE_COLUMNS,
} from '../supabase/functions/_shared/reminderCadence.mjs';
import { RECIPIENT_COLUMNS } from '../supabase/functions/_shared/reminderRecipients.mjs';
import { PROFILE_TOMBSTONE_PATCH } from '../supabase/functions/delete-account/lib.ts';

// send-reminders and the in-app banner used to share alerts_fingerprint and
// last_notified. The server stored a 24-hex hash there and resent whenever its
// hash differed from the column; the banner writes its own format there on
// every Snooze, Email or Text tap, so after any tap the next 13:00 UTC run
// sent whatever the cadence said, and it never read snoozed_until (production
// 2026-09-21/22). Separately, the cadence was elapsed milliseconds against a
// stamp taken after Resend answered, so every run fell short by a second or
// two: Daily went every other day, Weekly every 8 days (production: the
// 2026-09-29 13:00 run said "recently notified, unchanged" 6.7 seconds short
// of a week after the 09-22 13:00:06.802 send).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const at = iso => Date.parse(iso);
// The app's banner fingerprint (src/utils/notifications.js generateAlerts).
const APP_FP = 'soon:licenses:2026-10-19';

// ── The decision, as a pure function ─────────────────────────────────────

test('the cadence counts whole UTC days: a run seconds earlier in the day still sends', () => {
  const fingerprint = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const daily = { reminder_email_fingerprint: fingerprint, reminder_emailed_at: '2026-09-28T13:00:05.000Z' };
  assert.deepEqual(reminderEmailDecision(daily, { fingerprint, freqDays: 1, now: at('2026-09-29T13:00:03.000Z') }),
    { send: true, reason: 'due' }, 'Daily: yesterday 13:00:05, today 13:00:03');
  // The production case: emailed 09-22 13:00:06.802, the 09-29 run at 13:00:00.08.
  const weekly = { reminder_email_fingerprint: fingerprint, reminder_emailed_at: '2026-09-22T13:00:06.802Z' };
  assert.equal(reminderEmailDecision(weekly, { fingerprint, freqDays: 7, now: at('2026-09-29T13:00:00.083Z') }).send, true, 'Weekly on day 7, not day 8');
  assert.equal(reminderEmailDecision(weekly, { fingerprint, freqDays: 7, now: at('2026-09-28T13:00:00.083Z') }).send, false, 'not on day 6');
  assert.deepEqual(reminderEmailDecision(daily, { fingerprint, freqDays: 1, now: at('2026-09-28T22:00:00.000Z') }),
    { send: false, reason: 'recently notified, unchanged' }, 'a second run the same UTC day never sends twice');
  assert.equal(utcDaysBetween(at('2026-09-28T23:59:59Z'), at('2026-09-29T00:00:01Z')), 1);
  assert.equal(utcDaysBetween(at('2026-09-29T00:00:01Z'), at('2026-09-29T23:59:59Z')), 0);
});

test('the snooze holds every email, even when the list changed and the cadence is due', () => {
  const now = at('2026-09-22T13:00:06.000Z');
  const p = { reminder_email_fingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbb', reminder_emailed_at: '2026-09-01T13:00:05Z', snoozed_until: '2026-09-24T23:08:46.550Z' };
  assert.deepEqual(reminderEmailDecision(p, { fingerprint: 'cccccccccccccccccccccccc', freqDays: 7, now }), { send: false, reason: 'snoozed' });
  assert.deepEqual(reminderEmailDecision({ snoozed_until: '2026-09-24T23:08:46Z' }, { fingerprint: 'c', freqDays: 7, now }), { send: false, reason: 'snoozed' }, 'never emailed, still quiet');
  const lapsed = { ...p, snoozed_until: '2026-09-21T00:00:00Z' };
  assert.equal(reminderEmailDecision(lapsed, { fingerprint: 'cccccccccccccccccccccccc', freqDays: 7, now }).send, true, 'a snooze in the past is over');
  assert.equal(reminderSnoozed('not a date', now), false, 'an unreadable snooze is no snooze');
  assert.equal(reminderSnoozed(null, now), false);
  assert.equal(reminderSnoozed('', now), false);
});

test('first email, a changed list, and the app\'s columns are never the server\'s state', () => {
  const now = at('2026-09-22T13:00:06Z');
  assert.deepEqual(reminderEmailDecision({}, { fingerprint: 'f', freqDays: 7, now }), { send: true, reason: 'first email' });
  const p = { reminder_email_fingerprint: 'dddddddddddddddddddddddd', reminder_emailed_at: '2026-09-21T13:00:05Z' };
  assert.deepEqual(reminderEmailDecision(p, { fingerprint: 'eeeeeeeeeeeeeeeeeeeeeeee', freqDays: 7, now }), { send: true, reason: 'list changed' });
  // The banner's columns hold a different format and a fresh tap stamp; they
  // are not what the server compares against.
  const tapped = { ...p, reminder_email_fingerprint: 'eeeeeeeeeeeeeeeeeeeeeeee', alerts_fingerprint: APP_FP, last_notified: '2026-09-21T23:08:20.420Z' };
  assert.deepEqual(reminderEmailDecision(tapped, { fingerprint: 'eeeeeeeeeeeeeeeeeeeeeeee', freqDays: 7, now }), { send: false, reason: 'recently notified, unchanged' });
  assert.deepEqual(REMINDER_STATE_COLUMNS, ['reminder_email_fingerprint', 'reminder_emailed_at']);
});

test('the fingerprint is the 24-hex hash send-reminders always stored', async () => {
  const fp = await reminderFingerprint([{ id: 'b', exp: '2026-10-01' }, { id: 'a', exp: '2026-11-01' }]);
  assert.match(fp, /^[0-9a-f]{24}$/);
  assert.equal(fp, await reminderFingerprint([{ id: 'a', exp: '2026-11-01' }, { id: 'b', exp: '2026-10-01' }]), 'order does not matter');
  assert.notEqual(fp, await reminderFingerprint([{ id: 'a', exp: '2026-11-02' }, { id: 'b', exp: '2026-10-01' }]), 'a new date changes it');
});

test('send-reminders reads and writes only its own columns', () => {
  const fn = read('supabase/functions/send-reminders/index.ts');
  const cols = RECIPIENT_COLUMNS.split(',').map(c => c.trim());
  for (const c of ['snoozed_until', ...REMINDER_STATE_COLUMNS]) assert.ok(cols.includes(c), `the recipient query selects ${c}`);
  for (const c of ['alerts_fingerprint', 'last_notified']) {
    assert.ok(!cols.includes(c), `the recipient query no longer selects the app's ${c}`);
    assert.doesNotMatch(fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), new RegExp(`\\b${c}\\b`), `send-reminders code never names ${c}`);
  }
  assert.match(fn, /reminderEmailDecision\(p, \{ fingerprint: fp, freqDays: freq \}\)/);
  assert.equal(PROFILE_TOMBSTONE_PATCH.reminder_email_fingerprint, null, 'account deletion clears the server fingerprint');
  assert.equal(PROFILE_TOMBSTONE_PATCH.reminder_emailed_at, null, 'and the send stamp');
  const sync = read('src/lib/supabase.js');
  const map = sync.slice(sync.indexOf('const SETTINGS_TO_PROFILE'), sync.indexOf('};', sync.indexOf('const SETTINGS_TO_PROFILE')));
  for (const c of REMINDER_STATE_COLUMNS) assert.ok(!map.includes(`"${c}"`), `the app never syncs ${c}, so no device can push an old copy over it`);
});

// ── The real function, run under node ────────────────────────────────────

const STUBS = {
  'https://deno.land/std@0.168.0/http/server.ts': 'export function serve(handler) { globalThis.__reminders.handler = handler; }',
  'https://esm.sh/@supabase/supabase-js@2': 'export function createClient() { return globalThis.__reminders.db; } export class SupabaseClient {}',
  'https://esm.sh/jose@5': 'export function createRemoteJWKSet() { return null; } export async function jwtVerify() { throw new Error("no jwt in this test"); }',
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const HOOK = 'hook-secret-for-tests';
const ENV = { RESEND_API_KEY: 're_test', WELCOME_HOOK_SECRET: HOOK, SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' };
globalThis.Deno = { env: { get: k => ENV[k] } };

// An in-memory PostgREST with the calls send-reminders makes. select(cols)
// returns only the named columns, so the function sees exactly what its query
// asks for.
function createDb(tables) {
  const log = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.cols = '*'; this.payload = null; }
    select(cols = '*') { this.cols = cols; return this; }
    update(p) { this.op = 'update'; this.payload = p; return this; }
    insert(p) { this.op = 'insert'; this.payload = p; return this; }
    eq(c, v) { this.filters.push(r => r[c] === v); return this; }
    neq(c, v) { this.filters.push(r => r[c] !== v); return this; }
    not(c, op, v) { if (op !== 'is') throw new Error(`not.${op}`); this.filters.push(r => v === null ? r[c] != null : r[c] !== v); return this; }
    gte(c, v) { this.filters.push(r => r[c] != null && String(r[c]) >= String(v)); return this; }
    lte(c, v) { this.filters.push(r => r[c] != null && String(r[c]) <= String(v)); return this; }
    run() {
      const rows = tables[this.table] ||= [];
      log.push({ table: this.table, op: this.op, payload: this.payload });
      if (this.op === 'insert') { rows.push(...[].concat(this.payload)); return { data: null, error: null }; }
      const hit = rows.filter(r => this.filters.every(f => f(r)));
      if (this.op === 'update') { for (const r of hit) Object.assign(r, this.payload); return { data: null, error: null }; }
      const pick = this.cols === '*' ? r => ({ ...r }) : r => Object.fromEntries(this.cols.split(',').map(c => c.trim()).map(c => [c, r[c] ?? null]));
      return { data: hit.map(pick), error: null };
    }
    then(res, rej) { try { res(this.run()); } catch (e) { rej(e); } }
  }
  return { log, from: t => new Query(t) };
}

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  if (String(input) === 'https://api.resend.com/emails') {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `email-${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
globalThis.__reminders = { handler: null, db: null };
await import(pathToFileURL(path.join(ROOT, 'supabase/functions/send-reminders/index.ts')).href);

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function profile(n, extra) {
  return { id: uid(n), name: 'Alex Sample', email: `member${n}@example.test`, notify_email: true, access_status: 'active',
    reminder_lead_days: 90, notify_freq_days: 7, alerts_fingerprint: null, last_notified: null, snoozed_until: null,
    reminder_email_fingerprint: null, reminder_emailed_at: null, updated_at: '2026-09-01T00:00:00.000Z', ...extra };
}
const license = n => ({ id: `lic-${n}`, user_id: uid(n), type: 'State Medical License', state: 'ZZ', expiration_date: '2026-10-19' });
async function serverFp(n) { return reminderFingerprint([{ id: `lic-${n}`, exp: '2026-10-19' }]); }

async function runAt(iso, tables) {
  mock.timers.setTime(at(iso));
  globalThis.__reminders.db = createDb(tables);
  const res = await globalThis.__reminders.handler(new Request('https://fn.test/send-reminders', {
    method: 'POST', headers: { 'x-hook-secret': HOOK, 'content-type': 'application/json' }, body: '{}',
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  return { body, log: globalThis.__reminders.db.log, byProfile: Object.fromEntries(body.results.map(r => [r.profile, r])) };
}

test('send-reminders under node: snooze, the app\'s columns and the daily cadence', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: at('2026-09-22T13:00:03.000Z') });
  t.after(() => mock.timers.reset());

  await t.test('a member who tapped Email and then Snooze in the app gets no email the next morning', async () => {
    sent.length = 0;
    // Production a676337e on 2026-09-22: the banner's fingerprint and tap
    // stamp from the night before, snoozed until the 24th.
    const p = profile(1, { alerts_fingerprint: APP_FP, last_notified: '2026-09-21T23:08:20.420Z', snoozed_until: '2026-09-24T23:08:46.550Z' });
    const tables = { profiles: [p], licenses: [license(1)], alert_acks: [], notification_log: [] };
    const { byProfile, log } = await runAt('2026-09-22T13:00:03.000Z', tables);
    assert.deepEqual(byProfile[uid(1)], { profile: uid(1), sent: false, reason: 'snoozed' });
    assert.equal(sent.length, 0, 'no email');
    assert.equal(log.filter(l => l.op === 'update').length, 0, 'nothing stamped');
  });

  await t.test('the banner\'s own fingerprint never reads as a changed list', async () => {
    sent.length = 0;
    const p = profile(2, { alerts_fingerprint: APP_FP, last_notified: '2026-09-21T23:08:20.420Z',
      reminder_email_fingerprint: await serverFp(2), reminder_emailed_at: '2026-09-20T13:00:05.000Z' });
    const { byProfile } = await runAt('2026-09-22T13:00:03.000Z', { profiles: [p], licenses: [license(2)], alert_acks: [], notification_log: [] });
    assert.deepEqual(byProfile[uid(2)], { profile: uid(2), sent: false, reason: 'recently notified, unchanged' });
    assert.equal(sent.length, 0);
  });

  await t.test('Daily goes out the next morning, not the morning after, and stamps only the server\'s columns', async () => {
    sent.length = 0;
    const p = profile(3, { notify_freq_days: 1, alerts_fingerprint: APP_FP, last_notified: '2026-09-21T23:08:20.420Z',
      snoozed_until: '2026-09-21T00:00:00.000Z', reminder_email_fingerprint: await serverFp(3), reminder_emailed_at: '2026-09-21T13:00:05.000Z' });
    const tables = { profiles: [p], licenses: [license(3)], alert_acks: [], notification_log: [] };
    const { byProfile, log } = await runAt('2026-09-22T13:00:03.000Z', tables);
    assert.equal(byProfile[uid(3)].sent, true, 'yesterday 13:00:05, today 13:00:03, Daily');
    assert.equal(byProfile[uid(3)].reason, 'due');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['member3@example.test']);
    const updates = log.filter(l => l.table === 'profiles' && l.op === 'update');
    assert.equal(updates.length, 1);
    assert.deepEqual(Object.keys(updates[0].payload).sort(), ['reminder_email_fingerprint', 'reminder_emailed_at', 'updated_at']);
    const row = tables.profiles[0];
    assert.equal(row.reminder_emailed_at, '2026-09-22T13:00:03.000Z');
    assert.equal(row.updated_at, '2026-09-22T13:00:03.000Z', 'a server-side edit bumps updated_at');
    assert.equal(row.reminder_email_fingerprint, await serverFp(3));
    assert.equal(row.alerts_fingerprint, APP_FP, 'the banner keeps its fingerprint, so its snoozed view survives');
    assert.equal(row.last_notified, '2026-09-21T23:08:20.420Z', 'and its tap stamp');
    assert.equal(tables.notification_log.length, 1);

    const again = await runAt('2026-09-22T18:30:00.000Z', tables);
    assert.equal(again.byProfile[uid(3)].sent, false, 'a manual run later the same day sends nothing');
    const tomorrow = await runAt('2026-09-23T13:00:01.000Z', tables);
    assert.equal(tomorrow.byProfile[uid(3)].sent, true, 'and the next morning it goes again');
    assert.equal(sent.length, 2);
  });

  // NOTIFY-001: dayDiff rounded (expiry at 00:00Z minus the 13:00Z run time),
  // so every count was a day short: a credential expiring today was listed
  // under EXPIRED as "1 day ago" and counted as expired in the subject line.
  await t.test('day counts are whole UTC dates: today, in 1 day, in 30 days; nothing expired', async () => {
    mock.timers.setTime(at('2026-10-01T13:00:03.000Z'));
    const rows = [['lic-today', '2026-10-01'], ['lic-tomorrow', '2026-10-02'], ['lic-month', '2026-10-31'], ['lic-lapsed', '2026-09-30']]
      .map(([id, exp]) => ({ id, user_id: uid(4), type: 'State Medical License', state: 'ZZ', expiration_date: exp }));
    globalThis.__reminders.db = createDb({ profiles: [profile(4)], licenses: rows, alert_acks: [], notification_log: [] });
    const res = await globalThis.__reminders.handler(new Request('https://fn.test/send-reminders', {
      method: 'POST', headers: { 'x-hook-secret': HOOK, 'content-type': 'application/json' }, body: JSON.stringify({ dry_run: true }),
    }));
    const { results: [result] } = await res.json();
    assert.match(result.text, /Oct 1, 2026 \(today\)/);
    assert.match(result.text, /Oct 2, 2026 \(in 1 day\)/);
    assert.match(result.text, /Oct 31, 2026 \(in 30 days\)/);
    assert.match(result.text, /Sep 30, 2026 \(1 day ago\)/, 'yesterday is the one expired item');
    assert.equal(result.headline, '1 expired, 3 coming up');
    const expired = result.text.slice(result.text.indexOf('EXPIRED'), result.text.indexOf('Due within 30 days'));
    assert.doesNotMatch(expired, /Oct 1, 2026/, 'today is not listed as expired');
  });
});

// ── The migration and rollback on a real PostgreSQL ──────────────────────

const PORT = '58961';
const run = promisify(execFile);
const MIGRATION = read('supabase/migrations/20260929140000_reminder_email_state.sql');
const ROLLBACK = read('docs/rollback/20260929140000_reminder_email_state.rollback.sql');

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-cadence-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 4 * 1024 * 1024 });
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, close };
}

// Production's shape for these columns (information_schema, 2026-09-29):
// last_notified, snoozed_until and alerts_fingerprint are text; updated_at
// timestamptz default now().
const PROFILES = `
  create table public.profiles (id uuid primary key, name text, email text, access_status text not null default 'pending',
    notify_email boolean, reminder_lead_days integer, notify_freq_days integer, last_notified text, snoozed_until text,
    alerts_fingerprint text, updated_at timestamptz default now());
`;
const OLD = '2026-09-01 00:00:00+00';
const ROWS = [
  // [n, alerts_fingerprint, last_notified]
  [1, 'f4deaed37db1a8b8298e9cf5', '2026-09-22T13:00:06.802Z'], // the server's own stamp: carried over
  [2, APP_FP, '2026-09-21T23:08:20.420Z'],                     // the banner's: left alone
  [3, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'yesterday-ish'],             // unreadable stamp: left alone, no failure
  [4, 'bbbbbbbbbbbbbbbbbbbbbbbb', null],                        // no stamp
  [5, null, null],                                              // never notified
];

test('the reminder state migration and rollback on a real PostgreSQL', { skip: pgSkip(), timeout: 120000 }, async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(PROFILES);
  const lit = v => v === null ? 'null' : `'${v}'`;
  await pg.sql(`insert into public.profiles (id, alerts_fingerprint, last_notified, snoozed_until, updated_at) values ${ROWS.map(([n, fp, ln]) =>
    `('${uid(n)}', ${lit(fp)}, ${lit(ln)}, '2026-09-24T23:08:46.550Z', '${OLD}')`).join(', ')}`);

  await t.test('before the migration the new recipient query cannot run: the migration goes first', async () => {
    await assert.rejects(pg.sql(`select ${RECIPIENT_COLUMNS} from public.profiles`), /reminder_email_fingerprint|reminder_emailed_at/);
  });

  await t.test('applies twice; carries over only the server\'s own last send, with updated_at', async () => {
    await pg.sql(MIGRATION);
    await pg.sql(MIGRATION);
    const rows = (await pg.sql(`select id, coalesce(reminder_email_fingerprint, '-'), coalesce(to_char(reminder_emailed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS'), '-'), updated_at > '${OLD}', coalesce(last_notified, '-') from public.profiles order by id`)).split('\n');
    assert.deepEqual(rows, [
      `${uid(1)}|f4deaed37db1a8b8298e9cf5|2026-09-22T13:00:06.802|t|2026-09-22T13:00:06.802Z`,
      `${uid(2)}|-|-|f|2026-09-21T23:08:20.420Z`,
      `${uid(3)}|-|-|f|yesterday-ish`,
      `${uid(4)}|-|-|f|-`,
      `${uid(5)}|-|-|f|-`,
    ]);
    assert.equal(await pg.sql(`select alerts_fingerprint from public.profiles where id = '${uid(1)}'`), 'f4deaed37db1a8b8298e9cf5', 'the app\'s column is not cleared');
    assert.equal(await pg.sql(`select count(*) from (select ${RECIPIENT_COLUMNS} from public.profiles) q`), '5', 'the recipient query\'s columns all exist now');
  });

  await t.test('a later send is never overwritten by a re-run', async () => {
    await pg.sql(`update public.profiles set reminder_email_fingerprint = 'cccccccccccccccccccccccc', reminder_emailed_at = '2026-09-30T13:00:02Z' where id = '${uid(1)}'`);
    await pg.sql(MIGRATION);
    assert.equal(await pg.sql(`select reminder_email_fingerprint from public.profiles where id = '${uid(1)}'`), 'cccccccccccccccccccccccc');
  });

  await t.test('no top-level transaction lines', () => {
    assert.doesNotMatch(MIGRATION, /^\s*(begin|commit)\s*;/im);
    assert.doesNotMatch(ROLLBACK, /^\s*(begin|commit)\s*;/im);
  });

  await t.test('the rollback drops both columns, twice, and keeps the app\'s', async () => {
    await pg.sql(ROLLBACK);
    await pg.sql(ROLLBACK);
    assert.equal(await pg.sql(`select count(*) from information_schema.columns where table_name = 'profiles' and column_name in ('reminder_email_fingerprint', 'reminder_emailed_at')`), '0');
    assert.equal(await pg.sql(`select count(*) from public.profiles where alerts_fingerprint is not null`), '4');
    await pg.sql(MIGRATION);
  });
});
