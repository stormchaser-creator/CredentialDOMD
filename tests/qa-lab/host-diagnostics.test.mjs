import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { hostCommandDiagnostics, sanitizeHostOutput } from '../../qa-lab/e2e/support/host-diagnostics.mjs';

const source = readFileSync(new URL('../../qa-lab/e2e/ops-host.spec.mjs', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'js', format: 'cjs' }).code;

test('both complete diagnostic streams and exact process failure survive sanitization', () => {
  const stdout = Array.from({ length: 1000 }, (_, n) => `ok ${n} - synthetic test\n`).join('') + 'not ok 1000 - expected lock release\n  error: wait timed out\n';
  const out = hostCommandDiagnostics({ stdout, stderr: 'Warning: child stderr\nstack: tests/ticket-fix/example.test.mjs:42\n', status: 1, signal: null, ms: 168111, ignoredProviderResult: { secret: 'not-for-artifact' } }, { command: ['node', '--test', 'tests/ticket-fix/example.test.mjs'] });
  assert.equal(out.stdout, stdout); assert.match(out.stderr, /example.test.mjs:42/);
  assert.equal(out.exitCode, 1); assert.equal(out.durationMs, 168111); assert.equal(out.signal, null);
  assert.ok(!JSON.stringify(out).includes('not-for-artifact'));
  const killed = hostCommandDiagnostics({ status: null, signal: 'SIGTERM', error: 'spawnSync node ETIMEDOUT', ms: 600000, stdout: 'partial before timeout', stderr: 'last stderr' });
  assert.equal(killed.exitCode, null); assert.equal(killed.signal, 'SIGTERM'); assert.match(killed.error, /ETIMEDOUT/);
  assert.equal(killed.stdout, 'partial before timeout'); assert.equal(killed.stderr, 'last stderr');
});

test('credentials and labeled raw provider payloads are excluded while assertion locations remain', () => {
  const raw = '\x1b[31mnot ok 7\x1b[0m\n  error: expected true\n  body: {\n    patient: "sensitive response"\n  }\n  stack: tests/ticket-fix/example.test.mjs:42\nAuthorization: Bearer hidden-value\nSERVICE_ROLE_KEY=opaque-value\nprivate arbitrary secret\nshort pw\nraw provider response: confidential text\n{"content":[{"text":"private provider message"}]}\n-----BEGIN PRIVATE KEY-----\nprivate-key-bytes\n-----END PRIVATE KEY-----';
  const safe = sanitizeHostOutput(raw, { MODEL_SECRET: 'private arbitrary secret', TEST_PASSWORD: 'pw', NON_SECRET_EMPTY: '' });
  for (const forbidden of ['sensitive response', 'hidden-value', 'opaque-value', 'private arbitrary secret', 'short pw', 'confidential text', 'private provider message', 'private-key-bytes', '\x1b']) assert.ok(!safe.includes(forbidden), forbidden);
  assert.match(safe, /not ok 7/); assert.match(safe, /error: expected true/); assert.match(safe, /example.test.mjs:42/);
});

test('same-indent JSON provider payloads are removed through their closing delimiter', () => {
  for (const payload of ['{\n  "patient": "synthetic-sensitive-body", "nested": {"text": "brace } in string"}\n}', '[\n  {"patient": "synthetic-sensitive-body"}\n]']) {
    const safe = sanitizeHostOutput(`raw provider response:\n${payload}\nstack: tests/ticket-fix/example.test.mjs:42`);
    assert.ok(!safe.includes('synthetic-sensitive-body'));
    assert.ok(!safe.includes('brace } in string'));
    assert.match(safe, /example.test.mjs:42/);
  }
});

test('the actual OPS-009 wrapper attaches diagnostics before asserting a child failure', async () => {
  const registered = [], checks = [], attachments = [], calls = [];
  const secret = 'synthetic-env-secret';
  const require = createRequire(import.meta.url);
  const helpers = {
    REPO_ROOT: '/synthetic', repoFile: () => '', stackKeys: () => { throw new Error('No lab access allowed'); },
    nodeTestSummary: () => ({ tests: 344, pass: 343, fail: 1, skipped: 0, cancelled: 0 }),
    hostRun(command, args) {
      calls.push([command, args]);
      if (command === 'git') return { status: 0, stdout: 'tests/ticket-fix/example.test.mjs\n', stderr: '' };
      if (command === 'python3') return { status: 0, stdout: 'synthetic contract passed\n', stderr: '', ms: 1 };
      return { status: 1, stdout: `not ok 9 - reproducer failed\n  error: ${secret}\n`, stderr: 'failure stack: example.test.mjs:9\n', ms: 123 };
    },
  };
  vm.runInNewContext(code, { module: { exports: {} }, exports: {}, process: { execPath: '/synthetic/node', env: { TOKEN: secret } },
    require(name) {
      if (name.startsWith('node:')) return require(name);
      if (name === './support/fixtures.mjs') return { test: Object.assign((title, options, fn) => registered.push({ title, fn }), { setTimeout() {} }) };
      if (name === './support/host-diagnostics.mjs') return { hostCommandDiagnostics };
      if (name === './support/ops-helpers.mjs') return helpers;
      if (name === './support/lab.mjs') return { lab: () => { throw new Error('No runtime access allowed'); } };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const ticket = registered.find(t => t.title.startsWith('ticket agent:')); assert.ok(ticket);
  await ticket.fn({ qa: { feature: async (_id, name, fn) => { if (name.startsWith("the runner's harness")) await fn(); }, check: (name, ok) => { checks.push({ name, ok, attachmentsAlreadyPresent: attachments.length }); } } },
    { attach: async (name, { body, contentType }) => attachments.push({ name, contentType, report: JSON.parse(body) }) });
  assert.equal(attachments.length, 2); assert.equal(attachments[0].name, 'ticket-agent-node-diagnostics.json');
  assert.equal(attachments[1].name, 'ticket-agent-cli-diagnostics.json');
  assert.equal(attachments[0].report.exitCode, 1); assert.match(attachments[0].report.stdout, /reproducer failed/);
  assert.match(attachments[0].report.stderr, /example.test.mjs:9/); assert.ok(!JSON.stringify(attachments).includes(secret));
  assert.equal(checks[0].ok, false, 'retaining evidence must not turn a failed run green');
  assert.equal(checks[0].attachmentsAlreadyPresent, 1); assert.equal(checks[1].ok, true);
  assert.equal(calls.filter(([cmd]) => cmd === '/synthetic/node').length, 1, 'no child retries');
  calls.length = 0; checks.length = 0;
  await assert.rejects(ticket.fn({ qa: { feature: async (_id, name, fn) => { if (name.startsWith("the runner's harness")) await fn(); }, check: (...args) => checks.push(args) } },
    { attach: async () => { throw new Error('attachment unavailable'); } }), /attachment unavailable/);
  assert.equal(checks.length, 0, 'failed evidence cannot reach a green assertion');
  assert.equal(calls.filter(([cmd]) => cmd === '/synthetic/node').length, 1, 'attachment failure does not rerun the child');
});
