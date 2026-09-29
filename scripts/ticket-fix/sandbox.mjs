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
//   writes        only the worktree (or gate worktree), the session directory
//                 and a per-run temporary directory. The owner's checkout, its
//                 .git (hooks, config, refs), its node_modules, ticket-work and
//                 the global git config cannot be changed.
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
import { writeFileSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

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
function literal(value) {
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

// kind: 'session' (a model session: API network allowed) or 'gates' (host
// steps running worktree code: loopback only). writable: directories the
// process tree may write. denyRead: further directories it may not read
// (the run records, the baseline cache, the AUTO_MERGE flag, other state).
// readable: directories it may read (never write) even inside a denied one:
// this ticket's downloaded attachments (stage 3, G6), whose parent holds no
// other ticket's files but is denied as a whole anyway.
export function sandboxProfile({ kind, home = os.homedir(), writable, denyRead = [], denyFiles = [], readable = [] }) {
  if (!['session', 'gates'].includes(kind)) throw Error('Unknown sandbox kind');
  if (!Array.isArray(writable) || !writable.length) throw Error('A sandbox needs its writable directories');
  const h = real(home);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dirs = [...SECRET_DIRS.map(d => path.join(h, d)), '/Library/Keychains', `/private/tmp/claude-${uid}`, ...denyRead.map(real)];
  const files = [...SECRET_FILES.map(f => path.join(h, f)), ...denyFiles.map(f => path.join(real(path.dirname(f)), path.basename(f)))];
  const open = writable.map(real);
  const view = readable.map(real);
  for (const w of open) if (dirs.some(d => d === w || d.startsWith(`${w}/`))) throw Error('A writable sandbox directory may not contain a denied one');
  // A readable directory re-opens what a deny closed, so it may not hold a
  // denied directory or a credential, and it is never writable.
  for (const r of view) if (dirs.some(d => d.startsWith(`${r}/`)) || files.some(f => f.startsWith(`${r}/`)) || SECRET_DIRS.some(d => r === path.join(h, d) || r.startsWith(`${path.join(h, d)}/`))) throw Error('A readable sandbox directory may not contain or sit in a credential directory');
  const ancestors = [...new Set([...open, ...view].flatMap(w => { const out = []; for (let d = path.dirname(w); d !== path.dirname(d); d = path.dirname(d)) out.push(d); return out; }))];
  const lines = [
    '(version 1)',
    '(allow default)',
    ';; credentials and runner state: neither read nor written',
    `(deny file-read* file-write* ${dirs.map(d => `(subpath ${literal(d)})`).join(' ')} ${files.map(f => `(literal ${literal(f)})`).join(' ')} (regex #"/\\.env(\\.[^/]*)?$"))`,
    `(deny mach-lookup ${SECURITY_SERVICES.map(s => `(global-name "${s}")`).join(' ')})`,
    ';; the writable directories stay usable even inside a denied tree (a',
    ';; session directory lives inside the run directory), with their ancestors',
    ';; visible to stat only',
    `(allow file-read* file-write* ${open.map(w => `(subpath ${literal(w)})`).join(' ')})`,
    ...(view.length ? [';; this ticket\'s attachments: read only', `(allow file-read* ${view.map(r => `(subpath ${literal(r)})`).join(' ')})`] : []),
    `(allow file-read-metadata ${ancestors.map(a => `(literal ${literal(a)})`).join(' ')})`,
    `(deny process-exec ${DENIED_PROGRAMS.map(p => `(literal ${literal(p)})`).join(' ')} (regex #"/git-credential-[^/]*$"))`,
    ';; writes: only these',
    `(deny file-write* (require-not (require-any ${open.map(w => `(subpath ${literal(w)})`).join(' ')} (subpath "/dev"))))`,
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
export function sandboxEnv(tmp) {
  return { TMPDIR: `${real(tmp)}/`, npm_config_cache: path.join(real(tmp), 'npm-cache'), npm_config_update_notifier: 'false',
    npm_config_fund: 'false', npm_config_audit: 'false', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}
