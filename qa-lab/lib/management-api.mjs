// Read-only access to the PRODUCTION catalog through the Supabase Management API.
//
// Rules this module enforces (qa-lab/README.md, "Production access"):
//   * Only single SELECT/WITH statements pass assertReadOnlySql. Anything that
//     could write, read a secret value, or change a setting is refused before a
//     request is made.
//   * Every accepted statement is sent inside a READ ONLY transaction, so the
//     server refuses a write even if the text check were ever wrong.
//   * The access token is read from the macOS keychain item "Supabase CLI" (or
//     SUPABASE_ACCESS_TOKEN) and is never printed, logged or written to disk.
//   * No database password is used, read or reset.
import { execFileSync } from 'node:child_process';

export const PROD_PROJECT_REF = 'hkpnnsjcwprrwobmpqyy';
const API = `https://api.supabase.com/v1/projects/${PROD_PROJECT_REF}/database/query`;

// Words that have no business in a catalog read. Matched as whole words on the
// statement with comments and string literals removed.
const FORBIDDEN_WORDS = [
  'insert', 'update', 'delete', 'merge', 'truncate', 'create', 'alter', 'drop',
  'grant', 'revoke', 'copy', 'call', 'do', 'vacuum', 'reindex', 'cluster', 'lock',
  'set', 'reset', 'notify', 'listen', 'unlisten', 'comment', 'refresh', 'prepare',
  'execute', 'deallocate', 'import', 'load', 'discard', 'begin', 'commit', 'rollback',
  'savepoint', 'release', 'checkpoint', 'security', 'into',
];
// Functions that write, leak or signal. Matched as substrings (case-insensitive).
const FORBIDDEN_CALLS = [
  'decrypted_secret', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_', 'lo_', 'dblink',
  'nextval', 'setval', 'set_config', 'pg_terminate', 'pg_cancel', 'pg_reload',
  'pg_switch_wal', 'pg_advisory', 'http_', 'net.', 'vault.create', 'vault.update',
  'pg_notify', 'txid_current', 'pg_current_xact_id', 'cron.schedule', 'cron.alter',
  'cron.unschedule', 'query_to_xml',
];

/** Remove -- and /* *\/ comments and the contents of quoted literals/identifiers. */
export function stripSqlNoise(sql) {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') { while (i < sql.length && sql[i] !== '\n') i++; out += ' '; continue; }
    if (two === '/*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; out += ' '; continue; }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < sql.length) { if (sql[i] === q && sql[i + 1] === q) { i += 2; continue; } if (sql[i] === q) { i++; break; } i++; }
      out += q === "'" ? "''" : '"x"';
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { const end = sql.indexOf(m[0], i + m[0].length); i = end < 0 ? sql.length : end + m[0].length; out += "''"; continue; }
    }
    out += c; i++;
  }
  return out;
}

/** Throws unless sql is one read-only SELECT/WITH statement; returns it without a trailing ';'. */
export function assertReadOnlySql(sql) {
  const bare = stripSqlNoise(String(sql)).trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(bare)) throw new Error('read-only guard: statement must start with SELECT or WITH');
  if (bare.includes(';')) throw new Error('read-only guard: exactly one statement is allowed');
  const lower = bare.toLowerCase();
  for (const w of FORBIDDEN_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(lower)) throw new Error(`read-only guard: "${w}" is not allowed in a catalog read`);
  }
  for (const f of FORBIDDEN_CALLS) {
    if (lower.includes(f)) throw new Error(`read-only guard: "${f}" is not allowed in a catalog read`);
  }
  // The checked statement, as written (comments and literals intact), without a trailing ';'.
  return String(sql).trim().replace(/;\s*$/, '').trimEnd();
}

let cachedToken = null;
function token() {
  if (cachedToken) return cachedToken;
  let t = process.env.SUPABASE_ACCESS_TOKEN || '';
  if (!t) {
    try {
      t = execFileSync('security', ['find-generic-password', '-s', 'Supabase CLI', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      throw new Error('No Management API token: set SUPABASE_ACCESS_TOKEN or log in with `supabase login` (keychain item "Supabase CLI").');
    }
  }
  if (t.startsWith('go-keyring-base64:')) t = Buffer.from(t.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
  cachedToken = t.trim();
  return cachedToken;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one read-only catalog query against production and returns the rows.
 * search_path is pg_catalog so every deparsed name comes back schema-qualified.
 */
export async function prodQuery(sql, { attempts = 8 } = {}) {
  const bare = assertReadOnlySql(sql);
  const body = JSON.stringify({
    // The newline keeps a trailing "-- comment" in the statement from swallowing anything.
    query: `set transaction read only; set local search_path = pg_catalog; set local statement_timeout = '120s'; ${bare}\n`,
  });
  let wait = 2000;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API, { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body });
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500 || /Too Many Requests/i.test(text)) && attempt < attempts) {
      await sleep(wait); wait = Math.min(wait * 2, 30000); continue;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(`Management API returned non-JSON (HTTP ${res.status})`); }
    if (!res.ok || !Array.isArray(parsed)) throw new Error(`Management API error (HTTP ${res.status}): ${parsed?.message ?? text.slice(0, 300)}`);
    return parsed;
  }
}

/** Runs a query whose single row has a single JSON column "r"; returns that value. */
export async function prodJson(sql) {
  const rows = await prodQuery(sql);
  if (rows.length !== 1 || !('r' in rows[0])) throw new Error('expected exactly one row with column r');
  return typeof rows[0].r === 'string' ? JSON.parse(rows[0].r) : rows[0].r;
}
