// Regression tests for the October 2026 state data review (PA and NP rules
// re-read against their primary sources). Synthetic records only.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PA_STATE_RULES } from '../../src/constants/paStateRules.js';
import { NP_STATE_RULES } from '../../src/constants/npStateRules.js';
import { computeAppCompliance } from '../../src/utils/appCompliance.js';
import { periodProblem } from '../../scripts/generate-app-rules.mjs';

const nowNoon = new Date('2026-10-01T12:00:00');
const run = (st, deg, kind, opts = {}) => {
  mock.timers.enable({ apis: ['Date'], now: nowNoon });
  try { return computeAppCompliance(opts.cme || [], st, deg, { kind, ...opts }); } finally { mock.timers.reset(); }
};
const cme = (category, hours, date, topics = [], customFields) => ({ category, hours: String(hours), date, topics, ...(customFields ? { customFields } : {}) });
const pa = (st) => PA_STATE_RULES[st], rn = (st) => NP_STATE_RULES[st].rn, aprn = (st) => NP_STATE_RULES[st].aprn;
const topic = (set, name, pred = () => true) => set.topics.find(t => t.topic === name && pred(t));

test('accepted credit follows the statute or rule that names the sponsors (AZ, AL, FL, IA, MD, DE, NH)', () => {
  for (const c of ['AMA PRA Category 1', 'AOA Category 1-A']) assert.ok(pa('AZ').totalAccepted.includes(c), `AZ ${c}`);
  assert.deepEqual(pa('AL').totalAccepted, ['AMA PRA Category 1', 'AAPA Category 1 CME', 'AOA Category 1-A', 'AAFP Prescribed Credit']);
  assert.deepEqual(pa('AL').totalUnverified, [], 'PANRE-LA is not in the Alabama rule');
  assert.deepEqual(pa('FL').cat1Accepted, ['AAPA Category 1 CME', 'AMA PRA Category 1', 'AOA Category 1-A', 'AAFP Prescribed Credit']);
  assert.ok(pa('IA').cat1Accepted.includes('AOA Category 1-A') && pa('IA').cat1Accepted.includes('AAFP Prescribed Credit'));
  assert.ok(pa('MD').totalAccepted.includes('AAFP Prescribed Credit'));
  assert.deepEqual(pa('DE').cat1Accepted, ['AMA PRA Category 1', 'AOA Category 1-A']);
  assert.ok(pa('DE').cat1Unverified.includes('AAPA Category 1 CME'), 'no Delaware source names AAPA');
  assert.deepEqual(pa('WV').cat1Unverified, [], 'West Virginia accepts no other categories');
  assert.ok(pa('TN').cat1Unverified.includes('NCCPA PANRE-LA (Category 1 Self-Assessment)'));
  assert.ok(pa('MN').totalUnverified.includes('NCCPA PANRE-LA (Category 1 Self-Assessment)'));
});

test('counting windows the rules settle (AL fixed, MS fixed, OK and WY preceding calendar years, NC and TN member start)', () => {
  assert.equal(pa('AL').windowAnchor, '2025-01-01');
  assert.equal(pa('MS').windowAnchor, '2022-07-01');
  assert.equal(run('WY', 'PA', 'pa', { licenseExpiration: '2026-12-31' }).windowLabel, 'Counting CME dated Jan 1, 2023 through Dec 31, 2025');
  for (const [st, kind, set] of [['NC', 'pa', pa('NC')], ['NC', 'aprn', aprn('NC')], ['TN', 'pa', pa('TN')]]) {
    assert.equal(set.windowRule, 'memberStart', `${st} ${kind}`);
    const deg = kind === 'pa' ? 'PA' : 'NP';
    const open = run(st, deg, kind, { licenseExpiration: '2027-03-31' });
    assert.match(open.windowLabel, /^Set CME Cycle Start/);
    const set2 = run(st, deg, kind, { licenseExpiration: '2027-03-31', cycleStart: '2026-06-15' });
    assert.equal(set2.windowLabel.replace(/^Counting (CME|CE) dated /, ''), 'Jun 15, 2026 through Jun 14, 2028');
  }
});

test('topics: Arkansas pain management keeps its verified 5 hours open as to frequency, for hydrocodone prescribers only', () => {
  const t = topic(pa('AR'), 'Pain Management');
  assert.equal(t.status, 'unverified');
  assert.equal(t.condition.field, 'Authorized to prescribe Schedule II hydrocodone combination products');
  assert.match(t.unverifiedItem, /at least 5 hours/);
  const no = run('AR', 'PA', 'pa', { licenseExpiration: '2027-06-30', licenseAnswers: { 'Authorized to prescribe Schedule II hydrocodone combination products': 'No' } });
  assert.ok(!no.unverifiedTopics.some(u => u.topic === 'Pain Management' && u.applicability !== 'not-applicable'));
});

test('California: the geriatric share is open on the NCCPA route; the PA Schedule II period and the NP 3 hours are open as to frequency', () => {
  const answers = { 'Over 25 percent of primary care patients are 65 or older': 'Yes', 'Furnishes Schedule II controlled substances': 'No' };
  const cert = run('CA', 'PA', 'pa', { licenseExpiration: '2027-06-30', licenseAnswers: answers, certifications: [{ body: 'NCCPA', expirationDate: '2030-12-31', alertable: true }] });
  assert.ok(!cert.topicResults.some(t => t.topic === 'Geriatric Medicine'), 'not counted as owed on the certification route');
  assert.ok(cert.unverifiedTopics.some(t => t.topic === 'Geriatric Medicine'));
  const hours = run('CA', 'PA', 'pa', { licenseExpiration: '2027-06-30', licenseAnswers: answers });
  assert.ok(hours.topicResults.some(t => t.topic === 'Geriatric Medicine' && t.required === 10));
  assert.equal(topic(pa('CA'), 'Controlled Substances').status, 'unverified');
  assert.match(topic(aprn('CA'), 'Controlled Substances').unverifiedItem, /3 hours/);
  assert.match(periodProblem({ period: 'lifetime' }, [{ value: 'course for PAs who had not completed the one-time 1399.610 course', quote: 'shall complete, as part of their continuing education requirements, a course' }]), /one time/,
    'a one-time earlier course is not this course\'s period');
});

test('Delaware PA owes the child abuse and domestic violence hour every renewal; Connecticut APRN counts HIV/AIDS or infection control', () => {
  const t = topic(pa('DE'), 'Child Abuse Recognition');
  assert.equal(t.hours, 1);
  assert.equal(t.period, null);
  const ct = topic(aprn('CT'), 'HIV/AIDS');
  assert.deepEqual(ct.alsoTopics, ['Infection Control']);
  const comp = run('CT', 'NP', 'aprn', { licenseExpiration: '2027-06-30', cme: [cme('Accredited Nursing CE', 1, '2026-03-01', ['HIV/AIDS'])] });
  assert.equal(comp.topicResults.find(r => r.topic === 'HIV/AIDS').met, true);
});

test('Hawaii APRN: the 30 hours, pharmacology and certification are for APRNs renewing prescriptive authority', () => {
  const no = run('HI', 'NP', 'aprn', { licenseExpiration: '2027-06-30', licenseAnswers: { 'Holds prescriptive authority': 'No' } });
  assert.equal(no.exemption.applies, true);
  assert.equal(no.totalRequired, 0);
  assert.equal(no.credentialChecks.find(c => c.id === 'certification'), undefined);
  const yes = run('HI', 'NP', 'aprn', { licenseExpiration: '2027-06-30', licenseAnswers: { 'Holds prescriptive authority': 'Yes' } });
  assert.equal(yes.totalRequired, 30);
  assert.equal(yes.credentialChecks.find(c => c.id === 'certification').met, false);
});

test('first renewal exemptions are a question on the license (GA PA, KS PA, IL RN, OH RN, VA RN, WI PA, RI PA, TX PA, MI RN)', () => {
  for (const [st, kind] of [['GA', 'pa'], ['KS', 'pa'], ['IL', 'rn'], ['OH', 'rn'], ['VA', 'rn'], ['WI', 'pa'], ['RI', 'pa'], ['TX', 'pa'], ['MI', 'rn'], ['NE', 'rn'], ['WY', 'pa']]) {
    const set = kind === 'pa' ? pa(st) : rn(st);
    assert.ok(set.exemption?.question, `${st} ${kind}`);
  }
  const field = pa('GA').exemption.field;
  const exempt = run('GA', 'PA', 'pa', { licenseExpiration: '2027-06-30', licenseAnswers: { [field]: 'Yes', [`${field} (for renewal)`]: '2027-06-30' } });
  assert.equal(exempt.totalRequired, 0);
  const stale = run('GA', 'PA', 'pa', { licenseExpiration: '2029-06-30', licenseAnswers: { [field]: 'Yes', [`${field} (for renewal)`]: '2027-06-30' } });
  assert.equal(stale.totalRequired, 40, 'an answer for another renewal is asked again');
  const mi = run('MI', 'NP', 'rn', { licenseExpiration: '2027-06-30', licenseAnswers: { [rn('MI').exemption.field]: 'No', [`${rn('MI').exemption.field} (for renewal)`]: '2027-06-30' } });
  assert.equal(mi.totalRequired, 0, 'Michigan: not licensed the whole two years, so the 25 hours do not apply');
});

test('Texas PMP course and Utah DOPL tutorial do not reuse the hours of the controlled substance topic on the same tag', () => {
  const answers = { 'Holds prescriptive authority': 'No', 'Prescribes controlled substances': 'Yes', 'Texas APRN: agreement authorizes opioids': 'No', 'Authorized to access the Texas PMP': 'Yes' };
  const three = run('TX', 'NP', 'aprn', { licenseExpiration: '2027-06-30', licenseAnswers: answers, cme: [cme('Accredited Nursing CE', 3, '2026-03-01', ['Controlled Substances'])] });
  const pmp = three.topicResults.find(t => t.topic === 'Controlled Substances' && t.required === 2);
  assert.equal(pmp.met, false, '3 hours meet the 3, not the separate 2');
  const five = run('TX', 'NP', 'aprn', { licenseExpiration: '2027-06-30', licenseAnswers: answers, cme: [cme('Accredited Nursing CE', 5, '2026-03-01', ['Controlled Substances'])] });
  assert.equal(five.topicResults.find(t => t.topic === 'Controlled Substances' && t.required === 2).met, true);
  const ut = run('UT', 'NP', 'aprn', { licenseExpiration: '2028-01-31', licenseAnswers: { 'Holds a state controlled substance registration': 'Yes' }, cme: [cme('Accredited Nursing CE', 3.5, '2026-03-01', ['Substance Use Disorders'])] });
  assert.equal(ut.topicResults.find(t => t.topic === 'Controlled Substances' && t.required === 3.5).met, true, 'the SBIRT class counts for the controlled substance hours of its period');
});

test('North Carolina NP: the controlled substance hour is the 12 months before today', () => {
  const t = topic(aprn('NC'), 'Controlled Substances');
  assert.deepEqual(t.period, { years: 1, fromToday: true });
  const comp = run('NC', 'NP', 'aprn', { licenseExpiration: '2027-09-30', licenseAnswers: { 'Prescribes controlled substances': 'Yes' }, cme: [cme('Accredited Nursing CE', 1, '2026-08-01', ['Controlled Substances'])] });
  assert.equal(comp.topicResults.find(r => r.topic === 'Controlled Substances').met, true);
});

test('New York prescriber training runs on fixed July 1 due dates', () => {
  assert.deepEqual(topic(pa('NY'), 'Pain Management').period, { years: 3, anchor: '2017-07-01' });
  const answers = { 'Holds a DEA registration': 'Yes' };
  const old = run('NY', 'PA', 'pa', { licenseExpiration: '2028-12-31', licenseAnswers: answers, cme: [cme('AAPA Category 1 CME', 3, '2025-06-01', ['Pain Management'])] });
  // A December 2028 renewal falls before the July 1, 2029 due date: the
  // period counted is the one that ended July 1, 2026, which June 2025 met.
  assert.equal(old.topicResults.find(t => t.topic === 'Pain Management').met, true, 'June 2025 met the 2026 due date; the 2029 one is not due yet');
  assert.match(old.topicResults.find(t => t.topic === 'Pain Management').periodLabel, /due Jul 1, 2026, next due Jul 1, 2029/);
  const after = run('NY', 'PA', 'pa', { licenseExpiration: '2029-12-31', licenseAnswers: answers, cme: [cme('AAPA Category 1 CME', 3, '2025-06-01', ['Pain Management'])] });
  assert.equal(after.topicResults.find(t => t.topic === 'Pain Management').met, false, 'a renewal after July 1, 2029 counts the 2026 to 2029 period');
  assert.equal(rn('NY').cycle, 3);
});

test('options say what the board accepts: Tennessee two items, Alaska two of three methods', () => {
  assert.equal(rn('TN').options.length, 1);
  assert.match(rn('TN').options[0].text, /At least two items/);
  assert.match(rn('AK').options[0].text, /^Two of the three methods/);
  assert.equal(aprn('TN').ceMode, 'options', 'Tennessee APRN: certification plus one more item, confirmed');
  assert.match(aprn('TN').options[0].text, /plus one more item/);
});

test('license renewal intervals are carried where a fact states them', () => {
  const cases = [[pa('AR'), 1], [aprn('AK'), 2], [pa('IL'), 2], [rn('IL'), 2], [aprn('IL'), 2], [rn('IN'), 2], [pa('DC'), 2], [rn('DC'), 2], [aprn('DC'), 2],
    [rn('DE'), 2], [pa('NE'), 2], [rn('NE'), 2], [aprn('NE'), 2], [aprn('NV'), 2], [aprn('NH'), 2], [aprn('ND'), 2], [rn('OH'), 2], [aprn('OH'), 2],
    [rn('OK'), 2], [aprn('OR'), 2], [rn('PA'), 2], [aprn('PA'), 2], [pa('TN'), 2], [pa('UT'), 2], [rn('UT'), 2], [aprn('UT'), 2], [aprn('TX'), 2],
    [aprn('VT'), 2], [pa('WI'), 2], [rn('WI'), 2], [aprn('WI'), 2], [aprn('WV'), 2], [aprn('WY'), 2], [rn('NY'), 3]];
  for (const [set, years] of cases) assert.equal(set.licenseCycle, years, `${set.state} ${set.kind}`);
});

test('board links verified on the board\'s own host (IA, KY, MD, MN, NC, NH, NJ, OH, SD, WA, WY)', () => {
  for (const [st, which] of [['IA', 'pa'], ['IA', 'np'], ['KY', 'np'], ['MD', 'np'], ['MN', 'np'], ['NC', 'np'], ['NH', 'pa'], ['NH', 'np'], ['NJ', 'np'], ['OH', 'np'], ['SD', 'np'], ['WA', 'pa'], ['WA', 'np'], ['WY', 'pa']]) {
    const url = which === 'pa' ? pa(st).boardUrl : NP_STATE_RULES[st].boardUrl;
    assert.match(url || '', /^https:\/\//, `${st} ${which}`);
  }
  assert.equal(pa('MS').boardUrl, 'https://www.msbml.ms.gov/licensure/pa-renewal', 'the old Mississippi page returns Access Denied');
});

test('open questions the sources leave are shown, never settled (CO PA, NY PA, NJ RN, KY PA, MN PA, VT, WA)', () => {
  assert.equal(pa('CO').ceMode, 'unverified');
  assert.equal(pa('NY').ceMode, 'unverified');
  assert.ok(rn('NJ').unverified.some(u => /perinatal bias/.test(u.item)));
  assert.ok(pa('KY').unverified.length >= 4);
  assert.ok(pa('MN').unverified.some(u => /Fetal alcohol/.test(u.item)));
  assert.ok(aprn('MN').unverified.some(u => /Fetal alcohol/.test(u.item)));
  assert.ok(!rn('MN').unverified.some(u => /Fetal alcohol/.test(u.item)));
  assert.ok(pa('VT').unverified.length >= 2);
  assert.ok(aprn('WA').unverified.length >= 3);
});

test('conditioned requirements: Colorado and New Hampshire certification, Pennsylvania initial opioid hours, New Mexico first year', () => {
  assert.equal(aprn('CO').certificationRequired.condition.field, 'Holds prescriptive authority');
  assert.equal(aprn('NH').certificationRequired.condition.field, 'Licensed as an APRN after September 1984');
  assert.equal(aprn('NH').certificationInLieu, null, 'certification counts toward the RN or APRN hours under Nur 401.03(b), not the APRN 30 by statute');
  assert.match(topic(pa('PA'), 'Opioid Prescribing', t => t.hours === 4).condition.question, /within the past year/);
  assert.match(topic(pa('NM'), 'Pain Management', t => t.hours === 5).condition.question, /first year/);
  assert.ok(topic(aprn('PA'), 'Child Abuse Recognition', t => t.hours === 2));
  assert.equal(aprn('RI').total, 10);
  assert.equal(aprn('LA').topics.find(t => t.topic === 'Pharmacology').hours, 12);
  assert.ok(aprn('ME').topics.some(t => t.topic === 'Pharmacology' && t.hours === 15));
  assert.equal(aprn('VT').practiceHours.label, 'At least 400 hours of APRN practice in the two years before renewal, or 960 hours in the five years before');
});
