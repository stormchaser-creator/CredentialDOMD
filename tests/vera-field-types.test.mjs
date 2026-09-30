// VERA-004: a value Vera proposes must fit its column, or it is kept as a
// detail. "2027-03" in a date column or "1.5 hrs" in a numeric one used to
// show the card done while the cloud refused the whole record on every replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitFields, fieldValueFits, isValidIsoDate } from '../src/utils/sectionFields.js';

test('VERA-004: a month-only, worded or impossible date becomes a detail, not a date column value', () => {
  for (const bad of ['2027-03', 'March 2026', '2026-02-30']) {
    const { clean, extra } = splitFields('licenses', { type: 'Medical License', expirationDate: bad });
    assert.equal('expirationDate' in clean, false, bad);
    assert.equal(extra['Expiration Date'], bad, 'kept, not lost');
    assert.equal(clean.type, 'Medical License', 'the rest of the record is unaffected');
  }
  assert.equal(splitFields('licenses', { expirationDate: '2027-03-31' }).clean.expirationDate, '2027-03-31');
  assert.equal(isValidIsoDate('2028-02-29'), true);
});

test('VERA-004: a number with words goes to details; money and plain numbers fit', () => {
  let r = splitFields('cme', { title: 'Synthetic', hours: '1.5 hrs' });
  assert.equal('hours' in r.clean, false);
  assert.equal(r.extra.Hours, '1.5 hrs');
  assert.equal(splitFields('cme', { hours: '1.5' }).clean.hours, 1.5);
  assert.equal(splitFields('cme', { hours: 2 }).clean.hours, 2);
  assert.equal(splitFields('locumContracts', { dayRate: '$2,500' }).clean.dayRate, 2500);
  assert.equal(fieldValueFits('publications', 'sortOrder', '1.5'), undefined, 'an integer column takes whole numbers only');
  assert.equal(fieldValueFits('publications', 'sortOrder', '3'), 3);
  assert.equal(fieldValueFits('locumContracts', 'termStart', 'next spring'), undefined);
});

test('VERA-004: Vera\'s card uses the checked split', () => {
  const assistant = readFileSync(fileURLToPath(new URL('../src/utils/assistant.js', import.meta.url)), 'utf8');
  assert.match(assistant, /import \{ SECTION_FIELDS, splitFields \} from "\.\/sectionFields\.js";/);
  assert.doesNotMatch(assistant, /export function splitFields/);
});
