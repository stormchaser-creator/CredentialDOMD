// What disposable PostgreSQL clusters leave behind when their test process
// dies (review of 2026-09-30), for the slot helpers
// (tests/helpers/pg-slot.mjs; pg_slot.py has the same code) and the ticket
// runner, which cleans up after the sandboxed tests of a stopped run.
//
// Every cluster, and each backend initdb starts, takes one System V
// shared-memory segment, and macOS allows 32 for the whole machine. A
// backend that is SIGKILLed while attached never removes its segment: it
// stays, attached by no one, until someone removes it or the machine
// restarts, and a new cluster never reuses it. PostgreSQL keys the segment on
// its data directory's inode (sysv_shmem.c: NextShmemSegID = st_ino, the
// next key when that one is taken), so a segment is this cluster's orphan
// when its key is one of the first KEY_SPAN keys from that inode, no process
// is attached, it is this user's, and neither the process that made it nor
// the last one to attach it still runs. PostgreSQL removes such a segment
// itself when a cluster starts again in that directory; a test's directory is
// never used again, so the slot helpers remove it before they give its slot
// back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const KEY_SPAN = 10;
const MAX_SMALL = 4096;
const STOP_WAIT_MS = 15 * 1000;
const TOOL_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' };
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Whether a process of this user runs (EPERM, another user's, is not one).
// pid 0 or below would name a process group, never one process.
export function running(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A small regular file's text, never following a link or blocking on a pipe
// (sandboxed test code can write the slot directory and the data
// directories); null otherwise.
export function readSmall(file) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SMALL) return null;
    const buffer = Buffer.alloc(MAX_SMALL);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, MAX_SMALL, 0)).toString('utf8');
  } catch { return null; } finally { fs.closeSync(fd); }
}

// The segment keys a cluster whose data directory has inode `ino` can hold,
// as unsigned 32-bit numbers (key_t is 32 bits; ipcs prints it in hex).
export function segmentKeys(ino, span = KEY_SPAN) {
  const base = BigInt.asUintN(32, BigInt(ino));
  return Array.from({ length: span }, (_, i) => Number(BigInt.asUintN(32, base + BigInt(i))));
}
// A data directory's inode as a decimal string (the slot record keeps it),
// or null when it is not a real directory.
export function directoryInode(dir) {
  try {
    const st = fs.lstatSync(dir, { bigint: true });
    return st.isDirectory() ? String(st.ino) : null;
  } catch { return null; }
}
const INODE = /^\d{1,20}$/;
// The inodes a slot record's cluster keyed its segments on: the one recorded
// when the slot was taken (the helpers make the data directory then, so a
// signalled initdb, which removes only what it put in a directory it did not
// make, leaves it), and the directory's current one when its marker still
// holds the record's token.
export function clusterInodes(record) {
  const out = new Set();
  if (typeof record?.dataIno === 'string' && INODE.test(record.dataIno)) out.add(record.dataIno);
  const dataDir = record?.dataDir;
  if (typeof dataDir === 'string' && path.isAbsolute(dataDir) && typeof record.token === 'string' && readSmall(`${dataDir}.pg-slot`)?.trim() === record.token) {
    const now = directoryInode(dataDir);
    if (now) out.add(now);
  }
  return [...out];
}

// This machine's System V shared-memory segments: { id, key (unsigned),
// nattch, mine, cpid, lpid }, or null when they cannot be listed. macOS:
// ipcs (it runs inside the runner's sandbox too); Linux: /proc.
export function sysvSegments() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (process.platform === 'linux') {
    let text;
    try { text = fs.readFileSync('/proc/sysvipc/shm', 'utf8'); } catch { return null; }
    const [head, ...rows] = text.trim().split('\n');
    const cols = head.trim().split(/\s+/);
    const at = name => cols.indexOf(name);
    if (['key', 'shmid', 'nattch', 'uid', 'cpid', 'lpid'].some(c => at(c) < 0)) return null;
    return rows.map(r => r.trim().split(/\s+/)).map(f => ({ id: Number(f[at('shmid')]), key: Number(f[at('key')]) >>> 0, nattch: Number(f[at('nattch')]),
      mine: uid !== null && Number(f[at('uid')]) === uid, cpid: Number(f[at('cpid')]), lpid: Number(f[at('lpid')]) }));
  }
  const r = spawnSync('/usr/bin/ipcs', ['-m', '-a'], { encoding: 'utf8', env: TOOL_ENV, timeout: 10000 });
  if (r.status !== 0) return null;
  const lines = r.stdout.split('\n');
  const head = lines.find(l => /^T\s+ID\s+KEY\s/.test(l));
  if (!head) return null;
  const cols = head.trim().split(/\s+/);
  const at = name => cols.indexOf(name);
  if (['ID', 'KEY', 'OWNER', 'NATTCH', 'CPID', 'LPID'].some(c => at(c) < 0)) return null;
  let user = null;
  try { user = os.userInfo().username; } catch { user = null; }
  return lines.filter(l => /^m\s/.test(l)).map(l => l.trim().split(/\s+/)).filter(f => f.length >= cols.length).map(f => ({
    id: Number(f[at('ID')]), key: Number(f[at('KEY')]) >>> 0, nattch: Number(f[at('NATTCH')]),
    mine: (user !== null && f[at('OWNER')] === user) || (uid !== null && f[at('OWNER')] === String(uid)), cpid: Number(f[at('CPID')]), lpid: Number(f[at('LPID')]) }));
}
const ipcrm = id => spawnSync('ipcrm', ['-m', String(id)], { stdio: 'ignore', env: TOOL_ENV, timeout: 10000 }).status === 0;

// Removes the orphaned segments of clusters keyed on these inodes (see the
// header): this user's, attached by no one, made and last attached by
// processes that no longer run. Returns the ids removed. segments and
// remove are for tests.
export function removeOrphanSegments(inodes, { segments = sysvSegments, remove = ipcrm } = {}) {
  const keys = new Set(inodes.filter(i => INODE.test(String(i))).flatMap(i => segmentKeys(i)));
  if (!keys.size) return [];
  const list = segments();
  if (!list) return [];
  const removed = [];
  for (const s of list) {
    if (!keys.has(s.key) || s.nattch !== 0 || !s.mine || running(s.cpid) || running(s.lpid)) continue;
    if (remove(s.id)) removed.push(s.id);
  }
  return removed;
}

// A process's command line from /bin/ps, or null (the host can always run
// it; inside the runner's sandbox the setuid ps does not run).
export function processCommand(pid) {
  const r = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: TOOL_ENV, timeout: 10000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
// The postmaster of a slot record's cluster, or null: its marker holds the
// record's token, its postmaster.pid names a running process, and that
// process is postgres started on exactly that data directory. A record is
// written by test code, so nothing else it names is ever signalled.
export function postmasterOf(record, { command = processCommand } = {}) {
  const dataDir = record?.dataDir;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof record.token !== 'string') return null;
  if (readSmall(`${dataDir}.pg-slot`)?.trim() !== record.token) return null;
  const pid = Number(readSmall(path.join(dataDir, 'postmaster.pid'))?.split('\n')[0]);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !running(pid)) return null;
  const line = command(pid);
  if (!line) return null;
  const program = line.split(' ')[0];
  return /(?:^|\/)(?:postgres|postmaster)$/.test(program) && (line.includes(` -D ${dataDir} `) || line.endsWith(` -D ${dataDir}`)) ? pid : null;
}

// The slot records in a slot directory (slot-N names only).
export function slotRecords(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.filter(n => /^slot-\d+$/.test(n))) {
    const text = readSmall(path.join(dir, name));
    let record = null;
    try { record = text ? JSON.parse(text) : null; } catch { record = null; }
    if (record && typeof record === 'object' && !Array.isArray(record)) out.push(record);
  }
  return out;
}

// Stops every cluster the records in a slot directory name, whatever became
// of their owners, and removes the segments they orphaned. The runner calls
// it before it removes a run's slot directory (the run ended, the runner was
// signalled, or a runner that died left it): once the records are gone no
// reclaimer can find those clusters, and a postmaster whose data directory
// still exists holds its segment for good. SIGQUIT is PostgreSQL's immediate
// shutdown, which frees the segment. Returns { stopped, running, segments }.
export function stopRecordedClusters(dir, { waitMs = STOP_WAIT_MS } = {}) {
  const records = slotRecords(dir);
  const stopped = [];
  for (const record of records) {
    const pid = postmasterOf(record);
    if (pid === null) continue;
    try { process.kill(pid, 'SIGQUIT'); stopped.push(pid); } catch { /* gone meanwhile */ }
  }
  for (const until = Date.now() + waitMs; stopped.some(running) && Date.now() < until;) sleepSync(50);
  const segments = removeOrphanSegments(records.flatMap(clusterInodes));
  return { stopped, running: stopped.filter(running), segments };
}
