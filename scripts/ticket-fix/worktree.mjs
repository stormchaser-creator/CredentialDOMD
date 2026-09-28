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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync, readFileSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';

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

export const isEditable = file => EDITABLE.some(p => file.startsWith(p)) && !NOT_EDITABLE.some(p => file.startsWith(p));
export const isRunnerCode = file => RUNNER_CODE.some(r => r.test(file));
export const isProduct = file => PRODUCT.some(p => file.startsWith(p));

// git with hooks off and no pager, never interactive. Throws with the command
// name only (never output, which can quote file contents).
export function git(dir, args, { env = process.env, allowFail = false, input, binary = 'git', timeout = 120000 } = {}) {
  const r = spawnSync(binary, ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.pager=cat', ...args],
    { encoding: 'utf8', env: { ...env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024, timeout, input });
  if (r.error || r.status !== 0) {
    if (allowFail) return null;
    throw Error(`git ${args.filter(a => !a.includes('\n')).slice(0, 3).join(' ')} failed in ${dir}${r.stderr ? `: ${r.stderr.trim().split('\n').slice(-1)[0].slice(0, 200)}` : ''}`);
  }
  return r.stdout;
}

// The hooks every worktree of this repository shares. Checked before every
// push (critique B2): a test the model wrote runs as the owner's user and
// could plant a pre-push hook. Returns a sha256 over names and contents.
export function hooksDigest(repo, { binary = 'git' } = {}) {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { binary }).trim();
  const configured = git(repo, ['config', '--get', 'core.hooksPath'], { binary, allowFail: true });
  const hash = createHash('sha256');
  hash.update(`hooksPath=${(configured || '').trim()}\n`);
  const dir = path.join(common, 'hooks');
  let names = [];
  try { names = readdirSync(dir).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = lstatSync(file);
    hash.update(`${name}\0${stat.mode}\0`);
    if (stat.isFile()) hash.update(readFileSync(file));
    else if (stat.isSymbolicLink()) hash.update(`link:${readlinkSync(file)}`);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function branchName(ticketId, runId) {
  if (!UUID.test(ticketId || '') || !RUN_ID.test(runId || '')) throw Error('A ticket id and a 16-hex run id are required');
  return `agent/${ticketId.slice(0, 8)}-${runId}`;
}

// G3a. Fetches origin main in the owner's repository (refs only; the owner's
// working tree and branch are never touched) and adds a worktree on a new
// branch. node_modules is linked from the owner's checkout when the lockfiles
// match; otherwise installNodeModules (npm ci by default) runs in the worktree.
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
  const hooks = hooksDigest(repo, { binary });
  const modules = await linkNodeModules({ repo, dir, base, binary, installNodeModules, env });
  return { dir, branch, base, hooks_sha256: hooks, node_modules: modules };
}

async function linkNodeModules({ repo, dir, base, binary, installNodeModules, env }) {
  const lock = file => { try { return readFileSync(file); } catch { return null; } };
  const ownerLock = lock(path.join(repo, 'package-lock.json'));
  const baseLock = git(dir, ['show', `${base}:package-lock.json`], { binary, allowFail: true });
  const same = (ownerLock === null && baseLock === null) || (ownerLock !== null && baseLock !== null && ownerLock.equals(Buffer.from(baseLock, 'utf8')));
  const source = path.join(repo, 'node_modules');
  if (same) {
    if (!existsSync(source)) return 'none';
    await fs.symlink(source, path.join(dir, 'node_modules'));
    return 'linked';
  }
  await installNodeModules(dir, env);
  return 'installed';
}
function defaultInstall(dir, env) {
  const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: dir, env, stdio: 'ignore', timeout: 15 * 60 * 1000 });
  if (r.error || r.status !== 0) throw Error('npm ci failed in the ticket worktree');
}

export function removeWorktree({ repo, dir, branch = null, deleteBranch = false, binary = 'git' }) {
  git(repo, ['worktree', 'remove', '--force', dir], { binary, allowFail: true });
  if (existsSync(dir)) spawnSync('/bin/rm', ['-rf', dir]);
  git(repo, ['worktree', 'prune'], { binary, allowFail: true });
  if (deleteBranch && branch) git(repo, ['branch', '-D', branch], { binary, allowFail: true });
}

// Every path the worktree differs from base in: committed, staged, unstaged
// and untracked (not ignored). The node_modules link is the host's own.
export function changedPaths(dir, base, { binary = 'git' } = {}) {
  const out = new Set();
  const committed = git(dir, ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD'], { binary });
  for (const f of committed.split('\0').filter(Boolean)) out.add(f);
  const status = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { binary });
  for (const entry of status.split('\0').filter(Boolean)) out.add(entry.slice(3));
  out.delete('node_modules');
  return [...out].sort();
}

// G0 on the result, not the permission rules: what the model changed.
export function classifyChanges(files, { frozen = {} } = {}) {
  const runnerCode = files.filter(isRunnerCode);
  const outside = files.filter(f => !isEditable(f) && !isRunnerCode(f));
  return { files, runner_code: runnerCode, outside, product: files.filter(isProduct), tests: files.filter(f => f.startsWith('tests/')),
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
// paths are staged. Returns the commit, or null when nothing changed.
export function commitWork({ dir, base, subject, ticketId, runId, committer, binary = 'git', env = process.env }) {
  if (!RUN_COMMITTER.test(committer || '')) throw Error('The run committer identity is required');
  git(dir, ['reset', '--quiet', '--soft', base], { binary });
  git(dir, ['reset', '--quiet'], { binary });
  const editable = changedPaths(dir, base, { binary }).filter(isEditable);
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
  const diff = git(dir, ['diff', '--no-color', '--no-ext-diff', from, to], { binary });
  if (!diff.trim()) return null;
  const out = git(dir, ['patch-id', '--stable'], { binary, input: diff }).trim();
  return out.split(/\s+/)[0] || null;
}
