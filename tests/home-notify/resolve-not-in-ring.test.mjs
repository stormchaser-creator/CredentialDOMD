// HOME-013: a licence saved as "date not yet known" or "Pending confirmation"
// is a Resolve task, never an alert and never in the ring. Its state stayed
// in CME tracking (right: the state card and Vera still show it), but the
// ring counted that state's CME as due today, because with no alertable
// licence to anchor its window daysLeft is null. Adding a CO date-unknown and
// a UT pending licence took the ring from 67% to 50% and listed "CO CME review
// records" and "UT CME review records" under it; the bell alerted on both.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { trackedStates, alertingStates, complianceFor, findStateLicense, standingScore } from '../../src/utils/compliance.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const day = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const bundle = async (entry) => {
  const out = await build({ entryPoints: [`${root}${entry}`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
};

const TX = { id: 'tx', type: 'State Medical License', state: 'TX', licenseNumber: 'SYN-TX', expirationDate: day(800) };
const DEA = { id: 'dea', type: 'DEA Registration', state: 'TX', licenseNumber: 'SYN-DEA', expirationDate: day(30) };
const CO = { id: 'co', type: 'State Medical License', state: 'CO', licenseNumber: 'SYN-CO', dateUnknown: true, statusSource: 'Synthetic board email' };
const UT = { id: 'ut', type: 'State Medical License', state: 'UT', licenseNumber: 'SYN-UT', expirationDate: day(20), lifecycleStatus: 'pending_confirmation', statusSource: 'Synthetic letter' };
const data = (licenses, settings = {}) => ({
  settings: { name: 'Synthetic Physician', degreeType: 'MD', primaryState: 'TX', additionalStates: [], reminderLeadDays: 90, ...settings },
  licenses, cme: [], privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [],
});

/** The ring as Home builds it: every tracked state's card, only the alerting states' CME in the ring (App.jsx ringComps). */
function ring(d) {
  const stateComps = trackedStates(d.settings.primaryState, d.settings.additionalStates, d.licenses)
    .map(st => ({ st, comp: complianceFor(d, st), lic: findStateLicense(d.licenses, st) }));
  const counted = new Set(alertingStates(d.settings.primaryState, d.settings.additionalStates, d.licenses));
  const ringComps = stateComps.filter(x => counted.has(x.st));
  return { stateComps, score: standingScore({ items: d.licenses, stateComps: ringComps, leadDays: 90 }) };
}

test('a date-unknown or pending licence keeps its state card but adds nothing to the ring', () => {
  const before = ring(data([TX, DEA]));
  const after = ring(data([TX, DEA, CO, UT]));
  assert.deepEqual(after.stateComps.map(x => x.st).sort(), ['CO', 'TX', 'UT'], 'both states are still tracked (state cards, CME page, Vera)');
  assert.equal(after.score.percent, before.score.percent, `the ring stays at ${before.score.percent}%`);
  assert.equal(after.score.total, before.score.total, 'no new tracked deadline check');
  assert.deepEqual(after.score.needsAction.map(n => n.item.id), before.score.needsAction.map(n => n.item.id));
  assert.equal(after.score.needsAction.some(n => /^cme:(CO|UT)$/.test(n.item.id)), false, 'no "<ST> CME review records" line');
});

test('alertingStates: Settings picks and states held by a licence that can alert', () => {
  assert.deepEqual(alertingStates('TX', [], [TX, CO, UT]), ['TX']);
  assert.deepEqual(alertingStates(null, [], [CO, UT]), []);
  assert.deepEqual(alertingStates('CO', ['UT'], []).sort(), ['CO', 'UT'], 'a state picked in Settings with no licence held there still counts');
  assert.deepEqual(alertingStates('CO', ['UT'], [CO, UT]), [], 'once a licence is held there, the licence decides, picked or not (npi-import-resolve-ring.test.mjs)');
  assert.deepEqual(alertingStates(null, [], [{ ...UT, lifecycleStatus: 'provisional' }]), ['UT'], 'a provisional licence alerts, so its state counts');
  assert.deepEqual(alertingStates(null, [], [{ ...CO, dateUnknown: false }]), ['CO'], 'an undated active licence still counts: its date is missing, not unknown');
  assert.deepEqual(alertingStates(null, undefined, [null, { ...TX, lifecycleStatus: 'historical' }]), []);
  // Once the date arrives the state counts again.
  const resolved = ring(data([TX, DEA, { ...CO, dateUnknown: false, expirationDate: day(40) }]));
  assert.ok(resolved.score.needsAction.some(n => n.item.id === 'cme:CO'), 'a dated CO licence with no CME logged is back in the ring');
});

test('the bell raises no CME alert for a state held only by a pending or date-unknown licence', async () => {
  const { generateAlerts } = await bundle('src/utils/notifications.js');
  assert.equal(generateAlerts(data([TX, CO, UT])), null, 'nothing alerts: TX renews in 800 days, CO and UT are Resolve tasks');
  const withDate = generateAlerts(data([TX, { ...CO, dateUnknown: false, expirationDate: day(40) }]));
  assert.deepEqual(withDate.cmeIssues.map(c => c.state), ['CO'], 'a dated CO licence with no CME logged raises its CME gap again');
});

test('Home feeds the ring, its CME summary and its pending mark from the alerting states only', () => {
  const app = readFileSync(`${root}src/App.jsx`, 'utf8');
  assert.match(app, /alertingStates\(data\.settings\.primaryState, data\.settings\.additionalStates, data\.licenses, data\.settings\.degreeType\)/);
  assert.match(app, /items: lapsingCreds, missingRequired: missingExpiration, stateComps: \[\.\.\.ringComps, \.\.\.certRingComps\],/);
  assert.match(app, /const cmeSummary = cmeReviewSummary\(ringComps\);/);
  assert.equal((app.match(/<CmeReviewSummary stateComps=\{ringComps\}/g) || []).length, 2, 'phone and desk heroes');
  assert.doesNotMatch(app, /<CmeReviewSummary stateComps=\{stateComps\}/);
  assert.match(app, /const stateCards = stateComps\.map\(renderStateCard\);/, 'every tracked state keeps its card');
  const bell = readFileSync(`${root}src/utils/notifications.js`, 'utf8');
  assert.match(bell, /const allStates = new Set\(alertingStates\(data\.settings\.primaryState, data\.settings\.additionalStates, data\.licenses, data\.settings\.degreeType\)\);/);
  assert.match(bell, /complianceListFor\(data\)\.filter\(x => allStates\.has\(x\.st\)\)/);
});

test('the state card of a licence on the Resolve card names the open question, not "No license on file"', async () => {
  const { rollingWindowLabel } = await import('../../src/utils/cmePresentation.js');
  const { lifecycleNote } = await import('../../src/utils/lifecycle.js');
  assert.equal(rollingWindowLabel('CO', 2, lifecycleNote(CO)), 'CO license: date not yet known, so the app tracks a rolling 2-yr window');
  assert.equal(rollingWindowLabel('UT', 2, lifecycleNote(UT)), 'UT license: pending confirmation, so the app tracks a rolling 2-yr window');
  assert.equal(rollingWindowLabel('NM', 3), 'No NM license on file, so the app tracks a rolling 3-yr window');
  const app = readFileSync(`${root}src/App.jsx`, 'utf8');
  assert.match(app, /const waiting = comp\.windowAnchored \? null : resolvePendingLicense\(data\.licenses, st, kind \|\| "medical"\);/);
  const { resolvePendingLicense } = await import('../../src/utils/compliance.js');
  assert.equal(resolvePendingLicense([TX, CO, UT], 'CO'), CO);
  assert.equal(resolvePendingLicense([TX, CO, UT], 'UT'), UT);
  assert.equal(resolvePendingLicense([TX, CO, UT], 'TX'), null, 'an alertable licence is not a Resolve task');
  assert.equal(resolvePendingLicense([{ ...CO, lifecycleStatus: 'historical' }], 'CO'), null, 'nor is a retired one');
  assert.match(app, /: rollingWindowLabel\(st, comp\.cycle, waiting \? lifecycleNote\(waiting\) : null\)\}/);
  assert.doesNotMatch(app, /`No \$\{st\} license on file/);
});
