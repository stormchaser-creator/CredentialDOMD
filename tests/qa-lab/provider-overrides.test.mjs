// The base-URL overrides the QA lab added to the edge functions change nothing
// in production: production sets none of these variables, and without them
// every function calls the real provider exactly as before. The lab sets them
// (qa-lab/lib/functions-env.mjs) to reach its mocks.
//
// Also a guard: a provider URL written into a function without an override
// would make that function unreachable from the lab (it would call the real
// provider with a lab key and fail), so every provider host literal must be an
// override's default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FUNCTIONS = path.join(ROOT, 'supabase', 'functions');
const read = (rel) => readFileSync(path.join(FUNCTIONS, rel), 'utf8');

/** Loads a TypeScript module in a sandbox whose Deno.env holds exactly `env`; network and esm.sh imports are stubbed. */
function load(rel, env = {}) {
  const code = transformSync(read(rel), { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  const Deno = { env: { get: (k) => env[k] } };
  vm.runInNewContext(code, { module, exports: module.exports, Deno, URL, AbortSignal, require: () => ({ default: class {} }), fetch() { throw new Error('network forbidden'); } });
  return module.exports;
}

test('Clerk locations: the real ones unless the lab names its mock', () => {
  const prod = load('_shared/clerkContinuity.ts');
  assert.equal(prod.PRODUCTION_CLERK_ISSUER, 'https://clerk.credentialdomd.com');
  assert.equal(prod.CLERK_API_BASE, 'https://api.clerk.com');
  assert.equal(prod.clerkJwksUrl('https://clerk.credentialdomd.com').href, 'https://clerk.credentialdomd.com/.well-known/jwks.json');
  assert.equal(prod.clerkJwksUrl('https://dev-instance.clerk.accounts.dev/').href, 'https://dev-instance.clerk.accounts.dev/.well-known/jwks.json');
  const blank = load('_shared/clerkContinuity.ts', { CLERK_PRODUCTION_ISSUER: '', CLERK_API_BASE: '  ', CLERK_JWKS_URL: '' });
  assert.equal(blank.PRODUCTION_CLERK_ISSUER, 'https://clerk.credentialdomd.com', 'an empty value is unset');
  assert.equal(blank.CLERK_API_BASE, 'https://api.clerk.com');
  const lab = load('_shared/clerkContinuity.ts', { CLERK_PRODUCTION_ISSUER: 'https://clerk.qa.credentialdomd.test', CLERK_API_BASE: 'http://host.docker.internal:54380/clerk/', CLERK_JWKS_URL: 'http://host.docker.internal:54380/clerk/.well-known/jwks.json' });
  assert.equal(lab.PRODUCTION_CLERK_ISSUER, 'https://clerk.qa.credentialdomd.test');
  assert.equal(lab.CLERK_API_BASE, 'http://host.docker.internal:54380/clerk');
  assert.equal(lab.clerkJwksUrl('https://clerk.qa.credentialdomd.test').href, 'http://host.docker.internal:54380/clerk/.well-known/jwks.json');
});

test('Clerk Backend API reads go to api.clerk.com by default', async () => {
  const prod = load('_shared/clerkContinuity.ts');
  let seen = null;
  await prod.readProductionIdentity('user_Synthetic', 'sk_live_synthetic', async (url) => { seen = url; return new Response('{}', { status: 404 }); }).catch(() => {});
  assert.equal(seen, 'https://api.clerk.com/v1/users/user_Synthetic');
});

test('Stripe: the SDK keeps its own host unless STRIPE_API_BASE is set', () => {
  const load2 = (env) => { const m = load('_shared/billingDependencies.ts', env); return { stripeHostOptions: (...a) => JSON.parse(JSON.stringify(m.stripeHostOptions(...a))) }; };
  const prod = load2();
  assert.deepEqual(prod.stripeHostOptions(), {}, 'production passes no host, port or protocol');
  assert.deepEqual(prod.stripeHostOptions(''), {});
  const lab = load2({ STRIPE_API_BASE: 'http://host.docker.internal:54380' });
  assert.deepEqual(lab.stripeHostOptions(), { host: 'host.docker.internal', port: '54380', protocol: 'http' });
  assert.deepEqual(prod.stripeHostOptions('https://stripe.qa.credentialdomd.test'), { host: 'stripe.qa.credentialdomd.test', port: '443', protocol: 'https' });
  assert.throws(() => prod.stripeHostOptions('http://host.docker.internal:54380/v1'), /bare http\(s\) origin/);
  assert.throws(() => prod.stripeHostOptions('ftp://x'), /bare http\(s\) origin/);
});

// Each override, exactly as written, with the real provider as its default.
const OVERRIDES = [
  ['ai-proxy/index.ts', 'GEMINI_API_BASE', 'https://generativelanguage.googleapis.com'],
  ['ai-proxy/index.ts', 'ANTHROPIC_API_BASE', 'https://api.anthropic.com'],
  ['admin-shared-key/index.ts', 'GEMINI_API_BASE', 'https://generativelanguage.googleapis.com'],
  ['email-inbound/index.ts', 'GEMINI_API_BASE', 'https://generativelanguage.googleapis.com'],
  ['email-inbound/index.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['send-guide/index.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['send-invite/index.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['send-reminders/index.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['send-ticket-reply/index.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['send-welcome/index.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['send-packet-email/index.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['forwarding-address/index.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['build-backup/index.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['_shared/credentialPortalDependencies.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['_shared/supportDependencies.ts', 'RESEND_API_BASE', 'https://api.resend.com'],
  ['_shared/telegram.ts', 'TELEGRAM_API_BASE', 'https://api.telegram.org'],
];

test('every override defaults to the real provider when its variable is unset', () => {
  for (const [rel, name, real] of OVERRIDES) {
    const text = read(rel);
    const quoted = `["']${name}["']`;
    const re = new RegExp(`(?:Deno\\.env\\.get|env)\\(${quoted}\\)\\s*(?:\\|\\||\\?\\?)\\s*["']${real.replace(/[.]/g, '\\.')}["']`);
    assert.match(text, re, `${rel}: ${name} must fall back to ${real}`);
  }
});

const PROVIDER_HOST = /https:\/\/(api\.clerk\.com|clerk\.credentialdomd\.com|api\.stripe\.com|api\.resend\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.telegram\.org)/g;

test('no function calls a provider host except through an override (comments aside)', () => {
  const problems = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|mjs|js)$/.test(name)) continue;
      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/(^|[^:])\/\/.*$/, '$1');   // a // comment, not the // of a URL
        if (/^\s*(\*|\/\*)/.test(line)) return;   // block comment lines
        for (const m of code.matchAll(PROVIDER_HOST)) {
          const before = code.slice(0, m.index);
          if (/(\|\||\?\?)\s*["'`]$/.test(before)) continue;   // an override's default
          problems.push(`${path.relative(ROOT, full)}:${i + 1}: ${line.trim().slice(0, 140)}`);
        }
      });
    }
  })(FUNCTIONS);
  assert.deepEqual(problems, [], 'give each new provider URL a *_API_BASE override that defaults to it (see _shared/clerkContinuity.ts)');
});
