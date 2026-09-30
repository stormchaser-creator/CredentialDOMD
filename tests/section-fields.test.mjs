// Vera's writes land in the real columns (VERA-004).
//
// splitFields keeps a proposed field only when SECTION_FIELDS lists it, and
// sends everything else to custom_fields. Memberships listed neither cost
// (the form's Annual Dues) nor expirationDate (Renewal Due), and work history
// did not list reasonForLeaving, so "set my AANS dues to $310, renewing
// 2027-01-31" became two custom fields while the columns the form, the CV and
// the dues deduction read stayed as they were. Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTION_FIELDS, FIELD_TYPES, splitFields } from '../src/utils/sectionFields.js';

// information_schema on production, read 2026-09-29 (SELECT only).
const PRODUCTION = {
  memberships: ['id', 'user_id', 'name', 'organization', 'role', 'start_date', 'end_date', 'notes', 'custom_fields', 'created_at', 'updated_at', 'cost', 'expiration_date', 'favorite'],
  workHistory: ['id', 'user_id', 'type', 'position', 'employer', 'city', 'state', 'start_date', 'end_date', 'is_current', 'description', 'reason_for_leaving', 'notes', 'created_at', 'updated_at', 'current', 'custom_fields', 'favorite'],
};
const snake = k => k.replace(/[A-Z]/g, m => '_' + m.toLowerCase());

test('membership dues and renewal date go to their columns, not custom fields', () => {
  const { clean, extra } = splitFields('memberships', { organization: 'Synthetic Society', cost: 310, expirationDate: '2027-01-31' });
  assert.deepEqual(clean, { organization: 'Synthetic Society', cost: 310, expirationDate: '2027-01-31' });
  assert.equal(extra, null);
});

test('work history reason for leaving goes to its column', () => {
  const { clean, extra } = splitFields('workHistory', { employer: 'Synthetic Health', reasonForLeaving: 'relocation' });
  assert.equal(clean.reasonForLeaving, 'relocation');
  assert.equal(extra, null);
});

test('a key no column holds still goes to custom fields', () => {
  const { clean, extra } = splitFields('memberships', { organization: 'Synthetic Society', duesPortal: 'x' });
  assert.deepEqual(clean, { organization: 'Synthetic Society' });
  assert.deepEqual(extra, { 'Dues Portal': 'x' });
});

test('every membership and work-history field Vera may write is a real column', () => {
  for (const [section, cols] of Object.entries(PRODUCTION)) {
    const have = new Set(cols);
    const missing = SECTION_FIELDS[section].filter(k => !have.has(snake(k)));
    assert.deepEqual(missing, [], section);
  }
  for (const k of ['name', 'cost', 'expirationDate']) assert.ok(SECTION_FIELDS.memberships.includes(k), k);
  assert.ok(SECTION_FIELDS.workHistory.includes('reasonForLeaving'));
});

// A value its column cannot read rejects the whole row, and a rejected insert
// is queued and fails again on every replay: "add my AANS membership, dues
// $310 a year, renews Jan 2027" never reached the cloud, and Sign out warned
// about unsynced changes forever. Money reads the way people write it; a value
// no column can hold is kept, as written, in custom fields.
test('dues written as money land in the numeric column as a number', () => {
  for (const [said, stored] of [['$310', 310], ['$1,310.50', 1310.5], [' 310 ', 310], ['310', 310]]) {
    const { clean, extra } = splitFields('memberships', { organization: 'Synthetic Society', cost: said });
    assert.equal(clean.cost, stored, said);
    assert.equal(extra, null, said);
  }
});

test('dues or a date no column can read go to custom fields, not the column', () => {
  const { clean, extra } = splitFields('memberships', {
    organization: 'Synthetic Society', cost: '310/yr', expirationDate: '2027-01', startDate: 'Jan 2020', endDate: '2026-02-30',
  });
  assert.deepEqual(clean, { organization: 'Synthetic Society' });
  assert.deepEqual(extra, { 'Cost': '310/yr', 'Expiration Date': '2027-01', 'Start Date': 'Jan 2020', 'End Date': '2026-02-30' });
});

test('a real date stays in its column', () => {
  const { clean, extra } = splitFields('memberships', { organization: 'Synthetic Society', expirationDate: '2027-01-31', startDate: '2020-01-01' });
  assert.equal(clean.expirationDate, '2027-01-31');
  assert.equal(clean.startDate, '2020-01-01');
  assert.equal(extra, null);
});

test('the same rule holds in every section: CME hours, a licence date, a contract rate', () => {
  assert.equal(splitFields('cme', { title: 'Synthetic course', hours: '1.5' }).clean.hours, 1.5);
  assert.deepEqual(splitFields('cme', { title: 'Synthetic course', hours: '1.5 hours' }).extra, { Hours: '1.5 hours' });
  assert.deepEqual(splitFields('licenses', { state: 'ZZ', expirationDate: '12/2027' }).extra, { 'Expiration Date': '12/2027' });
  assert.equal(splitFields('locumContracts', { facility: 'Synthetic Hospital', dayRate: '$2,500' }).clean.dayRate, 2500);
  assert.deepEqual(splitFields('locumContracts', { facility: 'Synthetic Hospital', minCallMinutes: '7.5' }).extra, { 'Min Call Minutes': '7.5' });
  assert.equal(splitFields('workHistory', { employer: 'Synthetic Health', current: 'yes' }).clean.current, true);
  assert.deepEqual(splitFields('workHistory', { employer: 'Synthetic Health', current: 'present' }).extra, { Current: 'present' });
});

// information_schema on production, read 2026-09-29 (SELECT only): every
// column of these tables that is not text, uuid, jsonb, an array or a
// timestamp. Each one Vera may write must be typed in FIELD_TYPES.
const PRODUCTION_TYPED = {
  cme: { date: 'date', hours: 'numeric' },
  education: { graduation_date: 'date', start_date: 'date' },
  healthRecords: { collected_date: 'date', date_administered: 'date', expiration_date: 'date', reported_date: 'date' },
  insurance: { date_unknown: 'boolean', effective_date: 'date', expiration_date: 'date' },
  licenses: { cme_cycle_start: 'date', date_unknown: 'boolean', expiration_date: 'date', issued_date: 'date', no_expiration: 'boolean', npi_imported: 'boolean', renewal_cost: 'numeric' },
  locumContracts: { call_hourly_rate: 'numeric', call_stipend: 'numeric', clinical_day_rate: 'numeric', day_rate: 'numeric', day_start_hour: 'integer', hourly_rate: 'numeric', increment_minutes: 'integer', min_call_minutes: 'integer', orientation_billed: 'boolean', orientation_fee: 'numeric', orientation_hourly_rate: 'numeric', overage_hourly_rate: 'numeric', scholarly_rate: 'numeric', split_at_day_start: 'boolean', stipend_hours: 'numeric', term_end: 'date', term_start: 'date' },
  privileges: { appointment_date: 'date', date_unknown: 'boolean', expiration_date: 'date' },
  memberships: { cost: 'numeric', end_date: 'date', expiration_date: 'date', start_date: 'date' },
  professionalPhotos: { date_taken: 'date' },
  publications: { sort_order: 'integer' },
  screenings: { expiration_date: 'date', order_date: 'date', report_date: 'date' },
  workHistory: { current: 'boolean', end_date: 'date', is_current: 'boolean', start_date: 'date' },
};

test('FIELD_TYPES types every non-text column Vera may write, as production does', () => {
  for (const [section, keys] of Object.entries(SECTION_FIELDS)) {
    const typed = PRODUCTION_TYPED[section] || {};
    for (const k of keys) {
      assert.equal(FIELD_TYPES[section]?.[k], typed[snake(k)], `${section}.${k}`);
    }
    for (const k of Object.keys(FIELD_TYPES[section] || {})) assert.ok(keys.includes(k), `${section}.${k} is not a field Vera writes`);
  }
});
