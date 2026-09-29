// G0 and G3a: every model session is contained (dontAsk, no settings or MCP
// from the machine, exact commands, fresh config, no tokens, git cannot push)
// and works only in a worktree on its own branch; the host commits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { sessionArgs, sessionSettings, reviewSettings, sessionEnv, gatesEnv, launch, sessionLaunch, WORKER_COMMANDS, REVIEW_MODEL, WORKER_MODEL } from '../../scripts/ticket-fix/worker.mjs';
import { createWorktree, removeWorktree, changedPaths, classifyChanges, commitWork, addGatesTrailer, trailers, hooksDigest, sanitizeSubject, branchName, isEditable, git, HOST_GIT_CONFIG,
  AGENT_NAME, AGENT_EMAIL } from '../../scripts/ticket-fix/worktree.mjs';
import { sandboxAvailable, sandboxProfile } from '../../scripts/ticket-fix/sandbox.mjs';
import { project, sh, COMMITTER, RUN_ID, TICKET } from './stage2-helpers.mjs';

const HOME = '/Users/synthetic';
test('every session runs in dontAsk with no machine settings, no MCP, a fresh config and a budget; none skips permissions', () => {
  const schema = { type: 'object' };
  for (const role of ['worker', 'repro', 'review']) {
    const args = sessionArgs({ role, settingsFile: '/tmp/s.json', schema });
    assert.ok(!args.some(a => /dangerously|bypass/i.test(a)), role);
    const flag = name => args[args.indexOf(name) + 1];
    assert.equal(flag('--permission-mode'), 'dontAsk');
    assert.equal(flag('--setting-sources'), '');
    assert.equal(flag('--settings'), '/tmp/s.json');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(flag('--mcp-config'), '{"mcpServers":{}}');
    assert.equal(flag('--effort'), 'high');
    assert.ok(Number(flag('--max-budget-usd')) > 0);
    // Stage 3: the host reads each session's tool events from its stdout.
    assert.equal(flag('--output-format'), 'stream-json');
    assert.ok(args.includes('--verbose'));
    assert.deepEqual(JSON.parse(flag('--json-schema')), schema);
  }
  // The checklist extractor has no tools and gets its images on stream-json
  // stdin; the confirmer is read-only like the reviewer.
  const extract = sessionArgs({ role: 'extract', settingsFile: 's', schema });
  assert.equal(extract[extract.indexOf('--tools') + 1], '');
  assert.equal(extract[extract.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(extract[extract.indexOf('--model') + 1], 'claude-opus-5-5');
  const confirm = sessionArgs({ role: 'confirm', settingsFile: 's', schema });
  assert.equal(confirm[confirm.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(confirm[confirm.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.ok(!sessionArgs({ role: 'worker', settingsFile: 's', schema }).includes('--input-format'));
  assert.equal(sessionArgs({ role: 'worker', settingsFile: 's', schema }).at(sessionArgs({ role: 'worker', settingsFile: 's', schema }).indexOf('--model') + 1), WORKER_MODEL);
  const review = sessionArgs({ role: 'review', settingsFile: 's', schema });
  assert.equal(review[review.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(REVIEW_MODEL, 'claude-opus-5-5');
  assert.equal(review[review.indexOf('--tools') + 1], 'Read,Grep,Glob', 'the reviewer is read-only: no Bash, Edit or Write');
  const resumed = sessionArgs({ role: 'worker', settingsFile: 's', schema, resume: '00000000-0000-4000-8000-0000000000ab' });
  assert.deepEqual(resumed.slice(0, 3), ['-p', '--resume', '00000000-0000-4000-8000-0000000000ab']);
  assert.throws(() => sessionArgs({ role: 'worker', settingsFile: 's', schema, resume: '--x; rm' }), /Invalid session id/);
});

test('the worker may edit only src, tests, public and landing, run exact commands, and read no runner state or secrets (critique B2)', () => {
  const s = sessionSettings({ role: 'worker', worktree: '/w/wt', home: HOME, work: '/w', state: ['/state/case', '/state/fix'], runDir: '/tmp/run', tmp: '/tmp',
    frozen: ['tests/repro.test.mjs'] });
  const { allow, deny, defaultMode } = s.permissions;
  assert.equal(defaultMode, 'dontAsk');
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  for (const dir of ['src', 'tests', 'public', 'landing']) { assert.ok(allow.includes(`Edit(//w/wt/${dir}/**)`), dir); assert.ok(allow.includes(`Write(//w/wt/${dir}/**)`), dir); }
  assert.ok(!allow.some(r => /^(?:Edit|Write)\(\/\/w\/wt\/(?:scripts|supabase|\.github)/.test(r)));
  const bash = allow.filter(r => r.startsWith('Bash('));
  assert.deepEqual(bash, [...WORKER_COMMANDS]);
  // The live check (containment-live.test.mjs) found the ":*" prefix form
  // does not match a path argument; the "*" wildcard does.
  assert.deepEqual(bash, ['Bash(npm test)', 'Bash(npm run build:site)', 'Bash(node --test tests/*)', 'Bash(node --experimental-vm-modules --test tests/*)']);
  for (const r of bash.filter(x => x.includes('*'))) assert.match(r, / tests\/\*\)$/, 'the only wildcard is a path under tests/');
  assert.ok(!allow.some(r => /Bash\((?:git|rg)/.test(r)), 'no git or rg: Read, Grep and Glob instead');
  for (const cmd of ['git', 'rg', 'security', 'curl', 'gh', 'npx', 'sh', 'bash', 'node -e']) assert.ok(deny.includes(`Bash(${cmd}:*)`), cmd);
  for (const p of ['//w/wt/tests/ticket-fix/**', '//w/wt/scripts/**', '//w/wt/supabase/**', '//w/wt/.github/**', '//w/wt/package.json', '//w/wt/tests/repro.test.mjs']) {
    assert.ok(deny.includes(`Edit(${p})`) && deny.includes(`Write(${p})`), p);
  }
  for (const p of ['//state/case/**', '//state/fix/**', '//w/runs/**', '//tmp/run/**', '//Users/synthetic/.ssh/**', '//Users/synthetic/Library/Keychains/**', '//Users/synthetic/Projects/**', '//tmp/credentialdomd-ticket-*/**']) {
    assert.ok(deny.includes(`Read(${p})`), p);
  }
  assert.ok(!deny.some(r => r === 'Read(//w/**)' || r.startsWith('Read(//w/wt')), 'a deny rule beats an allow rule: the worktree itself is never denied');
  for (const tool of ['WebFetch', 'WebSearch', 'Task']) assert.ok(deny.includes(tool), tool);
  const repro = sessionSettings({ role: 'repro', worktree: '/w/wt', home: HOME, work: '/w' }).permissions.allow;
  assert.ok(repro.includes('Edit(//w/wt/tests/**)') && !repro.some(r => r.startsWith('Edit(//w/wt/src')), 'the reproduction writes tests only');
  assert.ok(!repro.includes('Bash(npm test)'));
  // Finding 6: no bare Grep or Glob allow rule; the Read rule binds them to
  // the worktree (checked live in containment-live.test.mjs).
  assert.deepEqual(allow.filter(r => !/^(?:Edit|Write|Bash)\(/.test(r)), ['Read(//w/wt/**)']);
  const review = reviewSettings({ worktree: '/w/wt', home: HOME, work: '/w', state: ['/state/case'] }).permissions;
  assert.deepEqual(review.allow, ['Read(//w/wt/**)']);
  assert.ok(review.deny.includes('Read(//state/case/**)'));
  for (const tool of ['Edit', 'Write', 'Bash']) assert.ok(review.deny.includes(tool), tool);
});

test('session and gate environments come from an allowlist: no database or GitHub token, git cannot push, hooks are off', () => {
  const base = { PATH: '/bin', HOME, TMPDIR: '/tmp', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-model', TICKET_DATABASE_TOKEN: 'synthetic-db', GH_TOKEN: 'synthetic-gh',
    GITHUB_TOKEN: 'synthetic-gh2', SUPABASE_ACCESS_TOKEN: 'synthetic-sb', TOKEN: 'synthetic', CLAUDE_CONFIG_DIR: '/Users/synthetic/.claude', NODE_OPTIONS: '--require /tmp/x.js' };
  const env = sessionEnv({ base, configDir: '/tmp/run/sessions/worker/claude-config' });
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/run/sessions/worker/claude-config', 'a fresh config dir, not the owner\'s');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'synthetic-model');
  for (const key of ['TICKET_DATABASE_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'SUPABASE_ACCESS_TOKEN', 'TOKEN', 'NODE_OPTIONS']) assert.equal(env[key], undefined, key);
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.deepEqual([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0], ['remote.origin.pushurl', '/nonexistent/push-blocked']);
  assert.deepEqual([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1], ['credential.helper', '']);
  assert.deepEqual([env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2], ['core.hooksPath', '/dev/null']);
  assert.throws(() => sessionEnv({ base, configDir: 'relative' }), /fresh absolute/);
  assert.equal(env.VITE_SUPABASE_URL, 'https://ticketgate.supabase.co', 'a synthetic origin so build:site builds; never a production value');
  const gates = gatesEnv(base);
  assert.equal(gates.VITE_CLERK_PUBLISHABLE_KEY, 'pk_test_dummy');
  assert.equal(gates.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the gates run the fixer\'s code: no model credential either');
  assert.equal(gates.TICKET_DATABASE_TOKEN, undefined);
});

test('a push from inside a session goes nowhere: the pushurl is blocked', () => {
  const p = project();
  try {
    sh(p.repo, ['commit', '-q', '--allow-empty', '-m', 'Synthetic local commit']);
    const env = sessionEnv({ base: process.env, configDir: path.join(p.root, 'cfg') });
    const r = spawnSync('git', ['-C', p.repo, 'push', 'origin', 'HEAD:main'], { encoding: 'utf8', env });
    assert.notEqual(r.status, 0);
    assert.notEqual(p.originHead(), sh(p.repo, ['rev-parse', 'HEAD']), 'origin main is unchanged');
  } finally { p.cleanup(); }
});

test('launch kills the whole process group on timeout, not just the first process', async () => {
  const p = project();
  try {
    const marker = path.join(p.root, 'child-alive');
    // The parent starts a background child that would write a file after 1.5 s.
    const script = `(sleep 1.5; echo alive > '${marker}') & sleep 30`;
    const started = Date.now();
    const r = await launch({ command: '/bin/sh', args: ['-c', script], cwd: p.root, env: { PATH: '/bin:/usr/bin' }, timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 5000);
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal(existsSync(marker), false, 'the background child was killed with its group');
  } finally { p.cleanup(); }
});

test('the worktree: a new branch from origin/main under the work directory; the owner checkout is untouched', async () => {
  const p = project();
  try {
    // The owner has work in progress in the checkout.
    writeFileSync(path.join(p.repo, 'src/format.js'), `${readFileSync(path.join(p.repo, 'src/format.js'), 'utf8')}// owner edit in progress\n`);
    mkdirSync(path.join(p.repo, 'node_modules'));
    // The owner's lockfile differs from the one at base (base has none).
    writeFileSync(path.join(p.repo, 'package-lock.json'), '{}\n');
    const ownerHead = sh(p.repo, ['rev-parse', 'HEAD']), ownerStatus = sh(p.repo, ['status', '--porcelain']), ownerBranch = sh(p.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const moved = p.moveMain({ 'src/other.js': 'export const other = 1;\n' });
    const installs = [];
    const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID, installNodeModules: async dir => { installs.push(dir); } });
    assert.equal(installs.length, 1);
    assert.ok(installs[0].startsWith(path.join(p.work, 'modules')), 'installed once into the host-owned module cache, then copied');
    assert.equal(wt.base, moved, 'the base is origin/main as fetched, not the owner\'s HEAD');
    assert.equal(wt.branch, `agent/${TICKET.slice(0, 8)}-${RUN_ID}`);
    assert.equal(wt.dir, path.join(p.work, 'worktrees', `${TICKET.slice(0, 8)}-${RUN_ID}`));
    assert.equal(sh(wt.dir, ['rev-parse', '--abbrev-ref', 'HEAD']), wt.branch);
    assert.equal(wt.node_modules, 'installed', 'the lockfile differs from base, so modules are installed, not linked');
    assert.ok(lstatSync(path.join(wt.dir, 'node_modules')).isDirectory() && !lstatSync(path.join(wt.dir, 'node_modules')).isSymbolicLink());
    const again = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: 'fedcba9876543210', installNodeModules: async dir => { installs.push(dir); } });
    assert.equal(installs.length, 1, 'the cache is reused for the same lockfile');
    removeWorktree({ repo: p.repo, dir: again.dir, branch: again.branch, deleteBranch: true });
    assert.match(wt.hooks_sha256, /^[0-9a-f]{64}$/);
    // The owner's checkout: same branch, same HEAD, same work in progress.
    assert.equal(sh(p.repo, ['rev-parse', 'HEAD']), ownerHead);
    assert.equal(sh(p.repo, ['rev-parse', '--abbrev-ref', 'HEAD']), ownerBranch);
    assert.equal(sh(p.repo, ['status', '--porcelain']), ownerStatus);
    removeWorktree({ repo: p.repo, dir: wt.dir, branch: wt.branch, deleteBranch: true });
    assert.equal(existsSync(wt.dir), false);
    assert.equal(sh(p.repo, ['branch', '--list', wt.branch]), '');
    assert.throws(() => branchName(TICKET, 'short'), /16-hex run id/);
  } finally { p.cleanup(); }
});

test('node_modules is a copy of the owner checkout\'s when the lockfiles match, never a link into it (finding 1)', async () => {
  const p = project();
  try {
    mkdirSync(path.join(p.repo, 'node_modules', 'synthetic-pkg'), { recursive: true });
    writeFileSync(path.join(p.repo, 'node_modules', 'synthetic-pkg', 'index.js'), 'export default 1;\n');
    const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
    assert.equal(wt.node_modules, 'cloned');
    const modules = path.join(wt.dir, 'node_modules');
    assert.ok(!lstatSync(modules).isSymbolicLink(), 'not a link');
    writeFileSync(path.join(modules, 'synthetic-pkg', 'index.js'), 'export default 2;\n');
    assert.equal(readFileSync(path.join(p.repo, 'node_modules', 'synthetic-pkg', 'index.js'), 'utf8'), 'export default 1;\n', 'a write in the worktree never reaches the owner\'s modules');
    assert.deepEqual(changedPaths(wt.dir, wt.base), [], 'the copy is the host\'s own, not a change');
    assert.equal(wt.gitdir, realpathSync(path.join(p.repo, '.git', 'worktrees', path.basename(wt.dir))));
  } finally { p.cleanup(); }
});

test('the host commit: one commit on base, editable paths only, agent author, run committer, trailers, hooks never run', async () => {
  const p = project();
  try {
    const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
    // A hook that would fail every commit and push, planted where worktrees share it.
    const hooks = path.join(p.repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) { writeFileSync(path.join(hooks, hook), '#!/bin/sh\nexit 1\n'); chmodSync(path.join(hooks, hook), 0o755); }
    p.write(wt.dir, { 'src/format.js': 'export const title = "changed";\n', 'tests/new.test.mjs': '// synthetic\n', 'scripts/evil.sh': 'echo\n', 'tests/ticket-fix/x.mjs': '//\n' });
    const scope = classifyChanges(changedPaths(wt.dir, wt.base));
    assert.deepEqual(scope.outside, ['scripts/evil.sh', 'tests/ticket-fix/x.mjs'], 'the runner\'s own tests are not the worker\'s');
    assert.deepEqual(scope.product, ['src/format.js']);
    assert.ok(classifyChanges(['scripts/ticket-fix/claims.mjs', 'scripts/ticket-agent.sh', 'supabase/functions/send-ticket-reply/index.ts']).runner_code.length === 3);
    const head = commitWork({ dir: wt.dir, base: wt.base, subject: 'Fix for a@example.com 555 123 4567 in c237149abc', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
    const files = sh(wt.dir, ['diff', '--name-only', wt.base, head]).split('\n');
    assert.deepEqual(files, ['src/format.js', 'tests/new.test.mjs'], 'scripts/ and tests/ticket-fix/ are never committed');
    assert.equal(sh(wt.dir, ['rev-list', '--count', `${wt.base}..${head}`]), '1');
    assert.equal(sh(wt.dir, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', head]), `${AGENT_NAME} <${AGENT_EMAIL}>|CredentialDOMD Ticket Agent <${COMMITTER}>`);
    const subject = sh(wt.dir, ['log', '-1', '--format=%s', head]);
    assert.ok(!/@|555|c237149/.test(subject), subject);
    assert.deepEqual(trailers(wt.dir, head), { Ticket: TICKET.slice(0, 8), 'Ticket-Agent-Run': RUN_ID });
    // A second commit replaces the first: still one commit on base.
    p.write(wt.dir, { 'src/format.js': 'export const title = "changed again";\n' });
    const again = commitWork({ dir: wt.dir, base: wt.base, subject: 'Second', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
    assert.equal(sh(wt.dir, ['rev-list', '--count', `${wt.base}..${again}`]), '1');
    const gated = addGatesTrailer({ dir: wt.dir, subject: 'Second', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER, gatesSha256: 'a'.repeat(64) });
    assert.deepEqual(trailers(wt.dir, gated), { Ticket: TICKET.slice(0, 8), 'Ticket-Agent-Run': RUN_ID, Gates: 'a'.repeat(64) });
    assert.equal(sh(wt.dir, ['rev-parse', `${gated}^{tree}`]), sh(wt.dir, ['rev-parse', `${again}^{tree}`]), 'the trailer never changes the tree');
    assert.throws(() => commitWork({ dir: wt.dir, base: wt.base, subject: 'x', ticketId: TICKET, runId: RUN_ID, committer: 'someone@example.com' }), /run committer/);
    // The hooks digest changes when a hook is planted.
    const before = hooksDigest(p.repo);
    writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\n');
    assert.notEqual(hooksDigest(p.repo), before);
    assert.ok(lstatSync(path.join(hooks, 'pre-commit')).isFile());
  } finally { p.cleanup(); }
});

test('commit subjects are public: no addresses, numbers or ids survive', () => {
  assert.equal(sanitizeSubject('Show the renewal date on the collapsed line', TICKET), 'Show the renewal date on the collapsed line');
  assert.equal(sanitizeSubject('x', TICKET), `Ticket ${TICKET.slice(0, 8)}: agent change`);
  const s = sanitizeSubject('Fix for jane.doe@example.com at (555) 012-3456, NPI 1234567893, see deadbeef1234 — now', TICKET);
  assert.ok(!/@|555|1234567893|deadbeef|—/.test(s), s);
  assert.ok(s.length <= 72);
});

test('G0 refuses git metadata, links, nested repositories and NUL bytes in source; the host never stages them (finding 3)', async () => {
  const p = project();
  try {
    const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
    p.write(wt.dir, { 'src/.gitattributes': 'format.js -diff\n', 'tests/.gitignore': 'helper.mjs\n', 'src/.gitmodules': '[submodule "x"]\n', 'src/format.js': 'export const title = "x";\n',
      'src/nul.js': 'export const a = 1; // \u0000\n', 'public/ok.png': '\u0000binary is fine for media\n' });
    symlinkSync('/etc/hosts', path.join(wt.dir, 'src', 'hosts.js'));
    mkdirSync(path.join(wt.dir, 'src', 'nested'));
    sh(path.join(wt.dir, 'src', 'nested'), ['init', '-q']);
    const scope = classifyChanges(changedPaths(wt.dir, wt.base), { dir: wt.dir });
    assert.deepEqual(scope.outside, ['src/.gitattributes', 'src/.gitmodules', 'src/hosts.js', 'src/nested/', 'src/nul.js', 'tests/.gitignore']);
    assert.ok(!isEditable('src/.gitattributes') && !isEditable('tests/sub/.gitignore') && isEditable('src/format.js'));
    const head = commitWork({ dir: wt.dir, base: wt.base, subject: 'Synthetic', ticketId: TICKET, runId: RUN_ID, committer: COMMITTER });
    const files = sh(wt.dir, ['diff', '--name-only', wt.base, head]).split('\n');
    assert.ok(!files.some(f => /\.git(?:attributes|ignore|modules)$/.test(f)), files.join());
  } finally { p.cleanup(); }
});

test('host git ignores a planted fsmonitor, and the pre-push digest covers the shared git config, attributes and the global config (finding 8)', async () => {
  const p = project();
  try {
    const marker = path.join(p.root, 'fsmonitor-ran');
    const hook = path.join(p.root, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const before = hooksDigest(p.repo, { home: p.root });
    sh(p.repo, ['config', 'core.fsmonitor', hook]);
    git(p.repo, ['status', '--porcelain']);
    assert.equal(existsSync(marker), false, 'the host\'s git never runs a configured fsmonitor');
    assert.notEqual(hooksDigest(p.repo, { home: p.root }), before, 'a config change is a digest change');
    const config = hooksDigest(p.repo, { home: p.root });
    mkdirSync(path.join(p.repo, '.git', 'info'), { recursive: true });
    writeFileSync(path.join(p.repo, '.git', 'info', 'attributes'), '*.js -diff\n');
    assert.notEqual(hooksDigest(p.repo, { home: p.root }), config, 'info/attributes');
    const attributes = hooksDigest(p.repo, { home: p.root });
    writeFileSync(path.join(p.root, '.gitconfig'), '[credential]\n\thelper = !/bin/echo\n');
    assert.notEqual(hooksDigest(p.repo, { home: p.root }), attributes, 'the owner\'s global config');
    // Adding or removing a worktree does not change it.
    const settled = hooksDigest(p.repo, { home: p.root });
    const wt = await createWorktree({ repo: p.repo, work: p.work, ticketId: TICKET, runId: RUN_ID });
    assert.equal(hooksDigest(p.repo, { home: p.root }), settled);
    removeWorktree({ repo: p.repo, dir: wt.dir, branch: wt.branch, deleteBranch: true });
    // The host's git passes no credential helper except when asked to push.
    assert.ok(HOST_GIT_CONFIG.includes('core.fsmonitor=false') && HOST_GIT_CONFIG.includes('protocol.ext.allow=never'));
  } finally { p.cleanup(); }
});

test('sessions launch under the sandbox with the credential on a pipe, never in the environment (finding 1)', { skip: sandboxAvailable() ? false : 'needs sandbox-exec' }, async () => {
  const p = project();
  try {
    const sessionDir = path.join(p.root, 'run', 'sessions', 'worker');
    mkdirSync(sessionDir, { recursive: true });
    const profileDir = path.join(p.root, 'profiles');
    mkdirSync(profileDir);
    const how = await sessionLaunch({ claude: '/bin/echo', args: ['-p'], cwd: p.repo, sessionDir, baseEnv: { PATH: '/bin', HOME, CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth-value' },
      sandbox: { home: HOME, denyRead: [p.state, path.join(p.root, 'run')], denyFiles: [path.join(p.work, 'AUTO_MERGE')], profileDir } });
    assert.equal(how.command, '/usr/bin/sandbox-exec');
    assert.equal(how.args[0], '-f');
    assert.equal(how.args[2], '/bin/echo');
    assert.equal(how.secret, 'synthetic-oauth-value');
    assert.equal(how.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(how.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3');
    const profile = readFileSync(how.args[1], 'utf8');
    for (const text of ['(deny process-exec (literal "/usr/bin/security")', 'Library/Keychains', `(subpath "${realpathSync(p.state)}")`, '.gitconfig', 'AUTO_MERGE"', 'git-credential-',
      `(deny file-write* (require-not (require-any (subpath "${realpathSync(p.repo)}") (subpath "${realpathSync(sessionDir)}")`]) assert.ok(profile.includes(text), text);
    // The profile really holds: a process under it cannot write the state or read it.
    const r = spawnSync('/usr/bin/sandbox-exec', ['-f', how.args[1], '/bin/sh', '-c', `echo x > '${path.join(p.state, 'marker')}' ; cat '${path.join(p.state, 'marker')}'`], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(path.join(p.state, 'marker')), false);
    assert.throws(() => sandboxProfile({ kind: 'gates', home: HOME, writable: ['/tmp/a"b'] }), /absolute and plain/);
    const gates = sandboxProfile({ kind: 'gates', home: HOME, writable: [p.repo] });
    assert.ok(gates.includes('(deny network*)') && !gates.includes('(allow network* (remote unix-socket))') && !gates.includes('(allow network* (local ip'), 'gates: loopback only');
    // Under the gates profile no name resolves (no DNS resolver socket) and
    // the owner's local database port is closed; its own loopback server works.
    const gatesFile = path.join(profileDir, 'gates.sb');
    writeFileSync(gatesFile, gates);
    const probe = spawnSync('/usr/bin/sandbox-exec', ['-f', gatesFile, process.execPath, '-e', `
      const dns = require('node:dns'), net = require('node:net'), http = require('node:http');
      const out = {};
      dns.lookup('example.com', e => { out.dns = e ? e.code : 'resolved';
        const c = net.connect(5432, '127.0.0.1'); c.on('error', e2 => { out.pg = e2.code; c.destroy();
          const s = http.createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', () => http.get('http://127.0.0.1:' + s.address().port, r => { out.own = r.statusCode; s.close(); console.log(JSON.stringify(out)); })); });
        c.on('connect', () => { out.pg = 'connected'; c.destroy(); console.log(JSON.stringify(out)); }); });`], { encoding: 'utf8', cwd: p.repo, timeout: 20000 });
    const seen = JSON.parse(probe.stdout.trim() || '{}');
    assert.ok(seen.dns !== 'resolved' && seen.pg !== 'connected' && seen.own === 200, JSON.stringify(seen) + probe.stderr);
  } finally { p.cleanup(); }
});
