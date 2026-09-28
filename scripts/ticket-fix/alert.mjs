#!/usr/bin/env node
// Owner alerts and a status file for the hourly ticket runner (design phase 0).
//
// Until 2026-09-28 the only record of a parked ticket or a held lock was the
// runner log: 126 runs logged PARKED for two tickets while a third waited, and
// a lock held by hand stopped every run with one SKIP line each. Nobody was
// told. This writes, under the runner's private state directory:
//   alerts.log    one line per alert: time, kind, ticket id prefix or lock age
//   status.json   parked tickets, the lock, the last run and recent alerts
// and sends the same one-line message through the owner notifier
// (scripts/notify-owner.sh, the iMessage path signup-notify.sh uses).
// No ticket text is ever written or sent: ids and counts only.
//
//   alert.mjs park   --state DIR --ticket UUID --count N [--notify PATH]
//   alert.mjs hold   --state DIR --ticket UUID [--notify PATH]
//   alert.mjs lock   --state DIR --lock DIR [--notify PATH] [--max-hours 4]
//   alert.mjs status --state DIR --rc N [--lock DIR]
//
// "hold": a model run changed the runner's own code (the reply checks, the
// runner, the notifier, the support reply migrations or send-ticket-reply).
// The runner records nothing for it and writes HOLD_FILE; no run starts
// until the owner reviews the change and removes that file.
import { promises as fs, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const PARK_AFTER = 3;
export const STALE_LOCK_HOURS = 4;
export const HOLD_FILE = 'HOLD-host-code-changed';

async function writePrivate(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, filename);
}
async function ensureOwnerDir(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error(`${directory} must be an owner-only directory`);
}

export async function parkedList(state) {
  let names;
  try { names = await fs.readdir(path.join(state, 'failed')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const parked = [];
  for (const name of names.sort()) {
    const ticket = name.endsWith('.count') ? name.slice(0, -6) : '';
    if (!UUID.test(ticket)) continue;
    const file = path.join(state, 'failed', name);
    const raw = (await fs.readFile(file, 'utf8')).trim();
    if (!/^\d+$/.test(raw) || Number(raw) < PARK_AFTER) continue;
    parked.push({ ticket, rejected_runs: Number(raw), since: (await fs.stat(file)).mtime.toISOString() });
  }
  return parked;
}

export async function lockState(lock, now = Date.now()) {
  let stat;
  try { stat = await fs.lstat(lock); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let pid = null, started = null;
  try {
    const owner = await fs.readFile(path.join(lock, 'owner'), 'utf8');
    const p = /^pid=(\d+)$/m.exec(owner), s = /^started=(\d+)$/m.exec(owner);
    if (p) pid = Number(p[1]);
    if (s) started = Number(s[1]) * 1000;
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  // A lock taken by hand has no owner record; its directory time is the best age.
  const source = started ? 'owner' : 'mtime';
  started ??= stat.mtimeMs;
  let alive = null;
  if (pid) { try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; } }
  const ageHours = Math.max(0, (now - started) / 3600000);
  return { held: true, pid, pid_alive: alive, started_at: new Date(started).toISOString(), age_hours: Math.round(ageHours * 10) / 10, source,
    stale: ageHours > STALE_LOCK_HOURS, started_ms: Math.floor(started) };
}

async function recentAlerts(state, limit = 20) {
  try {
    const lines = (await fs.readFile(path.join(state, 'alerts.log'), 'utf8')).split('\n').filter(Boolean).slice(-limit);
    return lines.map(line => { const [at, , kind, ...rest] = line.split(' '); return { at, kind, detail: rest.join(' ') }; });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function writeStatus(state, { lock = null, rc = undefined, now = Date.now() } = {}) {
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(path.join(state, 'status.json'), 'utf8')); } catch { previous = {}; }
  const lockInfo = lock ? await lockState(lock, now) : null;
  let hold = false;
  try { await fs.lstat(path.join(state, HOLD_FILE)); hold = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const status = { version: 1, updated_at: new Date(now).toISOString(), hold,
    last_run: rc === undefined ? previous.last_run ?? null : { rc, finished_at: new Date(now).toISOString() },
    parked: await parkedList(state),
    lock: lockInfo && { ...lockInfo, started_ms: undefined },
    alerts: await recentAlerts(state) };
  await writePrivate(path.join(state, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
  return status;
}

async function executable(file) {
  try { await fs.access(file, constants.X_OK); return true; } catch { return false; }
}
export async function raise(state, kind, detail, message, { notify = null, now = Date.now(), send = null } = {}) {
  const line = `${new Date(now).toISOString()} ALERT ${kind} ${detail}\n`;
  await fs.appendFile(path.join(state, 'alerts.log'), line, { mode: 0o600 });
  console.log(`${new Date(now).toISOString().slice(0, 19).replace('T', ' ')} ALERT ${kind} ${detail}`);
  let delivered = false;
  if (send) delivered = await send(message);
  else if (notify && await executable(notify)) {
    const r = spawnSync(notify, [message], { timeout: 30000, stdio: 'ignore' });
    delivered = !r.error && r.status === 0;
  }
  if (!delivered) console.log(`ALERT ${kind} was logged but not delivered to the owner notifier`);
  return delivered;
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!/^--(state|ticket|count|notify|lock|rc|max-hours)$/.test(key) || rest[i + 1] === undefined || key.slice(2) in options) throw Error(`Unexpected argument ${key}`);
    options[key.slice(2)] = rest[i + 1];
  }
  if (!options.state || !path.isAbsolute(options.state)) throw Error('--state must be an absolute path');
  return { command, options };
}

export async function main(argv = process.argv.slice(2), { now = Date.now(), send = null } = {}) {
  const { command, options } = parse(argv);
  await ensureOwnerDir(options.state);
  const notify = options.notify || null;
  if (command === 'park') {
    if (!UUID.test(options.ticket || '') || !/^\d+$/.test(options.count || '')) throw Error('park needs --ticket UUID and --count N');
    const id8 = options.ticket.slice(0, 8);
    await raise(options.state, 'parked', `ticket=${id8} rejected_runs=${options.count}`,
      `CredentialDOMD ticket agent: ticket ${id8} is parked after ${options.count} rejected runs in a row. It is skipped until its count file under ticket-context/failed is removed; other tickets keep running.`,
      { notify, now, send });
    await writeStatus(options.state, { now });
    return;
  }
  if (command === 'hold') {
    if (!UUID.test(options.ticket || '')) throw Error('hold needs --ticket UUID');
    const id8 = options.ticket.slice(0, 8);
    await raise(options.state, 'host_code_changed', `ticket=${id8}`,
      `CredentialDOMD ticket agent: the run for ticket ${id8} changed the runner's own code (reply checks, runner, notifier, support reply migrations or send-ticket-reply). Nothing was recorded. Every run is held until ticket-context/${HOLD_FILE} is removed after review.`,
      { notify, now, send });
    await writeStatus(options.state, { now });
    return;
  }
  if (command === 'lock') {
    if (!options.lock || !path.isAbsolute(options.lock)) throw Error('lock needs --lock DIR');
    const info = await lockState(options.lock, now);
    const maxHours = options['max-hours'] ? Number(options['max-hours']) : STALE_LOCK_HOURS;
    if (info && info.age_hours > maxHours) {
      // One alert per lock: the marker is keyed by the lock's start time.
      const markers = path.join(options.state, 'alerts');
      await ensureOwnerDir(markers);
      const marker = path.join(markers, `stale-lock-${info.started_ms}`);
      let fresh = true;
      try { await fs.writeFile(marker, '', { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code === 'EEXIST') fresh = false; else throw error; }
      if (fresh) {
        const who = info.pid ? `pid ${info.pid}${info.pid_alive === false ? ', not running' : ''}` : 'no owner record, taken by hand';
        await raise(options.state, 'stale_lock', `age_hours=${info.age_hours} pid=${info.pid ?? 'none'} started=${info.started_at}`,
          `CredentialDOMD ticket agent: the run lock has been held ${info.age_hours} h (${who}). Every scheduled run is skipped until it is released.`,
          { notify, now, send });
      }
    }
    await writeStatus(options.state, { lock: options.lock, now });
    return;
  }
  if (command === 'status') {
    if (!/^-?\d+$/.test(options.rc ?? '')) throw Error('status needs --rc N');
    await writeStatus(options.state, { lock: options.lock ?? null, rc: Number(options.rc), now });
    return;
  }
  throw Error('Usage: alert.mjs park|hold|lock|status --state DIR ...');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(`ERROR: alert: ${error.message}`); process.exitCode = 1; });
}
