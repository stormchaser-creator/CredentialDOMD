// Ports, child processes and readiness waits for qa:lab.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LAB_LOG_DIR } from './paths.mjs';

/** True when nothing listens on 127.0.0.1:port. */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** The first free port at or above `start` (skipping any in `avoid`). */
export async function freePort(start, { avoid = [], tries = 200 } = {}) {
  for (let p = start; p < start + tries; p++) {
    if (avoid.includes(p)) continue;
    if (await portIsFree(p)) return p;
  }
  throw new Error(`no free port in ${start}-${start + tries - 1}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls fn() until it returns a truthy value; throws with `what` after timeoutMs. */
export async function waitFor(what, fn, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await sleep(intervalMs);
  }
}

/**
 * Starts a long-running child whose output goes to .generated/logs/<name>.log
 * and, prefixed, to this terminal (unless quiet).
 */
export function startChild(name, command, args, { env = process.env, cwd, quiet = false, onLine } = {}) {
  mkdirSync(LAB_LOG_DIR, { recursive: true });
  const logFile = path.join(LAB_LOG_DIR, `${name}.log`);
  const log = createWriteStream(logFile, { flags: 'a' });
  log.write(`\n--- ${new Date().toISOString()} ${command} ${args.join(' ')}\n`);
  const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  let buffer = '';
  const onData = (chunk) => {
    log.write(chunk);
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      onLine?.(line);
      if (!quiet && line.trim()) process.stdout.write(`[${name}] ${line}\n`);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code, signal) => log.write(`--- exited ${code ?? signal}\n`));
  child.logFile = logFile;
  return child;
}

/** Sends SIGTERM, then SIGKILL after graceMs. */
export function stopChild(child, graceMs = 8000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}

/**
 * The mock and app ports: the ones saved last time when they are free (the
 * functions' environment names the mock's port, and changing it restarts the
 * stack), otherwise the next free ports from the defaults. Saved again.
 */
export async function resolveLabPorts({ mockPort: wantMock, appPort: wantApp, defaults, file } = {}) {
  let saved = {};
  try { if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8')); } catch { saved = {}; }
  const mockPort = await freePort(Number(wantMock || saved.mockPort || defaults.mock));
  const appPort = await freePort(Number(wantApp || saved.appPort || defaults.app), { avoid: [mockPort] });
  if (saved.mockPort !== mockPort || saved.appPort !== appPort) writeFileSync(file, JSON.stringify({ mockPort, appPort }, null, 2) + '\n');
  return { mockPort, appPort };
}
