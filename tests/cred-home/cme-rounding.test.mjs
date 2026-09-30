// CME hour sums are rounded to hundredths where they are made, so no total
// reads 0.30000000000000004 and no requirement is missed by a float error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeCompliance, round2 } from '../../src/utils/compliance.js';
import { computeBoardCompliance } from '../../src/utils/boardCompliance.js';

const day = (n) => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('0.1 + 0.2 hours reads 0.3', () => {
  const c = computeCompliance([
    { id: 'a', date: day(10), hours: '0.1', category: 'AMA PRA Category 1' },
    { id: 'b', date: day(11), hours: '0.2', category: 'AMA PRA Category 1' },
  ], 'TX', 'MD');
  assert.equal(c.totalEarned, 0.3);
  assert.equal(c.cat1Earned, 0.3);
  assert.equal(round2(1.1 + 2.2), 3.3);
});

test('0.7 + 0.2 + 0.1 of a one-hour topic meets it', () => {
  const tag = (id, h) => ({ id, date: day(5), hours: h, category: 'AMA PRA Category 1', topics: ['Human Trafficking'] });
  const c = computeCompliance([tag('a', '0.7'), tag('b', '0.2'), tag('c', '0.1')], 'TX', 'MD');
  const t = c.topicResults.find(x => x.topic === 'Human Trafficking');
  assert.equal(t.earned, 1);
  assert.equal(t.met, true);
});

test('board totals and the CME page total are rounded too', () => {
  const boards = computeBoardCompliance({ settings: { specialties: ['ABMS:ABNS'] }, cme: [
    { id: 'a', date: day(1), hours: '0.1', category: 'AMA PRA Category 1' },
    { id: 'b', date: day(2), hours: '0.2', category: 'AMA PRA Category 1' },
  ] });
  assert.equal(boards[0].earned, 0.3);
  const src = readFileSync(fileURLToPath(new URL('../../src/components/features/CMESection.jsx', import.meta.url)), 'utf8');
  assert.match(src, /const totalHours = useMemo\(\(\) => round2\(/);
});
