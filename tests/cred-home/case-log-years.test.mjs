// Case log year labels come from the physician's own training start, not a
// hard-coded 2018, and Case Logs opens on a year that has cases. Synthetic
// cases only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pgyLabelOf, yearLabel, defaultCaseLogYear, careerSpanLabel, academicYearSpanLabel, yearShowing } from '../../src/utils/caseLogReport.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, 'utf8');

test('with no training start year, an academic year is labelled as itself', () => {
  assert.equal(pgyLabelOf('2019-20'), '2019-20');
  assert.equal(pgyLabelOf('2019-20', ''), '2019-20');
  assert.equal(pgyLabelOf('2019-20', null), '2019-20');
  assert.equal(yearLabel('2019-20'), '2019-20', 'and the report range does not repeat it');
});

test('with a training start year, PGY counts from it', () => {
  assert.equal(pgyLabelOf('2018-19', 2018), 'PGY 1');
  assert.equal(pgyLabelOf('2019-20', 2018), 'PGY 2');
  assert.equal(pgyLabelOf('2019-20', '2019'), 'PGY 1');
  assert.equal(pgyLabelOf('2017-18', 2018), '2017-18', 'a year before training stays plain');
  assert.equal(yearLabel('2019-20', 2018), 'PGY 2 (2019-20)');
  assert.equal(pgyLabelOf('Undated', 2018), 'Undated');
});

test('Case Logs opens on this year only when it has cases', () => {
  const now = new Date(2026, 8, 29, 12);
  assert.equal(defaultCaseLogYear([{ date: '2026-08-01' }, { date: '2021-01-01' }], now), '2026-27');
  assert.equal(defaultCaseLogYear([{ date: '2021-01-01' }, { date: '2023-03-01' }], now), '2022-23', 'imported past years open on the newest');
  assert.equal(defaultCaseLogYear([{ date: '' }], now), 'all', 'only undated cases open on Career');
  assert.equal(defaultCaseLogYear([], now), '2026-27');
});

test('Career\'s date line starts where the cases start', () => {
  assert.equal(careerSpanLabel([{ date: '2021-03-01' }, { date: '2024-09-01' }]), 'Jul 2020 - present');
  assert.equal(careerSpanLabel([]), 'All cases');
  assert.doesNotMatch(read('src/components/features/CaseLogSummary.jsx'), /Jul 2018 - present/);
});

test('the setting is a synced profile column, cleared on account deletion', () => {
  assert.match(read('src/lib/supabase.js'), /trainingStartYear: "training_start_year",/);
  assert.match(read('supabase/functions/delete-account/lib.ts'), /training_start_year: null,/);
  const sql = read('supabase/migrations/20260929221000_profiles_training_start_year.sql');
  assert.match(sql, /alter table public\.profiles add column if not exists training_start_year smallint/i);
  assert.doesNotMatch(sql, /^\s*(begin|commit);/im);
  assert.match(read('docs/rollback/20260929221000_profiles_training_start_year.rollback.sql'), /drop column if exists training_start_year/i);
});

test('the summary, the PDF and App read the setting instead of 2018', () => {
  assert.doesNotMatch(read('src/utils/caseLogReport.js'), /PGY_ANCHOR = 2018/);
  const summary = read('src/components/features/CaseLogSummary.jsx');
  assert.match(summary, /data\.settings\.trainingStartYear/);
  assert.match(read('src/App.jsx'), /defaultCaseLogYear\(data\.caseLogs\)/);
  assert.match(read('src/components/pages/SettingsSection.jsx'), /update\("trainingStartYear"/);
});

test('a link to an undated case lands on a summary that reads "Undated", not "Jul 1 Unda - Jun 30 NaN"', () => {
  const year = yearShowing({ id: 'k1', date: '' }, '2026-27');
  assert.equal(year, 'Undated');
  assert.equal(pgyLabelOf(year, 2018), 'Undated');
  assert.equal(academicYearSpanLabel(year), 'Cases with no date');
  assert.equal(academicYearSpanLabel('2019-20'), 'Jul 1 2019 - Jun 30 2020');
  const summary = read('src/components/features/CaseLogSummary.jsx');
  assert.match(summary, /detail: academicYearSpanLabel\(year\)/);
  assert.doesNotMatch(summary, /Jun 30 \$\{parseInt/);
});
