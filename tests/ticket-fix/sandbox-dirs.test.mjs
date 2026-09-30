// The directories a sandboxed process may write, and whether the next launch
// still grants only them (review of 2026-09-30). A profile grants
// (subpath W), which covers W itself: code in the sandbox can move W away or
// remove it and leave a symlink at W. The host resolved W again at every
// launch, so the next profile granted the link's target, and the unsandboxed
// host wrote its settings and shim into the session directory through links
// the session had left there. Each test here does what the sandboxed code
// did, under the real profile, then checks the next launch. Every value is
// synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxAvailable } from '../../scripts/ticket-fix/sandbox.mjs';
import { sessionLaunch, runSession, removeSessionTemps } from '../../scripts/ticket-fix/worker.mjs';
import { gateLaunch } from '../../scripts/ticket-fix/gates/tests.mjs';
import { gateWorktree } from '../../scripts/ticket-fix/worktree.mjs';
import { project, sh, gatesSandbox } from './stage2-helpers.mjs';

const skip = sandboxAvailable() ? false : 'needs sandbox-exec (macOS, not inside another sandbox)';
const HOME = os.homedir();
function scratch() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sandbox-dirs-')));
  const dirs = { base, wt: path.join(base, 'wt'), sessions: path.join(base, 'run', 'sessions'), victim: path.join(base, 'victim'), profiles: path.join(base, 'profiles') };
  for (const d of [dirs.wt, dirs.sessions, dirs.victim, dirs.profiles]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return { ...dirs, sandbox: { home: HOME, denyRead: [], denyFiles: [], profileDir: dirs.profiles }, cleanup: () => { removeSessionTemps(); rmSync(base, { recursive: true, force: true }); } };
}
// Runs a shell script under the profile a launch returned.
const underProfile = (how, script, cwd) => spawnSync(how.command, [...how.args, '-c', script], { env: how.env, cwd, encoding: 'utf8' });
// What the host says when it refuses a directory (sandbox.mjs SandboxDirChanged).
const CHANGED = /is not the directory the host made for it/;
const profilesMention = (dir, text) => readdirSync(dir).filter(n => n.endsWith('.sb')).some(n => readFileSync(path.join(dir, n), 'utf8').includes(text));

for (const [how, attack] of [['moved away', 'mv "$CLAUDE_CODE_TMPDIR" "$PWD/moved" && ln -s "$VICTIM" "$CLAUDE_CODE_TMPDIR"'],
  ['removed', 'rm -rf "$CLAUDE_CODE_TMPDIR" && ln -s "$VICTIM" "$CLAUDE_CODE_TMPDIR"']]) {
  test(`a session that swaps its temporary directory (${how}) for a link stops its next launch; the link's target is never granted`, { skip }, async () => {
    const s = scratch();
    try {
      const sessionDir = path.join(s.sessions, 'worker');
      mkdirSync(sessionDir, { mode: 0o700 });
      const launch = () => sessionLaunch({ claude: '/bin/sh', args: [], cwd: s.wt, sessionDir, baseEnv: { PATH: '/usr/bin:/bin', HOME }, sandbox: s.sandbox });
      const first = await launch();
      const tmp = first.env.CLAUDE_CODE_TMPDIR;
      assert.equal(first.env.TMPDIR, `${tmp}/`);
      const r = underProfile({ ...first, env: { ...first.env, VICTIM: s.victim } },
        `echo x > "$VICTIM/direct" 2>/dev/null && echo direct-written || echo direct-denied; ${attack} && echo swapped`, s.wt);
      assert.match(r.stdout, /direct-denied/, 'the victim is outside the sandbox');
      assert.match(r.stdout, /swapped/, `the sandbox can replace its own temporary directory: ${r.stderr}`);
      assert.equal(lstatSync(tmp).isSymbolicLink(), true);
      // The resume: refused, and no profile ever names the victim.
      await assert.rejects(launch(), CHANGED);
      assert.equal(profilesMention(s.profiles, s.victim), false, 'no profile grants the link\'s target');
      assert.equal(existsSync(path.join(sessionDir, '.tmpdir')), false, 'the host keeps the session\'s temporary directory in memory, not in a file the session can write');
    } finally { s.cleanup(); }
  });
}

test('a gate step that swaps the gate\'s temporary directory or worktree for a link stops the next step, and removing the gate leaves the link\'s target alone', { skip }, async () => {
  const p = project();
  const victim = path.join(p.root, 'victim');
  mkdirSync(victim);
  const sandbox = gatesSandbox(p);
  const commit = sh(p.repo, ['rev-parse', 'HEAD']);
  const env = { PATH: '/usr/bin:/bin', HOME };
  const step = (gate, script) => gateLaunch({ sandbox, dir: gate.dir, tmp: gate.tmp, command: '/bin/sh', args: ['-c', script], env, timeoutMs: 30000 });
  const gates = [];
  try {
    // The temporary directory (under /private/tmp): removed, a link left.
    const a = await gateWorktree({ repo: p.repo, work: p.work, commit, label: 'gate' });
    gates.push(a);
    let r = await step(a, `echo x > '${victim}/direct' 2>/dev/null && echo direct-written || echo direct-denied; rm -rf '${a.tmp}' && ln -s '${victim}' '${a.tmp}' && echo swapped`);
    assert.match(r.stdout, /direct-denied/);
    assert.match(r.stdout, /swapped/, 'the gate\'s code can replace its temporary directory');
    await assert.rejects(step(a, `echo pwned > '${victim}/pwned'`), CHANGED);
    assert.equal(existsSync(path.join(victim, 'pwned')), false);
    // The worktree itself: moved into the temporary directory, and a link to
    // another worktree of the same repository left in its place.
    const b = await gateWorktree({ repo: p.repo, work: p.work, commit, label: 'gate' });
    const other = await gateWorktree({ repo: p.repo, work: p.work, commit, label: 'other' });
    gates.push(b, other);
    r = await step(b, `mv '${b.dir}' '${b.tmp}/moved' && ln -s '${other.dir}' '${b.dir}' && echo swapped`);
    assert.match(r.stdout, /swapped/, `the gate's code can replace its worktree: ${r.stderr}`);
    await assert.rejects(step(b, `echo pwned > '${other.dir}/pwned'`), CHANGED);
    assert.equal(existsSync(path.join(other.dir, 'pwned')), false);
    assert.equal(readdirSync(sandbox.profileDir).filter(n => n.endsWith('.sb')).some(n => {
      const text = readFileSync(path.join(sandbox.profileDir, n), 'utf8');
      return text.includes(`(subpath "${victim}")`) || text.includes(`(subpath "${other.dir}")`);
    }), false, 'no gate profile grants a link\'s target');
    // Removing the swapped gate removes the link, never the worktree it
    // points at.
    await b.remove();
    gates.splice(gates.indexOf(b), 1);
    assert.equal(existsSync(b.dir), false);
    assert.equal(existsSync(path.join(other.dir, 'package.json')), true, 'the other worktree is still there');
    assert.match(sh(p.repo, ['worktree', 'list']), new RegExp(path.basename(other.dir)));
  } finally {
    for (const g of gates) await g.remove().catch(() => {});
    p.cleanup();
  }
});

test('the host never writes through a link a session left in its session directory, and a swapped session directory stops the next launch', { skip }, async () => {
  const s = scratch();
  try {
    const sessionDir = path.join(s.sessions, 'worker');
    const settingsVictim = path.join(s.victim, 'settings-victim.txt');
    const dirVictim = path.join(s.victim, 'dir-target');
    writeFileSync(settingsVictim, 'the owner\'s file\n');
    mkdirSync(dirVictim);
    // A stand-in CLI: does what the step file (the host's, read only) says,
    // then answers.
    const stepFile = path.join(s.base, 'step');
    const cli = path.join(s.base, 'claude');
    writeFileSync(cli, `#!/bin/sh
S="$(dirname "$CLAUDE_CONFIG_DIR")"
case "$(cat '${stepFile}')" in
  plant) rm -rf "$S/settings.json" "$S/shims" && ln -s '${settingsVictim}' "$S/settings.json" && ln -s '${dirVictim}' "$S/shims" && echo planted >&2 ;;
  swap) mv "$S" "$PWD/moved-session" && ln -s '${dirVictim}' "$S" && echo swapped >&2 ;;
esac
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0,"session_id":"00000000-0000-4000-8000-0000000000a1","structured_output":{"ok":true}}'
`, { mode: 0o755 });
    const session = async step => {
      writeFileSync(stepFile, step);
      return runSession({ claude: cli, role: 'worker', cwd: s.wt, input: 'synthetic', schema: { type: 'object' }, settings: { permissions: { allow: [], deny: [] } },
        sessionDir, timeoutMs: 30000, baseEnv: { PATH: '/usr/bin:/bin', HOME }, sandbox: s.sandbox, stderrFile: null });
    };
    const planted = await session('plant');
    assert.equal(planted.ok, true, planted.reason);
    // What the session planted is there; the resume writes nothing through it.
    assert.equal(lstatSync(path.join(sessionDir, 'settings.json')).isSymbolicLink(), true, 'the session could plant its links');
    const resumed = await session('none');
    assert.equal(resumed.ok, true, resumed.reason);
    assert.equal(readFileSync(settingsVictim, 'utf8'), 'the owner\'s file\n', 'the settings went elsewhere, not through the link');
    assert.deepEqual(readdirSync(dirVictim), [], 'no shim was written through the link');
    // The session directory itself, moved away and a link left: refused.
    const swapped = await session('swap');
    assert.equal(swapped.ok, true, swapped.reason);
    await assert.rejects(session('none'), CHANGED);
    assert.deepEqual(readdirSync(dirVictim), [], 'nothing of the host\'s (.tmpdir, claude-config, settings) landed in the link\'s target');
    assert.equal(profilesMention(s.profiles, `(subpath "${dirVictim}")`), false);
  } finally { s.cleanup(); }
});
