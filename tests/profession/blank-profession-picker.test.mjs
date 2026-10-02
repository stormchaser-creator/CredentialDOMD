// A member with no profession chosen is asked it once, with the one-tap
// picker Home shows (ProfessionPicker.jsx), before the CV reader reads her CV
// and before Vera answers her first question. The choice is saved to her
// profile and the chosen-profession path runs: the CV she picked is read with
// that profession's lists, her question is answered with that profession's
// rules. "Not now" reads no CV; Vera then answers only what needs no rule and
// shows the choice again when a rule is needed. Members who chose MD, DO, PA
// or NP never see the picker. Every record here is synthetic.
import '../helpers/app-rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sharedRuleResolver } from '../helpers/shared-rule-resolver.mjs';
import { mountComponent, settle } from '../component-harness.mjs';
import { mountVera, recorder } from '../assistant-harness.mjs';
import * as cvImport from '../../src/utils/cvImport.js';
import * as publicRecord from '../../src/utils/publicRecord.js';
import * as professions from '../../src/constants/professions.js';
import * as helpers from '../../src/utils/helpers.js';
import { evidenceForTurn, evidenceInstructionsFor, EVIDENCE_INSTRUCTIONS } from '../../src/utils/assistantEvidence.js';
import { sourceIdsForQuestion } from '../../src/utils/veraSourcesClient.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
// Objects made inside the component's sandbox compare by value only.
const plain = v => JSON.parse(JSON.stringify(v));
const isPicker = n => typeof n.type === 'function' && n.type.name === 'ProfessionPicker';

// ── CV import ───────────────────────────────────────────────────────────────

// What the reader returns for the synthetic CV: a PA program and a PA licence.
const CV_REPLY = {
  education: [{ type: 'Master of Physician Assistant Studies (MPAS)', institution: 'Synthetic University', graduationDate: '2015' }],
  licenses: [{ type: 'State Physician Assistant License', state: 'TX', licenseNumber: 'PA-0001' }],
};

async function mountCv({ degreeType, refuse = false, documents = [], source = null } = {}) {
  const calls = [];
  const settings = { degreeType, name: 'Synthetic Member' };
  const data = { settings, documents, licenses: [], education: [], workHistory: [], privileges: [], publications: [], memberships: [] };
  const reader = (name) => async (_bytes, degree) => { calls.push([name, degree]); return CV_REPLY; };
  const ui = await mountComponent('src/components/features/CvImportReview.jsx', {
    app: {
      data, theme: {}, isDesktop: false, isPro: true, user: { id: 'synthetic-user' },
      addItem: () => true,
      // The profile save: the settings on screen carry the choice from the next render.
      updateSettings: (patch) => { calls.push(['updateSettings', patch]); if (refuse) return false; Object.assign(settings, patch); return undefined; },
    },
    props: { source, onClose: () => {} },
    modules: {
      cvImport, publicRecord, professions, helpers,
      cvScan: { analyzeCvPdf: reader('analyzeCvPdf'), analyzeCvImage: reader('analyzeCvImage'), analyzeCvText: reader('analyzeCvText') },
      aiClient: { useAiAvailable: () => true, describeAiStatus: () => '' },
      storageQuota: { checkStorageQuota: () => ({ ok: true }) },
      docPrefill: { isReadableDoc: () => true },
      storedBytes: { storedDataUrl: async (d) => { calls.push(['storedDataUrl', d.id]); return { dataUrl: 'data:application/pdf;base64,JVBERg==' }; } },
      limitedLaunchAccess: { alertWriteRefused: (o) => { calls.push(['alertWriteRefused', o]); } },
    },
  });
  const pickCv = () => ui.pick(ui.fileInputs()[0], [new File(['%PDF-1.4 synthetic'], 'Synthetic CV.pdf', { type: 'application/pdf' })]);
  const picker = () => ui.nodes().find(isPicker);
  const reads = () => calls.filter(c => /^analyzeCv|^storedDataUrl/.test(c[0]));
  const rowLabels = () => ui.nodes().filter(n => n.type === 'input' && n.props.type === 'checkbox').map(n => n.props['aria-label']);
  return { ui, calls, pickCv, picker, reads, rowLabels };
}

test('CV import, blank member: the picker comes before anything is read; her choice is saved and the CV she picked is read with that profession\'s lists', async () => {
  const cv = await mountCv({ degreeType: '' });
  await cv.pickCv();
  assert.deepEqual(cv.reads(), [], 'nothing is read before she chooses');
  const picker = cv.picker();
  assert.ok(picker, 'the one-tap choice is shown inline');
  assert.match(picker.props.why, /Synthetic CV\.pdf/);
  assert.ok(picker.props.onDismiss, 'with "Not now"');
  assert.equal(cv.ui.fileInputs().length, 0, 'the file chooser waits behind the choice');
  picker.props.onChoose('PA');
  await settle(); cv.ui.render();
  assert.deepEqual(plain(cv.calls.filter(c => c[0] === 'updateSettings')), [['updateSettings', { degreeType: 'PA' }]], 'saved to her profile');
  assert.deepEqual(cv.reads(), [['analyzeCvPdf', 'PA']], 'the CV she picked, read once, as a PA');
  assert.equal(cv.picker(), undefined, 'never asked again');
  // Typed with the PA lists: the program and the licence keep their PA types.
  const labels = cv.rowLabels().join('\n');
  assert.match(labels, /Master of Physician Assistant Studies \(MPAS\)/);
  assert.match(labels, /State Physician Assistant License/);
  const typed = cvImport.cvFindings(CV_REPLY, { settings: { degreeType: 'PA' } });
  assert.deepEqual(typed.filter(f => f.section === 'education').map(f => f.fields.type), ['Master of Physician Assistant Studies (MPAS)']);
  assert.deepEqual(typed.filter(f => f.section === 'licenses').map(f => f.fields.type), ['State Physician Assistant License']);
});

test('CV import, blank member: "Not now" reads nothing and says the reader needs her license type', async () => {
  const cv = await mountCv({ degreeType: '' });
  await cv.pickCv();
  cv.picker().props.onDismiss();
  await settle();
  const text = cv.ui.pageText();
  assert.deepEqual(cv.reads(), [], 'nothing parsed');
  assert.deepEqual(cv.calls.filter(c => c[0] === 'updateSettings'), [], 'no profession saved');
  assert.equal(cv.picker(), undefined);
  assert.match(text, /Synthetic CV\.pdf was not read\. The reader needs your license type \(MD, DO, PA or NP\)/);
  assert.equal(cv.ui.fileInputs().length, 1, 'she can choose the file again');
  // Choosing the file again asks again; nothing is read until she answers.
  await cv.pickCv();
  assert.ok(cv.picker());
  assert.deepEqual(cv.reads(), []);
  assert.doesNotMatch(cv.ui.pageText(), /was not read/);
});

test('CV import, blank member: a CV already in Files and the "this looks like your CV" offer wait for the choice too', async () => {
  const stored = await mountCv({ degreeType: '', documents: [{ id: 'doc-cv', name: 'Synthetic CV.pdf', type: 'application/pdf' }] });
  const onFile = stored.ui.nodes().find(n => n.type === 'button' && stored.ui.text(n) === 'Synthetic CV.pdf');
  await onFile.props.onClick();
  await settle(); stored.ui.render();
  assert.deepEqual(stored.reads(), [], 'not even fetched before she chooses');
  stored.picker().props.onChoose('NP');
  await settle(); stored.ui.render();
  assert.deepEqual(stored.reads(), [['storedDataUrl', 'doc-cv'], ['analyzeCvPdf', 'NP']]);

  const offered = await mountCv({ degreeType: '', source: { dataUrl: 'data:application/pdf;base64,JVBERg==', fileName: 'Offered CV.pdf', mime: 'application/pdf' } });
  await offered.ui.nodes().find(n => n.type === 'button' && offered.ui.text(n) === 'Read Offered CV.pdf').props.onClick();
  await settle(); offered.ui.render();
  assert.deepEqual(offered.reads(), []);
  offered.picker().props.onChoose('DO');
  await settle();
  assert.deepEqual(offered.reads(), [['analyzeCvPdf', 'DO']]);
});

test('CV import, blank member: a refused profile save reads nothing and keeps the choice on screen', async () => {
  const cv = await mountCv({ degreeType: '', refuse: true });
  await cv.pickCv();
  cv.picker().props.onChoose('MD');
  await settle(); cv.ui.render();
  assert.deepEqual(cv.reads(), []);
  assert.ok(cv.calls.some(c => c[0] === 'alertWriteRefused'));
  assert.ok(cv.picker(), 'still asking');
});

test('CV import: a member who chose MD, DO, PA or NP never sees the picker; her CV is read at once with her own profession', async () => {
  for (const degreeType of ['MD', 'DO', 'PA', 'NP']) {
    const cv = await mountCv({ degreeType });
    assert.equal(cv.picker(), undefined, degreeType);
    await cv.pickCv();
    assert.equal(cv.picker(), undefined, degreeType);
    assert.deepEqual(cv.reads(), [['analyzeCvPdf', degreeType]], degreeType);
    assert.deepEqual(cv.calls.filter(c => c[0] === 'updateSettings'), [], degreeType);
  }
});

test('Setup\'s "Upload my CV" opens the same reader, so its picker is the one above', () => {
  const setup = readFileSync(`${root}src/components/features/SetupPage.jsx`, 'utf8');
  const drawer = setup.slice(setup.indexOf('export function CvDrawer'), setup.indexOf('export function DeaDrawer'));
  assert.match(drawer, /return <CvImportReview onClose=\{\(\) => setImporting\(false\)\} \/>;/);
  assert.match(drawer, />Upload my CV<\/button>/);
});

// ── Vera ────────────────────────────────────────────────────────────────────

const bundleAssistant = async () => {
  const stubs = {
    'aiClient$': 'export const geminiCall=()=>{};export const proxyErrorMessage=()=>null;export const anthropicAvailable=()=>false;export const anthropicClientFor=async()=>null;export const anthropicErrorMessage=()=>null;export const anthropicSdk=()=>null;export const AI_MESSAGES={};',
  };
  const out = await build({
    entryPoints: [`${root}src/utils/assistant.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, external: ['react'],
    plugins: [{ name: 'stubs', setup(b) {
      for (const [filter, contents] of Object.entries(stubs)) {
        b.onResolve({ filter: new RegExp(filter) }, () => ({ path: filter, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents, loader: 'js' }));
      }
    } }, sharedRuleResolver],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
};
const A = await bundleAssistant();

const RULE_QUESTION = 'How many CME hours do I need to renew in Texas?';
const GENERAL_QUESTION = 'How do I add a document?';

async function mountBlankVera({ degreeType = '', refuse = false, needsProfession = q => q === RULE_QUESTION, settings: settingsOver = { primaryState: 'TX' }, data = {}, allTrackedStates = ['TX'], saved = [], device = {}, actions = () => [], askingActions = () => [] } = {}) {
  const rec = recorder();
  const settings = { degreeType, ...settingsOver };
  const turns = [];
  const vera = await mountVera({
    rec, saved, device,
    data: { ...data, settings },
    app: {
      allTrackedStates,
      updateSettings: (patch) => { rec.calls.push(['updateSettings', patch]); if (refuse) return false; Object.assign(settings, patch); return undefined; },
    },
    modules: {
      assistant: {
        buildSnapshot: A.buildSnapshot, splitFields: A.splitFields,
        // The model is a fake; the evidence it would read is the real one.
        assistantTurn: async (args) => {
          turns.push(args);
          const question = args.history.at(-1).text;
          const degree = args.snapshot.physician.degree;
          if (!professions.isKnownDegree(degree) && needsProfession(question)) return { reply: 'That depends on the license you hold.', actions: askingActions(question), needsProfession: true };
          return { reply: `Answer for ${degree || 'no profession'}: ${question}`, actions: actions(question, degree), ...(needsProfession(question) && degreeType ? { needsProfession: true } : {}) };
        },
      },
      limitedLaunchAccess: { alertWriteRefused: (o) => { rec.calls.push(['alertWriteRefused', o]); } },
    },
  });
  const picker = () => vera.nodes().find(isPicker);
  const userTexts = () => plain(vera.store.chat.filter(m => m.role === 'user').map(m => m.text));
  return { ...vera, turns, picker, userTexts };
}

test('Vera, blank member: her first question waits for the picker; her choice is saved and the question answered with that profession\'s rules', async () => {
  const v = await mountBlankVera();
  await v.ask(RULE_QUESTION);
  assert.equal(v.turns.length, 0, 'Vera does not answer before she chooses');
  const picker = v.picker();
  assert.ok(picker, 'the one-tap choice, inline under her question');
  assert.ok(picker.props.onDismiss, 'with "Not now"');
  assert.equal(v.button('Send').props.disabled, true, 'one question waits at a time');
  assert.match(v.pageText(), new RegExp(RULE_QUESTION.replace(/[?]/g, '\\?')));
  picker.props.onChoose('PA');
  await settle(); v.render();
  assert.deepEqual(plain(v.rec.of('updateSettings')), [['updateSettings', { degreeType: 'PA' }]], 'saved to her profile');
  assert.equal(v.turns.length, 1);
  const [turn] = v.turns;
  assert.equal(turn.snapshot.physician.degree, 'PA', 'answered as a PA, on the turn she chose it');
  assert.equal(turn.history.at(-1).text, RULE_QUESTION, 'the question she asked, not asked again');
  // The evidence the turn carries is a PA's: the Texas PA rule, no physician figure.
  const evidence = evidenceForTurn(turn.snapshot, turn.history);
  assert.equal(evidence.referenceEvidence.jurisdictions.TX.profession, 'pa');
  assert.ok(!('professionStatus' in evidence.referenceEvidence));
  assert.match(v.pageText(), /Answer for PA: How many CME hours/);
  assert.equal(v.picker(), undefined, 'never asked again');
  assert.deepEqual(v.userTexts(), [RULE_QUESTION], 'her question once in the thread');
});

test('Vera, blank member: "Not now" answers what needs no rule; a rule question shows the choice again and is answered once she picks', async () => {
  const v = await mountBlankVera();
  await v.ask(GENERAL_QUESTION);
  v.picker().props.onDismiss();
  await settle(); v.render();
  assert.equal(v.turns.length, 1, 'answered without a profession');
  const blank = v.turns[0];
  assert.equal(blank.snapshot.physician.degree, '');
  const evidence = evidenceForTurn(blank.snapshot, blank.history);
  assert.equal(evidence.referenceEvidence.professionStatus, 'not_chosen');
  assert.deepEqual(evidence.renewalInfo, {}, 'no rule is sent');
  assert.deepEqual(blank.snapshot.cmeSummary.byState, {}, 'and no rule calculation');
  assert.deepEqual(sourceIdsForQuestion(blank.history, evidence), [], 'and no official source');
  assert.equal(v.picker(), undefined, 'a general answer needs no choice');
  assert.deepEqual(v.rec.of('updateSettings'), []);

  // Asked once: the next question goes straight to Vera. It needs a rule, so
  // the reply carries the choice again.
  await v.ask(RULE_QUESTION);
  assert.equal(v.turns.length, 2);
  assert.match(v.pageText(), /That depends on the license you hold\./);
  const again = v.picker();
  assert.ok(again, 'the one-tap choice under the reply');
  assert.equal(again.props.onDismiss, undefined);
  again.props.onChoose('NP');
  await settle(); v.render();
  assert.deepEqual(plain(v.rec.of('updateSettings')), [['updateSettings', { degreeType: 'NP' }]]);
  assert.equal(v.turns.length, 3);
  assert.equal(v.turns[2].snapshot.physician.degree, 'NP');
  assert.equal(v.turns[2].history.at(-1).text, RULE_QUESTION);
  assert.ok(!v.turns[2].history.some(m => /That depends on the license/.test(m.text)), 'the reply that asked is not sent back');
  assert.equal(evidenceForTurn(v.turns[2].snapshot, v.turns[2].history).referenceEvidence.jurisdictions.TX.profession, 'np');
  const text = v.pageText();
  assert.doesNotMatch(text, /That depends on the license you hold\./, 'the answer takes its place');
  assert.match(text, /Answer for NP: How many CME hours/);
  assert.deepEqual(v.userTexts(), [GENERAL_QUESTION, RULE_QUESTION]);
  assert.equal(v.picker(), undefined);
});

test('Vera, blank member: "Not now" is remembered on this device, so coming back to Vera answers her next general question at once', async () => {
  const device = {};
  const v = await mountBlankVera({ device });
  await v.ask(GENERAL_QUESTION);
  v.picker().props.onDismiss();
  await settle(); v.render();
  assert.equal(v.turns.length, 1);
  assert.equal(device.veraProfessionLater, '1', 'kept for her account on this device');

  // She goes Home (Vera unmounts) or iOS reloads the app, then comes back.
  const back = await mountBlankVera({ device, saved: v.store.chat });
  await back.ask('How do I export my file?');
  assert.equal(back.turns.length, 1, 'answered at once, not held under the picker');
  assert.equal(back.picker(), undefined, 'not asked again before a general question');
  assert.match(back.pageText(), /Answer for no profession: How do I export my file\?/);
  // A rule still brings the choice back, under the reply.
  await back.ask(RULE_QUESTION);
  assert.equal(back.turns.length, 2);
  const again = back.picker();
  assert.ok(again);
  assert.equal(again.props.onDismiss, undefined, 'the choice under a reply, not the picker that holds a question');

  // A member who never tapped "Not now" is still asked first.
  const fresh = await mountBlankVera();
  await fresh.ask(GENERAL_QUESTION);
  assert.equal(fresh.turns.length, 0);
  assert.ok(fresh.picker()?.props.onDismiss);
});

test('the "Not now" mark is one of the account\'s on-device keys, so Sign out and Delete All My Data remove it', async () => {
  const scope = await import('../../src/utils/storageScope.js');
  assert.equal(scope.BASE_KEYS.veraProfessionLater, 'credentialdomd-vera-profession-later');
  const vera = readFileSync(`${root}src/components/features/AssistantSection.jsx`, 'utf8');
  assert.match(vera, /lsGet\(BASE_KEYS\.veraProfessionLater\) === "1"/);
  assert.match(vera, /lsSet\(BASE_KEYS\.veraProfessionLater, "1"\)/);
});

test('Vera, blank member: choosing under a reply that asked re-sends her question with its file, so Approve still saves the file to Files', async () => {
  const card = { kind: 'create_record', section: 'licenses', fields: { type: 'APRN License (NP)', state: 'TX', licenseNumber: 'SYN-NP-1' }, summary: 'Add the APRN license' };
  const ASK = 'add this and tell me my CE hours';
  const run = async (deferFirst) => {
    const v = await mountBlankVera({ needsProfession: q => q === ASK, actions: (q, degree) => (q === ASK && degree === 'NP' ? [card] : []) });
    if (deferFirst) {
      await v.ask(GENERAL_QUESTION);
      v.picker().props.onDismiss();
      await settle(); v.render();
    }
    await v.pick(v.fileInputs()[0], [new File(['%PDF synthetic'], 'np-license.pdf', { type: 'application/pdf' })]);
    await v.ask(ASK);
    v.picker().props.onChoose('NP');
    await settle(); v.render();
    const last = v.turns.at(-1);
    assert.equal(last.snapshot.physician.degree, 'NP');
    assert.ok(last.attachment?.dataUrl, 'Vera reads the file');
    assert.equal(last.attachment.implicit, undefined, 'as the file she attached to this question, not a follow-up copy');
    await v.button('Approve').props.onClick();
    await settle(); v.render();
    assert.equal(v.rec.of('addItem').filter(c => c[1] === 'licenses').length, 1);
    assert.equal(v.rec.of('addItem').filter(c => c[1] === 'documents').length, 1, 'the file goes to Files');
    return v;
  };
  // After "Not now": the choice shows under the reply that asked.
  const fromReply = await run(true);
  assert.equal(fromReply.turns.length, 3);
  // The control: the picker that held her question.
  const fromWait = await run(false);
  assert.equal(fromWait.turns.length, 1);
});

test('Vera, blank member: a file already saved by an Approve under the reply that asked is read again on her choice, not saved to Files a second time', async () => {
  // The reply that asked proposes the licence too; she approves it, then picks.
  const card = { kind: 'create_record', section: 'licenses', fields: { type: 'State Physician Assistant License', state: 'TX', licenseNumber: 'SYN-PA-1' }, summary: 'Add the PA license' };
  const ASK = 'add this and how many CME hours do I need?';
  const v = await mountBlankVera({
    needsProfession: q => q === ASK,
    askingActions: q => (q === ASK ? [card] : []),
    actions: (q, degree) => (q === ASK && degree === 'PA' ? [card] : []),
  });
  await v.ask(GENERAL_QUESTION);
  v.picker().props.onDismiss();
  await settle(); v.render();
  await v.pick(v.fileInputs()[0], [new File(['%PDF synthetic'], 'pa-license.pdf', { type: 'application/pdf' })]);
  await v.ask(ASK);
  assert.ok(v.picker(), 'the choice under the reply that asked');
  await v.button('Approve').props.onClick();
  await settle(); v.render();
  const docs = () => v.rec.of('addItem').filter(c => c[1] === 'documents').length;
  assert.equal(docs(), 1, 'the first Approve puts the file in Files');
  v.picker().props.onChoose('PA');
  await settle(); v.render();
  const last = v.turns.at(-1);
  assert.equal(last.snapshot.physician.degree, 'PA');
  assert.ok(last.attachment?.dataUrl, 'Vera still reads the file');
  assert.equal(last.attachment.implicit, true, 'as a follow-up copy of a file already in Files');
  await v.button('Approve').props.onClick();
  await settle(); v.render();
  assert.equal(docs(), 1, 'no second copy in Files');
});

test('Vera, blank member: after Vera remounts, choosing under the reply that asked never re-sends a question without the file it carried; she is asked to attach it again', async () => {
  const ASK = 'add this and how many CME hours do I need?';
  const v = await mountBlankVera({ needsProfession: q => q === ASK });
  await v.ask(GENERAL_QUESTION);
  v.picker().props.onDismiss();
  await settle(); v.render();
  await v.pick(v.fileInputs()[0], [new File(['%PDF synthetic'], 'pa-license.pdf', { type: 'application/pdf' })]);
  await v.ask(ASK);
  assert.ok(v.picker(), 'the choice under the reply that asked');
  // She leaves Vera (or iOS reloads the app) and comes back: the transcript
  // is read back from the device, the file is not.
  const saved = plain(v.store.chat);
  const back = await mountBlankVera({ needsProfession: q => q === ASK, saved, device: { ...v.device } });
  await settle(); back.render();
  assert.ok(back.picker(), 'the choice is still under the reply that asked');
  back.picker().props.onChoose('PA');
  await settle(); back.render();
  assert.deepEqual(plain(back.rec.of('updateSettings')), [['updateSettings', { degreeType: 'PA' }]], 'her choice is saved');
  assert.equal(back.turns.length, 0, 'nothing is sent without the file');
  assert.match(back.pageText(), /Your license type is saved\. Re-attach pa-license\.pdf first/);
  const composer = back.nodes().find(n => n.type === 'textarea');
  assert.equal(composer.props.value, ASK, 'her question waits in the composer');
  assert.deepEqual(back.userTexts(), [GENERAL_QUESTION, ASK], 'the thread is kept as it was');
  // Attached again and sent: answered as a PA, with the file.
  await back.pick(back.fileInputs()[0], [new File(['%PDF synthetic'], 'pa-license.pdf', { type: 'application/pdf' })]);
  await back.ask(ASK);
  const last = back.turns.at(-1);
  assert.equal(last.snapshot.physician.degree, 'PA');
  assert.ok(last.attachment?.dataUrl, 'Vera reads the file');

  // The control: a question with no file is re-sent as before after a remount.
  const plainV = await mountBlankVera();
  await plainV.ask(GENERAL_QUESTION);
  plainV.picker().props.onDismiss();
  await settle(); plainV.render();
  await plainV.ask(RULE_QUESTION);
  const again = await mountBlankVera({ saved: plain(plainV.store.chat), device: { ...plainV.device } });
  await settle(); again.render();
  again.picker().props.onChoose('NP');
  await settle(); again.render();
  assert.equal(again.turns.length, 1);
  assert.equal(again.turns[0].snapshot.physician.degree, 'NP');
  assert.equal(again.turns[0].history.at(-1).text, RULE_QUESTION);
  assert.match(again.pageText(), /Answer for NP: How many CME hours/);
});

test('Vera, blank member: after Vera remounts, a file an Approve already put in Files is never asked for again, so it is never saved twice', async () => {
  const card = { kind: 'create_record', section: 'licenses', fields: { type: 'State Physician Assistant License', state: 'TX', licenseNumber: 'SYN-PA-1' }, summary: 'Add the PA license' };
  const ASK = 'add this and how many CME hours do I need?';
  const opts = { needsProfession: q => q === ASK, askingActions: q => (q === ASK ? [card] : []), actions: (q, degree) => (q === ASK && degree === 'PA' ? [card] : []) };
  const v = await mountBlankVera(opts);
  await v.ask(GENERAL_QUESTION);
  v.picker().props.onDismiss();
  await settle(); v.render();
  await v.pick(v.fileInputs()[0], [new File(['%PDF synthetic'], 'pa-license.pdf', { type: 'application/pdf' })]);
  await v.ask(ASK);
  await v.button('Approve').props.onClick();
  await settle(); v.render();
  assert.equal(v.rec.of('addItem').filter(c => c[1] === 'documents').length, 1, 'the Approve puts the file in Files');
  const saved = plain(v.store.chat);
  assert.ok(saved.some(m => m.askProfession && m.sourceAttachSaved), 'the saved chat remembers the file went to Files');
  const back = await mountBlankVera({ ...opts, saved, device: { ...v.device } });
  await settle(); back.render();
  back.picker().props.onChoose('PA');
  await settle(); back.render();
  assert.deepEqual(plain(back.rec.of('updateSettings')), [['updateSettings', { degreeType: 'PA' }]], 'her choice is saved');
  assert.equal(back.turns.length, 0, 'nothing is sent without the file');
  assert.doesNotMatch(back.pageText(), /Re-attach/, 'she is not asked to attach a file already in Files');
  assert.match(back.pageText(), /pa-license\.pdf is already in your Files/);
  const composer = back.nodes().find(n => n.type === 'textarea');
  assert.equal(composer.props.value, '', 'her "add this" question is not put back to be sent without the file');
  assert.equal(back.rec.of('addItem').filter(c => c[1] === 'documents').length, 0, 'no second copy in Files');
});

test('Vera, blank member: after Vera remounts, choosing under the reply that asked never replaces a draft she is typing', async () => {
  const ASK = 'add this and how many CME hours do I need?';
  const DRAFT = 'also when does my DEA expire?';
  const FILE_ONLY = '(sent pa-license.pdf)';
  const needsProfession = q => q === ASK || q === FILE_ONLY;
  // A question with a file, and a file sent with no words (nothing to put back).
  for (const [question, restored] of [[ASK, ASK], ['', '']]) {
    const v = await mountBlankVera({ needsProfession });
    await v.ask(GENERAL_QUESTION);
    v.picker().props.onDismiss();
    await settle(); v.render();
    await v.pick(v.fileInputs()[0], [new File(['%PDF synthetic'], 'pa-license.pdf', { type: 'application/pdf' })]);
    await v.ask(question);
    assert.ok(v.picker(), `the reply to ${question || 'the file alone'} asks for her license`);
    const saved = plain(v.store.chat);
    // With a draft: kept exactly as she typed it.
    const back = await mountBlankVera({ needsProfession, saved, device: { ...v.device } });
    await settle(); back.render();
    back.nodes().find(n => n.type === 'textarea').props.onChange({ target: { value: DRAFT } });
    await settle(); back.render();
    assert.ok(back.picker(), 'the choice is still under the reply that asked');
    back.picker().props.onChoose('PA');
    await settle(); back.render();
    assert.equal(back.turns.length, 0);
    assert.match(back.pageText(), /Re-attach pa-license\.pdf first/);
    assert.equal(back.nodes().find(n => n.type === 'textarea').props.value, DRAFT, 'her draft is kept');
    // Without a draft: her question comes back into the empty composer.
    const empty = await mountBlankVera({ needsProfession, saved, device: { ...v.device } });
    await settle(); empty.render();
    empty.picker().props.onChoose('PA');
    await settle(); empty.render();
    assert.equal(empty.nodes().find(n => n.type === 'textarea').props.value, restored);
  }
});

test('Vera, blank member: the question she waited on is answered with the states her chosen profession tracks', async () => {
  // No primary state; her only licence is a Texas PA licence. For a blank
  // profession only medical licences add a state, so the list on screen
  // before she chose is empty.
  const licenses = [{ id: 'lic-pa', type: 'State Physician Assistant License', state: 'TX', licenseNumber: 'SYN-PA-1', expirationDate: '2027-06-30' }];
  const compliance = await import('../../src/utils/compliance.js');
  assert.deepEqual(compliance.trackedStates('', [], licenses, ''), []);
  assert.deepEqual(compliance.trackedStates('', [], licenses, 'PA'), ['TX']);
  const QUESTION = 'How many CE hours do I still need before my license renews?';
  for (const path of ['wait', 'reply']) {
    const v = await mountBlankVera({ settings: {}, data: { licenses }, allTrackedStates: [], needsProfession: q => q === QUESTION });
    if (path === 'reply') {
      await v.ask(GENERAL_QUESTION);
      v.picker().props.onDismiss();
      await settle(); v.render();
    }
    await v.ask(QUESTION);
    v.picker().props.onChoose('PA');
    await settle(); v.render();
    const turn = v.turns.at(-1);
    assert.equal(turn.snapshot.physician.degree, 'PA', path);
    assert.deepEqual(plain(turn.snapshot.physician.states), ['TX'], `${path}: her PA licence state`);
    assert.deepEqual(Object.keys(turn.snapshot.renewalInfo || {}), ['TX'], `${path}: the Texas renewal rule`);
    const evidence = evidenceForTurn(turn.snapshot, turn.history);
    assert.equal(evidence.referenceEvidence.jurisdictions.TX?.profession, 'pa', `${path}: the Texas PA rule`);
  }
});

test('Vera, blank member: a refused profile save sends nothing and keeps the choice', async () => {
  const v = await mountBlankVera({ refuse: true });
  await v.ask(RULE_QUESTION);
  v.picker().props.onChoose('MD');
  await settle(); v.render();
  assert.equal(v.turns.length, 0);
  assert.ok(v.rec.of('alertWriteRefused').length);
  assert.ok(v.picker());
});

test('Vera: a member who chose MD, DO, PA or NP never sees the picker, even on a rule question', async () => {
  for (const degreeType of ['MD', 'DO', 'PA', 'NP']) {
    const v = await mountBlankVera({ degreeType });
    await v.ask(RULE_QUESTION);
    assert.equal(v.turns.length, 1, degreeType);
    assert.equal(v.turns[0].snapshot.physician.degree, degreeType);
    assert.equal(v.picker(), undefined, degreeType);
    assert.deepEqual(v.rec.of('updateSettings'), [], degreeType);
  }
});

test('Vera\'s contract for a blank member: no rule, and needsProfession when one is needed; MD, DO, PA and NP contracts unchanged', async () => {
  const blank = evidenceInstructionsFor('');
  assert.ok(blank.startsWith(EVIDENCE_INSTRUCTIONS));
  assert.match(blank, /sends no licence, CME, CE or certification rule/);
  assert.match(blank, /give no rule, figure, board or link from memory or from another profession/);
  assert.match(blank, /"needsProfession": true/);
  assert.match(A.systemStaticFor(''), /"needsProfession": true/);
  assert.doesNotMatch(blank, /[\u2013\u2014]\s|byProfession|omittedJurisdictions|uncertainCodesLeftOut/);
  for (const d of ['MD', 'DO']) assert.equal(evidenceInstructionsFor(d), EVIDENCE_INSTRUCTIONS, d);
  for (const d of ['MD', 'DO', 'PA', 'NP']) assert.doesNotMatch(A.systemStaticFor(d), /needsProfession/, d);
});

test('Vera passes needsProfession from the model reply through to the screen', async () => {
  let reply = { reply: 'That depends on the license you hold.', needsProfession: true };
  const stubs = {
    'aiClient$': `export const geminiCall=async()=>({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: globalThis.__reply }] } }] }) });export const proxyErrorMessage=()=>null;export const anthropicAvailable=()=>false;export const anthropicClientFor=async()=>null;export const anthropicErrorMessage=()=>null;export const anthropicSdk=()=>null;export const AI_MESSAGES={};`,
  };
  const out = await build({
    entryPoints: [`${root}src/utils/assistant.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, external: ['react'],
    plugins: [{ name: 'stubs', setup(b) {
      for (const [filter, contents] of Object.entries(stubs)) {
        b.onResolve({ filter: new RegExp(filter) }, () => ({ path: filter, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents, loader: 'js' }));
      }
    } }, sharedRuleResolver],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  const snapshot = mod.exports.buildSnapshot({ settings: { degreeType: '' }, cme: [], licenses: [] }, ['TX']);
  globalThis.__reply = JSON.stringify(reply);
  const asked = await mod.exports.assistantTurn({ history: [{ role: 'user', text: RULE_QUESTION }], snapshot, settings: {} });
  assert.equal(asked.needsProfession, true);
  reply = { reply: 'Here is how.' };
  globalThis.__reply = JSON.stringify(reply);
  const plain = await mod.exports.assistantTurn({ history: [{ role: 'user', text: GENERAL_QUESTION }], snapshot, settings: {} });
  assert.ok(!('needsProfession' in plain), 'absent unless the model asks for it');
  delete globalThis.__reply;
});

// ── The removed guessing paths ──────────────────────────────────────────────

test('the blank-member guessing paths are gone and nothing calls them', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|jsx|ts)$/.test(name)) files.push(p);
    }
  };
  walk(`${root}src`);
  walk(`${root}supabase/functions`);
  const gone = ['blankProfessionEvidence', 'statedProfession', 'statedInConversation', 'WORD_CODES', 'omittedJurisdictions', 'uncertainCodesLeftOut',
    'BLANK_EVIDENCE_BUDGET', 'PROFESSION_LABELS', 'blankReferences', 'blankJurisdiction', 'blankCertifications', 'toAnyProfessionOption', 'ANY_PROFESSION', 'oneReading', 'professionReading',
    'PROFESSION_CUES', 'ALL_EDUCATION_TYPES', 'has not chosen a profession yet: they may be'];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const name of gone) assert.ok(!s.includes(name), `${f.slice(root.length)} still has ${name}`);
  }
});
