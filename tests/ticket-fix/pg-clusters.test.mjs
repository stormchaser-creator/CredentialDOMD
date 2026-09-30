// What disposable PostgreSQL clusters leave behind when their test process
// or the runner is killed (review of 2026-09-30), with real clusters and
// real System V segments (macOS allows 32 for the whole machine):
//   - the runner ended a process group with SIGKILL at once, which kills an
//     initdb backend attached to its segment, and that segment then stays on
//     the machine for good;
//   - a dead owner's slot was given back while its orphaned segment stayed;
//   - a runner stopped by a signal removed its run's slot directory while the
//     clusters its gates had started still ran (pg_ctl puts the postmaster in
//     a session of its own), with their data directories kept, so nothing
//     ever stopped them.
// Each test holds one slot of the machine's own while it runs clusters in
// private slot directories, one at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquirePgSlot, withSlotWait, defaultSlotDir } from '../helpers/pg-slot.mjs';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { sandboxAvailable, shortTmpRoot, RUN_PG_SLOTS } from '../../scripts/ticket-fix/sandbox.mjs';
import { stopRecordedClusters } from '../../scripts/ticket-fix/pg-clusters.mjs';
import { launch } from '../../scripts/ticket-fix/worker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const url = file => pathToFileURL(path.resolve(HERE, file)).href;
const HELPER = url('../helpers/pg-slot.mjs');
const PY_HELPERS = path.resolve(HERE, '../helpers');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
const SLOT_ENV = ['PG_TEST_SLOT_DIR', 'PG_TEST_SLOTS', 'PG_TEST_SLOT_TIMEOUT', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT'];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SLOT_ENV.includes(k) && !k.startsWith('PG')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return true; return check(); };
// Inside the gates sandbox /tmp is not writable: the runner makes these.
const nested = process.platform === 'darwin' && !sandboxAvailable() ? 'inside a sandbox /tmp is not writable' : false;

// This machine's segments, read here without the code under test.
function segments() {
  if (process.platform === 'linux') {
    const [head, ...rows] = fs.readFileSync('/proc/sysvipc/shm', 'utf8').trim().split('\n');
    const cols = head.trim().split(/\s+/);
    return rows.map(r => r.trim().split(/\s+/)).map(f => ({ id: Number(f[cols.indexOf('shmid')]), key: Number(f[cols.indexOf('key')]) >>> 0, nattch: Number(f[cols.indexOf('nattch')]) }));
  }
  const out = spawnSync('/usr/bin/ipcs', ['-m', '-a'], { encoding: 'utf8' }).stdout.split('\n');
  const cols = out.find(l => /^T\s+ID\s+KEY/.test(l)).trim().split(/\s+/);
  return out.filter(l => /^m\s/.test(l)).map(l => l.trim().split(/\s+/)).map(f => ({ id: Number(f[cols.indexOf('ID')]), key: Number(f[cols.indexOf('KEY')]) >>> 0, nattch: Number(f[cols.indexOf('NATTCH')]) }));
}
// PostgreSQL keys a cluster's segment on its data directory's inode.
const keysOf = ino => new Set(Array.from({ length: 10 }, (_, i) => Number(BigInt.asUintN(32, BigInt(ino) + BigInt(i)))));
const inodeOf = dir => { try { return fs.statSync(dir, { bigint: true }).ino; } catch { return null; } };
const segmentsOf = keys => segments().filter(s => keys.has(s.key));
const ipcrm = id => spawnSync('ipcrm', ['-m', String(id)], { stdio: 'ignore' });

function scratch(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A child process; lines(text) waits for a line it prints that starts with text.
function child(command, args, env, options = {}) {
  const proc = spawn(command, args, { env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  let out = '', err = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { err += d; });
  const done = new Promise(resolve => proc.on('close', (code, signal) => resolve({ code, signal, out, err })));
  let ended = false;
  done.then(() => { ended = true; });
  const line = async (text, ms = 60000) => {
    const find = () => out.split('\n').find(l => l.startsWith(text));
    await until(() => find() !== undefined || ended, ms);
    const found = find();
    if (found === undefined) throw Error(`no "${text}" line: ${out}\n${err}`);
    return found.slice(text.length).trim();
  };
  return { proc, done, line, output: () => `${out}\n${err}` };
}

test('a process group is ended with SIGTERM first, and with SIGKILL only after a grace', async t => {
  const dir = scratch(t, 'end-group-');
  const marker = path.join(dir, 'got-term');
  const r = await launch({ command: '/bin/sh', args: ['-c', `trap 'echo term > "${marker}"; exit 0' TERM; sleep 30 & wait`], cwd: dir, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(fs.existsSync(marker), true, 'the group got SIGTERM, so initdb and its backend can clean up and a test can give its slot back');
  // One that ignores SIGTERM still ends.
  const started = Date.now();
  const stubborn = await launch({ command: '/bin/sh', args: ['-c', `trap '' TERM; echo $$ > "${path.join(dir, 'pid')}"; sleep 30 & wait; sleep 30`], cwd: dir, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 300 });
  assert.equal(stubborn.timedOut, true);
  assert.ok(Date.now() - started < 10000, 'SIGKILL followed the grace');
  assert.equal(running(Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'))), false);
});

// Starts initdb from an owner that holds a slot in `pool`, waits until a
// backend of it is attached to its segment, and kills it there: the owner's
// whole group (the owner dies too) or, with alive, only initdb's.
const OWNER = ({ data, alive }) => `import * as slots from ${JSON.stringify(HELPER)};
const { spawn } = await import('node:child_process');
const s = await slots.acquirePgSlot(${JSON.stringify(data)}, { label: 'orphan-maker' });
const init = spawn(${JSON.stringify(path.join(pgBin(), 'initdb'))}, ['-D', ${JSON.stringify(data)}, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'],
  { env: { PATH: process.env.PATH, LC_ALL: 'C' }, stdio: 'ignore', detached: ${alive ? 'true' : 'false'} });
console.log('init ' + init.pid);
init.on('exit', (code, signal) => console.log('initdb-exit ' + code + ' ' + signal));
process.stdin.on('data', d => { if (String(d).includes('release')) { s.release(); console.log('released'); process.exit(0); } });`;
async function orphan(t, { alive = false } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const root = scratch(t, 'pg-orphan-');
    const data = path.join(root, 'data'), pool = path.join(root, 'slots');
    const c = child(process.execPath, ['--input-type=module', '-e', OWNER({ data, alive })], { PG_TEST_SLOT_DIR: pool, PG_TEST_SLOTS: '1' }, { detached: true });
    t.after(() => { try { process.kill(-c.proc.pid, 'SIGKILL'); } catch { /* gone */ } });
    const init = Number(await c.line('init '));
    let keys = null, caught = false;
    for (const end = Date.now() + 20000; Date.now() < end && !c.output().includes('initdb-exit');) {
      const ino = inodeOf(data);
      if (ino !== null) keys = keysOf(ino);
      if (keys && segmentsOf(keys).some(s => s.nattch > 0)) {
        try { process.kill(alive ? -init : -c.proc.pid, 'SIGKILL'); caught = true; } catch { /* ended meanwhile */ }
        break;
      }
      await sleep(10);
    }
    if (!caught) { try { process.kill(-c.proc.pid, 'SIGKILL'); } catch { /* gone */ } continue; }
    await until(() => !running(init), 5000);
    const left = segmentsOf(keys).filter(s => s.nattch === 0);
    // Whatever a failed assertion leaves, this test removes.
    t.after(() => { for (const s of left) if (segments().some(x => x.id === s.id && x.nattch === 0)) ipcrm(s.id); });
    if (!left.length) { try { process.kill(-c.proc.pid, 'SIGKILL'); } catch { /* gone */ } continue; }
    return { c, root, data, pool, keys, ids: left.map(s => s.id) };
  }
  throw Error('could not catch an initdb backend attached to its segment');
}
const present = ids => segments().filter(s => ids.includes(s.id)).map(s => s.id);

test('an owner killed during initdb leaves an orphaned segment, and whoever takes its slot next, node or python, removes it first', { skip: pgSkip(), timeout: withSlotWait(180000) }, async t => {
  const cover = await acquirePgSlot(null, { label: 'pg-clusters.test orphans' });
  t.after(() => cover.release());
  // Python reclaims.
  let o = await orphan(t);
  assert.equal((await o.c.done).signal, 'SIGKILL');
  assert.equal(fs.statSync(o.data).isDirectory(), true, 'the helper made the data directory, so its inode, the segment key, outlives initdb');
  assert.deepEqual(present(o.ids), o.ids, 'the killed backend left its segment, attached by no one');
  if (python) {
    const py = child(python, ['-B', '-c', `import sys; sys.dont_write_bytecode = True; sys.path.insert(0, ${JSON.stringify(PY_HELPERS)}); import pg_slot
s = pg_slot.acquire(label='py-reclaimer', timeout=30); print('got', s.name); s.release()`], { PG_TEST_SLOT_DIR: o.pool, PG_TEST_SLOTS: '1' });
    const r = await py.done;
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(present(o.ids), [], 'python removed the orphaned segment before it took the slot');
    o = await orphan(t);
    await o.c.done;
  }
  // Node reclaims.
  assert.deepEqual(present(o.ids), o.ids);
  const s = await acquirePgSlot(null, { dir: o.pool, slots: 1, timeoutMs: 30000 });
  s.release();
  assert.deepEqual(present(o.ids), [], 'node removed the orphaned segment before it took the slot');
});

test('an owner whose initdb was killed removes the orphaned segment when it gives its slot back', { skip: pgSkip(), timeout: withSlotWait(120000) }, async t => {
  const cover = await acquirePgSlot(null, { label: 'pg-clusters.test release' });
  t.after(() => cover.release());
  const o = await orphan(t, { alive: true });
  assert.deepEqual(present(o.ids), o.ids);
  o.c.proc.stdin.write('release\n');
  await o.c.line('released', 30000);
  assert.deepEqual(present(o.ids), [], 'release() removed the segment its killed initdb left');
});

// A cluster a gate's test started, whose test process was then killed with
// its gate: the postmaster runs on, in a session of its own.
const GATE_CLUSTER = ({ port }) => `import * as slots from ${JSON.stringify(HELPER)};
const { execFileSync } = await import('node:child_process');
const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
const bin = ${JSON.stringify(pgBin())};
const data = path.join(os.tmpdir(), 'data'), sock = path.join(os.tmpdir(), 's');
fs.mkdirSync(sock);
const env = { PATH: process.env.PATH, LC_ALL: 'C' };
const s = await slots.acquirePgSlot(data, { label: 'gate-cluster' });
execFileSync(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'], { env, stdio: 'ignore' });
execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', data + '.log', '-o', "-k " + sock + " -p ${port} -c listen_addresses='' -c fsync=off", '-w', 'start'], { env, stdio: 'ignore' });
console.log('ready ' + fs.readFileSync(path.join(data, 'postmaster.pid'), 'utf8').split('\\n')[0] + ' ' + fs.statSync(data, { bigint: true }).ino);
process.kill(process.pid, 'SIGKILL');`;

test('a runner stopped by a signal stops the clusters its gates left running, and removes their slot directory and temporary directory', {
  skip: pgSkip() || (sandboxAvailable() ? false : 'the runner makes its slot directory only where sandbox-exec runs'), timeout: withSlotWait(180000),
}, async t => {
  const cover = await acquirePgSlot(null, { label: 'pg-clusters.test stop' });
  t.after(() => cover.release());
  // The runner: its signal handlers, its run's slot directory (run.mjs
  // runSlots) and a gate's temporary directory, and one gate step that
  // starts a cluster and is then killed.
  const driver = child(process.execPath, ['--input-type=module', '-e', `
    import { installSignalHandlers, launch } from ${JSON.stringify(url('../../scripts/ticket-fix/worker.mjs'))};
    import { runSlots } from ${JSON.stringify(url('../../scripts/ticket-fix/run.mjs'))};
    import { hostTemp, slotEnv } from ${JSON.stringify(url('../../scripts/ticket-fix/sandbox.mjs'))};
    installSignalHandlers();
    const pool = runSlots(true, () => {});
    const tmp = hostTemp('ctg-');
    console.log('dirs ' + JSON.stringify({ pool, tmp }));
    const r = await launch({ command: process.execPath, args: ['--input-type=module', '-e', ${JSON.stringify(GATE_CLUSTER({ port: 56731 }))}], cwd: tmp,
      env: { PATH: process.env.PATH, LC_ALL: 'C', TMPDIR: tmp + '/', ...slotEnv(pool) }, timeoutMs: 120000, onStdout: text => process.stdout.write(text) });
    console.log('gate-ended ' + (r.signal ?? r.code));
    setInterval(() => {}, 1000);`], {});
  t.after(() => { try { driver.proc.kill('SIGKILL'); } catch { /* gone */ } });
  const { pool, tmp } = JSON.parse(await driver.line('dirs '));
  const [pid, ino] = (await driver.line('ready ', 120000)).split(' ');
  const postmaster = Number(pid);
  t.after(() => { if (running(postmaster)) process.kill(postmaster, 'SIGQUIT'); });
  assert.equal(await driver.line('gate-ended '), 'SIGKILL');
  assert.equal(running(postmaster), true, 'the postmaster outlived its test process');
  const keys = keysOf(ino);
  assert.ok(segmentsOf(keys).some(s => s.nattch > 0), 'and holds its segment');
  // The shell's 3-hour alarm.
  driver.proc.kill('SIGALRM');
  const end = await driver.done;
  assert.equal(end.code, 142, driver.output());
  assert.equal(await until(() => !running(postmaster), 20000), true, 'the stop handler stopped the cluster its records named');
  assert.deepEqual(segmentsOf(keys), [], 'and its segment is free');
  assert.equal(fs.existsSync(pool), false, 'the run\'s slot directory is gone');
  assert.equal(fs.existsSync(tmp), false, 'so is the gate\'s temporary directory, with the data directory');
});

test('a new run stops the clusters a SIGKILLed runner left and removes its slot directory and its temporary directories, never a live runner\'s', {
  skip: nested || pgSkip(), timeout: withSlotWait(180000),
}, async t => {
  const cover = await acquirePgSlot(null, { label: 'pg-clusters.test sweep' });
  t.after(() => cover.release());
  const { runSlotDir } = await import('../../scripts/ticket-fix/sandbox.mjs');
  // The runner that dies: alive while its gate starts the cluster (another
  // test file's run would otherwise sweep its directories first), killed
  // before the next run starts.
  const runner = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  const dead = runner.pid;
  const live = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  t.after(() => { for (const p of [runner, live]) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
  const pool = `${defaultSlotDir()}-run-${dead}-AbC123`;
  const deadTmp = path.join(shortTmpRoot(), `ctg-${dead}-AbC123`), liveTmp = path.join(shortTmpRoot(), `ctg-${live.pid}-AbC123`);
  for (const d of [pool, deadTmp, liveTmp]) { fs.mkdirSync(d, { mode: 0o700 }); t.after(() => fs.rmSync(d, { recursive: true, force: true })); }
  // The dead runner's gate started a cluster in its temporary directory and
  // was killed with it.
  const gate = child(process.execPath, ['--input-type=module', '-e', GATE_CLUSTER({ port: 56732 })], { TMPDIR: `${deadTmp}/`, PG_TEST_SLOT_DIR: pool, PG_TEST_SLOTS: '6' });
  const [pid, ino] = (await gate.line('ready ', 120000)).split(' ');
  const postmaster = Number(pid);
  t.after(() => { if (running(postmaster)) process.kill(postmaster, 'SIGQUIT'); });
  assert.equal((await gate.done).signal, 'SIGKILL');
  assert.equal(running(postmaster), true);
  runner.kill('SIGKILL');
  await new Promise(resolve => (runner.exitCode !== null || runner.signalCode !== null ? resolve() : runner.on('exit', resolve)));
  const next = runSlotDir();
  t.after(() => fs.rmSync(next, { recursive: true, force: true }));
  assert.equal(await until(() => !running(postmaster), 20000), true, 'the dead runner\'s cluster was stopped');
  assert.deepEqual(segmentsOf(keysOf(ino)), [], 'its segment is free');
  assert.equal(fs.existsSync(pool), false, 'the dead runner\'s slot directory was removed');
  assert.equal(fs.existsSync(deadTmp), false, 'so was its temporary directory');
  assert.equal(fs.existsSync(liveTmp), true, 'a live runner\'s stays');
});

// Review of 2026-09-30: sandboxed code writes the entries of its run's slot
// directory, and the host, stopping the run, read every slot-N name there and
// ran a ps for each record whose marker and pid checked out: one forged
// record hard-linked to millions of names kept the stop handler busy for
// hours. The host reads only the pool's own names (the helpers take slot-0 ..
// slot-5 there), looks each cluster up once, and stops looking when its
// budget is spent. The "postmaster" here is node started as "postgres ... -D
// <data directory>": it passes every check without being PostgreSQL.
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function forged(t) {
  const root = scratch(t, 'pg-forged-');
  const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '-D', path.join(root, 'cts-0', 'data')], { argv0: 'postgres', stdio: 'ignore' });
  t.after(() => { try { fake.kill('SIGKILL'); } catch { /* gone */ } });
  const slots = path.join(root, 'slots');
  fs.mkdirSync(slots);
  // A data directory with its marker and a postmaster.pid naming the fake;
  // the record for it, written once.
  const cluster = i => {
    const dataDir = path.join(root, `cts-${i}`, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${dataDir}.pg-slot`, `synthetic-token-${i}\n`);
    fs.writeFileSync(path.join(dataDir, 'postmaster.pid'), `${fake.pid}\n${dataDir}\n`);
    const record = path.join(root, `record-${i}.json`);
    fs.writeFileSync(record, JSON.stringify({ token: `synthetic-token-${i}`, dataDir }));
    return record;
  };
  return { root, fake, slots, cluster };
}

test('a forged record under slot names past the run\'s pool is never looked up; the same record under a pool name is', async t => {
  const f = forged(t);
  const record = f.cluster(0);
  for (const i of [RUN_PG_SLOTS, RUN_PG_SLOTS + 1, 999]) fs.linkSync(record, path.join(f.slots, `slot-${i}`));
  assert.deepEqual(stopRecordedClusters(f.slots, { waitMs: 0 }).stopped, []);
  await sleep(200);
  assert.equal(running(f.fake.pid), true, 'nothing a name past the pool names was signalled');
  // The same record in the pool: the fake passes every check, which is what
  // makes the result above mean something.
  fs.linkSync(record, path.join(f.slots, 'slot-0'));
  assert.deepEqual(stopRecordedClusters(f.slots, { waitMs: 0 }).stopped, [f.fake.pid]);
  assert.equal(await until(() => !running(f.fake.pid), 5000), true);
});

test('one record under every pool name is looked up once, and lookups stop when their budget is spent', t => {
  const f = forged(t);
  const record = f.cluster(0);
  for (let i = 0; i < RUN_PG_SLOTS; i++) fs.linkSync(record, path.join(f.slots, `slot-${i}`));
  const calls = [];
  assert.deepEqual(stopRecordedClusters(f.slots, { waitMs: 0, command: pid => { calls.push(pid); return null; } }).stopped, []);
  assert.deepEqual(calls, [f.fake.pid], 'one lookup, not one per name');
  // A distinct cluster under every pool name, each lookup slow.
  const other = path.join(f.root, 'slots-distinct');
  fs.mkdirSync(other);
  for (let i = 0; i < RUN_PG_SLOTS; i++) fs.copyFileSync(f.cluster(i), path.join(other, `slot-${i}`));
  calls.length = 0;
  const started = Date.now();
  stopRecordedClusters(other, { waitMs: 0, budgetMs: 150, command: pid => { calls.push(pid); sleepSync(100); return null; } });
  assert.ok(calls.length >= 1 && calls.length <= 2, `${calls.length} lookups within a 150 ms budget of 100 ms lookups`);
  assert.ok(Date.now() - started < 1500);
  assert.equal(running(f.fake.pid), true);
});
