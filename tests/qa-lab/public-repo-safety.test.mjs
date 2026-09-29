import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROD_PROJECT_REF } from '../../qa-lab/lib/management-api.mjs';

// THE REPOSITORY IS PUBLIC. The QA lab's committed files hold configuration and
// synthetic test data only: no member data, no production rows, no secrets, and
// nothing generated from production's catalog (that lives in the gitignored
// qa-lab/.generated/).
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LAB = path.join(ROOT, 'qa-lab');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

function* committedLabFiles(dir = LAB) {
  for (const name of readdirSync(dir)) {
    if (name === '.generated' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* committedLabFiles(full);
    else yield full;
  }
}

const SECRET_SHAPES = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/, /\bwhsec_[A-Za-z0-9]{8,}/, /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{6,}/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/, /\bAIza[0-9A-Za-z_-]{30,}/, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

test('seed.sql addresses are synthetic, on the reserved qa.credentialdomd.test domain', () => {
  const seed = read('qa-lab/seed.sql');
  const addresses = seed.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  assert.ok(addresses.length > 0);
  for (const a of addresses) assert.match(a, /@qa\.credentialdomd\.test$/, a);
});

test('seed.sql writes configuration tables only (never members, admins or secrets)', () => {
  const sql = read('qa-lab/seed.sql').replace(/--[^\n]*/g, '');
  const written = [...sql.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+([a-z_.]+)/gi)].map((m) => m[1]);
  const allowed = new Set(['public.access_policy_settings', 'public.vera_source_settings', 'qa_lab.seed_version']);
  for (const t of written) assert.ok(allowed.has(t), `seed writes ${t}`);
  const calls = [...sql.matchAll(/select\s+(public\.[a-z_]+)\(/gi)].map((m) => m[1]);
  assert.deepEqual(calls, ['public.seal_limited_free_beta_cohort', 'public.prepare_founding_program', 'public.prepare_founding_program',
    'public.stage_clerk_continuity', 'public.set_clerk_continuity_enabled']);
  // Synthetic founding programs for both modes (the lab runs live mode, as production does).
  assert.match(sql, /prepare_founding_program\(\s*false,/, 'a synthetic test-mode founding program');
  assert.match(sql, /prepare_founding_program\(\s*true,/, 'a synthetic live-mode founding program');
  // The continuity run names only the lab's own reserved .test issuers, never production's Clerk.
  const urls = sql.match(/https?:\/\/[A-Za-z0-9.-]+/g) || [];
  assert.ok(urls.length >= 2);
  for (const u of urls) assert.match(u, /^https:\/\/[a-z0-9-]+\.qa\.credentialdomd\.test$/, u);
  assert.doesNotMatch(sql, /clerk\.credentialdomd\.com|clerk\.accounts\.dev/);
});

test('no committed QA-lab file holds a secret or names a real mailbox', () => {
  for (const file of committedLabFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const re of SECRET_SHAPES) assert.doesNotMatch(text, re, `${path.relative(ROOT, file)} matches ${re}`);
    for (const a of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) || []) {
      assert.match(a, /@(?:qa\.credentialdomd\.test|example\.(?:com|test))$/, `${path.relative(ROOT, file)} names ${a}`);
    }
  }
});

test('the production project ref appears only where the lab reads production (read-only)', () => {
  const allowed = new Set(['qa-lab/lib/management-api.mjs', 'qa-lab/README.md']);
  for (const file of committedLabFiles()) {
    const rel = path.relative(ROOT, file);
    if (allowed.has(rel)) continue;
    assert.ok(!readFileSync(file, 'utf8').includes(PROD_PROJECT_REF), `${rel} names the production project`);
  }
  assert.ok(!read('supabase/config.toml').includes(PROD_PROJECT_REF), 'config.toml must never point at production');
});

test('everything generated from the production catalog is gitignored', () => {
  const lines = read('.gitignore').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('/qa-lab/.generated/'), '.gitignore must list /qa-lab/.generated/');
});

test('the local stack config: migrations and seeding off, verify_jwt stated for deployed functions', () => {
  const toml = read('supabase/config.toml');
  const section = (name) => { const m = new RegExp(`^\\[${name.replace('.', '\\.')}\\]\\n([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(toml); return m ? m[1] : ''; };
  assert.match(toml, /^project_id = "credentialdomd-qa-lab"$/m);
  assert.match(section('db.migrations'), /^enabled = false$/m, 'the schema comes from the catalog, not the migration chain');
  assert.match(section('db.seed'), /^enabled = false$/m, 'apply-schema.mjs seeds after the schema');
  const fnDirs = new Set(readdirSync(path.join(ROOT, 'supabase/functions')).filter((n) => !n.startsWith('_') && statSync(path.join(ROOT, 'supabase/functions', n)).isDirectory()));
  const listed = [...toml.matchAll(/^\[functions\.([a-z0-9-]+)\]\nverify_jwt = (true|false)$/gm)];
  assert.ok(listed.length >= 40);
  for (const [, name] of listed) assert.ok(fnDirs.has(name), `config.toml lists ${name}, which has no directory`);
  const jwtOn = listed.filter(([, , v]) => v === 'true').map(([, n]) => n);
  assert.deepEqual(jwtOn, ['track-event'], 'every deployed function except track-event runs with verify_jwt off in production');
});

test('the browser app never imports QA-lab code', () => {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && /from\s+['"][^'"]*qa-lab\//.test(readFileSync(full, 'utf8'))) hits.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(hits, []);
  assert.doesNotMatch(read('vite.config.js'), /qa-lab/);
});
