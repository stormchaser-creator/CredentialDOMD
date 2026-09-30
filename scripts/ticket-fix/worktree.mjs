// Branch-only work for the hourly ticket agent (design G3a and the host
// commit of G3b; critique B2).
//
// The model never touches main or the owner's checkout. For each ticket run
// the host creates a git worktree on a new branch agent/<id8>-<runid> from
// origin/main, under the runner's private work directory, and the model edits
// only that worktree. The host, not the model, makes the one commit on the
// branch, with hooks disabled (core.hooksPath=/dev/null: a worktree shares the
// main checkout's .git/hooks), the agent as author and trailers that tell an
// agent commit apart from the owner's:
//   Ticket: <id8>
//   Ticket-Agent-Run: <runid>
//   Gates: <sha256 of gates.json>        (added once the gates have run)
// The committer is the run's identity (ticket-agent+<runid>@...), which is how
// the reply path recognises a commit this run made.
//
// Every git call the host makes ignores the system config, never runs an
// fsmonitor, an ssh command from config or the ext:: transport, and has no
// credential helper except for the one push (stage 2 review, finding 8). The
// gates never run in the model's worktree: they run in a fresh detached
// worktree of the commit (gateWorktree), so a git-ignored file the fixer left
// behind cannot make a tree pass that is not the commit (findings 10, 11).
// Each worktree gets its own APFS clone of node_modules, never a link to the
// owner's (finding 1).
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, existsSync, readFileSync, lstatSync, readdirSync, readlinkSync, realpathSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostTemp, dropHostTemp, pinDir, forgetDir } from './sandbox.mjs';

export const AGENT_NAME = 'CredentialDOMD Ticket Agent';
export const AGENT_EMAIL = 'ticket-agent@credentialdomd.invalid';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RUN_ID = /^[0-9a-f]{16}$/;
const SHA = /^[0-9a-f]{40}$/;
export const RUN_COMMITTER = /^ticket-agent\+[0-9a-f]{16}@credentialdomd\.invalid$/;

// Where the model may edit (G0). Everything else in its diff is refused.
export const EDITABLE = Object.freeze(['src/', 'tests/', 'public/', 'landing/']);
export const NOT_EDITABLE = Object.freeze(['tests/ticket-fix/']);
// The runner's own code. A run whose diff touches any of it holds every later
// run until the owner has looked (ticket-agent.sh PROTECTED, same list).
export const RUNNER_CODE = Object.freeze([/^scripts\/ticket-fix\//, /^scripts\/ticket-agent/, /^scripts\/notify-owner\.sh$/,
  /^supabase\/migrations\/[^/]*support_reply/, /^supabase\/functions\/send-ticket-reply\//]);
export const PRODUCT = Object.freeze(['src/', 'public/', 'landing/']);

// Files that change how git itself reads the tree: a "-diff" line hides a
// change from every host diff, a .gitignore hides files from the commit, a
// .gitmodules names other repositories. Never the model's to change.
export const GIT_META = Object.freeze(['.gitattributes', '.gitignore', '.gitmodules', '.git', '.mailmap']);
export const isGitMeta = file => file.split('/').some(part => GIT_META.includes(part));
export const isEditable = file => EDITABLE.some(p => file.startsWith(p)) && !NOT_EDITABLE.some(p => file.startsWith(p)) && !isGitMeta(file);
export const isRunnerCode = file => RUNNER_CODE.some(r => r.test(file));
export const isProduct = file => PRODUCT.some(p => file.startsWith(p));

// git with hooks off and no pager, never interactive, no system config, no
// fsmonitor, no ssh command or ext:: transport from config and no credential
// helper (credentials: true keeps the configured helpers, for the one push).
// Throws with the command name only (never output, which can quote file
// contents).
export const HOST_GIT_CONFIG = Object.freeze(['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false',
  '-c', 'core.sshCommand=ssh', '-c', 'protocol.ext.allow=never', '-c', 'core.askPass=']);
// encoding: 'buffer' returns the bytes (a blob as git holds it).
export function git(dir, args, { env = process.env, allowFail = false, input, binary = 'git', timeout = 120000, credentials = false, encoding = 'utf8' } = {}) {
  const r = spawnSync(binary, ['-C', dir, ...HOST_GIT_CONFIG, ...(credentials ? [] : ['-c', 'credential.helper=']), ...args],
    { encoding, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 64 * 1024 * 1024, timeout, input });
  if (r.error || r.status !== 0) {
    if (allowFail) return null;
    const stderr = r.stderr ? String(r.stderr).trim() : '';
    throw Error(`git ${args.filter(a => !a.includes('\n')).slice(0, 3).join(' ')} failed in ${dir}${stderr ? `: ${stderr.split('\n').slice(-1)[0].slice(0, 200)}` : ''}`);
  }
  return r.stdout;
}
// Options for every host diff or grep of the model's change: attributes come
// from the trusted base tree, never from the worktree (a "-diff" line would
// turn a source file into "Binary files differ"), and no textconv or external
// diff driver runs. DIFF_TEXT forces text so a NUL byte cannot hide a file
// either; media files are left out of text diffs.
export const attrFrom = tree => ['-c', `attr.tree=${tree}`];
export const DIFF_TEXT = Object.freeze(['--text', '--no-textconv', '--no-ext-diff', '--no-color']);
const MEDIA = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns', 'pdf', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'zip', 'gz', 'pfb'];
export const MEDIA_EXCLUDES = Object.freeze(MEDIA.map(ext => `:(exclude,glob)**/*.${ext}`));
export const MEDIA_FILE = new RegExp(`\\.(?:${MEDIA.join('|')})$`, 'i');

// The hooks and git configuration every worktree of this repository shares,
// and the owner's global git configuration. Checked before every push and
// after every session and gate run: a test the model wrote runs as the
// owner's user, and a planted hook, credential.helper, fsmonitor, url
// rewrite or attribute file in the shared repository would reach the host's
// own git (critique B2, stage 2 review finding 8). Returns a sha256 over
// names and contents.
export function hooksDigest(repo, { binary = 'git', home = os.homedir() } = {}) {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { binary }).trim();
  const configured = git(repo, ['config', '--get', 'core.hooksPath'], { binary, allowFail: true });
  const hash = createHash('sha256');
  hash.update(`hooksPath=${(configured || '').trim()}\n`);
  // A file the host cannot read (the gates sandbox denies ~/.gitconfig to
  // the repository's own tests) hashes as unreadable, the same every time.
  const file = (label, full) => {
    let stat = null, unreadable = false;
    try { stat = lstatSync(full); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) unreadable = true; else if (error.code !== 'ENOENT') throw error; }
    hash.update(`${label}\0${stat ? stat.mode : unreadable ? 'unreadable' : 'absent'}\0`);
    if (stat?.isFile()) hash.update(readFileSync(full));
    else if (stat?.isSymbolicLink()) hash.update(`link:${readlinkSync(full)}`);
    hash.update('\n');
  };
  const dir = path.join(common, 'hooks');
  let names = [];
  try { names = readdirSync(dir).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of names) file(`hooks/${name}`, path.join(dir, name));
  for (const name of ['config', 'config.worktree', 'info/attributes', 'info/exclude']) file(name, path.join(common, name));
  // Per-worktree config (only when extensions.worktreeConfig is on): hashed
  // when present, so adding or removing a worktree does not change the digest.
  let worktrees = [];
  try { worktrees = readdirSync(path.join(common, 'worktrees')).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of worktrees) if (existsSync(path.join(common, 'worktrees', name, 'config.worktree'))) file(`worktrees/${name}/config.worktree`, path.join(common, 'worktrees', name, 'config.worktree'));
  const xdg = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : path.join(home, '.config');
  file('global', path.join(home, '.gitconfig'));
  file('xdg', path.join(xdg, 'git', 'config'));
  return hash.digest('hex');
}

// The model's worktree must still point at the git directory the host made
// for it. A worktree's ".git" is a file inside the worktree, which the
// session can write: pointed at a directory of its own choosing, every host
// git call there would read that directory's config.
export function worktreeGitdir(dir, { binary = 'git' } = {}) {
  return realpathSync(git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'], { binary }).trim());
}
export function checkWorktreeLink(dir, gitdir) {
  if (!gitdir) throw Error('The run does not record its worktree git directory');
  const file = path.join(dir, '.git');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('The worktree .git link was replaced');
  const text = readFileSync(file, 'utf8');
  const target = /^gitdir: (.+)\n?$/.exec(text)?.[1];
  if (!target || realpathSync(path.resolve(dir, target)) !== gitdir) throw Error('The worktree .git link was changed');
}

// origin's main as the remote has it now (no fetch, no ref changes), or null
// when the remote cannot be read.
export function remoteMain(repo, { binary = 'git', env = process.env } = {}) {
  const out = git(repo, ['ls-remote', '--quiet', 'origin', 'refs/heads/main'], { binary, env, allowFail: true, timeout: 60000 });
  const sha = out?.trim().split(/\s+/)[0] ?? '';
  return SHA.test(sha) ? sha : null;
}
// Whether any commit origin main gained since `from` was made by the ticket
// agent (its author or committer identity, or a Ticket-Agent-Run trailer):
// agent work that reached main without the host's merge. Fetches the refs.
export function agentCommitsOnMain(repo, from, { binary = 'git', env = process.env } = {}) {
  git(repo, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { binary, env, allowFail: true, timeout: 180000 });
  const log = git(repo, ['log', '--format=%ae%n%ce%n%B%x00', `${from}..refs/remotes/origin/main`], { binary, allowFail: true });
  if (log === null) return null;
  return log.split('\0').filter(entry => entry.includes(AGENT_EMAIL) || /ticket-agent\+[0-9a-f]{16}@credentialdomd\.invalid/.test(entry) || /^Ticket-Agent-Run: /m.test(entry)).length;
}

export function branchName(ticketId, runId) {
  if (!UUID.test(ticketId || '') || !RUN_ID.test(runId || '')) throw Error('A ticket id and a 16-hex run id are required');
  return `agent/${ticketId.slice(0, 8)}-${runId}`;
}

// G3a. Fetches origin main in the owner's repository (refs only; the owner's
// working tree and branch are never touched) and adds a worktree on a new
// branch. node_modules is an APFS clone (copy on write: seconds, no extra
// space) of a host-owned source: the owner's checkout when its lockfile is
// base's, otherwise <work>/modules/<lockfile sha256>, installed once with
// installNodeModules (npm ci --ignore-scripts by default). Never a link: a
// test the model wrote could write through it into the owner's modules.
export async function createWorktree({ repo, work, ticketId, runId, binary = 'git', fetch = true, installNodeModules = defaultInstall, env = process.env }) {
  const branch = branchName(ticketId, runId);
  const name = `${ticketId.slice(0, 8)}-${runId}`;
  const root = path.join(work, 'worktrees');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, name);
  if (existsSync(dir)) throw Error(`Worktree ${name} already exists`);
  if (fetch) git(repo, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { binary, env, timeout: 180000 });
  const base = git(repo, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], { binary }).trim();
  if (!SHA.test(base)) throw Error('origin/main is not a commit');
  git(repo, ['worktree', 'add', '--quiet', '-b', branch, dir, base], { binary, env });
  // Sessions write it, the directory entry included: pinned, so a session
  // that swaps it for a link is refused, not followed (sandbox.mjs grantDir).
  pinDir(dir);
  const hooks = hooksDigest(repo, { binary });
  const modules = await moduleSource({ repo, work, base, binary, installNodeModules, env });
  const copied = await cloneModules(modules, dir);
  return { dir, branch, base, gitdir: worktreeGitdir(dir, { binary }), hooks_sha256: hooks, node_modules: copied ? modules.kind : 'none', modules_source: modules.dir };
}

// Where node_modules comes from for a base: { kind, dir } (dir null: none).
export async function moduleSource({ repo, work, base, binary = 'git', installNodeModules = defaultInstall, env = process.env }) {
  const lock = file => { try { return readFileSync(file); } catch { return null; } };
  const ownerLock = lock(path.join(repo, 'package-lock.json'));
  const baseLock = git(repo, ['show', `${base}:package-lock.json`], { binary, allowFail: true });
  const same = (ownerLock === null && baseLock === null) || (ownerLock !== null && baseLock !== null && ownerLock.equals(Buffer.from(baseLock, 'utf8')));
  if (same) return { kind: 'cloned', dir: existsSync(path.join(repo, 'node_modules')) ? path.join(repo, 'node_modules') : null };
  const key = createHash('sha256').update(baseLock ?? '').digest('hex');
  const cache = path.join(work, 'modules', key);
  const target = path.join(cache, 'node_modules');
  if (existsSync(path.join(cache, '.complete'))) return { kind: 'installed', dir: target };
  await fs.rm(cache, { recursive: true, force: true });
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(cache, 'package.json'), git(repo, ['show', `${base}:package.json`], { binary }), { mode: 0o600 });
  if (baseLock !== null) await fs.writeFile(path.join(cache, 'package-lock.json'), baseLock, { mode: 0o600 });
  await installNodeModules(cache, env);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(cache, '.complete'), '', { mode: 0o600 });
  return { kind: 'installed', dir: target };
}
function defaultInstall(dir, env) {
  const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: dir, env, stdio: 'ignore', timeout: 15 * 60 * 1000 });
  if (r.error || r.status !== 0) throw Error('npm ci failed for the ticket worktree');
}
// An APFS clone where the filesystem allows it (cp -c), else a plain copy.
export async function cloneModules(source, dir) {
  const from = typeof source === 'string' ? source : source?.dir ?? null;
  if (!from || !existsSync(from)) return false;
  const to = path.join(dir, 'node_modules');
  let r = spawnSync('/bin/cp', ['-c', '-R', from, to], { stdio: 'ignore', timeout: 10 * 60 * 1000 });
  if (r.status !== 0) {
    await fs.rm(to, { recursive: true, force: true });
    r = spawnSync('/bin/cp', ['-R', from, to], { stdio: 'ignore', timeout: 20 * 60 * 1000 });
  }
  if (r.error || r.status !== 0) throw Error('Could not copy node_modules into the worktree');
  return true;
}

// A fresh detached worktree of one commit for the gates (and the
// reproduction record, the base count and the merge re-gate). Nothing the
// model left in its own worktree (git-ignored files, a changed node_modules)
// is in it. remove() deletes it. Both it and its temporary directory are
// pinned when made (sandbox.mjs pinDir): every gate step runs test code that
// can write them, entries included, and each later step is granted them only
// while they are still what the host made (review of 2026-09-30). The
// temporary directory is tracked by the host (hostTemp), so a signalled
// runner removes it too; it holds the tests' PostgreSQL data directories.
export async function gateWorktree({ repo, work, commit, modules = null, binary = 'git', label = 'gate' }) {
  if (!SHA.test(commit || '')) throw Error('A gate worktree needs a full commit id');
  const root = path.join(work, 'gates');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const name = `${label}-${commit.slice(0, 12)}-${randomBytes(4).toString('hex')}`;
  const dir = path.join(root, name);
  // Short, for unix socket paths (sandbox.mjs SHORT_TMP).
  const tmp = hostTemp('ctg-');
  try {
    git(repo, ['worktree', 'add', '--quiet', '--detach', dir, commit], { binary });
    pinDir(dir);
    await cloneModules(modules, dir);
  } catch (error) { removeWorktree({ repo, dir, binary }); dropHostTemp(tmp); throw error; }
  return { dir, tmp, remove: async () => { removeWorktree({ repo, dir, binary }); dropHostTemp(tmp); } };
}

// A commit object (on no branch) of base plus the given paths as they are in
// dir, made through a scratch index so dir's own index is untouched. Used to
// run the reproduction on base in a gate worktree.
export function snapshotCommit({ dir, base, files, binary = 'git', message = 'Reproduction snapshot' }) {
  const index = path.join(os.tmpdir(), `ticket-snapshot-${process.pid}-${randomBytes(6).toString('hex')}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(dir, ['read-tree', base], { binary, env });
    if (files.length) git(dir, ['add', '-A', '--', ...files], { binary, env });
    const tree = git(dir, ['write-tree'], { binary, env }).trim();
    return git(dir, ['commit-tree', tree, '-p', base, '-m', message], { binary, env: { ...env, GIT_AUTHOR_NAME: AGENT_NAME, GIT_AUTHOR_EMAIL: AGENT_EMAIL,
      GIT_COMMITTER_NAME: AGENT_NAME, GIT_COMMITTER_EMAIL: AGENT_EMAIL } }).trim();
  } finally { try { spawnSync('/bin/rm', ['-f', index]); } catch { /* gone */ } }
}

// A link found where the worktree was (sandboxed code can replace the
// directory entry) is removed itself and never handed to git: what it points
// at is not this worktree.
export function removeWorktree({ repo, dir, branch = null, deleteBranch = false, binary = 'git' }) {
  let link = false;
  try { link = lstatSync(dir).isSymbolicLink(); } catch { link = false; }
  if (link) rmSync(dir, { force: true });
  else git(repo, ['worktree', 'remove', '--force', dir], { binary, allowFail: true });
  forgetDir(dir);
  if (existsSync(dir)) spawnSync('/bin/rm', ['-rf', dir]);
  git(repo, ['worktree', 'prune'], { binary, allowFail: true });
  if (deleteBranch && branch) git(repo, ['branch', '-D', branch], { binary, allowFail: true });
}

// Every path the worktree differs from base in: committed, staged, unstaged
// and untracked. ignored: also the git-ignored files under the editable
// roots, less node_modules and the files `npm test` generates, which the
// commit would silently leave out (stage 2 review, finding 11).
export const GENERATED = Object.freeze([/^public\/credential-access\/vendor\//]);
export function changedPaths(dir, base, { binary = 'git', ignored = false } = {}) {
  const out = new Set();
  const committed = git(dir, ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD'], { binary });
  for (const f of committed.split('\0').filter(Boolean)) out.add(f);
  const status = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { binary });
  for (const entry of status.split('\0').filter(Boolean)) out.add(entry.slice(3));
  out.delete('node_modules');
  if (ignored) for (const f of ignoredPaths(dir, { binary })) out.add(f);
  return [...out].sort();
}
export function ignoredPaths(dir, { binary = 'git', limit = 200 } = {}) {
  const status = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames', '--', ...EDITABLE.map(p => p.slice(0, -1))], { binary });
  const out = [];
  // An ignored directory is listed as "dir/": name the files in it.
  const walk = rel => {
    if (out.length >= limit) return;
    let entries = [];
    try { entries = readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { out.push(rel); return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}${e.name}`;
      if (e.isDirectory() && !e.isSymbolicLink()) walk(`${child}/`); else if (out.length < limit) out.push(child);
    }
  };
  for (const entry of status.split('\0').filter(e => e.startsWith('!! ')).map(e => e.slice(3))) {
    if (entry.startsWith('node_modules') || entry.split('/').includes('node_modules') || GENERATED.some(r => r.test(entry))) continue;
    if (entry.endsWith('/')) walk(entry); else out.push(entry);
  }
  return out.filter(f => !GENERATED.some(r => r.test(f)));
}

// Source files git would treat as binary if they held a NUL byte; one is
// refused, so no host diff or grep can skip it.
const TEXT_FILE = /\.(?:m?js|cjs|jsx|ts|tsx|css|html?|json|md|svg|txt|ya?ml)$/i;
function hasNul(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    for (let offset = 0; ;) { const n = readSync(fd, buffer, 0, buffer.length, offset); if (!n) return false; if (buffer.subarray(0, n).includes(0)) return true; offset += n; }
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}
// Paths no change may carry whatever their directory: git metadata files, a
// symbolic link, a nested repository or directory entry, an ignored file, or
// a source file with a NUL byte. dir: the worktree to look at.
export function specialPaths(dir, files, { ignored = [] } = {}) {
  const special = [];
  for (const file of files) {
    if (isGitMeta(file) || ignored.includes(file)) { special.push(file); continue; }
    let stat = null;
    try { stat = lstatSync(path.join(dir, file)); } catch { stat = null; }
    if (stat && (stat.isSymbolicLink() || stat.isDirectory() || !stat.isFile())) special.push(file);
    else if (stat && TEXT_FILE.test(file) && hasNul(path.join(dir, file))) special.push(file);
  }
  return special;
}

// G0 on the result, not the permission rules: what the model changed. With
// dir, the special paths above are refused too.
export function classifyChanges(files, { frozen = {}, dir = null, ignored = [] } = {}) {
  const runnerCode = files.filter(isRunnerCode);
  const special = dir ? specialPaths(dir, files.filter(f => !isRunnerCode(f)), { ignored }) : files.filter(isGitMeta);
  const outside = [...new Set([...files.filter(f => !isEditable(f) && !isRunnerCode(f)), ...special])].sort();
  return { files, runner_code: runnerCode, outside, special, ignored: files.filter(f => ignored.includes(f)), product: files.filter(isProduct), tests: files.filter(f => f.startsWith('tests/')),
    frozen_changed: Object.keys(frozen).filter(f => files.includes(f)) };
}

// sha256 of each file as it is now in the worktree (null when absent).
export function fileDigests(dir, files) {
  const digests = {};
  for (const file of files) {
    try { digests[file] = createHash('sha256').update(readFileSync(path.join(dir, file))).digest('hex'); } catch { digests[file] = null; }
  }
  return digests;
}

// A one-line commit subject a public repository can carry: printable ASCII,
// no addresses, phone-like or long digit runs, no hex ids, 72 characters.
export function sanitizeSubject(subject, ticketId) {
  let s = String(subject ?? '').normalize('NFKD').replace(/[^\x20-\x7e]/g, ' ');
  s = s.replace(/\S+@\S+/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\b[0-9a-f]{7,40}\b/gi, ' ').replace(/\d[\d\s().-]{6,}\d/g, ' ')
    .replace(/[^A-Za-z0-9 .,:;'()/_+-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 8) s = `Ticket ${ticketId.slice(0, 8)}: agent change`;
  return s.slice(0, 72).trim();
}

export function commitMessage({ subject, ticketId, runId, gatesSha256 = null }) {
  if (gatesSha256 !== null && !/^[0-9a-f]{64}$/.test(gatesSha256)) throw Error('Invalid gates digest');
  return `${sanitizeSubject(subject, ticketId)}\n\nPrepared by the CredentialDOMD ticket agent on a branch. The host ran the\ngates and an independent review; the run record holds both.\n\nTicket: ${ticketId.slice(0, 8)}\nTicket-Agent-Run: ${runId}${gatesSha256 ? `\nGates: ${gatesSha256}` : ''}\n`;
}

const agentEnv = (env, committer) => ({ ...env, GIT_AUTHOR_NAME: AGENT_NAME, GIT_AUTHOR_EMAIL: AGENT_EMAIL,
  GIT_COMMITTER_NAME: AGENT_NAME, GIT_COMMITTER_EMAIL: committer });

// The host's commit of the model's work: always ONE commit on base, so a
// repaired or revised run replaces it rather than stacking. Only editable
// paths are staged, never a git metadata file, a link, a nested repository
// or a source file with a NUL byte (G0 refuses those before this runs). Returns the commit, or null when nothing changed.
export function commitWork({ dir, base, subject, ticketId, runId, committer, binary = 'git', env = process.env }) {
  if (!RUN_COMMITTER.test(committer || '')) throw Error('The run committer identity is required');
  git(dir, ['reset', '--quiet', '--soft', base], { binary });
  git(dir, ['reset', '--quiet'], { binary });
  const changed = changedPaths(dir, base, { binary });
  const special = new Set(specialPaths(dir, changed));
  const editable = changed.filter(f => isEditable(f) && !special.has(f));
  if (editable.length) git(dir, ['add', '-A', '--', ...editable], { binary });
  const staged = git(dir, ['diff', '--cached', '--name-only', '-z'], { binary }).split('\0').filter(Boolean);
  if (!staged.length) return null;
  if (staged.some(f => !isEditable(f))) throw Error('A path outside the editable set was staged');
  git(dir, ['commit', '--quiet', '--no-verify', '-F', '-'], { binary, env: agentEnv(env, committer), input: commitMessage({ subject, ticketId, runId }) });
  return git(dir, ['rev-parse', 'HEAD'], { binary }).trim();
}

// Adds the Gates trailer once gates.json exists. The tree is unchanged, so
// the gates (which record the tree) still describe the commit.
export function addGatesTrailer({ dir, subject, ticketId, runId, committer, gatesSha256, binary = 'git', env = process.env }) {
  const tree = git(dir, ['rev-parse', 'HEAD^{tree}'], { binary }).trim();
  git(dir, ['commit', '--quiet', '--amend', '--no-verify', '-F', '-'], { binary, env: agentEnv(env, committer), input: commitMessage({ subject, ticketId, runId, gatesSha256 }) });
  if (git(dir, ['rev-parse', 'HEAD^{tree}'], { binary }).trim() !== tree) throw Error('Amending the trailer changed the tree');
  return git(dir, ['rev-parse', 'HEAD'], { binary }).trim();
}

// Trailers of a commit, parsed from its message.
export function trailers(dir, commit, { binary = 'git' } = {}) {
  const out = git(dir, ['log', '-1', '--format=%B', commit], { binary });
  const found = {};
  for (const line of out.split('\n')) {
    const m = /^(Ticket|Ticket-Agent-Run|Gates): (\S+)$/.exec(line.trim());
    if (m) found[m[1]] = m[2];
  }
  return found;
}

// `git patch-id --stable` of a range: two diffs with the same id are the
// same change, whatever their base.
export function patchId(dir, from, to, { binary = 'git' } = {}) {
  const diff = git(dir, [...attrFrom(from), 'diff', ...DIFF_TEXT, from, to], { binary });
  if (!diff.trim()) return null;
  const out = git(dir, ['patch-id', '--stable'], { binary, input: diff }).trim();
  return out.split(/\s+/)[0] || null;
}
