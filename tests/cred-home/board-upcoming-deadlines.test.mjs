// A dated board step is a deadline the app lists, like a dated credential,
// however far off it is: the AOBS QI attestation (due 2027-12-31, once per
// 2025-2027 OCC cycle) shows in the Notification Center's upcoming list, in
// Home search and in Vera's snapshot while it is outside the reminder lead
// window, and raises no alert, banner or email there. Done, not-required,
// unconfirmed and not-yet steps are never listed. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BOARD_TASKS } from '../../src/constants/boardRequirements.js';
import { boardComplianceFor } from '../../src/utils/boardCompliance.js';
import { boardTaskAlerts, boardTaskField, datedBoardSteps, notRequiredMark, upcomingBoardSteps } from '../../src/utils/boardTasks.js';
import { reminderBoardItems } from '../../supabase/functions/_shared/reminderBoardSteps.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, 'utf8');
const at = (iso) => new Date(`${iso}T12:00:00`);
const doData = (lic = {}, extra = {}) => ({
  settings: { degreeType: 'DO', specialties: [], reminderLeadDays: 90, ...extra },
  licenses: [{ id: 'bc', type: 'Board Certification (AOA)', name: 'AOBS Surgery', expirationDate: '2027-12-31', ...lic }],
  cme: [],
});
const boards = (data) => boardComplianceFor(data);
const qiTask = BOARD_TASKS['AOA:AOBS'].tasks.find(t => t.id === 'qi');
const qiField = boardTaskField('AOA:AOBS', qiTask, '2025-2027');
const TODAY = at('2026-11-18');

test('a cycle step due in about 13 months is listed as an upcoming deadline and raises no alert', () => {
  const data = doData();
  const steps = datedBoardSteps(data, boards(data), 90, TODAY);
  const qi = steps.find(s => s.taskId === 'qi');
  assert.ok(qi, 'the QI attestation is listed');
  assert.equal(qi.due, '2027-12-31');
  assert.equal(qi.name, 'AOBS QI attestation');
  assert.equal(qi.daysLeft, 408);
  assert.equal(qi.alerted, false, 'outside the 90 day lead window');
  assert.deepEqual(upcomingBoardSteps(data, boards(data), 90, TODAY).map(s => s.taskId), ['qi']);
  // No alert for it: the bell, the banner and the in-app message read boardTaskAlerts.
  assert.deepEqual(boardTaskAlerts(data, boards(data), 90, TODAY), []);
});

test('inside the lead window the step alerts as before and leaves the upcoming list', () => {
  const data = doData();
  const late = at('2027-11-01');
  const alerts = boardTaskAlerts(data, boards(data), 90, late);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].issues, ['QI attestation: due 2027-12-31']);
  const qi = datedBoardSteps(data, boards(data), 90, late).find(s => s.taskId === 'qi');
  assert.equal(qi.alerted, true);
  assert.equal(upcomingBoardSteps(data, boards(data), 90, late).some(s => s.taskId === 'qi'), false, 'listed once, as the alert');
});

test('a done, not-required, unconfirmed or not-yet step is never listed', () => {
  const done = doData({ customFields: { [qiField]: '2026-06-01' } });
  assert.equal(datedBoardSteps(done, boards(done), 90, TODAY).some(s => s.taskId === 'qi'), false, 'done');
  const notReq = doData({ customFields: { [qiField]: notRequiredMark('2026-06-01') } });
  assert.equal(datedBoardSteps(notReq, boards(notReq), 90, TODAY).some(s => s.taskId === 'qi'), false, 'not required');
  // 2026-11-18: the 2026 Longitudinal Assessment closed Nov 15 with no mark: asked on the card, not listed.
  const plain = doData();
  assert.equal(datedBoardSteps(plain, boards(plain), 90, TODAY).some(s => s.taskId === 'la'), false, 'unconfirmed');
  // 2026-03-01: the assessment is due Nov 15 for a current certificate...
  assert.equal(datedBoardSteps(plain, boards(plain), 90, at('2026-03-01')).find(s => s.taskId === 'la')?.due, '2026-11-15');
  // ...but not started yet for one on the old exam track expiring in 2028.
  const oldTrack = doData({ issuedDate: '2015-06-01', expirationDate: '2028-12-31' });
  assert.equal(datedBoardSteps(oldTrack, boards(oldTrack), 90, at('2026-03-01')).some(s => s.taskId === 'la'), false, 'not yet');
  // A step with no published date is not a dated deadline.
  assert.equal(datedBoardSteps(plain, boards(plain), 90, TODAY).some(s => s.taskId === 'license'), false, 'no date');
});

test('the reminder email still names only steps inside the lead window', () => {
  const rows = [{ id: 'bc', type: 'Board Certification (AOA)', name: 'AOBS Surgery', expiration_date: '2027-12-31' }];
  const profile = { degree_type: 'DO', specialties: [] };
  assert.deepEqual(reminderBoardItems(profile, rows, { lead: 90, now: TODAY }), [], 'outside the window: no email line');
  assert.deepEqual(reminderBoardItems(profile, rows, { lead: 90, now: at('2027-11-01') }).map(i => i.name), ['AOBS QI attestation'], 'inside it: as before');
});

test('a PA or NP has no physician board steps listed', () => {
  for (const degreeType of ['PA', 'NP']) {
    const data = doData({}, { degreeType });
    assert.deepEqual(datedBoardSteps(data, boards(data), 90, TODAY), []);
  }
});

const bundle = async (entry, stubs = {}) => {
  const out = await build({
    entryPoints: [`${root}${entry}`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'],
    plugins: [{ name: 'stubs', setup(b) {
      for (const [filter, contents] of Object.entries(stubs)) {
        b.onResolve({ filter: new RegExp(filter) }, () => ({ path: filter, namespace: 'stub' }));
        b.onLoad({ filter: new RegExp(`^${filter.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`), namespace: 'stub' }, () => ({ contents, loader: 'js' }));
      }
    } }],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
};
const AI_STUB = 'export const geminiCall=()=>{};export const proxyErrorMessage=()=>null;export const anthropicAvailable=()=>false;export const anthropicClientFor=async()=>null;export const anthropicErrorMessage=()=>null;export const anthropicSdk=()=>null;export const AI_MESSAGES={};';

test('Vera can answer "when is my QI attestation due"', async () => {
  const { boardStepsSnapshot, buildSnapshot, systemStaticFor } = await bundle('src/utils/assistant.js', { 'aiClient$': AI_STUB, 'veraSourcesClient\\.js$': 'export const loadVeraSources=async()=>({});export const sourceCheckReceipt=()=>null;' });
  const steps = boardStepsSnapshot(doData(), TODAY);
  const qi = steps.find(s => s.step === 'AOBS QI attestation');
  assert.equal(qi.due, '2027-12-31');
  assert.equal(qi.inReminderWindow, false);
  assert.equal(qi.period, '2025-2027');
  // A done step is not sent as a deadline.
  assert.equal(boardStepsSnapshot(doData({ customFields: { [qiField]: '2026-06-01' } }), TODAY).some(s => s.step === 'AOBS QI attestation'), false);
  // The live snapshot carries the list (the QI date is after the real today too), and the prompt says how to read it.
  const snap = buildSnapshot(doData(), []);
  assert.ok(snap.boardSteps.some(s => s.step === 'AOBS QI attestation' && s.due === '2027-12-31'));
  assert.equal('boardSteps' in buildSnapshot({ settings: { degreeType: 'MD', specialties: [] }, licenses: [], cme: [] }, []), false, 'no key without a step');
  assert.match(systemStaticFor('DO'), /snapshot\.boardSteps/);
});

test('Home search finds a board step by its name and opens CME progress, where its board card is', async () => {
  const { searchRecords } = await bundle('src/components/features/HomeSearch.jsx', { 'context/AppContext$': 'export const useApp=()=>({});' });
  const groups = searchRecords(doData(), 'qi');
  const g = groups.find(x => x.sec.key === 'boardSteps');
  assert.ok(g, 'a Board steps group');
  assert.equal(g.hits[0].label, 'AOBS QI attestation');
  assert.equal(g.hits[0].sub, 'due 2027-12-31');
  assert.equal(g.sec.sub, 'cmeProgress');
  assert.match(read('src/App.jsx'), /sec\.key === "boardSteps" \|\| sec\.key === "stateDeadlines"\) \{ openCmeProgress\(\); return; \}/);
});

test('the Notification Center lists upcoming board steps apart from the alerts, never counted', () => {
  const src = read('src/components/pages/NotificationCenter.jsx');
  assert.match(src, /const lead = reminderLeadDays\(data\.settings\.reminderLeadDays\);/);
  assert.match(src, /upcomingBoardSteps\(data, boardComplianceFor\(data\), lead\)/);
  assert.match(src, /Upcoming deadlines/);
  // Shown with All Clear too, and never added to the alert count.
  assert.match(src, /\{upcomingList && <div style=\{\{ marginTop: 18 \}\}>\{upcomingList\}<\/div>\}/);
  assert.doesNotMatch(read('src/utils/notifications.js'), /upcomingBoardSteps|datedBoardSteps/);
  assert.doesNotMatch(src, /—[^"]*Board step|Upcoming deadlines—/);
});
