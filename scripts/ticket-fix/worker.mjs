// Containment for every model session the ticket runner starts (design G0,
// critique B2, stage 2 review): the reproduction writer, the fixer ("worker")
// and the independent reviewer.
//
// Each session runs with
//   --permission-mode dontAsk     anything not allowed below is refused, never asked
//   --setting-sources ""          no user, project or local settings (hooks, MCP, allow rules)
//   --settings <file>             this run's explicit allow and deny rules
//   --strict-mcp-config           no MCP servers
//   --tools <list>                only the built-in tools the role needs
//   CLAUDE_CONFIG_DIR=<fresh>     no user CLAUDE.md, memory or transcripts; per run
// and an environment built from an allowlist: no database, GitHub or other
// token reaches it, git cannot push (pushurl points nowhere, no credential
// helper) and hooks are off. The model credential is not in the environment
// either: the CLI reads it from a pipe (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR),
// so a Bash child of the session never inherits it.
//
// The fixer may edit only src/**, tests/** (not tests/ticket-fix/**, and not
// the frozen reproduction files), public/** and landing/**, and run exactly
// `npm test`, `npm run build:site` and `node --test <file under tests/>`. It
// reads with Read, Grep and Glob, which the Read rule binds to the worktree
// (a bare "Grep" or "Glob" allow rule would let them search any path the deny
// list does not name); git, rg and shells are not available (critique B2:
// `rg --pre`, `git grep -O` and `git diff --output` run programs or write
// files). The host commits, gates, reviews and merges.
//
// The permission rules bind the model's own tool calls only. A test file the
// fixer writes runs when `npm test` or `node --test` runs it, and that code is
// not bound by them. So the CLI itself runs under the macOS sandbox
// (sandbox.mjs): the session and everything it starts can write only the
// worktree and its own session directory, cannot read the keychain, the
// owner's credential files or the runner's state, cannot run security, gh or
// a git credential helper, and cannot reach an ssh-agent. The host's gates run
// the fixer's code in a sandbox with no network at all.
import { spawn } from 'node:child_process';
import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import { SANDBOX_EXEC, shortTmpRoot, sandboxProfile, sandboxEnv, real } from './sandbox.mjs';

export const WORKER_MODEL = 'claude-sonnet-5';
export const REPRO_MODEL = 'claude-sonnet-5';
export const REVIEW_MODEL = 'claude-opus-5-5';
export const WORKER_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
export const REVIEW_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
// Exact commands. The one wildcard is the test file path, anchored to tests/.
export const WORKER_COMMANDS = Object.freeze(['Bash(npm test)', 'Bash(npm run build:site)', 'Bash(node --test tests/*)',
  'Bash(node --experimental-vm-modules --test tests/*)']);
export const REPRO_COMMANDS = Object.freeze(['Bash(node --test tests/*)', 'Bash(node --experimental-vm-modules --test tests/*)']);
// Refused even if an allow rule ever matched them. With dontAsk every other
// command is refused anyway; these are named so the intent is on record.
export const DENIED_COMMANDS = Object.freeze(['git', 'rg', 'grep', 'security', 'curl', 'wget', 'gh', 'ssh', 'scp', 'nc', 'npx', 'npm install',
  'npm ci', 'npm publish', 'npm exec', 'npm run deploy', 'osascript', 'open', 'sh', 'bash', 'zsh', 'env', 'node -e', 'node --eval', 'node -p',
  'python', 'python3', 'perl', 'ruby', 'launchctl', 'sudo', 'rm', 'mv', 'cp', 'chmod', 'ln', 'find', 'xargs', 'tee'].map(c => `Bash(${c}:*)`));
const NOT_EDITABLE = Object.freeze(['scripts', '.github', '.githooks', 'supabase', 'tests/ticket-fix', 'node_modules', '.git', '.claude']);
const NOT_EDITABLE_FILES = Object.freeze(['package.json', 'package-lock.json', 'eslint.config.js', 'vite.config.js', 'index.html']);
export const EDIT_ROOTS = Object.freeze(['src', 'tests', 'public', 'landing']);

// Permission paths: "//abs/path" is an absolute path in Claude Code rules.
const abs = p => `/${path.resolve(p)}`;

// Files outside the worktree a session must never read: runner state (other
// tickets' records and ledgers, passed as state), credentials and the owner's
// checkouts. The CredentialDOMD support directory as a whole is not denied:
// the worktrees live under it, and a deny rule beats an allow rule.
export function secretReadDenials({ home, state = [], runDir = null, tmp = null }) {
  const denied = [
    ...['.ssh', '.aws', '.config', '.claude', '.gnupg', '.docker', '.kube', 'Library/Keychains', 'Library/Logs', 'Projects']
      .map(p => `Read(${abs(path.join(home, p))}/**)`),
    ...['.claude.json', '.npmrc', '.netrc', '.gitconfig', '.git-credentials', '.zshrc', '.zsh_history', '.bash_history'].map(p => `Read(${abs(path.join(home, p))})`),
    'Read(**/.env)', 'Read(**/.env.*)',
    ...state.map(p => `Read(${abs(p)}/**)`),
  ];
  if (runDir) denied.push(`Read(${abs(runDir)}/**)`);
  if (tmp) denied.push(`Read(${abs(tmp)}/credentialdomd-ticket-*/**)`);
  return denied;
}

// The fixer's and the reproduction writer's rules. worktree is the session's
// cwd. It lives under the work directory, which is NOT in the read denials
// (a deny rule beats an allow rule), while the work directory's run records
// are. frozen: repository paths the session may not edit (the reproduction,
// once recorded). Grep and Glob have no allow rule of their own: the Read rule
// on the worktree is what lets them search it (checked live).
export function sessionSettings({ role, worktree, home, work, state = [], runDir = null, tmp = null, frozen = [] }) {
  if (!['worker', 'repro'].includes(role)) throw Error('Unknown session role');
  const root = abs(worktree);
  const editRoots = role === 'repro' ? ['tests'] : EDIT_ROOTS;
  const allow = [`Read(${root}/**)`,
    ...editRoots.flatMap(dir => [`Edit(${root}/${dir}/**)`, `Write(${root}/${dir}/**)`]),
    ...(role === 'repro' ? REPRO_COMMANDS : WORKER_COMMANDS)];
  const noEdit = [...NOT_EDITABLE.map(dir => `${root}/${dir}/**`), ...NOT_EDITABLE_FILES.map(f => `${root}/${f}`), `${root}/**/.env*`,
    ...frozen.map(f => `${root}/${f}`)];
  const deny = [...noEdit.flatMap(p => [`Edit(${p})`, `Write(${p})`]), ...DENIED_COMMANDS, 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
    ...secretReadDenials({ home, state: [...state, path.join(work, 'runs'), path.join(work, 'baseline')], runDir, tmp })];
  return { permissions: { defaultMode: 'dontAsk', allow, deny, disableBypassPermissionsMode: 'disable' }, env: {} };
}

// The reviewer: read-only, no Bash at all. The host hands it the diff.
export function reviewSettings({ worktree, home, work, state = [], runDir = null, tmp = null }) {
  const root = abs(worktree);
  return { permissions: { defaultMode: 'dontAsk', allow: [`Read(${root}/**)`],
    deny: ['Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
      ...secretReadDenials({ home, state: [...state, path.join(work, 'runs'), path.join(work, 'baseline')], runDir, tmp })],
    disableBypassPermissionsMode: 'disable' }, env: {} };
}

const ROLE = {
  worker: { model: WORKER_MODEL, effort: 'high', tools: WORKER_TOOLS, budget: 6 },
  repro: { model: REPRO_MODEL, effort: 'high', tools: WORKER_TOOLS, budget: 3 },
  review: { model: REVIEW_MODEL, effort: 'high', tools: REVIEW_TOOLS, budget: 5 },
};
// The command line for one session. resume: a session id to continue (the
// repair, gate and review loops); the same settings apply again.
export function sessionArgs({ role, settingsFile, schema, resume = null, budget = null }) {
  const r = ROLE[role];
  if (!r) throw Error('Unknown session role');
  if (resume !== null && !/^[0-9a-f-]{36}$/i.test(resume)) throw Error('Invalid session id');
  return ['-p', ...(resume ? ['--resume', resume] : []), '--model', r.model, '--effort', r.effort,
    '--permission-mode', 'dontAsk', '--setting-sources', '', '--settings', settingsFile,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', r.tools.join(','),
    '--max-budget-usd', String(budget ?? r.budget), '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
}

// Environment for a model session, from an allowlist. configDir is fresh per
// session role and run. With credentials: false (what runSession uses) the
// model credential is left out and handed over on a pipe instead.
const KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'PG_BIN'];
const MODEL_CREDENTIALS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
// The file descriptor the CLI reads the credential from, per credential kind.
export const CREDENTIAL_FD = 3;
const CREDENTIAL_FD_VARIABLE = { CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', ANTHROPIC_API_KEY: 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR' };
export function modelCredential(base = process.env) {
  for (const key of MODEL_CREDENTIALS) if (typeof base[key] === 'string' && base[key].trim()) return { variable: CREDENTIAL_FD_VARIABLE[key], value: base[key].trim() };
  return null;
}
// What `npm run build:site` needs to build (not deploy): a dummy Clerk key and
// a synthetic Supabase origin of the reviewed shape (package-site.mjs). No
// production value; the gates never publish what they build.
export const BUILD_ENV = Object.freeze({ VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_dummy', VITE_SUPABASE_URL: 'https://ticketgate.supabase.co' });
export const GIT_LOCKDOWN = Object.freeze({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'remote.origin.pushurl', GIT_CONFIG_VALUE_0: '/nonexistent/push-blocked',
  GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
export function sessionEnv({ base = process.env, configDir, credentials = true }) {
  if (!configDir || !path.isAbsolute(configDir)) throw Error('A fresh absolute CLAUDE_CONFIG_DIR is required');
  const env = {};
  for (const key of [...KEEP, ...(credentials ? MODEL_CREDENTIALS : [])]) if (typeof base[key] === 'string') env[key] = base[key];
  // launchd may start the runner without SHELL; the Bash tool needs one.
  env.SHELL ??= '/bin/zsh';
  return { ...env, ...GIT_LOCKDOWN, ...BUILD_ENV, CLAUDE_CONFIG_DIR: configDir, LC_ALL: 'C',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
// Environment for the host's gates: the same allowlist without the model
// credential. The gates run code the fixer wrote, in the gates sandbox (no
// network, writes only to the gate worktree): git has no credential helper
// and no hooks, but its push URL is not blocked, because the repository's own
// tests push to local bare repositories they create, and with it blocked the
// base suite could never pass (so no code change ever could).
export const GATES_GIT = Object.freeze({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
export const gatesEnv = (base = process.env) => {
  const env = {};
  for (const key of KEEP) if (typeof base[key] === 'string') env[key] = base[key];
  return { ...env, ...GATES_GIT, ...BUILD_ENV, LC_ALL: 'C' };
};

// Writes the settings file and a fresh config directory for one session.
export async function prepareSession({ sessionDir, settings }) {
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const configDir = path.join(sessionDir, 'claude-config');
  await fs.mkdir(configDir, { recursive: false, mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const settingsFile = path.join(sessionDir, 'settings.json');
  await fs.writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { configDir, settingsFile };
}

// Process groups the runner started, killed on timeout, on exit and when the
// runner itself is signalled (the old alarm killed only the model; its npm and
// git children kept running).
const GROUPS = new Set();
export function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}
let handlersInstalled = false;
export function installSignalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const stop = (signal, code) => () => { for (const pid of GROUPS) killGroup(pid); removeSessionTemps(); process.exit(code); };
  process.on('SIGTERM', stop('SIGTERM', 143));
  process.on('SIGINT', stop('SIGINT', 130));
  process.on('SIGHUP', stop('SIGHUP', 129));
  process.on('SIGALRM', stop('SIGALRM', 142));
  process.on('exit', () => { for (const pid of GROUPS) killGroup(pid); removeSessionTemps(); });
}

// Runs one command in its own process group. stdout is captured (bounded)
// and returned; stderr goes to a file or is dropped. On timeout the whole
// group is killed; after a normal exit, any child it left behind is too.
// secret: a string written to file descriptor 3 (a pipe) and nowhere else;
// the child reads it once, and nothing it starts can read it from the
// environment.
export function launch({ command, args = [], cwd, env, input = '', timeoutMs, stdoutLimit = 32 * 1024 * 1024, stderrFile = null, secret = null }) {
  return new Promise(resolve => {
    let child;
    const stdio = secret === null ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'];
    try { child = spawn(command, args, { cwd, env, detached: true, stdio }); } catch (error) {
      resolve({ code: null, signal: null, timedOut: false, stdout: '', error: String(error.message) }); return;
    }
    GROUPS.add(child.pid);
    const chunks = []; let size = 0; let timedOut = false;
    let errOut = null;
    if (stderrFile) errOut = fs.open(stderrFile, 'a', 0o600).catch(() => null);
    child.stdout.on('data', d => { if (size < stdoutLimit) { chunks.push(d); size += d.length; } });
    child.stderr.on('data', async d => { const handle = await errOut; if (handle) handle.write(d).catch(() => {}); });
    child.stdin.on('error', () => {});
    if (secret !== null) { child.stdio[3].on('error', () => {}); child.stdio[3].end(secret); }
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); GROUPS.delete(child.pid); resolve({ code: null, signal: null, timedOut, stdout: '', error: String(error.message) }); });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      killGroup(child.pid);
      GROUPS.delete(child.pid);
      const handle = await errOut; if (handle) await handle.close().catch(() => {});
      resolve({ code, signal, timedOut, stdout: Buffer.concat(chunks).toString('utf8') });
    });
    child.stdin.end(input);
  });
}

// The command line and environment of one session: the CLI under the session
// sandbox (when sandbox is set), its credential on a pipe. sandbox: null (no
// sandbox; only for tests on a machine without sandbox-exec) or { home,
// denyRead, denyFiles, profileDir }: profileDir must be a directory no
// sandboxed process can write (the profile is read before the sandbox starts).
let profiles = 0;
// Each sandboxed session's temporary directory: short (a unix socket path is
// limited to 104 bytes) and kept for the session's resumes. Removed by
// removeSessionTemps() when the run ends.
const TEMPS = new Set();
async function sessionTemp(sessionDir) {
  const record = path.join(sessionDir, '.tmpdir');
  try {
    const known = (await fs.readFile(record, 'utf8')).trim();
    if (TEMPS.has(known)) return known;
  } catch { /* first launch of this session */ }
  const tmp = await fs.mkdtemp(path.join(shortTmpRoot(), 'cts-'));
  TEMPS.add(tmp);
  await fs.writeFile(record, tmp, { mode: 0o600 });
  return tmp;
}
export function removeSessionTemps() {
  for (const tmp of TEMPS) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } TEMPS.delete(tmp); }
}
export async function sessionLaunch({ claude, args, cwd, sessionDir, baseEnv = process.env, sandbox = null, apiBaseUrl = null }) {
  const configDir = path.join(sessionDir, 'claude-config');
  const credential = modelCredential(baseEnv);
  const env = { ...sessionEnv({ base: baseEnv, configDir, credentials: false }), ...(credential ? { [credential.variable]: String(CREDENTIAL_FD) } : {}),
    ...(apiBaseUrl ? { ANTHROPIC_BASE_URL: apiBaseUrl } : {}) };
  if (!sandbox) return { command: claude, args, env, secret: credential?.value ?? null };
  const tmp = real(await sessionTemp(sessionDir));
  // The CLI keeps its own temporary files under /tmp/claude-<uid> unless told
  // otherwise; that directory holds other sessions' output and is denied.
  Object.assign(env, sandboxEnv(tmp), { CLAUDE_CODE_TMPDIR: tmp });
  const profileFile = path.join(sandbox.profileDir, `session-${process.pid}-${++profiles}.sb`);
  const profile = sandboxProfile({ kind: 'session', home: sandbox.home, writable: [cwd, sessionDir, tmp], denyRead: sandbox.denyRead ?? [], denyFiles: sandbox.denyFiles ?? [] });
  await fs.writeFile(profileFile, profile, { mode: 0o600 });
  return { command: SANDBOX_EXEC, args: ['-f', profileFile, claude, ...args], env, secret: credential?.value ?? null };
}

// One model session. Returns { ok, output, session_id, reason }: output is
// the CLI's JSON result when it parsed and is not an error.
export async function runSession({ claude, role, cwd, input, schema, settings, sessionDir, resume = null, timeoutMs, baseEnv = process.env, stderrFile = null, budget = null,
  sandbox = null, apiBaseUrl = null }) {
  const { settingsFile } = await prepareSession({ sessionDir, settings });
  const args = sessionArgs({ role, settingsFile, schema, resume, budget });
  const how = await sessionLaunch({ claude, args, cwd: real(cwd), sessionDir: real(sessionDir), baseEnv, sandbox, apiBaseUrl });
  const r = await launch({ command: how.command, args: how.args, cwd, env: how.env, input, timeoutMs, stderrFile, secret: how.secret });
  if (r.timedOut) return { ok: false, reason: `timed out after ${Math.round(timeoutMs / 1000)} s`, timedOut: true, raw: r.stdout };
  if (r.code !== 0) return { ok: false, reason: `exited ${r.code ?? r.signal ?? r.error}`, raw: r.stdout };
  let output;
  try { output = JSON.parse(r.stdout); } catch { return { ok: false, reason: 'output is not JSON', raw: r.stdout }; }
  if (!output || output.is_error || !output.structured_output || typeof output.structured_output !== 'object') {
    return { ok: false, reason: 'no structured result', output, raw: r.stdout };
  }
  return { ok: true, output, session_id: /^[0-9a-f-]{36}$/i.test(output.session_id || '') ? output.session_id : null, raw: r.stdout };
}
