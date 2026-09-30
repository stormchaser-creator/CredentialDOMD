// G10 (stage 2 review, finding 7): the host's scan for personal data and
// secrets before anything reaches the public repository. Every value here is
// synthetic; the "real-looking" ones are made up to pass the checksums.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineFindings, luhnNpi, deaValid, evidenceShingles, personalDataReport } from '../../scripts/ticket-fix/gates/personal-data.mjs';
import { project, sh, npiFrom } from './stage2-helpers.mjs';

const rules = line => lineFindings(line).map(f => f.rule);
// Values the scanner must flag, made up so that none can be a real person's:
// an address on a public mail domain with an impossible local part, an area
// code no number has (0xx), and an NPI built from a synthetic prefix with its
// check digit computed (npiFrom), so no full NPI is written in this file.
const EMAIL = 'no-such-person-7f3a@gmail.com';
const PHONE = '099-555-4477';
const NPI = npiFrom('100000042');

test('patterns: what counts as personal data and what the synthetic fixtures may use', () => {
  assert.deepEqual(rules(`const a = '${EMAIL}';`), ['email']);
  for (const ok of ["'tester@example.invalid'", "'a@example.com'", "'b@clinic.test'", "'support@credentialdomd.com'", "'icon@2x.png'", "import x from '@scope/pkg';"]) assert.deepEqual(rules(ok), [], ok);
  assert.deepEqual(rules(`phone: '${PHONE}'`), ['phone']);
  assert.deepEqual(rules("phone: '(555) 012-3456'"), ['phone'], 'only 555-0100 to 555-0199 is fictional');
  assert.deepEqual(rules("phone: '555-555-0123'"), []);
  assert.equal(luhnNpi('1234567893'), true);
  assert.deepEqual(rules("npi: '1234567893'"), [], 'the repository\'s synthetic NPI');
  assert.equal(luhnNpi(NPI), true);
  assert.deepEqual(rules(`npi: '${NPI}'`), ['npi']);
  assert.deepEqual(rules(`npi: '${NPI.slice(0, 9)}${(Number(NPI[9]) + 1) % 10}'`), [], 'fails the NPI check digit');
  assert.equal(deaValid('AB', '1234563'), true);
  assert.deepEqual(rules("dea: 'AB1234563'"), ['dea']);
  assert.deepEqual(rules("ssn: '123-45-6789'"), ['ssn']);
  assert.deepEqual(rules(`img: 'data:image/png;base64,${'A'.repeat(500)}'`), ['base64_blob']);
  for (const token of [`sk-ant-${'a'.repeat(30)}`, `sbp_${'b'.repeat(40)}`, `ghp_${'c'.repeat(36)}`, `github_pat_${'d'.repeat(40)}`, `eyJ${'e'.repeat(12)}.eyJ${'f'.repeat(12)}.${'g'.repeat(12)}`, '-----BEGIN RSA PRIVATE KEY-----']) {
    assert.deepEqual(rules(`const t = '${token}';`), ['credential'], token.slice(0, 12));
  }
  assert.deepEqual(lineFindings("const t = 'synthetic-runner-credential-0123';", { secrets: ['synthetic-runner-credential-0123'] }).map(f => [f.rule, f.never_public]), [['credential', true]]);
  assert.deepEqual(rules("const d = '2026-09-28'; const id = '00000000-0000-4000-8000-000000004242';"), [], 'dates and ids are not phone numbers');
});

test('eight words in a row from the ticket thread count as copied text', () => {
  const shingles = evidenceShingles({ tickets: [{ subject: 'Synthetic', body: 'My renewal date is missing from the collapsed line on the phone', messages: [{ body: 'Still broken today' }] }] });
  assert.ok(shingles.has('renewal date is missing from the collapsed line'));
  assert.equal(evidenceShingles(null).size, 0);
});

// The runner's own verified reply (a message with a verification_id) is
// written from the acceptance criteria and the test names; a reproduction test
// named after its criterion, as the runner requires, matched it, and a frozen
// reproduction file can never be repaired (2026-09-29). Synthetic text.
const CRITERION = 'Renewal list: the expired badge shows on the card once the renewal date has passed';
const verifiedReply = { id: '00000000-0000-4000-8000-000000000301', body: `CredentialDOMD Support · Automated\n\nFixed and verified: ${CRITERION}. The test that checks it passed on the released build.`,
  is_admin_reply: true, verification_id: '00000000-0000-4000-8000-000000000302', actor_label: 'owner_support_reply' };
const ownerNote = { id: '00000000-0000-4000-8000-000000000303', body: 'Admin note, no verification: the orange banner on the credentials page overlaps the search field on narrow phones',
  is_admin_reply: true, verification_id: null, actor_label: 'recorded_admin_author' };
const memberAsk = { id: '00000000-0000-4000-8000-000000000304', body: 'Please make the reminder email name the licence that expires first, not the newest one',
  is_admin_reply: false, verification_id: null, actor_label: 'recorded_customer_author' };

test('the runner\'s own verified reply is not ticket text; an admin reply without a verification and the member\'s words still are', () => {
  const shingles = evidenceShingles({ tickets: [{ subject: 'Synthetic', body: 'Synthetic opening', messages: [verifiedReply, ownerNote, memberAsk] }] });
  assert.ok(!shingles.has('the expired badge shows on the card once the'), 'the verified reply is the runner\'s own words');
  assert.ok(!shingles.has('credentialdomd support automated fixed and verified renewal list'));
  assert.ok(shingles.has('banner on the credentials page overlaps the search'), 'an admin reply with no verification still counts');
  assert.ok(shingles.has('reminder email name the licence that expires first'), 'the member\'s own words still count');
});

test('the report: a reproduction test named after an acceptance criterion passes when only the runner\'s verified reply repeats it', () => {
  const p = project({ 'tests/existing.test.mjs': '// Existing fixture\n' });
  try {
    const base = sh(p.repo, ['rev-parse', 'HEAD']);
    p.write(p.repo, { 'tests/renewal-badge.test.mjs': `test(${JSON.stringify(CRITERION)}, () => {});\n` });
    sh(p.repo, ['add', '-A']); sh(p.repo, ['commit', '-q', '-m', 'Synthetic reproduction']);
    const head = sh(p.repo, ['rev-parse', 'HEAD']);
    const thread = messages => ({ target_id: 'x', tickets: [{ id: 'x', subject: 'Synthetic', body: 'Synthetic opening', messages }] });
    assert.deepEqual(personalDataReport({ dir: p.repo, base, head, context: thread([memberAsk, verifiedReply]) }), { pass: true, hits: [], files: 1 });
    // The same words from the member, or from an admin reply the runner did not
    // verify, are still copied ticket text.
    const fromMember = personalDataReport({ dir: p.repo, base, head, context: thread([{ ...memberAsk, body: `I think ${CRITERION}, but it does not.` }, verifiedReply]) });
    assert.deepEqual(fromMember.hits, [{ rule: 'ticket_text', file: 'tests/renewal-badge.test.mjs' }]);
    const fromAdmin = personalDataReport({ dir: p.repo, base, head, context: thread([{ ...verifiedReply, verification_id: null }]) });
    assert.deepEqual(fromAdmin.hits, [{ rule: 'ticket_text', file: 'tests/renewal-badge.test.mjs' }]);
  } finally { p.cleanup(); }
});

test('the report: added lines only, a value already public at base is not counted, the runner\'s credential always is, and no value is recorded', async () => {
  const p = project({ 'tests/existing.test.mjs': `// Existing fixture: ${EMAIL} is already in the public repo\n` });
  try {
    const base = sh(p.repo, ['rev-parse', 'HEAD']);
    p.write(p.repo, {
      'tests/new.test.mjs': `const copied = '${EMAIL}';\nconst fresh = 'no-such-person-9b2c@yahoo.com';\nconst key = 'synthetic-runner-credential-0123';\n// renewal date is missing from the collapsed line on the phone\n`,
      'tests/scan.png': 'synthetic image bytes',
    });
    sh(p.repo, ['add', '-A']); sh(p.repo, ['commit', '-q', '-m', 'Synthetic']);
    const head = sh(p.repo, ['rev-parse', 'HEAD']);
    const report = personalDataReport({ dir: p.repo, base, head, secrets: ['synthetic-runner-credential-0123'],
      context: { tickets: [{ subject: 'x', body: 'My renewal date is missing from the collapsed line on the phone', messages: [] }] } });
    assert.equal(report.pass, false);
    assert.deepEqual(report.hits.map(h => `${h.rule}:${h.file}`).sort(), ['credential:tests/new.test.mjs', 'email:tests/new.test.mjs', 'media_in_tests:tests/scan.png', 'ticket_text:tests/new.test.mjs']);
    assert.ok(!JSON.stringify(report).includes('yahoo') && !JSON.stringify(report).includes('synthetic-runner-credential'), 'no value in the report');
    const clean = personalDataReport({ dir: p.repo, base: head, head, context: null });
    assert.deepEqual(clean, { pass: true, hits: [], files: 0 });
  } finally { p.cleanup(); }
});
