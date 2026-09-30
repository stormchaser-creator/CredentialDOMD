// The environment the QA lab gives the edge functions and the app, and the
// stack config it writes. The rules: every provider location is this machine
// (or a reserved .test name), every key is one the lab generated, feature
// switches are the only thing a run may override, and each name the lab sets
// is one a function actually reads. Uses freshly generated secrets: nothing
// under qa-lab/.generated/ is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_SWITCHES, SDK_HOST_VARIABLES, assertLabOnlyEnv, envFileText, functionsEnv } from '../../qa-lab/lib/functions-env.mjs';
import { generateLabSecrets } from '../../qa-lab/lib/lab-secrets.mjs';
import { stackConfigText } from '../../qa-lab/lib/stack.mjs';
import { productionAppFlags, qaAppEnv } from '../../qa-lab/lib/app-env.mjs';
import { LAB_ISSUER } from '../../qa-lab/lib/lab-config.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const secrets = generateLabSecrets();
const vault = { welcome_hook_secret: 'local-vault-hook-secret-0123456789abcdef' };
const make = (overrides = {}) => functionsEnv({ mockPort: 54380, appPort: 54390, overrides, secrets, vault });

function functionsSource() {
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full); else out.push(readFileSync(full, 'utf8'));
    }
  })(path.join(ROOT, 'supabase', 'functions'));
  return out.join('\n');
}

test('every provider location points at the mock server or a reserved .test name', () => {
  const env = make();
  for (const [name, value] of Object.entries(env)) {
    if (!/(_BASE|_URL|ISSUER)$/.test(name)) continue;
    const host = new URL(value).hostname;
    assert.ok(['host.docker.internal', '127.0.0.1'].includes(host) || host.endsWith('.qa.credentialdomd.test'), `${name} = ${value}`);
  }
  for (const name of ['CLERK_API_BASE', 'CLERK_JWKS_URL', 'STRIPE_API_BASE', 'RESEND_API_BASE', 'ANTHROPIC_API_BASE', 'GEMINI_API_BASE', 'ANTHROPIC_BASE_URL']) {
    assert.match(env[name], /^http:\/\/host\.docker\.internal:54380(\/|$)/, name);
  }
  assert.equal(env.CLERK_ISSUER, LAB_ISSUER);
  assert.equal(env.CLERK_PRODUCTION_ISSUER, LAB_ISSUER, 'initialize-clerk-profile verifies the lab issuer, not production\'s');
});

test('every key and secret is lab-generated; billing mode and key mode agree', () => {
  const env = make();
  const generated = JSON.stringify(secrets);
  for (const [name, value] of Object.entries(env)) {
    if (/(KEY|SECRET|TOKEN|PEPPER)$/.test(name)) assert.ok(generated.includes(`"${value}"`) || Object.values(vault).includes(value), `${name} is not lab-generated`);
  }
  assert.equal(env.WELCOME_HOOK_SECRET, vault.welcome_hook_secret, 'the functions accept what the local vault\'s triggers send');
  assert.equal(env.CREDENTIALDOMD_BILLING_MODE, 'live');
  assert.match(env.STRIPE_SECRET_KEY, /^sk_live_/);
  assert.match(env.CLERK_SECRET_KEY, /^sk_live_/);
});

test('assertLabOnlyEnv refuses real providers, foreign hosts and keys the lab did not make', () => {
  const env = make();
  assert.throws(() => assertLabOnlyEnv({ ...env, STRIPE_API_BASE: 'https://api.stripe.com' }, secrets, vault), /real provider/);
  assert.throws(() => assertLabOnlyEnv({ ...env, CLERK_JWKS_URL: 'https://clerk.credentialdomd.com/.well-known/jwks.json' }, secrets, vault), /real provider/);
  assert.throws(() => assertLabOnlyEnv({ ...env, RESEND_API_BASE: 'https://mail.example.com' }, secrets, vault), /this machine/);
  assert.throws(() => assertLabOnlyEnv({ ...env, RESEND_API_KEY: 're_notTheLabs_0123456789abcdef' }, secrets, vault), /not a lab-generated value/);
  assert.throws(() => assertLabOnlyEnv({ ...env, ANTHROPIC_API_BASE: 'https://api.anthropic.com' }, secrets, vault), /real provider/);
  assert.throws(() => assertLabOnlyEnv({ ...env, SOME_URL: 'https://project.supabase.co' }, secrets, vault), /real provider/);
  assert.throws(() => assertLabOnlyEnv({ ...env, FLAG: 'a\nb' }, secrets, vault), /one line/);
});

test('a run may override feature switches only', () => {
  assert.equal(make({ QA_FN_VERA_SOURCE_RETRIEVAL_ENABLED: 'true' }).VERA_SOURCE_RETRIEVAL_ENABLED, 'true');
  for (const name of ['QA_FN_STRIPE_SECRET_KEY', 'QA_FN_STRIPE_API_BASE', 'QA_FN_CLERK_ISSUER', 'QA_FN_SUPABASE_URL', 'QA_FN_WELCOME_HOOK_SECRET']) {
    assert.throws(() => make({ [name]: 'x' }), /cannot be overridden/, name);
  }
  assert.equal(make({ UNRELATED: 'x' }).UNRELATED, undefined, 'only QA_FN_ variables are read');
});

test('every name the lab sets is one a function reads (a typo would silently do nothing)', () => {
  const source = functionsSource();
  for (const name of Object.keys(make())) {
    if (name in SDK_HOST_VARIABLES) continue;   // read by a provider SDK, checked below
    assert.match(source, new RegExp(`["'\`(]${name}["'\`)]`), `no function reads ${name}`);
  }
  for (const name of Object.keys(FEATURE_SWITCHES)) assert.ok(name in make(), name);
});

test('a provider SDK that picks its own host is pointed at the mock through the variable the SDK reads', () => {
  const env = make();
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full); else if (/\.(ts|mjs|js)$/.test(name)) files.push([path.relative(ROOT, full), readFileSync(full, 'utf8')]);
    }
  })(path.join(ROOT, 'supabase', 'functions'));
  // Every Anthropic SDK client a function builds without a baseURL depends on ANTHROPIC_BASE_URL.
  const sdkUsers = files.filter(([, text]) => text.includes(SDK_HOST_VARIABLES.ANTHROPIC_BASE_URL.sdkImport));
  assert.ok(sdkUsers.length >= 1, 'a function imports the Anthropic SDK (email-inbound\'s understanding step)');
  for (const [rel, text] of sdkUsers) {
    for (const m of text.matchAll(/new Anthropic\(\{([^}]*)\}\)/g)) assert.doesNotMatch(m[1], /baseURL/, `${rel}: a client with its own baseURL needs its own lab override, not ANTHROPIC_BASE_URL`);
  }
  for (const [name, spec] of Object.entries(SDK_HOST_VARIABLES)) {
    assert.match(env[name], /^http:\/\/host\.docker\.internal:54380\//, `${name} points at the mock`);
    assert.ok(files.some(([, text]) => text.includes(spec.sdkImport)), `${name}: some function imports ${spec.sdkImport}`);
    // The installed SDK (the version the functions pin) reads the variable for its host.
    const sdk = readFileSync(path.join(ROOT, spec.sdkFile), 'utf8');
    assert.ok(sdk.includes(spec.read), `${spec.sdkFile} reads ${name}`);
    const pinned = files.map(([, text]) => (text.match(/npm:@anthropic-ai\/sdk@([\d.]+)/) || [])[1]).filter(Boolean);
    const installed = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'), 'utf8')).version;
    for (const v of pinned) assert.equal(v, installed, `the functions pin @anthropic-ai/sdk@${v}; the SDK checked here is ${installed}`);
  }
  assert.throws(() => assertLabOnlyEnv({ ...env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, secrets, vault), /real provider/);
});

test('the env file is plain name=value lines', () => {
  const text = envFileText(make());
  for (const line of text.split('\n').filter((l) => l && !l.startsWith('#'))) assert.match(line, /^[A-Z][A-Z0-9_]*=[^\n]*$/);
});

test('the lab stack config: the template plus the function environment, nothing else', () => {
  const source = readFileSync(path.join(ROOT, 'qa-lab', 'supabase-config.template.toml'), 'utf8');
  const env = make();
  const text = stackConfigText(env, source);
  assert.match(text, /^signing_keys_path = "\.\/signing_keys\.json"$/m);
  assert.match(text, /^sql_paths = \[\]$/m);
  assert.match(text, /^\[edge_runtime\.secrets\]$/m);
  assert.ok(text.includes(`STRIPE_API_BASE = "${env.STRIPE_API_BASE}"`));
  // Everything else is the template line for line.
  const added = text.split('\n').filter((l) => !source.split('\n').includes(l));
  for (const line of added) assert.ok(/^#|^\[edge_runtime\.secrets\]$|^[A-Z][A-Z0-9_]* = "|^$/.test(line), `unexpected line: ${line}`);
  assert.throws(() => stackConfigText({ BAD: 'has "quote"' }, source), /plain one-line/);
  assert.throws(() => stackConfigText(null, source.replace('signing_keys_path = "./signing_keys.json"', '# signing_keys_path = "./signing_keys.json"')), /changed shape/);
  assert.throws(() => stackConfigText(null, source.replace('sql_paths = []', 'sql_paths = ["../qa-lab/seed.sql"]')), /changed shape/);
});

test('the QA app build gets the deploy\'s switches, the local stack and the QA flag, and drops the caller\'s VITE_* values', () => {
  const flags = productionAppFlags();
  assert.equal(flags.VITE_CLERK_CONTINUITY_ENABLED, 'true');
  assert.ok(!('VITE_QA_LAB' in flags));
  const env = qaAppEnv({ appPort: 54390, apiPort: 54385, anonKey: 'local-anon', base: { PATH: '/bin', VITE_SUPABASE_URL: 'https://project.example.com', VITE_ANYTHING: 'x' } });
  assert.equal(env.VITE_QA_LAB, '1');
  // The lab's API proxy: this machine, another origin than the app, so the browser checks CORS as it does live.
  assert.equal(env.VITE_SUPABASE_URL, 'http://127.0.0.1:54385');
  assert.equal(env.QA_LAB_APP_PORT, '54390');
  assert.throws(() => qaAppEnv({ appPort: 54390, apiPort: 54390, anonKey: 'k', base: {} }), /another port/);
  assert.equal(env.VITE_ANYTHING, undefined);
  assert.equal(env.PATH, '/bin');
  for (const [k, v] of Object.entries(flags)) assert.equal(env[k], v, k);
});
