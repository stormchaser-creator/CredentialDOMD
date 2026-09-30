// A machine-wide cap on the disposable PostgreSQL clusters tests start.
//
// Every running cluster, and initdb's bootstrap, takes one System V
// shared-memory segment for its data-directory interlock (even with mmap
// shared memory), and macOS allows kern.sysv.shmmni = 32 segments for the
// whole machine. One `npm test` alone starts up to ~23 clusters at once, so
// two suites at once (the ticket runner's sandboxed gate and another
// worktree's run) failed initdb with "could not create shared memory
// segment: No space left on device" and good changes were refused. Every
// fixture therefore takes a slot before initdb and gives it back once its
// cluster is stopped.
//
// The protocol (tests/helpers/pg_slot.py implements the same one, so node
// and python fixtures share the slots):
//   directory  PG_TEST_SLOT_DIR, default <realpath /tmp>/credentialdomd-pg-slots-<uid>
//              (/private/tmp/... on macOS): one per user and independent of
//              TMPDIR. It must be a directory of this user that no one else
//              can write. The ticket runner gives each run's sandboxed
//              sessions and gates a directory of their own instead
//              (scripts/ticket-fix/sandbox.mjs runSlotDir, with its own
//              PG_TEST_SLOTS); no sandboxed process can write this one.
//   slots      slot-0 .. slot-<N-1>, N = PG_TEST_SLOTS (default 12). A slot is
//              held while its file exists. It is taken by hard-linking a
//              complete record onto the name (link fails if the name exists),
//              so no reader ever sees a half-written record.
//   record     JSON {pid, start (process start, epoch ms), token, label,
//              dataDir, dataIno, since}. <dataDir>.pg-slot holds the token:
//              the proof that a cluster in that directory belongs to this
//              slot. The helper makes the (empty) data directory when it
//              takes the slot and records its inode (dataIno): PostgreSQL
//              keys its System V segment on that inode, and initdb, when it
//              is signalled, removes only what it put in a directory it did
//              not make, so the directory, and its inode, outlive it.
//   stale      the owner is gone. A record is not trusted to name a live test
//              process: it holds its slot only while its pid runs as this
//              user (a process of another user, such as pid 1, never owns
//              one), started when the record says (a record without a start
//              is stale), for under 2 hours, as a node or python process
//              (when this process can tell). Anything at a slot name that is
//              not a record is stale once 60 s old, or dated in the future.
//              A cluster the dead owner left running still holds its
//              segment, so it is stopped first (SIGQUIT, PostgreSQL's
//              immediate shutdown, which frees the segment), and only when
//              its postmaster.pid names a postgres process whose command line
//              is `-D <dataDir>` and the marker matches: a record anyone can
//              write never gets another process signalled. Then the segments
//              the dead owner's backends orphaned (a backend SIGKILLed while
//              attached, as during initdb, leaves its segment on the machine
//              for good) are removed: scripts/ticket-fix/pg-clusters.mjs
//              removeOrphanSegments, keyed on the recorded inode.
//   removal    a slot name is removed only under the directory's lock
//              (reclaim.lock, itself a record, taken by hard link; broken
//              when its pid no longer runs or it is 10 s old), and only while it is
//              still the very file (inode and content) its remover judged: a
//              record linked there meanwhile is never touched.
//   waiting    polls with backoff (to 1 s) for PG_TEST_SLOT_TIMEOUT seconds
//              (default 600), then fails naming the holders. A test that
//              takes a slot gets that wait on top of its own timeout
//              (withSlotWait).
//   release    slot.release() once the cluster is stopped; also on process
//              exit, SIGINT, SIGTERM and SIGHUP, which first stop a cluster
//              of this process that is still running. It removes the
//              segments this slot's cluster orphaned (an initdb killed by a
//              timeout) before the slot is free.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { removeOrphanSegments, clusterInodes, directoryInode } from '../../scripts/ticket-fix/pg-clusters.mjs';

export const DEFAULT_SLOTS = 12;
export const DEFAULT_TIMEOUT_SECONDS = 600;
const START_TOLERANCE_MS = 3000;
const MAX_RECORD = 4096;
// A name in the slot directory that is not a readable record (a crash
// between create and write cannot make one, but anything can be put there)
// is reclaimed once it is this old, or dated in the future.
const GARBAGE_AGE_MS = 60 * 1000;
// Dated in the future: more than the clock's granularity ahead (a file
// written this millisecond has an mtime a fraction of one past Date.now()).
const future = age => age < -START_TOLERANCE_MS;
// No test process holds a slot this long: a record whose owner has run
// longer is stale, whatever it names.
export const MAX_OWNER_AGE_MS = 2 * 3600 * 1000;
const WAIT_NOTICE_MS = 30 * 1000;
const STOP_WAIT_MS = 15 * 1000;
const LOCK_NAME = 'reclaim.lock';
const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 1000;
const LINUX_TICKS = 100; // USER_HZ, what /proc/<pid>/stat counts in
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SLOT_NAME = /^slot-(\d+)$/;
const LEFTOVER = /^\.(?:tmp|stale)-(\d+)-[0-9a-f]+$/;
// The program of every slot owner: the node and python test helpers.
const OWNER_PROGRAM = /(?:^|\/)(?:node|nodejs|python[0-9.]*|Python)(?:\s|$)/;

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 'user');
export function defaultSlotDir() {
  let tmp;
  try { tmp = fs.realpathSync('/tmp'); } catch { tmp = os.tmpdir(); }
  return path.join(tmp, `credentialdomd-pg-slots-${uid()}`);
}
export const slotDir = (env = process.env) => env.PG_TEST_SLOT_DIR || defaultSlotDir();
export function slotCount(env = process.env) {
  const text = env.PG_TEST_SLOTS;
  if (text === undefined || text === '') return DEFAULT_SLOTS;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw Error(`PG_TEST_SLOTS must be a whole number from 1 to 1000, not ${JSON.stringify(text)}`);
  return n;
}
export function slotTimeoutMs(env = process.env) {
  const text = env.PG_TEST_SLOT_TIMEOUT;
  if (text === undefined || text === '') return DEFAULT_TIMEOUT_SECONDS * 1000;
  const n = Number(text);
  if (!(n > 0) || !Number.isFinite(n)) throw Error(`PG_TEST_SLOT_TIMEOUT must be a positive number of seconds, not ${JSON.stringify(text)}`);
  return n * 1000;
}
// The timeout of a test that takes a slot: its own budget plus the longest
// wait for the slot. The wait happens inside the test, so with the test's
// own budget alone a test queued behind other runs timed out long before
// PG_TEST_SLOT_TIMEOUT (review of 2026-09-29: three suites at once, 120 s
// tests failing "test timed out" after waiting up to 156 s for a slot).
export const withSlotWait = (ms, env = process.env) => slotTimeoutMs(env) + ms;

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Whether a process of this user runs: kill(pid, 0) succeeds. EPERM is a
// process of another user (pid 1 is launchd's), which is never a slot owner
// nor one of our clusters.
export function running(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function linuxStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const boot = Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? Math.round((boot + ticks / LINUX_TICKS) * 1000) : null;
  } catch { return null; }
}
function linuxCommand(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '').split('\0').join(' ') || null; } catch { return null; }
}
const psEnv = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' };
// When another process started (epoch ms) and its command line (arguments
// joined by spaces), each null when this process cannot tell: on macOS
// inside the runner's sandbox the setuid /bin/ps does not run.
export function processInfo(pid) {
  if (process.platform === 'linux') return { start: linuxStart(pid), command: linuxCommand(pid) };
  const r = spawnSync('/bin/ps', ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: psEnv, timeout: 10000 });
  const m = r.status === 0 && /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})(?:\s+(.*?))?\s*$/s.exec(r.stdout);
  if (!m || !MONTHS.includes(m[1])) return { start: null, command: null };
  return { start: Date.UTC(Number(m[6]), MONTHS.indexOf(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])), command: m[7] || null };
}
export const processStart = pid => processInfo(pid).start;
const ownStart = () => (process.platform === 'linux' ? linuxStart(process.pid) : null) ?? Math.round(Date.now() - process.uptime() * 1000);
// A process's command line, or null. On macOS pgrep (not setuid) still reads
// it inside the runner's sandbox.
export function processCommand(pid) {
  if (process.platform === 'linux') return linuxCommand(pid);
  const command = processInfo(pid).command;
  if (command) return command;
  const all = spawnSync('/usr/bin/pgrep', ['-lf', '.'], { encoding: 'utf8', env: psEnv, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
  const line = all.status === 0 ? all.stdout.split('\n').find(l => l.startsWith(`${pid} `)) : null;
  return line?.slice(String(pid).length + 1).trim() || null;
}

// A small regular file's text and inode, never following a link or blocking
// on a pipe (the slot directory is writable by sandboxed test code).
function readSmall(file) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RECORD) return null;
    const buffer = Buffer.alloc(MAX_RECORD);
    const n = fs.readSync(fd, buffer, 0, MAX_RECORD, 0);
    return { text: buffer.subarray(0, n).toString('utf8'), ino: st.ino };
  } catch { return null; } finally { fs.closeSync(fd); }
}
// What is at a slot name: null when free, else its inode, kind, age, text
// (a small regular file's) and record (when the text is one).
function inspect(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const seen = { ino: st.ino, kind: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other', age: Date.now() - st.mtimeMs, text: null, record: null };
  const read = st.isFile() ? readSmall(file) : null;
  if (read && read.ino === st.ino) {
    seen.text = read.text;
    try { const record = JSON.parse(read.text); if (record && typeof record === 'object' && !Array.isArray(record)) seen.record = record; } catch { /* not a record */ }
  }
  return seen;
}
// Whether a record's owner is gone (see "stale" above). info: the owner's
// processInfo, and now, for tests.
export function ownerGone(record, info = null, now = Date.now()) {
  const pid = record.pid;
  if (!Number.isInteger(pid) || pid < 1 || !running(pid)) return true;
  if (typeof record.start !== 'number' || !Number.isFinite(record.start)) return true;
  const seen = info ?? processInfo(pid);
  if (seen.start !== null && Math.abs(seen.start - record.start) > START_TOLERANCE_MS) return true;
  const start = seen.start ?? record.start;
  if (now - start > MAX_OWNER_AGE_MS || start - now > START_TOLERANCE_MS) return true;
  if (seen.command !== null && !OWNER_PROGRAM.test(seen.command)) return true;
  return false;
}
const markerFile = dataDir => `${dataDir}.pg-slot`;
// The cluster a record covers: { state: 'none' } when nothing of it runs,
// { state: 'running', pid } for its postmaster, { state: 'unknown' } when a
// process runs that this process cannot identify. own: the record is this
// process's, for a data directory it made, so its postmaster.pid is trusted
// as pg_ctl trusts it; another's record must also prove itself.
function clusterOf(record, own) {
  const dataDir = record.dataDir;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof record.token !== 'string') return { state: 'none' };
  if (readSmall(markerFile(dataDir))?.text.trim() !== record.token) return { state: 'none' };
  const pid = Number(readSmall(path.join(dataDir, 'postmaster.pid'))?.text.split('\n')[0]);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !running(pid)) return { state: 'none' };
  const command = processCommand(pid);
  if (command === null) return own ? { state: 'running', pid } : { state: 'unknown' };
  const program = command.split(' ')[0];
  const names = /(?:^|\/)(?:postgres|postmaster)$/.test(program) && (command.includes(` -D ${dataDir} `) || command.endsWith(` -D ${dataDir}`));
  return names ? { state: 'running', pid } : { state: 'none' };
}
// PostgreSQL's immediate shutdown (what pg_ctl -m immediate sends): the
// postmaster ends its children and removes its shared memory.
function stopCluster(pid) {
  try { process.kill(pid, 'SIGQUIT'); } catch { /* gone, or not signalable from here */ }
  const until = Date.now() + STOP_WAIT_MS;
  while (running(pid) && Date.now() < until) sleepSync(50);
  return !running(pid);
}
const garbage = seen => seen.age > GARBAGE_AGE_MS || future(seen.age);
function reclaimable(seen) {
  if (!seen.record) return garbage(seen);
  if (!ownerGone(seen.record)) return false;
  const cluster = clusterOf(seen.record, false);
  if (cluster.state === 'unknown') return false;
  if (cluster.state === 'running' && !stopCluster(cluster.pid)) return false;
  // The segments its backends orphaned, before the slot is anyone else's.
  try { removeOrphanSegments(clusterInodes(seen.record)); } catch { /* best effort */ }
  return true;
}
// Removes a name only if it is still exactly what was seen there (inode,
// kind and content): a record linked there since is never touched.
function removeIfSame(file, seen) {
  const now = inspect(file);
  if (!now || now.ino !== seen.ino || now.kind !== seen.kind || now.text !== seen.text) return false;
  fs.rmSync(file, { recursive: true, force: true });
  return true;
}
// Runs fn holding the directory's lock: { held: true, value } or, when the
// lock stayed with a live holder for waitMs, { held: false }. Every removal
// of a slot name goes through it, so what a remover saw at a name cannot be
// replaced before it removes it. Removal by rename-aside-and-restore let two
// reclaimers of one stale slot delete a live holder's record (review of
// 2026-09-29). A lock whose owner no longer runs, or older than
// LOCK_STALE_MS (it is held for a few file operations), is broken.
const lockStale = seen => !seen.record || seen.age > LOCK_STALE_MS || future(seen.age) || !Number.isInteger(seen.record.pid) || !running(seen.record.pid);
function underLock(dir, fn, waitMs = LOCK_WAIT_MS) {
  const lock = path.join(dir, LOCK_NAME);
  const token = randomBytes(16).toString('hex');
  const draft = path.join(dir, `.tmp-${process.pid}-${token}`);
  fs.writeFileSync(draft, `${JSON.stringify({ pid: process.pid, start: ownStart(), token, label: 'lock', since: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
  let held = false;
  try {
    const until = Date.now() + waitMs;
    for (let delay = 2; ; delay = Math.min(50, delay * 2)) {
      try { fs.linkSync(draft, lock); held = true; break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const seen = inspect(lock);
      const stale = seen && lockStale(seen);
      if (stale) removeIfSame(lock, seen);
      if (Date.now() >= until) break;
      if (!stale) sleepSync(delay);
    }
  } finally { fs.rmSync(draft, { force: true }); }
  if (!held) return { held: false };
  try { return { held: true, value: fn() }; } finally {
    if (inspect(lock)?.record?.token === token) fs.rmSync(lock, { force: true });
  }
}
// Removes a stale slot, judged as seen, if it is still that: false when it
// changed meanwhile or the lock stayed busy (the caller tries again later).
function reclaim(dir, file, seen) {
  const r = underLock(dir, () => removeIfSame(file, seen));
  return r.held && r.value;
}
// For tests: what is at a name, and removing it as judged.
export const inspectSlot = inspect;
export const reclaimSlot = reclaim;
// Draft and aside files a crashed process left behind.
function sweep(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const m = LEFTOVER.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    try {
      const age = Date.now() - fs.lstatSync(file).mtimeMs;
      if (!running(Number(m[1])) || age > 24 * 3600 * 1000 || future(age)) fs.rmSync(file, { recursive: true, force: true });
    } catch { /* gone */ }
  }
}
function ensureDir(dir) {
  if (!path.isAbsolute(dir)) throw Error(`The PostgreSQL test slot directory must be an absolute path, not ${dir}`);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (error) {
    throw Error(`Cannot create the PostgreSQL test slot directory ${dir} (${error.code}); set PG_TEST_SLOT_DIR to a directory every test process on this machine can write`);
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o022) !== 0) {
    throw Error(`The PostgreSQL test slot directory ${dir} is not a directory of this user that only it can write; set PG_TEST_SLOT_DIR`);
  }
}

const HELD = new Set();
let hooked = false;
function releaseAll() {
  for (const slot of [...HELD]) { try { slot.release(); } catch { /* exiting: best effort */ } }
}
function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', releaseAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const onSignal = () => {
      releaseAll();
      // Alone, die of the signal as if no handler had been installed.
      if (process.listenerCount(signal) === 1) { process.removeListener(signal, onSignal); process.kill(process.pid, signal); }
    };
    process.on(signal, onSignal);
  }
}

export class PgSlot {
  constructor(state, file) {
    this.file = file;
    this.name = path.basename(file);
    this.dir = state.dir;
    this.token = state.record.token;
    this.dataDir = state.record.dataDir;
    this.record = state.record;
    this.released = false;
    if (this.dataDir) { try { fs.writeFileSync(markerFile(this.dataDir), `${this.token}\n`, { mode: 0o600 }); } catch { /* no parent: no cluster to stop later */ } }
    HELD.add(this);
    hook();
  }
  // Gives the slot back. Call it once the cluster is stopped; a cluster of
  // this slot still running is stopped first (immediate shutdown).
  release() {
    if (this.released) return;
    this.released = true;
    HELD.delete(this);
    if (this.dataDir) {
      const cluster = clusterOf(this.record, true);
      if (cluster.state === 'running') stopCluster(cluster.pid);
      try { removeOrphanSegments(clusterInodes(this.record)); } catch { /* best effort */ }
    }
    const mine = () => { const seen = inspect(this.file); if (seen?.record?.token === this.token) removeIfSame(this.file, seen); };
    try { if (!underLock(this.dir, mine).held) mine(); } catch { try { mine(); } catch { /* the directory is gone */ } }
    if (this.dataDir) fs.rmSync(markerFile(this.dataDir), { force: true });
  }
}

function prepare(dataDir, options) {
  const dir = options.dir ?? slotDir();
  const slots = options.slots ?? slotCount();
  const timeoutMs = options.timeoutMs ?? slotTimeoutMs();
  if (dataDir !== null && dataDir !== undefined && !path.isAbsolute(String(dataDir))) throw Error(`acquirePgSlot needs the cluster's absolute data directory, not ${dataDir}`);
  ensureDir(dir);
  sweep(dir);
  const token = randomBytes(16).toString('hex');
  const label = options.label ?? (path.relative(process.cwd(), process.argv[1] ?? '') || 'node');
  // The data directory, made now (empty, owner-only) when its parent exists:
  // its inode keys the cluster's segments (see "record" above).
  if (dataDir) { try { fs.mkdirSync(String(dataDir), { mode: 0o700 }); } catch { /* there already, or no parent yet */ } }
  const dataIno = dataDir ? directoryInode(String(dataDir)) : null;
  const record = { pid: process.pid, start: ownStart(), token, label, dataDir: dataDir ? String(dataDir) : null, ...(dataIno ? { dataIno } : {}), since: new Date().toISOString() };
  const draft = path.join(dir, `.tmp-${process.pid}-${token}`);
  fs.writeFileSync(draft, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  return { dir, slots, record, draft, began: Date.now(), deadline: Date.now() + timeoutMs, timeoutMs, noticed: false };
}
// One pass: a free slot, else reclaim stale ones and try again.
function attempt(state) {
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < state.slots; i++) {
      const file = path.join(state.dir, `slot-${i}`);
      try { fs.linkSync(state.draft, file); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      fs.rmSync(state.draft, { force: true });
      return new PgSlot(state, file);
    }
    let freed = false;
    for (let i = 0; i < state.slots; i++) {
      const file = path.join(state.dir, `slot-${i}`);
      const seen = inspect(file);
      if (seen && reclaimable(seen) && reclaim(state.dir, file, seen)) freed = true;
    }
    if (!freed) return null;
  }
  return null;
}
export function holders(dir = slotDir()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => SLOT_NAME.test(n)).sort((a, b) => Number(SLOT_NAME.exec(a)[1]) - Number(SLOT_NAME.exec(b)[1])).map(name => {
    const seen = inspect(path.join(dir, name));
    const r = seen?.record;
    return { name, pid: r?.pid ?? null, label: r?.label ?? null, dataDir: r?.dataDir ?? null, seconds: seen ? Math.round(seen.age / 1000) : null };
  });
}
function waitNotice(state) {
  if (state.noticed || Date.now() - state.began < WAIT_NOTICE_MS) return;
  state.noticed = true;
  process.stderr.write(`pg-slot: waiting for a PostgreSQL test slot; all ${state.slots} in ${state.dir} are held\n`);
}
function timeoutError(state) {
  const held = holders(state.dir).map(h => `${h.name}: pid ${h.pid} ${h.label ?? '?'} for ${h.seconds} s`).join('; ');
  return Error(`No PostgreSQL test slot came free in ${Math.round(state.timeoutMs / 1000)} s: all ${state.slots} slots in ${state.dir} are held (${held}). ` +
    'Each disposable cluster takes a System V shared-memory segment and this machine has only kern.sysv.shmmni of them, so every test process shares ' +
    'PG_TEST_SLOTS (default 12) slots. Wait for the other test runs, remove the slot files of processes that no longer run, or raise PG_TEST_SLOT_TIMEOUT (seconds).');
}
const backoff = delay => delay * (0.75 + Math.random() / 2);

// Waits for a slot. dataDir: the cluster's data directory, exactly as given to
// initdb and pg_ctl (null when there is none yet). options: { label, dir,
// slots, timeoutMs } override the environment. The test that calls it needs
// the wait on top of its own timeout: { timeout: withSlotWait(ms) }.
export async function acquirePgSlot(dataDir = null, options = {}) {
  const state = prepare(dataDir, options);
  try {
    for (let delay = 25; ; delay = Math.min(1000, delay * 1.5)) {
      const slot = attempt(state);
      if (slot) return slot;
      if (Date.now() >= state.deadline) throw timeoutError(state);
      waitNotice(state);
      await new Promise(resolve => setTimeout(resolve, Math.min(backoff(delay), Math.max(1, state.deadline - Date.now()))));
    }
  } finally { fs.rmSync(state.draft, { force: true }); }
}
// The same, blocking, for fixtures that start PostgreSQL synchronously.
export function acquirePgSlotSync(dataDir = null, options = {}) {
  const state = prepare(dataDir, options);
  try {
    for (let delay = 25; ; delay = Math.min(1000, delay * 1.5)) {
      const slot = attempt(state);
      if (slot) return slot;
      if (Date.now() >= state.deadline) throw timeoutError(state);
      waitNotice(state);
      sleepSync(Math.min(backoff(delay), Math.max(1, state.deadline - Date.now())));
    }
  } finally { fs.rmSync(state.draft, { force: true }); }
}
