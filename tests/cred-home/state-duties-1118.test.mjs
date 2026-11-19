// State duties beside the medical license (2026-11-18): the state's own
// controlled substance registration (asked, prefilled, never created), its
// PDMP prerequisites, and one-time topics due within a set time of
// licensure (dated from the issue date, alerted only inside the lead window,
// never alerted without the date). Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { STATE_CSR, STATE_CSR_TYPE } from '../../src/constants/stateControlledSubstance.js';
import { STATE_REQS, getStateEntry } from '../../src/constants/stateRequirements.js';
import {
  nextFixedExpiry, stateCsrRule, csrCard, csrCards, csrPrefill, csrDeclineEdits, CSR_DECLINED_FIELD,
  addPeriod, licensureDeadlinesFor, licensureDeadlines, datedLicensureDeadlines, licensureDeadlineAlerts,
  FIRST_LICENSED_FIELD, FIRST_REGISTERED_FIELD, firstDateEdits, firstDateEntered,
} from '../../src/utils/stateDuties.js';

const at = (iso) => new Date(`${iso}T12:00:00`);
const bundle = async (rel) => {
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
};
const notifications = await bundle('../../src/utils/notifications.js');
const assistant = await bundle('../../src/utils/assistant.js');

const med = (state, extra = {}) => ({ id: `lic-${state}`, type: 'State Medical License', name: `${state} license`, state, licenseNumber: 'X1', expirationDate: '2028-12-31', ...extra });
// A license whose first-licensure date the physician entered on the state card.
const first = (day) => ({ issuedDate: day, customFields: { [FIRST_LICENSED_FIELD]: day } });
const md = (licenses, extra = {}) => ({ settings: { degreeType: 'MD', specialties: [], reminderLeadDays: 90, primaryState: licenses[0]?.state, ...extra }, licenses, cme: [] });

// ── The table ──

test('every registration entry carries an official source URL, a short quote and its rule text', () => {
  for (const [st, r] of Object.entries(STATE_CSR)) {
    // Oklahoma's is the bureau's own GovDelivery bulletin (account OKBNDD).
    assert.match(r.sourceUrl, /^https:\/\/([^ /]+\.(gov|us)\/|content\.govdelivery\.com\/accounts\/OKBNDD\/)/, `${st} source is a state page`);
    assert.ok(r.quote && r.quote.split(/\s+/).length <= 20, `${st} quote is short`);
    assert.ok(r.name && r.short && r.agency && r.who && r.expiryRule, `${st} fields`);
    assert.ok(Array.isArray(r.prerequisites), `${st} prerequisites`);
    assert.doesNotMatch(JSON.stringify(r), /\u2014/, `${st} has no em dash`);
  }
  assert.equal(STATE_CSR.CA, undefined, 'never a California rule');
  assert.equal(STATE_CSR.TX, undefined);
});

test('fixed expiration rules: AL Dec 31 yearly, DE June 30 odd years, CT Feb 28 odd years, OK Oct 31 with a Dec 31 hard stop', () => {
  assert.equal(nextFixedExpiry(stateCsrRule('AL'), at('2026-11-18')), '2026-12-31');
  assert.equal(nextFixedExpiry(stateCsrRule('AL'), at('2027-01-02')), '2027-12-31');
  assert.equal(nextFixedExpiry(stateCsrRule('DE'), at('2026-11-18')), '2027-06-30');
  assert.equal(nextFixedExpiry(stateCsrRule('DE'), at('2027-07-01')), '2029-06-30');
  assert.equal(nextFixedExpiry(stateCsrRule('CT'), at('2026-11-18')), '2027-02-28');
  assert.equal(nextFixedExpiry(stateCsrRule('OK'), at('2026-11-18')), '2027-10-31');
  assert.equal(nextFixedExpiry(stateCsrRule('OK'), at('2026-07-01')), '2026-10-31');
  assert.match(STATE_CSR.OK.hardStop, /December 31/);
});

test('a rule that names no years fixes no date: Wyoming June 30 biennial, Missouri assigned month, Maryland own date', () => {
  for (const st of ['WY', 'MO', 'MD', 'NV', 'HI', 'LA', 'IA', 'IN', 'IL', 'SC', 'SD', 'ID', 'UT']) {
    assert.equal(nextFixedExpiry(stateCsrRule(st), at('2026-11-18')), null, st);
  }
});

test('PDMP prerequisites are on the verified states, and Nevada 6-monthly PMP check stays text', () => {
  assert.match(STATE_CSR.AL.prerequisites.join(' '), /Prescription Drug Monitoring Program/);
  assert.match(STATE_CSR.MD.prerequisites.join(' '), /CRISP/);
  assert.match(STATE_CSR.NV.prerequisites.join(' '), /Prescription Monitoring Program/);
  assert.match(STATE_CSR.NV.recurringNote, /every 6 months/);
  assert.equal(STATE_CSR.NV.expires, undefined);
});

// ── The prompt ──

test('a physician licensed in AL with no State Controlled Substance record is asked, with a prefill for Add it', () => {
  const data = md([med('AL')]);
  const c = csrCard(data, 'AL', at('2026-11-18'));
  assert.equal(c.status, 'ask');
  assert.deepEqual(c.prefill, { type: STATE_CSR_TYPE, state: 'AL', name: 'ACSC', expirationDate: '2026-12-31' });
  assert.equal(data.licenses.length, 1, 'nothing is created');
});

test('the prefill carries no date where the rule fixes none', () => {
  assert.deepEqual(csrPrefill('MD', at('2026-11-18')), { type: STATE_CSR_TYPE, state: 'MD', name: 'MD CDS' });
});

test('no prompt without a license in force there, for a state with no rule, or for a PA or NP', () => {
  assert.equal(csrCard(md([med('TX')]), 'TX'), null);
  assert.equal(csrCard(md([med('AL', { lifecycleStatus: 'historical' })]), 'AL'), null);
  assert.equal(csrCard(md([{ ...med('AL'), type: 'DEA Registration' }]), 'AL'), null);
  assert.equal(csrCard({ ...md([med('AL')]), settings: { degreeType: 'PA' } }, 'AL'), null);
  assert.deepEqual(csrCards(md([med('TX'), med('CA')])), []);
});

test('a record on file shows the rule beside it; it alerts like any record (no prompt alert)', () => {
  const rec = { id: 'csr', type: STATE_CSR_TYPE, state: 'DE', name: 'DE CSR', expirationDate: '2027-06-30' };
  const data = md([med('DE'), rec]);
  const c = csrCard(data, 'DE', at('2026-11-18'));
  assert.equal(c.status, 'on-file');
  assert.equal(c.record.id, 'csr');
  assert.equal(c.fixedNext, '2027-06-30');
});

test('"I don\'t prescribe controlled substances here" is stored on the license, and Undo clears it', () => {
  const data = md([med('OK')]);
  const edits = csrDeclineEdits(data.licenses, 'OK', '2026-11-18');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].customFields[CSR_DECLINED_FIELD], '2026-11-18');
  const declined = { ...data, licenses: edits };
  const c = csrCard(declined, 'OK', at('2026-11-18'));
  assert.equal(c.status, 'declined');
  assert.equal(c.on, '2026-11-18');
  const undo = csrDeclineEdits(declined.licenses, 'OK', null);
  assert.equal(undo.length, 1);
  assert.equal(Object.hasOwn(undo[0].customFields, CSR_DECLINED_FIELD), false);
  assert.equal(csrCard({ ...data, licenses: undo }, 'OK').status, 'ask');
});

test('the prompt never raises an alert', () => {
  const data = md([med('AL', { expirationDate: '2027-12-31' })]);
  const alerts = notifications.generateAlerts(data);
  assert.equal(alerts, null);
});

// ── Licensure-relative deadlines ──

test('the topic data carries `within` only on the four verified rules', () => {
  const withins = [];
  for (const [st, e] of Object.entries(STATE_REQS)) {
    for (const [deg, r] of e.md || e.do ? [['MD', e.md], ['DO', e.do]] : [['MD', e], ['DO', e]]) {
      for (const t of r?.topics || []) if (t.within) withins.push(`${st}:${deg}:${t.topic}`);
    }
  }
  assert.deepEqual(withins.sort(), [
    'AL:DO:Ethics', 'AL:MD:Ethics', 'DE:DO:Delaware Controlled Substance Law', 'DE:MD:Delaware Controlled Substance Law',
    'KY:DO:Pediatric Abusive Head Trauma', 'KY:MD:Pediatric Abusive Head Trauma', 'PA:DO:Organ and Tissue Donation', 'PA:MD:Organ and Tissue Donation',
  ]);
  for (const t of ['AL', 'DE', 'KY', 'PA'].flatMap(st => getStateEntry(st, 'MD').topics.filter(x => x.within))) {
    assert.equal(t.period, 'lifetime');
    assert.match(t.within.url, /^https:\/\//);
  }
});

test('addPeriod clamps to the month end', () => {
  assert.equal(addPeriod('2026-03-01', { months: 12 }), '2027-03-01');
  assert.equal(addPeriod('2028-02-29', { years: 1 }), '2029-02-28');
  assert.equal(addPeriod('2026-01-31', { months: 1 }), '2026-02-28');
  assert.equal(addPeriod('', { years: 5 }), null);
});

test('AL boundaries course: due 12 months after the license issue date, alerted only inside the lead window', () => {
  const data = md([med('AL', first('2026-03-01'))]);
  const [d] = licensureDeadlinesFor(data, 'AL', at('2026-11-18'));
  assert.equal(d.topic, 'Ethics');
  assert.equal(d.due, '2027-03-01');
  assert.equal(d.status, 'due');
  assert.equal(d.daysLeft, 103);
  assert.deepEqual(licensureDeadlineAlerts(data, 90, at('2026-11-18')), [], 'outside 90 days: listed, not alerted');
  assert.equal(datedLicensureDeadlines(data, 90, at('2026-11-18'))[0].alerted, false);
  const inside = licensureDeadlineAlerts(data, 90, at('2026-12-15'));
  assert.equal(inside.length, 1);
  assert.equal(inside[0].key, 'licensure:AL:Ethics');
  assert.equal(inside[0].renewal, '2027-03-01');
});

test('AL: a first license whose 12 months end on or before Dec 31, 2025 falls under the existing-licensee deadline: shown with Undo, never dated', () => {
  const data = md([med('AL', first('2015-06-01'))]);
  const [d] = licensureDeadlinesFor(data, 'AL', at('2026-11-18'));
  assert.equal(d.status, 'outside');
  assert.equal(d.due, null);
  assert.deepEqual(datedLicensureDeadlines(data, 365, at('2026-11-18')), []);
  assert.deepEqual(licensureDeadlineAlerts(data, 365, at('2026-11-18')), []);
});

test('AL: an issue date that is the current annual term is never read as first licensure (no date, no alert)', () => {
  // Licensed in AL long ago; the only record on file is this year's term.
  const data = md([med('AL', { issuedDate: '2026-01-01', expirationDate: '2026-12-31' })]);
  const [d] = licensureDeadlinesFor(data, 'AL', at('2026-11-18'));
  assert.equal(d.status, 'needs-date');
  assert.equal(d.due, null);
  assert.equal(d.anchor, null);
  assert.equal(d.suggested, '2026-01-01', 'offered only as the prefill for the question');
  assert.deepEqual(datedLicensureDeadlines(data, 365, at('2026-11-18')), []);
  assert.deepEqual(licensureDeadlineAlerts(data, 90, at('2026-11-18')), []);
  assert.deepEqual(licensureDeadlineAlerts(data, 365, at('2026-11-18')), []);
  const RealDate = Date;
  try {
    globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : ['2026-11-18T12:00:00'])); } static now() { return new RealDate('2026-11-18T12:00:00').getTime(); } };
    assert.equal(notifications.generateAlerts(data)?.cmeIssues?.some(i => i.kind === 'licensure') || false, false);
  } finally { globalThis.Date = RealDate; }
});

test('the first license date is asked, stored on the license, kept across a renewal record, and Undo clears it', () => {
  const lic = med('AL', { issuedDate: '2026-01-01', expirationDate: '2026-12-31' });
  const data = md([lic]);
  const edits = firstDateEdits(data.licenses, 'AL', 'license', '2026-03-01');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].customFields[FIRST_LICENSED_FIELD], '2026-03-01');
  assert.equal(data.licenses[0].customFields, undefined, 'nothing changes until the caller saves');
  const saved = { ...data, licenses: edits };
  assert.equal(licensureDeadlinesFor(saved, 'AL', at('2026-11-18'))[0].due, '2027-03-01');
  // The 2027 renewal entered as a new record; the old one is historical.
  const renewed = { ...data, licenses: [{ ...edits[0], lifecycleStatus: 'historical' }, med('AL', { id: 'lic-AL-2027', issuedDate: '2027-01-01', expirationDate: '2027-12-31' })] };
  assert.equal(firstDateEntered(renewed.licenses, 'AL', 'license'), '2026-03-01');
  assert.equal(licensureDeadlinesFor(renewed, 'AL', at('2026-11-18'))[0].due, '2027-03-01', 'the new term does not move the date');
  const undo = firstDateEdits(renewed.licenses, 'AL', 'license', null);
  assert.equal(undo.length, 1);
  assert.equal(Object.hasOwn(undo[0].customFields, FIRST_LICENSED_FIELD), false);
  assert.equal(licensureDeadlinesFor({ ...data, licenses: [undo[0], renewed.licenses[1]] }, 'AL', at('2026-11-18'))[0].status, 'needs-date');
  assert.deepEqual(firstDateEdits(data.licenses, 'AL', 'license', 'not a date'), []);
});

test('no issue date: asked calmly, never listed with a date or alerted', () => {
  const data = md([med('AL')]);
  const [d] = licensureDeadlinesFor(data, 'AL', at('2026-11-18'));
  assert.equal(d.status, 'needs-date');
  assert.equal(d.due, null);
  assert.deepEqual(datedLicensureDeadlines(data, 365, at('2026-11-18')), []);
  assert.deepEqual(licensureDeadlineAlerts(data, 365, at('2026-11-18')), []);
});

test('a date that passed with the topic unmet is asked on the card, never alerted', () => {
  const data = md([med('AL', first('2025-02-01'))]);
  const [d] = licensureDeadlinesFor(data, 'AL', at('2026-11-18'));
  assert.equal(d.status, 'past');
  assert.equal(d.due, '2026-02-01');
  assert.deepEqual(licensureDeadlineAlerts(data, 365, at('2026-11-18')), []);
});

test('a met topic (logged, or confirmed done before) gives no deadline', () => {
  const logged = { ...md([med('AL', first('2026-03-01'))]), cme: [{ id: 'c1', title: 'Synthetic boundaries course', category: 'AMA PRA Category 1', hours: '2', date: '2026-04-01', topics: ['Ethics'] }] };
  assert.deepEqual(licensureDeadlinesFor(logged, 'AL', at('2026-11-18')), []);
});

test('KY pediatric abusive head trauma: dated 5 years from licensure only for the boards the statute names', () => {
  const lic = [med('KY', first('2024-01-10'))];
  assert.deepEqual(licensureDeadlinesFor(md(lic, { specialties: ['ABMS:ABNS'] }), 'KY', at('2026-11-18')).map(d => d.topic).filter(t => t === 'Pediatric Abusive Head Trauma'), []);
  assert.deepEqual(licensureDeadlinesFor(md(lic, { specialties: [] }), 'KY', at('2026-11-18')).filter(d => d.topic === 'Pediatric Abusive Head Trauma'), []);
  for (const sp of ['ABMS:ABP', 'ABMS:ABR', 'ABMS:ABFM', 'ABMS:ABEM', 'AOA:AOBP', 'AOA:AOBEM']) {
    const d = licensureDeadlinesFor(md(lic, { specialties: [sp], degreeType: sp.startsWith('AOA') ? 'DO' : 'MD' }), 'KY', at('2026-11-18')).find(x => x.topic === 'Pediatric Abusive Head Trauma');
    assert.equal(d?.due, '2029-01-10', sp);
  }
});

test('KY: a first license before July 15, 2014 falls under 311.601(2)(a) (prior to Dec 31, 2017), never dated from licensure', () => {
  const ped = (day) => licensureDeadlinesFor(md([med('KY', first(day))], { specialties: ['ABMS:ABP'] }), 'KY', at('2026-11-18')).find(x => x.topic === 'Pediatric Abusive Head Trauma');
  const old = ped('2003-05-01');
  assert.equal(old.status, 'outside');
  assert.equal(old.due, null);
  assert.equal(ped('2014-07-14').status, 'outside');
  assert.equal(ped('2014-07-15').due, '2019-07-15');
  assert.equal(ped('2014-07-15').status, 'past');
  // An annually renewed record with no first date entered is asked, not dated.
  const undated = licensureDeadlinesFor(md([med('KY', { issuedDate: '2026-03-01' })], { specialties: ['ABMS:ABP'] }), 'KY', at('2026-11-18')).find(x => x.topic === 'Pediatric Abusive Head Trauma');
  assert.equal(undated.status, 'needs-date');
  assert.equal(undated.due, null);
});

test('PA DO organ donation cites 49 Pa. Code 25.271(c)(6)(i)(B)', () => {
  const t = getStateEntry('PA', 'DO').topics.find(x => x.topic === 'Organ and Tissue Donation');
  assert.match(t.within.cite, /25\.271\(c\)\(6\)\(i\)\(B\)/);
});

test('PA organ and tissue donation: 5 years from initial licensure only for a license issued on or after May 1, 2026', () => {
  const after = licensureDeadlinesFor(md([med('PA', first('2026-06-01'))]), 'PA', at('2026-11-18')).find(d => d.topic === 'Organ and Tissue Donation');
  assert.equal(after.due, '2031-06-01');
  const before = licensureDeadlinesFor(md([med('PA', first('2020-06-01'))]), 'PA', at('2026-11-18')).find(d => d.topic === 'Organ and Tissue Donation');
  assert.equal(before.status, 'outside', 'counted from a renewal the records do not date: not dated');
  assert.equal(before.due, null);
  // A renewal-dated record from May 2026 on, with no first date entered, is asked, never read as a new license.
  const renewalDated = licensureDeadlinesFor(md([med('PA', { issuedDate: '2026-06-01' })]), 'PA', at('2026-11-18')).find(d => d.topic === 'Organ and Tissue Donation');
  assert.equal(renewalDated.status, 'needs-date');
  assert.equal(renewalDated.due, null);
  const doAfter = licensureDeadlinesFor({ ...md([{ ...med('PA', first('2026-05-01')), type: 'State Medical License (DO)' }]), settings: { degreeType: 'DO', specialties: [] } }, 'PA', at('2026-11-18')).find(d => d.topic === 'Organ and Tissue Donation');
  assert.equal(doAfter.due, '2031-05-01');
});

test('PA note keeps "or of renewal/reactivation": 49 Pa. Code 16.19(c)(1) says so', () => {
  const t = getStateEntry('PA', 'MD').topics.find(x => x.topic === 'Organ and Tissue Donation');
  assert.match(t.note, /renewal\/reactivation/);
});

test('DE controlled substance law course: within the first year of a new Delaware CSR, from the first registration date entered', () => {
  const csr = { id: 'csr', type: STATE_CSR_TYPE, state: 'DE', name: 'DE CSR', expirationDate: '2027-06-30', issuedDate: '2026-02-01', customFields: { [FIRST_REGISTERED_FIELD]: '2026-02-01' } };
  const data = md([med('DE', first('2026-01-15')), csr]);
  const d = licensureDeadlinesFor(data, 'DE', at('2026-11-18')).find(x => x.topic === 'Delaware Controlled Substance Law');
  assert.equal(d.from, 'csr');
  assert.equal(d.due, '2027-02-01');
  assert.equal(licensureDeadlineAlerts(data, 90, at('2026-11-18')).length, 1);
  // No CSR record: nothing to count from, and no prompt for a date of a registration not on file.
  assert.equal(licensureDeadlinesFor(md([med('DE')]), 'DE', at('2026-11-18')).find(x => x.topic === 'Delaware Controlled Substance Law'), undefined);
  // A first registration from before July 2, 2013 fell under 3.1.1 (by June 30, 2015).
  const old = md([med('DE'), { ...csr, customFields: { [FIRST_REGISTERED_FIELD]: '2012-01-01' } }]);
  const oldD = licensureDeadlinesFor(old, 'DE', at('2026-11-18')).find(x => x.topic === 'Delaware Controlled Substance Law');
  assert.equal(oldD.status, 'outside');
  assert.equal(oldD.due, null);
  // CSR on file without any date: asked for it.
  const undated = md([med('DE'), { ...csr, issuedDate: '', customFields: {} }]);
  assert.equal(licensureDeadlinesFor(undated, 'DE', at('2026-11-18')).find(x => x.topic === 'Delaware Controlled Substance Law').status, 'needs-date');
});

test('DE: a renewal-dated CSR record is never read as a new registration (no date, no alert)', () => {
  // A long-standing registrant: the record shows the term after the June 30, 2025 expiry.
  const csr = { id: 'csr', type: STATE_CSR_TYPE, state: 'DE', name: 'DE CSR', expirationDate: '2027-06-30', issuedDate: '2025-07-01' };
  const data = md([med('DE'), csr]);
  const d = licensureDeadlinesFor(data, 'DE', at('2026-11-18')).find(x => x.topic === 'Delaware Controlled Substance Law');
  assert.equal(d.status, 'needs-date');
  assert.equal(d.due, null);
  assert.equal(d.suggested, '2025-07-01');
  // The 2027 renewal entered by editing the record: still nothing dated or alerted.
  const renewed = md([med('DE'), { ...csr, issuedDate: '2027-07-01', expirationDate: '2029-06-30' }]);
  assert.equal(licensureDeadlinesFor(renewed, 'DE', at('2028-05-01')).find(x => x.topic === 'Delaware Controlled Substance Law').due, null);
  assert.deepEqual(licensureDeadlineAlerts(renewed, 365, at('2028-05-01')), []);
  // The physician enters their first registration; it is stored on the CSR record.
  const edits = firstDateEdits(data.licenses, 'DE', 'csr', '2009-03-01');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].id, 'csr');
  assert.equal(edits[0].customFields[FIRST_REGISTERED_FIELD], '2009-03-01');
  const answered = { ...data, licenses: [data.licenses[0], edits[0]] };
  assert.equal(licensureDeadlinesFor(answered, 'DE', at('2026-11-18')).find(x => x.topic === 'Delaware Controlled Substance Law').status, 'outside');
});

test('DE 2-hour controlled substance CE topic says it is attested at the CSR renewal', () => {
  const t = getStateEntry('DE', 'MD').topics.find(x => x.topic === 'Controlled Substances');
  assert.match(t.note, /attested at each CSR renewal/);
  assert.match(t.note, /June 30 of odd years/);
});

test('generateAlerts raises a licensure deadline inside the lead window only', () => {
  const RealDate = Date;
  const frozen = (iso) => class extends RealDate { constructor(...a) { super(...(a.length ? a : [`${iso}T12:00:00`])); } static now() { return new RealDate(`${iso}T12:00:00`).getTime(); } };
  const data = md([med('AL', { ...first('2026-03-01'), expirationDate: '2027-12-31' })]);
  try {
    globalThis.Date = frozen('2026-11-18');
    assert.equal(notifications.generateAlerts(data), null);
    globalThis.Date = frozen('2026-12-15');
    const a = notifications.generateAlerts(data);
    assert.equal(a.cmeIssues.length, 1);
    assert.equal(a.cmeIssues[0].kind, 'licensure');
    assert.match(a.cmeIssues[0].issues[0], /due 2027-03-01/);
  } finally { globalThis.Date = RealDate; }
});

test('Vera gets the registrations and deadlines; a snapshot without them is unchanged', () => {
  const data = md([med('AL', first('2026-03-01')), med('TX')]);
  const s = assistant.stateDutiesSnapshot(data, at('2026-11-18'));
  assert.equal(s.registrations.length, 1);
  assert.equal(s.registrations[0].state, 'AL');
  assert.equal(s.registrations[0].status, 'not on file');
  assert.equal(s.registrations[0].nextByRule, '2026-12-31');
  assert.equal(s.deadlines[0].due, '2027-03-01');
  assert.equal(assistant.stateDutiesSnapshot(md([med('TX')]), at('2026-11-18')), null);
  assert.equal('stateDuties' in assistant.buildSnapshot(md([med('TX')]), ['TX']), false);
  assert.ok('stateDuties' in assistant.buildSnapshot(data, ['AL', 'TX']));
});

test('UI copy has no em dashes', () => {
  for (const f of ['../../src/components/shared/StateDuties.jsx', '../../src/utils/stateDuties.js', '../../src/constants/stateControlledSubstance.js']) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /\u2014/, f);
  }
});

test('licensureDeadlines covers every licensed state at once', () => {
  const data = md([med('AL', first('2026-03-01')), med('PA', first('2026-06-01'))]);
  assert.deepEqual(licensureDeadlines(data, at('2026-11-18')).map(d => d.state).sort(), ['AL', 'PA']);
});

test('the app-made answers stay app settings: hidden on the record view, the read-only archive and the support viewer', async () => {
  const { APP_MARKER_FIELDS } = await import('../../src/constants/appMarkerFields.js');
  const { BOARD_APP_MADE_FIELD } = await import('../../src/utils/lifecycle.js');
  for (const k of [CSR_DECLINED_FIELD, FIRST_LICENSED_FIELD, FIRST_REGISTERED_FIELD, BOARD_APP_MADE_FIELD]) assert.ok(APP_MARKER_FIELDS.has(k), k);
  const crud = readFileSync(new URL('../../src/components/features/CrudSection.jsx', import.meta.url), 'utf8');
  assert.match(crud, /HIDDEN_CUSTOM_KEYS = new Set\(\[[^\]]*\.\.\.APP_MARKER_FIELDS\]\)/);
  const rec = { ...med('OK'), customFields: { [CSR_DECLINED_FIELD]: '2026-11-18', [FIRST_LICENSED_FIELD]: '2020-01-01', 'Board order': 'none' } };
  const archive = await bundle('../../src/utils/readOnlyArchive.js');
  const rows = archive.recordDetails('licenses', rec, { licenses: [rec] });
  assert.equal(rows.some(r => /controlled substance|first ?licensed/i.test(`${r.label} ${r.value}`)), false);
  assert.ok(rows.some(r => r.value === 'none'), 'other custom fields still show');
  const viewer = await bundle('../../src/utils/memberViewer.js');
  const vrows = viewer.recordDetails('licenses', rec, { data: { licenses: [rec] }, settings: {} });
  assert.equal(JSON.stringify(vrows).includes('2026-11-18'), false);
  assert.equal(JSON.stringify(vrows).includes(FIRST_LICENSED_FIELD), false);
  assert.ok(JSON.stringify(vrows).includes('none'), 'the viewer still shows other custom fields');
});

test('a prerequisite is shown under a neutral label; its own timing stays in its text', () => {
  const ui = readFileSync(new URL('../../src/components/shared/StateDuties.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /Before you renew:/);
  assert.match(ui, /Also required: \{p\}/);
  assert.match(STATE_CSR.AL.prerequisites[0], /before you renew/);
  assert.doesNotMatch(STATE_CSR.SD.prerequisites.join(' '), /renew/);
});
