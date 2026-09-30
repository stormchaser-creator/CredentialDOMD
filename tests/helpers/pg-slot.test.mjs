// The machine-wide PostgreSQL test slots (pg-slot.mjs, pg_slot.py): several
// processes, node and python, never hold more than N; a dead owner's slot is
// reclaimed, and the cluster it left running is stopped first; a slot comes
// back on exit and on SIGTERM; a record anyone can write gets no other
// process signalled; and the runner's sandbox profiles leave the directory
// writable. Every scenario but the last uses a private slot directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquirePgSlot, acquirePgSlotSync, defaultSlotDir, slotCount, holders, running, processStart, processCommand } from './pg-slot.mjs';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { sandboxAvailable, sandboxProfile, pgSlotDir, SANDBOX_EXEC } from '../../scripts/ticket-fix/sandbox.mjs';
import { gateLaunch } from '../../scripts/ticket-fix/gates/tests.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_HELPER = pathToFileURL(path.join(HERE, 'pg-slot.mjs')).href;
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
const pySkip = python ? false : 'python3 not found';
const SLOT_ENV = ['PG_TEST_SLOT_DIR', 'PG_TEST_SLOTS', 'PG_TEST_SLOT_TIMEOUT', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT'];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SLOT_ENV.includes(k)));
const slotFiles = dir => fs.readdirSync(dir).filter(n => /^slot-\d+$/.test(n)).sort();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function scratch(t, prefix = 'pg-slot-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A child process running code against the node or the python helper, with
// its own slot settings. Resolves with its exit and output; `lines` lets the
// test wait for a line it prints.
function child(kind, code, env = {}) {
  const proc = kind === 'node'
    ? spawn(process.execPath, ['--input-type=module', '-e', `import * as slots from ${JSON.stringify(NODE_HELPER)};\n${code}`], { env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(python, ['-B', '-c', `import sys, os, time, signal\nsys.dont_write_bytecode = True\nsys.path.insert(0, ${JSON.stringify(HERE)})\nimport pg_slot\n${code}`], { env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  const waiters = [];
  proc.stdout.on('data', chunk => { out += chunk; for (const w of [...waiters]) if (out.includes(w.text)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } });
  proc.stderr.on('data', chunk => { err += chunk; });
  const done = new Promise(resolve => proc.on('close', (status, signal) => resolve({ status, signal, out, err })));
  return {
    proc, done,
    saw: text => (out.includes(text) ? Promise.resolve() : new Promise((resolve, reject) => { waiters.push({ text, resolve }); done.then(r => reject(Error(`child ended before printing ${text}: ${JSON.stringify(r)}`))); })),
  };
}
async function deadPid() {
  const c = child('node', '');
  await c.done;
  return c.proc.pid;
}

test('the defaults: 12 slots in one directory per user under /tmp, the same for node, python and the runner sandbox', { skip: pySkip }, () => {
  assert.equal(slotCount({}), 12);
  assert.equal(slotCount({ PG_TEST_SLOTS: '5' }), 5);
  assert.throws(() => slotCount({ PG_TEST_SLOTS: 'many' }), /PG_TEST_SLOTS must be a whole number/);
  assert.throws(() => slotCount({ PG_TEST_SLOTS: '0' }), /PG_TEST_SLOTS must be a whole number/);
  const dir = defaultSlotDir();
  assert.equal(path.dirname(dir), fs.realpathSync('/tmp'));
  assert.match(path.basename(dir), /^credentialdomd-pg-slots-/);
  assert.equal(pgSlotDir(), dir, 'the sandbox profiles open the directory the helpers use');
  const py = spawnSync(python, ['-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(HERE)}); import pg_slot; print(pg_slot.default_slot_dir()); print(pg_slot.slot_count())`], { encoding: 'utf8', env: baseEnv });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(py.stdout.trim().split('\n'), [dir, '12']);
});

test('concurrent node and python processes never hold more than N slots, and all of them get one', { skip: pySkip, timeout: 120000 }, async t => {
  const dir = scratch(t);
  const slots = path.join(dir, 'slots');
  const log = path.join(dir, 'log');
  fs.writeFileSync(log, '');
  const env = { PG_TEST_SLOT_DIR: slots, PG_TEST_SLOTS: '3', PG_TEST_SLOT_TIMEOUT: '60' };
  // "+" is written after the slot is taken and "-" before it is given back,
  // so the running sum at every point of the log is at most the holders.
  const nodeCode = `const s = await slots.acquirePgSlot(null, { label: 'n' + process.pid });
    const fs = await import('node:fs');
    fs.appendFileSync(${JSON.stringify(log)}, '+ ' + process.pid + ' ' + fs.readdirSync(${JSON.stringify(slots)}).filter(n => n.startsWith('slot-')).length + '\\n');
    await new Promise(r => setTimeout(r, 800));
    fs.appendFileSync(${JSON.stringify(log)}, '- ' + process.pid + '\\n');
    s.release();`;
  const pyCode = `s = pg_slot.acquire(label='p%d' % os.getpid())
with open(${JSON.stringify(log)}, 'a') as f: f.write('+ %d %d\\n' % (os.getpid(), len([n for n in os.listdir(${JSON.stringify(slots)}) if n.startswith('slot-')])))
time.sleep(0.8)
with open(${JSON.stringify(log)}, 'a') as f: f.write('- %d\\n' % os.getpid())
s.release()`;
  const kids = [];
  for (let i = 0; i < 6; i++) kids.push(child('node', nodeCode, env), child('python', pyCode, env));
  const results = await Promise.all(kids.map(k => k.done));
  for (const r of results) assert.equal(r.status, 0, r.err);
  const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' '));
  assert.equal(events.filter(e => e[0] === '+').length, 12, 'every process got a slot');
  let now = 0, most = 0;
  for (const [sign, , files] of events) {
    now += sign === '+' ? 1 : -1;
    most = Math.max(most, now);
    if (sign === '+') assert.ok(Number(files) <= 3, `at most 3 slot files at any time, saw ${files}`);
  }
  assert.ok(most <= 3, `at most 3 holders at once, saw ${most}`);
  assert.equal(most, 3, 'the processes did overlap: the cap, not luck, kept them at 3');
  assert.deepEqual(slotFiles(slots), [], 'every slot came back');
  assert.deepEqual(fs.readdirSync(slots), [], 'no draft or aside file left');
});

test('a dead owner\'s slot is reclaimed, a reused pid is recognised, a live owner\'s slot never is', async t => {
  const dir = scratch(t);
  const slots = path.join(dir, 'slots');
  fs.mkdirSync(slots, { mode: 0o700 });
  const dead = await deadPid();
  assert.equal(running(dead), false);
  const plant = (name, record) => fs.writeFileSync(path.join(slots, name), JSON.stringify({ token: `t-${name}`, label: 'planted', dataDir: null, ...record }));
  plant('slot-0', { pid: dead, start: Date.now() - 5000 });
  // This very process's pid, but a start an hour off: the pid was reused.
  plant('slot-1', { pid: process.pid, start: Date.now() - 3600 * 1000 });
  const known = processStart(process.pid) !== null;
  const a = await acquirePgSlot(null, { dir: slots, slots: 2, timeoutMs: 5000, label: 'a' });
  assert.equal(a.name, 'slot-0');
  if (known) {
    const b = await acquirePgSlot(null, { dir: slots, slots: 2, timeoutMs: 5000, label: 'b' });
    assert.equal(b.name, 'slot-1');
    b.release();
  }
  a.release();
  // A live owner (this process, its real start) is waited for, then named.
  plant('slot-0', { pid: process.pid, start: Math.round(Date.now() - process.uptime() * 1000) });
  plant('slot-1', { pid: process.pid, start: null });
  const began = Date.now();
  await assert.rejects(acquirePgSlot(null, { dir: slots, slots: 2, timeoutMs: 400 }), error => {
    assert.match(error.message, /No PostgreSQL test slot came free in 0 s: all 2 slots in .* are held/);
    assert.match(error.message, new RegExp(`slot-0: pid ${process.pid} planted`));
    assert.match(error.message, /PG_TEST_SLOT_TIMEOUT/);
    return true;
  });
  assert.ok(Date.now() - began >= 350, 'it waited for the timeout');
  assert.deepEqual(slotFiles(slots), ['slot-0', 'slot-1'], 'a live owner keeps its slot');
  assert.throws(() => acquirePgSlotSync(null, { dir: slots, slots: 2, timeoutMs: 200 }), /No PostgreSQL test slot came free/);
  // Something that is not a record at all is reclaimed once it is old.
  fs.rmSync(path.join(slots, 'slot-1'));
  fs.writeFileSync(path.join(slots, 'slot-1'), 'not json');
  await assert.rejects(acquirePgSlot(null, { dir: slots, slots: 2, timeoutMs: 200 }), /came free/);
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(path.join(slots, 'slot-1'), old, old);
  const c = await acquirePgSlot(null, { dir: slots, slots: 2, timeoutMs: 2000 });
  assert.equal(c.name, 'slot-1');
  c.release();
});

test('python reclaims a dead node owner\'s slot and node a dead python owner\'s', { skip: pySkip, timeout: 60000 }, async t => {
  const dir = scratch(t);
  const slots = path.join(dir, 'slots');
  const env = { PG_TEST_SLOT_DIR: slots, PG_TEST_SLOTS: '1', PG_TEST_SLOT_TIMEOUT: '10' };
  const n = child('node', "await slots.acquirePgSlot(null, { label: 'node-killed' }); console.log('held'); process.kill(process.pid, 'SIGKILL');", env);
  const nr = await n.done;
  assert.equal(nr.signal, 'SIGKILL');
  assert.deepEqual(slotFiles(slots), ['slot-0'], 'SIGKILL leaves the slot file behind');
  const p = child('python', "s = pg_slot.acquire(label='py-after-node'); print('got', s.name); s.release()", env);
  const pr = await p.done;
  assert.equal(pr.status, 0, pr.err);
  assert.match(pr.out, /got slot-0/);
  const q = child('python', "pg_slot.acquire(label='py-killed'); print('held', flush=True); os.kill(os.getpid(), signal.SIGKILL)", env);
  const qr = await q.done;
  assert.equal(qr.signal, 'SIGKILL');
  assert.deepEqual(slotFiles(slots), ['slot-0']);
  const s = await acquirePgSlot(null, { dir: slots, slots: 1, timeoutMs: 10000 });
  s.release();
  assert.deepEqual(slotFiles(slots), []);
});

test('a slot comes back on exit, on an uncaught error and on SIGTERM, in node and in python', { skip: pySkip, timeout: 60000 }, async t => {
  const dir = scratch(t);
  const slots = path.join(dir, 'slots');
  const env = { PG_TEST_SLOT_DIR: slots, PG_TEST_SLOTS: '4' };
  // Each child holds its slot until the test's word on stdin, then ends
  // without releasing it: by exit, by an uncaught error, or by SIGTERM.
  const go = { node: "await new Promise(r => process.stdin.once('data', r));", python: 'sys.stdin.readline()' };
  const cases = [
    ['node', `slots.acquirePgSlotSync(null); console.log('held'); ${go.node} process.exit(3);`, r => r.status === 3],
    ['node', `await slots.acquirePgSlot(null); console.log('held'); ${go.node} throw new Error('synthetic failure');`, r => r.status === 1 && /synthetic failure/.test(r.err)],
    ['node', "await slots.acquirePgSlot(null); console.log('held'); setInterval(() => {}, 1000);", r => r.signal === 'SIGTERM', 'SIGTERM'],
    ['python', `pg_slot.acquire(); print('held', flush=True); ${go.python}; sys.exit(3)`, r => r.status === 3],
    ['python', `pg_slot.acquire(); print('held', flush=True); ${go.python}; raise RuntimeError('synthetic failure')`, r => r.status === 1 && /synthetic failure/.test(r.err)],
    ['python', "pg_slot.acquire(); print('held', flush=True); time.sleep(60)", r => r.signal === 'SIGTERM', 'SIGTERM'],
  ];
  for (const [kind, code, ended, signal] of cases) {
    const c = child(kind, code, env);
    await c.saw('held');
    assert.deepEqual(slotFiles(slots), ['slot-0'], `${kind} holds its slot: ${code}`);
    if (signal) c.proc.kill(signal); else c.proc.stdin.write('go\n');
    const r = await c.done;
    assert.ok(ended(r), `${kind} ended as expected: ${JSON.stringify(r)}`);
    assert.deepEqual(slotFiles(slots), [], `${kind} gave its slot back: ${code}`);
  }
});

test('node and python wait for each other on the same slot', { skip: pySkip, timeout: 60000 }, async t => {
  const dir = scratch(t);
  const slots = path.join(dir, 'slots');
  const env = { PG_TEST_SLOT_DIR: slots, PG_TEST_SLOTS: '1', PG_TEST_SLOT_TIMEOUT: '20' };
  // node holds; python gives up after its timeout, naming the node holder.
  const holder = child('node', "const s = await slots.acquirePgSlot(null, { label: 'node-holder' }); console.log('held'); process.stdin.once('data', () => { console.log('released ' + Date.now()); s.release(); process.exit(0); });", env);
  await holder.saw('held');
  const impatient = child('python', 'pg_slot.acquire(timeout=0.2)', env);
  const ir = await impatient.done;
  assert.notEqual(ir.status, 0);
  assert.match(ir.err, /TimeoutError: No PostgreSQL test slot came free in 0 s: all 1 slots .* held \(slot-0: pid \d+ node-holder/);
  const patient = child('python', "print('waiting', flush=True); s = pg_slot.acquire(label='py-waiter'); print('acquired %d' % int(time.time() * 1000)); s.release()", env);
  await patient.saw('waiting');
  await sleep(300);
  holder.proc.stdin.write('go\n');
  const [hr, pr] = await Promise.all([holder.done, patient.done]);
  assert.equal(hr.status, 0, hr.err);
  assert.equal(pr.status, 0, pr.err);
  assert.ok(Number(/acquired (\d+)/.exec(pr.out)[1]) >= Number(/released (\d+)/.exec(hr.out)[1]), 'python got the slot only after node gave it back');
  // python holds; node waits.
  const pyHolder = child('python', "s = pg_slot.acquire(label='py-holder'); print('held', flush=True); sys.stdin.readline(); print('released %d' % int(time.time() * 1000), flush=True); s.release()", env);
  await pyHolder.saw('held');
  await assert.rejects(acquirePgSlot(null, { dir: slots, slots: 1, timeoutMs: 200 }), /slot-0: pid \d+ py-holder/);
  const waiting = acquirePgSlot(null, { dir: slots, slots: 1, timeoutMs: 20000 });
  await sleep(300);
  pyHolder.proc.stdin.write('go\n');
  const s = await waiting;
  const got = Date.now();
  s.release();
  const pyr = await pyHolder.done;
  assert.equal(pyr.status, 0, pyr.err);
  assert.ok(got >= Number(/released (\d+)/.exec(pyr.out)[1]), 'node got the slot only after python gave it back');
});

test('a planted record gets no process signalled that is not its own PostgreSQL', { skip: pySkip, timeout: 60000 }, async t => {
  const dir = scratch(t);
  const slots = path.join(dir, 'slots');
  fs.mkdirSync(slots, { mode: 0o700 });
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  // A live process whose command line even carries "-D <data>", and a data
  // directory with a matching marker whose postmaster.pid names it.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', '-D', data], { stdio: 'ignore' });
  t.after(() => { try { bystander.kill('SIGKILL'); } catch { /* gone */ } });
  await sleep(200);
  fs.writeFileSync(path.join(data, 'postmaster.pid'), `${bystander.pid}\n${data}\n`);
  fs.writeFileSync(`${data}.pg-slot`, 'planted-token\n');
  const plant = async () => fs.writeFileSync(path.join(slots, 'slot-0'), JSON.stringify({ pid: await deadPid(), start: null, token: 'planted-token', label: 'planted', dataDir: data }));
  await plant();
  assert.match(processCommand(bystander.pid) ?? '', new RegExp(` -D ${data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), 'node reads its command line, here and inside the runner\'s sandbox');
  const s = await acquirePgSlot(null, { dir: slots, slots: 1, timeoutMs: 5000 });
  s.release();
  assert.equal(running(bystander.pid), true, 'node reclaimed the slot without signalling the bystander');
  await plant();
  const py = child('python', "s = pg_slot.acquire(timeout=5); s.release(); print('ok')", { PG_TEST_SLOT_DIR: slots, PG_TEST_SLOTS: '1' });
  const pr = await py.done;
  assert.equal(pr.status, 0, pr.err);
  assert.equal(running(bystander.pid), true, 'python reclaimed the slot without signalling the bystander');
});

// Starts a real cluster from a child that holds a slot in `slots`.
function clusterScript(kind, { data, sock, port, then }) {
  const bin = pgBin();
  if (kind === 'node') {
    return `const { execFileSync } = await import('node:child_process');
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
      const s = await slots.acquirePgSlot(${JSON.stringify(data)}, { label: 'cluster-node' });
      execFileSync(${JSON.stringify(path.join(bin, 'initdb'))}, ['-D', ${JSON.stringify(data)}, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'], { env, stdio: 'ignore' });
      execFileSync(${JSON.stringify(path.join(bin, 'pg_ctl'))}, ['-D', ${JSON.stringify(data)}, '-l', ${JSON.stringify(`${data}.log`)}, '-o', "-k ${sock} -p ${port} -c listen_addresses='' -c fsync=off", '-w', 'start'], { env, stdio: 'ignore' });
      console.log('started');
      ${then}`;
  }
  return `import subprocess
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}; env['LC_ALL'] = 'C'
s = pg_slot.acquire(${JSON.stringify(data)}, label='cluster-python')
subprocess.run([${JSON.stringify(path.join(bin, 'initdb'))}, '-D', ${JSON.stringify(data)}, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'], env=env, check=True, capture_output=True)
subprocess.run([${JSON.stringify(path.join(bin, 'pg_ctl'))}, '-D', ${JSON.stringify(data)}, '-l', ${JSON.stringify(`${data}.log`)}, '-o', "-k ${sock} -p ${port} -c listen_addresses='' -c fsync=off", '-w', 'start'], env=env, check=True, capture_output=True)
print('started', flush=True)
${then}`;
}
const postmaster = data => Number(fs.readFileSync(path.join(data, 'postmaster.pid'), 'utf8').split('\n')[0]);

test('a cluster its owner left running is stopped: by the reclaimer after SIGKILL, by the owner on exit and on SIGTERM', { skip: pgSkip() || pySkip, timeout: 240000 }, async t => {
  // The clusters started here are real: this test holds one slot of the
  // machine's own for them (one at a time) while it plays owners and
  // reclaimers in a private directory.
  const cover = await acquirePgSlot(null, { label: 'pg-slot.test clusters' });
  t.after(() => cover.release());
  const dir = scratch(t, 'pgs-');
  const slots = path.join(dir, 'slots');
  const sock = path.join(dir, 's'); fs.mkdirSync(sock);
  const env = { PG_TEST_SLOT_DIR: slots, PG_TEST_SLOTS: '1', PG_TEST_SLOT_TIMEOUT: '60' };
  let port = 56611;
  const run = async (kind, then, name) => {
    const data = path.join(dir, name);
    const c = child(kind, clusterScript(kind, { data, sock, port: port++, then }), env);
    await c.saw('started');
    return { c, data, pid: postmaster(data) };
  };
  // 1. node owner SIGKILLed: its postmaster runs on; python reclaims.
  let o = await run('node', "process.kill(process.pid, 'SIGKILL');", 'orphan-of-node');
  assert.equal((await o.c.done).signal, 'SIGKILL');
  assert.equal(running(o.pid), true, 'the orphaned postmaster still runs');
  let r = await child('python', "s = pg_slot.acquire(label='py-reclaimer'); print('got', s.name); s.release()", env).done;
  assert.equal(r.status, 0, r.err);
  assert.equal(running(o.pid), false, 'python stopped the orphan before reusing its slot');
  assert.equal(fs.existsSync(path.join(o.data, 'postmaster.pid')), false, 'it shut down, removing its postmaster.pid');
  // 2. python owner SIGKILLed: node reclaims (where it can read command lines).
  if (processCommand(process.pid) !== null) {
    o = await run('python', 'os.kill(os.getpid(), signal.SIGKILL)', 'orphan-of-python');
    assert.equal((await o.c.done).signal, 'SIGKILL');
    assert.equal(running(o.pid), true);
    const s = await acquirePgSlot(null, { dir: slots, slots: 1, timeoutMs: 60000 });
    s.release();
    assert.equal(running(o.pid), false, 'node stopped the orphan before reusing its slot');
  }
  // 3. node owner exits without stopping its cluster: the exit hook does.
  o = await run('node', 'process.exit(0);', 'left-by-node');
  assert.equal((await o.c.done).status, 0);
  assert.equal(running(o.pid), false, 'the exit hook stopped the cluster');
  assert.deepEqual(slotFiles(slots), []);
  assert.equal(fs.existsSync(`${o.data}.pg-slot`), false, 'and removed its marker');
  // 4. python owner gets SIGTERM: its handler stops the cluster, then dies of it.
  o = await run('python', 'time.sleep(120)', 'left-by-python');
  o.c.proc.kill('SIGTERM');
  assert.equal((await o.c.done).signal, 'SIGTERM');
  assert.equal(running(o.pid), false, 'the SIGTERM handler stopped the cluster');
  assert.deepEqual(slotFiles(slots), []);
});

// The runner runs the suite in its gates sandbox and sessions run it in
// theirs; the slot directory must be one they share with every other test
// process, and writable there, while the rest of /tmp stays closed.
const sandboxSkip = process.platform !== 'darwin' ? 'macOS sandbox only' : !sandboxAvailable() ? 'sandbox-exec cannot run inside another sandbox' : false;
test('inside the gates sandbox a test process takes and gives back a slot in the shared directory', { skip: sandboxSkip || pySkip, timeout: 60000 }, async t => {
  const dir = fs.realpathSync(scratch(t));
  const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp);
  const profileDir = path.join(dir, 'profiles'); fs.mkdirSync(profileDir);
  const env = { PATH: process.env.PATH, HOME: os.homedir(), LC_ALL: 'C' };
  const script = `import * as slots from ${JSON.stringify(NODE_HELPER)};
    const s = await slots.acquirePgSlot(null, { label: 'gates-sandbox-probe' });
    console.log('slot ' + slots.slotDir() + ' ' + s.name); s.release();
    const fs = await import('node:fs');
    try { fs.writeFileSync(${JSON.stringify(`${fs.realpathSync('/tmp')}/pg-slot-escape-${process.pid}`)}, 'x'); console.log('escaped'); } catch (e) { console.log('closed ' + e.code); }`;
  let err = '';
  const onStderr = text => { err += text; };
  const r = await gateLaunch({ sandbox: { home: os.homedir(), profileDir }, dir, tmp, command: process.execPath, args: ['--input-type=module', '-e', script], env, timeoutMs: 30000, onStderr });
  assert.equal(r.code, 0, err);
  assert.match(r.stdout, new RegExp(`slot ${pgSlotDir()} slot-\\d+`));
  assert.match(r.stdout, /closed EPERM/, 'the rest of /tmp stays closed');
  const py = await gateLaunch({ sandbox: { home: os.homedir(), profileDir }, dir, tmp, command: python, env, timeoutMs: 30000, onStderr,
    args: ['-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(HERE)}); import pg_slot; s = pg_slot.acquire(label='gates-sandbox-probe-py'); print('slot', pg_slot.slot_dir(), s.name); s.release()`] });
  assert.equal(py.code, 0, err);
  assert.match(py.stdout, new RegExp(`slot ${pgSlotDir()} slot-\\d+`));
  // Without the shared directory (the profile before it) the same process
  // cannot take a slot, and says what to do.
  const closed = path.join(profileDir, 'closed.sb');
  fs.writeFileSync(closed, sandboxProfile({ kind: 'gates', home: os.homedir(), writable: [dir, tmp] }));
  const probe = spawnSync(SANDBOX_EXEC, ['-f', closed, process.execPath, '--input-type=module', '-e', `import * as slots from ${JSON.stringify(NODE_HELPER)};
    try { (await slots.acquirePgSlot(null, { dir: ${JSON.stringify(`${pgSlotDir()}-closed-probe`)} })).release(); console.log('open'); } catch (e) { console.log(e.message); }`], { encoding: 'utf8', env: { ...env, TMPDIR: `${tmp}/` } });
  assert.match(probe.stdout, /Cannot create the PostgreSQL test slot directory .* set PG_TEST_SLOT_DIR/, probe.stderr);
  // The session profile shares it too.
  const session = sandboxProfile({ kind: 'session', home: os.homedir(), writable: [dir], shared: [pgSlotDir()] });
  assert.ok(session.includes(`(subpath "${pgSlotDir()}")`));
  assert.ok(!session.includes(`(remote unix-socket (subpath "${pgSlotDir()}"))`), 'no socket there is a sandboxed process\'s own');
  assert.equal(holders(pgSlotDir()).some(h => /gates-sandbox-probe/.test(h.label ?? '')), false, 'the probes gave their slots back');
});
