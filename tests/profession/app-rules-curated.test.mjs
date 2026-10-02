// The curated PA and NP state rules (DESIGN 2.3 to 2.6, 7.4, 8.2). Every
// jurisdiction is curated for both professions; every rule names a citation
// and an https link or is listed as not yet verified with the board link;
// periods are encoded the three ways the engine reads; no dashes; and the
// numbers the engine sees for the spot-check states are the ledger's own.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildState, periodProblem, unstatedFigure, factStatesNumber } from '../../scripts/generate-app-rules.mjs';
import { draftState } from '../../scripts/app-rules/draft-from-ledger.mjs';
import { PA_STATE_RULES } from '../../src/constants/paStateRules.js';
import { NP_STATE_RULES } from '../../src/constants/npStateRules.js';
import { STATE_NAMES } from '../../src/constants/states.js';
import { getCmeTopics } from '../../src/constants/cmeTopics.js';
import { getCMECategories } from '../../src/constants/credentialTypes.js';
import { computeAppCompliance } from '../../src/utils/appCompliance.js';
import { renewalView } from '../../src/utils/renewalRoute.js';
import { findStateLicense } from '../../src/utils/compliance.js';
import { appCardTitle, certificationMetLine, totalHoursLabel, cmeAssessmentLabel } from '../../src/utils/cmePresentation.js';
import { mountComponent } from '../component-harness.mjs';
const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DATA = path.join(ROOT, 'data/app-rules');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const JURISDICTIONS = Object.keys(STATE_NAMES).filter(st => /^[A-Z]{2}$/.test(st) && !['GU', 'PR', 'VI', 'MP', 'AS'].includes(st));
const https = (u) => typeof u === 'string' && /^https:\/\//.test(u);
const sets = (st) => [['pa', PA_STATE_RULES[st]], ['rn', NP_STATE_RULES[st].rn], ['aprn', NP_STATE_RULES[st].aprn]];

test('every jurisdiction is curated for PA, RN and APRN: no board-only stub is left', () => {
  assert.equal(JURISDICTIONS.length, 51, 'fifty states and DC');
  for (const st of JURISDICTIONS) {
    const canon = read(path.join(DATA, 'states', `${st}.json`));
    for (const [kind, sec] of [['pa', canon.pa], ['rn', canon.np?.rn], ['aprn', canon.np?.aprn]]) {
      assert.ok(sec?.ce?.mode, `${st} ${kind}: a curated ce section`);
    }
    for (const [kind, set] of sets(st)) {
      assert.ok(set, `${st} ${kind} generated`);
      assert.doesNotMatch(set.unverified.map(u => u.why).join(' '), /not curated/, `${st} ${kind}: curated`);
    }
  }
});

test('every rule has a citation and an https link, or is listed as not yet verified with the board link', () => {
  for (const st of JURISDICTIONS) {
    for (const [kind, set] of sets(st)) {
      const where = `${st} ${kind}`;
      if (set.ceMode !== 'unverified') {
        assert.ok(set.source && set.source !== 'Not yet verified', `${where}: source`);
        assert.ok(https(set.sourceUrl), `${where}: sourceUrl ${set.sourceUrl}`);
      } else {
        assert.equal(set.total, null);
        assert.ok(set.unverified.length > 0, `${where}: says what is not verified`);
      }
      for (const t of set.topics) {
        if (t.status === 'verified') {
          assert.ok(t.cite, `${where} ${t.topic}: cite`);
          assert.ok(https(t.url), `${where} ${t.topic}: url`);
          assert.ok(typeof t.hours === 'number' && t.hours >= 0);
        } else {
          assert.equal(t.hours, null);
          assert.ok(set.unverified.some(u => u.item === t.unverifiedItem), `${where} ${t.topic}: listed as not yet verified`);
        }
      }
      for (const n of set.notes) assert.ok(n.cite && https(n.url), `${where} note "${n.text}"`);
      for (const o of set.options || []) assert.ok(o.cite && https(o.url), `${where} option "${o.text}"`);
      for (const k of ['certificationInLieu', 'certificationRequired', 'practiceHours']) {
        if (set[k]) assert.ok(set[k].cite && https(set[k].url), `${where} ${k}`);
      }
      if (set.nlc) assert.ok(set.nlc.cite && https(set.nlc.url), `${where} nlc`);
      if (set.practice?.agreement) for (const c of set.practice.agreement.cites) assert.ok(c.cite && https(c.url), `${where} agreement cite`);
      for (const u of set.unverified) assert.ok(u.boardUrl === null || https(u.boardUrl), `${where} "${u.item}" board link`);
    }
    const np = NP_STATE_RULES[st];
    if (np.practice?.agreement) for (const c of np.practice.agreement.cites) assert.ok(c.cite && https(c.url), `${st} np agreement cite`);
    if (np.prescribing?.stateCsRegistration) assert.ok(https(np.prescribing.stateCsRegistration.url), `${st} np csr`);
  }
});

test('periods are encoded the three ways the engine reads, and dated topics carry ISO dates', () => {
  let lifetime = 0, years = 0;
  for (const st of JURISDICTIONS) {
    for (const [kind, set] of sets(st)) {
      for (const t of set.topics) {
        const p = t.period;
        assert.ok(p === null || p === 'lifetime' || (typeof p === 'object' && Number.isInteger(p.years) && p.years > 0), `${st} ${kind} ${t.topic}: period ${JSON.stringify(p)}`);
        // Fixed due dates (New York prescriber training) and counted back from today (North Carolina NP).
        if (p && typeof p === 'object' && p.anchor) assert.match(p.anchor, /^\d{4}-\d{2}-\d{2}$/);
        if (p && typeof p === 'object' && 'fromToday' in p) assert.equal(p.fromToday, true);
        if (p === 'lifetime') lifetime++; else if (p) years++;
        for (const d of [t.expiringOnOrAfter, t.expiringBefore]) if (d) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
      }
      if (set.cycle !== null) assert.ok(Number.isInteger(set.cycle) && set.cycle > 0, `${st} ${kind} cycle`);
      if (set.licenseCycle !== null) assert.ok(Number.isInteger(set.licenseCycle) && set.licenseCycle > 0);
      assert.ok(['license', 'calendarYears', 'fixed', 'memberStart', 'unverified'].includes(set.windowRule));
      if (set.windowRule === 'fixed') assert.match(set.windowAnchor, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  assert.ok(lifetime > 40 && years > 30, `one-time ${lifetime}, N-year ${years}`);
});

test('a one-time or N-year period must be stated by its fact or carry a reviewed reason', () => {
  const fact = (value, quote) => ({ value, quote });
  assert.equal(periodProblem({ period: 'lifetime' }, [fact('2 hours', 'This is a one-time requirement.')]), null);
  assert.match(periodProblem({ period: 'lifetime' }, [fact('2 hours', 'each renewal')]), /one time/);
  assert.equal(periodProblem({ period: 'lifetime', periodReason: 'Due once.' }, [fact('', '')]), null);
  assert.equal(periodProblem({ period: { years: 6 } }, [fact('', 'not less than once every six years')]), null);
  assert.equal(periodProblem({ period: { years: 2 } }, [fact('', 'every 24 months')]), null);
  assert.match(periodProblem({ period: { years: 6 } }, [fact('', 'every third biennium')]), /every 6 years/);
  assert.equal(periodProblem({ period: { years: 1 } }, [fact('', 'Each year an APRN shall obtain')]), null);
  assert.equal(periodProblem({ period: null }, []), null);
});

test('every figure in a label, note, option or agreement is stated by its facts', () => {
  const f = (quote, value = '') => ({ value, quote });
  assert.equal(unstatedFigure('Up to 80 excess hours carry forward', [f('A maximum of 80 total excess credit hours')]), null);
  assert.equal(unstatedFigure('Under 4,000 hours', [f('fewer than four thousand hours')]), null);
  assert.equal(unstatedFigure('From May 30, 2027', [f('licenses expire on or after May 30, 2027.')]), null);
  assert.equal(unstatedFigure('2 hours a year, part of the 20', [f('not less than 2 hours annually')]), '20');
  assert.equal(factStatesNumber(f('three hundred clock hours'), 300), true);
  assert.equal(factStatesNumber(f('three hundred clock hours'), 30), false);
});

test('topic names and credit categories are the profession\'s own lists; no dashes anywhere in the curated data', () => {
  for (const st of JURISDICTIONS) {
    for (const [kind, set] of sets(st)) {
      const deg = kind === 'pa' ? 'PA' : 'NP';
      for (const t of set.topics) assert.ok(getCmeTopics(deg).includes(t.topic), `${st} ${kind}: topic ${t.topic}`);
      for (const c of [...(set.totalAccepted || []), ...(set.totalUnverified || []), ...set.cat1Accepted, ...set.cat1Unverified]) {
        assert.ok(getCMECategories(deg).includes(c), `${st} ${kind}: category ${c}`);
      }
    }
  }
  const files = [
    ...readdirSync(path.join(DATA, 'states')).map(f => path.join(DATA, 'states', f)),
    ...readdirSync(path.join(DATA, 'ledger/additions')).map(f => path.join(DATA, 'ledger/additions', f)),
    path.join(ROOT, 'src/constants/paStateRules.js'), path.join(ROOT, 'src/constants/npStateRules.js'), path.join(DATA, 'coverage.json'),
  ];
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /[–—]/, `${path.relative(ROOT, f)}: no en or em dash`);
});

test('additions re-host a ledger fact, or add a fact a reviewer loaded: https, quoted, named verifier', () => {
  const dir = path.join(DATA, 'ledger/additions');
  let rehosted = 0, added = 0;
  for (const file of readdirSync(dir)) {
    const st = file.slice(0, 2);
    const ledger = read(path.join(DATA, 'ledger', `${st}.json`));
    for (const f of read(path.join(dir, file)).facts) {
      assert.ok(['pa', 'np'].includes(f.profession));
      assert.equal(f.verified, true); assert.equal(f.loaded, true);
      assert.ok(https(f.url), f.url);
      assert.match(f.verifiedBy, /2026-10$/);
      assert.ok(f.quote.split(/\s+/).length <= 25, `${st} ${f.field}: quote of 25 words or fewer`);
      assert.ok(f.cite && f.value !== undefined, `${st} ${f.field}: cite and value`);
      if (f.verifiedBy === 'review-fix-2026-10') {
        // A fact the October review loaded from the primary source: a field of
        // its own, never a silent rewrite of a ledger fact's quote.
        added++;
        assert.ok(!ledger[f.profession].facts.some(x => x.field === f.field), `${st} ${f.field}: a new field, not a ledger rewrite`);
      } else {
        rehosted++;
        assert.ok(ledger[f.profession].facts.some(x => x.field === f.field && x.quote === f.quote && x.verified === true), `${st} ${f.field}: matches its ledger fact`);
      }
    }
  }
  assert.ok(rehosted >= 40, `${rehosted} re-hosted facts (Florida statutes, North Carolina rules)`);
  assert.ok(added >= 100, `${added} facts the October review loaded`);
});

test('spot checks against the ledger: TX, CA, NY, FL, PA, OH, WA', () => {
  const pa = (st) => PA_STATE_RULES[st], rn = (st) => NP_STATE_RULES[st].rn, aprn = (st) => NP_STATE_RULES[st].aprn;
  const pick = (set, ...keys) => Object.fromEntries(keys.map(k => [k, set[k]]));
  // Texas: 22 TAC 183.16 and 216.3.
  assert.deepEqual(pick(pa('TX'), 'ceMode', 'total', 'cycle', 'cat1min'), { ceMode: 'hours', total: 40, cycle: 2, cat1min: 20 });
  assert.deepEqual(pa('TX').cat1Accepted, ['AAPA Category 1 CME']);
  assert.deepEqual(pa('TX').certificationInLieu.covers, ['total', 'categoryMin']);
  assert.deepEqual(pick(rn('TX'), 'ceMode', 'total', 'cycle'), { ceMode: 'hours', total: 20, cycle: 2 });
  assert.equal(rn('TX').nlc.value, true);
  assert.deepEqual(pick(aprn('TX'), 'total', 'satisfiesRn'), { total: 20, satisfiesRn: true });
  assert.deepEqual(aprn('TX').topics.filter(t => t.additional).map(t => [t.topic, t.hours]), [['Pharmacology', 5], ['Controlled Substances', 3]]);
  assert.equal(aprn('TX').certificationInLieu.bodiesVerified, false, 'which certifications Texas approves is not in the ledger');
  // California: PAB and BRN.
  assert.deepEqual(pick(pa('CA'), 'ceMode', 'total', 'cycle'), { ceMode: 'hours', total: 50, cycle: 2 });
  assert.deepEqual(pick(rn('CA'), 'ceMode', 'total'), { ceMode: 'hours', total: 30 });
  assert.equal(aprn('CA').ceMode, 'none');
  // New York: whether the Commissioner set PA CME is open (no source says
  // none), triennial; nurse CE not verified, but the triennial window counts
  // the verified topics.
  assert.deepEqual(pick(pa('NY'), 'ceMode', 'total', 'cycle', 'windowRule'), { ceMode: 'unverified', total: null, cycle: 3, windowRule: 'license' });
  assert.equal(rn('NY').ceMode, 'unverified');
  assert.equal(aprn('NY').ceMode, 'unverified');
  // Florida: 64B8-30.005 and s. 464.013.
  assert.deepEqual(pick(pa('FL'), 'total', 'cat1min'), { total: 100, cat1min: 50 });
  assert.equal(rn('FL').total, 24);
  assert.ok(aprn('FL').topics.some(t => t.topic === 'Controlled Substances' && t.hours === 3 && t.additional));
  // Pennsylvania (the state): certification mode for PAs, 30 RN and CRNP hours.
  assert.equal(pa('PA').ceMode, 'certification');
  assert.equal(pa('PA').certificationRequired.value, true);
  assert.equal(rn('PA').total, 30);
  assert.ok(aprn('PA').topics.some(t => t.topic === 'Pharmacology' && t.hours === 16));
  // Ohio: 100 hours plus 12 additional pharmacology for prescribers.
  assert.equal(pa('OH').total, 100);
  assert.ok(pa('OH').topics.some(t => t.topic === 'Pharmacology' && t.hours === 12 && t.additional));
  assert.deepEqual(pick(aprn('OH'), 'total'), { total: 24 });
  // Washington: annual RN with practice hours; ARNP 30 plus 15 pharmacotherapeutics.
  assert.deepEqual(pick(pa('WA'), 'total', 'cat1min'), { total: 100, cat1min: 40 });
  assert.deepEqual(pick(rn('WA'), 'total', 'cycle'), { total: 8, cycle: 1 });
  assert.equal(rn('WA').practiceHours.hours, 96);
  assert.equal(aprn('WA').total, 30);
  // Every one of these numbers reached the module through a verified fact.
  for (const st of ['TX', 'CA', 'NY', 'FL', 'PA', 'OH', 'WA']) for (const [, set] of sets(st)) {
    if (set.ceMode === 'hours') assert.ok(set.facts.total?.length, `${st} ${set.kind}: total names its fact`);
  }
});

test('the license renewal interval is kept apart from the CE counting cycle (Minnesota PA)', () => {
  assert.equal(PA_STATE_RULES.MN.cycle, 2, '50 hours within the 2 years before renewal');
  assert.equal(PA_STATE_RULES.MN.licenseCycle, 1, 'the license renews every year');
  const v = renewalView({ id: 'm', type: 'State Physician Assistant License', state: 'MN', expirationDate: '2027-06-30' }, 'PA');
  assert.equal(v.cycleShort, 'Every year');
});

test('a state with alternatives states them in its own practice hours question (Delaware APRN)', () => {
  const comp = run('DE', 'NP', 'aprn', { licenseExpiration: '2027-05-31' });
  const check = comp.credentialChecks.find(c => c.id === 'practiceHours');
  assert.equal(check.label, 'At least 1,500 practice hours in the past 5 years, or 600 in the past 2 years');
  assert.equal(check.met, null, 'asked, never assumed');
});

test('Oregon names the license a physician associate license', () => {
  assert.equal(PA_STATE_RULES.OR.licenseTitle, 'Physician associate license');
  const comp = run('OR', 'PA', 'pa', { licenseExpiration: '2027-12-31' });
  assert.equal(appCardTitle(comp), 'Oregon physician associate license');
});

test('coverage lists the dated items to recheck', () => {
  const cov = read(path.join(DATA, 'coverage.json'));
  const has = (st, kind, date) => cov.states[st][kind].dated.some(d => d.date === date);
  assert.ok(has('RI', 'rn', '2027-01-01'), 'Rhode Island compact sunset');
  assert.ok(has('TX', 'pa', '2027-05-30'), 'Texas nutrition CE');
  assert.ok(has('OR', 'rn', '2028-01-01'), 'Oregon RN CE hours start');
  assert.ok(has('NE', 'pa', '2029-01-01'), 'Nebraska opiate CE ends');
});

test('a fresh draft from the ledger is safe: every drafted topic generates as not yet verified', () => {
  const draft = draftState('TX');
  for (const sec of [draft.pa, draft.np.rn, draft.np.aprn]) for (const t of sec.topics || []) assert.equal(t.status, 'unverified');
  const built = buildState('TX', draft);
  for (const set of [built.pa, built.np.rn, built.np.aprn]) {
    assert.ok(set.topics.every(t => t.status === 'unverified' && t.hours === null));
    assert.doesNotMatch(JSON.stringify(set.unverified), /\d+\s*(contact )?(hours?|credits?)/i);
  }
  assert.equal(built.pa.total, 40, 'scalars a verified fact states still come through');
});

// ── The engine on the curated data ──
const nowNoon = new Date('2026-10-01T12:00:00');
const withClock = (fn) => { mock.timers.enable({ apis: ['Date'], now: nowNoon }); try { return fn(); } finally { mock.timers.reset(); } };
const run = (st, deg, kind, opts) => withClock(() => computeAppCompliance(opts.cme || [], st, deg, { kind, ...opts }));
const nccpa = [{ body: 'NCCPA', expirationDate: '2030-12-31', alertable: true }];

test('Texas APRN who prescribes controlled substances owes 20 + 5 + 3 = 28 hours', () => {
  const comp = run('TX', 'NP', 'aprn', { licenseExpiration: '2028-03-31', licenseAnswers: {
    'Holds prescriptive authority': 'Yes', 'Prescribes controlled substances': 'Yes', 'Texas APRN: agreement authorizes opioids': 'No', 'Authorized to access the Texas PMP': 'No' } });
  assert.equal(comp.totalRequired, 28);
  assert.equal(comp.pharmacology.required, 5);
});

test('Texas PA certified by NCCPA: the hours are met through certification, nutrition is still owed', () => {
  const comp = run('TX', 'PA', 'pa', { licenseExpiration: '2028-05-31', certifications: nccpa, licenseAnswers: {
    'Provides direct patient care': 'No', 'Treats patients in an emergency room': 'No', 'Texas PA: agreement authorizes opioids or PMP access': 'No' } });
  assert.equal(comp.totalMet, true);
  assert.equal(comp.cat1Met, true);
  assert.deepEqual(comp.topicResults.map(t => [t.topic, t.required, t.met]), [['Nutrition', 1, false]]);
  assert.equal(comp.assessmentStatus, 'needs-hours');
  assert.equal(comp.shortBy, 'hours');
});

test('Wisconsin PA with 12 of 30 hours and a current NCCPA certification: the card says the certification is what meets the hours', () => {
  const lieu = PA_STATE_RULES.WI.certificationInLieu;
  assert.equal(PA_STATE_RULES.WI.status, 'verified');
  assert.deepEqual([lieu.bodies, lieu.bodiesVerified, lieu.covers, lieu.notForTopics, lieu.cite], [['NCCPA'], true, ['total'], ['Controlled Substances'], 'Wis. Admin. Code PA 2.04(6)']);
  const cme = [{ category: 'AAPA Category 1 CME', hours: '10', date: '2026-08-01', topics: [] }, { category: 'AAPA Category 1 CME', hours: '2', date: '2026-08-02', topics: ['Controlled Substances'] }];
  const comp = run('WI', 'PA', 'pa', { licenseExpiration: '2028-02-28', certifications: nccpa, cme, licenseAnswers: { 'First Wisconsin PA renewal after the license was issued': 'No' } });
  assert.deepEqual([comp.totalEarned, comp.totalRequired, comp.totalMet], [12, 30, true]);
  assert.equal(certificationMetLine(comp), 'Met by your current NCCPA certification, which Wisconsin accepts in place of the logged hours (Wis. Admin. Code PA 2.04(6)). It does not cover the Controlled Substances hours.');
  assert.equal(totalHoursLabel(comp), 'Total logged: 12/30h · met by NCCPA certification');
  assert.equal(comp.assessmentStatus, 'met');
  assert.equal(cmeAssessmentLabel(comp), 'Met through NCCPA certification');
  // No certification on file: 12/30 is a shortfall and nothing claims otherwise.
  const uncertified = run('WI', 'PA', 'pa', { licenseExpiration: '2028-02-28', certifications: [], cme, licenseAnswers: { 'First Wisconsin PA renewal after the license was issued': 'No' } });
  assert.equal(uncertified.totalMet, false);
  assert.equal(certificationMetLine(uncertified), null);
  assert.equal(totalHoursLabel(uncertified), 'Total logged: 12/30h');
  // Thirty logged hours meet it on their own: no certification sentence.
  const logged = run('WI', 'PA', 'pa', { licenseExpiration: '2028-02-28', certifications: nccpa, cme: [...cme, { category: 'AAPA Category 1 CME', hours: '18', date: '2026-08-03', topics: [] }], licenseAnswers: { 'First Wisconsin PA renewal after the license was issued': 'No' } });
  assert.equal(certificationMetLine(logged), null);
  assert.equal(totalHoursLabel(logged), 'Total logged: 30/30h');
  // A physician card never carries it.
  assert.equal(certificationMetLine({ ...comp, profession: undefined }), null);
});

test('a certification-mode card with no verified window (Missouri PA) is met by a current NCCPA record', () => {
  assert.equal(PA_STATE_RULES.MO.windowRule, 'unverified');
  assert.equal(run('MO', 'PA', 'pa', { licenseExpiration: '2027-01-31', certifications: nccpa }).assessmentStatus, 'met');
  assert.equal(run('MO', 'PA', 'pa', { licenseExpiration: '2027-01-31', certifications: [] }).shortBy, 'certification');
});

test('Mississippi PA counts the fixed July 1 even-year cycle the rule sets', () => {
  assert.equal(PA_STATE_RULES.MS.windowRule, 'fixed');
  const comp = run('MS', 'PA', 'pa', { licenseExpiration: '2027-06-30', cme: [{ category: 'AAPA Category 1 CME', hours: '60', date: '2026-08-01', topics: [] }, { category: 'AAPA Category 1 CME', hours: '48', date: '2026-05-01', topics: [] }] });
  assert.equal(comp.windowLabel, 'Counting CME dated Jul 1, 2026 through Jun 30, 2028');
  assert.equal(comp.totalEarned, 60, 'May 2026 belongs to the previous cycle');
});

test('an unverified counting window only matters for what is counted inside it (Rhode Island PA)', () => {
  assert.equal(PA_STATE_RULES.RI.windowRule, 'unverified');
  const cert = [{ body: 'NCCPA', expirationDate: '2030-12-31', alertable: true }];
  const comp = run('RI', 'PA', 'pa', { licenseExpiration: '2027-06-30', certifications: cert, cme: [{ category: 'AAPA Category 1 CME', hours: '30', date: '2026-08-01', topics: [] }] });
  assert.equal(comp.totalRequired, null, 'no hour target without a window');
  assert.equal(comp.assessmentStatus, 'needs-confirmation');
});

test('Alabama PA counts fixed two calendar years from January 1, 2025', () => {
  assert.equal(PA_STATE_RULES.AL.windowRule, 'fixed');
  assert.equal(run('AL', 'PA', 'pa', { licenseExpiration: '2026-12-31' }).windowLabel, 'Counting CME dated Jan 1, 2025 through Dec 31, 2026');
  assert.equal(run('AL', 'PA', 'pa', { licenseExpiration: '2027-12-31' }).windowLabel, 'Counting CME dated Jan 1, 2027 through Dec 31, 2028');
});

test('Oklahoma PA counts the calendar year before each renewal', () => {
  assert.equal(PA_STATE_RULES.OK.windowRule, 'calendarYears');
  assert.equal(run('OK', 'PA', 'pa', { licenseExpiration: '2027-03-31' }).windowLabel, 'Counting CME dated Jan 1, 2026 through Dec 31, 2026');
});

test('a mandate that ends stops applying (Nebraska opiate CE ends January 1, 2029)', () => {
  const answers = { 'Prescribes controlled substances': 'Yes' };
  const before = run('NE', 'PA', 'pa', { licenseExpiration: '2027-10-01', certifications: nccpa, licenseAnswers: answers });
  assert.ok(before.topicResults.some(t => t.topic === 'Opioid Prescribing'));
  const after = run('NE', 'PA', 'pa', { licenseExpiration: '2029-10-01', certifications: nccpa, licenseAnswers: answers });
  assert.ok(!after.topicResults.some(t => t.topic === 'Opioid Prescribing'));
});

test('the question card: a PA or NP answers on their own license, a shared question is asked once', async () => {
  const comp = run('AR', 'NP', 'aprn', { licenseExpiration: '2028-06-30' });
  assert.deepEqual(comp.conditionalTopics.map(t => t.condition.field), ['Holds prescriptive authority', 'Holds prescriptive authority']);
  const edits = [];
  const lic = { id: 'a1', type: 'APRN License (NP)', state: 'AR', expirationDate: '2028-06-30', customFields: {} };
  const mount = (licenses) => mountComponent('src/components/shared/ConditionalCmeTopics.jsx', {
    app: { data: { licenses }, editItem: (s, item) => edits.push([s, item]), theme: T },
    modules: { compliance: { findStateLicense } },
    props: { comp },
  });
  const c = await mount([lic]);
  const selects = c.nodes().filter(n => n.type === 'select');
  assert.equal(selects.length, 1, 'one question for two topics that share it');
  selects[0].props.onChange({ target: { value: 'Yes' } });
  assert.equal(JSON.stringify(edits[0][1].customFields), JSON.stringify({ 'Holds prescriptive authority': 'Yes' }));
  assert.equal(edits[0][1].id, 'a1', 'the answer is written to the APRN license');
  assert.doesNotMatch(c.pageText(), /null|undefined|NaN|medical license|Checked $/);
  const none = await mount([]);
  assert.match(none.pageText(), /Add your AR APRN license with its expiration date/);
  // Physicians keep their card exactly: the medical license wording.
  const md = await mountComponent('src/components/shared/ConditionalCmeTopics.jsx', {
    app: { data: { licenses: [] }, editItem() {}, theme: T }, modules: {},
    props: { comp: { state: 'OH', conditionalTopics: [{ topic: 'Pain Management', applicability: 'unknown', required: 20, condition: { field: 'x', question: 'q', description: 'd' }, url: 'https://x.test', cite: 'c', checkedOn: '2026-09-18' }] } },
  });
  assert.match(md.pageText(), /Add your OH medical license/);
  assert.match(md.pageText(), /The conditional 20-hour rule is awaiting confirmation/);
});

test('the Settings-only knowledge is still physician-free: no PA or NP rule cites a physician board rule as its own', () => {
  for (const st of JURISDICTIONS) for (const [kind, set] of sets(st)) {
    assert.doesNotMatch(String(set.source), /State medical board rule/, `${st} ${kind}`);
  }
  assert.ok(existsSync(path.join(DATA, 'README.md')));
});
