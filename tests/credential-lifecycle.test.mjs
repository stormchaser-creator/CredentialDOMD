import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  lifecycleOf, isAlertable, isInactive, needsResolution, isOnCv, isDateUnknown, expirationWaived,
  lifecycleNote, lifecycleSummary, normalizeLifecycle, LIFECYCLE_STATUSES, STATUS_SOURCE_MAX,
} from '../src/utils/lifecycle.js';
import { prepareRecord } from '../src/utils/recordWrite.js';
import { licenseFields, privilegeFields, insuranceFields } from '../src/utils/credentialForms.js';
import { findStateLicense, standingScore, complianceFor, hasDEARegistration } from '../src/utils/compliance.js';
import { dateless, buildSetup } from '../src/utils/setupTasks.js';
import { buildCredentialRows } from '../src/utils/credentialExport.js';
import { buildCredentialText } from '../src/utils/helpers.js';
import { renewalView } from '../src/utils/renewalRoute.js';
import { remindable, rowLifecycle } from '../supabase/functions/_shared/reminderRows.mjs';
import * as clientPacket from '../src/utils/requestPacket.js';
import * as serverPacket from '../supabase/functions/_shared/requestPacket.ts';

// Ticket 2c819309: historical credentials and unknown renewal dates without
// false alerts. Synthetic records only.

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
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

// -- The rule itself ------------------------------------------------------
test('status reads as active unless it says otherwise, so a bad value keeps alerts on', () => {
  for (const v of [undefined, null, '', 'bogus', 'ACTIVE', 7, {}]) assert.equal(lifecycleOf({ lifecycleStatus: v }), 'active', String(v));
  assert.equal(lifecycleOf({ lifecycleStatus: ' Superseded ' }), 'superseded');
  assert.equal(lifecycleOf(null), 'active');
});

test('only active and provisional records with a known date can alert', () => {
  const expect = { active: true, provisional: true, pending_confirmation: false, superseded: false, historical: false };
  for (const s of LIFECYCLE_STATUSES) {
    assert.equal(isAlertable({ lifecycleStatus: s, expirationDate: day(10) }), expect[s], s);
    assert.equal(isAlertable({ lifecycleStatus: s, dateUnknown: true }), false, `${s} + date unknown`);
  }
  assert.equal(isAlertable({ expirationDate: day(-400) }), true, 'a record with no lifecycle at all is active (cme, health records)');
  assert.equal(isAlertable({ dateUnknown: 'true' }), true, 'only an explicit true silences a record');
  assert.equal(isDateUnknown({ dateUnknown: 'false' }), false);
});

test('pending confirmation and unknown dates need resolving; retired records never do', () => {
  assert.equal(needsResolution({ lifecycleStatus: 'pending_confirmation' }), true);
  assert.equal(needsResolution({ dateUnknown: true }), true);
  assert.equal(needsResolution({ lifecycleStatus: 'provisional', dateUnknown: true }), true);
  assert.equal(needsResolution({ lifecycleStatus: 'historical', dateUnknown: true }), false);
  assert.equal(needsResolution({ lifecycleStatus: 'superseded' }), false);
  assert.equal(needsResolution({}), false);
  assert.equal(needsResolution(null), false);
  assert.deepEqual(['active', 'provisional', 'pending_confirmation', 'superseded', 'historical'].map(s => isOnCv({ lifecycleStatus: s })), [true, true, false, false, false]);
  assert.deepEqual(['historical', 'superseded'].map(s => isInactive({ lifecycleStatus: s })), [true, true]);
});

test('labels name what a record is, with no em dash', () => {
  assert.equal(lifecycleNote({}), null);
  assert.equal(lifecycleNote({ lifecycleStatus: 'historical' }), 'Historical');
  assert.equal(lifecycleNote({ dateUnknown: true }), 'Date not yet known');
  assert.equal(lifecycleSummary({ lifecycleStatus: 'provisional', dateUnknown: true }), 'Provisional or temporary, date not yet known');
  for (const s of LIFECYCLE_STATUSES) assert.doesNotMatch(lifecycleSummary({ lifecycleStatus: s }), /\u{2014}/u);
});

test('every write is normalised: five statuses, strict booleans, a clean source, a real replacement', () => {
  const out = normalizeLifecycle('licenses', { id: 'a', lifecycleStatus: 'Bogus', dateUnknown: 'yes', supersededBy: 'b', statusSource: '  x\n  y ', noExpiration: 1 });
  assert.deepEqual(out, { id: 'a', lifecycleStatus: 'active', dateUnknown: false, supersededBy: null, statusSource: 'x y', noExpiration: false });
  assert.equal(normalizeLifecycle('licenses', { id: 'a', lifecycleStatus: 'superseded', supersededBy: ' b ' }).supersededBy, 'b');
  assert.equal(normalizeLifecycle('licenses', { id: 'a', lifecycleStatus: 'superseded', supersededBy: 'a' }).supersededBy, null, 'never replaced by itself');
  assert.equal(normalizeLifecycle('insurance', { statusSource: 'z'.repeat(500) }).statusSource.length, STATUS_SOURCE_MAX);
  assert.equal(normalizeLifecycle('privileges', { statusSource: '   ' }).statusSource, null);
  assert.deepEqual(normalizeLifecycle('licenses', { noExpiration: true, dateUnknown: true }), { noExpiration: true, dateUnknown: false }, '"does not expire" and "not known yet" are different answers');
  const untouched = { id: 'c', expirationDate: '2027-01-01' };
  assert.equal(normalizeLifecycle('licenses', untouched), untouched, 'a record without lifecycle keys is returned as is');
  const cme = { lifecycleStatus: 'Bogus' };
  assert.equal(normalizeLifecycle('cme', cme), cme, 'other sections are not touched');
  assert.equal(prepareRecord('licenses', { id: 'a', name: 'Jordan Rivera', lifecycleStatus: 'HISTORICAL' }, 'Jordan Rivera').lifecycleStatus, 'historical');
});

// -- Forms ----------------------------------------------------------------
const req = (fields, key, form) => {
  const f = fields.find(x => x.key === key);
  return typeof f.required === 'function' ? f.required(form) : !!f.required;
};
test('an unknown date or a pending confirmation lets a record save without a made-up date', () => {
  const lic = licenseFields({ degreeType: 'DO' }), priv = privilegeFields(), ins = insuranceFields();
  assert.equal(req(lic, 'expirationDate', { type: 'State Medical License (DO)' }), true);
  assert.equal(req(lic, 'expirationDate', { type: 'State Medical License (DO)', dateUnknown: true }), false);
  assert.equal(req(lic, 'expirationDate', { type: 'Board Certification (AOA)', noExpiration: true }), false, 'does-not-expire still works');
  assert.equal(req(priv, 'expirationDate', {}), true, 'Reappointment Due stays required by default');
  assert.equal(req(priv, 'expirationDate', { dateUnknown: true }), false);
  assert.equal(req(priv, 'expirationDate', { lifecycleStatus: 'pending_confirmation' }), false);
  assert.equal(req(ins, 'expirationDate', { type: 'Tail Coverage', lifecycleStatus: 'historical' }), true, 'a historical policy keeps its real dates');
  assert.equal(req(ins, 'expirationDate', { type: 'Tail Coverage', dateUnknown: true }), false);
  assert.equal(expirationWaived({ lifecycleStatus: 'superseded' }), false);
});

test('the status fields: a picker over the same section, shown when they apply', () => {
  const records = [{ id: 'nd-temp', type: 'State Medical License (DO)', state: 'ND' }, { id: 'nd-full', type: 'State Medical License (DO)', state: 'ND' }];
  const fields = licenseFields({ degreeType: 'DO', records });
  const replaced = fields.find(f => f.key === 'supersededBy');
  assert.equal(replaced.show({ lifecycleStatus: 'active' }), false);
  assert.equal(replaced.show({ lifecycleStatus: 'superseded' }), true);
  assert.deepEqual(replaced.options({ id: 'nd-temp' }).map(o => o.value), ['nd-full'], 'a record cannot be replaced by itself');
  assert.equal(replaced.options({ id: 'nd-temp' })[0].label, 'State Medical License (DO), ND');
  const status = fields.find(f => f.key === 'lifecycleStatus');
  assert.deepEqual(status.options.map(o => o.value), LIFECYCLE_STATUSES);
  assert.equal(status.defaultValue, 'active');
  const source = fields.find(f => f.key === 'statusSource');
  assert.equal(source.maxLength, 200);
  assert.equal(source.show({}), false);
  assert.equal(source.show({ dateUnknown: true }), true);
  const unknown = fields.find(f => f.key === 'dateUnknown');
  assert.equal(unknown.show({ type: 'Certification' }), false, 'a course certification never expires');
  assert.equal(unknown.show({ type: 'Board Certification (AOA)', noExpiration: true }), false);
  assert.equal(privilegeFields().find(f => f.key === 'dateUnknown').checkboxLabel, 'Reappointment date not yet known');
});

// -- Alerts, the ring, the CME window ------------------------------------
const data = (over = {}) => ({
  settings: { name: 'Synthetic Physician', degreeType: 'DO', primaryState: 'ND', reminderLeadDays: 90 },
  licenses: [], cme: [], privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [],
  ...over,
});
test('a prior residency policy that expired years ago raises no alert; a provisional licence still does', async () => {
  const { generateAlerts } = await bundle('src/utils/notifications.js');
  const quiet = generateAlerts(data({
    insurance: [{ id: 'res', type: 'Medical Malpractice (Claims-Made)', expirationDate: '2019-06-30', lifecycleStatus: 'historical' }],
    privileges: [{ id: 'p1', type: 'Surgical Privileges', facility: 'Mercy', dateUnknown: true, expirationDate: day(-5) }],
    licenses: [{ id: 'l-pend', type: 'State Medical License (DO)', state: 'CO', lifecycleStatus: 'pending_confirmation', expirationDate: day(3) },
      { id: 'l-old', type: 'State Medical License (DO)', state: 'ND', lifecycleStatus: 'superseded', expirationDate: day(-800) },
      { id: 'l-now', type: 'State Medical License (DO)', state: 'ND', expirationDate: day(900) }],
    cme: [{ id: 'c', hours: '200', category: 'AOA Category 1-A', date: day(-30), topics: [] }],
  }));
  assert.equal(quiet, null, 'nothing retired, pending or undated alerts');
  const loud = generateAlerts(data({ licenses: [{ id: 'l-prov', type: 'State Medical License (DO)', state: 'ND', lifecycleStatus: 'provisional', expirationDate: day(20) }] }));
  assert.deepEqual(loud.soon.map(i => i.id), ['l-prov']);
});

test('a superseded ND temporary licence does not set the CME cycle', () => {
  const temp = { id: 'temp', type: 'State Medical License (DO)', state: 'ND', expirationDate: day(20), lifecycleStatus: 'superseded' };
  const full = { id: 'full', type: 'State Medical License (DO)', state: 'ND', expirationDate: day(700) };
  assert.equal(findStateLicense([temp, full], 'ND').id, 'full');
  assert.equal(findStateLicense([temp], 'ND'), null, 'with no licence in force the state keeps its rolling window');
  assert.equal(findStateLicense([{ ...full, dateUnknown: true }], 'ND'), null, 'a stale date that is marked unknown anchors nothing');
  assert.equal(findStateLicense([{ ...temp, lifecycleStatus: 'provisional' }], 'ND').id, 'temp', 'a provisional licence in force does anchor it');
  assert.equal(complianceFor(data({ licenses: [temp] }), 'ND').windowAnchored, false);
  assert.equal(hasDEARegistration([{ type: 'DEA Registration', lifecycleStatus: 'historical' }]), false);
  assert.equal(hasDEARegistration([{ type: 'DEA Registration' }]), true);
});

test('the compliance ring leaves retired, pending and undated records out entirely', () => {
  const items = [
    { id: 'a', expirationDate: day(400) },
    { id: 'b', expirationDate: '2019-01-01', lifecycleStatus: 'historical' },
    { id: 'c', expirationDate: day(10), lifecycleStatus: 'pending_confirmation' },
    { id: 'd', dateUnknown: true },
  ];
  const s = standingScore({ items, missingRequired: [{ item: { id: 'd' } }], leadDays: 90 });
  assert.deepEqual([s.good, s.total, s.percent], [1, 1, 100]);
  assert.deepEqual(standingScore({ items: [items[1]], leadDays: 90 }).percent, 0, 'nothing tracked reads as an empty ring, not a perfect one');
});

test('setup counts an unknown reappointment date as answered and never asks a retired licence for a date', () => {
  const lic = (over) => ({ id: Math.random().toString(36).slice(2), type: 'State Medical License (DO)', state: 'ND', ...over });
  assert.equal(dateless({ licenses: [lic({}), lic({ dateUnknown: true }), lic({ lifecycleStatus: 'historical' }), lic({ lifecycleStatus: 'pending_confirmation' })] }).length, 1);
  const task = (privileges) => buildSetup(data({ privileges }), { isPro: true }).byId.privileges.status;
  assert.equal(task([{ id: 'p', type: 'Surgical Privileges', dateUnknown: true, statusSource: 'Medical staff office' }]), 'done', 'an answered unknown date is not an open task');
  assert.equal(task([{ id: 'p', type: 'Surgical Privileges', lifecycleStatus: 'pending_confirmation' }]), 'done');
  assert.equal(task([{ id: 'p', type: 'Surgical Privileges' }]), 'pending', 'a plain undated privilege still asks for its date');
});

test('the renewal box never appears on a retired licence and is never urgent while the date is unknown', () => {
  assert.equal(renewalView({ type: 'State Medical License', state: 'ND', lifecycleStatus: 'superseded', expirationDate: day(5) }, 'MD'), null);
  assert.equal(renewalView({ type: 'State Medical License', state: 'ND', dateUnknown: true, expirationDate: day(5) }, 'MD').urgent, false);
});

// -- Reminder emails -----------------------------------------------------
test('reminder emails skip historical, superseded, pending and date-unknown rows', () => {
  assert.equal(remindable({ expiration_date: '2026-10-01' }), true, 'tables without the columns still remind');
  assert.equal(remindable({ lifecycle_status: 'provisional' }), true);
  assert.equal(remindable({ lifecycle_status: null, date_unknown: false }), true);
  for (const s of ['historical', 'superseded', 'pending_confirmation']) assert.equal(remindable({ lifecycle_status: s }), false, s);
  assert.equal(remindable({ date_unknown: true }), false);
  assert.equal(rowLifecycle({ lifecycle_status: 'Weird' }), 'active');
  assert.equal(remindable(null), false);
  const fn = readFileSync(new URL('../supabase/functions/send-reminders/index.ts', import.meta.url), 'utf8');
  const loop = fn.slice(fn.indexOf('for (const r of (data || []) as any[])'), fn.indexOf('items.push(', fn.indexOf('for (const r of (data || []) as any[])')));
  assert.match(loop, /if \(!remindable\(r\)\) continue;/, 'the digest loop filters every row through remindable');
});

// -- Exports, the CV, Vera, the share text -------------------------------
const ND = [
  { id: 'nd-temp', type: 'State Medical License (DO)', state: 'ND', licenseNumber: 'T-100', issuedDate: '2022-07-01', expirationDate: '2023-01-31', lifecycleStatus: 'superseded', supersededBy: 'nd-full', statusSource: 'ND board letter' },
  { id: 'nd-full', type: 'State Medical License (DO)', state: 'ND', licenseNumber: 'P-200', issuedDate: '2023-01-15', expirationDate: day(500) },
  { id: 'co-prov', type: 'State Medical License (DO)', state: 'CO', licenseNumber: 'C-3', expirationDate: day(200), lifecycleStatus: 'provisional' },
];
test('the full export keeps every licence ever held, with its number, dates and status', () => {
  const rows = buildCredentialRows(data({ licenses: ND, insurance: [{ id: 'res', type: 'Medical Malpractice (Claims-Made)', provider: 'Residency Carrier', policyNumber: 'R1', effectiveDate: '2015-07-01', expirationDate: '2019-06-30', lifecycleStatus: 'historical' }] }));
  const temp = rows.find(r => r['License/Cert #'] === 'T-100');
  assert.equal(temp.Status, 'Superseded');
  assert.equal(temp['Expiration Date'], '2023-01-31');
  assert.equal(temp['Issue Date'], '2022-07-01');
  assert.equal(temp['Status Detail'], 'Replaced by State Medical License (DO), ND. Source: ND board letter');
  assert.equal(temp.Credential, 'State Medical License (DO), ND');
  assert.equal(rows.find(r => r['License/Cert #'] === 'P-200').Status, 'Active');
  const policy = rows.find(r => r['License/Cert #'] === 'R1');
  assert.deepEqual([policy.Status, policy.Credential, policy['Expiration Date']], ['Historical', 'Residency Carrier', '2019-06-30']);
});

test('the CV shows active and provisional licences only, the provisional one labelled', async () => {
  const { buildCvContent } = await bundle('src/utils/cvContent.js');
  const cv = JSON.stringify(buildCvContent(data({ licenses: ND }), 'clinical'));
  assert.ok(cv.includes('P-200') && cv.includes('C-3 (provisional)'), cv.slice(0, 200));
  assert.ok(!cv.includes('T-100'), 'a superseded temporary licence is not on the CV');
});

test("Vera's snapshot carries each record's status, unknown date and replacement", async () => {
  const stub = 'export const geminiCall=()=>{};export const proxyErrorMessage=()=>null;export const anthropicAvailable=()=>false;export const anthropicClientFor=async()=>null;export const anthropicErrorMessage=()=>null;export const anthropicSdk=()=>null;export const AI_MESSAGES={};';
  const { buildSnapshot, lifecycleSnapshot, SECTION_FIELDS, systemBlocks } = await bundle('src/utils/assistant.js', { 'aiClient$': stub, 'veraSourcesClient\\.js$': 'export const loadVeraSources=async()=>({});export const sourceCheckReceipt=()=>null;' });
  const snap = buildSnapshot(data({ licenses: ND, privileges: [{ id: 'p', type: 'Surgical Privileges', facility: 'Mercy', dateUnknown: true }] }));
  const temp = snap.licenses.find(l => l.id === 'nd-temp');
  assert.deepEqual([temp.status, temp.replacedBy, temp.expires], ['superseded', 'nd-full', '2023-01-31']);
  assert.ok(!('status' in snap.licenses.find(l => l.id === 'nd-full')), 'absent means active');
  assert.equal(snap.privileges[0].dateUnknown, true);
  assert.deepEqual(lifecycleSnapshot({}), {});
  for (const s of ['licenses', 'privileges', 'insurance']) assert.ok(SECTION_FIELDS[s].includes('lifecycleStatus'), s);
  assert.match(systemBlocks(snap)[0], /never call them expired, overdue or due for renewal/);
});

test('shared credential text names a retired record as retired', () => {
  const text = buildCredentialText(ND[0], 'licenses', { name: 'Synthetic Physician', degreeType: 'DO' });
  assert.match(text, /Status: Superseded/);
  assert.doesNotMatch(buildCredentialText(ND[1], 'licenses', { name: 'Synthetic Physician' }), /Status:/, 'an active record adds nothing');
});

// -- Document requests ---------------------------------------------------
test('a document request sends the licence in force, and the history only when asked for', () => {
  const docs = [
    { id: 'doc-temp', name: 'nd temp.pdf', linkedTo: 'licenses:nd-temp', uploadedAt: '2024-05-01T00:00:00Z' },
    { id: 'doc-full', name: 'nd full.pdf', linkedTo: 'licenses:nd-full', uploadedAt: '2023-02-01T00:00:00Z' },
  ];
  // The superseded record carries the LATER expiration here, so ranking by date alone would have sent it.
  const records = { licenses: [{ ...ND[0], expirationDate: day(900) }, ND[1]] };
  for (const lib of [clientPacket, serverPacket]) {
    const cat = lib.catalogueFromRows(docs, records);
    assert.deepEqual(cat.map(e => e.lifecycle), ['superseded', 'active']);
    const ids = (ask) => lib.matchAsk(lib.classifyAsk(ask), cat).map(e => e.id);
    assert.deepEqual(ids('ND medical license'), ['doc-full']);
    assert.deepEqual(ids('all state licenses'), ['doc-full', 'doc-temp'], 'the record in force first');
    assert.deepEqual(ids('prior ND medical licenses'), ['doc-full', 'doc-temp']);
    const onlyOld = lib.catalogueFromRows([docs[0]], records);
    assert.deepEqual(lib.matchAsk(lib.classifyAsk('ND medical license'), onlyOld).map(e => e.id), [], 'a superseded licence alone is not offered as current');
  }
  const snake = serverPacket.catalogueFromRows([{ id: 'd', name: 'x.pdf', linked_to: 'licenses:l' }], { licenses: [{ id: 'l', type: 'DEA Registration', state: 'CO', lifecycle_status: 'historical' }] });
  assert.equal(snake[0].lifecycle, 'historical', 'the inbound function reads the snake_case column');
});

// -- The list: sorted last and labelled, on the phone and at the desk -----
const cardFixture = (over) => ({
  user: { id: 'u' }, isDesktop: false, toggleFavorite() {}, addItem() { throw Error('no writes'); },
  theme: { text: '#111', textMuted: '#666', textDim: '#888', border: '#aaa', card: '#fff', bg: '#eee', input: '#fff', inputBorder: '#ccc', accent: '#2a7', accentDim: '#dfe', success: '#2a7', warning: '#a60', danger: '#c00', dangerDim: '#fee', share: '#27a', shareGlow: '#eef', shadow1: 'none' },
  data: { settings: { name: 'Synthetic Physician', degreeType: 'DO' }, documents: [], followUps: [], locumContracts: [] },
  ...over,
});
test('retired records sink to the bottom under their own label, and open questions are grey, not red', async () => {
  const { CrudSection } = await bundle('src/components/features/CrudSection.jsx', {
    'context/AppContext$': 'export const useApp = () => globalThis.__lifecycleFixture;',
    'lib/supabase$': 'export {};',
  }).then(m => ({ CrudSection: m.default }));
  const items = [
    { ...ND[0] },
    { id: 'undated', type: 'State Medical License (DO)', state: 'CA', dateUnknown: true, statusSource: 'Board email' },
    { ...ND[1] },
    { id: 'lapsed', type: 'DEA Registration', state: 'CO', expirationDate: day(-3) },
  ];
  globalThis.__lifecycleFixture = cardFixture();
  const html = renderToStaticMarkup(React.createElement(CrudSection, {
    title: 'Licenses', sectionKey: 'licenses', items, fields: licenseFields({ degreeType: 'DO', records: items }),
    onAdd() {}, onEdit() {}, onDelete() {}, onShare() {},
  }));
  const at = (s) => html.indexOf(s);
  assert.ok(at('Needs attention (1)') >= 0, 'only the lapsed DEA needs attention');
  assert.ok(at('Historical and superseded (1)') > at('P-200'), 'the retired licence is listed last, under its label');
  assert.ok(at('T-100') > at('Historical and superseded (1)'));
  assert.match(html, /Exp Jan 31, 2023 \u{B7} Superseded/u, 'its date is kept, with no countdown');
  assert.match(html, /Date not yet known/);
  assert.doesNotMatch(html, /Needs review/, 'an answered unknown date is not flagged red');
});
