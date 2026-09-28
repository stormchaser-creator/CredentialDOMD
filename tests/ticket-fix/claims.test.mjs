// Fixed reply rules (G5 phase 0) and structured claims (A3). Synthetic text
// only; the failure patterns are paraphrased from the 2026-09-25 audit and
// the 2026-09-28 review replays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFixedRules, hexTokens, customerReplyText, parseStructuredReply, writerViolations, verifyClaim, foldForRules,
  renderStructured, fillPlaceholders, placeholdersIn, describeViolations, ruleNames, relationsIn, quotedStrings,
  HEADINGS, OPENINGS, CLOSINGS, CONTEXTS } from '../../scripts/ticket-fix/claims.mjs';
import { TICKET, OWNER, uuid } from './helpers.mjs';

const rules = (text, options) => checkFixedRules(text, options).map(v => v.rule);

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

test('a digits-only commit id, or a build id whose hash is all digits, is refused (review: 3.7% of short SHAs)', () => {
  assert.deepEqual(rules('Fixed in build 4081226.', { isCommit: token => token === '4081226' }), ['commit_or_build_id']);
  assert.deepEqual(rules('Fixed in build 4081226.', { liveShort: '4081226' }), ['commit_or_build_id']);
  assert.deepEqual(rules('The live build is 20260928T1648-4081226.'), ['commit_or_build_id'], 'the build pattern itself');
  assert.deepEqual(rules('Fixed in build 4081226.', { isCommit: () => false }), [], 'a number git does not know stays a number');
  assert.deepEqual(rules('Your total is 1500000 cents.', { isCommit: token => token === '4081226', liveShort: '4081226' }), []);
  assert.equal(checkFixedRules('Fixed in 20260928T1648-4081226.', { isCommit: () => true }).length, 1, 'one id, reported once');
});

test('zero-width and look-alike characters do not carry an id or a name past the rules', () => {
  const zw = 'Fixed in build c237\u200b149 by E\u200bric.';
  assert.deepEqual(rules(zw).sort(), ['commit_or_build_id', 'invisible_character', 'owner_name'].sort());
  assert.deepEqual(rules('\u0415ric will look at it.'), ['owner_name'], 'Cyrillic E');
  assert.deepEqual(rules('W\u04bbit will look at it.'), ['owner_name'], 'Cyrillic h');
  assert.deepEqual(rules('Fixed in c237\u00ad149.').sort(), ['commit_or_build_id', 'invisible_character'].sort(), 'soft hyphen');
  assert.deepEqual(rules('Fixed in c237\u2060149.').sort(), ['commit_or_build_id', 'invisible_character'].sort(), 'word joiner');
  assert.deepEqual(rules('Fixed in \uff43237149.'), ['commit_or_build_id'], 'fullwidth letter');
  assert.deepEqual(rules('Your HIP\u200bAA data.').sort(), ['hipaa', 'invisible_character'].sort());
  assert.equal(foldForRules('\u0415ric c237\u200b149'), 'Eric c237149');
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

test('a sentence naming a device or a mail client must say it was not tested there', () => {
  assert.deepEqual(rules('It now works on your iPhone.'), ['device_not_tested']);
  assert.deepEqual(rules('The Mail app shows each item on its own line.'), ['device_not_tested']);
  assert.deepEqual(rules('On Android the list scrolls to the top.'), ['device_not_tested']);
  // The review's five: the formatting loop, 288f73da, d0c17a29, c0aa1d32, and Gmail.
  for (const sentence of ['Your emails now keep their line breaks in Mail.', 'Scrolling on the work log is smooth again on your iPhone.',
    'The menu bar stays put when you scroll in Safari.', 'Contacts from your iPhone come in with phone and email.',
    'Pasted into Gmail, each item is on its own line.', 'Try it now: it works on your iPhone.']) {
    assert.deepEqual(rules(sentence), ['device_not_tested'], sentence);
  }
  assert.deepEqual(rules('The list should scroll on your phone, but this has not been tested on a phone.'), []);
  assert.deepEqual(rules('Could you check whether it works on your iPhone?'), [], 'a question reports nothing');
  assert.deepEqual(rules('Your phone number now shows on the CV.'), [], 'a phone number is not a device');
  assert.deepEqual(rules('Open Settings on your phone and tap Support.'), [], 'an instruction reports no result');
  assert.deepEqual(rules('This was not tested on an iPad; the desktop view now scrolls.'), []);
  assert.deepEqual(rules('This works on your iPhone; it was not tested on Android.'), ['device_not_tested'], 'a clause per result');
  assert.deepEqual(rules('We will email you when it is ready.'), [], 'email is not the Mail app');
});

test('free prose with no evidence may not report a result (agent replies: failure mode 1)', () => {
  const claims = text => rules(text, { claims: true });
  // 2343f33d and 821d2f76, paraphrased.
  assert.deepEqual(claims('The collapsed line now shows your next due date, and the body no longer repeats the subject.'), ['unverified_claim']);
  for (const sentence of ['The export is fixed.', 'This is live.', 'The Licences page lists every licence.', 'Your invoice includes all three receipts.',
    'The date displays under Licences.', 'You\'ll see the new field on the form.', 'We removed the duplicate entry.', 'Your expiration date is saved.']) {
    assert.deepEqual(claims(sentence), ['unverified_claim'], sentence);
  }
  for (const sentence of ['Your report is recorded; the investigation continues.', 'We are working on the export and will post here.',
    'Which screen were you on when the date disappeared?', 'Open the Licences page and tap Export.']) {
    assert.deepEqual(claims(sentence), [], sentence);
  }
  assert.deepEqual(rules('The export is fixed.'), [], 'only free prose is held to this');
});

test('unknown placeholders, control characters and overlong text are refused', () => {
  assert.deepEqual(rules('See {{TICKET_ID}} for details.'), ['unknown_placeholder']);
  assert.deepEqual(rules('Line one\u0007 line two.'), ['control_character']);
  assert.deepEqual(rules('Tabs\tand\nnewlines are fine.'), []);
  assert.deepEqual(rules('a '.repeat(2001)), ['too_long']);
  assert.match(describeViolations(checkFixedRules('Fixed in c237149 \u2014 live.')), /commit_or_build_id \("c237149"\).*em_dash/);
  assert.equal(ruleNames(checkFixedRules('Eric fixed c237149 on your iPhone \u2014 done.')), 'commit_or_build_id, em_dash, owner_name, device_not_tested');
});

test('placeholders are filled only with host values', () => {
  assert.deepEqual([...placeholdersIn('A {{BUILD}} B {{ FIX_COMMIT }} C {{OTHER}}')].sort(), ['BUILD', 'FIX_COMMIT']);
  assert.equal(fillPlaceholders('in {{FIX_COMMIT}} (build {{BUILD}})', { FIX_COMMIT: 'abc1234', BUILD: '20260928T1200-abc1234' }), 'in abc1234 (build 20260928T1200-abc1234)');
  assert.throws(() => fillPlaceholders('in {{FIX_COMMIT}}', {}), /No host value/);
});

test('the host hygiene still strips a doubled label and rewrites em dashes', () => {
  assert.equal(customerReplyText('CredentialDOMD Support · Automated\n\nDone \u2014 thanks.'), 'Done, thanks.');
});

const VERSION = '2026-09-28T12:00:00.123456+00:00';
const good = (changes = {}) => ({ ticket_id: TICKET, ticket_version: VERSION, opening: 'update', closing: 'reply_here',
  claims: [{ id: 'AC-1', text: 'The button says "Export all".', evidence: { file: 'src/export.js', line: 3, text: 'label: "Export all"' } }],
  ...changes });

test('a structured reply is parsed strictly, all problems at once, one ticket per file', () => {
  const parsed = parseStructuredReply(good({ context: 'release', not_done: ['The PDF layout.'] }), TICKET);
  assert.equal(parsed.context, 'release');
  assert.equal(parsed.ticket_version, VERSION);
  assert.equal(parseStructuredReply(good(), TICKET).context, 'none');
  assert.deepEqual(parsed.claims[0].evidence, { kind: 'file', ref: 'src/export.js:3', file: 'src/export.js', line: 3, text: 'label: "Export all"' });
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
    { test: 'no separator' }, { test: 'src/x.js::name' }, { query: 'Bad Id', expect: { rows: 1 } }, { query: 'ok', expect: { rows: -1 } }, { query: 'ok', expect: { other: 1 } },
    { query: 'ok' }, { query: 'ok', expect: {} }, { query: 'ok', expect: { rows: 1, rows_min: 1 } }, { query: 'ok', expect: { rows: 1, values: {} } },
    { query: 'ok', expect: { rows: 1, values: { 'bad column': 1 } } }, { query: 'ok', expect: { rows: 1, values: { a: { nested: 1 } } } },
    { query: 'ok', expect: { rows: 0, control: 'ok' } }, { test: 'tests/a.test.mjs::t', file: 'src/x.js' }]) {
    assert.throws(() => parseStructuredReply(good({ claims: [{ text: 'A claim.', evidence }] }), TICKET), /evidence/, JSON.stringify(evidence));
  }
  assert.throws(() => parseStructuredReply(good({ claims: [{ text: 'Two\nlines', evidence: { query: 'rows', expect: { rows: 1 } } }] }), TICKET), /one line/);
});

test('free prose has no field of its own: context is a fixed line, and the ticket version is required', () => {
  // Review replay: context carried "your invoice now lists all three receipts"
  // word for word under the fixed opening.
  assert.throws(() => parseStructuredReply(good({ context: 'We fixed the export, and your invoice now lists all three receipts.' }), TICKET), /context must be one of none, release/);
  assert.equal(renderStructured({ opening: 'update', context: 'release', confirmed: [], pending: [], closing: 'none' }), `${OPENINGS.update}\n\n${CONTEXTS.release}`);
  for (const version of [undefined, '', 'yesterday', 12]) assert.throws(() => parseStructuredReply(good({ ticket_version: version }), TICKET), /ticket_version is required/, String(version));
  assert.equal(parseStructuredReply(good({ ticket_version: '2026-09-28 12:00:00.123456+00' }), TICKET).ticket_version, '2026-09-28 12:00:00.123456+00', 'as the database prints it');
});

test('writer violations name the field they came from', () => {
  const parsed = parseStructuredReply(good({ claims: [{ text: 'Fixed in c237149.', evidence: { test: 'tests/a.test.mjs::t' } }], not_done: ['Eric will decide.'] }), TICKET);
  assert.deepEqual(writerViolations(parsed).map(v => `${v.field}:${v.rule}`), ['claims[0]:commit_or_build_id', 'not_done[0]:owner_name']);
});

const HEAD = 'a'.repeat(40), LIVE = 'b'.repeat(40);
const LIVE_SOURCE = 'line one\nline two\nconst options = { label: "Export all", includeExpired: true };\nline four\n';
const sources = (changes = {}) => ({ head: HEAD, live: { commit: LIVE, contains_head: true }, scope: [TICKET, OWNER],
  fileAtHead: file => ({ 'src/export.js': LIVE_SOURCE, 'tests/export.test.mjs': 'test' }[file] ?? null),
  fileAtLive: file => ({ 'src/export.js': LIVE_SOURCE, 'src/upload.jsx': 'export function Upload() {\n  return <button>Upload a screenshot</button>;\n}\n', 'notes/claims.md': 'The export includes everything now.\n' }[file] ?? null),
  gates: { version: 1, head: HEAD, dirty: false, tests: [{ id: 'tests/export.test.mjs::lists expired', status: 'pass' }, { id: 'tests/export.test.mjs::red', status: 'fail' }, { id: 'tests/export.test.mjs::later', status: 'skip' }] },
  query: id => QUERIES[id] ?? null, ...changes });
const at = (minutes, rows, sql) => ({ row_count: rows.length, rows, sql, ran_at: new Date(Date.parse('2026-09-28T12:00:00Z') + minutes * 60000).toISOString() });
const QUERIES = {
  dea: at(0, [{ id: uuid(1), type: 'DEA' }, { id: uuid(2), type: 'DEA' }, { id: uuid(3), type: 'DEA' }], `select id, type from licenses where user_id = '${OWNER}' and type = 'DEA'`),
  dea_count: at(0, [{ count: 3 }], `select count(*) from licenses where user_id = '${OWNER}' and type = 'DEA'`),
  dl_count: at(0, [{ count: 3 }], `select count(*) from licenses where user_id = '${OWNER}' and type = 'Driver License'`),
  dl_none: at(0, [], `select id from licenses where user_id = '${OWNER}' and type = 'Driver License'`),
  dl_zero: at(0, [{ count: 0 }], `select count(*) from licenses where user_id = '${OWNER}' and type = 'Driver License'`),
  licenses_control: at(5, [{ id: uuid(1) }], `select id from licenses where user_id = '${OWNER}' limit 1`),
  stale_control: at(60, [{ id: uuid(1) }], `select id from licenses where user_id = '${OWNER}' limit 1`),
  empty_control: at(0, [], `select id from licenses where user_id = '${OWNER}' limit 1`),
  select_one: at(0, [{ '?column?': 1 }], 'select 1'),
  other_table_control: at(0, [{ id: uuid(9) }], `select id from profiles where id = '${OWNER}'`),
  attachments: at(0, [{ name: `tickets/${TICKET}/shot.png` }], `select name from storage.objects where name like 'tickets/${TICKET}/%'`),
  attachments_control: at(0, [{ name: 'x' }], `select name from storage.objects where name like 'tickets/${TICKET}/%' or true limit 1`),
  unscoped: at(0, [{ id: uuid(1) }], 'select id from licenses limit 1'),
};
const claim = (text, evidence) => parseStructuredReply(good({ claims: [{ text, evidence }] }), TICKET).claims[0];
const check = (text, evidence, changes) => verifyClaim(claim(text, evidence), sources(changes));

test('test evidence verifies only from a clean host run at a HEAD the live build contains', () => {
  const pass = ['Expired licences are listed.', { test: 'tests/export.test.mjs::lists expired' }];
  assert.equal(check(...pass).verified, true);
  assert.match(check(...pass, { gates: null }).reason, /no host test run/);
  assert.match(check(...pass, { gates: { ...sources().gates, head: 'c'.repeat(40) } }).reason, /different HEAD/);
  assert.match(check(...pass, { gates: { ...sources().gates, dirty: true } }).reason, /uncommitted or untracked/);
  assert.match(check('A claim.', { test: 'tests/export.test.mjs::red' }).reason, /failed/);
  assert.match(check('A claim.', { test: 'tests/export.test.mjs::later' }).reason, /was skip/);
  assert.match(check('A claim.', { test: 'tests/export.test.mjs::never ran' }).reason, /did not run/);
  assert.match(check('A claim.', { test: 'tests/gone.test.mjs::lists expired' }).reason, /not committed/);
  // Review replay: HEAD carries a local commit the live build does not have.
  assert.match(check(...pass, { live: { commit: LIVE, contains_head: false } }).reason, /not live yet/);
  assert.match(check(...pass, { live: { commit: null, error: 'could not read the live build (offline)' } }).reason, /not live yet: could not read/);
  assert.match(check('Expired licences show on your iPhone; not tested there.', pass[1]).reason, /never confirmed here: not tested on that device/);
});

test('query evidence: the rows must show what the claim says (a36aeef3 and 5bef10ac replays)', () => {
  // a36aeef3: the screenshot exists, the reply said it never came through.
  assert.match(check('No screenshot came through with this ticket.', { query: 'attachments', expect: { rows_min: 1 } }).reason, /absent needs expect.rows 0/);
  assert.match(check('No screenshot came through with this ticket.', { query: 'attachments', expect: { rows: 0, control: 'attachments_control' } }).reason, /returned 1 rows, expected 0/);
  // 5bef10ac: three rows remained, the reply said none did.
  assert.match(check('No Driver License records remain on your account.', { query: 'dl_count', expect: { rows: 1 } }).reason, /absent needs expect.rows 0 or expect.values/);
  assert.match(check('No Driver License records remain on your account.', { query: 'dl_count', expect: { rows: 1, values: { count: 0 }, control: 'licenses_control' } }).reason, /do not all have count = 0/);
  assert.equal(check('No Driver License records remain on your account.', { query: 'dl_zero', expect: { rows: 1, values: { count: 0 }, control: 'licenses_control' } }).verified, true);
  assert.equal(check('No Driver License records remain on your account.', { query: 'dl_none', expect: { rows: 0, control: 'licenses_control' } }).verified, true);
  // A count(*) is always one row: it says nothing unless its value is stated.
  assert.match(check('Your DEA registrations are on file.', { query: 'dea_count', expect: { rows: 1 } }).reason, /aggregate row/);
  assert.equal(check('Your account has 3 DEA registrations.', { query: 'dea_count', expect: { rows: 1, values: { count: 3 } } }).verified, true);
  assert.match(check('Your account has 4 DEA registrations.', { query: 'dea_count', expect: { rows: 1, values: { count: 3 } } }).reason, /says 4, which is neither the row count nor in the returned rows/);
  assert.equal(check('Your account has 3 DEA registrations.', { query: 'dea', expect: { rows: 3, values: { type: 'DEA' } } }).verified, true);
  assert.match(check('A claim.', { query: 'dea', expect: { rows: 2 } }).reason, /expected 2/);
  assert.match(check('A claim.', { query: 'missing', expect: { rows: 1 } }).reason, /no recorded result/);
});

test('query evidence: a table, this customer, and a real positive control', () => {
  assert.match(check('Your licence is saved.', { query: 'select_one', expect: { rows: 1 } }).reason, /reads no table/);
  assert.match(check('Your licence is saved.', { query: 'unscoped', expect: { rows: 1 } }).reason, /not scoped to this ticket or its owner/);
  const absent = control => check('No Driver License records remain on your account.', { query: 'dl_none', expect: { rows: 0, ...(control ? { control } : {}) } }).reason;
  assert.match(absent(null), /needs a recorded positive control/);
  assert.match(absent('select_one'), /does not read the same table/, 'select 1 is not a control');
  assert.match(absent('other_table_control'), /does not read the same table/);
  assert.match(absent('empty_control'), /control returned no rows/);
  assert.match(absent('stale_control'), /15 minutes/);
  assert.deepEqual([...relationsIn("select a from public.licenses l join \"profiles\" p on p.id = l.user_id where x = 'from fake'")].sort(), ['licenses', 'profiles']);
  assert.deepEqual([...relationsIn('select * from generate_series(1, 3)')], [], 'a function is not a table');
});

test('file evidence confirms quoted UI text at the cited lines of live product source, and nothing else', () => {
  const cite = { file: 'src/export.js', line: 3, text: 'label: "Export all"' };
  assert.equal(check('The button says "Export all".', cite).verified, true);
  // 5f9b744d replay: the cited line still says "screenshot".
  const upload = check('The upload button now says "Upload a file" instead of screenshot.', { file: 'src/upload.jsx', line: 2, text: 'Upload a screenshot' });
  assert.equal(upload.verified, false);
  assert.match(upload.reason, /gone, or true everywhere/);
  assert.match(check('The upload button now says "Upload a file".', { file: 'src/upload.jsx', line: 2, text: 'Upload a screenshot' }).reason, /quoted text in the claim is not at the cited lines/);
  // 821d2f76 replay: a claim that something stopped, citing a test.
  assert.match(check('The body no longer repeats the subject.', { file: 'tests/export.test.mjs', line: 1, text: 'repeats the subject' }).reason, /product source/);
  assert.match(check('The body no longer repeats "the subject".', { file: 'src/export.js', line: 3, text: 'label: "Export all"' }).reason, /gone, or true everywhere/);
  assert.match(check('Every export includes "Export all".', cite).reason, /gone, or true everywhere/);
  // Review replay: any 8 characters near any line confirmed any claim.
  assert.match(check('The admin modal now saves the expiration date.', { file: 'package.json', line: 3, text: '"private": true' }).reason, /product source/);
  assert.match(check('The admin modal now saves the expiration date.', cite).reason, /confirms quoted text only/);
  assert.match(check('The export includes "everything".', { file: 'notes/claims.md', line: 1, text: 'The export includes everything' }).reason, /product source/);
  assert.match(check('The button says "Export all".', cite, { live: { commit: null, error: 'could not read the live build (offline)' } }).reason, /not live yet/);
  assert.match(check('The button says "Export all".', { ...cite, file: 'src/new.js' }).reason, /not in the live build/);
  assert.match(check('The button says "Export all".', { ...cite, line: 40 }).reason, /only \d+ lines/);
  assert.match(check('The button says "Export all".', { ...cite, text: 'label: "Export none"' }).reason, /not within 2 lines/);
  assert.match(check('The button says "Export all" on your iPhone; not tested there.', cite).reason, /not tested on that device/);
  assert.deepEqual(quotedStrings('It says \u201cSave\u201d, "Close" and \'Undo it\' but don\'t split words.'), ['Save', 'Close', 'Undo it']);
});

test('the host renders fixed opening, context and closing lines and the two lists', () => {
  const text = renderStructured({ opening: 'checked', context: 'none', confirmed: ['One.'], pending: ['Two.', 'Three.'], closing: 'follow_up' });
  assert.equal(text, `${OPENINGS.checked}\n\n${HEADINGS.confirmed}\n- One.\n\n${HEADINGS.pending}\n- Two.\n- Three.\n\n${CLOSINGS.follow_up}`);
  assert.equal(renderStructured({ opening: 'answer', context: 'none', confirmed: [], pending: [], closing: 'none' }), OPENINGS.answer);
  for (const fixed of [...Object.values(OPENINGS), ...Object.values(CONTEXTS), ...Object.values(CLOSINGS), ...Object.values(HEADINGS)]) assert.deepEqual(checkFixedRules(fixed), [], fixed);
});
