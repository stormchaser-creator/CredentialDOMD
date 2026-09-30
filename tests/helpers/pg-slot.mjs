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
//              TMPDIR, which the ticket runner sets per sandboxed run. The
//              runner's sandbox profiles make exactly this directory writable
//              (scripts/ticket-fix/sandbox.mjs pgSlotDir).
//   slots      slot-0 .. slot-<N-1>, N = PG_TEST_SLOTS (default 12). A slot is
//              held while its file exists. It is taken by hard-linking a
//              complete record onto the name (link fails if the name exists),
//              so no reader ever sees a half-written record.
//   record     JSON {pid, start (process start, epoch ms), token, label,
//              dataDir, since}. <dataDir>.pg-slot holds the token: the proof
//              that a cluster in that directory belongs to this slot.
//   stale      the owner is gone: no such pid, or the pid now belongs to a
//              process that started at another time. A cluster the dead owner
//              left running still holds its segment, so it is stopped first
//              (SIGQUIT, PostgreSQL's immediate shutdown, which frees the
//              segment), and only when its postmaster.pid names a postgres
//              process whose command line is `-D <dataDir>` and the marker
//              matches: a record anyone can write never gets another process
//              signalled. The file is moved aside and removed only if it is
//              still the file (inode) that was judged stale.
//   waiting    polls with backoff (to 1 s) for PG_TEST_SLOT_TIMEOUT seconds
//              (default 600), then fails naming the holders.
//   release    slot.release() once the cluster is stopped; also on process
//              exit, SIGINT, SIGTERM and SIGHUP, which first stop a cluster
//              of this process that is still running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const DEFAULT_SLOTS = 12;
export const DEFAULT_TIMEOUT_SECONDS = 600;
const START_TOLERANCE_MS = 3000;
const MAX_RECORD = 4096;
// A name in the slot directory that is not a readable record (a crash
// between create and write cannot make one, but anything can be put there)
// is reclaimed once it is this old.
const GARBAGE_AGE_MS = 60 * 1000;
const WAIT_NOTICE_MS = 30 * 1000;
const STOP_WAIT_MS = 15 * 1000;
const LINUX_TICKS = 100; // USER_HZ, what /proc/<pid>/stat counts in
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SLOT_NAME = /^slot-(\d+)$/;
const LEFTOVER = /^\.(?:tmp|stale)-(\d+)-[0-9a-f]+$/;

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

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function running(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function linuxStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const boot = Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? Math.round((boot + ticks / LINUX_TICKS) * 1000) : null;
  } catch { return null; }
}
const psEnv = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' };
// When another process started (epoch ms), or null when this process cannot
// tell (macOS inside a sandbox, where the setuid /bin/ps may not run).
export function processStart(pid) {
  if (process.platform === 'linux') return linuxStart(pid);
  const r = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: psEnv, timeout: 10000 });
  const m = r.status === 0 && /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(r.stdout);
  if (!m || !MONTHS.includes(m[1])) return null;
  return Date.UTC(Number(m[6]), MONTHS.indexOf(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}
const ownStart = () => (process.platform === 'linux' ? linuxStart(process.pid) : null) ?? Math.round(Date.now() - process.uptime() * 1000);
// A process's command line, arguments joined by spaces, or null. On macOS
// pgrep (not setuid) still reads it inside the runner's sandbox.
export function processCommand(pid) {
  if (process.platform === 'linux') {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '').split('\0').join(' '); } catch { return null; }
  }
  const r = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: psEnv, timeout: 10000 });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
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
// What is at a slot name: null when free, else its inode, age and record.
function inspect(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const seen = { ino: st.ino, age: Date.now() - st.mtimeMs, record: null };
  const read = st.isFile() ? readSmall(file) : null;
  if (read) {
    seen.ino = read.ino;
    try { const record = JSON.parse(read.text); if (record && typeof record === 'object') seen.record = record; } catch { /* not a record */ }
  }
  return seen;
}
function ownerGone(record) {
  const pid = record.pid;
  if (!Number.isInteger(pid) || pid < 1 || !running(pid)) return true;
  if (typeof record.start === 'number') {
    const now = processStart(pid);
    if (now !== null && Math.abs(now - record.start) > START_TOLERANCE_MS) return true;
  }
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
function reclaimable(seen) {
  if (!seen.record) return seen.age > GARBAGE_AGE_MS;
  if (!ownerGone(seen.record)) return false;
  const cluster = clusterOf(seen.record, false);
  if (cluster.state === 'unknown') return false;
  return cluster.state === 'none' || stopCluster(cluster.pid);
}
// Moves the name aside and removes it only if it is the file judged stale;
// a record another process wrote there meanwhile is put back.
function reclaim(dir, file, ino) {
  const aside = path.join(dir, `.stale-${process.pid}-${randomBytes(6).toString('hex')}`);
  try { fs.renameSync(file, aside); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let same = false;
  try { same = fs.lstatSync(aside).ino === ino; } catch { /* gone */ }
  if (!same) { try { fs.linkSync(aside, file); } catch { /* the name was taken again meanwhile */ } }
  fs.rmSync(aside, { recursive: true, force: true });
}
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
      if (!running(Number(m[1])) || age > 24 * 3600 * 1000) fs.rmSync(file, { recursive: true, force: true });
    } catch { /* gone */ }
  }
}
function ensureDir(dir) {
  if (!path.isAbsolute(dir)) throw Error(`The PostgreSQL test slot directory must be an absolute path, not ${dir}`);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (error) {
    throw Error(`Cannot create the PostgreSQL test slot directory ${dir} (${error.code}); set PG_TEST_SLOT_DIR to a directory every test process on this machine can write`);
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw Error(`The PostgreSQL test slot directory ${dir} is not a directory owned by this user; set PG_TEST_SLOT_DIR`);
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
    }
    if (inspect(this.file)?.record?.token === this.token) { try { fs.unlinkSync(this.file); } catch { /* already gone */ } }
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
  const record = { pid: process.pid, start: ownStart(), token, label, dataDir: dataDir ? String(dataDir) : null, since: new Date().toISOString() };
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
      if (seen && reclaimable(seen)) { reclaim(state.dir, file, seen.ino); freed = true; }
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
// slots, timeoutMs } override the environment.
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
