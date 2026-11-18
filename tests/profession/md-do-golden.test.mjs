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
// Ticket 53890221: a deliberate rule fix, reviewed case by case (PA only).
const reviewedPaPainTags = JSON.parse(readFileSync(new URL('./golden/ticket-53890221-pa-pain-tags.json', import.meta.url), 'utf8'));
// CME shortfall audit: CO and ND first cycles, MATE shown once (reviewed case by case).
const reviewedCmeAudit = JSON.parse(readFileSync(new URL('./golden/cme-audit-first-cycle-mate.json', import.meta.url), 'utf8'));
// Board certification tasks raise alerts; no AOA national entry for a DO (reviewed case by case).
const reviewedBoardTasks = JSON.parse(readFileSync(new URL('./golden/board-tasks-1118.json', import.meta.url), 'utf8'));
// WA DO rule text names MOC participation (WAC 246-853-080(2)(b)); text only (reviewed case by case).
const reviewedWaDoExemption = JSON.parse(readFileSync(new URL('./golden/board-exemption-wa-do-1118.json', import.meta.url), 'utf8'));
// TX rule source also names Tex. Occ. Code 156.052 and the TMB CME hours chart; source text only (reviewed case by case).
const reviewedTxExemptionSource = JSON.parse(readFileSync(new URL('./golden/board-exemption-tx-source-1118.json', import.meta.url), 'utf8'));
const full = JSON.parse(readFileSync(new URL('./golden/md-do-full.json', import.meta.url), 'utf8'));

test('goldens were captured at the base commit', () => {
  assert.equal(golden.base, BASE_COMMIT);
  assert.ok(Object.keys(golden.hashes).length >= 2500, 'the case set is the full one');
});

test('every MD and DO calculation matches its golden; only exact reviewed display copy, reference URLs and rule fixes differ', async () => {
  const { hashes, full: now } = await computeGolden();
  const reviewed = [...reviewedCopy.entries, ...reviewedReferences.entries, ...reviewedPaPainTags.entries, ...reviewedCmeAudit.entries, ...reviewedBoardTasks.entries, ...reviewedWaDoExemption.entries, ...reviewedTxExemptionSource.entries];
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
