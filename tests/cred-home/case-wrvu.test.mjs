// A case's wRVU on its card and in the totals matches what its detail view
// bills, for a case entered by hand and after an edit. Synthetic cases only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { caseWRVU } from '../../src/utils/caseLogReport.js';
import { prepareRecord } from '../../src/utils/recordWrite.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('a case entered with 61519 and no stored wRVU counts 42.34, not 0', () => {
  assert.equal(caseWRVU({ id: 'c1', cptCodes: '61519' }), 42.34);
  assert.equal(caseWRVU({ id: 'c2', cptCodes: '61519, 69990' }), 45.71);
  assert.equal(caseWRVU({ id: 'c3', cptCodes: '' }), 0);
  assert.equal(caseWRVU({ id: 'c4', cptCodes: '61519', wRvu: 40 }), 40, 'a stored value still wins');
});

test('a new case is saved with its catalog wRVU', () => {
  assert.equal(prepareRecord('caseLogs', { id: 'c1', cptCodes: '61519' }).wRvu, 42.34);
  assert.ok(!('wRvu' in prepareRecord('caseLogs', { id: 'c2', title: 'No codes yet' })), 'no codes, no number');
});

const imported = () => ({
  id: 'imp', cptCodes: '61519, 69990', wRvu: 50.1,
  customFields: { cptDetail: [{ code: '61519', units: 1, wRVU: 46.73 }, { code: '69990', units: 1, wRVU: 3.37 }], componentAudit: { note: 'synthetic' }, 'Imported from': 'Synthetic log' },
});

test('an edit that removes a code drops the old billing detail and recomputes the total', () => {
  const previous = imported();
  const next = prepareRecord('caseLogs', { ...previous, cptCodes: '61519' }, '', previous);
  assert.equal(next.wRvu, 42.34);
  assert.ok(!('cptDetail' in next.customFields), 'the removed code is no longer listed as billed');
  assert.ok(!('componentAudit' in next.customFields));
  assert.equal(next.customFields['Imported from'], 'Synthetic log', 'the rest of customFields stays');
  assert.equal(caseWRVU(next), 42.34);
});

test('an edit that leaves the codes alone keeps the imported numbers', () => {
  const previous = imported();
  const next = prepareRecord('caseLogs', { ...previous, notes: 'edited', cptCodes: '69990,61519' }, '', previous);
  assert.equal(next.wRvu, 50.1);
  assert.equal(next.customFields.cptDetail.length, 2);
});

test('the detail view reads the same billed lines', () => {
  const src = readFileSync(`${root}src/components/features/CrudSection.jsx`, 'utf8');
  assert.match(src, /import \{ billedCodes \} from "..\/..\/utils\/caseBilling(\.js)?";/);
  assert.doesNotMatch(src, /^function billedCodes/m);
});
