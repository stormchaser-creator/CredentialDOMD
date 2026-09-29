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
