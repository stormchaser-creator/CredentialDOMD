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
export const SUPABASE_CONFIG = path.join(REPO_ROOT, 'supabase', 'config.toml');

/** True when the module at `metaUrl` is the script node was started with. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(path.resolve(process.argv[1])); } catch { return false; }
}
