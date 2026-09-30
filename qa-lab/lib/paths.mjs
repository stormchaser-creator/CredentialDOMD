// Every QA-lab path is built with fileURLToPath: new URL(...).pathname would
// percent-encode a space ("Application Support") and point at nothing.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QA_LAB_DIR = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT = path.resolve(QA_LAB_DIR, '..');
export const GENERATED_DIR = path.join(QA_LAB_DIR, '.generated');
export const CATALOG_JSON = path.join(GENERATED_DIR, 'catalog.json');
export const SCHEMA_SQL = path.join(GENERATED_DIR, 'schema.sql');
export const LOCAL_SECRETS_JSON = path.join(GENERATED_DIR, 'local-secrets.json');
export const PARITY_REPORT = path.join(GENERATED_DIR, 'parity-report.txt');
export const SEED_SQL = path.join(QA_LAB_DIR, 'seed.sql');
export const PARITY_KNOWN = path.join(QA_LAB_DIR, 'parity-known.json');
/**
 * The lab's Supabase CLI config TEMPLATE. Deliberately not supabase/config.toml: the
 * CLI reads that file for production's `db push` / `functions deploy` too, and the lab's
 * settings (migrations off, seeding off) must never reach those commands.
 */
export const STACK_CONFIG_TEMPLATE = path.join(QA_LAB_DIR, 'supabase-config.template.toml');
/** Where a root CLI config would be. The repository has none (tests/qa-lab/public-repo-safety.test.mjs). */
export const ROOT_SUPABASE_CONFIG = path.join(REPO_ROOT, 'supabase', 'config.toml');
export const FUNCTIONS_DIR = path.join(REPO_ROOT, 'supabase', 'functions');

// Step 2 (sign-in, mocks, functions). All generated, all gitignored.
/** Lab-only keys and fake provider secrets (mode 600). Never production values. */
export const LAB_SECRETS_JSON = path.join(GENERATED_DIR, 'lab-secrets.json');
/** The Supabase CLI workdir the lab starts the stack from: config.toml (from the template) + signing key + functions link. */
export const STACK_WORKDIR = path.join(GENERATED_DIR, 'stack');
export const STACK_CONFIG = path.join(STACK_WORKDIR, 'supabase', 'config.toml');
export const STACK_SIGNING_KEYS = path.join(STACK_WORKDIR, 'supabase', 'signing_keys.json');
export const STACK_FUNCTIONS_LINK = path.join(STACK_WORKDIR, 'supabase', 'functions');
/** Environment for `supabase functions serve` (mode 600). */
export const FUNCTIONS_ENV = path.join(GENERATED_DIR, 'functions.env');
/** Where the running lab is: ports, URLs, process ids. Written by qa:lab, read by qa:smoke and qa:stripe. */
export const LAB_RUNTIME_JSON = path.join(GENERATED_DIR, 'lab.json');
/** The mock and app ports this machine's lab uses (kept, so the functions' environment stays the same between runs). */
export const LAB_PORTS_JSON = path.join(GENERATED_DIR, 'lab-ports.json');
/** The mock server's saved state (test physicians, sessions, Stripe objects) and captured email. */
export const MOCK_STATE_DIR = path.join(GENERATED_DIR, 'mocks');
/** The QA-lab app build (production mode, QA sign-in). Never dist/. */
export const QA_APP_DIST = path.join(GENERATED_DIR, 'app-dist');
export const LAB_LOG_DIR = path.join(GENERATED_DIR, 'logs');
export const QA_VITE_CONFIG = path.join(QA_LAB_DIR, 'app', 'vite.config.mjs');

/** True when the module at `metaUrl` is the script node was started with. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(path.resolve(process.argv[1])); } catch { return false; }
}
