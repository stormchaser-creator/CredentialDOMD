import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks, createRequire } from 'node:module';
import { build } from 'esbuild';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from './credential-portal/postgresFixture.mjs';
import {
  reminderEmailDecision, reminderFingerprint, reminderSnoozed, reminderToldStill, utcDaysBetween, REMINDER_STATE_COLUMNS, APP_SECTIONS,
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

test('the snooze holds the list it was set over, even when the cadence is due', () => {
  const now = at('2026-09-22T13:00:06.000Z');
  const p = { reminder_email_fingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbb', reminder_emailed_at: '2026-09-01T13:00:05Z', snoozed_until: '2026-09-24T23:08:46.550Z' };
  assert.deepEqual(reminderEmailDecision(p, { fingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbb', freqDays: 7, now }), { send: false, reason: 'snoozed' }, 'unchanged and 21 days since the last email');
  // NOTIFY-003: a list that changed under the snooze goes out, as the banner
  // wakes when its own list changes. Held, a lapsing acknowledgement on a
  // Monthly snooze reached its expiry date with no email.
  assert.deepEqual(reminderEmailDecision(p, { fingerprint: 'cccccccccccccccccccccccc', freqDays: 7, now }), { send: true, reason: 'list changed' });
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

test('the fingerprint starts with the 24-hex hash send-reminders always stored, then lists each item', async () => {
  const fp = await reminderFingerprint([{ id: 'b', exp: '2026-10-01', table: 'travel_docs' }, { id: 'a', exp: '2026-11-01', table: 'licenses' }]);
  assert.match(fp, /^[0-9a-f]{24};[0-9a-f]{12}:(licenses|travelDocs):\d{4}-\d{2}-\d{2},[0-9a-f]{12}:(licenses|travelDocs):\d{4}-\d{2}-\d{2}$/);
  assert.match(fp, /:travelDocs:2026-10-01/, 'items carry the app\'s section name');
  assert.equal(fp, await reminderFingerprint([{ id: 'a', exp: '2026-11-01', table: 'licenses' }, { id: 'b', exp: '2026-10-01', table: 'travel_docs' }]), 'order does not matter');
  assert.notEqual(fp, await reminderFingerprint([{ id: 'a', exp: '2026-11-02', table: 'licenses' }, { id: 'b', exp: '2026-10-01', table: 'travel_docs' }]), 'a new date changes it');
  assert.doesNotMatch(fp, /\b[ab]:/, 'record ids are stored hashed');
  // A row stamped before the items were kept holds the bare hash, and the
  // same list still reads as unchanged, so the deploy sends nothing off cadence.
  const legacy = fp.slice(0, 24);
  const p = { reminder_email_fingerprint: legacy, reminder_emailed_at: '2026-09-28T13:00:05Z' };
  assert.deepEqual(reminderEmailDecision(p, { fingerprint: fp, freqDays: 7, now: at('2026-09-30T13:00:03Z') }), { send: false, reason: 'recently notified, unchanged' });
});

// Review finding on NOTIFY-003: the snooze broke whenever the server's list
// differed from its last email, so an expired record ageing past the query's
// 30 day back window (which the banner still lists) sent a digest the member
// had snoozed, and so did a record added and seen in the banner before the
// 13:00 UTC run. Only an item the member has not been told about wakes it.
test('under a snooze only an item the member has not been told about is sent', async () => {
  const now = at('2026-10-06T13:00:03Z');
  const A = { id: 'lic-a', exp: '2026-09-05', table: 'licenses' };
  const B = { id: 'lic-b', exp: '2026-11-09', table: 'licenses' };
  const snoozed = { reminder_email_fingerprint: await reminderFingerprint([A, B]), reminder_emailed_at: '2026-09-30T13:00:05Z',
    snoozed_until: '2026-10-30T13:00:00Z', alerts_fingerprint: null };
  const decide = async (items, extra = {}) => reminderEmailDecision({ ...snoozed, ...extra }, { fingerprint: await reminderFingerprint(items), freqDays: 30, now });

  assert.deepEqual(await decide([B]), { send: false, reason: 'snoozed' }, 'A aged out of the 30 day window: nothing new');
  assert.deepEqual(await decide([A, { ...B, exp: '2027-11-09' }]), { send: false, reason: 'snoozed' }, 'B renewed to a later date');
  assert.deepEqual(await decide([A, { ...B, exp: '2026-10-20' }]), { send: true, reason: 'list changed' }, 'B corrected to a nearer date');
  const C = { id: 'dea-c', exp: '2026-10-12', table: 'licenses' };
  assert.deepEqual(await decide([A, B, C]), { send: true, reason: 'list changed' }, 'a new item (a lapsed acknowledgement) still wakes it');
  assert.deepEqual(await decide([B, C]), { send: true, reason: 'list changed' }, 'one item left and one came: the new one is sent');
  // The banner the member snoozed over listed C: they have seen it.
  const banner = 'exp:licenses:2026-09-05|soon:licenses:2026-10-12|soon:licenses:2026-11-09|cme:ZZ:2:2026-11-09';
  assert.deepEqual(await decide([A, B, C], { alerts_fingerprint: banner }), { send: false, reason: 'snoozed' }, 'added and seen in the banner before the run');
  assert.deepEqual(await decide([A, B, C], { alerts_fingerprint: 'soon:travelDocs:2026-10-12' }), { send: true, reason: 'list changed' }, 'the same date in another section is not C');
  // A row stamped before the items were kept: no per-item list to compare,
  // so a changed list wakes unless the banner already showed every item.
  const legacy = { reminder_email_fingerprint: (await reminderFingerprint([A, B])).slice(0, 24) };
  assert.deepEqual(await decide([B, C], legacy), { send: true, reason: 'list changed' });
  assert.deepEqual(await decide([B, C], { ...legacy, alerts_fingerprint: banner }), { send: false, reason: 'snoozed' });
  // With the snooze over, any change is sent as before.
  assert.deepEqual(await decide([B], { snoozed_until: '2026-10-01T00:00:00Z' }), { send: true, reason: 'list changed' });
});

// Review finding on NOTIFY-003: the told list never shrank. The Nov 2 email
// listed a license L and a DEA D; the member acknowledged D until Nov 15 and
// snoozed the banner (which then showed only L) to Dec 2. On Nov 16 the run's
// list was {L, D} again, which hashed to the Nov 2 email, so every run to the
// DEA's Nov 22 expiry said "snoozed". A run that sends nothing now forgets
// the told items it no longer lists, so D returns as new.
test('an item told in the last email, acknowledged and lapsed under a snooze, is sent again', async () => {
  const L = { id: 'lic-l', exp: '2027-01-21', table: 'licenses' };
  const D = { id: 'dea-d', exp: '2026-11-22', table: 'licenses' };
  const emailed = await reminderFingerprint([L, D]);
  const row = { reminder_email_fingerprint: emailed, reminder_emailed_at: '2026-11-02T13:00:05Z',
    snoozed_until: '2026-12-02T14:00:00Z', alerts_fingerprint: 'soon:licenses:2027-01-21' };
  // One run as send-reminders makes it: decide, and narrow when nothing goes.
  const run = async (day, items) => {
    const fingerprint = await reminderFingerprint(items);
    const decision = reminderEmailDecision(row, { fingerprint, freqDays: 30, now: at(`${day}T13:00:03Z`) });
    if (!decision.send) row.reminder_email_fingerprint = reminderToldStill(row.reminder_email_fingerprint, fingerprint) || row.reminder_email_fingerprint;
    return decision;
  };
  assert.deepEqual(await run('2026-11-03', [L]), { send: false, reason: 'snoozed' }, 'D acknowledged: nothing new');
  assert.equal(row.reminder_email_fingerprint.slice(0, 24), emailed.slice(0, 24), 'the hash of the last email stays');
  assert.equal(row.reminder_email_fingerprint, `${emailed.slice(0, 24)};${(await reminderFingerprint([L])).split(';')[1]}`, 'only L is still told');
  assert.deepEqual(await run('2026-11-10', [L]), { send: false, reason: 'snoozed' });
  assert.deepEqual(await run('2026-11-16', [L, D]), { send: true, reason: 'list changed' }, 'the acknowledgement lapsed six days before the DEA expires');
  // Without the narrowing (the stored value left as the Nov 2 email) the
  // same run is held: the regression this guards.
  assert.deepEqual(reminderEmailDecision({ ...row, reminder_email_fingerprint: emailed }, { fingerprint: emailed, freqDays: 30, now: at('2026-11-16T13:00:03Z') }),
    { send: false, reason: 'snoozed' });
  // The banner listed D when the member snoozed: still seen, still held.
  const seen = { ...row, alerts_fingerprint: 'soon:licenses:2026-11-22|soon:licenses:2027-01-21' };
  assert.deepEqual(reminderEmailDecision(seen, { fingerprint: emailed, freqDays: 30, now: at('2026-11-16T13:00:03Z') }), { send: false, reason: 'snoozed' });
  // Nothing narrows when every told item is listed, for a bare legacy hash,
  // or before any email; a run with nothing due forgets every told item.
  assert.equal(reminderToldStill(emailed, emailed), null);
  assert.equal(reminderToldStill(emailed.slice(0, 24), await reminderFingerprint([L])), null);
  assert.equal(reminderToldStill(null, await reminderFingerprint([L])), null);
  assert.equal(reminderToldStill(emailed, await reminderFingerprint([])), `${emailed.slice(0, 24)};`);
  const none = { ...row, reminder_email_fingerprint: `${emailed.slice(0, 24)};`, alerts_fingerprint: null };
  assert.deepEqual(reminderEmailDecision(none, { fingerprint: emailed, freqDays: 30, now: at('2026-11-16T13:00:03Z') }), { send: true, reason: 'list changed' });
  // An unchanged list with every item still told holds, whatever the banner.
  assert.deepEqual(reminderEmailDecision({ ...row, reminder_email_fingerprint: emailed, alerts_fingerprint: null }, { fingerprint: emailed, freqDays: 30, now: at('2026-11-16T13:00:03Z') }),
    { send: false, reason: 'snoozed' });
});

// Review finding on NOTIFY-003: the narrowing only counted under a snooze.
// A Monthly member with no snooze was emailed on 10-01 about a DEA expiring
// 10-25 and acknowledged it until 10-19; the 10-02 run found nothing due and
// narrowed the told items to none. On 10-20 the DEA was listed again, its
// list hashed to the 10-01 email, and the run said "recently notified,
// unchanged" until 10-31, after the DEA lapsed.
test('without a snooze, an item forgotten on a nothing-due run and listed again is a changed list', async () => {
  const D = { id: 'dea-unsnoozed', exp: '2026-10-25', table: 'licenses' };
  const L = { id: 'lic-unsnoozed', exp: '2026-12-20', table: 'licenses' };
  const emailed = await reminderFingerprint([D]);
  const row = { reminder_email_fingerprint: emailed, reminder_emailed_at: '2026-10-01T13:00:05Z', snoozed_until: null, alerts_fingerprint: null };
  row.reminder_email_fingerprint = reminderToldStill(row.reminder_email_fingerprint, await reminderFingerprint([])) || row.reminder_email_fingerprint;
  assert.equal(row.reminder_email_fingerprint, `${emailed.slice(0, 24)};`, 'the nothing-due run forgets the DEA');
  const decide = async (r, items, day = '2026-10-20') => reminderEmailDecision(r, { fingerprint: await reminderFingerprint(items), freqDays: 30, now: at(`${day}T13:00:03Z`) });
  assert.deepEqual(await decide(row, [D]), { send: true, reason: 'list changed' }, 'five days before the DEA lapses, not on 10-31');
  // A told list as the last email stored it holds while unchanged, as before.
  assert.deepEqual(await decide({ ...row, reminder_email_fingerprint: emailed }, [D]), { send: false, reason: 'recently notified, unchanged' });
  assert.deepEqual(await decide({ ...row, reminder_email_fingerprint: emailed }, [D], '2026-10-31'), { send: true, reason: 'due' });
  // Narrowed to the items still listed: a still-told item is not new, a forgotten one is.
  const both = await reminderFingerprint([D, L]);
  const kept = { ...row, reminder_email_fingerprint: reminderToldStill(both, await reminderFingerprint([L])) };
  assert.deepEqual(await decide(kept, [L]), { send: true, reason: 'list changed' }, 'the hash differs from the two-item email: changed, as on main');
  assert.deepEqual(await decide(kept, [D, L]), { send: true, reason: 'list changed' }, 'D returns with the same hash: changed');
  // A bare legacy hash compares the hash alone, as before.
  assert.deepEqual(await decide({ ...row, reminder_email_fingerprint: emailed.slice(0, 24) }, [D]), { send: false, reason: 'recently notified, unchanged' });
});

// Review finding on NOTIFY-003: the banner names a section and a date, not a
// record. A state license S and its controlled substance registration C both
// expire 2026-12-31; C was acknowledged, so the Nov 20 email and the snoozed
// banner listed S only. When C's acknowledgement lapsed, the banner's one
// "soon:licenses:2026-12-31" part (S's) was read as C's too.
test('a second record with the same section and date as a banner item is not taken as seen', async () => {
  const S = { id: 'lic-st', exp: '2026-12-31', table: 'licenses' };
  const C = { id: 'csr-st', exp: '2026-12-31', table: 'licenses' };
  const now = at('2026-12-10T13:00:03Z');
  const row = { reminder_email_fingerprint: await reminderFingerprint([S]), reminder_emailed_at: '2026-11-20T13:00:05Z',
    snoozed_until: '2026-12-20T14:00:00Z', alerts_fingerprint: 'soon:licenses:2026-12-31' };
  const decide = async (items, extra = {}) => reminderEmailDecision({ ...row, ...extra }, { fingerprint: await reminderFingerprint(items), freqDays: 30, now });
  assert.deepEqual(await decide([S, C]), { send: true, reason: 'list changed' }, 'one banner part, already S\'s: C is new');
  assert.deepEqual(await decide([S, C], { alerts_fingerprint: 'soon:licenses:2026-12-31|soon:licenses:2026-12-31' }), { send: false, reason: 'snoozed' },
    'the banner showed two items with that date: both seen');
  assert.deepEqual(await decide([S, { ...C, exp: '2026-12-30' }]), { send: true, reason: 'list changed' }, 'a different date, as before');
  // Two new items with one date, the banner showed one: the second is new.
  const T = { id: 'csr-two', exp: '2026-12-31', table: 'licenses' };
  assert.deepEqual(await decide([C, T], { reminder_email_fingerprint: await reminderFingerprint([{ id: 'other', exp: '2027-03-01', table: 'licenses' }]) }),
    { send: true, reason: 'list changed' });
  // A legacy bare hash: the banner covers as many items as it has parts.
  const legacy = { reminder_email_fingerprint: (await reminderFingerprint([S])).slice(0, 24) };
  assert.deepEqual(await decide([S, C], legacy), { send: true, reason: 'list changed' });
  assert.deepEqual(await decide([S, C], { ...legacy, alerts_fingerprint: 'soon:licenses:2026-12-31|soon:licenses:2026-12-31' }), { send: false, reason: 'snoozed' });
});

test('the server\'s section names are the app\'s, for every table the email reads', async () => {
  const sync = read('src/lib/supabase.js');
  const map = sync.slice(sync.indexOf('const TABLE_MAP'), sync.indexOf('};', sync.indexOf('const TABLE_MAP')));
  const fn = read('supabase/functions/send-reminders/index.ts');
  const tables = [...fn.slice(fn.indexOf('const TABLES'), fn.indexOf('];', fn.indexOf('const TABLES'))).matchAll(/table: "([a-z_]+)"/g)].map(m => m[1]);
  assert.ok(tables.length >= 8);
  for (const t of tables) {
    assert.ok(APP_SECTIONS[t], `a section for ${t}`);
    assert.match(map, new RegExp(`\\b${APP_SECTIONS[t]}: "${t}"`), `TABLE_MAP maps ${APP_SECTIONS[t]} to ${t}`);
  }
  // The banner's real fingerprint for a license due in 20 days and an
  // expired travel document holds the server's run for the same two records.
  const out = await build({
    entryPoints: [path.join(ROOT, 'src/utils/notifications.js')], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const alerts = mod.exports.generateAlerts({
    settings: { name: 'Synthetic Physician', degreeType: 'DO', primaryState: 'ZZ', reminderLeadDays: 90 },
    licenses: [{ id: 'lic-new', type: 'State Medical License (DO)', state: 'ZZ', expirationDate: day(20) }],
    travelDocs: [{ id: 'pass-old', type: 'Passport', expirationDate: day(-10) }],
    cme: [], privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [],
  });
  assert.match(alerts.fingerprint, new RegExp(`soon:licenses:${day(20)}`));
  assert.match(alerts.fingerprint, new RegExp(`exp:travelDocs:${day(-10)}`));
  const old = { id: 'lic-old', exp: day(200), table: 'licenses' };
  const p = { reminder_email_fingerprint: await reminderFingerprint([old]), reminder_emailed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    snoozed_until: new Date(Date.now() + 20 * 86400000).toISOString(), alerts_fingerprint: alerts.fingerprint };
  const fingerprint = await reminderFingerprint([old, { id: 'lic-new', exp: day(20), table: 'licenses' }, { id: 'pass-old', exp: day(-10), table: 'travel_docs' }]);
  assert.deepEqual(reminderEmailDecision(p, { fingerprint, freqDays: 7 }), { send: false, reason: 'snoozed' });
});

test('send-reminders reads and writes only its own columns', () => {
  const fn = read('supabase/functions/send-reminders/index.ts');
  const cols = RECIPIENT_COLUMNS.split(',').map(c => c.trim());
  for (const c of ['snoozed_until', ...REMINDER_STATE_COLUMNS]) assert.ok(cols.includes(c), `the recipient query selects ${c}`);
  assert.ok(cols.includes('alerts_fingerprint'), 'the banner\'s list is read, as what the member snoozed over');
  assert.ok(!cols.includes('last_notified'), 'the recipient query no longer selects the app\'s last_notified');
  for (const c of ['alerts_fingerprint', 'last_notified']) {
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
// Like PostgREST, a select returns at most maxRows rows (hosted Supabase's
// max_rows is 1,000), from the offset .range() asks for, in .order() order.
function createDb(tables, fail = [], { maxRows = 1000 } = {}) {
  const log = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.cols = '*'; this.payload = null; this.orderBy = null; this.span = null; }
    in(c, vs) { const set = new Set(vs); this.filters.push(r => set.has(r[c])); return this; }
    order(c) { this.orderBy = c; return this; }
    range(a, b) { this.span = [a, b]; return this; }
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
      if (this.op === 'select' && fail.includes(this.table)) return { data: null, error: { message: `${this.table} read failed` } };
      let hit = rows.filter(r => this.filters.every(f => f(r)));
      if (this.op === 'update') { for (const r of hit) Object.assign(r, this.payload); return { data: null, error: null }; }
      if (this.orderBy) hit = [...hit].sort((a, b) => String(a[this.orderBy]).localeCompare(String(b[this.orderBy])));
      const [from, to] = this.span || [0, Infinity];
      hit = hit.slice(from, Math.min(to + 1, from + maxRows));
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
async function serverFp(n) { return reminderFingerprint([{ id: `lic-${n}`, exp: '2026-10-19', table: 'licenses' }]); }

async function runAt(iso, tables, { fail = [], maxRows } = {}) {
  mock.timers.setTime(at(iso));
  globalThis.__reminders.db = createDb(tables, fail, { maxRows });
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

  // NOTIFY-003: Monthly, lead 90. A license due in 80 days sets the banner's
  // Snooze to 30 days; a DEA due in 20 days is acknowledged until day 13.
  // When the acknowledgement lapses, the DEA is mailed under the snooze, once.
  await t.test('an item that comes due under a snooze is emailed before it lapses', async () => {
    sent.length = 0;
    const lic = { id: 'lic-snooze', user_id: uid(5), type: 'State Medical License', state: 'ZZ', expiration_date: '2027-01-21' };
    const dea = { id: 'dea-snooze', user_id: uid(5), type: 'DEA Registration', state: 'ZZ', expiration_date: '2026-11-22' };
    const p = profile(5, { notify_freq_days: 30, snoozed_until: '2026-12-02T13:00:00.000Z',
      reminder_email_fingerprint: await reminderFingerprint([{ id: lic.id, exp: lic.expiration_date }]), reminder_emailed_at: '2026-11-02T13:00:05.000Z' });
    const tables = { profiles: [p], licenses: [lic, dea], alert_acks: [{ user_id: uid(5), item_id: dea.id, until: '2026-11-15' }], notification_log: [] };
    const held = await runAt('2026-11-15T13:00:03.000Z', tables);
    assert.deepEqual(held.byProfile[uid(5)], { profile: uid(5), sent: false, reason: 'snoozed' }, 'the acknowledgement still holds: the snoozed list is unchanged');
    const due = await runAt('2026-11-16T13:00:03.000Z', tables);
    assert.equal(due.byProfile[uid(5)].sent, true, 'six days before the DEA lapses, under a snooze to Dec 2');
    assert.equal(due.byProfile[uid(5)].reason, 'list changed');
    assert.match(sent[0].text, /Nov 22, 2026 \(in 6 days\)/);
    const after = await runAt('2026-11-17T13:00:03.000Z', tables);
    assert.deepEqual(after.byProfile[uid(5)], { profile: uid(5), sent: false, reason: 'snoozed' }, 'then the snooze holds the new list');
    assert.equal(sent.length, 1);
  });

  // Review finding on NOTIFY-003, through the real function: the DEA was in
  // the last email, then acknowledged under the snooze. The held runs forget
  // it, so when the acknowledgement lapses it is mailed before it expires.
  await t.test('an item told in the last email whose acknowledgement lapses under a snooze is emailed again', async () => {
    sent.length = 0;
    const lic = { id: 'lic-told', user_id: uid(8), type: 'State Medical License', state: 'ZZ', expiration_date: '2027-01-21' };
    const dea = { id: 'dea-told', user_id: uid(8), type: 'DEA Registration', state: 'ZZ', expiration_date: '2026-11-22' };
    const emailed = await reminderFingerprint([{ id: lic.id, exp: lic.expiration_date, table: 'licenses' }, { id: dea.id, exp: dea.expiration_date, table: 'licenses' }]);
    const p = profile(8, { notify_freq_days: 30, snoozed_until: '2026-12-02T14:00:00.000Z', alerts_fingerprint: 'soon:licenses:2027-01-21',
      reminder_email_fingerprint: emailed, reminder_emailed_at: '2026-11-02T13:00:05.000Z' });
    const tables = { profiles: [p], licenses: [lic, dea], alert_acks: [{ user_id: uid(8), item_id: dea.id, until: '2026-11-15' }], notification_log: [] };
    const held = await runAt('2026-11-03T13:00:03.000Z', tables);
    assert.deepEqual(held.byProfile[uid(8)], { profile: uid(8), sent: false, reason: 'snoozed' });
    const updates = held.log.filter(l => l.table === 'profiles' && l.op === 'update');
    assert.equal(updates.length, 1, 'the held run narrows the told items');
    assert.deepEqual(Object.keys(updates[0].payload), ['reminder_email_fingerprint'], 'and nothing else: no send stamp, no updated_at');
    assert.equal(tables.profiles[0].reminder_email_fingerprint.slice(0, 24), emailed.slice(0, 24));
    assert.equal(tables.profiles[0].updated_at, '2026-09-01T00:00:00.000Z');
    const again = await runAt('2026-11-04T13:00:03.000Z', tables);
    assert.equal(again.log.filter(l => l.op === 'update').length, 0, 'nothing to narrow the next day');
    const due = await runAt('2026-11-16T13:00:03.000Z', tables);
    assert.equal(due.byProfile[uid(8)].sent, true, 'six days before the DEA lapses, under a snooze to Dec 2');
    assert.match(sent[0].text, /Nov 22, 2026 \(in 6 days\)/);
    assert.equal(tables.profiles[0].reminder_email_fingerprint, emailed, 'the send stores the whole list');
    const after = await runAt('2026-11-17T13:00:03.000Z', tables);
    assert.deepEqual(after.byProfile[uid(8)], { profile: uid(8), sent: false, reason: 'snoozed' });
    assert.equal(sent.length, 1);
  });

  // Review finding on NOTIFY-003, through the real function: the last email
  // listed an expired license (25 days past) and one due in 40 days; the
  // member snoozed the banner for a Monthly period. Six days later the
  // expired one is past the query's 30 day back window and drops out of the
  // run's list. Nothing new: the snooze holds.
  await t.test('an expired item ageing out of the 30 day window under a snooze sends nothing', async () => {
    sent.length = 0;
    const a = { id: 'lic-aged', user_id: uid(6), type: 'State Medical License', state: 'ZZ', expiration_date: '2026-09-05' };
    const b = { id: 'lic-later', user_id: uid(6), type: 'State Medical License', state: 'ZZ', expiration_date: '2026-11-09' };
    const p = profile(6, { notify_freq_days: 30, snoozed_until: '2026-10-30T13:00:00.000Z', reminder_emailed_at: '2026-09-30T13:00:05.000Z',
      reminder_email_fingerprint: await reminderFingerprint([{ id: a.id, exp: a.expiration_date, table: 'licenses' }, { id: b.id, exp: b.expiration_date, table: 'licenses' }]) });
    const tables = { profiles: [p], licenses: [a, b], alert_acks: [], notification_log: [] };
    const listed = await runAt('2026-10-05T13:00:03.000Z', tables);
    assert.deepEqual(listed.byProfile[uid(6)], { profile: uid(6), sent: false, reason: 'snoozed' }, 'day 30 past expiry: still listed, unchanged');
    const aged = await runAt('2026-10-06T13:00:03.000Z', tables);
    assert.deepEqual(aged.byProfile[uid(6)], { profile: uid(6), sent: false, reason: 'snoozed' }, 'day 31: the expired item left the list, nothing came');
    assert.equal(sent.length, 0);
    assert.equal(tables.profiles[0].reminder_emailed_at, '2026-09-30T13:00:05.000Z', 'nothing stamped');
  });

  // Review finding on NOTIFY-003, through the real function, no snooze:
  // Monthly, emailed 10-01 about a DEA due 10-25, acknowledged that day
  // until 10-19. The 10-02 run has nothing due and forgets the DEA; when the
  // acknowledgement lapses on 10-20 it is mailed, not held to 10-31.
  await t.test('without a snooze, a DEA acknowledged on a nothing-due day is emailed when the acknowledgement lapses', async () => {
    sent.length = 0;
    const dea = { id: 'dea-nosnooze', user_id: uid(9), type: 'DEA Registration', state: 'ZZ', expiration_date: '2026-10-25' };
    const emailed = await reminderFingerprint([{ id: dea.id, exp: dea.expiration_date, table: 'licenses' }]);
    const p = profile(9, { notify_freq_days: 30, reminder_email_fingerprint: emailed, reminder_emailed_at: '2026-10-01T13:00:05.000Z' });
    const tables = { profiles: [p], licenses: [dea], alert_acks: [{ user_id: uid(9), item_id: dea.id, until: '2026-10-19' }], notification_log: [] };
    const none = await runAt('2026-10-02T13:00:03.000Z', tables);
    assert.deepEqual(none.byProfile[uid(9)], { profile: uid(9), sent: false, reason: 'nothing due' });
    assert.equal(tables.profiles[0].reminder_email_fingerprint, `${emailed.slice(0, 24)};`, 'the DEA is forgotten as told');
    const acked = await runAt('2026-10-19T13:00:03.000Z', tables);
    assert.deepEqual(acked.byProfile[uid(9)], { profile: uid(9), sent: false, reason: 'nothing due' }, 'the acknowledgement holds through 10-19');
    const lapsed = await runAt('2026-10-20T13:00:03.000Z', tables);
    assert.equal(lapsed.byProfile[uid(9)].sent, true, 'five days before the DEA lapses');
    assert.equal(lapsed.byProfile[uid(9)].reason, 'list changed');
    assert.match(sent[0].text, /Oct 25, 2026 \(in 5 days\)/);
    assert.equal(tables.profiles[0].reminder_email_fingerprint, emailed, 'the send stores the whole list');
    const after = await runAt('2026-10-21T13:00:03.000Z', tables);
    assert.deepEqual(after.byProfile[uid(9)], { profile: uid(9), sent: false, reason: 'recently notified, unchanged' });
    assert.equal(sent.length, 1);
  });

  // Review finding on NOTIFY-003: a failed table read on a held run used to
  // narrow that table's told items away. Snoozed to 10-08 over a banner of
  // one license; a passport entered the window on 10-02 and was mailed. On
  // 10-03 the travel_docs read failed and the run held; on 10-04 the full
  // list (the one 10-02 mailed) read the passport as fresh and mailed it again.
  await t.test('a failed table read on a held run forgets nothing, so the next full read holds', async () => {
    sent.length = 0;
    const lic = { id: 'lic-readfail', user_id: uid(10), type: 'State Medical License', state: 'ZZ', expiration_date: '2026-11-20' };
    const pass = { id: 'pass-readfail', user_id: uid(10), type: 'Passport', expiration_date: '2026-12-31' };
    const p = profile(10, { notify_freq_days: 30, snoozed_until: '2026-10-08T13:00:00.000Z', alerts_fingerprint: 'soon:licenses:2026-11-20',
      reminder_email_fingerprint: await reminderFingerprint([{ id: lic.id, exp: lic.expiration_date, table: 'licenses' }]), reminder_emailed_at: '2026-10-01T13:00:05.000Z' });
    const tables = { profiles: [p], licenses: [lic], travel_docs: [pass], alert_acks: [], notification_log: [] };
    const entered = await runAt('2026-10-02T13:00:03.000Z', tables);
    assert.equal(entered.byProfile[uid(10)].sent, true, 'the passport enters the 90 day window under the snooze');
    const told = tables.profiles[0].reminder_email_fingerprint;
    const failed = await runAt('2026-10-03T13:00:03.000Z', tables, { fail: ['travel_docs'] });
    assert.deepEqual(failed.byProfile[uid(10)], { profile: uid(10), sent: false, reason: 'snoozed' });
    assert.equal(failed.log.filter(l => l.op === 'update').length, 0, 'nothing narrowed on a partial read');
    assert.equal(tables.profiles[0].reminder_email_fingerprint, told);
    const full = await runAt('2026-10-04T13:00:03.000Z', tables);
    assert.deepEqual(full.byProfile[uid(10)], { profile: uid(10), sent: false, reason: 'snoozed' }, 'the same list the 10-02 email held');
    assert.equal(sent.length, 1);
    // A held run that read every table still narrows (a record left the list).
    tables.travel_docs = [];
    const left = await runAt('2026-10-05T13:00:03.000Z', tables);
    assert.deepEqual(left.byProfile[uid(10)], { profile: uid(10), sent: false, reason: 'snoozed' });
    assert.equal(left.log.filter(l => l.op === 'update').length, 1, 'the passport left: forgotten as told');
  });

  // The second case: a record added and seen in the banner, snoozed before
  // the 13:00 UTC run. The banner's list (alerts_fingerprint, stamped with
  // the snooze) holds it; one added after the snooze is sent the next day.
  await t.test('a record the member saw in the banner when snoozing is not emailed that day', async () => {
    sent.length = 0;
    const x = { id: 'lic-known', user_id: uid(7), type: 'State Medical License', state: 'ZZ', expiration_date: '2026-12-20' };
    const y = { id: 'lic-added', user_id: uid(7), type: 'State Medical License', state: 'ZZ', expiration_date: '2026-10-26' };
    const p = profile(7, { notify_freq_days: 30, reminder_emailed_at: '2026-09-29T13:00:05.000Z',
      reminder_email_fingerprint: await reminderFingerprint([{ id: x.id, exp: x.expiration_date, table: 'licenses' }]),
      snoozed_until: '2026-11-05T08:00:00.000Z', alerts_fingerprint: 'soon:licenses:2026-10-26|soon:licenses:2026-12-20', last_notified: null });
    const tables = { profiles: [p], licenses: [x, y], alert_acks: [], notification_log: [] };
    const same = await runAt('2026-10-06T13:00:03.000Z', tables);
    assert.deepEqual(same.byProfile[uid(7)], { profile: uid(7), sent: false, reason: 'snoozed' });
    assert.equal(sent.length, 0);
    tables.travel_docs = [{ id: 'pass-new', user_id: uid(7), type: 'Passport', expiration_date: '2026-10-30' }];
    const next = await runAt('2026-10-07T13:00:03.000Z', tables);
    assert.equal(next.byProfile[uid(7)].sent, true, 'a passport added after the snooze, due in 23 days');
    assert.equal(next.byProfile[uid(7)].reason, 'list changed');
    assert.equal(sent.length, 1);
    assert.equal(tables.profiles[0].alerts_fingerprint, 'soon:licenses:2026-10-26|soon:licenses:2026-12-20', 'the banner\'s list is read, never written');
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

  // Review finding on 7d7d1430: re-indenting the per-member loop indented the
  // text template's body lines, and a template literal keeps its whitespace,
  // so every plain-text email read "  Your credential check..." with only the
  // first section header indented. The body is the 30f41ff7 layout: every
  // paragraph and header at column 0, items under them as "  - ".
  await t.test('the email body sits at column 0, every section header alike', async () => {
    mock.timers.setTime(at('2026-10-01T13:00:03.000Z'));
    const rows = [['lic-x', '2026-09-20'], ['lic-y', '2026-10-21'], ['lic-z', '2026-12-10']]
      .map(([id, exp]) => ({ id, user_id: uid(30), type: 'State Medical License', state: 'ZZ', expiration_date: exp }));
    globalThis.__reminders.db = createDb({ profiles: [profile(30)], licenses: rows, alert_acks: [], notification_log: [] });
    const res = await globalThis.__reminders.handler(new Request('https://fn.test/send-reminders', {
      method: 'POST', headers: { 'x-hook-secret': HOOK, 'content-type': 'application/json' }, body: JSON.stringify({ dry_run: true }),
    }));
    const { results: [result] } = await res.json();
    const lines = result.text.split('\n');
    assert.equal(lines[0], 'Hi Alex,', 'a salutation word, as the welcome email greets');
    assert.equal(lines[1], '');
    assert.equal(lines[2], 'Your credential check for Oct 1, 2026: 1 expired, 2 coming up.');
    assert.equal(lines[4], 'EXPIRED');
    for (const header of ['EXPIRED', 'Due within 30 days', 'Coming up (within 90 days)', 'CredentialDOMD']) {
      assert.ok(lines.includes(header), `"${header}" is its own line at column 0`);
    }
    assert.ok(lines.some(l => l.startsWith('Open the app to renew')), 'the app line at column 0');
    assert.ok(lines.some(l => l.startsWith('You get this because')), 'the footer at column 0');
    for (const l of lines) {
      if (/^\s+\S/.test(l)) assert.match(l, /^ {2}- |^ {6}(Renew|Steps and fees): /, `only item lines are indented: ${JSON.stringify(l)}`);
    }
  });

  // The QA lab, 2026-10-01: with 1,387 recipients the run read nine queries
  // per member, one member at a time, and the edge runtime stopped it for CPU
  // time (WORKER_LIMIT) before the newest members; and the recipients read
  // returned at most PostgREST's 1,000 rows, so the rest were never read.
  await t.test('every recipient past PostgREST\'s max_rows is reminded, with grouped reads', async () => {
    sent.length = 0;
    const n = 1203;
    const profiles = [], licenses = [];
    for (let i = 1; i <= n; i++) {
      profiles.push(profile(10000 + i, { reminder_lead_days: i % 2 ? 90 : 30 }));
      // Due in 60 days: inside a 90-day lead, outside a 30-day one, in the same group.
      licenses.push({ id: `lic-g${i}`, user_id: uid(10000 + i), type: 'State Medical License', state: 'ZZ', expiration_date: '2026-11-21' });
    }
    const tables = { profiles, licenses, alert_acks: [], notification_log: [] };
    const { body, log } = await runAt('2026-09-22T13:00:03.000Z', tables, { maxRows: 1000 });
    assert.equal(body.profiles, n, 'every recipient is read, not the first 1,000');
    const mailed = new Set(sent.map(m => m.to[0]));
    assert.equal(mailed.size, Math.ceil(n / 2), 'each member with a 90-day lead gets the license due in 60 days');
    assert.ok(mailed.has(`member${10000 + n}@example.test`), 'the last recipient too');
    assert.ok(!mailed.has('member10002@example.test'), 'a 30-day lead in the same group does not list it');
    assert.equal(body.results.filter(r => r.sent === false && r.reason === 'nothing due').length, Math.floor(n / 2));
    const reads = log.filter(l => l.op === 'select');
    assert.ok(reads.filter(l => l.table === 'licenses').length <= 2 * Math.ceil(n / 100), `licenses read per group of members, not per member (${reads.filter(l => l.table === 'licenses').length})`);
    assert.ok(reads.length < n, `${reads.length} reads for ${n} members`);
  });

  await t.test('a table that fails to read holds its group without forgetting what was told', async () => {
    sent.length = 0;
    const p = profile(20001, { reminder_email_fingerprint: await reminderFingerprint([{ id: 'lic-told', exp: '2026-10-19', table: 'licenses' }]), reminder_emailed_at: '2026-09-21T13:00:05.000Z' });
    const tables = { profiles: [p], licenses: [{ id: 'lic-told', user_id: uid(20001), type: 'State Medical License', state: 'ZZ', expiration_date: '2026-10-19' }], alert_acks: [], notification_log: [] };
    const { byProfile, log } = await runAt('2026-09-22T13:00:03.000Z', tables, { fail: ['licenses'] });
    assert.equal(byProfile[uid(20001)].sent, false);
    assert.equal(log.filter(l => l.table === 'profiles' && l.op === 'update').length, 0, 'the told list is kept for the next full read');
    assert.equal(sent.length, 0);
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
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const sql = async (query) => (await exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-c', query])).stdout.trim();
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
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

test('the reminder state migration and rollback on a real PostgreSQL', { skip: pgSkip(), timeout: withSlotWait(120000) }, async (t) => {
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
