// QA OPS-006: the web deploy runs only when a push touches a path in
// .github/workflows/deploy-gh-pages.yml `on.push.paths`. The app bundle
// imports server modules from supabase/functions/_shared (access policy,
// member view, Vera source registry, credential portal view), and the build
// scripts import other scripts; a fix pushed to only one of those passed the
// tests and left the live bundle on the old logic until some unrelated src/
// change deployed. This walks the real import graph from src/ and the build
// entry points and requires every file outside src/ to match the filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importClosure } from '../../scripts/import-graph.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-gh-pages.yml'), 'utf8');

/** The `on.push.paths` globs, in order. */
export function deployPaths(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^\s{4}paths:\s*$/.test(l));
  assert.ok(start >= 0, 'on.push.paths not found');
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s{6}-\s*'([^']+)'\s*$/) || line.match(/^\s{6}-\s*"([^"]+)"\s*$/) || line.match(/^\s{6}-\s*(\S+)\s*$/);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full);
    return /\.(m?js|jsx|ts)$/.test(e.name) ? [full] : [];
  });
}

// What the deploy job builds: the app (everything under src/, through vite)
// and the scripts `npm run build:site` and the help check run.
const BUILD_ENTRIES = ['vite.config.js', 'scripts/build-credential-portal.mjs', 'scripts/package-site.mjs', 'scripts/build-help.mjs'];

test('every file outside src/ that the app or its build imports triggers the deploy', () => {
  const patterns = deployPaths(WORKFLOW).map(globToRegExp);
  const entries = [...walk(path.join(ROOT, 'src')), ...BUILD_ENTRIES.map((f) => path.join(ROOT, f))];
  const outside = importClosure(entries).map((f) => path.relative(ROOT, f)).filter((f) => !f.startsWith('src/'));
  // supabase/functions/_shared/app/** is a generated mirror of src/**
  // (scripts/sync-shared-app-modules.mjs); its source already triggers.
  const mirrored = (f) => f.startsWith('supabase/functions/_shared/app/') && fs.existsSync(path.join(ROOT, 'src', f.slice('supabase/functions/_shared/app/'.length)));
  const uncovered = outside.filter((f) => !mirrored(f) && !patterns.some((re) => re.test(f)));
  assert.deepEqual(uncovered, [], 'add these to on.push.paths in .github/workflows/deploy-gh-pages.yml');
  assert.ok(outside.includes('supabase/functions/_shared/billingCatalog.mjs'), 'the walk reaches the server modules the bundle imports');
});

test('the path parser and glob matching read the workflow the way GitHub does', () => {
  const paths = deployPaths(WORKFLOW);
  assert.ok(paths.includes('src/**'));
  assert.ok(globToRegExp('src/**').test('src/components/pages/App.jsx'));
  assert.ok(!globToRegExp('scripts/*.mjs').test('scripts/ticket-fix/run.mjs'));
  assert.ok(globToRegExp('supabase/functions/_shared/memberView.mjs').test('supabase/functions/_shared/memberView.mjs'));
});
