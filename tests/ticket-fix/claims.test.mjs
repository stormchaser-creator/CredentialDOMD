// Fixed reply rules (G5 phase 0) and structured claims (A3). Synthetic text
// only; the failure patterns are paraphrased from the 2026-09-25 audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFixedRules, hexTokens, customerReplyText, parseStructuredReply, writerViolations, verifyEvidence,
  renderStructured, fillPlaceholders, placeholdersIn, describeViolations, HEADINGS, OPENINGS, CLOSINGS } from '../../scripts/ticket-fix/claims.mjs';
import { TICKET, uuid } from './helpers.mjs';

const rules = text => checkFixedRules(text).map(v => v.rule);

test('a commit, build or ticket id written by the author is refused; numbers and placeholders are not', () => {
  assert.deepEqual(rules('This was fixed in build c237149 and is live.'), ['commit_or_build_id']);
  assert.deepEqual(rules('See commit ab12cd34ef for the change.'), ['commit_or_build_id']);
  assert.deepEqual(rules('The value deadbeef is a placeholder.'), ['commit_or_build_id'], 'letters-only hex is still an id');
  assert.deepEqual(rules('Ticket ab12cd34-0000-4000-8000-000000000001 is linked.'), ['commit_or_build_id']);
  assert.deepEqual(rules('The live build is 20260928T1824-8e1981e.'), ['commit_or_build_id']);
  assert.deepEqual(rules('The change is in {{FIX_COMMIT}}, live in build {{BUILD}}.'), []);
  assert.deepEqual(rules('Your total is 1500000 cents over 20260928 and 2026-09-28.'), [], 'digits alone are numbers');
  assert.deepEqual(rules('A cafe fed a bee.'), [], 'short words are not ids');
  assert.deepEqual(hexTokens('c237149 and C237149 and 1234567'), ['c237149', 'C237149']);
});

test('em dash, HIPAA, "compliant" and the owner name are refused; nearby words are not', () => {
  assert.deepEqual(rules('The list is sorted \u2014 newest first.'), ['em_dash']);
  assert.deepEqual(rules('Dates run Aug 1 – Aug 15.'), [], 'an en dash is a range');
  assert.deepEqual(rules('Your data is HIPAA protected.'), ['hipaa']);
  assert.deepEqual(rules('Your CME is compliant with the board.'), ['compliant']);
  assert.deepEqual(rules('The compliance deadlines are on the dashboard.'), [], 'compliance is a product word');
  for (const name of ['Eric', 'eric', 'Whit', 'WHITNEY']) assert.deepEqual(rules(`${name} will look at it.`), ['owner_name'], name);
  assert.deepEqual(rules('Erica and Whitfield are synthetic names.'), [], 'only whole words match');
});

test('a result on a phone or device must say it was not tested there', () => {
  assert.deepEqual(rules('It now works on your iPhone.'), ['device_not_tested']);
  assert.deepEqual(rules('The Mail app shows each item on its own line.'), ['device_not_tested']);
  assert.deepEqual(rules('On Android the list scrolls to the top.'), ['device_not_tested']);
  assert.deepEqual(rules('The list should scroll on your phone, but this has not been tested on a phone.'), []);
  assert.deepEqual(rules('Could you check whether it works on your iPhone?'), [], 'a question reports nothing');
  assert.deepEqual(rules('Your phone number now shows on the CV.'), [], 'a phone number is not a device');
  assert.deepEqual(rules('Open Settings on your phone and tap Support.'), [], 'an instruction reports no result');
  assert.deepEqual(rules('This was not tested on an iPad; the desktop view now scrolls.'), []);
});

test('unknown placeholders, control characters and overlong text are refused', () => {
  assert.deepEqual(rules('See {{TICKET_ID}} for details.'), ['unknown_placeholder']);
  assert.deepEqual(rules('Line one\u0007 line two.'), ['control_character']);
  assert.deepEqual(rules('Tabs\tand\nnewlines are fine.'), []);
  assert.deepEqual(rules('a '.repeat(2001)), ['too_long']);
  assert.match(describeViolations(checkFixedRules('Fixed in c237149 \u2014 live.')), /commit_or_build_id \("c237149"\).*em_dash/);
});

test('placeholders are filled only with host values', () => {
  assert.deepEqual([...placeholdersIn('A {{BUILD}} B {{ FIX_COMMIT }} C {{OTHER}}')].sort(), ['BUILD', 'FIX_COMMIT']);
  assert.equal(fillPlaceholders('in {{FIX_COMMIT}} (build {{BUILD}})', { FIX_COMMIT: 'abc1234', BUILD: '20260928T1200-abc1234' }), 'in abc1234 (build 20260928T1200-abc1234)');
  assert.throws(() => fillPlaceholders('in {{FIX_COMMIT}}', {}), /No host value/);
});

test('the host hygiene still strips a doubled label and rewrites em dashes', () => {
  assert.equal(customerReplyText('CredentialDOMD Support · Automated\n\nDone \u2014 thanks.'), 'Done, thanks.');
});

const good = (changes = {}) => ({ ticket_id: TICKET, opening: 'update', closing: 'reply_here',
  claims: [{ id: 'AC-1', text: 'The export now lists expired licences.', evidence: { file: 'src/export.js', line: 3, text: 'includeExpired: true' } }],
  ...changes });

test('a structured reply is parsed strictly, all problems at once, one ticket per file', () => {
  const parsed = parseStructuredReply(good({ context: '  A short note.  ', not_done: ['The PDF layout.'] }), TICKET);
  assert.equal(parsed.context, 'A short note.');
  assert.deepEqual(parsed.claims[0].evidence, { kind: 'file', ref: 'src/export.js:3', file: 'src/export.js', line: 3, text: 'includeExpired: true' });
  assert.throws(() => parseStructuredReply([good()], TICKET), /batches are refused/);
  assert.throws(() => parseStructuredReply(good(), 'not-a-uuid'), /single ticket UUID/);
  assert.throws(() => parseStructuredReply(good({ ticket_id: uuid(1) }), TICKET), /one ticket per call/);
  const error = (() => { try { parseStructuredReply(good({ opening: 'hello', extra: 1, claims: [{ text: 'x'.repeat(161), evidence: {} }] }), TICKET); } catch (e) { return e; } })();
  assert.ok(error.problems.length >= 4, error.message);
  assert.match(error.message, /unknown field "extra"/);
  assert.match(error.message, /opening must be one of/);
  assert.match(error.message, /at most 160 characters/);
  assert.match(error.message, /exactly one of test, query or file/);
  for (const evidence of [{ file: '../etc/passwd', line: 1, text: 'root entry here' }, { file: '/abs/x.js', line: 1, text: 'long enough' },
    { file: '.git/config', line: 1, text: 'long enough' }, { file: 'src/x.js', line: 0, text: 'long enough' }, { file: 'src/x.js', line: 2, text: 'short' },
    { test: 'no separator' }, { test: 'src/x.js::name' }, { query: 'Bad Id' }, { query: 'ok', expect: { rows: -1 } }, { query: 'ok', expect: { other: 1 } },
    { test: 'tests/a.test.mjs::t', file: 'src/x.js' }]) {
    assert.throws(() => parseStructuredReply(good({ claims: [{ text: 'A claim.', evidence }] }), TICKET), /evidence/, JSON.stringify(evidence));
  }
  assert.throws(() => parseStructuredReply(good({ claims: [{ text: 'Two\nlines', evidence: { query: 'rows' } }] }), TICKET), /one line/);
});

test('writer violations name the field they came from', () => {
  const parsed = parseStructuredReply(good({ context: 'Fixed in c237149.', not_done: ['Eric will decide.'] }), TICKET);
  assert.deepEqual(writerViolations(parsed).map(v => `${v.field}:${v.rule}`), ['context:commit_or_build_id', 'not_done[0]:owner_name']);
});

const HEAD = 'a'.repeat(40);
const sources = (changes = {}) => ({ head: HEAD,
  fileAtHead: file => ({ 'src/export.js': 'line one\nline two\nconst options = { includeExpired: true };\nline four\n', 'tests/export.test.mjs': 'test' }[file] ?? null),
  gates: { version: 1, head: HEAD, dirty: false, tests: [{ id: 'tests/export.test.mjs::lists expired', status: 'pass' }, { id: 'tests/export.test.mjs::red', status: 'fail' }, { id: 'tests/export.test.mjs::later', status: 'skip' }] },
  query: id => ({ present: { row_count: 3, ran_at: '2026-09-28T12:00:00Z' }, empty: { row_count: 0, ran_at: '2026-09-28T12:00:00Z' },
    control: { row_count: 1, ran_at: '2026-09-28T12:05:00Z' }, stale_control: { row_count: 1, ran_at: '2026-09-28T13:00:00Z' },
    empty_control: { row_count: 0, ran_at: '2026-09-28T12:00:00Z' } }[id] ?? null),
  ...changes });
const evidence = e => parseStructuredReply(good({ claims: [{ text: 'A claim.', evidence: e }] }), TICKET).claims[0].evidence;

test('test evidence verifies only from a clean host run at the same HEAD', () => {
  const pass = evidence({ test: 'tests/export.test.mjs::lists expired' });
  assert.equal(verifyEvidence(pass, sources()).verified, true);
  assert.match(verifyEvidence(pass, sources({ gates: null })).reason, /no gates file/);
  assert.match(verifyEvidence(pass, sources({ gates: { ...sources().gates, head: 'b'.repeat(40) } })).reason, /different HEAD/);
  assert.match(verifyEvidence(pass, sources({ gates: { ...sources().gates, dirty: true } })).reason, /uncommitted/);
  assert.match(verifyEvidence(evidence({ test: 'tests/export.test.mjs::red' }), sources()).reason, /failed/);
  assert.match(verifyEvidence(evidence({ test: 'tests/export.test.mjs::later' }), sources()).reason, /was skip/);
  assert.match(verifyEvidence(evidence({ test: 'tests/export.test.mjs::never ran' }), sources()).reason, /did not run/);
  assert.match(verifyEvidence(evidence({ test: 'tests/gone.test.mjs::lists expired' }), sources()).reason, /not committed/);
});

test('query evidence needs a stored result; an absence claim needs a positive control', () => {
  assert.equal(verifyEvidence(evidence({ query: 'present' }), sources()).verified, true);
  assert.equal(verifyEvidence(evidence({ query: 'present', expect: { rows: 3 } }), sources()).verified, true);
  assert.match(verifyEvidence(evidence({ query: 'present', expect: { rows: 2 } }), sources()).reason, /expected 2/);
  assert.match(verifyEvidence(evidence({ query: 'missing' }), sources()).reason, /no recorded result/);
  assert.match(verifyEvidence(evidence({ query: 'empty' }), sources()).reason, /unless it expects none/, 'zero rows is not "it is there"');
  assert.match(verifyEvidence(evidence({ query: 'empty', expect: { rows: 0 } }), sources()).reason, /positive control/);
  assert.equal(verifyEvidence(evidence({ query: 'empty', expect: { rows: 0, control: 'control' } }), sources()).verified, true);
  assert.match(verifyEvidence(evidence({ query: 'empty', expect: { rows: 0, control: 'empty_control' } }), sources()).reason, /control returned no rows/);
  assert.match(verifyEvidence(evidence({ query: 'empty', expect: { rows: 0, control: 'stale_control' } }), sources()).reason, /15 minutes/);
});

test('file evidence needs the cited text within two lines at HEAD', () => {
  assert.equal(verifyEvidence(evidence({ file: 'src/export.js', line: 3, text: 'includeExpired: true' }), sources()).verified, true);
  assert.equal(verifyEvidence(evidence({ file: 'src/export.js', line: 1, text: 'includeExpired: true' }), sources()).verified, true);
  assert.match(verifyEvidence(evidence({ file: 'src/export.js', line: 3, text: 'includeExpired: false' }), sources()).reason, /not within 2 lines/);
  assert.match(verifyEvidence(evidence({ file: 'src/export.js', line: 40, text: 'includeExpired: true' }), sources()).reason, /only \d+ lines/);
  assert.match(verifyEvidence(evidence({ file: 'src/missing.js', line: 1, text: 'includeExpired: true' }), sources()).reason, /not committed/);
});

test('the host renders fixed opening and closing lines and the two lists', () => {
  const text = renderStructured({ opening: 'checked', context: 'A short note.', confirmed: ['One.'], pending: ['Two.', 'Three.'], closing: 'follow_up' });
  assert.equal(text, `${OPENINGS.checked}\n\nA short note.\n\n${HEADINGS.confirmed}\n- One.\n\n${HEADINGS.pending}\n- Two.\n- Three.\n\n${CLOSINGS.follow_up}`);
  assert.equal(renderStructured({ opening: 'answer', context: '', confirmed: [], pending: [], closing: 'none' }), OPENINGS.answer);
  for (const fixed of [...Object.values(OPENINGS), ...Object.values(CLOSINGS), ...Object.values(HEADINGS)]) assert.deepEqual(checkFixedRules(fixed), [], fixed);
});
