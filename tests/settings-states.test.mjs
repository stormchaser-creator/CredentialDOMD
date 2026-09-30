// SETTINGS-009: Settings > Licensed States showed a remove (✕) button on
// every row. A state that comes from a medical license was re-added by
// trackedStates at once, and the primary with no other picked state returned
// early: both taps silently did nothing, and the states stayed on Home and in
// the Matrix. Now ✕ appears only where the tap changes the list, and a
// license-held state says why it stays.
//
// The real SettingsSection through the component harness; synthetic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import { DEFAULT_DATA, DEFAULT_SETTINGS } from '../src/constants/defaults.js';
import { trackedStates } from '../src/utils/compliance.js';

const src = rel => new URL(`../src/${rel}`, import.meta.url).href;
const modules = {
  states: await import(src('constants/states.js')),
  contactFormat: await import(src('utils/contactFormat.js')),
  cmePassport: await import(src('utils/cmePassport.js')),
  stateRequirements: await import(src('constants/stateRequirements.js')),
  boardRequirements: await import(src('constants/boardRequirements.js')),
  membershipCopy: await import(src('content/membershipCopy.js')),
  reminderPreferences: await import(src('utils/reminderPreferences.js')),
  forwardingAddresses: await import(src('utils/forwardingAddresses.js')),
  compliance: await import(src('utils/compliance.js')),
  useInputStyle: { useInputStyle: () => ({}) },
  useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [], loading: false }) },
  aiClient: { useSharedAiStatus: () => ({}), fetchSharedAiStatus() {}, describeAiStatus: () => '', describeOpusStatus: () => '', describeAiBudget: () => null, useAnthropicAvailable: () => false },
  cptCoder: { CODER_MODELS: [] },
  deskKeys: { DESK_KEYS: [] },
};
const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });

async function statesCard(settings, licenses) {
  const saved = [];
  const data = { ...DEFAULT_DATA, licenses, settings: { ...DEFAULT_SETTINGS, ...settings } };
  const app = { data, updateSettings: u => { saved.push(JSON.parse(JSON.stringify(u))); return true; }, theme: T,
    allTrackedStates: trackedStates(data.settings.primaryState, data.settings.additionalStates, licenses), navigate() {}, limitedLaunch: { enabled: false }, isDesktop: false };
  const c = await mountComponent('src/components/pages/SettingsSection.jsx', { app, modules });
  const rows = () => c.nodes().filter(n => n.type === 'div' && n.key && /^[A-Z]{2}$/.test(n.key));
  const removeIn = row => c.nodes(row).find(n => n.type === 'button' && c.text(n) === '✕');
  return { c, saved, rows, removeIn, row: st => rows().find(r => r.key === st) };
}
const caLicense = { id: 'ca', type: 'State Medical License (MD)', state: 'CA', expirationDate: '2027-01-31' };

test('primary TX with no picked states and a CA license: no remove button that does nothing', async () => {
  const s = await statesCard({ primaryState: 'TX', additionalStates: [] }, [caLicense]);
  assert.deepEqual(s.rows().map(r => r.key), ['TX', 'CA']);
  assert.equal(s.removeIn(s.row('CA')), undefined, 'CA comes from a license');
  assert.equal(s.removeIn(s.row('TX')), undefined, 'TX is the only picked state');
  assert.match(s.c.text(s.row('CA')), /Tracked because you hold a CA medical license\. Mark that license historical to stop tracking\./);
  assert.doesNotMatch(s.c.text(s.row('CA')), /—/);
});

test('a picked state without a license keeps its remove button, and removing it works', async () => {
  const s = await statesCard({ primaryState: 'TX', additionalStates: ['NV'] }, [caLicense]);
  const nv = s.removeIn(s.row('NV'));
  assert.ok(nv);
  nv.props.onClick();
  assert.deepEqual(s.saved, [{ additionalStates: [] }]);
  const tx = s.removeIn(s.row('TX'));
  assert.ok(tx, 'the primary can go when another picked state takes its place');
});

test('a license marked historical no longer holds its state', async () => {
  const s = await statesCard({ primaryState: 'TX', additionalStates: ['CA'] }, [{ ...caLicense, lifecycleStatus: 'historical' }]);
  assert.ok(s.removeIn(s.row('CA')));
});
