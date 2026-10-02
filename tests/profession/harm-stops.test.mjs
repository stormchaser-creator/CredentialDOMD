// Nothing a PA or NP sees or sends calls them a physician or shows a
// physician rule (DESIGN 8.1 step 7, 7.3, 7.5). MD and DO output is pinned
// by md-do-golden.test.mjs; these are the PA, NP and blank sides. Synthetic
// records only.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildCredentialText, buildCredentialBlurb, buildEmailSubject } from '../../src/utils/helpers.js';
import { buildCvContent } from '../../src/utils/cvContent.js';
import { invoiceCoverBlurb, invoiceCoverEmail } from '../../src/utils/invoiceCover.js';
import { invoiceDocumentArgs, physicianLabel, invoiceSenderFields } from '../../src/utils/invoiceArgs.js';
import { PLACEHOLDER_SENDERS, isPlaceholderSender } from '../../src/utils/outgoingText.js';
import * as edgeOutgoing from '../../supabase/functions/_shared/app/utils/outgoingText.js';
import { SYSTEM_PROMPT } from '../../src/utils/scannerCore.js';
import { cat1BucketLabel } from '../../src/constants/creditEquivalence.js';
import { jurisdictionEvidence, renewalEvidence, savedReferenceContext, evidenceForTurn, evidenceInstructionsFor, EVIDENCE_INSTRUCTIONS, mentionedJurisdictions } from '../../src/utils/assistantEvidence.js';
import { STATE_REQS } from '../../src/constants/stateRequirements.js';
import { stateCmeCards } from '../../src/utils/memberViewer.js';
import { ruleSetFor } from '../../src/utils/ruleResolver.js';
import { bundle } from './bundle.mjs';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });

const PHYSICIAN_WORD = /\bphysician\b(?! assistant)/i;
const settings = (degreeType, over = {}) => ({ name: 'Pat Example', degreeType, npi: '1234567893', specialties: [], ...over });
const paLic = { id: 'p1', type: 'State Physician Assistant License', name: 'TX Physician Assistant License', state: 'TX', licenseNumber: 'PA100', expirationDate: '2027-05-31' };

test('share text: a PA or NP states their profession, never "Dr." or "Doctor of Medicine"; blank states none', () => {
  for (const [deg, label] of [['PA', 'Physician Assistant'], ['NP', 'Nurse Practitioner']]) {
    const text = buildCredentialText(paLic, 'licenses', settings(deg));
    assert.match(text, new RegExp(`^Name: Pat Example, ${deg}$`, 'm'));
    assert.match(text, new RegExp(`^Profession: ${label}$`, 'm'));
    assert.doesNotMatch(text, /Physician:|Degree:|Doctor of|Dr\./);
    // No name: no name line at all (release goal2 dropped "Physician: Dr."),
    // never a "Clinician" placeholder; the profession line still says what
    // the member is.
    const noName = buildCredentialText(paLic, 'licenses', settings(deg, { name: '' }));
    assert.doesNotMatch(noName, /^Name:|Clinician|Physician:/m);
    assert.match(noName, new RegExp(`^Profession: ${label}$`, 'm'));
    const blurb = buildCredentialBlurb(paLic, 'licenses', settings(deg, { name: '' }), false, '');
    assert.match(blurb, new RegExp(`^Credential verification from the ${label.toLowerCase()} \\(NPI`));
    assert.doesNotMatch(blurb, /Dr\./);
    assert.match(buildEmailSubject(paLic, 'licenses', settings(deg, { name: '' })), / - Clinician$/);
  }
  const blank = buildCredentialText(paLic, 'licenses', settings(''));
  assert.match(blank, /^Name: Pat Example$/m);
  assert.doesNotMatch(blank, /Degree:|Profession:|Doctor of Medicine|Physician:/);
  assert.doesNotMatch(buildCredentialBlurb(paLic, 'licenses', settings('', { name: '' }), false, ''), /Dr\./);
});

test('NUCC specialties print their display name, never a 363 code, in share text, blurb and CV', () => {
  const s = settings('NP', { specialties: ['NUCC:363LF0000X:Family Nurse Practitioner'] });
  const text = buildCredentialText(paLic, 'licenses', s);
  assert.match(text, /^Specialty: Family Nurse Practitioner$/m);
  for (const out of [text, buildCredentialBlurb(paLic, 'licenses', s, false, '')]) assert.doesNotMatch(out, /363[AL]/);
  // The CV renderers (cvPdf.js, CVGenerator.jsx) print the last segment of each id.
  const header = buildCvContent({ settings: s, licenses: [], education: [] }).find(x => x.type === 'header');
  assert.deepEqual(header.specialties.map(id => String(id).split(':').pop()), ['Family Nurse Practitioner']);
});

test('CV: no "Dr." for a PA, NP or blank member; a PA or NP lists their licences under "Licenses"', () => {
  for (const deg of ['PA', 'NP', '']) {
    const cv = buildCvContent({ settings: settings(deg), licenses: [paLic, { id: 'a', type: 'APRN License (NP)', state: 'TX', expirationDate: '2027-01-31' }], education: [] });
    const header = cv.find(x => x.type === 'header');
    assert.equal(header.name, 'Pat Example', deg);
    if (deg) assert.equal(header.fullDegree, deg === 'PA' ? 'Physician Assistant' : 'Nurse Practitioner');
    const text = JSON.stringify(cv);
    assert.doesNotMatch(text, /Dr\. |Doctor of Medicine/);
    if (deg) assert.match(text, /"primary":"Licenses"/);
  }
});

test('invoice cover (D-2): physician assistant, nurse practitioner or clinical services; MD unchanged', () => {
  const inv = (deg) => invoiceDocumentArgs({ number: 'INV-1', periodStart: '2026-08-01', periodEnd: '2026-08-15', totalAmount: 1500, lines: [] }, { facility: 'Synthetic Hospital' }, settings(deg), 'Synthetic Agency');
  assert.match(invoiceCoverEmail(inv('PA')), /for physician assistant services at Synthetic Hospital/);
  assert.match(invoiceCoverEmail(inv('NP')), /for nurse practitioner services at Synthetic Hospital/);
  assert.match(invoiceCoverEmail(inv('')), /for clinical services at Synthetic Hospital/);
  assert.match(invoiceCoverEmail(inv('MD')), /for physician services at Synthetic Hospital/);
  assert.equal(inv('MD').servicesPhrase, undefined, 'MD and DO arguments are unchanged');
  // The no-name "Clinician" placeholder is never a sender (senderName).
  assert.doesNotMatch(invoiceCoverBlurb({ ...inv('NP'), email: 'synthetic@example.test' }), /Clinician/);
  assert.equal(physicianLabel({ degreeType: 'PA' }), 'Clinician');
  assert.equal(physicianLabel({ degreeType: 'MD' }), 'Physician');
  assert.equal(physicianLabel({ degreeType: 'DO' }), 'Physician');
  // A blank profession is neutral on a third-party bill (DESIGN 1.3, 7.2).
  assert.equal(physicianLabel({ degreeType: '' }), 'Clinician');
  assert.equal(physicianLabel({}), 'Clinician');
  assert.equal(physicianLabel({ name: 'Pat Example', degreeType: 'PA' }), 'Pat Example, PA');
});

test('invoiceSenderFields: one spread gives a send site the label and the services phrase; MD and DO get only the label', () => {
  assert.deepEqual(invoiceSenderFields({ name: 'Pat Example', degreeType: 'MD' }), { physician: 'Pat Example, MD' });
  assert.deepEqual(invoiceSenderFields({ degreeType: 'DO' }), { physician: 'Physician' });
  const pa = invoiceSenderFields({ degreeType: 'PA' });
  assert.equal(pa.physician, 'Clinician');
  assert.equal(pa.servicesPhrase, 'physician assistant services');
  assert.equal(invoiceSenderFields({ degreeType: 'NP' }).servicesPhrase, 'nurse practitioner services');
  assert.equal(invoiceSenderFields({ degreeType: '' }).servicesPhrase, 'clinical services');
  // A resend goes through the same fields.
  const s = { name: '', degreeType: 'NP' };
  const args = invoiceDocumentArgs({ number: 'N-1', lines: [], totalAmount: 0 }, { facility: 'Synthetic Hospital' }, s);
  for (const [k, v] of Object.entries(invoiceSenderFields(s))) assert.equal(args[k], v, k);
  // Both no-name labels are placeholders, never a sender's name.
  assert.deepEqual([...PLACEHOLDER_SENDERS], ['Physician', 'Clinician']);
  for (const deg of ['MD', 'DO', 'PA', 'NP', '']) assert.ok(isPlaceholderSender(physicianLabel({ degreeType: deg })), deg || 'blank');
  assert.equal(isPlaceholderSender('Pat Example, PA'), false);
  assert.equal(edgeOutgoing.isPlaceholderSender('Clinician'), true, 'the edge copy agrees');
});

test('scanner: a PA or NP gets their own types and categories; blank gets every profession\'s', () => {
  const pa = SYSTEM_PROMPT('PA');
  assert.match(pa, /"State Physician Assistant License", "DEA Registration"/);
  assert.match(pa, /"AAPA Category 1 CME"/);
  assert.match(pa, /The clinician is a physician assistant \(PA\)/);
  assert.match(pa, /"Master of Physician Assistant Studies \(MPAS\)"/);
  assert.doesNotMatch(pa, /"State Medical License"|The physician is/);
  const np = SYSTEM_PROMPT('NP');
  assert.match(np, /"APRN License \(NP\)", "RN License", "RN License \(Multistate\)"/);
  assert.match(np, /"Accredited Nursing CE"/);
  assert.match(np, /pharmacologyHours/);
  const blank = SYSTEM_PROMPT('');
  for (const t of ['State Medical License', 'State Physician Assistant License', 'APRN License (NP)', 'AMA PRA Category 1', 'AAPA Category 1 CME', 'Accredited Nursing CE']) assert.ok(blank.includes(`"${t}"`), t);
  assert.doesNotMatch(blank, /an MD or DO \(degree not yet specified/);
});

test('credit labels name the PA or NP minimum from its own categories', () => {
  assert.equal(cat1BucketLabel(['AAPA Category 1 CME'], 'PA'), 'Category 1 minimum (AAPA Category 1 CME)');
  assert.equal(cat1BucketLabel(['Accredited Nursing CE'], 'NP'), 'Accredited contact hours minimum (Accredited Nursing CE)');
  assert.equal(cat1BucketLabel(['AMA PRA Category 1'], 'MD'), 'AMA PRA Category 1 minimum');
});

test('Vera: a PA or NP never receives physician rules as evidence', () => {
  const physicianUrls = new Set(Object.values(STATE_REQS).flatMap(e => [e, e.md, e.do]).filter(Boolean).map(r => r.sourceUrl).filter(Boolean));
  for (const deg of ['PA', 'NP']) {
    for (const st of ['TX', 'CA', 'NY', 'PA', 'FL']) {
      const ev = jurisdictionEvidence(st, deg);
      assert.equal(ev.profession, deg === 'PA' ? 'pa' : 'np');
      assert.equal(ev.degreeSelectionNeeded, false);
      const s = JSON.stringify(ev);
      for (const u of physicianUrls) assert.ok(!s.includes(`"${u}"`), `${st} ${deg} carries ${u}`);
      for (const r of ev.rules) {
        // Hours come only from the PA or NP rule set, and only when its mode
        // is a verified hour total (or a verified "none").
        const set = ruleSetFor(st, deg, r.kind);
        assert.equal(r.savedGeneralHours, set.ceMode === 'hours' || set.ceMode === 'none' ? set.total : null);
        if (set.ceMode === 'unverified') assert.ok(r.notYetVerified.length > 0, `${st} ${deg} ${r.kind}: unverified says so`);
      }
      const ren = renewalEvidence(st, deg);
      assert.equal(ren.portal, null);
      assert.equal(ren.guide, null);
    }
    const ctx = savedReferenceContext(['TX'], deg);
    assert.ok(ctx.certificationRules.every(r => r.profession === (deg === 'PA' ? 'pa' : 'np')));
    assert.ok(ctx.generalSources.every(s => /^https:\/\//.test(s.url)));
    assert.match(evidenceInstructionsFor(deg), /not yet verified: say so and give the board link/);
    assert.doesNotMatch(evidenceInstructionsFor(deg), /Ask MD vs DO/);
  }
  assert.equal(evidenceInstructionsFor('MD'), EVIDENCE_INSTRUCTIONS);
  // A blank member: the physician contract, plus rule 8: no rule is sent,
  // and a rule question gets the one-tap choice (needsProfession).
  assert.ok(evidenceInstructionsFor('').startsWith(EVIDENCE_INSTRUCTIONS));
  assert.match(evidenceInstructionsFor(''), /has not chosen a profession yet/);
  assert.match(evidenceInstructionsFor(''), /"needsProfession": true/);
});

test('Vera, blank profession: no rule is sent, whatever her words say; she is asked her licence instead', () => {
  for (const text of ["I'm a PA in Texas. How many CME hours do I need to renew?", 'What do I need in Pennsylvania?', 'As a nurse practitioner, what CE do I need?']) {
    const turn = evidenceForTurn({ physician: { degree: '', states: ['TX'] }, licenses: [] }, [{ role: 'user', text }]);
    assert.deepEqual(turn.referenceEvidence, { basis: 'saved_sources_only', liveRetrieval: 'not_performed', professionStatus: 'not_chosen', rules: 'none_until_profession_chosen' }, text);
    assert.deepEqual(turn.renewalInfo, {}, text);
  }
  // A chosen physician who mentions a PA colleague is unchanged.
  const md = evidenceForTurn({ physician: { degree: 'MD', states: ['TX'] }, licenses: [] }, [{ role: 'user', text: "I'm a physician; my physician assistant asked about Texas." }]);
  assert.ok(!('professionStatus' in md.referenceEvidence));
  assert.deepEqual(md.referenceEvidence.jurisdictions.TX, jurisdictionEvidence('TX', null), 'a named state: both physician degrees, as before');
});

test('Vera: "I\'m a PA" never adds Pennsylvania; a Pennsylvania licence or the word does', () => {
  const history = [{ role: 'user', text: "I'm a PA in Texas. What do I need?" }];
  const turn = evidenceForTurn({ physician: { degree: 'PA', states: ['TX'] }, licenses: [] }, history);
  assert.deepEqual(Object.keys(turn.referenceEvidence.jurisdictions), ['TX']);
  const named = evidenceForTurn({ physician: { degree: 'PA', states: ['TX'] }, licenses: [] }, [{ role: 'user', text: 'Do I need anything for Pennsylvania?' }]);
  assert.deepEqual(Object.keys(named.referenceEvidence.jurisdictions).sort(), ['PA', 'TX']);
  const held = evidenceForTurn({ physician: { degree: 'PA', states: ['TX', 'PA'] }, licenses: [{ type: 'State Physician Assistant License', state: 'PA' }] }, history);
  assert.ok(held.referenceEvidence.jurisdictions.PA);
  assert.equal(held.referenceEvidence.jurisdictions.PA.profession, 'pa', 'mentioned states get the member\'s own profession rules');
  assert.deepEqual(mentionedJurisdictions(history), ['PA', 'TX'], 'physicians: unchanged');
});

test('Vera snapshot: PA and NP cards keyed by state and licence, never physician numbers', async () => {
  const { buildSnapshot, systemStaticFor } = await bundle('src/utils/assistant.js');
  const data = { settings: { degreeType: 'NP', primaryState: 'TX', additionalStates: [] }, cme: [], licenses: [
    { id: 'a', type: 'APRN License (NP)', state: 'TX', expirationDate: '2027-03-31' }, { id: 'r', type: 'RN License', state: 'TX', expirationDate: '2027-09-30' }],
  privileges: [], insurance: [], healthRecords: [], documents: [], education: [], caseLogs: [], workLog: [] };
  const snap = buildSnapshot(data, ['TX']);
  assert.deepEqual(Object.keys(snap.cmeSummary.byState), ['TX:aprn', 'TX:rn']);
  // Texas APRN: 20 contact hours (22 TAC 216.3), from the NP rule data.
  assert.equal(snap.cmeSummary.byState['TX:aprn'].required, ruleSetFor('TX', 'NP', 'aprn').total);
  assert.equal(snap.cmeSummary.byState['TX:aprn'].required, 20);
  assert.equal(snap.physician.profession, 'nurse practitioner');
  assert.equal(snap.referenceEvidence.jurisdictions.TX.profession, 'np');
  assert.match(systemStaticFor('NP'), /You are the nurse practitioner's credentialing coordinator/);
  assert.match(systemStaticFor('PA'), /the user is a busy physician assistant/);
  assert.doesNotMatch(systemStaticFor('PA'), /the user is a surgeon/);
  // A blank member is not called a surgeon and is told the profession is open.
  assert.doesNotMatch(systemStaticFor(''), /the user is a surgeon/);
  assert.match(systemStaticFor(''), /has not chosen a profession yet/);
});

test('alerts and the support viewer: PA and NP cards, Clinician fallback, no "null"', async () => {
  const notifications = await bundle('src/utils/notifications.js');
  const data = { settings: { name: '', degreeType: 'PA', primaryState: 'TX', additionalStates: [], reminderLeadDays: 90 }, cme: [],
    licenses: [{ ...paLic, expirationDate: '2026-11-15' }, { id: 'n', type: 'Board Certification (NCCPA)', name: 'PA-C', expirationDate: '2027-12-31' }],
    privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [], memberships: [] };
  const alerts = notifications.generateAlerts(data);
  // Texas PA hours are met through the current NCCPA record (22 TAC 183.16
  // presumption), so the 40 hours are not a shortfall.
  assert.deepEqual(alerts.cmeIssues, [], 'hours met through NCCPA certification are not a shortfall');
  const msg = notifications.buildNotificationMessage(data, alerts);
  assert.match(msg.body, /^CredentialDOMD Alert for Clinician, PA$/m);
  const cards = stateCmeCards({ member: { name: '', degreeType: 'PA', primaryState: 'TX', additionalStates: [], reminderLeadDays: 90 }, sections: { licenses: data.licenses, cme: [] } });
  assert.equal(cards[0].title, 'Texas physician assistant license');
  assert.equal(cards[0].key, 'TX:pa');
  // The verified Texas total, never a physician figure, and the certification
  // that meets it named beside a total under its target.
  assert.equal(cards[0].hoursLine, 'Total logged: 0/40h · met by NCCPA certification', 'the verified Texas total, never a physician figure');
  assert.doesNotMatch(JSON.stringify(cards.map(({ comp, ...rest }) => rest)), /null|NaN|undefined|State medical board rule|No general CME/);
  // A rule set with nothing verified (Montana PA) still reads "not yet verified".
  const mt = stateCmeCards({ member: { name: '', degreeType: 'PA', primaryState: 'MT', additionalStates: [], reminderLeadDays: 90 }, sections: { licenses: [{ ...paLic, state: 'MT' }], cme: [] } });
  assert.equal(mt[0].hoursLine, 'Not yet verified');
  assert.match(mt[0].assessment, /rules not yet verified/);
  assert.doesNotMatch(JSON.stringify(mt.map(({ comp, ...rest }) => rest)), /null|NaN|undefined|State medical board rule|No general CME/);
});

test('copy added for PA and NP carries no physician wording or dashes', () => {
  const texts = [
    SYSTEM_PROMPT('PA').match(/The clinician is[^\n]*/)[0], SYSTEM_PROMPT('NP').match(/The clinician is[^\n]*/)[0],
    evidenceInstructionsFor('PA').split('\n').at(-1),
  ];
  for (const t of texts) {
    assert.doesNotMatch(t.replace(/physician associate|physician's assistant|physician assistant|physician \(MD or DO\)|physician rules/gi, ''), PHYSICIAN_WORD, t);
    assert.doesNotMatch(t, /[–—]/);
  }
});
