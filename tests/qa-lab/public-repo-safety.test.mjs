import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  const allowed = new Set(['public.access_policy_settings', 'public.vera_source_settings', 'public.welcome_email_settings', 'qa_lab.seed_version']);
  for (const t of written) assert.ok(allowed.has(t), `seed writes ${t}`);
  const calls = [...sql.matchAll(/select\s+(public\.[a-z_]+)\(/gi)].map((m) => m[1]);
  assert.deepEqual(calls, ['public.seal_limited_free_beta_cohort', 'public.prepare_founding_program', 'public.seal_limited_free_beta_cohort', 'public.prepare_founding_program',
    'public.stage_clerk_continuity', 'public.set_clerk_continuity_enabled']);
  // Synthetic founding programs for both modes (the lab runs live mode, as production does).
  assert.match(sql, /prepare_founding_program\(\s*false,[\s\S]*?,\s*2\);/, 'a synthetic test-mode founding program (lab-only, two places)');
  // The live program promises as many places as production's (4 on 2026-09-29; qa:parity compares it live).
  const live = /prepare_founding_program\(\s*true,\s*'([a-z_]+)',[\s\S]*?,\s*(\d+)\);/.exec(sql);
  assert.ok(live, 'a synthetic live-mode founding program');
  assert.equal(Number(live[2]), 4);
  const cohort = new RegExp(`seal_limited_free_beta_cohort\\(\\s*'${live[1]}',[\\s\\S]*?'(\\[[^']*\\])'::jsonb`).exec(sql);
  assert.equal(JSON.parse(cohort[1]).length, 4, 'the live cohort holds four synthetic addresses');
  // The continuity run names only the lab's own reserved .test issuers, never production's Clerk.
  const urls = sql.match(/https?:\/\/[A-Za-z0-9.-]+/g) || [];
  assert.ok(urls.length >= 2);
  for (const u of urls) assert.match(u, /^https:\/\/[a-z0-9-]+\.qa\.credentialdomd\.test$/, u);
  assert.doesNotMatch(sql, /clerk\.credentialdomd\.com|clerk\.accounts\.dev/);
});

// Not people: the product's own public intake address the journeys mail to, and
// placeholder text the app's forms show (the journeys find fields by it).
const ROLE_AND_PLACEHOLDER_ADDRESSES = new Set(['docs@credentialdomd.com', 'you@hospital.org', 'billing@hospital.org']);

test('no committed QA-lab file holds a secret or names a real mailbox', () => {
  for (const file of committedLabFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const re of SECRET_SHAPES) assert.doesNotMatch(text, re, `${path.relative(ROOT, file)} matches ${re}`);
    for (const a of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) || []) {
      if (ROLE_AND_PLACEHOLDER_ADDRESSES.has(a)) continue;
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
  assert.ok(!read('qa-lab/supabase-config.template.toml').includes(PROD_PROJECT_REF), 'the lab stack config must never point at production');
});

test('everything generated from the production catalog is gitignored', () => {
  const lines = read('.gitignore').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('/qa-lab/.generated/'), '.gitignore must list /qa-lab/.generated/');
});

test('the lab stack config template: migrations and seeding off, verify_jwt stated for deployed functions', () => {
  const toml = read('qa-lab/supabase-config.template.toml');
  const section = (name) => { const m = new RegExp(`^\\[${name.replace('.', '\\.')}\\]\\n([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(toml); return m ? m[1] : ''; };
  assert.match(toml, /^project_id = "credentialdomd-qa-lab"$/m);
  assert.match(section('db.migrations'), /^enabled = false$/m, 'the schema comes from the catalog, not the migration chain');
  assert.match(section('db.seed'), /^enabled = false$/m, 'apply-schema.mjs seeds after the schema');
  assert.match(section('db.seed'), /^sql_paths = \[\]$/m);
  const fnDirs = new Set(readdirSync(path.join(ROOT, 'supabase/functions')).filter((n) => !n.startsWith('_') && statSync(path.join(ROOT, 'supabase/functions', n)).isDirectory()));
  const listed = [...toml.matchAll(/^\[functions\.([a-z0-9-]+)\]\nverify_jwt = (true|false)$/gm)];
  assert.ok(listed.length >= 40);
  for (const [, name] of listed) assert.ok(fnDirs.has(name), `the template lists ${name}, which has no directory`);
  const jwtOn = listed.filter(([, , v]) => v === 'true').map(([, n]) => n);
  assert.deepEqual(jwtOn, ['track-event'], 'every deployed function except track-event runs with verify_jwt off in production');
});

// The Supabase CLI reads supabase/config.toml for production's own procedures
// (`supabase db push --project-ref ...`, `supabase functions deploy`, `supabase
// config push`). A root config with the lab's settings made `db push` print
// "Skipping migrations because it is disabled in config.toml" and then "Remote
// database is up to date": every later migration, a security fix included,
// would be skipped silently. The lab's settings live only in its template.
test('no root supabase/config.toml carries lab settings (production db push must apply migrations)', () => {
  const root = path.join(ROOT, 'supabase', 'config.toml');
  if (existsSync(root)) {
    const toml = readFileSync(root, 'utf8');
    const section = (name) => { const m = new RegExp(`^\\[${name.replace('.', '\\.')}\\]\\n([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(toml); return m ? m[1] : ''; };
    assert.doesNotMatch(section('db.migrations'), /^\s*enabled\s*=\s*false/m, 'supabase/config.toml disables migrations: `supabase db push` would skip them all');
    assert.doesNotMatch(toml, /qa-lab/, 'supabase/config.toml names QA-lab files');
    assert.doesNotMatch(toml, /^project_id\s*=\s*"credentialdomd-qa-lab"/m, 'supabase/config.toml is the QA-lab config');
    assert.doesNotMatch(toml, /^\s*signing_keys_path\s*=/m, 'supabase/config.toml names a signing key (the lab trusts its own)');
  }
  // The template is not where the CLI looks: nothing under qa-lab/ (outside .generated/) is named config.toml.
  for (const file of committedLabFiles()) assert.notEqual(path.basename(file), 'config.toml', path.relative(ROOT, file));
  // And the lab never writes a root config itself.
  for (const file of committedLabFiles()) {
    if (!/\.(m?js|sh)$/.test(file)) continue;
    assert.doesNotMatch(readFileSync(file, 'utf8'), /ROOT_SUPABASE_CONFIG[^;\n]*(?:write|copy|symlink)|(?:writeFileSync|copyFileSync|symlinkSync)\([^)]*ROOT_SUPABASE_CONFIG/, path.relative(ROOT, file));
  }
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
