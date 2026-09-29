// G4 with the model stubbed: citations checked against head, the pass rule,
// two reviews for risky diffs, and what the reviewer is (not) shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDiff, reviewVerdict, verifyCitations, reviewInput, isRisky, validateReview, reviseInput, REVIEW_SCHEMA } from '../../scripts/ticket-fix/review.mjs';
import { createWorktree, commitWork } from '../../scripts/ticket-fix/worktree.mjs';
import { project, context, COMMITTER, RUN_ID, TICKET } from './stage2-helpers.mjs';

const FIXED = "// Synthetic module for the gate tests.\nexport const title = 'Synthetic summary line';\n\nexport function joinLines(lines) {\n  return lines.join('\\n');\n}\n";
const good = (changes = {}) => ({
  items: [{ requirement: 'Summary lines are separated by line breaks', verdict: 'met', citations: [{ file: 'src/format.js', line: 5, snippet: "return lines.join('\\n');" }] }],
  regressions: [], missed_paths: [], test_changes: [], sibling_exclusions: [], verdict: 'approve', summary: 'Synthetic review.', ...changes });
const gates = (extra = {}) => ({ pass: true, diff: { files: ['src/format.js'], test_changes: [] }, persistence: { triggered: false }, ...extra });

async function fixed() {
  const p = project();
  const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
  p.write(wt.dir, { 'src/format.js': FIXED });
  const head = commitWork({ dir: wt.dir, base: wt.base, subject: 'Join lines', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
  return { p, wt, head };
}
const stub = outputs => {
  const inputs = [];
  return { inputs, launch: async (input, meta) => { inputs.push({ input, meta }); const next = outputs.shift(); return next === undefined ? { ok: false, reason: 'no more stub output' } : { ok: true, output: { structured_output: next } }; } };
};

test('the schema is strict and the stubbed approve passes', async () => {
  assert.equal(REVIEW_SCHEMA.properties.verdict.enum.join(), 'approve,revise,block');
  assert.throws(() => validateReview({ ...good(), extra: 1 }), /Invalid review object/);
  assert.throws(() => validateReview(good({ verdict: 'maybe' })), /enum/);
  const { p, wt, head } = await fixed();
  try {
    const s = stub([good()]);
    const result = await reviewDiff({ dir: wt.dir, base: wt.base, head, context: context(), gates: gates(), protectedReport: { protected: false, hits: [] }, blast: { terms: [], sibling_groups: [] }, launch: s.launch, prompt: 'Review.' });
    assert.equal(result.pass, true, JSON.stringify(result.reasons));
    assert.equal(result.count, 1);
  } finally { p.cleanup(); }
});

test('an invented citation gets one fresh rerun; invented twice fails', async () => {
  const { p, wt, head } = await fixed();
  const invented = good({ items: [{ requirement: 'x', verdict: 'met', citations: [{ file: 'src/format.js', line: 5, snippet: 'return lines.join("<br>") // not in the file' }] }] });
  const args = { dir: wt.dir, base: wt.base, head, context: context(), gates: gates(), protectedReport: {}, blast: { terms: [], sibling_groups: [] }, prompt: 'Review.' };
  try {
    const once = stub([invented, good()]);
    const recovered = await reviewDiff({ ...args, launch: once.launch });
    assert.equal(recovered.pass, true);
    assert.equal(recovered.reviews[0].attempts, 2);
    const twice = stub([invented, invented]);
    const refused = await reviewDiff({ ...args, launch: twice.launch });
    assert.equal(refused.pass, false);
    assert.match(refused.reasons.join(), /citation\(s\) not found at head/);
    assert.equal(refused.revise, false, 'an unverifiable review never sends the worker round again');
    // Wrong line (more than 2 away), missing file, too-short snippet.
    const read = file => (file === 'src/format.js' ? FIXED : (() => { throw Error('missing'); })());
    const bad = verifyCitations(good({ regressions: [{ file: 'src/format.js', line: 1, snippet: "return lines.join('\\n');", scenario: 's', severity: 'low' }],
      missed_paths: [{ file: 'src/none.js', line: 1, snippet: 'something long enough', why: 'w' }, { file: 'src/format.js', line: 6, snippet: '}', why: 'w' }] }), read);
    assert.deepEqual(bad.map(b => b.why), ['snippet not within 2 lines of the cited line', 'no such file', 'snippet too short to locate']);
  } finally { p.cleanup(); }
});

test('the pass rule: approve with a not_met item, a high regression, an unjustified test change, an unreviewed test change or an unexcluded sibling fails', () => {
  assert.equal(reviewVerdict(good()).pass, true);
  const cases = [
    [good({ items: [{ requirement: 'a', verdict: 'not_met', citations: [] }] }), /not met/],
    [good({ regressions: [{ file: 'f', line: 1, snippet: 's', scenario: 'x', severity: 'high' }] }), /high-severity/],
    [good({ test_changes: [{ file: 'tests/a.test.mjs', test: 't', verdict: 'unjustified', why: 'w' }] }), /unjustified test change/],
    [good({ verdict: 'revise' }), /verdict revise/],
  ];
  for (const [review, reason] of cases) assert.match(reviewVerdict(review).reasons.join(), reason);
  const withTests = reviewVerdict(good(), { gates: { diff: { files: ['src/format.js', 'tests/a.test.mjs'], test_changes: [{ file: 'tests/a.test.mjs', removed: ['assert.equal(1, 1)'] }] } } });
  assert.match(withTests.reasons.join(), /changed test file tests\/a\.test\.mjs was not reviewed/);
  const blast = { sibling_groups: [{ name: 'send channels', touched: ['src/a.js'], untouched: ['src/b.js', 'src/c.js'] }] };
  assert.match(reviewVerdict(good(), { blast }).reasons.join(), /untouched sibling src\/b\.js/);
  const excluded = good({ sibling_exclusions: [{ group: 'send channels', member: 'src/b.js', reason: 'does not format line breaks at all' }, { group: 'send channels', member: 'src/c.js', reason: 'shares composeText, fixed with it' }] });
  assert.equal(reviewVerdict(excluded, { blast }).pass, true);
  const cited = [{ file: 'src/format.js', line: 5, snippet: "return lines.join('\\n');" }];
  assert.equal(reviewVerdict(good({ items: [{ requirement: 'a', verdict: 'partial', citations: cited }] })).pass, true, 'partial is honest, not a refusal');
});

test('finding 16: a met or partial item needs a verified citation into the change; an approve that cites nothing fails', () => {
  const gates = { diff: { files: ['src/format.js'], test_changes: [] }, repro: { tests: [{ file: 'tests/join.test.mjs', name: 't' }] }, declared: [], green: [] };
  const none = reviewVerdict(good({ items: [{ requirement: 'a', verdict: 'met', citations: [] }] }), { gates });
  assert.equal(none.pass, false);
  assert.match(none.reasons.join(), /item 1 is met without a verified citation into the change/);
  const elsewhere = reviewVerdict(good({ items: [{ requirement: 'a', verdict: 'met', citations: [{ file: 'src/other.js', line: 1, snippet: 'something else entirely' }] }] }), { gates });
  assert.match(elsewhere.reasons.join(), /item 1 is met without a verified citation/, 'a file the diff did not touch is not evidence of the change');
  const invented = [{ where: 'items[0]', file: 'src/format.js', line: 5, why: 'snippet not within 2 lines of the cited line' }];
  assert.match(reviewVerdict(good(), { gates, invented }).reasons.join(), /item 1 is met without a verified citation/);
  assert.equal(reviewVerdict(good({ items: [{ requirement: 'a', verdict: 'met', citations: [{ file: 'tests/join.test.mjs', line: 5, snippet: 'assert.equal(joinLines' }] }] }), { gates }).pass, true, 'a reproduction test counts');
  assert.equal(reviewVerdict(good({ items: [{ requirement: 'a', verdict: 'cannot_verify', citations: [] }] }), { gates }).pass, true, 'cannot_verify needs no citation');
  assert.equal(reviewVerdict(good(), { gates }).pass, true);
});

test('finding 15: a missed path is not an approval, and a member both excluded and missed is a contradiction; the worker gets one revision', async () => {
  const missed = good({ missed_paths: [{ file: 'src/utils/outgoingText.js', line: 1, snippet: 'export const outgoing = 1;', why: 'same join, not fixed' }],
    sibling_exclusions: [{ group: 'send channels', member: 'src/utils/outgoingText.js', reason: 'does not join summary lines at all' }] });
  const verdict = reviewVerdict(missed);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join(), /missed path src\/utils\/outgoingText\.js:1/);
  assert.match(verdict.reasons.join(), /sibling src\/utils\/outgoingText\.js is both excluded and named as missed/);
  const { p, wt, head } = await fixed();
  try {
    p.write(wt.dir, {});
    const approveWithMissed = good({ missed_paths: [{ file: 'src/format.js', line: 2, snippet: "export const title = 'Synthetic summary line';", why: 'synthetic sibling' }] });
    const s = stub([approveWithMissed]);
    const result = await reviewDiff({ dir: wt.dir, base: wt.base, head, context: context(), gates: gates(), protectedReport: {}, blast: { terms: [], sibling_groups: [] }, launch: s.launch, prompt: 'Review.' });
    assert.equal(result.pass, false, 'approve with a missed path does not pass');
    assert.equal(result.revise, true, 'the worker is sent round once with the missed path');
    assert.match(reviseInput(result.reviews.map(r => r.review)), /missed path src\/format\.js:2: synthetic sibling/);
  } finally { p.cleanup(); }
});

test('a money or sync diff gets two reviews, and they must agree', async () => {
  assert.equal(isRisky(['src/utils/invoicePdf.js']), true);
  assert.equal(isRisky(['src/constants/defaults.js']), true);
  assert.equal(isRisky(['src/components/pages/FAQSection.jsx']), false);
  assert.equal(isRisky(['src/components/pages/FAQSection.jsx'], { persistence: { triggered: true } }), true);
  const { p, wt, head } = await fixed();
  const args = { dir: wt.dir, base: wt.base, head, context: context(), gates: gates(), protectedReport: {}, blast: { terms: [], sibling_groups: [] }, prompt: 'Review.', risky: true };
  try {
    const both = stub([good(), good()]);
    const agreed = await reviewDiff({ ...args, launch: both.launch });
    assert.equal(agreed.count, 2);
    assert.equal(agreed.pass, true);
    assert.deepEqual(both.inputs.map(i => i.meta.index), [0, 1], 'two separate sessions');
    const split = stub([good(), good({ verdict: 'block' })]);
    const disagreed = await reviewDiff({ ...args, launch: split.launch });
    assert.equal(disagreed.pass, false);
    assert.match(disagreed.reasons.join(), /two reviews disagree \(approve vs block\)/);
    assert.equal(disagreed.revise, false, 'a block never sends the worker round');
    const revise = stub([good({ verdict: 'revise', missed_paths: [{ file: 'src/format.js', line: 2, snippet: "export const title = 'Synthetic summary line';", why: 'synthetic' }] }), good({ verdict: 'revise' })]);
    const asked = await reviewDiff({ ...args, launch: revise.launch });
    assert.equal(asked.revise, true);
    assert.match(reviseInput(asked.reviews.map(r => r.review)), /missed path src\/format\.js:2: synthetic/);
  } finally { p.cleanup(); }
});

test('the reviewer sees the diff, gates, protected paths, blast radius and thread, never the worker\'s draft or earlier drafts', () => {
  const ctx = context();
  const input = reviewInput({ prompt: 'PROMPT', context: ctx, diff: 'diff --git a/src/format.js b/src/format.js\n', gates: { pass: true }, protectedReport: { protected: false }, blast: { terms: [] }, base: 'b'.repeat(40), head: 'h'.repeat(40) });
  assert.match(input, /^PROMPT/);
  assert.match(input, /### gates\.json/);
  assert.match(input, /### Diff base\.\.head/);
  assert.match(input, /Synthetic body: the summary joins lines with spaces/);
  assert.ok(!input.includes('PRIOR-DRAFT-MARKER'), 'saved earlier drafts are removed');
  assert.ok(!input.includes('Your report is recorded'), 'no worker reply');
  assert.ok(ctx.prior_reviews.length === 1, 'the caller\'s context is not mutated');
});
