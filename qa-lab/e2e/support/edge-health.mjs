import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { edgeErrorObservations, edgeRequestClaim, edgeRequestLogWindow, edgeRequestObservation } from '../../lib/edge-health-claims.mjs';
import { readEdgeClock } from '../../lib/edge-clock.mjs';

export function readErrors(since, until, remainingMs = 2000, containerId) {
  if (!/^[a-f0-9]{64}$/.test(containerId || '')) throw new Error('Raw log read requires the measured container identity.');
  const logs = spawnSync('docker', ['logs', '--timestamps', '--since', since, '--until', until, containerId], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: Math.max(1, Math.min(2000, Math.floor(remainingMs))),
  });
  if (logs.status !== 0 || logs.error) throw new Error('Cannot verify the negative request: raw Docker logs are unavailable.');
  return edgeErrorObservations(`${logs.stdout}\n${logs.stderr}`);
}

/** Execute one deliberate request, retaining its HTTP evidence even when proof fails. */
export async function observeIntentionalEdgeRequest(kind, reason, action, {
  now = () => new Date().toISOString(), clock = readEdgeClock, read = readErrors,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), monotonic = () => performance.now(), timeoutMs = 2000,
  recordRequest = () => {},
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid bounded edge log wait.');
  const before = clock();
  const startedAt = now();
  const response = await action();
  const browserResponse = typeof response?.status === 'function';
  const url = browserResponse ? response.url() : response?.url;
  const method = browserResponse ? response.request().method() : response?.method;
  const status = browserResponse ? response.status() : response?.status;
  let responseText;
  try { responseText = browserResponse ? await response.text() : response?.text; }
  catch (error) {
    recordRequest({ id: randomUUID(), startedAt, finishedAt: now(), url, method, status, clock: { before, after: null }, captureProblem: 'Actual response body could not be read.' });
    throw error;
  }
  const observed = { startedAt, finishedAt: now(), url, method, status, responseText, clock: { before, after: null } };
  let request;
  try { request = edgeRequestObservation(observed); }
  catch (error) {
    // A surprising status or malformed receipt is diagnostic evidence, never
    // an allowance. Final reconciliation rejects this incomplete observation.
    recordRequest({ id: randomUUID(), ...observed, captureProblem: error.message });
    throw error;
  }
  try { request.clock.after = clock(); }
  finally { recordRequest(structuredClone(request)); }
  const window = edgeRequestLogWindow(request), deadline = monotonic() + timeoutMs;
  // Identical fixed Docker bounds on every read. Never repeat the HTTP action,
  // extend the window, or select one candidate out of an ambiguous collection.
  let reads = 0;
  while (true) {
    reads++;
    try {
      const claim = edgeRequestClaim(read(window.since, window.until, Math.max(1, deadline - monotonic()), request.clock.before.containerId), request, { kind, reason });
      return { response, request, claim, reads };
    } catch (error) {
      if (error.code !== 'EDGE_OBSERVATION_ABSENT' || monotonic() >= deadline || reads >= 25) throw error;
      await pause(Math.min(100, Math.max(1, deadline - monotonic())));
    }
  }
}
