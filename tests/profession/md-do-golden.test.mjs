// MD and DO output is byte for byte what it was before PA and NP support
// (DESIGN 7.1). The goldens were written at the base commit by
// scripts/capture-profession-golden.mjs, which refuses to run anywhere else.
// The base moved from 230a126d to 5c53366d (main with release goal2) when
// feat/np-pa was merged into release/goal3: goal2's own MD and DO changes
// (link fixes, share text, invoice covers) are the baseline, and PA and NP
// support must leave them unchanged.
// Time is frozen at local noon; computeBoardCompliance dates by UTC, so a
// zone more than 12 hours from UTC (Auckland in summer) moves the board case
// by a day. Run it in a US zone, as CI does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeGolden, BASE_COMMIT } from './golden-cases.mjs';

const golden = JSON.parse(readFileSync(new URL('./golden/md-do.json', import.meta.url), 'utf8'));
const reviewedCopy = JSON.parse(readFileSync(new URL('./golden/qa-ca-view-copy.json', import.meta.url), 'utf8'));
const reviewedReferences = JSON.parse(readFileSync(new URL('./golden/qa-reference-urls.json', import.meta.url), 'utf8'));
const full = JSON.parse(readFileSync(new URL('./golden/md-do-full.json', import.meta.url), 'utf8'));

test('goldens were captured at the base commit', () => {
  assert.equal(golden.base, BASE_COMMIT);
  assert.ok(Object.keys(golden.hashes).length >= 2500, 'the case set is the full one');
});

test('every MD and DO calculation matches its golden; only exact reviewed display copy and reference URLs differ', async () => {
  const { hashes, full: now } = await computeGolden();
  const reviewed = [...reviewedCopy.entries, ...reviewedReferences.entries];
  const allowed = new Map(reviewed.map(entry => [entry.key, entry]));
  assert.equal(allowed.size, reviewed.length, 'reviewed cases cannot silently replace another exception');
  for (const entry of allowed.values()) {
    assert.equal(golden.hashes[entry.key], entry.originalHash, `${entry.key}: the original baseline is retained`);
    assert.equal(hashes[entry.key], entry.reviewedHash, `${entry.key}: only the exact reviewed output is accepted`);
  }
  const changed = Object.keys(golden.hashes).filter(k => hashes[k] !== golden.hashes[k] && !allowed.has(k));
  // Full JSON first, so a failure shows the field that moved.
  for (const k of changed) if (full[k]) assert.deepEqual(now[k], full[k], k);
  assert.deepEqual(changed, [], `MD/DO output changed in ${changed.length} cases`);
});
