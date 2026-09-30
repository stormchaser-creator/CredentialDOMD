// The machine-wide PostgreSQL test slots (pg-slot.mjs, pg_slot.py): several
// processes, node and python, never hold more than N; a dead owner's slot is
// reclaimed, and the cluster it left running is stopped first; a record that
// does not prove a live test process holds nothing; two reclaimers never
// remove a live record; a slot comes back on exit and on SIGTERM; a record
// anyone can write gets no other process signalled; the slot wait comes on
// top of a test's own timeout; and the runner's sandboxes get a slot
// directory of their own that they cannot swap, never the owner's. Every
// scenario uses a private slot directory, except the cluster test's cover.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquirePgSlot, acquirePgSlotSync, defaultSlotDir, slotCount, holders, running, processStart, processCommand, processInfo, ownerGone, MAX_OWNER_AGE_MS,
  inspectSlot, reclaimSlot, withSlotWait } from './pg-slot.mjs';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { sandboxAvailable, sandboxProfile, runSlotDir, slotEnv, RUN_PG_SLOTS, SANDBOX_EXEC } from '../../scripts/ticket-fix/sandbox.mjs';
import { gateLaunch } from '../../scripts/ticket-fix/gates/tests.mjs';
import { sessionLaunch, removeSessionTemps } from '../../scripts/ticket-fix/worker.mjs';

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

test('the defaults: 12 slots in one directory per user under /tmp, the same for node and python; each runner run gets its own', { skip: pySkip }, t => {
  assert.equal(slotCount({}), 12);
  assert.equal(slotCount({ PG_TEST_SLOTS: '5' }), 5);
  assert.throws(() => slotCount({ PG_TEST_SLOTS: 'many' }), /PG_TEST_SLOTS must be a whole number/);
  assert.throws(() => slotCount({ PG_TEST_SLOTS: '0' }), /PG_TEST_SLOTS must be a whole number/);
  const dir = defaultSlotDir();
  assert.equal(path.dirname(dir), fs.realpathSync('/tmp'));
  assert.match(path.basename(dir), /^credentialdomd-pg-slots-/);
  // A runner run's sandboxed sessions and gates share a fresh directory of
  // their own, never this one (sandbox.mjs runSlotDir).
  const run = runSlotDir();
  t.after(() => fs.rmSync(run, { recursive: true, force: true }));
  assert.equal(path.dirname(run), path.dirname(dir));
  assert.ok(path.basename(run).startsWith(`${path.basename(dir)}-run-`) && run !== dir, run);
  assert.equal(fs.statSync(run).mode & 0o777, 0o700);
  assert.deepEqual(slotEnv(run), { PG_TEST_SLOT_DIR: run, PG_TEST_SLOTS: String(RUN_PG_SLOTS) });
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
  // Every slot starts stale (a dead owner), so the first processes all
  // reclaim the same slots at once.
  fs.mkdirSync(slots, { mode: 0o700 });
  const dead = await deadPid();
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(slots, `slot-${i}`), JSON.stringify({ pid: dead, start: Date.now() - 5000, token: `stale-${i}`, label: 'stale', dataDir: null }));
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
  plant('slot-1', { pid: process.pid, start: Math.round(Date.now() - process.uptime() * 1000) });
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

test('a cluster its owner left running is stopped: by the reclaimer after SIGKILL, by the owner on exit and on SIGTERM', { skip: pgSkip() || pySkip, timeout: withSlotWait(240000) }, async t => {
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


// Review of 2026-09-29: a record is not trusted to name a live test process.
// Before, a record naming pid 1 with no start (kill answers EPERM, and no
// start skipped the reuse check), or junk dated in the future, held its slot
// for good, and every later run waited PG_TEST_SLOT_TIMEOUT and failed.
test('a record that does not prove a live test process holds no slot, in node and in python', { skip: pySkip, timeout: 60000 }, async t => {
  const dir = scratch(t);
  const slots = path.join(dir, 'slots');
  fs.mkdirSync(slots, { mode: 0o700 });
  const sleeper = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  t.after(() => { try { sleeper.kill('SIGKILL'); } catch { /* gone */ } });
  await sleep(200);
  const future = new Date('2030-01-01T00:00:00Z');
  const readable = processInfo(process.pid).command !== null;
  const put = (name, value) => fs.writeFileSync(path.join(slots, name), typeof value === 'string' ? value : JSON.stringify({ token: `t-${name}`, label: 'forged', dataDir: null, ...value }));
  const plant = () => {
    put('slot-0', { pid: 1 }); // launchd: another user's pid, and no start
    put('slot-1', { pid: 1, start: processStart(1) ?? Date.now() }); // another user's pid with its real start
    put('slot-2', { pid: process.pid }); // a live test process, but no start
    fs.mkdirSync(path.join(slots, 'slot-3')); fs.utimesSync(path.join(slots, 'slot-3'), future, future); // not a record, dated 2030
    put('slot-4', 'junk'); fs.utimesSync(path.join(slots, 'slot-4'), future, future);
    put('slot-5', { pid: process.pid, start: Date.now() + 3600 * 1000 }); // a start in the future
    // A live process that is not node or python, with its real start (where
    // this process can read command lines).
    if (readable) put('slot-6', { pid: sleeper.pid, start: processStart(sleeper.pid) });
  };
  const n = readable ? 7 : 6;
  plant();
  const got = [];
  for (let i = 0; i < n; i++) got.push(await acquirePgSlot(null, { dir: slots, slots: n, timeoutMs: 3000, label: `n${i}` }));
  assert.deepEqual(got.map(s => s.name).sort(), Array.from({ length: n }, (_, i) => `slot-${i}`).sort(), 'node reclaimed every forged slot');
  for (const s of got) s.release();
  assert.deepEqual(slotFiles(slots), []);
  plant();
  const py = await child('python', `got = [pg_slot.acquire(slots=${n}, timeout=3, label='p%d' % i) for i in range(${n})]
print(' '.join(sorted(s.name for s in got)))
for s in got: s.release()`, { PG_TEST_SLOT_DIR: slots }).done;
  assert.equal(py.status, 0, py.err);
  assert.equal(py.out.trim(), Array.from({ length: n }, (_, i) => `slot-${i}`).sort().join(' '), 'python reclaimed every forged slot');
  assert.deepEqual(slotFiles(slots), []);
  // No record holds a slot longer than MAX_OWNER_AGE_MS, whatever it names.
  const me = processInfo(process.pid);
  const start = me.start ?? Math.round(Date.now() - process.uptime() * 1000);
  assert.equal(ownerGone({ pid: process.pid, start }, { start, command: me.command }), false, 'this live node process owns its record');
  assert.equal(ownerGone({ pid: process.pid, start }, { start, command: me.command }, start + MAX_OWNER_AGE_MS + 1000), true);
  assert.equal(ownerGone({ pid: process.pid, start }, { start, command: '/bin/zsh -l' }), true, 'only node and python take slots');
  const pyAge = await child('python', `start, command = pg_slot.process_info(os.getpid())
record = {'pid': os.getpid(), 'start': start}
print(pg_slot.owner_gone(record), pg_slot.owner_gone(record, now=start + pg_slot.MAX_OWNER_AGE_MS + 1000), pg_slot.owner_gone(record, (start, '/bin/zsh -l')))`, {}).done;
  assert.equal(pyAge.status, 0, pyAge.err);
  assert.equal(pyAge.out.trim(), 'False True True');
});

// Review of 2026-09-29: reclaim moved the name aside and put back a record it
// had not judged. A reclaimer holding an old judgment of a stale slot could
// move aside the live record another process had linked there since; a third
// process linked into the name in that moment, the put-back failed, and the
// live record was deleted (13 clusters on 12 slots, one with no record).
// Now a name is removed only under the lock, and only if it is still what was
// judged: the name is never free for a moment.
test('a reclaimer with an old judgment never removes the live record linked there since, in node and in python', { skip: pySkip, timeout: 60000 }, async t => {
  const dir = scratch(t);
  const slots = path.join(dir, 'slots');
  fs.mkdirSync(slots, { mode: 0o700 });
  const file = path.join(slots, 'slot-0');
  const other = path.join(slots, '.other-record');
  fs.writeFileSync(other, JSON.stringify({ pid: process.pid, start: 0, token: 'other' }));
  const dead = await deadPid();
  fs.writeFileSync(file, JSON.stringify({ pid: dead, start: Date.now(), token: 'stale', dataDir: null }));
  const judged = inspectSlot(file); // A judges the stale record...
  fs.rmSync(file); // ...B removes it first...
  const live = await acquirePgSlot(null, { dir: slots, slots: 1, timeoutMs: 2000, label: 'live' }); // ...and C links a live record
  // Whenever slot-0 is free for a moment, a third process links into it.
  const { renameSync, unlinkSync } = fs;
  let freed = 0;
  const race = from => { if (from === file) { freed++; try { fs.linkSync(other, file); } catch { /* taken */ } } };
  fs.renameSync = (from, to) => { renameSync(from, to); race(from); };
  fs.unlinkSync = f => { unlinkSync(f); race(f); };
  let removed;
  try { removed = reclaimSlot(slots, file, judged); } finally { fs.renameSync = renameSync; fs.unlinkSync = unlinkSync; }
  assert.equal(removed, false, 'A removed nothing');
  assert.equal(freed, 0, 'the name was never free');
  assert.equal(inspectSlot(file).record.token, live.token, 'the live record is still there');
  live.release();
  assert.deepEqual(slotFiles(slots), []);
  // A lock a live process holds keeps reclaimers out (they try again later);
  // a lock whose owner is gone, or dated in the future, is broken.
  fs.writeFileSync(file, JSON.stringify({ pid: dead, start: Date.now(), token: 'stale', dataDir: null }));
  const lock = path.join(slots, 'reclaim.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start: Date.now(), token: 'busy' }));
  assert.equal(reclaimSlot(slots, file, inspectSlot(file)), false, 'a live lock holder keeps the reclaimer out');
  assert.equal(inspectSlot(file).record.token, 'stale');
  fs.writeFileSync(lock, JSON.stringify({ pid: dead, start: Date.now(), token: 'dead' }));
  assert.equal(reclaimSlot(slots, file, inspectSlot(file)), true, 'a dead holder\'s lock is broken');
  fs.writeFileSync(file, JSON.stringify({ pid: dead, start: Date.now(), token: 'stale', dataDir: null }));
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start: Date.now(), token: 'future' }));
  const future = new Date('2030-01-01T00:00:00Z');
  fs.utimesSync(lock, future, future);
  assert.equal(reclaimSlot(slots, file, inspectSlot(file)), true, 'a lock dated in the future is broken');
  assert.deepEqual(fs.readdirSync(slots).sort(), ['.other-record'], 'no lock or draft left');
  // python: the same race, through os.rename and os.unlink.
  const py = await child('python', `import json
d = ${JSON.stringify(slots)}; p = os.path.join(d, 'slot-0'); other = os.path.join(d, '.other-record')
with open(p, 'w') as f: f.write(json.dumps({'pid': ${dead}, 'start': time.time() * 1000, 'token': 'stale', 'dataDir': None}))
judged = pg_slot._inspect(p)
os.unlink(p)
live = pg_slot.acquire(directory=d, slots=1, timeout=2, label='live')
freed = [0]
real_rename, real_unlink = os.rename, os.unlink
def race(path):
    if path == p:
        freed[0] += 1
        try: os.link(other, p)
        except OSError: pass
def rename(a, b): real_rename(a, b); race(a)
def unlink(a, *args, **kw): real_unlink(a, *args, **kw); race(a)
os.rename, os.unlink = rename, unlink
try: removed = pg_slot._reclaim(d, p, judged)
finally: os.rename, os.unlink = real_rename, real_unlink
print(json.dumps({'removed': removed, 'freed': freed[0], 'live': pg_slot._inspect(p)['record']['token'] == live.token}))
live.release()`, {}).done;
  assert.equal(py.status, 0, py.err);
  assert.deepEqual(JSON.parse(py.out.trim()), { removed: false, freed: 0, live: true });
  assert.deepEqual(slotFiles(slots), []);
});

// Review of 2026-09-29: the wait for a slot happens inside the test body, so
// with only its own budget a test queued behind other runs timed out (120 s)
// long before PG_TEST_SLOT_TIMEOUT (600 s), and a good change was refused.
test('the wait for a slot comes on top of a test\'s own timeout', { timeout: 60000 }, async t => {
  const dir = scratch(t);
  const slots = path.join(dir, 'slots');
  const env = { PG_TEST_SLOT_DIR: slots, PG_TEST_SLOTS: '1', PG_TEST_SLOT_TIMEOUT: '30' };
  assert.equal(withSlotWait(1000, env), 31000);
  const holder = child('node', "const s = await slots.acquirePgSlot(null, { label: 'holder' }); console.log('held'); process.stdin.once('data', () => { s.release(); process.exit(0); });", env);
  await holder.saw('held');
  const testFile = (name, timeout) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `import test from 'node:test';\nimport { acquirePgSlot, withSlotWait } from ${JSON.stringify(NODE_HELPER)};\n` +
      `test('takes a slot', { timeout: ${timeout} }, async () => { (await acquirePgSlot(null)).release(); });\n`);
    return file;
  };
  const runTest = file => new Promise(resolve => {
    const c = spawn(process.execPath, ['--test', file], { env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
    c.on('close', code => resolve({ code, out }));
  });
  const began = Date.now();
  const bare = runTest(testFile('bare.test.mjs', '1000'));
  const waits = runTest(testFile('waits.test.mjs', 'withSlotWait(1000)'));
  await sleep(2500);
  holder.proc.stdin.write('go\n');
  const [b, w] = await Promise.all([bare, waits]);
  assert.notEqual(b.code, 0, 'its own 1 s alone: the wait behind the holder timed it out');
  assert.match(b.out, /timed out after 1000ms/);
  assert.equal(w.code, 0, w.out);
  assert.ok(Date.now() - began >= 2500, 'it waited past its own 1 s and passed');
  assert.equal((await holder.done).status, 0);
});

test('every test that takes a slot, itself or through a python fixture, has the slot wait on top of its timeout', () => {
  const root = path.resolve(HERE, '../..');
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === '__pycache__') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  const all = [...walk(path.join(root, 'tests')), ...walk(path.join(root, 'scripts'))];
  const python = all.filter(f => f.endsWith('.py') && path.basename(f) !== 'pg_slot.py' && /pg_slot\.acquire\(/.test(fs.readFileSync(f, 'utf8'))).map(f => path.basename(f));
  assert.ok(python.length >= 15, `python fixtures found: ${python.length}`);
  const takers = [], bad = [];
  for (const f of all.filter(f => f.endsWith('.test.mjs') && path.dirname(f) !== HERE)) {
    const text = fs.readFileSync(f, 'utf8');
    if (!/acquirePgSlot(?:Sync)?\(|postgresFixture\(/.test(text) && !python.some(p => text.includes(p))) continue;
    takers.push(f);
    text.split('\n').forEach((line, i) => { if (/\btest\(/.test(line) && /\btimeout:\s*\d/.test(line)) bad.push(`${path.relative(root, f)}:${i + 1}`); });
  }
  assert.ok(takers.length >= 22, `tests that take a slot found: ${takers.length}`);
  assert.deepEqual(bad, [], 'a literal timeout counts the slot wait against the test: use withSlotWait');
});

// Review of 2026-09-29: the profile resolved a shared directory's own name,
// and granted (subpath dir), which covers the directory entry itself: a
// sandboxed process removed the slot directory, put a symlink to another
// directory (~/Library/LaunchAgents, a checkout's .git/hooks) in its place,
// and every later profile made that target writable. Now the name is never
// resolved, anything but a real directory of this user that only it can write
// is refused, and only the entries inside it are granted.
test('a shared sandbox directory is never followed through a symlink, and only its entries are granted', t => {
  const base = fs.realpathSync(scratch(t, 'pg-slot-shared-'));
  const work = path.join(base, 'work'); fs.mkdirSync(work);
  const victim = path.join(base, 'victim'); fs.mkdirSync(victim);
  const profile = shared => sandboxProfile({ kind: 'gates', home: os.homedir(), writable: [work], shared: [shared] });
  const planted = path.join(base, 'credentialdomd-pg-slots-planted');
  fs.symlinkSync(victim, planted);
  for (const kind of ['gates', 'session']) {
    assert.throws(() => sandboxProfile({ kind, home: os.homedir(), writable: [work], shared: [planted] }), /not a directory of this user that only it can write/);
  }
  const open = path.join(base, 'open-to-others'); fs.mkdirSync(open); fs.chmodSync(open, 0o777);
  assert.throws(() => profile(open), /only it can write/, 'a directory others can write is refused');
  assert.throws(() => sandboxProfile({ kind: 'gates', home: os.homedir(), writable: [work], shared: [path.join(work, 'slots')] }), /may not sit in a writable one/);
  // A missing one is made, owner-only; the profile grants what is inside it,
  // and the directory itself only to read.
  const fresh = path.join(base, 'credentialdomd-pg-slots-fresh');
  const text = profile(fresh);
  assert.equal(fs.lstatSync(fresh).mode & 0o777, 0o700);
  assert.ok(text.includes(`(allow file-read* file-write* (subpath "${work}") (regex #"^${fresh}/"))`), text);
  assert.ok(text.includes(`(require-any (subpath "${work}") (regex #"^${fresh}/") (subpath "/dev"))`), text);
  assert.ok(text.includes(`(allow file-read* (literal "${fresh}"))`));
  assert.ok(!text.includes(`(subpath "${fresh}")`) && !text.includes(victim), 'no subpath grant of the directory, and nothing of the symlink\'s target');
  assert.ok(profile(path.join(base, 'a.b+c')).includes('(regex #"^' + base + '/a\\.b\\+c/")'), 'regex characters in the path are escaped');
});

// The runner's gates and sessions run the suite in their sandboxes: they take
// slots in their run's own directory (never the owner's, which they cannot
// write), and cannot remove, rename or replace that directory.
const sandboxSkip = process.platform !== 'darwin' ? 'macOS sandbox only' : !sandboxAvailable() ? 'sandbox-exec cannot run inside another sandbox' : false;
test('inside the gates sandbox a test takes a slot in its run\'s own directory, cannot swap that directory, and cannot touch the owner\'s slots', { skip: sandboxSkip || pySkip, timeout: 60000 }, async t => {
  const dir = fs.realpathSync(scratch(t));
  const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp);
  const profileDir = path.join(dir, 'profiles'); fs.mkdirSync(profileDir);
  const victim = fs.realpathSync(scratch(t, 'pg-slot-victim-'));
  const run = runSlotDir();
  t.after(() => fs.rmSync(run, { recursive: true, force: true }));
  const owner = defaultSlotDir();
  const sandbox = { home: os.homedir(), profileDir, slots: run };
  const env = { PATH: process.env.PATH, HOME: os.homedir(), LC_ALL: 'C' };
  const script = `import * as slots from ${JSON.stringify(NODE_HELPER)};
    const fs = await import('node:fs');
    const s = await slots.acquirePgSlot(null, { label: 'gates-sandbox-probe' });
    console.log('slot ' + slots.slotDir() + ' ' + slots.slotCount() + ' ' + s.name); s.release();
    const tryIt = fn => { try { fn(); return 'allowed'; } catch (e) { return e.code || 'error'; } };
    console.log('owner ' + tryIt(() => { fs.mkdirSync(${JSON.stringify(owner)}, { recursive: true }); fs.writeFileSync(${JSON.stringify(path.join(owner, `slot-forged-${process.pid}`))}, '{"pid":1}'); }));
    console.log('rmdir ' + tryIt(() => fs.rmdirSync(${JSON.stringify(run)})));
    console.log('rename ' + tryIt(() => fs.renameSync(${JSON.stringify(run)}, ${JSON.stringify(`${run}.moved`)})));
    console.log('victim ' + tryIt(() => fs.writeFileSync(${JSON.stringify(path.join(victim, 'escaped'))}, 'x')));`;
  let err = '';
  const onStderr = text => { err += text; };
  const r = await gateLaunch({ sandbox, dir, tmp, command: process.execPath, args: ['--input-type=module', '-e', script], env, timeoutMs: 30000, onStderr });
  t.after(() => fs.rmSync(path.join(owner, `slot-forged-${process.pid}`), { force: true }));
  assert.equal(r.code, 0, err);
  assert.match(r.stdout, new RegExp(`slot ${run} ${RUN_PG_SLOTS} slot-\\d+`), 'the run\'s own directory and count, from the environment');
  assert.match(r.stdout, /owner EPERM/, 'the owner\'s slots are not writable');
  assert.match(r.stdout, /rmdir EPERM/);
  assert.match(r.stdout, /rename EPERM/);
  assert.match(r.stdout, /victim EPERM/);
  assert.equal(fs.lstatSync(run).isDirectory(), true, 'the directory is still the directory');
  const py = await gateLaunch({ sandbox, dir, tmp, command: python, env, timeoutMs: 30000, onStderr,
    args: ['-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(HERE)}); import pg_slot; s = pg_slot.acquire(label='gates-sandbox-probe-py'); print('slot', pg_slot.slot_dir(), pg_slot.slot_count(), s.name); s.release()`] });
  assert.equal(py.code, 0, err);
  assert.match(py.stdout, new RegExp(`slot ${run} ${RUN_PG_SLOTS} slot-\\d+`));
  assert.deepEqual(holders(run), [], 'the probes gave their slots back');
  // Without the shared directory the same process cannot take a slot, and
  // says what to do.
  const closed = path.join(profileDir, 'closed.sb');
  fs.writeFileSync(closed, sandboxProfile({ kind: 'gates', home: os.homedir(), writable: [dir, tmp] }));
  const probe = spawnSync(SANDBOX_EXEC, ['-f', closed, process.execPath, '--input-type=module', '-e', `import * as slots from ${JSON.stringify(NODE_HELPER)};
    try { (await slots.acquirePgSlot(null, { dir: ${JSON.stringify(`${run}-closed-probe`)} })).release(); console.log('open'); } catch (e) { console.log(e.message); }`], { encoding: 'utf8', env: { ...env, TMPDIR: `${tmp}/` } });
  assert.match(probe.stdout, /Cannot create the PostgreSQL test slot directory .* set PG_TEST_SLOT_DIR/, probe.stderr);
  // Sessions get the same directory, in their environment and their profile.
  const sessionDir = path.join(dir, 'session'); fs.mkdirSync(sessionDir);
  t.after(removeSessionTemps);
  const how = await sessionLaunch({ claude: '/bin/echo', args: [], cwd: dir, sessionDir, baseEnv: { PATH: '/bin', HOME: os.homedir() }, sandbox });
  assert.equal(how.env.PG_TEST_SLOT_DIR, run);
  assert.equal(how.env.PG_TEST_SLOTS, String(RUN_PG_SLOTS));
  const session = fs.readFileSync(how.args[1], 'utf8');
  assert.ok(session.includes(`(regex #"^${run}/")`) && !session.includes(`(subpath "${run}")`), session);
  assert.ok(!session.includes(owner + '"') && !session.includes(owner + '/'), 'the owner\'s slot directory is in no profile');
  assert.ok(!session.includes(`(remote unix-socket (subpath "${run}"))`), 'no socket there is a sandboxed process\'s own');
});
