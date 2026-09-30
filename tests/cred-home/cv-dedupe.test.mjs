// A second program or position at an institution already on file can be
// imported from a CV; the same row twice still cannot. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markAlreadyOnFile, isSelectable, dedupeKey } from '../../src/utils/publicRecord.js';

const CENTER = 'Synthetic Medical Center';
const onFile = {
  education: [{ id: 'e1', type: 'Residency Certificate', institution: CENTER }],
  workHistory: [{ id: 'w1', position: 'Resident', employer: CENTER }],
};
const finding = (section, fields, id) => ({ id, section, fields, label: id });

test('a fellowship at the residency\'s center is not "already on file"', () => {
  const [f] = markAlreadyOnFile([finding('education', { type: 'Fellowship Certificate', institution: CENTER }, 'fel')], onFile);
  assert.equal(f.alreadyOnFile, false);
  assert.equal(f.sameOrgOnFile, true, 'it says there is another entry there');
  assert.equal(isSelectable(f), true);
});

test('a faculty post at the employer of a residency on file can be ticked', () => {
  const [f] = markAlreadyOnFile([finding('workHistory', { position: 'Assistant Professor', employer: CENTER }, 'fac')], onFile);
  assert.equal(f.alreadyOnFile, false);
  assert.equal(f.sameOrgOnFile, true);
  assert.equal(isSelectable(f), true);
});

test('the same row re-imported is still already on file', () => {
  const marked = markAlreadyOnFile([
    finding('education', { type: 'Residency Certificate', institution: CENTER.toUpperCase() }, 'res'),
    finding('workHistory', { position: 'resident', employer: CENTER }, 'job'),
  ], onFile);
  assert.deepEqual(marked.map(f => f.alreadyOnFile), [true, true]);
});

test('a Medicare employer lead with no title still matches a job on file there', () => {
  const [f] = markAlreadyOnFile([finding('workHistory', { employer: CENTER }, 'cms')], onFile);
  assert.equal(f.alreadyOnFile, true);
});

test('two findings at one center are told apart by type or position', () => {
  assert.notEqual(dedupeKey('education', { type: 'Residency Certificate', institution: CENTER }), dedupeKey('education', { type: 'Fellowship Certificate', institution: CENTER }));
  assert.notEqual(dedupeKey('workHistory', { position: 'Resident', employer: CENTER }), dedupeKey('workHistory', { position: 'Assistant Professor', employer: CENTER }));
});
