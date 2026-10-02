// Fifth review round: copy and links a PA or NP sees on the Setup, Settings,
// Vera receipt and card paths, and the invoice sender label. MD and DO stay
// as they were. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FOCUS_COPY, focusCopyFor } from '../../src/utils/publicRecord.js';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('public records opened from the PA program or nursing education row speak of that program, never medical school or residency', () => {
  for (const deg of ['PA', 'NP']) {
    const c = focusCopyFor('education', deg);
    assert.doesNotMatch(`${c.title} ${c.line}`, /medical school|residency|fellowship/i, deg);
    assert.match(c.line, /not the degree your program granted/);
  }
  assert.equal(focusCopyFor('education', 'PA').title, 'PA program');
  assert.equal(focusCopyFor('education', 'NP').title, 'Nursing education');
  for (const deg of ['MD', 'DO', '']) assert.equal(focusCopyFor('education', deg), FOCUS_COPY.education, deg || 'blank');
  assert.equal(focusCopyFor('workHistory', 'PA'), FOCUS_COPY.workHistory);
  assert.equal(focusCopyFor('nothing', 'PA'), null);
  assert.match(read('src/components/features/PublicRecordReview.jsx'), /focusCopyFor\(focus, data\.settings\?\.degreeType\)/);
});

test("Vera's source receipt: an Ohio PA or NP is never offered the Ohio physician rules; MATE stays for every DEA practitioner", async () => {
  const { sourceIdsForQuestion } = await import('../../src/utils/veraSourcesClient.js');
  const ask = (text) => [{ role: 'user', text }];
  const q = ask('How many CME credits do I need to renew my license?');
  for (const degree of ['PA', 'NP']) {
    assert.deepEqual(sourceIdsForQuestion(q, { physician: { degree, states: ['OH'] } }), [], degree);
    assert.deepEqual(sourceIdsForQuestion(ask('Do I need the MATE training for my DEA renewal?'), { physician: { degree, states: ['OH'] } }), ['dea-mate'], degree);
  }
  // A member with no profession is offered no source: her turn carries no
  // rule until she chooses (evidenceForTurn marks it not_chosen), whatever
  // her words say.
  const { evidenceForTurn } = await import('../../src/utils/assistantEvidence.js');
  for (const text of ["I'm a PA in Ohio. How many CME credits do I need?", 'How many CME credits do I need to renew my license?']) {
    const turn = evidenceForTurn({ physician: { degree: '', states: ['OH'] } }, ask(text));
    assert.deepEqual(sourceIdsForQuestion(ask(text), turn), [], text);
  }
  // Physicians are unchanged.
  for (const degree of ['MD', 'DO']) assert.deepEqual(sourceIdsForQuestion(q, evidenceForTurn({ physician: { degree, states: ['OH'] } }, q)), ['oh-cme-general', 'oh-pain-clinic'], degree);
});

test('a Minnesota PA and a Virginia NP get the checked board link beside their unverified items; a territory never promises a link it lacks', async () => {
  const { computeAppCompliance } = await import('../../src/utils/appCompliance.js');
  const { cmeAssessmentLabel } = await import('../../src/utils/cmePresentation.js');
  const mn = computeAppCompliance([], 'MN', 'PA');
  assert.ok(mn.unverifiedItems.length > 0);
  assert.equal(mn.boardUrl, 'https://mn.gov/boards/medical-practice/');
  const va = computeAppCompliance([], 'VA', 'NP');
  assert.equal(va.boardUrl, 'https://www.dhp.virginia.gov/Boards/Nursing/');
  const { PA_STATE_RULES } = await import('../../src/constants/paStateRules.js');
  const { NP_STATE_RULES } = await import('../../src/constants/npStateRules.js');
  assert.deepEqual(Object.entries(PA_STATE_RULES).filter(([, r]) => !r.boardUrl).map(([st]) => st), [], 'every PA state has a board link');
  assert.deepEqual(Object.entries(NP_STATE_RULES).filter(([, r]) => !r.boardUrl).map(([st]) => st), [], 'every NP state has a board link');
  for (const st of ['GU', 'PR', 'VI', 'MP']) {
    const c = computeAppCompliance([], st, 'PA');
    assert.equal(c.boardUrl, null, st);
    const label = cmeAssessmentLabel(c);
    assert.match(label, /not yet verified\. The app has no verified board link for them yet$/, st);
    assert.doesNotMatch(label, /The board link has them/, st);
  }
  const app = read('src/App.jsx');
  assert.match(app, /app && !comp\.boardUrl && comp\.rulesVerified && \(comp\.unverifiedItems \|\| \[\]\)\.length > 0/);
});

test('right after an NPI import, the PA card says the licence is on file and asks for its date, never "no license on file"', async () => {
  const { mergeNpiLicenses } = await import('../../src/utils/npiImport.js');
  const { complianceListFor, undatedLicenseOnFile } = await import('../../src/utils/compliance.js');
  const { appRenewalLine } = await import('../../src/utils/cmePresentation.js');
  const imported = mergeNpiLicenses([], [{ state: 'TX', licenseNumber: 'PA-00001', taxonomyCode: '363A00000X', description: 'Physician Assistant' }], { degreeType: 'PA', makeId: () => 'n1' });
  assert.equal(imported[0].expirationDate, '');
  const data = { settings: { name: 'Pat Example', degreeType: 'PA', primaryState: 'TX', additionalStates: [] }, licenses: imported, cme: [], education: [], documents: [], privileges: [] };
  const card = complianceListFor(data).find(c => c.st === 'TX');
  assert.equal(card.comp.windowAnchored, false);
  const undated = undatedLicenseOnFile(data.licenses, 'TX', card.kind);
  assert.equal(undated?.id, 'n1');
  const line = appRenewalLine(card.comp, null, undated);
  assert.equal(line, "Texas physician assistant license on file. Add its expiration date to start this card's countdown");
  // With nothing on file the line still says so.
  assert.equal(appRenewalLine(card.comp, null, null), 'No Texas physician assistant license on file yet');
  assert.match(read('src/App.jsx'), /appRenewalLine\(comp, waiting \? lifecycleNote\(waiting\) : null, undatedLicenseOnFile\(data\.licenses, st, kind\)\)/);
  const { stateCmeCards } = await import('../../src/utils/memberViewer.js');
  assert.match(stateCmeCards({ member: { degreeType: 'PA', primaryState: 'TX' }, sections: { licenses: imported } }).find(c => c.st === 'TX')?.renews || '', /on file\. Add its expiration date/);
});
