import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import { captureLaunchInvitation, redactLaunchInvitation } from '../../src/utils/launchInvitation.js';

const token = 'synthetic_only_launch_token_A1b2c3d4e5f6g7h8j9k0';
const url = `https://app.invalid/app/?view=membership#launch_invite=${token}&tab=help`;
const source = await readFile(new URL('../../src/lib/errorReport.js', import.meta.url), 'utf8');

// Execute real reporting code with fake sendBeacon/fetch and synthetic strings.
// No account, provider, database or network endpoint is accessed by these tests.
function reporter({ href = url, dev = false, beacon = true } = {}) {
  const reports = [], logs = [], listeners = new Map();
  const location = new URL(href);
  const navigator = { userAgent: 'Synthetic browser', sendBeacon: (_target, body) => {
    if (!beacon) return false;
    reports.push({ transport: 'beacon', body: JSON.parse(body) }); return true;
  } };
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, Error, location, navigator,
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    console: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    fetch: async (_target, options) => { reports.push({ transport: 'fetch', body: JSON.parse(options.body) }); return {}; },
    require: name => {
      if (name === 'react') return { Component: class {}, createElement: (...args) => args };
      if (name === '../utils/launchInvitation.js') return { redactLaunchInvitation };
      throw Error(`Unexpected reporting dependency: ${name}`);
    },
  });
  vm.runInContext(transformSync(source, { loader: 'js', format: 'cjs', define: {
    'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://report.invalid', DEV: dev }),
    '__APP_BUILD_ID__': '"synthetic-build"',
  } }).code, context);
  return { api: module.exports, location, reports, logs, listeners };
}

test('redaction preserves unrelated URL fields for raw, encoded and quoted invitation values', () => {
  for (const [input, expected] of [
    [url, 'https://app.invalid/app/?view=membership#launch_invite=[redacted]&tab=help'],
    [`?launch_invite=${token}&keep=yes#anchor`, '?launch_invite=[redacted]&keep=yes#anchor'],
    [`%23launch_invite%3D${token}%26tab%3Dhelp`, '%23launch_invite%3D[redacted]%26tab%3Dhelp'],
    [`#%6Caunch%5Finvite=${token}&tab=help`, '#%6Caunch%5Finvite=[redacted]&tab=help'],
    [`{"launch_invite":"${token}","keep":"yes"}`, '{"launch_invite":"[redacted]","keep":"yes"}'],
    ['#launch_invite=short&keep=yes', '#launch_invite=[redacted]&keep=yes'],
  ]) {
    assert.equal(redactLaunchInvitation(input), expected);
    assert.equal(redactLaunchInvitation(expected), expected);
  }
  const ordinary = 'https://app.invalid/app/?keep=yes#tab=help&not_launch_invite=ordinary';
  assert.equal(redactLaunchInvitation(ordinary), ordinary);
});

test('failed history cleanup cannot leak the invitation through a report URL, message, stack or extra', () => {
  const f = reporter();
  const values = new Map([['credentialdomd.launch_invitation', token]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  assert.equal(captureLaunchInvitation({ location: f.location, history: { replaceState() { throw Error('Synthetic history failure'); } }, storage }), null);
  assert.equal(values.size, 0);
  assert.ok(f.location.href.includes(token)); // The browser refused cleanup.
  const error = new Error(`Synthetic report at ${url}`);
  error.stack = `Error: Synthetic report\n    at render (${url})`;
  const extra = { source: url, nested: { filename: url, launch_invite: token }, line: 12, col: 4 };
  f.api.reportError(error, 'error', extra);
  assert.equal(f.reports.length, 1);
  const payload = f.reports[0].body;
  assert.equal(JSON.stringify(payload).includes(token), false);
  assert.ok(payload.message.includes('launch_invite=[redacted]&tab=help'));
  assert.ok(payload.stack.includes('launch_invite=[redacted]&tab=help'));
  assert.ok(payload.url.includes('launch_invite=[redacted]&tab=help'));
  assert.equal(payload.extra.nested.launch_invite, '[redacted]');
  assert.equal(payload.extra.line, 12);
  assert.equal(extra.nested.launch_invite, token); // Reporting does not mutate input.
});

test('global error filenames are scrubbed before their shorter clipping boundary', () => {
  const f = reporter({ href: 'https://app.invalid/app/#tab=help' });
  f.api.install();
  f.listeners.get('error')({ message: 'Synthetic script crash', filename: `${'x'.repeat(269)}#launch_invite=${token}`, lineno: 14, colno: 2 });
  const payload = f.reports[0].body;
  assert.equal(payload.extra.source.includes('synthetic_only'), false);
  assert.ok(payload.extra.source.includes('[redacted]'));
  assert.equal(payload.extra.line, 14);
  assert.equal(payload.url, 'https://app.invalid/app/#tab=help');
});

test('redacting before clipping also retains existing API-secret protection', () => {
  const f = reporter();
  const error = new Error(`${'x'.repeat(987)} sk_test_${'A'.repeat(32)}`);
  error.stack = `${'x'.repeat(3980)}#launch_invite=${token}`;
  f.api.reportError(error);
  const payload = f.reports[0].body;
  assert.equal(payload.message.includes('sk_test_'), false);
  assert.equal(payload.stack.includes('synthetic_'), false);
  assert.ok(payload.message.endsWith('[redacted]'));
});

test('invitation values crossing the report URL 500-character limit are redacted before clipping', () => {
  const prefix = 'https://app.invalid/app/?pad=';
  const href = `${prefix}${'x'.repeat(475 - prefix.length)}#launch_invite=${token}&tab=help`;
  const f = reporter({ href });
  f.api.reportError('Synthetic long URL crash');
  const reportedUrl = f.reports[0].body.url;
  assert.equal(reportedUrl.includes(token.slice(0, 10)), false);
  assert.ok(reportedUrl.includes('launch_invite=[redacted]'));
  assert.ok(reportedUrl.startsWith(prefix));
  assert.ok(reportedUrl.length <= 501);
});

test('fallback fetch and development logging only receive scrubbed payloads', () => {
  const fallback = reporter({ beacon: false });
  fallback.api.reportError(`Synthetic fallback ${url}`, 'error', { filename: url });
  assert.equal(fallback.reports[0].transport, 'fetch');
  assert.equal(JSON.stringify(fallback.reports).includes(token), false);
  const dev = reporter({ dev: true });
  dev.api.reportError(`Synthetic dev ${url}`, 'error', { filename: url });
  assert.equal(dev.reports.length, 0);
  assert.equal(dev.logs.length, 1);
  assert.equal(JSON.stringify(dev.logs).includes(token), false);
});

test('React console diagnostics and component stacks cannot expose invitation URLs', () => {
  const f = reporter();
  const error = new Error(`Synthetic React crash ${url}`);
  error.stack = `Synthetic stack ${url}`;
  new f.api.ErrorBoundary({}).componentDidCatch(error, { componentStack: `Synthetic component (${url})` });
  assert.equal(f.logs.length, 1);
  assert.equal(JSON.stringify(f.logs).includes(token), false);
  assert.equal(JSON.stringify(f.reports).includes(token), false);
  assert.ok(f.reports[0].body.extra.componentStack.includes('[redacted]'));
});

test('ordinary reports keep fields, duplicate suppression and the session cap', () => {
  const f = reporter({ href: 'https://app.invalid/app/?page=docs#tab=help' });
  f.api.setErrorUser('user_synthetic');
  f.api.reportError('Synthetic ordinary crash', 'error', { source: 'app.js', line: 3, detail: ['one', 2, false] });
  f.api.reportError('Synthetic ordinary crash', 'error');
  assert.equal(f.reports.length, 1);
  const payload = f.reports[0].body;
  assert.equal(payload.message, 'Synthetic ordinary crash');
  assert.equal(payload.url, 'https://app.invalid/app/?page=docs#tab=help');
  assert.equal(payload.auth_user_id, 'user_synthetic');
  assert.deepEqual(payload.extra, { source: 'app.js', line: 3, detail: ['one', 2, false] });
  for (let i = 0; i < 30; i++) f.api.reportError(`Synthetic ordinary crash ${i}`);
  assert.equal(f.reports.length, 25);
});
