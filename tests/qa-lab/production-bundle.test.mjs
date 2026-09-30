// The QA lab's sign-in never reaches production.
//
// Production is built by the repository's vite.config.js (npm run build:site in
// .github/workflows/deploy-gh-pages.yml). The QA sign-in (qa-lab/app/) is only
// reachable through qa-lab/app/vite.config.mjs, which aliases
// "@clerk/clerk-react" to it and refuses to run without VITE_QA_LAB=1. These
// tests pin both halves: nothing production builds from names the lab, and an
// actual production build (same config, same plugins that shape the bundle,
// the deploy's VITE_* switches) contains none of the lab's sign-in code and
// still contains the real Clerk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionAppFlags } from '../../qa-lab/lib/app-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

// Strings only the lab's sign-in carries (qa-lab/app/*). Any of them in a
// production bundle means the QA sign-in shipped.
const QA_SIGNIN_MARKERS = [
  'qa-signin', 'qa_lab_session', '/__qa/mock', '/__qa/sb', '/qa/stripe/hosted', 'QA-lab sign-in', 'Sign in as a test physician',
  'clerk.qa.credentialdomd.test', 'clerk-legacy.qa.credentialdomd.test', 'qa.credentialdomd.test', 'isQaLab', 'signInAs',
];

test('nothing in the production build graph names the QA lab', () => {
  for (const file of files(path.join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    assert.doesNotMatch(text, /qa-lab|VITE_QA_LAB|qa-clerk|clerk-shim|QaSignIn/, `${rel} names the QA lab`);
  }
  for (const rel of ['vite.config.js', 'index.html']) assert.doesNotMatch(read(rel), /qa-lab|VITE_QA_LAB/, `${rel} names the QA lab`);
  const pkg = JSON.parse(read('package.json'));
  for (const name of ['build', 'build:site', 'dev', 'preview']) assert.doesNotMatch(pkg.scripts[name], /qa-lab|VITE_QA_LAB/, `npm run ${name} names the QA lab`);
});

test('no workflow sets the QA-lab flag or builds with the QA-lab config', () => {
  for (const file of files(path.join(ROOT, '.github', 'workflows'))) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /VITE_QA_LAB|qa-lab\/app\/vite\.config/, `${path.relative(ROOT, file)} would build the QA lab`);
  }
});

test('the QA-lab vite config refuses to build without VITE_QA_LAB=1, with a remote Supabase URL, or with the API on the app\'s origin', async () => {
  const saved = { lab: process.env.VITE_QA_LAB, url: process.env.VITE_SUPABASE_URL, port: process.env.QA_LAB_APP_PORT };
  try {
    const { default: config } = await import('../../qa-lab/app/vite.config.mjs');
    delete process.env.VITE_QA_LAB;
    assert.throws(() => config({ command: 'build', mode: 'production' }), /VITE_QA_LAB=1/);
    process.env.VITE_QA_LAB = '1';
    process.env.VITE_SUPABASE_URL = 'https://project.example.com';
    assert.throws(() => config({ command: 'build', mode: 'production' }), /not this machine/);
    // Same origin as the app: the browser would never check the functions' CORS headers.
    process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:54390/__qa/sb';
    process.env.QA_LAB_APP_PORT = '54390';
    assert.throws(() => config({ command: 'build', mode: 'production' }), /another origin/);
    process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:54385';
    assert.doesNotThrow(() => config({ command: 'build', mode: 'production' }));
  } finally {
    for (const [k, v] of [['VITE_QA_LAB', saved.lab], ['VITE_SUPABASE_URL', saved.url], ['QA_LAB_APP_PORT', saved.port]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

/**
 * Builds the app with the repository's vite.config.js into a temporary folder
 * and returns its emitted text. `qa` adds exactly what the QA-lab config adds
 * to the bundle (the Clerk alias and VITE_QA_LAB=1), as the negative control.
 */
async function buildApp({ qa = false } = {}) {
  const { build } = await import('vite');
  const { default: baseConfig } = await import('../../vite.config.js');
  const out = mkdtempSync(path.join(tmpdir(), 'credentialdomd-bundle-'));
  const envDir = mkdtempSync(path.join(tmpdir(), 'credentialdomd-bundle-env-'));
  const saved = { ...process.env };
  try {
    // The deploy's environment: its literal switches, placeholder connection values, no QA flag.
    for (const k of Object.keys(process.env)) if (k.startsWith('VITE_')) delete process.env[k];
    Object.assign(process.env, productionAppFlags(), {
      VITE_SUPABASE_URL: 'https://project.example.com', VITE_SUPABASE_ANON_KEY: 'placeholder-anon-key',
      VITE_CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from('clerk.example.com$').toString('base64')}`,
    }, qa ? { VITE_QA_LAB: '1', VITE_SUPABASE_URL: 'http://127.0.0.1:54385' } : {});
    // stamp-build-id and assert-precache write and check the repository's dist/
    // (the service worker stamp and version.json); they do not change the bundle.
    const plugins = baseConfig.plugins.filter((p) => !(p && !Array.isArray(p) && ['stamp-build-id', 'assert-precache'].includes(p.name)));
    await build({
      ...baseConfig, configFile: false, root: ROOT, base: '/app/', mode: 'production', envDir, logLevel: 'silent', plugins,
      ...(qa ? { resolve: { alias: [{ find: /^@clerk\/clerk-react$/, replacement: fileURLToPath(new URL('../../qa-lab/app/clerk-shim.jsx', import.meta.url)) }] } } : {}),
      build: { ...baseConfig.build, outDir: out, emptyOutDir: true },
    });
    return [...files(out)].filter((f) => /\.(js|html|css)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(out, { recursive: true, force: true });
    rmSync(envDir, { recursive: true, force: true });
  }
}

test('a production build contains no QA sign-in code, and does contain Clerk', { timeout: 240000 }, async () => {
  const js = await buildApp();
  assert.ok(js.length > 100000, 'the production build emitted its bundle');
  for (const marker of QA_SIGNIN_MARKERS) assert.ok(!js.includes(marker), `the production bundle contains QA-lab code: ${marker}`);
  // The real Clerk SDK is what production signs in with (the shim replaces exactly this package).
  assert.match(js, /clerk-react|ClerkProvider|clerk\.browser/i, 'the production bundle contains the Clerk SDK');
  assert.match(js, /clerk\.credentialdomd\.com/, 'the production bundle keeps the production Clerk issuer');
  // Checkout and the billing portal still go to Stripe's own pages (the lab's stand-in rewrite is QA-build only).
  assert.match(js, /checkout\.stripe\.com/);
  assert.match(js, /billing\.stripe\.com/);
});

test('negative control: the same build with the QA-lab alias does contain the markers', { timeout: 240000 }, async () => {
  const js = await buildApp({ qa: true });
  const found = QA_SIGNIN_MARKERS.filter((m) => js.includes(m));
  for (const marker of ['qa-signin', 'qa_lab_session', '/__qa/mock', 'Sign in as a test physician', 'signInAs']) assert.ok(found.includes(marker), `the QA build lacks ${marker}: the marker list no longer detects the QA sign-in`);
});
