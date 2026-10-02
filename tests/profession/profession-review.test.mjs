// The profession mismatch review (DESIGN 1.8): records filed under the other
// profession's types are listed with the types they can become; "Keep as is"
// stops the question. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { professionMismatches, keepAsIsPatch } from '../../src/utils/professionReview.js';

const d = (degreeType, over) => ({ settings: { degreeType }, licenses: [], cme: [], education: [], ...over });

test('a PA with a licence filed as medical, a physician board and MD CME categories', () => {
  const data = d('PA', {
    licenses: [
      { id: 'l1', type: 'State Medical License', state: 'TX' },
      { id: 'l2', type: 'Board Certification (ABMS)', name: 'ABEM' },
      { id: 'l3', type: 'State Physician Assistant License', state: 'TX' },
      { id: 'l4', type: 'State Medical License', state: 'CO', lifecycleStatus: 'historical' },
    ],
    cme: [{ id: 'c1', category: 'AMA PRA Category 2' }, { id: 'c2', category: 'AAPA Category 1 CME' }, { id: 'c3', category: 'Self-Assessment' }],
    education: [{ id: 'e1', type: 'Doctor of Medicine (MD)' }, { id: 'e2', type: 'Master of Physician Assistant Studies (MPAS)' }],
  });
  const list = professionMismatches(data);
  assert.deepEqual(list.map(x => `${x.section}:${x.id}`), ['licenses:l1', 'licenses:l2', 'education:e1', 'cme:c1', 'cme:c3']);
  assert.deepEqual(list[0].options, ['State Physician Assistant License']);
  assert.ok(list.find(x => x.id === 'c1').options.includes('Category 2 CME'));
});

test('an NP can retype a medical licence as APRN or RN; "Keep as is" stops the question', () => {
  const lic = { id: 'l1', type: 'State Medical License', state: 'CA' };
  const [one] = professionMismatches(d('NP', { licenses: [lic] }));
  assert.deepEqual(one.options, ['APRN License (NP)', 'RN License', 'RN License (Multistate)']);
  assert.deepEqual(professionMismatches(d('NP', { licenses: [{ ...lic, customFields: keepAsIsPatch(lic) }] })), []);
});

test('an MD with PA or NP types is asked; MD CME categories never are; blank and an MD with only medical records see nothing', () => {
  const list = professionMismatches(d('MD', { licenses: [{ id: 'r', type: 'RN License', state: 'TX' }, { id: 'n', type: 'Board Certification (NCCPA)' }, { id: 'm', type: 'State Medical License' }], cme: [{ id: 'c', category: 'AAPA Category 1 CME' }] }));
  assert.deepEqual(list.map(x => x.id), ['r', 'n']);
  assert.deepEqual(professionMismatches(d('', { licenses: [{ id: 'r', type: 'RN License' }] })), []);
  assert.deepEqual(professionMismatches(d('DO', { licenses: [{ id: 'm', type: 'State Medical License (DO)' }], cme: [{ id: 'c', category: 'AOA Category 1-A' }] })), []);
});
