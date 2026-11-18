// AOA "valid thru" date and the "Not required for me" choice (2026-11-18).
// The AOA Physician Portal shows every current-track certificate with a
// "valid thru" date (the end of the current OCC cycle), so the app no longer
// says an AOA certificate issued after 2018 has no expiration date. A board
// record the app made to hold a mark asks for that date calmly on the card
// and never raises the missing-date warning. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BOARD_TASKS } from '../../src/constants/boardRequirements.js';
import { boardComplianceFor } from '../../src/utils/boardCompliance.js';
import { boardTasksFor, boardTaskAlerts, applyBoardTaskMark, newBoardRecord, notRequiredMark, readMark, validThruFor } from '../../src/utils/boardTasks.js';
import { awaitsBoardDate, isAlertable, lifecycleNote, BOARD_APP_MADE_FIELD } from '../../src/utils/lifecycle.js';
import { isNonExpiring } from '../../src/utils/helpers.js';
import { licenseFields } from '../../src/utils/credentialForms.js';
import { currentBoardCertificationOnFile } from '../../src/utils/conditionalCme.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const at = (iso) => new Date(`${iso}T12:00:00`);
const doData = (lic = {}, extra = {}) => ({
  settings: { degreeType: 'DO', specialties: [], ...extra },
  licenses: [{ id: 'bc', type: 'Board Certification (AOA)', name: 'AOBS Surgery', ...lic }],
  cme: [],
});
const aobs = (data) => boardComplianceFor(data).find(b => b.id === 'AOA:AOBS');
// App.jsx missingExpiration: the gate behind the "missing an expiration date" banner and the ring.
const warnsMissingDate = (l) => !l.expirationDate && !isNonExpiring(l, 'licenses') && !awaitsBoardDate(l) && isAlertable(l);
const LEGACY = { id: 'old', type: 'Board Certification (AOA)', name: 'AOBS Surgery', issuedDate: '', expirationDate: '', noExpiration: true,
  notes: 'Added when you marked a board step done. If your certificate shows an expiration date, add it here.', customFields: {} };

test('a post-2018 AOA certificate with a typed valid-thru date does not delay the assessment, even in that year', () => {
  for (const now of ['2026-03-01', '2027-03-01']) {
    const data = doData({ issuedDate: '2025-09-17', expirationDate: '2027-12-31' });
    const la = boardTasksFor(data, aobs(data), at(now)).tasks.find(t => t.id === 'la');
    assert.notEqual(la.status, 'not-yet', now);
    assert.equal(la.startsYear, null, now);
  }
  // A date typed with no issued date at all never delays it either.
  const bare = doData({ expirationDate: '2027-12-31' });
  assert.equal(boardTasksFor(bare, aobs(bare), at('2026-03-01')).tasks[0].status, 'due');
  // The old exam track keeps its meaning: issued 2018 or before starts in the expiration year.
  const old = doData({ issuedDate: '2018-12-31', expirationDate: '2028-12-31' });
  const la = boardTasksFor(old, aobs(old), at('2026-03-01')).tasks[0];
  assert.equal(la.status, 'not-yet');
  assert.equal(la.startsYear, 2028);
});

test('the typed valid-thru date is the certificate date: explained, never contradicted', () => {
  const data = doData({ issuedDate: '2025-09-17', expirationDate: '2027-12-31' });
  const vt = boardTasksFor(data, aobs(data), at('2026-03-01')).validThru;
  assert.deepEqual(vt, { date: '2027-12-31', askDate: false, url: 'https://physicianportal.osteopathic.org/OccComponents', hasRecord: true });
  assert.equal(isNonExpiring(data.licenses[0], 'licenses'), false);
  // A passed valid-thru date is an ordinary passed date.
  assert.equal(currentBoardCertificationOnFile([{ type: 'Board Certification (AOA)', name: 'AOBS Surgery', issuedDate: '2020-06-01', expirationDate: '2026-01-01' }], '2026-11-18'), false);
  assert.equal(currentBoardCertificationOnFile([{ type: 'Board Certification (AOA)', name: 'AOBS Surgery', issuedDate: '2020-06-01', expirationDate: '2027-12-31' }], '2026-11-18'), true);
});

test('an app-made board record with no date never alerts and never says it does not expire', () => {
  const rec = newBoardRecord('AOA:AOBS', () => 'm');
  assert.equal(rec.customFields[BOARD_APP_MADE_FIELD], 'Added when you marked a board step');
  assert.equal('noExpiration' in rec, false);
  assert.match(rec.notes, /valid thru date your AOA Physician Portal shows/);
  assert.equal(awaitsBoardDate(rec), true);
  assert.equal(warnsMissingDate(rec), false, 'no missing-date banner');
  assert.equal(isNonExpiring(rec, 'licenses'), false, 'no "Does not expire" label');
  assert.equal(lifecycleNote(rec), 'Date not added yet');
  const exp = licenseFields({ degreeType: 'DO' }).find(f => f.key === 'expirationDate');
  assert.equal(exp.required(rec), false, 'editing it never forces a date');
  // The card asks for the date, calmly.
  const data = { settings: { degreeType: 'DO', specialties: [] }, licenses: [{ ...rec, customFields: { ...rec.customFields } }], cme: [] };
  const t = boardTasksFor(data, aobs(data), at('2026-03-01'));
  assert.equal(t.validThru.askDate, true);
  assert.equal(t.validThru.hasRecord, true);
  // Once the physician enters the date it is an ordinary dated record.
  const dated = { ...rec, expirationDate: '2027-12-31' };
  assert.equal(awaitsBoardDate(dated), false);
  assert.equal(lifecycleNote(dated), null);
  assert.equal(exp.required({ ...rec, expirationDate: '' , customFields: {} }), true, 'a record of the physician\'s own still asks for its date');
});

test('a legacy noExpiration:true record from the 11-18 release does not alarm and is no longer "Does not expire"', () => {
  assert.equal(awaitsBoardDate(LEGACY), true);
  assert.equal(warnsMissingDate(LEGACY), false);
  assert.equal(isNonExpiring(LEGACY, 'licenses'), false);
  const data = doData();
  data.licenses = [LEGACY];
  const t = boardTasksFor(data, aobs(data), at('2026-03-01'));
  assert.equal(t.validThru.askDate, true);
  // The first mark made through the card moves it to the app's marker; still calm.
  const out = applyBoardTaskMark(data, 'AOA:AOBS', t.tasks[0].field, '2026-03-01');
  const [moved] = out.records;
  assert.equal(moved.noExpiration, false);
  assert.equal(moved.customFields[BOARD_APP_MADE_FIELD], 'Added when you marked a board step');
  assert.equal(warnsMissingDate(moved), false);
  // A lifetime diplomate who ticked "does not expire" on their own record keeps that answer.
  const own = { id: 'l', type: 'Board Certification (AOA)', name: 'AOBS Surgery', noExpiration: true, notes: 'Lifetime certificate' };
  assert.equal(awaitsBoardDate(own), false);
  assert.equal(isNonExpiring(own, 'licenses'), true);
  assert.equal(validThruFor('AOA:AOBS', own), null, 'no request for a date they said does not exist');
});

test('no board record on file: the card still asks for the valid-thru date', () => {
  const data = { settings: { degreeType: 'DO', specialties: ['AOA:AOBS'] }, licenses: [], cme: [] };
  const t = boardTasksFor(data, aobs(data), at('2026-03-01'));
  assert.equal(t.validThru.askDate, true);
  assert.equal(t.validThru.hasRecord, false);
});

test('"Not required for me": stored in the mark field, never alerted, answered on the card, and Undo restores', () => {
  const data = doData();
  const boards = boardComplianceFor(data);
  const now = at('2026-10-01');
  assert.equal(boardTaskAlerts(data, boards, 90, now).length, 1, 'due in 45 days: alerted');
  const la = boardTasksFor(data, aobs(data), now).tasks[0];
  const value = notRequiredMark('2026-10-01');
  assert.equal(value, 'Not required for me (2026-10-01)');
  assert.deepEqual(readMark(value), { kind: 'not-required', on: '2026-10-01' });
  assert.deepEqual(readMark('2026-04-02'), { kind: 'done', on: '2026-04-02' });
  assert.equal(readMark('yes'), null);
  const out = applyBoardTaskMark(data, 'AOA:AOBS', la.field, value);
  assert.equal(out.records[0].customFields[la.field], value, 'same customFields field as a Done mark, so it syncs');
  const marked = { ...data, licenses: out.records };
  const after = boardTasksFor(marked, aobs(marked), now).tasks[0];
  assert.equal(after.status, 'not-required');
  assert.equal(after.notRequiredOn, '2026-10-01');
  assert.equal(after.doneOn, null);
  assert.equal(after.periodWord, 'year');
  assert.equal(boardTaskAlerts(marked, boardComplianceFor(marked), 90, now).length, 0, 'never alerted');
  assert.equal(boardTasksFor(marked, aobs(marked), at('2026-11-18')).tasks[0].status, 'not-required', 'never "unconfirmed" after the date');
  // Undo
  const undo = applyBoardTaskMark(marked, 'AOA:AOBS', la.field, null);
  const restored = { ...data, licenses: undo.records };
  assert.equal(la.field in restored.licenses[0].customFields, false);
  assert.equal(boardTasksFor(restored, aobs(restored), now).tasks[0].status, 'due');
  assert.equal(boardTaskAlerts(restored, boardComplianceFor(restored), 90, now).length, 1);
  // The 3-year QI step reads "this cycle".
  assert.equal(boardTasksFor(data, aobs(data), now).tasks.find(t => t.id === 'qi').periodWord, 'cycle');
});

test('"Not required for me" with no board record creates the record, like a Done mark', () => {
  const data = { settings: { degreeType: 'MD', specialties: ['ABMS:ABNS'] }, licenses: [], cme: [] };
  const b = boardComplianceFor(data)[0];
  const t = boardTasksFor(data, b, at('2026-05-01'));
  const out = applyBoardTaskMark(data, b.id, t.tasks[0].field, notRequiredMark('2026-05-01'), { makeId: () => 'n1' });
  assert.equal(out.create.customFields[t.tasks[0].field], 'Not required for me (2026-05-01)');
  assert.equal(awaitsBoardDate(out.create), true);
  const after = { ...data, licenses: [out.create] };
  assert.equal(boardTasksFor(after, b, at('2026-05-01')).tasks[0].status, 'not-required');
  assert.equal(boardTasksFor(after, b, at('2026-05-01')).validThru, null, 'ABNS has no AOA valid-thru date');
});

test('where to check and who to ask: AOA portal and the AOBS contact; ABNS keeps its own page and no invented contact', () => {
  const set = BOARD_TASKS['AOA:AOBS'];
  assert.equal(set.checked, '2026-11');
  for (const n of [1, 2, 3, 4]) assert.ok(set.sources.includes(`https://certification.osteopathic.org/surgery/occ-overview/component-${n}/`), `component ${n}`);
  assert.deepEqual(set.whereToCheck, { label: 'AOA Physician Portal', url: 'https://physicianportal.osteopathic.org/OccComponents' });
  assert.equal(set.contact.phone, '(312) 202-8078');
  assert.equal(set.contact.email, 'aobs@osteopathic.org');
  assert.equal(set.noExpirationIssuedAfter, undefined, 'renamed: oldExamTrackIssuedThrough');
  assert.equal(set.oldExamTrackIssuedThrough, 2018);
  assert.equal(BOARD_TASKS['ABMS:ABNS'].contact, undefined);
  assert.equal(BOARD_TASKS['ABMS:ABNS'].whereToCheck, undefined);
  const data = doData();
  const t = boardTasksFor(data, aobs(data), at('2026-11-18'));
  assert.equal(t.tasks[0].status, 'unconfirmed');
  assert.equal(t.contact.name, 'AOBS');
  assert.equal(t.whereToCheck.url, 'https://physicianportal.osteopathic.org/OccComponents');
});

test('the card offers the choice, the links and the calm date request; no copy claims no expiration', () => {
  const src = read('src/components/shared/BoardTasks.jsx');
  assert.match(src, /Not required for me this \{t\.periodWord\}/);
  assert.match(src, /Where to check: \{info\.whereToCheck\.label\}/);
  assert.match(src, /info\.contact\.phone/);
  assert.match(src, /Add the date your AOA Physician Portal shows/);
  assert.doesNotMatch(src, /No expiration date:/);
  assert.doesNotMatch(src, /T\.danger|T\.error/, 'the date request is never styled as an alarm');
  const walk = (dir) => readdirSync(dir).flatMap(f => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const f of walk(path.join(root, 'src')).filter(p => /\.(js|jsx)$/.test(p))) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /issued after 2018 carr(y|ies) no expiration|stays active while you meet these yearly steps/i, f);
  }
  for (const f of ['src/components/shared/BoardTasks.jsx', 'src/utils/boardTasks.js', 'src/constants/boardRequirements.js']) {
    assert.doesNotMatch(read(f), /—/, `${f}: no em dashes`);
  }
});

// Review of the board-portal-truth branch (2026-11-18).
import { recordDetails as viewerDetails } from '../../src/utils/memberViewer.js';
import { recordDetails as archiveDetails } from '../../src/utils/readOnlyArchive.js';
import { boardFormStart, normalizeLifecycle } from '../../src/utils/lifecycle.js';

test('a legacy record never reads "Does not expire" to an administrator, in the archive, or in the form', () => {
  const viewer = viewerDetails('licenses', LEGACY, { member: {}, documents: [] });
  assert.equal(viewer.some(r => /does not expire/i.test(r.label) || /does not expire/i.test(r.value)), false, JSON.stringify(viewer));
  const archive = archiveDetails('licenses', LEGACY, {});
  assert.equal(archive.some(r => /expire/i.test(r.label) && /yes|true/i.test(r.value)), false, JSON.stringify(archive));
  // A lifetime diplomate's own tick still shows to the administrator.
  const own = { id: 'l', type: 'Board Certification (AOA)', name: 'AOBS Surgery', noExpiration: true, notes: 'Lifetime certificate' };
  assert.equal(viewerDetails('licenses', own, { member: {}, documents: [] }).some(r => r.label === 'Does not expire'), true);
  // The edit form opens with the box unticked and the app's marker in its place.
  const start = boardFormStart('licenses', LEGACY);
  assert.equal(start.noExpiration, false);
  assert.equal(start.customFields[BOARD_APP_MADE_FIELD], 'Added when you marked a board step');
  assert.equal(awaitsBoardDate(start), true, 'still calm');
  assert.equal(boardFormStart('licenses', own), own, 'a record of the physician\'s own opens as it is');
  const src = read('src/components/features/CrudSection.jsx');
  assert.match(src, /boardFormStart\(sectionKey, item\)/);
  assert.match(src, /f\.key === "noExpiration" && awaitsBoardDate\(viewItem\)/, 'the detail view hides the flag too');
});

test('the app marker is hidden in the read-only records view', () => {
  const rec = newBoardRecord('AOA:AOBS', () => 'm');
  const rows = archiveDetails('licenses', rec, {});
  assert.equal(rows.some(r => /app made/i.test(r.label) || /Added when you marked a board step$/.test(r.value)), false, JSON.stringify(rows));
});

test('a date on an app-made record makes it the physician\'s own: clearing it later raises the banner', () => {
  const rec = { ...newBoardRecord('AOA:AOBS', () => 'm'), expirationDate: '2027-12-31' };
  const saved = normalizeLifecycle('licenses', rec);
  assert.equal(BOARD_APP_MADE_FIELD in saved.customFields, false, 'marker dropped on the write that brings the date');
  const cleared = normalizeLifecycle('licenses', { ...saved, expirationDate: '' });
  assert.equal(awaitsBoardDate(cleared), false);
  assert.equal(warnsMissingDate(cleared), true);
  // A legacy record given a date loses the app's "does not expire" with it.
  const legacyDated = normalizeLifecycle('licenses', { ...LEGACY, expirationDate: '2027-12-31' });
  assert.equal(legacyDated.noExpiration, false);
  // No date: nothing changes.
  assert.deepEqual(normalizeLifecycle('licenses', newBoardRecord('AOA:AOBS', () => 'm')).customFields, { [BOARD_APP_MADE_FIELD]: 'Added when you marked a board step' });
  // A marked record the physician ticks "does not expire" on is lifetime by their word.
  const ticked = { ...newBoardRecord('AOA:AOBS', () => 'm'), noExpiration: true };
  assert.equal(awaitsBoardDate(ticked), false);
  assert.equal(isNonExpiring(ticked, 'licenses'), true);
});

test('"Not required for me" alone never puts a current board certification on file; a Done mark does', () => {
  const data = { settings: { degreeType: 'MD', specialties: ['ABMS:ABNS'] }, licenses: [], cme: [] };
  const b = boardComplianceFor(data)[0];
  const field = boardTasksFor(data, b, at('2026-05-01')).tasks[0].field;
  const notReq = applyBoardTaskMark(data, b.id, field, notRequiredMark('2026-05-01'), { makeId: () => 'n1' }).create;
  assert.equal(currentBoardCertificationOnFile([notReq], '2026-11-18'), false);
  const done = applyBoardTaskMark(data, b.id, field, '2026-05-01', { makeId: () => 'n2' }).create;
  assert.equal(currentBoardCertificationOnFile([done], '2026-11-18'), true);
  // A legacy record made by a Done mark still counts, as it did.
  const legacyDone = { ...LEGACY, customFields: { [field]: '2026-03-01' } };
  assert.equal(currentBoardCertificationOnFile([legacyDone], '2026-11-18'), true);
  // A record of the physician's own with no date counts, as before.
  assert.equal(currentBoardCertificationOnFile([{ type: 'Board Certification (ABMS)', name: 'ABNS' }], '2026-11-18'), true);
});
