// The macOS sandbox for everything that runs code the model wrote or steered
// (stage 2 review, finding 1). A test file the worker writes runs as the
// owner's user, both inside its own session (`npm test`, `node --test`) and in
// the host's gates. The permission rules bind only the model's own tool calls,
// so every model session AND every host step that runs worktree code (the
// reproduction record, the tests, the suite, the build, eslint, lint:hooks,
// the base count and the merge re-gate) runs under /usr/bin/sandbox-exec with
// a profile from this file:
//
//   credentials   no read of the keychains, ~/.ssh, ~/.config (gh, git),
//                 ~/.gitconfig, ~/.netrc, ~/.npmrc, ~/.claude, .env files, the
//                 runner's state (case records, run records, ledgers, the
//                 AUTO_MERGE flag); no exec of security, osascript, gh or any
//                 git-credential helper; no mach lookup of the security daemon
//   writes        only the worktree (or gate worktree), the session directory,
//                 a per-run temporary directory and the entries (never the
//                 directory itself) of this run's PostgreSQL slot directory
//                 (runSlotDir). The owner's checkout, its .git (hooks, config,
//                 refs), its node_modules, ticket-work, the global git config
//                 and the slots the owner's own test runs use cannot be
//                 changed. Each writable directory is granted as the host made
//                 it (pinDir, grantDir): never resolved again, and refused once
//                 it is no longer that directory.
//   network       sessions: outbound allowed (the CLI needs the API), but not
//                 the owner's local services (database and model-server ports,
//                 sockets under /tmp, the launchd sockets that serve
//                 ssh-agent). Gates: loopback only and their own sockets only
//                 (a test's PostgreSQL), no DNS resolver, so nothing leaves
//                 the machine.
//
// Every descendant inherits the sandbox, including a detached child in its
// own process group. Nothing here reads an environment variable: the profile
// is fixed by the host's arguments, never by the session.
import { writeFileSync, existsSync, realpathSync, mkdirSync, mkdtempSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { stopRecordedClusters, running } from './pg-clusters.mjs';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// Whether a sandbox can be applied here: macOS, sandbox-exec present, and
// not already inside a sandbox (sandbox-exec cannot nest: "sandbox_apply:
// Operation not permitted"). The last case is the repository's own suite run
// by the gates, which is already confined; its sandbox tests skip there. The
// runner itself refuses to start any session or gate when this is false.
let probed = null;
export function sandboxAvailable() {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) return false;
  if (probed === null) probed = spawnSync(SANDBOX_EXEC, ['-p', '(version 1) (allow default)', '/usr/bin/true'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  return probed;
}

// An SBPL string literal. Paths come from the host, but a quote or a newline
// in one would change the profile, so they are refused rather than escaped.
export function literal(value) {
  const text = String(value);
  if (!path.isAbsolute(text) || /["\\\n\r\0]/.test(text)) throw Error('A sandbox path must be absolute and plain');
  return `"${text}"`;
}
// sandbox-exec matches resolved paths (/private/var/..., not /var/...).
export function real(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

// What no sandboxed process may read or write, relative to the owner's home.
export const SECRET_DIRS = Object.freeze(['Library/Keychains', '.ssh', '.gnupg', '.aws', '.docker', '.kube', '.config', '.claude',
  'Library/Mobile Documents', 'Library/Messages', 'Library/Mail', 'Library/Cookies', 'Library/Application Support/CredentialDOMD/ticket-quality',
  'Library/Application Support/CredentialDOMD/ticket-context', 'Library/Application Support/CredentialDOMD/ticket-fix']);
export const SECRET_FILES = Object.freeze(['.gitconfig', '.git-credentials', '.netrc', '.npmrc', '.pgpass', '.claude.json', '.zsh_history', '.bash_history']);
export const DENIED_PROGRAMS = Object.freeze(['/usr/bin/security', '/usr/bin/osascript', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']);
const SECURITY_SERVICES = ['com.apple.SecurityServer', 'com.apple.securityd.xpc', 'com.apple.security.agent'];
// Ports of databases and services that may run on the owner's machine.
export const LOCAL_SERVICE_PORTS = Object.freeze([5432, 5433, 5434, 5435, 3306, 6379, 7474, 7687, 8090, 9200, 11434, 27017]);
// Temporary directories for sandboxed processes live under a short root: a
// unix socket path is limited to 104 bytes, and PostgreSQL in a test puts
// its socket in one. macOS's TMPDIR (/var/folders/...) is too long; inside
// the gates' own sandbox (the repository's tests) TMPDIR is already short
// and /private/tmp is not writable.
export const SHORT_TMP = '/private/tmp';
export function shortTmpRoot() {
  const t = real(os.tmpdir());
  return t.length <= 40 ? t : SHORT_TMP;
}

// The directories a profile lets sandboxed processes write, as the host made
// them (review of 2026-09-30). A profile grants (subpath W), which covers W
// itself: a sandboxed process can rename W away or remove it and put a
// symlink in its place, and the next launch that resolved W (realpath) at
// launch time granted the link's target instead (~/Library/LaunchAgents,
// the owner's checkout). So the host resolves a directory once, when it makes
// it (pinDir; a directory the host never pinned is pinned the first time a
// profile grants it, before any sandbox has had it), and records its device,
// inode and owner. Every later grant (grantDir) takes the recorded path,
// never resolved again, and refuses unless it is still a real directory,
// not a link, with the same device, inode and owner, and resolves to itself
// (no link anywhere in it). The profile names that string: if it is swapped
// after the check, the grant is still the path, and a path reached through a
// link is matched as its target, which is not granted.
export class SandboxDirChanged extends Error {}
const PINS = new Map();
const ownUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);
const changed = dir => new SandboxDirChanged(`The sandbox directory ${dir} is not the directory the host made for it (removed, moved, replaced or reached through a link); nothing more runs in it`);
function pinOf(key) {
  let st;
  try { st = lstatSync(key); } catch { throw changed(key); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw changed(key);
  const resolved = realpathSync(key);
  literal(resolved);
  const at = lstatSync(resolved);
  const uid = ownUid();
  if (uid !== null && at.uid !== uid) throw Error(`The sandbox directory ${resolved} is not this user's`);
  return { path: resolved, dev: at.dev, ino: at.ino, uid: at.uid };
}
// Records a directory the host just made; returns its resolved path.
export function pinDir(p) {
  const key = path.resolve(String(p));
  const pin = pinOf(key);
  PINS.set(key, pin);
  PINS.set(pin.path, pin);
  return pin.path;
}
// The path a profile grants for a directory the host made, or
// SandboxDirChanged when it is no longer that directory.
export function grantDir(p) {
  const text = String(p);
  literal(text);
  const key = path.resolve(text);
  if (!PINS.has(key)) pinDir(key);
  const pin = PINS.get(key);
  let same = false;
  try {
    const st = lstatSync(pin.path);
    same = !st.isSymbolicLink() && st.isDirectory() && st.dev === pin.dev && st.ino === pin.ino && st.uid === pin.uid && realpathSync(pin.path) === pin.path;
  } catch { same = false; }
  if (!same) throw changed(pin.path);
  return pin.path;
}
export const verifyDir = grantDir;
export function dirIntact(p) {
  try { grantDir(p); return true; } catch { return false; }
}
export function forgetDir(p) {
  const key = path.resolve(String(p));
  const pin = PINS.get(key);
  PINS.delete(key);
  if (pin) PINS.delete(pin.path);
}

// The host's temporary directories for sandboxed processes: the gates'
// (ctg-) and each session's (cts-), under the short root, the runner's pid in
// the name, pinned, and tracked so the stop handler removes them (review of
// 2026-09-30: a signalled runner exits without its gates' `finally`, and a
// gate's clusters kept their data directories, and so their segments). One
// whose runner is gone goes when the next run starts (runSlotDir).
const HOST_TEMPS = new Set();
export function hostTemp(prefix) {
  if (!/^[a-z]{2,8}-$/.test(prefix)) throw Error('A host temporary directory prefix is a short name and a dash');
  const dir = pinDir(mkdtempSync(path.join(shortTmpRoot(), `${prefix}${process.pid}-`)));
  HOST_TEMPS.add(dir);
  return dir;
}
// Removes one (a link put in its place is removed, never followed).
export function dropHostTemp(dir) {
  HOST_TEMPS.delete(dir);
  forgetDir(dir);
  rmSync(dir, { recursive: true, force: true });
}
export function removeHostTemps() {
  for (const dir of [...HOST_TEMPS]) { try { dropHostTemp(dir); } catch { /* gone */ } }
}
const TEMP_NAME = /^(?:ctg|cts)-(?:(\d+)-)?[A-Za-z0-9]{6}$/;
// Names without a pid (made before 2026-09-30) go once a day old.
const UNNAMED_TEMP_AGE_MS = 24 * 3600 * 1000;
export function sweepHostTemps(root = shortTmpRoot()) {
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  const uid = ownUid();
  const removed = [];
  for (const name of names) {
    const m = TEMP_NAME.exec(name);
    if (!m) continue;
    const full = path.join(root, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (!st.isDirectory() || (uid !== null && st.uid !== uid)) continue;
    if (m[1] ? Number(m[1]) === process.pid || running(Number(m[1])) : Date.now() - st.mtimeMs < UNNAMED_TEMP_AGE_MS) continue;
    try { rmSync(full, { recursive: true, force: true }); removed.push(full); } catch { /* gone meanwhile */ }
  }
  return removed;
}

// The PostgreSQL test slots of one run's sandboxed processes
// (tests/helpers/pg-slot.mjs and pg_slot.py). Every disposable cluster a test
// starts, and each initdb backend, takes a System V shared-memory segment and
// macOS allows 32 for the whole machine, so every test process takes one of a
// fixed number of slots before initdb. The owner's own runs share
// <realpath /tmp>/credentialdomd-pg-slots-<uid> (12 slots). No sandboxed
// process can write there: a record there is trusted to name a live test
// process, and code under test could otherwise plant records that hold every
// slot for good, stalling every later gate and the owner's own `npm test`
// (review of 2026-09-29). Each run's sessions and gates instead share a slot
// directory of their own that the host makes when the run starts and removes
// when it ends, with RUN_PG_SLOTS slots: whatever a sandboxed process does
// there (hold, fake or drop slots) delays or fails only this run's database
// tests. The budget: 12 + 6 for a run + 6 for a merge the owner runs
// meanwhile = 24, with the owner's own databases (2 segments on 2026-09-30;
// the 4 counted on 2026-09-29 were those 2 and 2 initdb backends a SIGKILL
// had orphaned): 26 of 32. A segment is lost for good when a PostgreSQL
// process dies attached to it without cleaning up (SIGKILL), so the runner
// ends a process group with SIGTERM first (worker.mjs endGroup) and the slot
// helpers remove a dead owner's orphaned segments before they give its slot
// back (pg-clusters.mjs).
// Before the host removes a run's slot directory (the run ended, the runner
// was signalled, or a runner that died left it: its pid is in the name) it
// stops every cluster the records there name (stopRecordedClusters): a
// test process killed with its gate cannot stop its own, pg_ctl puts the
// postmaster in a session of its own that no group kill reaches, and once
// the records are gone no reclaimer can find it. The runner's temporary
// directories, which hold the data directories, go too.
export const RUN_PG_SLOTS = 6;
export function runSlotDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const parent = real('/tmp');
  const prefix = `credentialdomd-pg-slots-${uid}-run-`;
  let names = [];
  try { names = readdirSync(parent); } catch { names = []; }
  for (const name of names) {
    const pid = name.startsWith(prefix) ? /^(\d+)-[A-Za-z0-9]{6}$/.exec(name.slice(prefix.length))?.[1] : null;
    if (!pid || Number(pid) === process.pid || running(Number(pid))) continue;
    try {
      const st = lstatSync(path.join(parent, name));
      if (st.isDirectory() && (typeof process.getuid !== 'function' || st.uid === process.getuid())) retireSlotDir(path.join(parent, name));
    } catch { /* gone meanwhile */ }
  }
  sweepHostTemps();
  return mkdtempSync(path.join(parent, `${prefix}${process.pid}-`));
}
// Removes a run's slot directory once every cluster its records name is
// stopped and their orphaned segments are removed.
export function retireSlotDir(dir) {
  try { stopRecordedClusters(dir); } catch { /* remove it anyway */ }
  rmSync(dir, { recursive: true, force: true });
}
// What a sandboxed test process needs to find this run's slots.
export const slotEnv = dir => ({ PG_TEST_SLOT_DIR: dir, PG_TEST_SLOTS: String(RUN_PG_SLOTS) });

// A shared directory as a profile grants it (sandboxProfile shared). Its own
// name is never resolved: a symlink there would make the profile open its
// target (a sandboxed process that could replace the directory with a link to
// ~/Library/LaunchAgents got that folder writable in every later profile:
// review of 2026-09-29). The host makes it (0700) when it is missing and
// otherwise requires a real directory of this user that no one else can
// write; anything else stops the launch. The profile then opens only the
// entries inside it, never the directory itself, so no sandboxed process can
// remove, rename or replace it.
export function sharedDir(p) {
  const text = String(p);
  if (!path.isAbsolute(text)) throw Error('A sandbox path must be absolute and plain');
  const dir = path.join(real(path.dirname(text)), path.basename(text));
  literal(dir);
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = lstatSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!st.isDirectory() || (uid !== null && st.uid !== uid) || (st.mode & 0o022) !== 0) {
    throw Error(`The shared sandbox directory ${dir} is not a directory of this user that only it can write (a symlink, another user's, or open to others); nothing runs until it is removed`);
  }
  return dir;
}
// An SBPL filter for the entries inside a directory, not the directory.
const regexText = text => text.replace(/[.*+?^$|()[\]{}]/g, '\\$&');
const entriesOf = dir => `(regex #"^${regexText(literal(dir).slice(1, -1))}/")`;

// kind: 'session' (a model session: API network allowed) or 'gates' (host
// steps running worktree code: loopback only). writable: directories the
// process tree may write, each granted as the host made it (grantDir: a
// directory swapped for a link or replaced since is refused). denyRead:
// further directories it may not read (the run records, the baseline cache,
// the AUTO_MERGE flag, other state).
// readable: directories it may read (never write) even inside a denied one:
// this ticket's downloaded attachments (stage 3, G6), whose parent holds no
// other ticket's files but is denied as a whole anyway. shared: directories
// whose entries it may write, shared with the run's other sandboxed
// processes (runSlotDir): checked and made by sharedDir, only their entries
// writable, never a unix socket there its own; none may sit inside a
// writable directory, where it could be swapped.
export function sandboxProfile({ kind, home = os.homedir(), writable, denyRead = [], denyFiles = [], readable = [], shared = [] }) {
  if (!['session', 'gates'].includes(kind)) throw Error('Unknown sandbox kind');
  if (!Array.isArray(writable) || !writable.length) throw Error('A sandbox needs its writable directories');
  const h = real(home);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dirs = [...SECRET_DIRS.map(d => path.join(h, d)), '/Library/Keychains', `/private/tmp/claude-${uid}`, ...denyRead.map(real)];
  const files = [...SECRET_FILES.map(f => path.join(h, f)), ...denyFiles.map(f => path.join(real(path.dirname(f)), path.basename(f)))];
  // As the host made them, never resolved here (grantDir).
  const open = writable.map(grantDir);
  const view = readable.map(real);
  const shares = shared.map(sharedDir);
  for (const s of shares) if (open.some(w => s === w || s.startsWith(`${w}/`))) throw Error('A shared sandbox directory may not sit in a writable one');
  const writes = [...open, ...shares];
  for (const w of writes) if (dirs.some(d => d === w || d.startsWith(`${w}/`))) throw Error('A writable sandbox directory may not contain a denied one');
  const writeFilters = [...open.map(w => `(subpath ${literal(w)})`), ...shares.map(entriesOf)].join(' ');
  // A readable directory re-opens what a deny closed, so it may not hold a
  // denied directory or a credential, and it is never writable.
  for (const r of view) if (dirs.some(d => d.startsWith(`${r}/`)) || files.some(f => f.startsWith(`${r}/`)) || SECRET_DIRS.some(d => r === path.join(h, d) || r.startsWith(`${path.join(h, d)}/`))) throw Error('A readable sandbox directory may not contain or sit in a credential directory');
  const ancestors = [...new Set([...writes, ...view].flatMap(w => { const out = []; for (let d = path.dirname(w); d !== path.dirname(d); d = path.dirname(d)) out.push(d); return out; }))];
  const lines = [
    '(version 1)',
    '(allow default)',
    ';; credentials and runner state: neither read nor written',
    `(deny file-read* file-write* ${dirs.map(d => `(subpath ${literal(d)})`).join(' ')} ${files.map(f => `(literal ${literal(f)})`).join(' ')} (regex #"/\\.env(\\.[^/]*)?$"))`,
    `(deny mach-lookup ${SECURITY_SERVICES.map(s => `(global-name "${s}")`).join(' ')})`,
    ';; the writable directories stay usable even inside a denied tree (a',
    ';; session directory lives inside the run directory), with their ancestors',
    ';; visible to stat only',
    `(allow file-read* file-write* ${writeFilters})`,
    ...(shares.length ? [';; shared directories: their entries only (above); the directory itself read only', `(allow file-read* ${shares.map(d => `(literal ${literal(d)})`).join(' ')})`] : []),
    ...(view.length ? [';; this ticket\'s attachments: read only', `(allow file-read* ${view.map(r => `(subpath ${literal(r)})`).join(' ')})`] : []),
    `(allow file-read-metadata ${ancestors.map(a => `(literal ${literal(a)})`).join(' ')})`,
    `(deny process-exec ${DENIED_PROGRAMS.map(p => `(literal ${literal(p)})`).join(' ')} (regex #"/git-credential-[^/]*$"))`,
    ';; writes: only these',
    `(deny file-write* (require-not (require-any ${writeFilters} (subpath "/dev"))))`,
  ];
  // One filter per directory: several paths inside one (unix-socket ...)
  // filter must ALL match, which none does.
  const own = side => open.map(w => `(${side} unix-socket (subpath ${literal(w)}))`).join(' ');
  // Local services the owner runs (databases, model servers): no sandboxed
  // process connects to them, over TCP or their sockets in /tmp.
  lines.push(';; the owner\'s local services',
    `(deny network-outbound ${LOCAL_SERVICE_PORTS.map(p => `(remote ip "localhost:${p}")`).join(' ')})`,
    '(deny network-outbound (remote unix-socket (regex #"^/private/tmp/")) (remote unix-socket (regex #"^/tmp/")) (remote unix-socket (regex #"^/private/tmp/com\\.apple\\.launchd\\.")))',
    ';; except its own sockets',
    `(allow network-outbound ${own('remote')})`);
  if (kind === 'gates') {
    // Loopback only, and only its own unix sockets (local PostgreSQL in its
    // temporary directory): no DNS resolver, so no name reaches the network.
    lines.push(';; network: loopback only',
      '(deny network*)',
      `(allow network* ${own('remote')})`,
      `(allow network-bind network-inbound ${own('local')})`,
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
      `(deny network-outbound ${LOCAL_SERVICE_PORTS.map(p => `(remote ip "localhost:${p}")`).join(' ')})`);
  }
  return `${lines.join('\n')}\n`;
}

// Writes the profile (owner-only) and returns the command that runs `command`
// inside it.
export function sandboxed({ profileFile, profile, command, args = [] }) {
  writeFileSync(profileFile, profile, { mode: 0o600 });
  return { command: SANDBOX_EXEC, args: ['-f', profileFile, command, ...args] };
}

// The environment every sandboxed process gets on top of its allowlist: its
// own TMPDIR and npm cache, and git that reads no global or system config
// (the sandbox denies ~/.gitconfig; git would otherwise stop on it).
// tmp is granted like a writable directory (grantDir), never resolved.
export function sandboxEnv(tmp) {
  const t = grantDir(tmp);
  return { TMPDIR: `${t}/`, npm_config_cache: path.join(t, 'npm-cache'), npm_config_update_notifier: 'false',
    npm_config_fund: 'false', npm_config_audit: 'false', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}
