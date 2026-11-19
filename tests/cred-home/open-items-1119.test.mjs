// 2026-11-19 open items: Delaware CSR CME counted in the CSR period, the New
// Hampshire board certification condition from Med 402.01, ABIM steps, the
// banner snooze naming each board step's date, and licensure deadlines in
// the reminder email. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeCompliance, complianceFor } from '../../src/utils/compliance.js';
import { csrCountingPeriod } from '../../src/utils/csrWindow.js';
import { STATE_CSR_TYPE } from '../../src/constants/stateControlledSubstance.js';
import { CSR_DECLINED_FIELD, FIRST_LICENSED_FIELD } from '../../src/constants/appMarkerFields.js';
import { BOARD_EXEMPTION_CONDITIONS } from '../../src/utils/conditionalCme.js';
import { getStateEntry } from '../../src/constants/stateRequirements.js';
import { boardComplianceFor } from '../../src/utils/boardCompliance.js';
import { boardTasksFor, openBoardTasks, boardTaskAlerts } from '../../src/utils/boardTasks.js';
import { reminderLicensureItems } from '../../supabase/functions/_shared/reminderLicensureDeadlines.mjs';
import { reminderFingerprint, reminderEmailDecision, reminderToldLicensure } from '../../supabase/functions/_shared/reminderCadence.mjs';
import { readReminderGroup } from '../../supabase/functions/_shared/reminderReads.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const at = (iso) => new Date(`${iso}T12:00:00`);
const cs = (date, hours = 2) => ({ id: `cme-${date}`, title: 'Opioid prescribing', date, hours, category: 'AMA PRA Category 1', topics: ['Controlled Substances'] });
const deTopic = (comp) => comp.topicResults.find(t => t.topic === 'Controlled Substances');

// ── Delaware: the CSR's 2 hours count in the CSR period ──

test('DE: the CSR period ends at the registration on file, else the next June 30 of an odd year', () => {
  assert.deepEqual(csrCountingPeriod('DE', '2029-06-30', at('2027-07-02')), { end: '2029-06-30', years: 2, source: 'record' });
  assert.deepEqual(csrCountingPeriod('DE', null, at('2026-11-19')), { end: '2027-06-30', years: 2, source: 'rule' });
  assert.deepEqual(csrCountingPeriod('DE', '2025-06-30', at('2026-11-19')), { end: '2027-06-30', years: 2, source: 'rule' }, 'a lapsed record date is not used');
  assert.equal(csrCountingPeriod('WY', null, at('2026-11-19')), null, 'no fixed cycle, no period');
});

test('DE: hours after the license window but inside the CSR period count; hours before the CSR period do not', () => {
  // License window: 2025-03-31 to 2027-03-31. CSR period: 2025-06-30 to 2027-06-30.
  const opts = { licenseExpiration: '2027-03-31', csrPeriod: { end: '2027-06-30', years: 2, source: 'record' } };
  const late = computeCompliance([cs('2027-05-01')], 'DE', 'MD', opts);
  assert.equal(deTopic(late).met, true, 'May 2027 is inside the CSR period');
  assert.match(deTopic(late).periodLabel, /controlled substance registration period ending Jun 30, 2027/);
  const early = computeCompliance([cs('2025-04-15')], 'DE', 'MD', opts);
  assert.equal(deTopic(early).met, false, 'April 2025 is before the CSR period');
  assert.equal(early.totalEarned, 2, 'the hours still count toward the license total');
  assert.doesNotMatch(deTopic(early).note, /counts it in your license window/);
});

test('DE: complianceFor reads the CSR record, and the CSR topics drop out for a physician who does not prescribe there', () => {
  const lic = { id: 'l1', type: 'State Medical License', state: 'DE', expirationDate: '2027-03-31' };
  const csr = { id: 'c1', type: STATE_CSR_TYPE, state: 'DE', expirationDate: '2027-06-30' };
  const data = { settings: { degreeType: 'MD', specialties: [] }, licenses: [lic, csr], cme: [cs('2027-05-01')] };
  const comp = complianceFor(data, 'DE');
  assert.equal(deTopic(comp).met, true);
  assert.equal(deTopic(comp).period.registrationSource, 'record');
  const declined = complianceFor({ ...data, licenses: [{ ...lic, customFields: { [CSR_DECLINED_FIELD]: '2026-11-19' } }] }, 'DE');
  assert.equal(declined.topicResults.some(t => t.topic === 'Controlled Substances' || t.topic === 'Delaware Controlled Substance Law'), false);
  assert.equal(declined.conditionalTopics.some(t => t.topic === 'Controlled Substances'), false, 'not shown as a question either');
});

test('AL: the ACSC holders\' controlled substance hours drop out the same way', () => {
  const lic = { id: 'l1', type: 'State Medical License', state: 'AL', expirationDate: '2027-12-31', customFields: { [CSR_DECLINED_FIELD]: '2026-11-19' } };
  const comp = complianceFor({ settings: { degreeType: 'MD', specialties: [] }, licenses: [lic], cme: [] }, 'AL');
  assert.equal(comp.topicResults.some(t => t.topic === 'Controlled Substances'), false);
  assert.equal(comp.topicResults.some(t => t.topic === 'Ethics'), true, 'the boundaries course is everyone\'s');
});

// ── New Hampshire ──

test('NH: the condition restates Med 402.01(g) and (i): any specialty board exam or current MOC/OCC, not ABMS alone', () => {
  const c = BOARD_EXEMPTION_CONDITIONS.NH;
  assert.doesNotMatch(c, /ABMS/);
  assert.match(c, /specialty board exam \(initial or recertification\)/);
  assert.match(c, /maintenance of certification \(MOC or OCC\)/);
  const nh = getStateEntry('NH', 'DO');
  assert.match(nh.sourceUrl, /^https:\/\/gc\.nh\.gov\//);
  assert.match(nh.topics.find(t => t.topic === 'Pain Management').note, /still owed/);
  const guide = readFileSync(`${root}landing/states/new-hampshire.html`, 'utf8');
  assert.doesNotMatch(guide, /Passing an ABMS board exam/);
  assert.match(guide, /Med 402\.01\(i\)/);
});

// ── ABIM ──

const abim = { settings: { specialties: ['ABIM'], degreeType: 'MD' }, licenses: [{ id: 'b1', type: 'Board Certification (ABMS)', name: 'ABIM', expirationDate: '2030-12-31' }], cme: [] };

test('ABIM: the fee is dated Dec 31 for the coming year; points and the assessment are the physician\'s own cycle, never dated', () => {
  const [card] = boardComplianceFor(abim);
  const tasks = boardTasksFor(abim, card, at('2026-11-19')).tasks;
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  assert.equal(byId.fee.due, '2026-12-31');
  assert.equal(byId.points.due, null);
  assert.match(byId.points.dueRule, /ABIM Physician Portal/);
  assert.equal(byId.assessment.due, null);
});

test('ABIM: the first period asks and never alerts; the next year\'s fee alerts inside the lead window', () => {
  const boards = boardComplianceFor(abim);
  assert.deepEqual(openBoardTasks(abim, boards, 90, at('2026-11-19')), []);
  assert.deepEqual(openBoardTasks(abim, boards, 90, at('2026-12-20')), []);
  const next = openBoardTasks(abim, boards, 90, at('2027-11-20'));
  assert.deepEqual(next.flatMap(o => o.tasks.map(t => `${t.id}:${t.due}`)), ['fee:2027-12-31']);
});

// ── Banner snooze: each board step's date ──

test('a board alert whose steps have different dates names each in the banner fingerprint; one date stays as before', () => {
  // Through the app's own alert builder: ABAI steps due 12-31 share a date.
  const abai = { settings: { specialties: ['ABAI'], degreeType: 'MD' }, licenses: [{ id: 'b2', type: 'Board Certification (ABMS)', name: 'ABAI', expirationDate: '2030-12-31' }], cme: [] };
  for (const a of boardTaskAlerts(abai, boardComplianceFor(abai), 120, at('2027-11-20'))) {
    if (a.fpDates) assert.match(a.fpDates, /^\d{4}-\d{2}-\d{2}(\+\d{4}-\d{2}-\d{2})+$/);
    else assert.match(a.renewal, /^\d{4}-\d{2}-\d{2}$/);
  }
  const src = readFileSync(`${root}src/utils/boardTasks.js`, 'utf8');
  assert.match(src, /dues\.every\(d => d === dues\[0\]\) \? undefined : dues\.join\("\+"\)/);
});

test('under a banner snooze, a later step of the same board the banner showed no longer wakes the email', async () => {
  const now = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const d1 = iso(new Date(now.getTime() + 20 * 86400000));
  const d2 = iso(new Date(now.getTime() + 40 * 86400000));
  const cred = { id: 'synthetic-license', table: 'licenses', exp: iso(new Date(now.getTime() + 200 * 86400000)) };
  const s1 = { id: 'board:ABMS:ABAI:fee:2027', table: 'board', exp: d1 };
  const s2 = { id: 'board:ABMS:ABAI:cap2:2027', table: 'board', exp: d2 };
  const base = {
    reminder_email_fingerprint: await reminderFingerprint([cred]),
    reminder_emailed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    snoozed_until: new Date(Date.now() + 20 * 86400000).toISOString(),
  };
  const fingerprint = await reminderFingerprint([cred, s1, s2]);
  assert.deepEqual(reminderEmailDecision({ ...base, alerts_fingerprint: `soon:licenses:${cred.exp}|cme:board:ABMS:ABAI:2:${d1}+${d2}` }, { fingerprint, freqDays: 7 }),
    { send: false, reason: 'snoozed' }, 'both steps were on the snoozed banner');
  assert.deepEqual(reminderEmailDecision({ ...base, alerts_fingerprint: `soon:licenses:${cred.exp}|cme:board:ABMS:ABAI:1:${d1}` }, { fingerprint, freqDays: 7 }),
    { send: true, reason: 'list changed' }, 'the banner showed one step; the second is new');
});

// ── Licensure deadlines in the reminder email ──

const alProfile = { id: 'synthetic-member', degree_type: 'MD', specialties: [] };
const alLicense = (extra = {}) => ({ id: 'synthetic-al', user_id: 'synthetic-member', type: 'State Medical License', state: 'AL', expiration_date: '2027-12-31', issued_date: '2026-03-01', lifecycle_status: 'active', custom_fields: { [FIRST_LICENSED_FIELD]: '2026-03-01' }, ...extra });

test('the email lists an unmet licensure course inside the lead time, from the app\'s own code', () => {
  const items = reminderLicensureItems(alProfile, { licenses: [alLicense()], cme: [] }, { lead: 90, now: at('2026-12-15'), today: '2026-12-15' });
  assert.deepEqual(items.map(i => [i.id, i.table, i.exp, i.days, i.state]), [['licensure:AL:Ethics', 'licensure', '2027-03-01', 76, 'AL']]);
  assert.match(items[0].name, /AL Ethics \(one-time\)/);
});

test('never emailed: outside the lead time, already logged, or with no first date the physician entered', () => {
  assert.deepEqual(reminderLicensureItems(alProfile, { licenses: [alLicense()], cme: [] }, { lead: 90, now: at('2026-11-19') }), []);
  const logged = { id: 'c1', user_id: 'synthetic-member', title: 'Boundaries', date: '2026-06-01', hours: 2, category: 'AMA PRA Category 1', topics: ['Ethics'] };
  assert.deepEqual(reminderLicensureItems(alProfile, { licenses: [alLicense()], cme: [logged] }, { lead: 90, now: at('2026-12-15') }), []);
  assert.deepEqual(reminderLicensureItems(alProfile, { licenses: [alLicense({ custom_fields: {} })], cme: [] }, { lead: 90, now: at('2026-12-15') }), []);
  assert.deepEqual(reminderLicensureItems(alProfile, undefined, { lead: 90, now: at('2026-12-15') }), [], 'a member with no first date is never read');
  assert.deepEqual(reminderLicensureItems({ ...alProfile, degree_type: 'PA' }, { licenses: [alLicense()], cme: [] }, { lead: 90, now: at('2026-12-15') }), []);
});

test('the reads fetch licences and CME only for members with a first date, and a failure is marked, never thrown', async () => {
  const calls = [];
  const db = (failCme = false) => ({
    from(table) {
      const q = { table, or: false, ilike: false };
      const chain = {
        select: () => chain, in: () => chain, gte: () => chain, lte: () => chain, order: () => chain, limit: () => chain, gt: () => { q.after = true; return chain; },
        ilike: () => { q.ilike = true; return chain; },
        or: (f) => { q.or = f; return chain; },
        then(resolve, reject) {
          calls.push(`${table}${q.or ? ':first' : ''}`);
          if (q.after) return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          if (table === 'cme' && failCme) return Promise.resolve({ data: null, error: { message: 'synthetic' } }).then(resolve, reject);
          const rows = table === 'licenses' ? (q.ilike ? [] : [alLicense()]) : table === 'cme' ? [] : [];
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  });
  const read = await readReminderGroup(db(), ['synthetic-member'], { tables: [], today: '2026-12-15', lo: '2026-11-15', hi: '2027-03-15' });
  assert.equal(read.licensureFailed, false);
  assert.deepEqual(read.licensure.get('synthetic-member').licenses.map(r => r.id), ['synthetic-al']);
  assert.ok(calls.includes('licenses:first'));
  const failed = await readReminderGroup(db(true), ['synthetic-member'], { tables: [], today: '2026-12-15', lo: '2026-11-15', hi: '2027-03-15' });
  assert.equal(failed.licensureFailed, true);
  assert.equal(failed.licensure.size, 0);
});

test('a told licensure course, then a failed read, holds the member; the banner part covers it under a snooze', async () => {
  const item = { id: 'licensure:AL:Ethics', table: 'licensure', exp: '2027-03-01' };
  const fp = await reminderFingerprint([item]);
  assert.equal(reminderToldLicensure(fp), true);
  assert.equal(reminderToldLicensure(await reminderFingerprint([])), false);
  const fn = readFileSync(`${root}supabase/functions/send-reminders/index.ts`, 'utf8');
  assert.match(fn, /licensureFailed && reminderToldLicensure\(p\.reminder_email_fingerprint\)/);
  assert.match(fn, /readFailed \|\| boardFailed \|\| licensureFailed \? null/);
  const cred = { id: 'synthetic-license', table: 'licenses', exp: '2099-01-01' };
  const decision = reminderEmailDecision({
    reminder_email_fingerprint: await reminderFingerprint([cred]),
    reminder_emailed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    snoozed_until: new Date(Date.now() + 20 * 86400000).toISOString(),
    alerts_fingerprint: 'soon:licenses:2099-01-01|cme:licensure:AL:Ethics:1:2027-03-01',
  }, { fingerprint: await reminderFingerprint([cred, item]), freqDays: 7 });
  assert.deepEqual(decision, { send: false, reason: 'snoozed' });
});

// ── State controlled substance registrations added 2026-11-19 ──

test('DC, MA, MI, NM and RI are in the table from their own official text; New Jersey stays out', async () => {
  const { STATE_CSR } = await import('../../src/constants/stateControlledSubstance.js');
  for (const st of ['DC', 'MA', 'MI', 'NM', 'RI']) assert.ok(STATE_CSR[st], st);
  assert.equal(STATE_CSR.NJ, undefined);
  for (const st of ['DC', 'MA', 'MI', 'RI']) assert.equal(STATE_CSR[st].expiresWithLicense, true, st);
  assert.equal(STATE_CSR.NM.expires, undefined, 'New Mexico\'s month is the registration\'s own');
});

test('"Add it" for a registration that expires with the license prefills the current license date', async () => {
  const { csrCard } = await import('../../src/utils/stateDuties.js');
  const lic = { id: 'l-mi', type: 'State Medical License', state: 'MI', expirationDate: '2029-01-31' };
  const data = { settings: { degreeType: 'DO', specialties: [] }, licenses: [lic], cme: [] };
  const card = csrCard(data, 'MI', at('2026-11-19'));
  assert.equal(card.status, 'ask');
  assert.deepEqual(card.prefill, { type: STATE_CSR_TYPE, state: 'MI', name: 'MI CS license', expirationDate: '2029-01-31' });
  const nm = csrCard({ ...data, licenses: [{ ...lic, id: 'l-nm', state: 'NM' }] }, 'NM', at('2026-11-19'));
  assert.equal(nm.prefill.expirationDate, undefined, 'no date the app can know');
  const lapsed = csrCard({ ...data, licenses: [{ ...lic, expirationDate: '2026-01-31' }] }, 'MI', at('2026-11-19'));
  assert.equal(lapsed?.prefill?.expirationDate, undefined, 'a passed license date is not offered');
});

// ── Review fixes: helpers, alert date, a record outranks "don't prescribe" ──

const deData = (cme, extra = {}) => ({
  settings: { degreeType: 'MD', specialties: [], reminderLeadDays: 90, primaryState: 'DE' },
  licenses: [
    { id: 'l1', type: 'State Medical License', state: 'DE', expirationDate: '2027-03-31', ...extra },
    { id: 'c1', type: STATE_CSR_TYPE, state: 'DE', expirationDate: '2027-06-30' },
  ],
  cme,
});

test('the course suggestions and the CME math panel count the CSR period, as the engine does', async () => {
  const { topicCountingPool } = await import('../../src/utils/topicMatch.js');
  const { stillCountingTopics } = await import('../../src/utils/cmeCore.js');
  const before = cs('2025-05-01'), after = cs('2027-05-01');
  const comp = complianceFor(deData([before, after]), 'DE');
  const row = deTopic(comp);
  assert.deepEqual(topicCountingPool(comp, row, [before, after]).map(c => c.id), [after.id]);
  assert.deepEqual(stillCountingTopics(after, comp.topicResults, comp.windowEnd).length, 1);
  assert.deepEqual(stillCountingTopics(before, comp.topicResults, comp.windowEnd).length, 0);
});

test('a registration on file outranks an earlier "I don\'t prescribe here"', () => {
  const comp = complianceFor(deData([], { customFields: { [CSR_DECLINED_FIELD]: '2026-11-19' } }), 'DE');
  assert.ok(deTopic(comp), 'the CSR topic applies again');
});

test('the DE CSR CME gap alerts at the registration date, never inside the license gap', async () => {
  const { build } = await import('esbuild');
  const out = await build({ entryPoints: [fileURLToPath(new URL('../../src/utils/notifications.js', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  const { generateAlerts } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  const RealDate = Date;
  const freeze = (iso) => { globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [`${iso}T12:00:00`])); } static now() { return new RealDate(`${iso}T12:00:00`).getTime(); } }; };
  try {
    // Mid April 2027: the license renewed (window to 2029) but the CSR runs to 2027-06-30.
    freeze('2027-04-15');
    const renewed = deData([], { expirationDate: '2029-03-31' });
    const a = generateAlerts(renewed);
    const csr = (a?.cmeIssues || []).find(ci => ci.kind === 'csr');
    assert.ok(csr, 'alerted on its own');
    assert.equal(csr.renewal, '2027-06-30');
    assert.ok(!(a.cmeIssues || []).some(ci => ci.kind !== 'csr' && ci.issues.some(x => /Controlled Substances/.test(x))), 'not in the license gap');
    // No registration on file: the card asks; nothing is alerted.
    const noRecord = { ...renewed, licenses: renewed.licenses.filter(l => l.type !== STATE_CSR_TYPE) };
    assert.ok(!(generateAlerts(noRecord)?.cmeIssues || []).some(ci => ci.kind === 'csr'));
  } finally { globalThis.Date = RealDate; }
});
