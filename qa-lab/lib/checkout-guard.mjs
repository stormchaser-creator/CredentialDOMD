// Which checkout the lab stack and its database belong to.
//
// Every checkout of the repository carries the lab (it is on main), but a
// machine runs ONE lab stack: the Supabase CLI names the containers and the
// database volume after the template's project_id (credentialdomd-qa-lab),
// whichever checkout started it. What a running lab serves and trusts is the
// starting checkout's own:
//   * its edge functions: the stack mounts
//     <checkout>/qa-lab/.generated/stack/supabase/functions (a link to that
//     checkout's supabase/functions);
//   * its lab keys (.generated/lab-secrets.json: the token key, the fake
//     provider keys its mocks accept);
//   * the local vault values its database was built with
//     (.generated/local-secrets.json; the database's triggers send
//     welcome_hook_secret, and the functions must hold the same value).
// So a second checkout that ran qa:lab, qa:up or qa:e2e would restart the
// running stack under the first one's journeys, serving its own functions with
// keys the first one's mocks do not know; qa:down there would stop the first
// one's lab; and a checkout reusing a database another checkout built would
// give its functions a hook secret the database's triggers do not send.
//
// lib/stack.mjs refuses to start, restart or stop a stack running from another
// checkout, and apply-schema.mjs refuses a database whose vault another
// checkout wrote. QA_LAB_TAKE_OVER=1 lets a checkout stop or restart another
// checkout's stack on purpose (for example when that checkout is gone).
// tests/qa-lab/checkout-guard.test.mjs checks every rule offline.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { REPO_ROOT } from './paths.mjs';
import { projectId } from './config.mjs';

/** Where a checkout's lab mounts its functions into the edge runtime (relative to the checkout). */
export const LAB_FUNCTIONS_MOUNT = '/qa-lab/.generated/stack/supabase/functions';

const trim = (p) => String(p).replace(/\/+$/, '');

/**
 * The checkout a running edge runtime serves, from its mounts (`docker inspect
 * --format '{{json .Mounts}}'`): the bind mount of a lab workdir's functions
 * link, or failing that of any supabase/functions folder. null when there is
 * none (so nothing can be said about it).
 */
export function checkoutFromMounts(mounts) {
  if (!Array.isArray(mounts)) return null;
  const binds = mounts.filter((m) => m && m.Type === 'bind' && typeof m.Source === 'string').map((m) => trim(m.Source));
  const lab = binds.find((s) => s.endsWith(LAB_FUNCTIONS_MOUNT));
  if (lab) return lab.slice(0, -LAB_FUNCTIONS_MOUNT.length) || '/';
  const other = binds.find((s) => s.endsWith('/supabase/functions'));
  return other ? other.slice(0, -'/supabase/functions'.length) || '/' : null;
}

const realOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };

/**
 * True when `owner` (a path Docker reports) is the checkout at `root`: the same
 * path, the same once symbolic links are resolved, or the same under a mount
 * prefix Docker adds on some hosts (/host_mnt/Users/... for /Users/...).
 */
export function sameCheckout(owner, root, real = realOrNull) {
  if (!owner || !root) return false;
  const a = [trim(owner), real(owner)].filter(Boolean).map(trim);
  const b = [trim(root), real(root)].filter(Boolean).map(trim);
  return a.some((x) => b.some((y) => x === y || (y.startsWith('/') && x.endsWith(y) && x.length > y.length)));
}

/** The checkout the running lab stack serves, or null when its edge runtime is not running (or says nothing). */
export function runningStackCheckout(run = spawnSync) {
  const r = run('docker', ['inspect', '--format', '{{.State.Running}}\t{{json .Mounts}}', `supabase_edge_runtime_${projectId()}`], { encoding: 'utf8' });
  if (!r || r.status !== 0) return null;
  const [running, mounts] = String(r.stdout || '').trim().split('\t');
  if (running !== 'true') return null;
  try { return checkoutFromMounts(JSON.parse(mounts)); } catch { return null; }
}

/**
 * Throws when the lab stack is running from another checkout than `root`, so
 * this one does not start, restart or stop it under the other one's runs.
 * Passes when no lab stack runs, when it is this checkout's, when the other
 * checkout no longer exists, or with QA_LAB_TAKE_OVER=1.
 */
export function assertStackIsOurs(action, { owner = runningStackCheckout(), root = REPO_ROOT, env = process.env, exists = existsSync, log = console.log } = {}) {
  if (!owner || sameCheckout(owner, root)) return;
  if (!exists(owner)) {
    log(`qa-lab: the running lab stack was started from ${owner}, which no longer exists; this checkout takes it over.`);
    return;
  }
  if (env.QA_LAB_TAKE_OVER === '1') {
    log(`qa-lab: QA_LAB_TAKE_OVER=1: taking over the lab stack started from ${owner} (its runs lose their lab).`);
    return;
  }
  throw new Error(`the QA lab stack on this machine is running from another checkout (${owner}). `
    + `Its functions, keys and database are that checkout's, and one machine runs one lab stack, so this checkout will not ${action} it. `
    + `Use that lab from its own checkout, or stop it there first (Ctrl-C in its qa:lab terminal, then npm run qa:down) `
    + `and run this again here. QA_LAB_TAKE_OVER=1 lets this checkout ${action} it anyway, under whatever that checkout is running.`);
}

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');

/**
 * The vault secrets whose value in the database is not this checkout's
 * (.generated/local-secrets.json), compared by SHA-256 so no value leaves the
 * database or reaches a command line. Only names both sides hold are compared.
 */
export function vaultDifferences(expected, databaseHashes) {
  const out = [];
  for (const [name, value] of Object.entries(expected || {})) {
    const have = databaseHashes?.[name];
    if (typeof value === 'string' && value && typeof have === 'string' && have && have !== sha256(value)) out.push(name);
  }
  return out.sort();
}

/** SQL for { vault secret name: sha256 hex of its value } in the local database (run through localJson). */
export const VAULT_HASHES_SQL = "select coalesce(pg_catalog.json_object_agg(name, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(decrypted_secret, 'UTF8')), 'hex')), '{}'::json) from vault.decrypted_secrets where name is not null";

/**
 * Throws when the local database's vault was written by another checkout (its
 * values are not this checkout's local-secrets.json), so this checkout's
 * functions would not hold the hook secret its triggers send.
 */
export function assertDatabaseIsOurs({ expected, databaseHashes } = {}) {
  const differ = vaultDifferences(expected, databaseHashes);
  if (!differ.length) return;
  throw new Error(`the local database was built by another checkout: its vault values (${differ.join(', ')}) are not this checkout's `
    + `qa-lab/.generated/local-secrets.json, so the edge functions here would not hold the hook secret the database's triggers send. `
    + 'Rebuild it for this checkout (npm run qa:down -- --wipe && npm run qa:up, or npm run qa:e2e -- --fresh), '
    + 'or run the lab from the checkout that built it.');
}
