// Release goal3 review fixes (PA and NP on top of goal2). Synthetic members
// only. Each test names the defect it pins.
import '../helpers/app-rules.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sharedRuleResolver } from '../helpers/shared-rule-resolver.mjs';
import { withDegree, oneDegree } from '../../src/utils/outgoingText.js';
import { invoiceSenderFields, physicianLabel, archiveSenderFields } from '../../src/utils/invoiceArgs.js';
import { invoiceEmailSender, invoiceFileName } from '../../src/utils/invoiceEmail.js';
import { buildEmailSubject, buildCredentialText, buildCredentialBlurb } from '../../src/utils/helpers.js';
import { complianceFor } from '../../src/utils/compliance.js';
import { cmeAssessmentLabel } from '../../src/utils/cmePresentation.js';
import { licenseFields } from '../../src/utils/credentialForms.js';
import { ALL_LICENSE_TYPES, LICENSE_TYPES_MD, LICENSE_TYPES_DO } from '../../src/constants/credentialTypes.js';
import { buildSetup } from '../../src/utils/setupTasks.js';
import { renewalLineFor } from '../../supabase/functions/_shared/reminderRenewalLine.mjs';
import * as rpJs from '../../src/utils/requestPacket.js';
import { STATES } from '../../src/constants/states.js';
import { mountComponent, settle } from '../component-harness.mjs';
import { bundle } from './bundle.mjs';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const src = (rel) => new URL(`../../src/${rel}`, import.meta.url).href;
const lic = (type, state, over = {}) => ({ id: `${type}:${state}`, type, name: `${state} ${type}`, state, licenseNumber: 'X100', expirationDate: '2027-05-31', ...over });

// ── A credential typed with the name prints once ─────────────────────────────

test('a PA or NP credential typed with the name is not followed by the stored degree', () => {
  const cases = [
    ['Pat Example, PA-C', 'PA', 'Pat Example, PA-C'],
    ['Pat Example PA-C', 'PA', 'Pat Example PA-C'],
    ['Pat Example, P.A.-C.', 'PA', 'Pat Example, P.A.-C.'],
    ['Pat Example, RPA-C', 'PA', 'Pat Example, RPA-C'],
    ['Kim Sample, FNP-C', 'NP', 'Kim Sample, FNP-C'],
    ['Kim Sample, FNP-BC', 'NP', 'Kim Sample, FNP-BC'],
    ['Kim Sample, APRN', 'NP', 'Kim Sample, APRN'],
    ['Kim Sample, DNP, FNP-BC', 'NP', 'Kim Sample, DNP, FNP-BC'],
    ['Kim Sample, AGACNP-BC', 'NP', 'Kim Sample, AGACNP-BC'],
    ['Kim Sample, CRNP', 'NP', 'Kim Sample, CRNP'],
    // Still given the degree: a plain name, a doctorate, an RN, a surname.
    ['Pat Example', 'PA', 'Pat Example, PA'],
    ['Kim Sample, DNP', 'NP', 'Kim Sample, DNP, NP'],
    ['Kim Sample, RN', 'NP', 'Kim Sample, RN, NP'],
    ['Pat Pac', 'PA', 'Pat Pac, PA'],
    ['Kim Snp', 'NP', 'Kim Snp, NP'],
  ];
  for (const [name, deg, want] of cases) assert.equal(withDegree(name, deg), want, `${name} / ${deg}`);
  // MD and DO read exactly as before, a PA-C in an MD's name included.
  assert.equal(withDegree('Jordan Rivera, DO', 'DO'), 'Jordan Rivera, DO');
  assert.equal(withDegree('Ann Do', 'DO'), 'Ann Do, DO');
  assert.equal(withDegree('Jordan Rivera, MD, FACS', 'MD'), 'Jordan Rivera, MD, FACS, MD');
  assert.equal(withDegree('Jordan Rivera, PA-C', 'MD'), 'Jordan Rivera, PA-C, MD');
  // A name a caller already joined collapses the same way.
  assert.equal(oneDegree('Pat Example, PA-C, PA'), 'Pat Example, PA-C');
  assert.equal(oneDegree('Kim Sample, FNP-BC, NP'), 'Kim Sample, FNP-BC');
  assert.equal(oneDegree('Kim Sample, DNP, NP'), 'Kim Sample, DNP, NP');
  assert.equal(oneDegree('Jordan Rivera, PA-C, MD'), 'Jordan Rivera, PA-C, MD');
});

test('every outgoing invoice and share path prints a PA-C once', () => {
  const s = { name: 'Pat Example, PA-C', degreeType: 'PA', email: 'pat@example.test', npi: '' };
  assert.equal(physicianLabel(s), 'Pat Example, PA-C');
  const fields = invoiceSenderFields(s);
  assert.equal(fields.physician, 'Pat Example, PA-C');
  assert.equal(invoiceFileName({ number: '2026-0001', ...fields }), 'Invoice 2026-0001 from Pat Example, PA-C.pdf');
  // An invoice saved before this fix still carries the doubled label.
  assert.equal(invoiceFileName({ number: '2026-0001', physician: 'Pat Example, PA-C, PA' }), 'Invoice 2026-0001 from Pat Example, PA-C.pdf');
  const sender = invoiceEmailSender({ name: s.name, degree: 'PA', email: s.email });
  assert.equal(sender.fromName, 'Pat Example, PA-C via CredentialDOMD');
  const np = invoiceEmailSender({ name: 'Kim Sample, FNP-BC', degree: 'NP', email: 'kim@example.test' });
  assert.equal(np.fromName, 'Kim Sample, FNP-BC via CredentialDOMD');
  const item = lic('State Physician Assistant License', 'TX');
  assert.match(buildCredentialText(item, 'licenses', s), /^Name: Pat Example, PA-C$/m);
  assert.match(buildCredentialBlurb(item, 'licenses', s, false, ''), /^Credential verification from Pat Example, PA-C\./);
  // MD and DO senders as before.
  assert.equal(invoiceSenderFields({ name: 'Jordan Rivera', degreeType: 'DO' }).physician, 'Jordan Rivera, DO');
  assert.equal(invoiceEmailSender({ name: 'Jordan Rivera, DO', degree: 'DO', email: 'j@example.test' }).fromName, 'Jordan Rivera, DO via CredentialDOMD');
});

test('the read-only archive keeps the MD and DO label it always printed', () => {
  assert.deepEqual(archiveSenderFields({ name: 'Pat Example', degreeType: 'MD' }), { physician: 'Pat Example' });
  assert.deepEqual(archiveSenderFields({ name: '', degreeType: 'DO' }), { physician: 'Physician' });
  assert.equal(archiveSenderFields({ name: 'Pat Example', degreeType: 'PA' }).physician, 'Pat Example, PA');
  assert.equal(archiveSenderFields({ name: '', degreeType: '' }).physician, 'Clinician');
});

// ── The share subject never names a profession she did not choose ────────────

test('a nameless member with no profession is "Clinician" in a share subject, never "Physician"', () => {
  const item = { id: 'd', type: 'DEA Registration', state: 'CO' };
  assert.match(buildEmailSubject(item, 'licenses', { name: '', degreeType: '' }), / - Clinician$/);
  assert.match(buildEmailSubject(item, 'licenses', {}), / - Clinician$/);
  for (const deg of ['MD', 'DO']) assert.match(buildEmailSubject(item, 'licenses', { name: '', degreeType: deg }), / - Physician$/, deg);
  assert.match(buildEmailSubject(item, 'licenses', { name: 'Pat Example', degreeType: '' }), / - Pat Example$/);
  // The edge copy is the same module.
  assert.equal(read('supabase/functions/_shared/app/utils/helpers.js').includes('(isPhysicianDegree(settings?.degreeType) ? "Physician" : "Clinician")'), true);
});

// ── A recorded PA or NP shortfall is never shown as "confirm" ────────────────

test('a verified PA hour shortfall reads "needs-hours" in every state, open questions or not', () => {
  const hidden = [];
  for (const st of STATES) {
    const data = { settings: { degreeType: 'PA', primaryState: st, additionalStates: [] }, licenses: [lic('State Physician Assistant License', st)],
      cme: [{ id: 'c1', title: 'Synthetic course', category: 'AAPA Category 1 CME', hours: '1', date: '2026-03-01', topics: [] }] };
    const comp = complianceFor(data, st, 'pa');
    if (comp.rulesVerified && comp.windowKnown && comp.totalRequired > comp.totalEarned && !comp.satisfiedVia?.confirm && !comp.exemption?.unanswered
      && comp.assessmentStatus !== 'needs-hours') hidden.push(`${st} ${comp.totalEarned}/${comp.totalRequired} ${comp.assessmentStatus}`);
  }
  assert.deepEqual(hidden, []);
  // Texas: 10 of 40 with an opioid topic whose applicability is unanswered.
  const tx = { settings: { degreeType: 'PA', primaryState: 'TX', additionalStates: [] }, licenses: [lic('State Physician Assistant License', 'TX')],
    cme: [{ id: 'c1', title: 'Synthetic course', category: 'AAPA Category 1 CME', hours: '10', date: '2026-03-01', topics: [] }] };
  const comp = complianceFor(tx, 'TX', 'pa');
  assert.equal(comp.assessmentStatus, 'needs-hours');
  assert.equal(comp.shortBy, 'hours');
  assert.match(cmeAssessmentLabel(comp), /^Recorded CE gaps/);
  // With no licence date the window is a stand-in: still a question.
  const undated = complianceFor({ ...tx, licenses: [lic('State Physician Assistant License', 'TX', { expirationDate: '' })] }, 'TX', 'pa');
  assert.notEqual(undated.assessmentStatus, 'needs-hours');
});

// ── PA transcript in a member-start state ────────────────────────────────────

test('a NC or TN PA transcript with no cycle start asks for CME Cycle Start, never "not yet verified"', async () => {
  const t = await bundle('src/utils/cmeTranscriptPdf.js');
  const cme = [{ id: 'c1', title: 'Course', category: 'AAPA Category 1 CME', hours: '10', date: '2026-03-01', topics: [] }];
  for (const [st, name] of [['NC', 'North Carolina'], ['TN', 'Tennessee']]) {
    const data = { settings: { name: 'Pat Example', degreeType: 'PA', primaryState: st }, licenses: [lic('State Physician Assistant License', st)], cme, education: [], documents: [], privileges: [] };
    const err = t.stateTranscriptModel(data, st, { kind: 'pa' }).error;
    assert.equal(err, `Set CME Cycle Start on your ${name} physician assistant license to the first day of your current period, then build the transcript.`);
    assert.doesNotMatch(err, /not yet verified|CE Cycle Start/);
    const started = { ...data, licenses: [lic('State Physician Assistant License', st, { cmeCycleStart: '2025-06-01' })] };
    assert.equal(t.stateTranscriptModel(started, st, { kind: 'pa' }).error, undefined);
  }
  assert.doesNotMatch(read('src/utils/cmeTranscriptPdf.js'), /CE Cycle Start/);
});

// ── Setup: a BS or MS PA program ─────────────────────────────────────────────

test('a PA program filed as a BS or MS completes the Setup task once it names the program', () => {
  const task = (education) => buildSetup({ settings: { degreeType: 'PA', name: 'Pat Example' }, licenses: [], cme: [], education, documents: [] })
    .tasks.find((t) => t.section === 'education' || t.id === 'education');
  const bs = { id: 'e1', type: 'Bachelor of Science (BS)', institution: 'Synthetic University', fieldOfStudy: 'Physician Assistant' };
  assert.equal(task([bs]).status, 'done');
  assert.equal(task([{ ...bs, type: 'Master of Science (MS)', fieldOfStudy: '', name: 'MS, Synthetic PA Program' }]).status, 'done');
  assert.equal(task([{ id: 'e2', type: 'Master of Physician Assistant Studies (MPAS)' }]).status, 'done');
  const undergrad = task([{ id: 'e3', type: 'Bachelor of Science (BS)', institution: 'Synthetic College', fieldOfStudy: 'Biology' }]);
  assert.notEqual(undergrad.status, 'done');
  assert.match(undergrad.detail || undergrad.pendingDetail || JSON.stringify(undergrad), /field of study says Physician Assistant/);
});

// ── Credentials > Licenses for a member with no profession ───────────────────

test('a blank member adding a licence from Credentials is asked her profession and offered every type', () => {
  const types = licenseFields({ degreeType: '' }).find((f) => f.key === 'type').options;
  assert.deepEqual(types, ALL_LICENSE_TYPES);
  for (const t of ['State Physician Assistant License', 'Board Certification (NCCPA)', 'APRN License (NP)', 'State Medical License']) assert.ok(types.includes(t), t);
  // MD and DO lists unchanged.
  assert.deepEqual(licenseFields({ degreeType: 'MD' }).find((f) => f.key === 'type').options, LICENSE_TYPES_MD);
  assert.deepEqual(licenseFields({ degreeType: 'DO' }).find((f) => f.key === 'type').options, LICENSE_TYPES_DO);
  const app = read('src/App.jsx');
  const licenses = app.slice(app.indexOf('if (sub === "licenses")'), app.indexOf('if (sub === "cme")'));
  assert.match(licenses, /!data\.settings\.degreeType && \([\s\S]{0,300}<ProfessionPicker[\s\S]{0,200}chooseProfessionThen\(updateSettings, d,/);
  assert.match(licenses, /"Add your licenses, DEA, and certifications\."/);
});

// ── Setup's profession chips ask before switching profession ─────────────────

async function identity(degreeType) {
  const saved = [];
  const app = { data: { settings: { name: 'Nora Example', degreeType, primaryState: '' } }, user: { fullName: '' }, theme: {}, updateSettings: (u) => { saved.push(u); return true; } };
  const c = await mountComponent('src/components/features/SetupPage.jsx', { app, exportName: 'IdentityDrawer', modules: {
    reminderPreferences: await import(src('utils/reminderPreferences.js')), contactFormat: await import(src('utils/contactFormat.js')),
    useInputStyle: { useInputStyle: () => ({}) }, states: await import(src('constants/states.js')), professions: await import(src('constants/professions.js')),
    appRules: await import(src('utils/appRules.js')),
  } });
  const chip = (d) => c.nodes().find((n) => n.type === 'button' && c.text(n) === d);
  const button = (re) => c.nodes().find((n) => n.type === 'button' && re.test(c.text(n)));
  return { c, saved, chip, button };
}

test('Setup: an MD tapping NP is asked first; MD to DO and a first choice stay one tap', async () => {
  const md = await identity('MD');
  md.chip('NP').props.onClick(); md.c.render();
  assert.deepEqual(md.saved, [], 'nothing saved on the tap');
  assert.match(md.c.pageText(), /Switching to Nurse Practitioner \(NP\) changes which state rules/);
  md.button(/^Keep MD$/).props.onClick(); md.c.render();
  assert.deepEqual(md.saved, []);
  assert.doesNotMatch(md.c.pageText(), /Switching to/);
  md.chip('PA').props.onClick(); md.c.render();
  md.button(/^Switch to PA$/).props.onClick(); md.c.render();
  assert.deepEqual(JSON.parse(JSON.stringify(md.saved)), [{ degreeType: 'PA' }]);
  const within = await identity('MD');
  within.chip('DO').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(within.saved)), [{ degreeType: 'DO' }], 'MD to DO stays one tap');
  const blank = await identity('');
  blank.chip('PA').props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(blank.saved)), [{ degreeType: 'PA' }], 'a first choice stays one tap');
});

// ── PA CME import: the assumed credit type can be confirmed ──────────────────

test('a PA can release a held import row by picking the credit type it already assumed', async () => {
  const csv = 'Date,Title,Hours,Credit Type\n2026-01-10,Synthetic course one,2,Category 1\n';
  const added = [];
  const m = await mountComponent('src/components/features/CMEImport.jsx', {
    app: { data: { settings: { degreeType: 'PA' }, cme: [] }, theme: {}, addItem: (_s, row) => { added.push(row); } },
    props: { open: true, onClose() {}, requiredTopics: [] },
    modules: {
      cmeImport: await import(src('utils/cmeImport.js')), credentialTypes: await import(src('constants/credentialTypes.js')),
      cmeTopics: await import(src('constants/cmeTopics.js')), helpers: await import(src('utils/helpers.js')),
      spreadsheetGuard: await import(src('utils/spreadsheetGuard.js')),
      aiClient: { useAiAvailable: () => false, aiAvailable: () => false, describeAiStatus: () => '' }, xlsx: await import('xlsx'),
    },
  });
  const [input] = m.fileInputs();
  await m.pick(input, [new File([csv], 'transcript.csv', { type: 'text/csv' })]);
  await settle();
  const next = m.nodes().find((n) => n.type === 'button' && m.text(n) === 'Continue to review');
  if (next) { next.props.onClick(); m.render(); }
  const held = m.nodes().find((n) => n.type === 'button' && /^Pick 1 credit type first$/.test(m.text(n)));
  assert.ok(held, `held: ${m.pageText().slice(0, 300)}`);
  const select = m.nodes().find((n) => n.type === 'select' && n.props['aria-label'] === 'Credit type');
  assert.equal(select.props.value, '', 'the held row shows the prompt, so the assumed type is a change');
  const options = [select.props.children].flat(3).filter((o) => o?.type === 'option');
  assert.deepEqual([options[0].props.value, options[0].props.disabled], ['', true]);
  select.props.onChange({ target: { value: '' } }); m.render();
  assert.ok(m.nodes().some((n) => n.type === 'button' && /^Pick 1 credit type first$/.test(m.text(n))), 'the prompt itself never releases it');
  m.nodes().find((n) => n.type === 'select' && n.props['aria-label'] === 'Credit type').props.onChange({ target: { value: 'AAPA Category 1 CME' } }); m.render();
  const add = m.nodes().find((n) => n.type === 'button' && /^Add 1 to CME log/.test(m.text(n)));
  assert.ok(add && !add.props.disabled, m.pageText().slice(0, 300));
  add.props.onClick(); m.render();
  assert.equal(added.length, 1);
  assert.equal(added[0].category, 'AAPA Category 1 CME');
});

// ── Vera: MD and DO CME rows in stored order, as before ──────────────────────

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
async function bundleStubbed(entry, stubs) {
  const out = await build({ entryPoints: [`${root}${entry}`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'],
    plugins: [{ name: 'stubs', setup(b) {
      for (const [filter, contents] of Object.entries(stubs)) {
        b.onResolve({ filter: new RegExp(filter) }, () => ({ path: filter, namespace: 'stub' }));
        b.onLoad({ filter: new RegExp(`^${filter.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`), namespace: 'stub' }, () => ({ contents, loader: 'js' }));
      }
    } }, sharedRuleResolver] });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

test("Vera's snapshot sends an MD's or DO's first 40 CME rows in stored order; a PA's newest first", async () => {
  const { buildSnapshot } = await bundleStubbed('src/utils/assistant.js', {
    'aiClient$': 'export const geminiCall=()=>{};export const proxyErrorMessage=()=>null;export const anthropicAvailable=()=>false;export const anthropicClientFor=async()=>null;export const anthropicErrorMessage=()=>null;export const anthropicSdk=()=>null;export const AI_MESSAGES={};',
    'veraSourcesClient\\.js$': 'export const loadVeraSources=async()=>({});export const sourceCheckReceipt=()=>null;',
  });
  const cme = Array.from({ length: 45 }, (_, i) => ({ id: `c${i}`, title: `Course ${i}`, hours: '1', category: 'AMA PRA Category 1', date: `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`.replace(/^2024/, String(2022 + Math.floor(i / 12))) }));
  const data = (degreeType) => ({ settings: { name: 'Synthetic Member', degreeType, primaryState: 'TX', reminderLeadDays: 90 },
    licenses: [], cme, privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [] });
  for (const deg of ['MD', 'DO', '']) {
    const ids = buildSnapshot(data(deg)).cme.map((x) => x.id);
    assert.equal(ids.length, 40);
    assert.deepEqual(ids.slice(0, 3), ['c0', 'c1', 'c2'], deg || 'blank');
  }
  assert.deepEqual(buildSnapshot(data('PA')).cme.map((x) => x.id).slice(0, 3), ['c44', 'c43', 'c42']);
});

// ── Request packets: a PA's compound ask is two asks ─────────────────────────

test("a PA's inline compound ask splits into both documents in the app and server matchers", async () => {
  const copies = [['app', rpJs], ['server', await import('../../supabase/functions/_shared/requestPacket.ts')]];
  const docs = [{ id: 'd1', name: 'agreement.pdf', linked_to: 'licenses:l1' }, { id: 'd2', name: 'nccpa.pdf', linked_to: 'licenses:l2' }, { id: 'd3', name: 'bls.pdf', linked_to: 'licenses:l3' }];
  const recs = { licenses: [{ id: 'l1', type: 'Practice Agreement', state: 'TX' }, { id: 'l2', type: 'Board Certification (NCCPA)' }, { id: 'l3', type: 'BLS' }] };
  for (const [name, rp] of copies) {
    const cat = rp.catalogueFromRows(docs, recs);
    const run = (body, deg) => rp.buildProposal({ subject: 'Request', body }, cat, { name: 'Pat Example', degree_type: deg }, '2026-10-01');
    const agreement = run('Hi, please send your practice agreement and your NCCPA certificate.', 'PA');
    assert.deepEqual(agreement.items.map((i) => [i.kind, i.status]), [['practice_agreement', 'found'], ['board_cert', 'found']], name);
    assert.deepEqual(agreement.docIds, ['d1', 'd2'], name);
    const bls = run('Hi, please send your BLS card and your NCCPA certificate.', 'PA');
    assert.deepEqual(bls.items.map((i) => i.kind), ['bls', 'board_cert'], name);
    // MD as before, and the rule-only reader with no degree unchanged.
    assert.deepEqual(run('Hi, please send your BLS card and your board certificate.', 'MD').items.map((i) => i.kind), ['bls', 'board_cert'], name);
    assert.deepEqual(rp.parseAsks('Hi, please send your practice agreement and your NCCPA certificate.'), ['practice agreement and your NCCPA certificate'], name);
    // A PA's signature still reads as a name, not an ask.
    assert.deepEqual(run('Hi, please send your BLS card.\n\nThanks,\nPat Example, PA-C', 'PA').items.map((i) => i.kind), ['bls'], name);
  }
});

// ── Reminder email: no physician portal for a PA or NP only record ───────────

test("a blank member's PA or NP only record gets no physician renewal portal in the reminder email", () => {
  const renewalLinks = JSON.parse(read('supabase/functions/send-reminders/renewalLinks.json'));
  const appBoardLinks = JSON.parse(read('supabase/functions/send-reminders/appBoardLinks.json'));
  const line = (type, degree) => renewalLineFor({ isLicense: true, state: 'TX', type }, degree, { renewalLinks, appBoardLinks });
  for (const type of ['Prescriptive Authority', 'Practice Agreement', 'Board Certification (NCCPA)', 'Board Certification (AANPCB)']) {
    for (const degree of ['', null]) assert.equal(line(type, degree), '', `${type} / ${degree}`);
  }
  // Unchanged: a blank member's medical, DEA and PA licence lines, and every MD or DO line.
  assert.match(line('State Medical License', ''), /Renew: /);
  assert.match(line('State Physician Assistant License', ''), /Board: /);
  assert.match(line('Practice Agreement', 'MD'), /Renew: /);
  assert.equal(line('State Medical License', 'MD'), line('State Medical License', ''));
});
