// The daily reminder email names the board certification steps the app
// alerts on (src/utils/boardTasks.js boardTaskAlerts), through the app's own
// code copied into _shared/app/ (reminderBoardSteps.mjs). A due step is
// listed and counted in the fingerprint; a passed unmarked step, a done step
// and one past the lead time are not; a failed board read leaves the
// credential digest intact. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reminderBoardItems, boardDataFor, specialtiesOf } from '../supabase/functions/_shared/reminderBoardSteps.mjs';
import { reminderFingerprint, reminderEmailDecision, reminderToldBoard, reminderToldStill } from '../supabase/functions/_shared/reminderCadence.mjs';
import { readReminderGroup } from '../supabase/functions/_shared/reminderReads.mjs';
import { RECIPIENT_COLUMNS } from '../supabase/functions/_shared/reminderRecipients.mjs';
import { boardComplianceFor } from '../src/utils/boardCompliance.js';
import { boardTaskAlerts, openBoardTasks } from '../src/utils/boardTasks.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fn = readFileSync(`${root}supabase/functions/send-reminders/index.ts`, 'utf8');
const at = (iso) => new Date(`${iso}T12:00:00`);
const DONE_FIELD = 'AOBS Longitudinal Assessment done for 2026';

// A DO with an AOBS Board Certification record, as the licenses row reads.
const profile = (extra = {}) => ({ id: 'synthetic-member', degree_type: 'DO', specialties: [], ...extra });
const boardRow = (extra = {}) => ({
  id: 'synthetic-board-record', user_id: 'synthetic-member', type: 'Board Certification (AOA)', name: 'AOBS Surgery',
  notes: null, issued_date: null, expiration_date: null, lifecycle_status: 'active', custom_fields: {}, ...extra,
});

test('a step due inside the lead time is listed with a stable id, its name and its date', () => {
  const items = reminderBoardItems(profile(), [boardRow()], { lead: 90, now: at('2026-10-01') });
  assert.equal(items.length, 1);
  assert.deepEqual(
    { id: items[0].id, table: items[0].table, name: items[0].name, exp: items[0].exp, days: items[0].days },
    { id: 'board:AOA:AOBS:la:2026', table: 'board', name: 'AOBS Longitudinal Assessment', exp: '2026-11-15', days: 45 },
  );
  assert.equal(items[0].isLicense, false, 'no renewal portal line');
  assert.equal(items[0].isDea, false);
});

test('the email lists exactly the steps the app alerts on, from the same records', () => {
  const now = at('2026-10-01');
  const data = boardDataFor(profile(), [boardRow()]);
  const app = boardTaskAlerts(data, boardComplianceFor(data), 90, now);
  const items = reminderBoardItems(profile(), [boardRow()], { lead: 90, now });
  assert.deepEqual(items.map(i => i.exp), openBoardTasks(data, boardComplianceFor(data), 90, now).flatMap(o => o.tasks.map(t => t.due)));
  assert.equal(items.length, app.reduce((n, a) => n + a.issues.length, 0));
});

test('a passed step with no mark is asked in the app, never emailed', () => {
  assert.deepEqual(reminderBoardItems(profile(), [boardRow()], { lead: 90, now: at('2026-11-18') }), []);
});

test('a step marked done on the board record is not emailed', () => {
  const done = boardRow({ custom_fields: { [DONE_FIELD]: '2026-09-01' } });
  assert.deepEqual(reminderBoardItems(profile(), [done], { lead: 90, now: at('2026-10-01') }), []);
});

test('a step past the member\'s lead time is not emailed', () => {
  assert.deepEqual(reminderBoardItems(profile(), [boardRow()], { lead: 30, now: at('2026-10-01') }), []);
});

test('a done mark on a superseded board record counts no more in the email than in the app', () => {
  const now = at('2026-10-01');
  const rows = [boardRow({ lifecycle_status: 'superseded', custom_fields: { [DONE_FIELD]: '2026-09-01' } })];
  const data = boardDataFor(profile(), rows);
  const app = openBoardTasks(data, boardComplianceFor(data), 90, now).flatMap(o => o.tasks.map(t => t.due));
  assert.deepEqual(reminderBoardItems(profile(), rows, { lead: 90, now }).map(i => i.exp), app);
});

test('a PA or NP gets no physician board steps', () => {
  for (const degree_type of ['PA', 'NP']) {
    assert.deepEqual(reminderBoardItems(profile({ degree_type }), [boardRow()], { lead: 90, now: at('2026-10-01') }), []);
  }
});

test('a board picked in Settings alone (no record yet) is emailed like the app alerts on it', () => {
  const items = reminderBoardItems(profile({ specialties: ['AOA:AOBS'] }), [], { lead: 90, now: at('2026-10-01') });
  assert.deepEqual(items.map(i => i.id), ['board:AOA:AOBS:la:2026']);
  assert.deepEqual(specialtiesOf('["AOA:AOBS"]'), ['AOA:AOBS'], 'a JSON text value reads the same');
  assert.deepEqual(specialtiesOf(null), []);
  assert.deepEqual(specialtiesOf('not json'), []);
});

test('the fingerprint changes when a step comes due and when it is marked done', async () => {
  const now = at('2026-10-01');
  const cred = { id: 'synthetic-license', table: 'licenses', exp: '2026-12-01' };
  const due = reminderBoardItems(profile(), [boardRow()], { lead: 90, now });
  const done = reminderBoardItems(profile(), [boardRow({ custom_fields: { [DONE_FIELD]: '2026-09-01' } })], { lead: 90, now });
  const withStep = await reminderFingerprint([cred, ...due]);
  const without = await reminderFingerprint([cred, ...done]);
  assert.notEqual(withStep, without);
  assert.equal(without, await reminderFingerprint([cred]), 'a done step leaves exactly the credential list');
  const emailed = { reminder_email_fingerprint: without, reminder_emailed_at: new Date(Date.now() - 86400000).toISOString() };
  assert.deepEqual(reminderEmailDecision(emailed, { fingerprint: withStep, freqDays: 7 }), { send: true, reason: 'list changed' }, 'a newly due step sends');
  const told = { reminder_email_fingerprint: withStep, reminder_emailed_at: new Date(Date.now() - 86400000).toISOString() };
  assert.deepEqual(reminderEmailDecision(told, { fingerprint: withStep, freqDays: 7 }), { send: false, reason: 'recently notified, unchanged' });
});

test('under a banner snooze, a step the snoozed banner showed does not wake the email; a new one does', async () => {
  const now = new Date();
  const y = now.getFullYear();
  const soon = new Date(now.getTime() + 20 * 86400000);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // The banner part as notifications.js writes it for a board with one step.
  const due = iso(soon);
  const step = { id: `board:AOA:AOBS:la:${y}`, table: 'board', exp: due };
  const cred = { id: 'synthetic-license', table: 'licenses', exp: iso(new Date(now.getTime() + 200 * 86400000)) };
  const base = {
    reminder_email_fingerprint: await reminderFingerprint([cred]),
    reminder_emailed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    snoozed_until: new Date(Date.now() + 20 * 86400000).toISOString(),
  };
  const fingerprint = await reminderFingerprint([cred, step]);
  assert.deepEqual(reminderEmailDecision({ ...base, alerts_fingerprint: `soon:licenses:${cred.exp}|cme:board:AOA:AOBS:1:${due}` }, { fingerprint, freqDays: 7 }),
    { send: false, reason: 'snoozed' }, 'the banner showed this step');
  assert.deepEqual(reminderEmailDecision({ ...base, alerts_fingerprint: `soon:licenses:${cred.exp}` }, { fingerprint, freqDays: 7 }),
    { send: true, reason: 'list changed' }, 'the banner did not show it');
  // The part's shape is the one the app writes for a board alert.
  const notifications = readFileSync(`${root}src/utils/notifications.js`, 'utf8');
  assert.match(notifications, /`cme:\$\{ci\.key \?\? ci\.state\}:\$\{ci\.issues\.length\}:\$\{ci\.fpDates \?\? ci\.renewal \?\? "x"\}`/);
  assert.match(readFileSync(`${root}src/utils/boardTasks.js`, 'utf8'), /key: `board:\$\{b\.id\}`/);
});

// A supabase-js stand-in: every query resolves with the rows for its table;
// the Board Certification read (ilike on type) can be made to fail.
function fakeDb({ boardFails = false } = {}) {
  const data = {
    alert_acks: [],
    licenses: [{ id: 'synthetic-license', user_id: 'synthetic-member', type: 'Medical License', expiration_date: '2026-10-20' }],
    boards: [boardRow()],
  };
  return {
    from(table) {
      const q = { table, board: false, after: null };
      const chain = {
        select: () => chain, in: () => chain, gte: () => chain, lte: () => chain, order: () => chain, limit: () => chain,
        // The first-date read (licensure deadlines) finds nobody here.
        or: () => { q.after = 'none'; return chain; },
        ilike: () => { q.board = true; return chain; },
        gt: (_c, v) => { q.after = v; return chain; },
        then(resolve, reject) {
          let rows = q.board ? data.boards : (data[table] || []);
          if (q.board && boardFails) return Promise.resolve({ data: null, error: { message: 'synthetic failure' } }).then(resolve, reject);
          if (q.after !== null) rows = [];
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

test('the board records are one grouped read, any dates', async () => {
  const read = await readReminderGroup(fakeDb(), ['synthetic-member'], { tables: [{ table: 'licenses' }], today: '2026-10-01', lo: '2026-09-01', hi: '2026-12-30' });
  assert.equal(read.boardsFailed, false);
  assert.deepEqual(read.boards.get('synthetic-member').map(r => r.id), ['synthetic-board-record']);
  assert.ok(RECIPIENT_COLUMNS.split(', ').includes('specialties'), 'the recipient query reads the Settings boards');
});

test('a failed board read leaves the credential digest intact', async () => {
  const read = await readReminderGroup(fakeDb({ boardFails: true }), ['synthetic-member'], { tables: [{ table: 'licenses' }], today: '2026-10-01', lo: '2026-09-01', hi: '2026-12-30' });
  assert.equal(read.boardsFailed, true);
  assert.equal(read.failed.size, 0, 'no credential table counts as unread');
  assert.equal(read.acksFailed, false);
  assert.deepEqual(read.rows.get('licenses').get('synthetic-member').map(r => r.id), ['synthetic-license']);
  assert.equal(read.boards.size, 0);
});

test('send-reminders adds the steps after the records, never lets them block the digest, and holds told items on failure', () => {
  const loop = fn.slice(fn.indexOf('for (const t of TABLES)'), fn.indexOf('const decision = reminderEmailDecision'));
  const board = loop.indexOf('reminderBoardItems(p, read.boards.get(p.id) || [], { lead, now: new Date() })');
  assert.ok(board > 0, 'board steps are computed per member from the grouped read');
  assert.ok(board < loop.indexOf('const fp = await reminderFingerprint(items);'), 'and counted in the fingerprint');
  assert.match(loop, /let boardFailed = !!read\.boardsFailed;/);
  assert.match(loop, /try \{\s*items\.push\(\.\.\.\(reminderBoardItems[\s\S]*?\} catch \(e\) \{\s*boardFailed = true;/, 'an error is caught and logged');
  assert.match(loop, /const told = dryRun \|\| readFailed \|\| boardFailed \|\| licensureFailed \? null : reminderToldStill/, 'a run without the steps forgets nothing');
  assert.doesNotMatch(fn.slice(fn.indexOf('if (read.acksFailed || read.failed.size)'), fn.indexOf('const lead = reminderLeadDays')), /boards/, 'a board failure never refuses the digest');
  assert.match(fn, /"\\n      Mark it done in the app when finished\."/, 'the hint, once, on the first step');
  assert.match(fn, /i === firstBoard \?/);
});

test('a told board step, then a failed board read, holds the member: no send and nothing stored', async () => {
  const now = at('2026-10-01');
  const cred = { id: 'synthetic-license', table: 'licenses', exp: '2026-12-01' };
  const steps = reminderBoardItems(profile(), [boardRow()], { lead: 90, now });
  assert.ok(steps.length, 'the synthetic board has a step due');
  const told = await reminderFingerprint([cred, ...steps]);
  const member = { reminder_email_fingerprint: told, reminder_emailed_at: new Date(Date.now() - 86400000).toISOString() };
  // Without the hold, the run that could not read the boards would send at once.
  const credOnly = await reminderFingerprint([cred]);
  assert.deepEqual(reminderEmailDecision(member, { fingerprint: credOnly, freqDays: 30 }), { send: true, reason: 'list changed' });
  assert.equal(reminderToldBoard(told), true, 'a told board step is seen');
  assert.equal(reminderToldBoard(credOnly), false, 'a credential-only list is not held');
  assert.equal(reminderToldBoard(credOnly.split(';')[0]), false, 'a bare legacy hash is not held');
  assert.equal(reminderToldBoard(null), false, 'a member never emailed is not held');
  assert.notEqual(reminderToldStill(told, credOnly), null, 'and a held run would otherwise forget the step');
  // The function holds before any decision, send or stored change.
  const hold = fn.indexOf('if (boardFailed && reminderToldBoard(p.reminder_email_fingerprint))');
  assert.ok(hold > 0, 'send-reminders checks the told board steps on a failed board read');
  assert.ok(hold < fn.indexOf('const fp = await reminderFingerprint(items);'), 'before the fingerprint and decision');
  assert.match(fn.slice(hold, hold + 200), /error: "records_unavailable" \}\);\s*continue;/, 'as a failed credential table does');
});

test('the shared copies of the board code are the app\'s', () => {
  for (const rel of ['utils/boardTasks.js', 'utils/boardCompliance.js', 'constants/boardRequirements.js']) {
    const copy = readFileSync(`${root}supabase/functions/_shared/app/${rel}`, 'utf8');
    assert.ok(copy.endsWith(readFileSync(`${root}src/${rel}`, 'utf8')), rel);
  }
  const shared = readFileSync(`${root}supabase/functions/_shared/reminderBoardSteps.mjs`, 'utf8');
  assert.match(shared, /from '\.\/app\/utils\/boardTasks\.js'/);
  assert.doesNotMatch(shared + fn, /\u2014/, 'no em dashes');
});
