// Review of f06d9276 (goal4, 2026-10-02): while the PA and NP rule data
// loads after launch, the screen is kept and shows the records without what
// needs the data (AppContext withoutAppRuleNeeds): a PA or NP profession
// reads as the one shown before, and with no physician degree a PA, RN or
// APRN licence waits off the screen. What acted on that masked copy acted
// wrongly: Vera answered a PA as an MD, an NPI import added a hidden licence
// again, and a registry MD or DO answer replaced a PA it could not see. Each
// now reads the records as saved once the data is in (recordsWithAppRules),
// and the waiting line names the profession the rules on screen belong to.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as appRules from '../../src/utils/appRules.js';
import * as professions from '../../src/constants/professions.js';
import * as npiImport from '../../src/utils/npiImport.js';
import * as compliance from '../../src/utils/compliance.js';
import { DEFAULT_DATA, DEFAULT_SETTINGS } from '../../src/constants/defaults.js';
import { mountComponent, settle } from '../component-harness.mjs';
import { mountVera, recorder } from '../assistant-harness.mjs';

const { withoutAppRuleNeeds, APP_RULES_UNAVAILABLE } = appRules;
const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });
const lic = (id, type, state, licenseNumber) => ({ id, type, state, licenseNumber, name: `${type} ${state}`, expirationDate: '2027-06-30' });
const PA_CA = lic('pa-ca', 'State Physician Assistant License', 'CA', 'SYN-PA-77');
const RN_CA = lic('rn-ca', 'RN License', 'CA', 'SYN-RN-9');
const MED_TX = lic('med-tx', 'State Medical License', 'TX', 'SYN-MD-1');

// The records as saved and as the kept screen shows them (the real mask).
function screens(saved, shownDegree) {
  const data = { ...DEFAULT_DATA, ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings } };
  return { saved: data, shown: withoutAppRuleNeeds(data, shownDegree) };
}
// AppContext recordsWithAppRules, with the load the test lets finish.
function recordsFor(saved, { fails = false } = {}) {
  let release;
  const gate = new Promise(r => { release = r; });
  const st = saved.settings;
  const read = async () => {
    await gate;
    if (fails) throw new TypeError('Failed to fetch dynamically imported module');
    return { data: saved, trackedStates: compliance.trackedStates(st.primaryState, st.additionalStates, saved.licenses, st.degreeType) };
  };
  return { read, release: () => release() };
}

// ── Vera ────────────────────────────────────────────────────────────────────

async function maskedVera({ saved, shown, waiting, records }) {
  const rec = recorder();
  const turns = [];
  const st = shown.settings;
  const vera = await mountVera({
    rec, data: shown,
    app: { allTrackedStates: compliance.trackedStates(st.primaryState, st.additionalStates, shown.licenses, st.degreeType), appRulesWaiting: waiting, recordsWithAppRules: records.read },
    modules: {
      appRules,
      assistant: {
        buildSnapshot: (d, states) => ({ physician: { degree: d.settings.degreeType }, states, licences: (d.licenses || []).map(l => l.id) }),
        splitFields: () => ({}),
        assistantTurn: async (args) => { turns.push(args); return { reply: `Answer for ${args.snapshot.physician.degree}`, actions: [] }; },
      },
    },
  });
  return { ...vera, turns, saved };
}

test('Vera while the rules load: her answer reads her saved profession and licences, never the one shown in their place', async () => {
  const { saved, shown } = screens({ settings: { degreeType: 'PA', primaryState: 'TX' }, licenses: [PA_CA] }, 'MD');
  assert.equal(shown.settings.degreeType, 'MD', 'the kept screen shows the earlier profession');
  const records = recordsFor(saved);
  const v = await maskedVera({ saved, shown, waiting: { failed: false, profession: 'PA', shownProfession: 'MD' }, records });
  const asked = v.ask('How many CE hours do I need to renew?');
  await settle(); v.render();
  assert.equal(v.turns.length, 0, 'not answered from the copy on screen');
  records.release();
  await asked;
  await settle(); v.render();
  assert.equal(v.turns.length, 1);
  assert.equal(v.turns[0].snapshot.physician.degree, 'PA');
  assert.deepEqual(v.turns[0].snapshot.states, ['TX', 'CA'], 'her PA licence state is tracked');
  assert.match(v.pageText(), /Answer for PA/);
});

test('Vera while the rules cannot load: the plain sentence, her question kept to try again, nothing answered', async () => {
  const { saved, shown } = screens({ settings: { degreeType: 'NP', primaryState: 'TX' }, licenses: [RN_CA] }, 'MD');
  const records = recordsFor(saved, { fails: true });
  const v = await maskedVera({ saved, shown, waiting: { failed: true, profession: 'NP', shownProfession: 'MD' }, records });
  records.release();
  await v.ask('What do I need for California?');
  await settle(); v.render();
  assert.equal(v.turns.length, 0);
  assert.ok(v.pageText().includes(APP_RULES_UNAVAILABLE));
  assert.ok(v.store.chat.some(m => m.role === 'user' && m.failed === true));
  assert.equal(v.nodes().find(n => n.type === 'textarea')?.props.disabled ?? false, false, 'not left busy');
});

test('Vera with nothing waiting: answered from the screen at once, as before', async () => {
  const data = { ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS, degreeType: 'MD', primaryState: 'TX' }, licenses: [MED_TX] };
  let read = 0;
  const v = await maskedVera({ saved: data, shown: data, waiting: null, records: { read: async () => { read += 1; return { data, trackedStates: ['TX'] }; } } });
  await v.ask('When does Texas renew?');
  assert.equal(read, 0);
  assert.equal(v.turns.length, 1);
  assert.equal(v.turns[0].snapshot.physician.degree, 'MD');
});

// ── The NPI imports ─────────────────────────────────────────────────────────

const registry = ({ credential = '', rows }) => ({
  npi: '1234567893', firstName: 'Synthetic', lastName: 'Member', credential,
  allTaxonomies: rows.map(([code, state, license], i) => ({ code, description: 'Synthetic', isPrimary: i === 0, license, state })),
  address: { state: 'TX' },
});
const DO_ANSWER = registry({ credential: 'D.O.', rows: [['207T00000X', 'TX', 'SYN-DO-4']] });
const RN_ANSWER = registry({ rows: [['163W00000X', 'CA', 'SYN-RN-9']] });

async function setupPanel({ shown, waiting, records, answer }) {
  const added = [], saved = [];
  const app = { data: shown, theme: T, appRulesWaiting: waiting, recordsWithAppRules: records?.read,
    addItem: (key, item) => { added.push(item); return true; }, updateSettings: (u) => { saved.push(JSON.parse(JSON.stringify(u))); return true; } };
  const c = await mountComponent('src/components/features/setup/NpiPanel.jsx', {
    app,
    modules: {
      npiImport, professions, appRules, helpers: { generateId: (() => { let n = 0; return () => `new-${n++}`; })() },
      npiLookup: { lookupNPI: async () => answer, findProvidersByName: async () => ({ results: [] }), extractLicensesFromNPI: npiImport.extractLicensesFromNPI },
      useInputStyle: { useInputStyle: () => ({}) }, states: await import('../../src/constants/states.js'),
    },
  });
  const lookUp = async () => {
    c.nodes().find(n => n.type === 'input').props.onChange({ target: { value: answer.npi } });
    c.render();
    const done = c.nodes().find(n => n.type === 'button' && /Look up/.test(c.text(n))).props.onClick();
    return done;
  };
  return { c, added, saved, lookUp };
}

test('Setup NPI panel while the rules load: a registry DO never replaces the PA it cannot see', async () => {
  const { saved: records, shown } = screens({ settings: { degreeType: 'PA', primaryState: 'TX' }, licenses: [PA_CA] }, '');
  assert.equal(shown.settings.degreeType, '', 'shown blank in its place');
  const r = recordsFor(records);
  const p = await setupPanel({ shown, waiting: { failed: false, profession: 'PA', shownProfession: '' }, records: r, answer: DO_ANSWER });
  const looking = p.lookUp();
  await settle();
  assert.deepEqual(p.saved, [], 'nothing saved from the copy on screen');
  r.release();
  await looking;
  await settle();
  assert.deepEqual(p.saved, [{ npi: '1234567893' }], 'the NPI, and no profession over her PA');
});

test('Setup NPI panel while the rules load: an RN licence held off the screen is not imported a second time', async () => {
  const { saved: records, shown } = screens({ settings: { degreeType: '', primaryState: 'TX' }, licenses: [RN_CA] }, '');
  assert.deepEqual(shown.licenses, [], 'the RN licence waits off the screen');
  const r = recordsFor(records);
  const p = await setupPanel({ shown, waiting: { failed: false }, records: r, answer: RN_ANSWER });
  r.release();
  await p.lookUp();
  await settle(); p.c.render();
  // The screen, without the RN licence, offers it.
  const importButton = p.c.nodes().find(n => n.type === 'button' && /^Import 1 license/.test(p.c.text(n).trim()));
  assert.ok(importButton, 'offered from the copy on screen');
  importButton.props.onClick();
  await settle();
  assert.deepEqual(p.added, [], 'already on file');
  // The same import with nothing waiting adds what is new, at once.
  const fresh = await setupPanel({ shown: records, waiting: null, records: null, answer: registry({ rows: [['163W00000X', 'NV', 'SYN-RN-5']] }) });
  await fresh.lookUp();
  await settle(); fresh.c.render();
  fresh.c.nodes().find(n => n.type === 'button' && /^Import 1 license/.test(fresh.c.text(n).trim())).props.onClick();
  assert.deepEqual(fresh.added.map(l => l.state), ['NV']);
});

test('Setup NPI panel while the rules load: a second tap in the wait adds each new licence once', async () => {
  const { saved: records, shown } = screens({ settings: { degreeType: 'MD', primaryState: 'TX' }, licenses: [] }, 'MD');
  const two = registry({ credential: 'M.D.', rows: [['207T00000X', 'TX', 'SYN-MD-7'], ['207T00000X', 'NV', 'SYN-MD-8']] });
  // The lookup reads the saved records first; the import's read waits on the gate.
  let reads = 0;
  const r = recordsFor(records);
  const counted = { read: () => { reads += 1; return reads === 1 ? Promise.resolve({ data: records }) : r.read(); } };
  const p = await setupPanel({ shown, waiting: { failed: false }, records: counted, answer: two });
  await p.lookUp();
  reads = 0;
  await settle(); p.c.render();
  const offer = () => p.c.nodes().find(n => n.type === 'button' && /^Import 2 licenses|^Importing/.test(p.c.text(n).trim()));
  offer().props.onClick();
  p.c.render();
  assert.equal(offer().props.disabled, true, 'held while the rules load');
  assert.equal(p.c.text(offer()).trim(), 'Importing...');
  offer().props.onClick();
  offer().props.onClick();
  assert.equal(reads, 1, 'one import in flight');
  r.release();
  await settle(); p.c.render();
  assert.deepEqual(p.added.map(l => l.state).sort(), ['NV', 'TX'], 'each new licence once');
  assert.equal(p.saved.filter(u => 'additionalStates' in u).length, 1, 'one settings patch');
});

test('Setup NPI panel: an import the rules could not load for can be tapped again', async () => {
  const { saved: records, shown } = screens({ settings: { degreeType: '', primaryState: 'TX' }, licenses: [] }, '');
  const failing = recordsFor(records, { fails: true });
  let tries = -1; // the lookup's own read first
  const p = await setupPanel({ shown, waiting: { failed: true }, records: { read: () => { tries += 1; return tries === 1 ? failing.read() : Promise.resolve({ data: records }); } }, answer: RN_ANSWER });
  await p.lookUp();
  await settle(); p.c.render();
  const offer = () => p.c.nodes().find(n => n.type === 'button' && /^Import 1 license|^Importing/.test(p.c.text(n).trim()));
  offer().props.onClick();
  failing.release();
  await settle(); p.c.render();
  assert.ok(p.c.pageText().includes(APP_RULES_UNAVAILABLE));
  assert.deepEqual(p.added, []);
  assert.equal(offer().props.disabled, false, 'released after the failure');
  offer().props.onClick();
  await settle();
  assert.equal(tries, 2);
  assert.deepEqual(p.added.map(l => l.state), ['CA']);
});

const settingsModules = async () => {
  const src = rel => new URL(`../../src/${rel}`, import.meta.url).href;
  return {
    states: await import(src('constants/states.js')), contactFormat: await import(src('utils/contactFormat.js')), cmePassport: await import(src('utils/cmePassport.js')),
    stateRequirements: await import(src('constants/stateRequirements.js')), boardRequirements: await import(src('constants/boardRequirements.js')),
    membershipCopy: await import(src('content/membershipCopy.js')), reminderPreferences: await import(src('utils/reminderPreferences.js')),
    forwardingAddresses: await import(src('utils/forwardingAddresses.js')), compliance, professions, npiImport, appRules,
    useInputStyle: { useInputStyle: () => ({}) }, useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [], loading: false }) },
    aiClient: { useSharedAiStatus: () => ({}), fetchSharedAiStatus() {}, describeAiStatus: () => '', describeOpusStatus: () => '', describeAiBudget: () => null, useAnthropicAvailable: () => false },
    cptCoder: { CODER_MODELS: [] }, deskKeys: { DESK_KEYS: [] },
    helpers: { generateId: (() => { let n = 0; return () => `new-${n++}`; })() },
  };
};

async function settingsImport({ shown, waiting, records, answer }) {
  const added = [], saved = [];
  const st = shown.settings;
  const app = { data: shown, theme: T, navigate() {}, limitedLaunch: { enabled: false }, isDesktop: false,
    allTrackedStates: compliance.trackedStates(st.primaryState, st.additionalStates, shown.licenses, st.degreeType),
    appRulesWaiting: waiting, recordsWithAppRules: records?.read,
    addItem: (key, item) => { added.push(item); return true; }, updateSettings: (u) => { saved.push(JSON.parse(JSON.stringify(u))); return true; } };
  const modules = await settingsModules();
  modules.npiLookup = { findProvidersByName: async () => ({ results: [answer], note: '' }), extractLicensesFromNPI: npiImport.extractLicensesFromNPI, lookupNPI: async () => answer };
  const c = await mountComponent('src/components/pages/SettingsSection.jsx', { app, modules });
  await c.nodes().find(n => n.type === 'button' && /Find My NPI|Re-search/.test(c.text(n))).props.onClick();
  await settle(); c.render();
  const pick = c.nodes().find(n => n.type === 'button' && n.key === answer.npi);
  assert.ok(pick, 'the registry answer is offered');
  return { c, added, saved, pick: () => pick.props.onClick() };
}

test('Settings NPI import while the rules load: a registry DO never replaces the PA shown as an MD', async () => {
  const { saved: records, shown } = screens({ settings: { name: 'Synthetic Member', degreeType: 'PA', primaryState: 'TX' }, licenses: [PA_CA] }, 'MD');
  const r = recordsFor(records);
  const s = await settingsImport({ shown, waiting: { failed: false, profession: 'PA', shownProfession: 'MD' }, records: r, answer: DO_ANSWER });
  s.pick();
  await settle();
  assert.deepEqual(s.saved, [], 'nothing saved from the copy on screen');
  r.release();
  await settle();
  assert.equal(s.saved.length, 1);
  assert.equal('degreeType' in s.saved[0], false, 'her PA stands');
  assert.equal(s.saved[0].npi, '1234567893');
});

test('Settings NPI import while the rules load: a second tap, on the same result or another, imports once', async () => {
  const { saved: records, shown } = screens({ settings: { name: 'Synthetic Member', degreeType: 'MD', primaryState: 'TX' }, licenses: [] }, 'MD');
  let reads = 0;
  const r = recordsFor(records);
  const s = await settingsImport({ shown, waiting: { failed: false }, records: { read: () => { reads += 1; return r.read(); } }, answer: DO_ANSWER });
  s.pick();
  s.c.render();
  const row = s.c.nodes().find(n => n.type === 'button' && n.key === DO_ANSWER.npi);
  assert.equal(row.props.disabled, true, 'the results are held while the rules load');
  row.props.onClick();
  s.pick();
  assert.equal(reads, 1, 'one import in flight');
  r.release();
  await settle();
  assert.deepEqual(s.added.map(l => l.state), ['TX'], 'the licence once');
  assert.equal(s.saved.length, 1, 'one settings patch');
});

test('Settings NPI import while the rules cannot load: nothing saved, and the plain sentence', async () => {
  const { saved: records, shown } = screens({ settings: { name: 'Synthetic Member', degreeType: '', primaryState: 'TX' }, licenses: [RN_CA] }, '');
  const r = recordsFor(records, { fails: true });
  const s = await settingsImport({ shown, waiting: { failed: true }, records: r, answer: RN_ANSWER });
  s.pick();
  r.release();
  await settle(); s.c.render();
  assert.deepEqual(s.saved, []);
  assert.deepEqual(s.added, []);
  assert.ok(s.c.pageText().includes(APP_RULES_UNAVAILABLE));
});

test('Settings NPI import with nothing waiting: at once, as before', async () => {
  const data = { ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS, name: 'Synthetic Member', degreeType: 'MD', primaryState: 'TX' }, licenses: [] };
  let read = 0;
  const s = await settingsImport({ shown: data, waiting: null, records: { read: async () => { read += 1; } }, answer: DO_ANSWER });
  s.pick();
  assert.equal(read, 0);
  assert.equal(s.saved.length, 1, 'saved in the same tap');
  assert.equal(s.saved[0].degreeType, 'DO', 'an MD takes the registry DO, as before');
  assert.deepEqual(s.added.map(l => l.state), ['TX']);
});

// ── The waiting line ────────────────────────────────────────────────────────

test('the waiting line names the profession the rules on screen belong to', async () => {
  const line = appRules.appRulesWaitingLine;
  assert.equal(line({ failed: false, profession: 'PA', shownProfession: 'MD' }),
    'Your profession is now Physician Assistant. Loading the PA and NP rules; until then, the rules on screen are for Doctor of Medicine.');
  assert.equal(line({ failed: true, profession: 'NP', shownProfession: '' }),
    `Your profession is now Nurse Practitioner. Until the PA and NP rules load, the rules on screen are not the ones for it. ${APP_RULES_UNAVAILABLE}`);
  assert.equal(line({ failed: false }), 'Loading the PA and NP rules. What needs them shows in a moment.', 'a licence waiting: as before');
  assert.equal(line({ failed: true }), `Your change is saved. What needs the PA and NP rules shows once they load. ${APP_RULES_UNAVAILABLE}`);
  for (const w of [{ failed: false, profession: 'PA', shownProfession: 'MD' }, { failed: true, profession: 'NP', shownProfession: '' }]) assert.doesNotMatch(line(w), /\u2014/, 'no em dash');
  const notice = await readFile(new URL('../../src/components/shared/AppRulesNotice.jsx', import.meta.url), 'utf8');
  assert.match(notice, /\{appRulesWaitingLine\(appRulesWaiting\)\}/, 'the notice shows that line');
});

test('AppContext: the line is told both professions, and recordsWithAppRules reads the records as saved after the load', async () => {
  const ctx = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
  assert.match(ctx, /savedDegree !== shownDegree \? \{ profession: savedDegree, shownProfession: shownDegree \}/);
  assert.match(ctx, /const recordsWithAppRules = useCallback\(async \(\) => \{\n\s+await loadAppRules\(\);\n\s+const d = dataRef\.current \|\| DEFAULT_DATA;/);
  assert.match(ctx, /recordsWithAppRules, setData/, 'in the context value');
});
