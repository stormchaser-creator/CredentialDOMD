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
//
// Stage 3: two more roles. The checklist extractor ("extract", design G1)
// has no tools at all and gets the ticket's screenshots inline
// (--input-format stream-json); the confirmer ("confirm") is the reviewer's
// read-only role for runs with no change to review (attachment observations,
// sentences judged not to be asks). Every session now reports on
// --output-format stream-json: the host reads each Read tool call and its
// result from the CLI's own stdout (a test file a session runs cannot write
// there), which is the only proof that an attachment was looked at (G6). A
// session may Read this ticket's attachment directory and nothing next to it.
import { spawn } from 'node:child_process';
import { promises as fs, rmSync, readdirSync, existsSync, mkdirSync, writeFileSync, chmodSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SANDBOX_EXEC, sandboxProfile, sandboxEnv, real, slotEnv, pinDir, grantDir, hostTemp, dropHostTemp, removeHostTemps } from './sandbox.mjs';
import { ATTACH_ROOT_PREFIX } from './attachments.mjs';
import { redactSecrets, redactedLine } from './redact.mjs';

export const WORKER_MODEL = 'claude-sonnet-5';
export const REPRO_MODEL = 'claude-sonnet-5';
export const REVIEW_MODEL = 'claude-opus-5-5';
export const EXTRACT_MODEL = 'claude-opus-5-5';
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
// on the worktree is what lets them search it (checked live). attachments:
// this ticket's attachment directory (read only).
export function sessionSettings({ role, worktree, home, work, state = [], runDir = null, tmp = null, frozen = [], attachments = null }) {
  if (!['worker', 'repro'].includes(role)) throw Error('Unknown session role');
  const root = abs(worktree);
  const editRoots = role === 'repro' ? ['tests'] : EDIT_ROOTS;
  const files = attachmentRules(attachments);
  const allow = [`Read(${root}/**)`, ...files.allow,
    ...editRoots.flatMap(dir => [`Edit(${root}/${dir}/**)`, `Write(${root}/${dir}/**)`]),
    ...(role === 'repro' ? REPRO_COMMANDS : WORKER_COMMANDS)];
  const noEdit = [...NOT_EDITABLE.map(dir => `${root}/${dir}/**`), ...NOT_EDITABLE_FILES.map(f => `${root}/${f}`), `${root}/**/.env*`,
    ...frozen.map(f => `${root}/${f}`)];
  const deny = [...noEdit.flatMap(p => [`Edit(${p})`, `Write(${p})`]), ...DENIED_COMMANDS, 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
    ...secretReadDenials({ home, state: [...state, path.join(work, 'runs'), path.join(work, 'baseline')], runDir, tmp }), ...files.deny];
  return { permissions: { defaultMode: 'dontAsk', allow, deny, disableBypassPermissionsMode: 'disable' }, env: {} };
}

// This ticket's attachment directory (G6): Read is allowed there, and denied
// in every other directory next to it (another ticket of the same run) and in
// any other run's attachment root (left by a crash). The runner removes those
// before a session starts; the denial covers the case it could not.
export function attachmentRules(dir) {
  if (!dir) return { allow: [], deny: [] };
  const own = path.resolve(dir);
  const root = path.dirname(own);
  const deny = [];
  const list = d => { try { return readdirSync(d); } catch { return []; } };
  for (const name of list(root)) if (path.join(root, name) !== own) deny.push(`Read(${abs(path.join(root, name))}/**)`, `Read(${abs(path.join(root, name))})`);
  const parent = path.dirname(root);
  for (const name of list(parent)) if (name.startsWith(ATTACH_ROOT_PREFIX) && path.join(parent, name) !== root) deny.push(`Read(${abs(path.join(parent, name))}/**)`);
  return { allow: existsSync(own) ? [`Read(${abs(own)}/**)`] : [], deny };
}

// The reviewer and the confirmer: read-only, no Bash at all. The host hands
// the reviewer the diff.
export function reviewSettings({ worktree, home, work, state = [], runDir = null, tmp = null, attachments = null }) {
  const root = abs(worktree);
  const files = attachmentRules(attachments);
  return { permissions: { defaultMode: 'dontAsk', allow: [`Read(${root}/**)`, ...files.allow],
    deny: ['Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
      ...secretReadDenials({ home, state: [...state, path.join(work, 'runs'), path.join(work, 'baseline')], runDir, tmp }), ...files.deny],
    disableBypassPermissionsMode: 'disable' }, env: {} };
}
// The checklist extractor: the CLI offers it no tool but the structured
// result; everything is denied besides, so a CLI change cannot give it one.
export function extractSettings() {
  return { permissions: { defaultMode: 'dontAsk', allow: [], deny: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
    disableBypassPermissionsMode: 'disable' }, env: {} };
}

const ROLE = {
  worker: { model: WORKER_MODEL, effort: 'high', tools: WORKER_TOOLS, budget: 6 },
  repro: { model: REPRO_MODEL, effort: 'high', tools: WORKER_TOOLS, budget: 3 },
  review: { model: REVIEW_MODEL, effort: 'high', tools: REVIEW_TOOLS, budget: 5 },
  confirm: { model: REVIEW_MODEL, effort: 'high', tools: REVIEW_TOOLS, budget: 3 },
  extract: { model: EXTRACT_MODEL, effort: 'high', tools: [], budget: 2, streamInput: true },
};
export const SESSION_ROLES = Object.freeze(Object.keys(ROLE));
export const roleTakesStream = role => Boolean(ROLE[role]?.streamInput);
// One stream-json user message: text, then images (base64) for the extractor.
export function streamMessage(text, images = []) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text },
    ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }))] } })}\n`;
}

// The CLI's stream-json stdout, read as it arrives (a Read of an image carries
// the image, so nothing is kept but what the host needs): the final result
// event, and every Read tool call with whether its result was an error.
const TOOL_ERROR = /^\s*<tool_use_error>/;
export function streamCollector({ tailLimit = 4000 } = {}) {
  let buffer = '', result = null, events = 0, unparsed = 0, tail = '';
  const pending = new Map();
  const reads = [];
  const keep = line => { if (line.length < 2000) tail = `${tail}${line}\n`.slice(-tailLimit); };
  const handle = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { unparsed++; keep(line); return; }
    events++;
    keep(line);
    if (event?.type === 'result') { result = event; return; }
    const content = event?.message?.content;
    if (!Array.isArray(content)) return;
    if (event.type === 'assistant') {
      for (const block of content) if (block?.type === 'tool_use' && block.name === 'Read' && typeof block.input?.file_path === 'string') pending.set(block.id, block.input.file_path);
    } else if (event.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result' || !pending.has(block.tool_use_id)) continue;
        const text = typeof block.content === 'string' ? block.content : '';
        reads.push({ file_path: pending.get(block.tool_use_id), ok: block.is_error !== true && !TOOL_ERROR.test(text) });
        pending.delete(block.tool_use_id);
      }
    }
  };
  return {
    feed(chunk) {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) { handle(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
    },
    end() { if (buffer) handle(buffer); buffer = ''; return { result, reads, events, unparsed, tail }; },
  };
}

// The command line for one session. resume: a session id to continue (the
// repair, gate and review loops); the same settings apply again. Every role
// reports on stream-json; the extractor also reads stream-json (its images).
export function sessionArgs({ role, settingsFile, schema, resume = null, budget = null }) {
  const r = ROLE[role];
  if (!r) throw Error('Unknown session role');
  if (resume !== null && !/^[0-9a-f-]{36}$/i.test(resume)) throw Error('Invalid session id');
  return ['-p', ...(resume ? ['--resume', resume] : []), '--model', r.model, '--effort', r.effort,
    '--permission-mode', 'dontAsk', '--setting-sources', '', '--settings', settingsFile,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', r.tools.join(','),
    '--max-budget-usd', String(budget ?? r.budget), '--output-format', 'stream-json', '--verbose',
    ...(r.streamInput ? ['--input-format', 'stream-json'] : []), '--json-schema', JSON.stringify(schema)];
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

// The session directory (its CLAUDE_CONFIG_DIR, transcripts) is the
// session's to write, so the host writes no file there (review of
// 2026-09-30): the unsandboxed host followed a symlink a session left at
// settings.json or shims/ and overwrote a file of the owner's with its own
// content. It makes the directory when the session first starts and pins it
// (sandbox.mjs pinDir), and makes claude-config, an empty directory, only
// when it is missing and only after checking the session directory is still
// that one (grantDir). The settings file and the security shim of each
// launch go in a fresh directory of the host's (sessionFiles), which the
// session may read and never write.
const FILES = new Set();
// A fresh directory for one launch's settings and shim: in the sandbox's
// profile directory, which no sandboxed process can write (the session
// profile re-opens this one directory to read), or without a sandbox (tests
// only) in the host's temporary directory.
export async function sessionFiles(sandbox = null) {
  const dir = real(await fs.mkdtemp(path.join(sandbox ? sandbox.profileDir : os.tmpdir(), 'session-files-')));
  FILES.add(dir);
  return dir;
}
export async function prepareSession({ sessionDir, settings, files = null }) {
  const made = await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  if (made !== undefined) pinDir(sessionDir);
  else grantDir(sessionDir);
  const configDir = path.join(sessionDir, 'claude-config');
  let missing = false;
  try { lstatSync(configDir); } catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; }
  if (missing) await fs.mkdir(configDir, { mode: 0o700 });
  const own = files ?? await sessionFiles(null);
  const settingsFile = path.join(own, 'settings.json');
  await fs.writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { configDir, settingsFile, files: own };
}

// Process groups the runner started, ended on timeout, on exit and when the
// runner itself is signalled (the old alarm killed only the model; its npm and
// git children kept running). SIGTERM first, then SIGKILL after a grace
// (review of 2026-09-30): a SIGKILL that lands during a test's initdb kills
// the backend while it is attached to its System V segment, which then stays
// on the machine for good (macOS has 32), and a test process killed outright
// never stops its cluster or gives its PostgreSQL slot back. On SIGTERM the
// backend and initdb clean up and the slot helpers stop their clusters.
export const KILL_GRACE_MS = 3000;
const GROUPS = new Set();
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const signalGroup = (pid, signal) => { try { process.kill(-pid, signal); } catch { /* already gone */ } };
export async function endGroup(pid, graceMs = KILL_GRACE_MS) {
  if (!groupAlive(pid)) return;
  signalGroup(pid, 'SIGTERM');
  for (const until = Date.now() + graceMs; groupAlive(pid) && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 50));
  if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
}
// The same for several groups at once, synchronously (the stop and exit
// handlers cannot wait on the event loop).
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function endGroupsSync(pids, graceMs = KILL_GRACE_MS) {
  const alive = () => pids.filter(groupAlive);
  for (const pid of alive()) signalGroup(pid, 'SIGTERM');
  for (const until = Date.now() + graceMs; alive().length && Date.now() < until;) sleepSync(50);
  for (const pid of alive()) signalGroup(pid, 'SIGKILL');
}
// When the runner is signalled, a session's stderr is still in memory (it is
// written when the session ends) and the run record has no entry for it
// (review of 2026-09-29): the stop handler writes the stderr of every session
// in flight, synchronously, then runs the hooks the runner registered with
// onStop(fn) (fn(signal), synchronous: run.mjs puts the session and the stop
// on the run record), then exits.
const ACTIVE = new Set();
const STOP_HOOKS = new Set();
export function onStop(fn) {
  STOP_HOOKS.add(fn);
  return () => { STOP_HOOKS.delete(fn); };
}
export function flushActiveSessions(signal) {
  for (const active of ACTIVE) {
    ACTIVE.delete(active);
    try {
      const err = active.errors.end();
      keepStderrSync(active.file, redactSecrets(err.text, active.secrets), err.dropped, `[the runner was stopped by ${signal} while this session was running]`);
    } catch { /* the run record says the session was killed either way */ }
  }
}
let handlersInstalled = false;
export function installSignalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const stop = (signal, code) => () => {
    endGroupsSync([...GROUPS]);
    flushActiveSessions(signal);
    for (const hook of STOP_HOOKS) { try { hook(signal); } catch { /* never keep the runner from stopping */ } }
    removeSessionTemps();
    removeHostTemps();
    process.exit(code);
  };
  process.on('SIGTERM', stop('SIGTERM', 143));
  process.on('SIGINT', stop('SIGINT', 130));
  process.on('SIGHUP', stop('SIGHUP', 129));
  process.on('SIGALRM', stop('SIGALRM', 142));
  process.on('exit', () => { endGroupsSync([...GROUPS]); removeSessionTemps(); removeHostTemps(); });
}

// Runs one command in its own process group. stdout is captured (bounded)
// and returned; stderr goes to a file or is dropped. On timeout the whole
// group is ended (endGroup: SIGTERM, then SIGKILL); after a normal exit, any
// child it left behind is too.
// secret: a string written to file descriptor 3 (a pipe) and nowhere else;
// the child reads it once, and nothing it starts can read it from the
// environment.
// onStdout: a consumer for stdout as it arrives (a session's stream-json);
// stdout is then not kept. onStderr: the same for stderr (a model session's
// stderr is redacted before it is written anywhere); stderrFile is then
// not written.
export function launch({ command, args = [], cwd, env, input = '', timeoutMs, stdoutLimit = 32 * 1024 * 1024, stderrFile = null, secret = null, onStdout = null, onStderr = null }) {
  return new Promise(resolve => {
    let child;
    const stdio = secret === null ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'];
    try { child = spawn(command, args, { cwd, env, detached: true, stdio }); } catch (error) {
      resolve({ code: null, signal: null, timedOut: false, stdout: '', error: String(error.message) }); return;
    }
    GROUPS.add(child.pid);
    const chunks = []; let size = 0; let timedOut = false;
    let errOut = null;
    if (stderrFile && !onStderr) errOut = fs.open(stderrFile, 'a', 0o600).catch(() => null);
    if (onStdout) child.stdout.setEncoding('utf8');
    if (onStderr) child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      if (onStdout) { try { onStdout(String(d)); } catch { /* a consumer error never breaks the launch */ } return; }
      if (size < stdoutLimit) { chunks.push(d); size += d.length; }
    });
    child.stderr.on('data', async d => {
      if (onStderr) { try { onStderr(String(d)); } catch { /* a consumer error never breaks the launch */ } return; }
      const handle = await errOut; if (handle) handle.write(d).catch(() => {});
    });
    child.stdin.on('error', () => {});
    if (secret !== null) { child.stdio[3].on('error', () => {}); child.stdio[3].end(secret); }
    const timer = setTimeout(() => { timedOut = true; endGroup(child.pid); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); GROUPS.delete(child.pid); resolve({ code: null, signal: null, timedOut, stdout: '', error: String(error.message) }); });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      await endGroup(child.pid);
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
// denyRead, denyFiles, profileDir, slots }: profileDir must be a directory no
// sandboxed process can write (the profile is read before the sandbox starts);
// slots, the run's PostgreSQL test slot directory (sandbox.mjs runSlotDir).
let profiles = 0;
// Each sandboxed session's temporary directory: short (a unix socket path is
// limited to 104 bytes) and kept for the session's resumes, by session
// directory, in the host's memory: never in a file the session can write
// (the .tmpdir record it had followed a planted link), and granted as the
// host made it (sandbox.mjs hostTemp, grantDir: one a session swapped for a
// link stops the next launch instead of opening the link's target). Removed
// by removeSessionTemps() when the run ends.
const TEMPS = new Map();
function sessionTemp(sessionDir) {
  const key = path.resolve(sessionDir);
  if (!TEMPS.has(key)) TEMPS.set(key, hostTemp('cts-'));
  return TEMPS.get(key);
}
export function removeSessionTemps() {
  for (const [key, tmp] of TEMPS) { try { dropHostTemp(tmp); } catch { /* gone */ } TEMPS.delete(key); }
  for (const dir of FILES) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } FILES.delete(dir); }
}
// files: the launch's own directory from sessionFiles() (runSession passes
// the one prepareSession wrote the settings to); made here when absent.
export async function sessionLaunch({ claude, args, cwd, sessionDir, baseEnv = process.env, sandbox = null, apiBaseUrl = null, files = null }) {
  const configDir = path.join(sessionDir, 'claude-config');
  const credential = modelCredential(baseEnv);
  const env = { ...sessionEnv({ base: baseEnv, configDir, credentials: false }), ...(credential ? { [credential.variable]: String(CREDENTIAL_FD) } : {}),
    ...(apiBaseUrl ? { ANTHROPIC_BASE_URL: apiBaseUrl } : {}) };
  // The CLI runs `security` at start to look for a keychain credential. The
  // sandbox denies /usr/bin/security (and the security daemon), and the CLI
  // then crashed with EPERM before reading the credential it was handed on a
  // pipe: every run from 2026-09-29 16:17Z ended "extraction session exited 1".
  // A shim first on PATH answers "not found" (errSecItemNotFound, 44), so no
  // keychain item is read and the CLI falls through to the piped credential.
  // It lives in the launch's own directory, outside the session directory.
  const own = files ?? await sessionFiles(sandbox);
  const shims = path.join(own, 'shims');
  await fs.mkdir(shims, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(shims, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o700 });
  env.PATH = `${shims}:${env.PATH ?? '/usr/bin:/bin'}`;
  if (!sandbox) return { command: claude, args, env, secret: credential?.value ?? null };
  // Granted as the host made them (sandbox.mjs grantDir), never resolved here.
  const writable = [cwd, sessionDir, sessionTemp(sessionDir)].map(grantDir);
  const tmp = writable[2];
  if (writable.some(w => own === w || own.startsWith(`${w}/`))) throw Error('The session\'s settings and shim must be outside every directory it can write (sandbox.profileDir)');
  // The CLI keeps its own temporary files under /tmp/claude-<uid> unless told
  // otherwise; that directory holds other sessions' output and is denied.
  Object.assign(env, sandboxEnv(tmp), { CLAUDE_CODE_TMPDIR: tmp }, sandbox.slots ? slotEnv(sandbox.slots) : {});
  const profileFile = path.join(sandbox.profileDir, `session-${process.pid}-${++profiles}.sb`);
  const profile = sandboxProfile({ kind: 'session', home: sandbox.home, writable, shared: sandbox.slots ? [sandbox.slots] : [], denyRead: sandbox.denyRead ?? [], denyFiles: sandbox.denyFiles ?? [],
    readable: [...(sandbox.readable ?? []).filter(d => existsSync(d)), own] });
  await fs.writeFile(profileFile, profile, { mode: 0o600 });
  return { command: SANDBOX_EXEC, args: ['-f', profileFile, claude, ...args], env, secret: credential?.value ?? null };
}

// A session's stderr as it arrives, the newest limit characters of it (a
// crash or a refusal is at the end).
export function stderrCollector({ limit = 64 * 1024 } = {}) {
  let text = '', dropped = 0;
  const trim = () => { if (text.length > limit) { dropped += text.length - limit; text = text.slice(-limit); } };
  return {
    feed(chunk) { text += chunk; if (text.length > 2 * limit) trim(); },
    end() { trim(); return { text, dropped }; },
  };
}
// The model credentials a session was given, for redaction.
export const sessionSecrets = (base = process.env) => MODEL_CREDENTIALS.map(k => base[k]).filter(v => typeof v === 'string' && v.trim().length >= 8).map(v => v.trim());

// What the host records of one session, pass or fail (the run record and the
// log; runs/<run>/sessions/ keeps the stderr): the CLI's result subtype
// (success, error_max_budget_usd, error_max_turns, error_during_execution,
// error_max_structured_output_retries), its cost and turns, and the last
// error line: the result's own error, or else the last line of stderr. Every
// string is redacted and one line (redact.mjs).
export function sessionFacts({ output = null, stderrText = '', secrets = [], stderrFile = null }) {
  const errors = Array.isArray(output?.errors) ? output.errors.filter(e => typeof e === 'string' && e.trim()) : [];
  const lastLine = String(stderrText).split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? null;
  const failedResult = output?.is_error === true && typeof output.result === 'string' && output.result.trim() ? output.result : null;
  const error = errors.at(-1) ?? failedResult ?? lastLine;
  return {
    subtype: typeof output?.subtype === 'string' ? redactedLine(output.subtype, secrets, 60) : null,
    cost_usd: Number.isFinite(output?.total_cost_usd) ? output.total_cost_usd : null,
    turns: Number.isInteger(output?.num_turns) ? output.num_turns : null,
    ...(typeof output?.terminal_reason === 'string' ? { terminal_reason: redactedLine(output.terminal_reason, secrets, 60) } : {}),
    error: error === null ? null : redactedLine(error, secrets),
    stderr_last_line: lastLine === null ? null : redactedLine(lastLine, secrets),
    stderr_file: stderrFile,
  };
}
// The subscription's session or usage limit (2026-09-29). Once it is reached
// every session exits 1 at once with a result like "You've hit your session
// limit · resets 2pm (America/Los_Angeles)", and three such runs parked two
// tickets that had nothing wrong with them. It says nothing about the ticket,
// so run.mjs pauses the run (EXIT.usageLimit) and the shell counts nothing.
// Only a failed session's CLI text is read: the result of a non-zero exit or
// an is_error result, the errors list and the last stderr line, never a
// model's answer, and only the "hit/reached" forms, never a warning that the
// limit is near.
export const USAGE_LIMIT = /\b(?:hit|reached|exceeded) your (?:[\w-]+ )?limit\b|\b(?:session|usage|weekly|daily|5-hour|opus) limit (?:reached|hit|exceeded)\b/i;
export function usageLimitHit({ code = null, output = null, stderrText = '' } = {}) {
  const texts = [...(Array.isArray(output?.errors) ? output.errors : []), String(stderrText ?? '').split('\n').map(l => l.trim()).filter(Boolean).at(-1)];
  if (code !== 0 || output?.is_error === true) texts.push(output?.result);
  return texts.some(t => typeof t === 'string' && USAGE_LIMIT.test(t));
}
// The CLI's limit sentence out of a failed session's reason ("exited 1
// (success, 1 turn, $0.0000): You've hit your session limit · resets 2pm
// (America/Los_Angeles)"): from the clause that says it, at most 160
// characters, so the owner's alert says which limit and when it resets and
// carries nothing else of the error text. null when no text says it.
export function limitNotice(...texts) {
  for (const text of texts) {
    for (const line of String(text ?? '').split(/[\r\n]+/)) {
      const s = [...line].map(c => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/\s+/g, ' ').trim();
      const m = USAGE_LIMIT.exec(s);
      if (!m) continue;
      const colon = s.lastIndexOf(': ', m.index);
      const from = colon < 0 ? 0 : colon + 2;
      return s.slice(from, from + 160).trim();
    }
  }
  return null;
}
// "exited 1 (error_max_budget_usd, 57 turns, $3.0096): Reached maximum budget ($3)"
export function failureReason(head, facts) {
  const parts = [facts?.subtype, Number.isInteger(facts?.turns) ? `${facts.turns} turn${facts.turns === 1 ? '' : 's'}` : null,
    Number.isFinite(facts?.cost_usd) ? `$${facts.cost_usd.toFixed(4)}` : null].filter(Boolean);
  return `${head}${parts.length ? ` (${parts.join(', ')})` : ''}${facts?.error ? `: ${facts.error}` : ''}`;
}
// The same, synchronously, for the stop handler; note: a last line saying why
// the file ends where it does.
function keepStderrSync(file, text, dropped, note) {
  if (!file || !text.trim()) return null;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${dropped ? `[the first ${dropped} characters were dropped; the newest are kept]\n` : ''}${text}${text.endsWith('\n') ? '' : '\n'}${note}\n`, { mode: 0o600, flag: 'w' });
  chmodSync(file, 0o600);
  return file;
}
// The session's stderr, redacted, owner-only. Nothing is written for a
// session that printed nothing.
async function keepStderr(file, text, dropped) {
  if (!file || !text.trim()) return null;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = `${dropped ? `[the first ${dropped} characters were dropped; the newest are kept]\n` : ''}${text}`;
  await fs.writeFile(file, body, { mode: 0o600, flag: 'w' });
  await fs.chmod(file, 0o600);
  return file;
}

// One model session. Returns { ok, output, session_id, reason, reads, session }:
// output is the CLI's result event when there is one and it is not an error;
// reads are the session's Read tool calls, each with whether it succeeded;
// session is sessionFacts() (subtype, cost, turns, last error line and the
// stderr file). A failed session's reason carries the subtype, cost and
// error line; usage_limit is true when the subscription's limit stopped it. input: text, or (the extractor) a ready stream-json message.
// stderrFile: where the session's redacted stderr is kept (the runner puts it
// under runs/<run>/sessions/, which outlives the run directory).
export async function runSession({ claude, role, cwd, input, schema, settings, sessionDir, resume = null, timeoutMs, baseEnv = process.env, stderrFile = null, budget = null,
  sandbox = null, apiBaseUrl = null }) {
  const { settingsFile, files } = await prepareSession({ sessionDir, settings, files: await sessionFiles(sandbox) });
  const args = sessionArgs({ role, settingsFile, schema, resume, budget });
  // cwd and sessionDir as the host made them: never resolved again here.
  const how = await sessionLaunch({ claude, args, cwd, sessionDir, baseEnv, sandbox, apiBaseUrl, files });
  const stream = streamCollector();
  const errors = stderrCollector();
  const secrets = sessionSecrets(baseEnv);
  const text = roleTakesStream(role) && !String(input).startsWith('{"type":"user"') ? streamMessage(String(input)) : input;
  // In flight until its stderr is kept: the stop handler writes it if the
  // runner is signalled first.
  const active = { errors, file: stderrFile, secrets };
  ACTIVE.add(active);
  let r, err, kept = null;
  try {
    r = await launch({ command: how.command, args: how.args, cwd, env: how.env, input: text, timeoutMs, secret: how.secret,
      onStdout: chunk => stream.feed(chunk), onStderr: chunk => errors.feed(chunk) });
    err = errors.end();
    try { kept = await keepStderr(stderrFile, redactSecrets(err.text, secrets), err.dropped); } catch { kept = null; }
  } finally { ACTIVE.delete(active); }
  const { result: output, reads, tail } = stream.end();
  const session = sessionFacts({ output, stderrText: err.text, secrets, stderrFile: kept });
  // usage_limit: the subscription's limit stopped it (usageLimitHit).
  const limit = () => (usageLimitHit({ code: r.code, output, stderrText: err.text }) ? { usage_limit: true } : {});
  if (r.timedOut) return { ok: false, reason: failureReason(`timed out after ${Math.round(timeoutMs / 1000)} s`, session), timedOut: true, raw: tail, reads, session };
  if (r.code !== 0) return { ok: false, reason: failureReason(`exited ${r.code ?? r.signal ?? r.error}`, session), raw: tail, reads, session, ...limit() };
  if (!output) return { ok: false, reason: failureReason('output is not JSON', session), raw: tail, reads, session, ...limit() };
  if (output.is_error || !output.structured_output || typeof output.structured_output !== 'object') {
    return { ok: false, reason: failureReason('no structured result', session), output, raw: tail, reads, session, ...limit() };
  }
  return { ok: true, output, session_id: /^[0-9a-f-]{36}$/i.test(output.session_id || '') ? output.session_id : null, raw: tail, reads, session };
}
