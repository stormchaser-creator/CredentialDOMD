// Home, the CME page and the transcript read the same boards: the ones picked
// in Settings plus the ones a Board Certification license record implies.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { effectiveBoardSpecialties, boardComplianceFor } from '../../src/utils/boardCompliance.js';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

test('an ABNS license record with no specialty picked still gives an ABNS card', () => {
  const data = { settings: { degreeType: 'MD', specialties: [] }, licenses: [{ id: 'b', type: 'Board Certification (ABMS)', name: 'ABNS diplomate' }], cme: [] };
  assert.deepEqual(effectiveBoardSpecialties(data), ['ABMS:ABNS']);
  assert.deepEqual(boardComplianceFor(data).map(b => [b.source, b.code]), [['ABMS', 'ABNS']]);
});

test('a DO with an AOBS license and the Neurological Surgery discipline gets one card, not an extra Surgery card', () => {
  const data = { settings: { degreeType: 'DO', specialties: ['AOA-SUB:AOBS:Neurological Surgery'] }, licenses: [{ id: 'b', type: 'Board Certification (AOA)', name: 'AOBS' }], cme: [] };
  const cards = boardComplianceFor(data).filter(b => !b.followsParent);
  assert.deepEqual(cards.map(b => b.name), ['Neurological Surgery']);
});

test('Home, the CME page and the transcript all use the shared list', () => {
  assert.match(read('src/App.jsx'), /const list = boardComplianceFor\(data\);/);
  assert.match(read('src/components/features/CMESection.jsx'), /return boardComplianceFor\(data\);/);
  assert.match(read('src/utils/cmeTranscriptPdf.js'), /const list = boardComplianceFor\(data\)\.filter/);
});
