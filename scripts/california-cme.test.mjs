// Pure synthetic checks against actual engine/rule/import modules. No network,
// user records, storage mutation, or claims of regulator-verified course content.
// Run: node --test scripts/california-cme.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCompliance, complianceFor } from '../src/utils/compliance.js';
import { CA_GERIATRIC_FIELD, OHIO_PAIN_CLINIC_FIELD, topicApplicability } from '../src/utils/conditionalCme.js';
import { guessTopics, mapCreditType } from '../src/utils/cmeImport.js';
import { STATE_REQS } from '../src/constants/stateRequirements.js';

const entry = (hours, topics = [], date = '2026-06-01', category = 'AMA PRA Category 1') => ({ hours, topics, date, category });
const oldPain = entry(12, ['Pain Management'], '2020-01-01');
const base = degree => degree === 'DO'
  ? [entry(20, [], '2026-02-01', 'AOA Category 1-A'), entry(30, ['Substance Use Disorders']), oldPain]
  : [entry(50), oldPain];
const options = answer => ({ licenseExpiration: '2027-01-31', topicApplicability: { [CA_GERIATRIC_FIELD]: answer } });
const calculate = (degree, answer, rows = base(degree), extra = {}) => computeCompliance(rows, 'CA', degree, { ...options(answer), ...extra });
const geriatric = comp => comp.conditionalTopics.find(t => t.topic === 'Geriatric Medicine');

for (const degree of ['MD', 'DO']) {
  test(`${degree}: implicit bias remains sourced information, never a pass/fail checklist`, () => {
    for (const tagged of [false, true]) {
      const rows = base(degree);
      if (tagged) rows.push(entry(1, ['Implicit Bias']));
      const comp = calculate(degree, 'No', rows);
      const info = comp.informationalTopics.find(t => t.topic === 'Implicit Bias');
      assert.equal(comp.assessmentStatus, 'met');
      assert.equal(comp.fullyCompliant, true);
      assert.equal(info.informational, true);
      assert.equal(info.applicability, 'informational');
      assert.equal(info.met, null);
      assert.equal(info.earned, null);
      assert.equal(info.checklist, false);
      assert.equal(info.required, 0);
      assert.match(info.cite, /2190\.1/);
      assert.match(info.url, /^https:\/\//);
      assert.ok(!comp.topicResults.some(t => t.topic === 'Implicit Bias'));
      assert.ok(!comp.conditionalTopics.some(t => t.topic === 'Implicit Bias'));
    }
  });

  test(`${degree}: geriatric unknown, yes and no have different meanings`, () => {
    for (const answer of [undefined, null, '', 'Not sure', 'false', 1]) {
      const comp = calculate(degree, answer);
      assert.equal(comp.assessmentStatus, 'needs-confirmation');
      assert.equal(comp.applicabilityUnknown, true);
      assert.equal(comp.fullyCompliant, false);
      assert.equal(geriatric(comp).applicability, 'unknown');
      assert.ok(!comp.topicResults.some(t => t.topic === 'Geriatric Medicine'));
      assert.equal(comp.hoursRemaining, 0);
    }
    for (const answer of ['No', false]) {
      const comp = calculate(degree, answer);
      assert.equal(geriatric(comp).applicability, 'not-applicable');
      assert.equal(comp.assessmentStatus, 'met');
      assert.equal(comp.fullyCompliant, true);
    }
    for (const answer of ['Yes', true]) {
      const comp = calculate(degree, answer);
      const topic = comp.topicResults.find(t => t.topic === 'Geriatric Medicine');
      assert.equal(comp.assessmentStatus, 'needs-hours');
      assert.equal(topic.required, 10);
      assert.equal(topic.earned, 0);
      assert.equal(topic.checklist, false);
      assert.equal(topic.met, false);
    }
  });

  test(`${degree}: applicable target is exactly10 within mandatory50, not 20% of130.5`, () => {
    const rows = [...base(degree), entry(70.5), entry(10, ['Geriatric Medicine'])];
    const comp = calculate(degree, 'Yes', rows);
    assert.equal(comp.totalEarned, 130.5);
    assert.equal(comp.totalRequired, 50);
    assert.equal(geriatric(comp).required, 10);
    assert.equal(geriatric(comp).earned, 10);
    assert.equal(comp.fullyCompliant, true);
    const short = calculate(degree, 'Yes', [...base(degree), entry(9.5, ['Geriatric Medicine'])]);
    assert.equal(geriatric(short).met, false);
    assert.equal(short.assessmentStatus, 'needs-hours');
  });

  test(`${degree}: geriatric credits follow inclusive cycle boundaries and explicit override`, () => {
    const rows = [...base(degree), entry(3, ['Geriatric Medicine'], '2025-01-31'), entry(2, ['Geriatric Medicine'], '2027-01-31'), entry(20, ['Geriatric Medicine'], '2025-01-30'), entry(20, ['Geriatric Medicine'], '2027-02-01')];
    assert.equal(geriatric(calculate(degree, 'Yes', rows)).earned, 5);
    const custom = calculate(degree, 'Yes', rows, { cycleStart: '2026-01-01' });
    assert.equal(geriatric(custom).earned, 2);
    assert.equal(geriatric(custom).required, 10);
    assert.equal(custom.totalRequired, 50);
  });

  test(`${degree}: unknown applicability does not hide known general/category shortfalls`, () => {
    const comp = calculate(degree, undefined, [entry(10), oldPain]);
    assert.equal(comp.applicabilityUnknown, true);
    assert.equal(comp.hoursRemaining, 40);
    assert.equal(comp.cat1Met, false);
    assert.equal(comp.assessmentStatus, 'needs-hours');
    assert.ok(!comp.topicResults.some(t => t.topic === 'Geriatric Medicine'));
  });

  test(`${degree}: one-time pain/MATE and DO recurring addiction requirements are preserved`, () => {
    const rows = [...base(degree), entry(8, ['Substance Use Disorders'], '2020-01-02')];
    const comp = calculate(degree, 'No', rows, { hasDEA: true });
    assert.equal(comp.totalEarned, 50);
    assert.equal(comp.topicResults.find(t => t.topic === 'Pain Management').earned, 12);
    assert.equal(comp.mate.met, true);
    assert.equal(comp.mate.required, 8);
    assert.equal(comp.fullyCompliant, true);
    const missing = calculate(degree, 'No', base(degree).filter(r => !r.topics.includes('Pain Management')), { hasDEA: true });
    assert.equal(missing.topicResults.find(t => t.topic === 'Pain Management').met, false);
    if (degree === 'MD') assert.equal(missing.mate.met, false);
    if (degree === 'DO') {
      const priorOnly = calculate(degree, 'No', [entry(20, [], '2026-06-01', 'AOA Category 1-A'), entry(30), oldPain, entry(8, ['Substance Use Disorders'], '2020-01-02')], { hasDEA: true });
      assert.equal(priorOnly.mate.met, true);
      assert.equal(priorOnly.topicResults.find(t => t.topic === 'Substance Use Disorders').met, false);
    }
  });
}

test('source-backed applicability asks both facts and excludes exactly25%; MD and DO retain their own source', () => {
  for (const degree of ['MD', 'DO']) {
    const t = geriatric(calculate(degree));
    assert.equal(t.condition.field, CA_GERIATRIC_FIELD);
    assert.match(t.condition.question, /general internist or family physician AND/);
    assert.match(t.condition.question, /more than 25%/);
    assert.match(t.condition.description, /Exactly 25% does not/);
    assert.match(t.note, /dementia/);
    assert.match(t.note, /does not verify course content or board acceptance/);
    assert.equal(t.checkedOn, '2026-09-20');
  }
  assert.match(geriatric(calculate('MD')).cite, /Medical Board of California/);
  assert.match(geriatric(calculate('DO')).cite, /1635\(e\)\(3\)/);
  assert.match(geriatric(calculate('DO')).url, /I4500CE10638B11F0ADE8DF244CB90544/);
  assert.equal(geriatric(calculate('DO')).effectiveFrom, '2025-10-01');
});

test('dementia and older-patient topic guesses track content without verifying course acceptance', () => {
  for (const title of ['Care for patients with dementia', 'Geriatric medicine update', 'Care of older adults']) {
    const tags = guessTopics(title, '');
    assert.ok(tags.includes('Geriatric Medicine'));
    assert.equal(geriatric(calculate('MD', 'Yes', [...base('MD'), entry(10, tags)])).earned, 10);
  }
  const irrelevant = calculate('MD', 'Yes', [...base('MD'), entry(10, ['Patient Safety'])]);
  assert.equal(geriatric(irrelevant).earned, 0);
  const unaccepted = calculate('MD', 'Yes', [...base('MD'), entry(10, ['Geriatric Medicine'], '2026-06-01', 'AMA PRA Category 2')]);
  assert.equal(geriatric(unaccepted).earned, 0);
  const doCat2 = calculate('DO', 'Yes', [...base('DO'), entry(10, ['Geriatric Medicine'], '2026-06-01', 'AOA Category 2-A')]);
  assert.equal(geriatric(doCat2).earned, 10);
  // The app already maps AAFP prescribed credits to this tracking bucket;
  // keep that representation without asserting AMA accreditation or approval.
  const aafp = mapCreditType('AAFP Prescribed', 'MD');
  assert.equal(aafp.category, 'AMA PRA Category 1');
  assert.equal(aafp.assumed, true);
  assert.equal(geriatric(calculate('MD', 'Yes', [...base('MD'), entry(10, ['Geriatric Medicine'], '2026-06-01', aafp.category)])).earned, 10);
});

test('missing/unrecognized degree never certifies split-board fallback; explicit MD and DO differ', () => {
  for (const degree of [undefined, null, '', 'unknown', 'md']) {
    const ready = calculate(degree, 'No', base('MD'));
    assert.equal(ready.degreeUnknown, true);
    assert.equal(ready.totalRequired, 50);
    assert.equal(ready.totalEarned, 50);
    assert.equal(ready.cat1Required, 50);
    assert.equal(ready.knownRequirementsMet, true);
    assert.equal(ready.assessmentStatus, 'needs-confirmation');
    assert.equal(ready.fullyCompliant, false);
    const empty = calculate(degree, 'No', []);
    assert.equal(empty.assessmentStatus, 'needs-confirmation');
    assert.equal(empty.hoursRemaining, 50); // Fallback numbers remain available as provisional.
  }
  assert.equal(calculate('MD', 'No', base('MD')).fullyCompliant, true);
  const doUsingMd = calculate('DO', 'No', base('MD'));
  assert.equal(doUsingMd.degreeUnknown, false);
  assert.equal(doUsingMd.cat1Required, 20);
  assert.equal(doUsingMd.cat1Earned, 0);
  assert.equal(doUsingMd.assessmentStatus, 'needs-hours');
});

test('license-specific answer is read without inferring from name/specialty or modifying records', () => {
  const data = { settings: { degreeType: 'MD', name: 'Synthetic Physician, DO', specialty: 'Family Medicine' }, licenses: [{ id: 'ca-test', type: 'Medical License', state: 'CA', expirationDate: '2099-01-31', customFields: { [CA_GERIATRIC_FIELD]: 'No', untouched: 'value' } }], cme: [entry(50, [], '2098-01-01'), oldPain] };
  const before = JSON.stringify(data);
  assert.equal(geriatric(complianceFor(data, 'CA')).applicability, 'not-applicable');
  assert.equal(JSON.stringify(data), before);
  delete data.licenses[0].customFields[CA_GERIATRIC_FIELD];
  assert.equal(geriatric(complianceFor(data, 'CA')).applicability, 'unknown');
});

test('other genuine zero-hour personal checklists remain required and can be satisfied', () => {
  const empty = computeCompliance([], 'MD', 'MD', options());
  const t = empty.topicResults.find(t => t.topic === 'Implicit Bias');
  assert.equal(t.informational, false);
  assert.equal(t.checklist, true);
  assert.equal(t.met, false);
  const tagged = computeCompliance([entry(1, ['Implicit Bias'], '2020-01-01')], 'MD', 'MD', options());
  assert.equal(tagged.topicResults.find(t => t.topic === 'Implicit Bias').met, true);
  assert.deepEqual(tagged.informationalTopics, []);
  assert.equal(topicApplicability(STATE_REQS.CA.md.topics.find(t => t.informational)), 'informational');
});

test('Ohio unknown-only, real shortfall plus unknown, yes and no classifications remain intact', () => {
  const oh = (answer, rows) => computeCompliance(rows, 'OH', 'MD', { licenseExpiration: '2027-01-31', topicApplicability: { [OHIO_PAIN_CLINIC_FIELD]: answer } });
  const rows = [entry(50, ['Ethics'])];
  assert.equal(oh(undefined, rows).assessmentStatus, 'needs-confirmation');
  assert.equal(oh(undefined, rows).topicResults.some(t => t.topic === 'Pain Management'), false);
  assert.equal(oh(undefined, [entry(10, ['Ethics'])]).assessmentStatus, 'needs-hours');
  assert.equal(oh('Yes', rows).assessmentStatus, 'needs-hours');
  assert.equal(oh('No', rows).fullyCompliant, true);
  assert.equal(oh('Yes', [...rows, entry(20, ['Pain Management'])]).fullyCompliant, true);
});
