import test from 'node:test';
import assert from 'node:assert/strict';
import { adminReportCsv, adminReportErrorMessage, formatReportTimestamp, normalizeAdminReport, reportCsvCell } from '../../src/utils/adminOperationsReport.js';
import { reportFixture } from './report-fixture.mjs';

test('report accepts all supported dense UTC windows and keeps only aggregate fields', () => {
  for (const days of [7, 30, 90]) {
    const input = reportFixture(days);
    input.accounts.email = 'private@example.invalid';
    input.daily[0].subject = 'Private ticket';
    input.debug_profiles = [{ email: 'private@example.invalid' }];
    const actual = normalizeAdminReport(input, days);
    assert.equal(actual.days, days);
    assert.equal(actual.accounts.total, 1000);
    assert.equal(actual.daily.length, days);
    assert.doesNotMatch(JSON.stringify(actual), /private|debug_profiles|subject|email/);
    assert.equal(actual.daily[0].day, actual.period_start.slice(0, 10));
    assert.equal(actual.daily.at(-1).day, actual.period_end.slice(0, 10));
  }
});

test('unknown, truncated, inconsistent, unsafe and incorrectly scoped reports fail instead of becoming zero', () => {
  const variants = [
    value => delete value.accounts,
    value => delete value.accounts.active,
    value => value.schema_version = 2,
    value => value.days = 7,
    value => value.period_start = '2026-08-25T23:00:00.000Z',
    value => value.period_end = '2026-09-23T12:30:00.000Z',
    value => value.generated_at = 'bad timestamp',
    value => value.support.open = '10',
    value => value.support.urgent = -1,
    value => value.support.waiting_approval = 11,
    value => value.support.oldest_open_at = null,
    value => value.accounts.total = Number.MAX_SAFE_INTEGER + 1,
    value => value.accounts.active = 1001,
    value => value.daily.pop(),
    value => value.daily.reverse(),
    value => value.daily[0].day = value.daily[1].day,
    value => value.daily[0].tickets = NaN,
    value => delete value.daily[0].errors,
    value => value.errors.in_period = 7,
    value => value.accounts.new_in_period = 1,
  ];
  for (const alter of variants) {
    const input = reportFixture(); alter(input);
    assert.throws(() => normalizeAdminReport(input, 30), /incomplete report/, alter.toString());
  }
  for (const value of [null, [], 'html', {}]) assert.throws(() => normalizeAdminReport(value, 30), /incomplete report/);
});

test('an authoritative zero backlog has no oldest ticket; timestamps display explicitly in UTC', () => {
  const input = reportFixture();
  input.support = { open: 0, urgent: 0, waiting_approval: 0, oldest_open_at: null };
  assert.equal(normalizeAdminReport(input, 30).support.open, 0);
  assert.equal(formatReportTimestamp('2026-09-24T05:30:00-07:00'), '2026-09-24 12:30:00 UTC');
});

test('CSV cells quote delimiters and neutralize spreadsheet formula prefixes including hidden whitespace', () => {
  for (const value of ['=SUM(A1)', '+1+1', '-2+3', '@IMPORT', '  =DDE()', '\t=1', '\r\n@formula', '\u0001=1']) {
    assert.ok(reportCsvCell(value).startsWith('"\''), JSON.stringify(value));
  }
  assert.equal(reportCsvCell('A,"quoted"\nline'), '"A,""quoted""\nline"');
  assert.equal(reportCsvCell(1000), '"1000"');
});

test('CSV records exact totals, scope, retention limits, definitions and timestamps without server extra fields', () => {
  const input = reportFixture(7);
  input.customer_email = 'private@example.invalid'; input.daily[0].notes = '=HYPERLINK("private")';
  const csv = adminReportCsv(input, '2026-09-24T13:00:00Z');
  assert.ok(csv.startsWith('\uFEFF"Section","Metric","UTC date","Value","Definition"\r\n'));
  assert.match(csv, /"Snapshot","Account profiles","","1000"/);
  assert.match(csv, /"Window","New signup profiles","","14"/);
  assert.match(csv, /2026-09-24T12:30:00.000Z/);
  assert.match(csv, /2026-09-24T13:00:00.000Z/);
  assert.match(csv, /Window start inclusive/);
  assert.match(csv, /Window end exclusive/);
  assert.match(csv, /pruned after 7 days/);
  assert.match(csv, /partial UTC day/);
  assert.doesNotMatch(csv, /private@example|HYPERLINK|customer_email|notes/);
  assert.equal(csv.split('\r\n').filter(row => row.startsWith('"Daily"')).length, 7 * 4);
  assert.throws(() => adminReportCsv({ ...input, daily: [] }), /incomplete report/);
});

test('missing migration, authorization and network failures have actionable safe messages', () => {
  assert.match(adminReportErrorMessage({ code: 'PGRST202' }), /reporting database update/);
  assert.match(adminReportErrorMessage({ code: '42883' }), /reporting database update/);
  assert.match(adminReportErrorMessage({ code: '42501' }), /administrator access/);
  assert.match(adminReportErrorMessage({ status: 401 }), /Sign in again/);
  assert.match(adminReportErrorMessage({ message: 'SELECT private_table' }), /Check your connection/);
  assert.doesNotMatch(adminReportErrorMessage({ message: 'SELECT private_table' }), /SELECT|private_table/);
});
