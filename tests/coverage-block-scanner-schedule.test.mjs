import test from 'node:test';
import assert from 'node:assert/strict';
import { coversDate as scheduled, checkPlacement } from '../src/utils/scheduleGuard.js';
import { coversDate, contractsForDate, contractEndDate, specificity, agencyForDate, termCovers } from '../src/utils/contractsForDate.js';
import { AGREEMENT_PROMPT } from '../src/utils/agreementPrompt.js';
import { SYSTEM_PROMPT } from '../src/utils/scannerCore.js';
import { normalizeAgreementFields, withAgreementFields } from '../src/utils/docPrefill.js';
import { coverageBlocksFromText, withStatedTimes } from '../src/utils/coverageText.js';

// Coverage blocks with times outside billing: which contract is in force on
// a date (the pickers and the schedule guard), and the agreement scanner that
// reads the times off the agreement. Synthetic agreements and contracts only.

const TIMED = { id: 'c-timed', facility: 'Synthetic Regional Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 3000,
  coveragePeriods: [{ start: '2026-09-25', startTime: '16:00', end: '2026-09-28', endTime: '07:00' }], startDate: '2026-09-25', endDate: '2026-09-28' };
const UNTIMED = { ...TIMED, id: 'c-untimed', coveragePeriods: [{ start: '2026-09-25', end: '2026-09-27' }], endDate: '2026-09-27' };
const OTHER = { id: 'c-other', facility: 'Synthetic Valley Clinic', agency: 'Other Synthetic Locums', payModel: 'stipend', callStipend: 2000,
  coveragePeriods: [{ start: '2026-09-28', end: '2026-10-02' }] };

// ── Which contract is in force ───────────────────────────────────

test('a timed block is in force on every date it touches, the sign-out morning included', () => {
  assert.deepEqual(['2026-09-24', '2026-09-25', '2026-09-27', '2026-09-28', '2026-09-29'].map(d => scheduled(TIMED, d)), [false, true, true, true, false]);
  assert.deepEqual(['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29'].map(d => coversDate(TIMED, d)), [false, true, true, false]);
  assert.equal(specificity(TIMED, '2026-09-28'), 0);
  // Logging the sign-out on Sep 28 against this contract raises no question
  // about the schedule, only that another agreement also starts that day.
  assert.equal(checkPlacement([TIMED], TIMED, '2026-09-28'), null);
  assert.equal(checkPlacement([TIMED, OTHER], TIMED, '2026-09-28').level, 'conflict');
  assert.equal(checkPlacement([TIMED], TIMED, '2026-09-29').level, 'unscheduled');
});

test('a block ending at midnight is not in force on the day it ends', () => {
  const midnight = { ...TIMED, coveragePeriods: [{ start: '2026-09-25', startTime: '16:00', end: '2026-09-28', endTime: '00:00' }], endDate: '' };
  assert.equal(scheduled(midnight, '2026-09-28'), false);
  assert.equal(coversDate(midnight, '2026-09-28'), false);
  assert.equal(contractEndDate(midnight), '2026-09-27');
  assert.equal(termCovers(midnight, '2026-09-27'), true);
});

test('a block without times reads exactly as before', () => {
  assert.deepEqual(['2026-09-24', '2026-09-25', '2026-09-27', '2026-09-28'].map(d => scheduled(UNTIMED, d)), [false, true, true, false]);
  assert.deepEqual(['2026-09-25', '2026-09-27', '2026-09-28'].map(d => coversDate(UNTIMED, d)), [true, true, false]);
  assert.equal(contractEndDate({ ...UNTIMED, endDate: '' }), '2026-09-27');
  // An open-ended block (no end) still covers every later date in the picker.
  assert.equal(coversDate({ coveragePeriods: [{ start: '2026-09-25' }] }, '2027-01-01'), true);
});

test('on the sign-out morning the pickers offer the timed booking as in force beside the next one, and the travel day counts from that morning', () => {
  assert.deepEqual(contractsForDate([OTHER, TIMED], '2026-09-28').covering.map(c => c.id), ['c-other', 'c-timed']);
  const today = '2026-09-20';
  assert.equal(agencyForDate([TIMED], '2026-09-30', { today }), 'Synthetic Staffing', 'two days after the sign-out morning is a travel day');
  assert.equal(agencyForDate([TIMED], '2026-10-01', { today }), '');
});

// ── Reading the times off the agreement ──────────────────────────

const AGREEMENT = `SYNTHETIC LOCUM TENENS CONFIRMATION
Physician: Synthetic Physician, DO. Facility: Synthetic Regional Hospital.
Coverage: September 25, 2026 (4pm) to September 28, 2026 (7am).
Second assignment: November 5, 2026 (6am) to November 12, 2026 (6am).
Compensation: $3,000 per 24-hour call including the first four hours worked; $300 per hour thereafter,
billed in 15-minute increments. Signed September 1, 2026.`;

test('the agreement prompt asks for each block\'s times in 24-hour HH:MM, with the end date as written', () => {
  assert.match(AGREEMENT_PROMPT, /add startTime and endTime as 24-hour\s+"HH:MM" strings, and keep end as the date written \(not the day before\)/);
  assert.match(AGREEMENT_PROMPT, /"start": "2026-09-25", "startTime": "16:00",\s+"end": "2026-09-28", "endTime": "07:00"/);
  assert.match(AGREEMENT_PROMPT, /"start": "2026-11-05", "startTime": "06:00", "end": "2026-11-12", "endTime": "06:00"/);
  assert.match(AGREEMENT_PROMPT, /Omit startTime and endTime when the agreement states no time for that block; never guess one/);
  // The shared scanner (Documents and the docs@ inbox) asks the same.
  const shared = SYSTEM_PROMPT('DO', []);
  assert.match(shared, /add "startTime" and "endTime" as 24-hour "HH:MM" and keep "end" as the date written/);
  assert.match(shared, /\{"start":"2026-09-25","startTime":"16:00","end":"2026-09-28","endTime":"07:00"\}/);
});

test('the scanner\'s blocks come back with their times as HH:MM, and a block without times keeps its old shape', () => {
  const out = normalizeAgreementFields({ coveragePeriods: [
    { start: '2026-09-25', end: '2026-09-28', startTime: '4pm', endTime: '7am' },
    { start: '2026-11-05', end: '2026-11-12', startTime: '06:00', endTime: '6:00 AM' },
    { start: '2026-12-01', end: '2026-12-03' },
    { start: '2026-12-10', end: '2026-12-12', startTime: 'evening', endTime: '' },
    { end: '2027-01-09', endTime: '07:00' },
  ] });
  assert.deepEqual(out.coveragePeriods, [
    { start: '2026-09-25', end: '2026-09-28', startTime: '16:00', endTime: '07:00' },
    { start: '2026-11-05', end: '2026-11-12', startTime: '06:00', endTime: '06:00' },
    { start: '2026-12-01', end: '2026-12-03' },
    { start: '2026-12-10', end: '2026-12-12' },
    { start: '2027-01-09', end: '2027-01-09' },
  ]);
});

test('synthetic agreement text: every block it states with times is read, in 24-hour time', () => {
  assert.deepEqual(coverageBlocksFromText(AGREEMENT), [
    { start: '2026-09-25', end: '2026-09-28', startTime: '16:00', endTime: '07:00' },
    { start: '2026-11-05', end: '2026-11-12', startTime: '06:00', endTime: '06:00' },
  ]);
  const formats = [
    ['Nov 20, 2026 at 6:00 AM through Nov 22, 2026 at 6:00 AM', { start: '2026-11-20', end: '2026-11-22', startTime: '06:00', endTime: '06:00' }],
    ['12/1/2026 4pm - 12/3/2026 7am', { start: '2026-12-01', end: '2026-12-03', startTime: '16:00', endTime: '07:00' }],
    ['2026-12-10 16:00 to 2026-12-12 07:00', { start: '2026-12-10', end: '2026-12-12', startTime: '16:00', endTime: '07:00' }],
    ['beginning 7 a.m. on February 1, 2027 and ending February 3, 2027 at noon', { start: '2027-02-01', end: '2027-02-03', startTime: '07:00', endTime: '12:00' }],
    ['Sept. 25th, 2026 (4 PM) \u{2013} Sept. 28th, 2026 (7 AM)', { start: '2026-09-25', end: '2026-09-28', startTime: '16:00', endTime: '07:00' }],
    ['January 5, 2027 to January 9, 2027', { start: '2027-01-05', end: '2027-01-09' }],
  ];
  for (const [text, want] of formats) assert.deepEqual(coverageBlocksFromText(text), [want], text);
  // Dates that are not a range, and numbers that are not times, are left alone.
  assert.deepEqual(coverageBlocksFromText('Signed September 1, 2026. Effective September 3, 2026 for 4 physicians.'), []);
});

test('a time the model left out is filled from the agreement text, with the end date as written', () => {
  // The model dropped the times and "helpfully" returned the last call day.
  const result = withAgreementFields({ confidence: 'high', extracted: { callStipend: '$3,000', coveragePeriods: [{ start: '2026-09-25', end: '2026-09-27' }, { start: '2026-11-05', end: '2026-11-12' }] } }, { text: AGREEMENT });
  assert.deepEqual(result.extracted.coveragePeriods, [
    { start: '2026-09-25', end: '2026-09-28', startTime: '16:00', endTime: '07:00' },
    { start: '2026-11-05', end: '2026-11-12', startTime: '06:00', endTime: '06:00' },
  ]);
  assert.equal(result.extracted.callStipend, 3000);
  // What the model already read with times stands.
  const kept = withStatedTimes([{ start: '2026-09-25', end: '2026-09-28', startTime: '17:00', endTime: '07:00' }], AGREEMENT);
  assert.equal(kept[0].startTime, '17:00');
  // No periods from the model: the text's timed blocks are used.
  assert.equal(normalizeAgreementFields({}, { text: AGREEMENT }).coveragePeriods.length, 2);
  // Without text (a PDF or photo) nothing is added.
  assert.deepEqual(withAgreementFields({ extracted: { coveragePeriods: [{ start: '2026-09-25', end: '2026-09-27' }] } }).extracted.coveragePeriods, [{ start: '2026-09-25', end: '2026-09-27' }]);
  // Text that states no times changes nothing.
  assert.deepEqual(normalizeAgreementFields({ coveragePeriods: [{ start: '2027-01-05', end: '2027-01-09' }] }, { text: 'January 5, 2027 to January 9, 2027' }).coveragePeriods, [{ start: '2027-01-05', end: '2027-01-09' }]);
});
