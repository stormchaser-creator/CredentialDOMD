// HOME-013, the setup walkthrough's way in: the NPI import (NpiPanel.runImport
// and the Settings import) saves every registry licence state other than the
// primary into settings.additionalStates (npiImport.js
// additionalStatesAfterImport), and Set Primary saves every tracked state
// there too. alertingStates kept every saved state, so an imported CO licence
// the member then marked "Expiration date not yet known" still held the ring
// down and listed "CO CME review records" under it, and Settings offered no
// way to remove CO because its licence keeps it tracked. Once a licence is
// held in a state, the licence decides. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { extractLicensesFromNPI, mergeNpiLicenses, additionalStatesAfterImport } from '../../src/utils/npiImport.js';
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

// A registry answer in the shape npiLookup.js hands the importer.
const REGISTRY = { allTaxonomies: [
  { code: '207T00000X', description: 'Neurological Surgery', isPrimary: true, license: 'SYN-TX-0001', state: 'TX' },
  { code: '207T00000X', description: 'Neurological Surgery', isPrimary: false, license: 'SYN-CO-0002', state: 'CO' },
] };

/** What runImport leaves behind: the imported licences and the saved picks. */
function importFromRegistry(existing = []) {
  const rows = extractLicensesFromNPI(REGISTRY);
  let n = 0;
  const added = mergeNpiLicenses(existing, rows, { degreeType: 'MD', makeId: () => `lic-${n++}` });
  return { licenses: [...existing, ...added], additionalStates: additionalStatesAfterImport([], 'TX', rows) };
}

const data = (licenses, additionalStates) => ({
  settings: { name: 'Synthetic Physician', degreeType: 'MD', primaryState: 'TX', additionalStates, reminderLeadDays: 90 },
  licenses, cme: [], privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [],
});

/** The ring as Home builds it (App.jsx stateComps, ringComps, standing). */
function ring(d) {
  const stateComps = trackedStates(d.settings.primaryState, d.settings.additionalStates, d.licenses)
    .map(st => ({ st, comp: complianceFor(d, st), lic: findStateLicense(d.licenses, st) }));
  const counted = new Set(alertingStates(d.settings.primaryState, d.settings.additionalStates, d.licenses));
  return { stateComps, score: standingScore({ items: d.licenses, stateComps: stateComps.filter(x => counted.has(x.st)), leadDays: 90 }) };
}

test('an NPI-imported licence marked "date not yet known" keeps its card but not its CME in the ring', () => {
  const imported = importFromRegistry();
  assert.deepEqual(imported.additionalStates, ['CO'], 'the import saves CO among the picks, as the setup walkthrough does');
  // The TX licence gets its date; CO's is not known yet.
  const licenses = imported.licenses.map(l => l.state === 'TX' ? { ...l, expirationDate: day(800) } : { ...l, dateUnknown: true });
  const d = data(licenses, imported.additionalStates);

  assert.deepEqual(alertingStates('TX', imported.additionalStates, licenses), ['TX']);
  const after = ring(d);
  assert.deepEqual(after.stateComps.map(x => x.st).sort(), ['CO', 'TX'], 'CO is still tracked: its card, the CME page and Vera show it');
  assert.equal(after.score.needsAction.some(n => n.item.id === 'cme:CO'), false, 'no "CO CME review records" line');
  const withoutCo = ring(data(licenses.filter(l => l.state === 'TX'), []));
  assert.equal(after.score.percent, withoutCo.score.percent, 'the ring reads as it would with no CO licence and no CO pick');
  assert.equal(after.score.total, withoutCo.score.total);

  // Its date arrives: CO counts again.
  const dated = ring(data(licenses.map(l => l.state === 'CO' ? { ...l, dateUnknown: false, expirationDate: day(40) } : l), imported.additionalStates));
  assert.ok(dated.score.needsAction.some(n => n.item.id === 'cme:CO'), 'a dated CO licence with no CME logged is back in the ring');
});

test('the bell raises no CME alert for the imported date-unknown licence\'s state', async () => {
  const { generateAlerts } = await bundle('src/utils/notifications.js');
  const imported = importFromRegistry();
  const licenses = imported.licenses.map(l => l.state === 'TX' ? { ...l, expirationDate: day(800) } : { ...l, dateUnknown: true });
  assert.equal(generateAlerts(data(licenses, imported.additionalStates)), null, 'TX renews in 800 days; CO is a Resolve task');
  const pending = licenses.map(l => l.state === 'CO' ? { ...l, dateUnknown: false, lifecycleStatus: 'pending_confirmation', expirationDate: day(20) } : l);
  assert.equal(generateAlerts(data(pending, imported.additionalStates)), null, 'pending confirmation reads the same');
});

test('a state saved by Set Primary, or picked before its licence was added, follows the licence too', () => {
  // A hand-added UT licence awaiting confirmation. Set Primary on TX saves
  // every other tracked state among the picks (SettingsSection makePrimary).
  const UT = { id: 'ut', type: 'State Medical License', state: 'UT', licenseNumber: 'SYN-UT', lifecycleStatus: 'pending_confirmation', expirationDate: day(20) };
  const TX = { id: 'tx', type: 'State Medical License', state: 'TX', licenseNumber: 'SYN-TX', expirationDate: day(800) };
  const saved = trackedStates('CO', [], [TX, UT]).filter(st => st !== 'TX');
  assert.deepEqual(saved.sort(), ['CO', 'UT']);
  assert.deepEqual(alertingStates('TX', saved, [TX, UT]).sort(), ['CO', 'TX'], 'CO (no licence held) is a pick and counts; UT follows its pending licence');
  // The primary follows its licence the same way.
  assert.deepEqual(alertingStates('UT', [], [UT]), [], 'a primary held only by a pending licence adds no CME to the ring');
});

test('alertingStates: picks with no licence held count; a held licence decides otherwise', () => {
  const lic = (state, extra = {}) => ({ id: `${state}-${Object.keys(extra).join('-')}`, type: 'State Medical License', state, licenseNumber: `SYN-${state}`, expirationDate: day(300), ...extra });
  assert.deepEqual(alertingStates('TX', ['NM'], []), ['TX', 'NM'], 'no licence held: the Settings picks count as before');
  assert.deepEqual(alertingStates('TX', ['CO'], [lic('CO', { dateUnknown: true, expirationDate: '' })]), ['TX']);
  assert.deepEqual(alertingStates('TX', ['CO'], [lic('CO', { dateUnknown: true, expirationDate: '' }), lic('CO')]), ['TX', 'CO'], 'one alertable CO licence is enough');
  assert.deepEqual(alertingStates('TX', ['CO'], [lic('CO', { lifecycleStatus: 'provisional' })]), ['TX', 'CO'], 'a provisional licence alerts');
  assert.deepEqual(alertingStates('TX', ['CO'], [lic('CO', { expirationDate: '' })]), ['TX', 'CO'], 'an undated active licence still counts: its date is missing, not unknown');
  assert.deepEqual(alertingStates('TX', ['CO'], [lic('CO', { lifecycleStatus: 'historical' })]), ['TX', 'CO'], 'a historical licence is not held, so the pick stands');
  assert.deepEqual(alertingStates('TX', ['CO'], [{ ...lic('CO', { dateUnknown: true }), type: 'DEA Registration' }]), ['TX', 'CO'], 'only a medical licence decides');
  assert.deepEqual(alertingStates(null, undefined, [null, lic('CO', { dateUnknown: true })]), []);
});
