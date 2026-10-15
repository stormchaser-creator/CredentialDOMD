// Docker timestamps and host Date timestamps are different clock domains.
// Keep measured clock receipts; never compensate with an assumed time margin.
import { spawnSync } from 'node:child_process';
import { localContainer } from './config.mjs';

const NS_PER_MS = 1000000n;
export const CLOCK_TIMEOUT_MS = 2000;
export function utcInstant(value, digits = 3) {
  if (typeof value !== 'string' || !new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{${digits}}Z$`).test(value)) return false;
  const millis = value.replace(/\.(\d{3})\d*Z$/, '.$1Z');
  return Number.isFinite(Date.parse(millis)) && new Date(millis).toISOString() === millis;
}
export function timestampNs(value) {
  const digits = typeof value === 'string' ? value.match(/\.(\d{3,9})Z$/)?.[1].length : null;
  if (!digits || !utcInstant(value, digits)) throw new Error('Malformed measured clock timestamp.');
  return BigInt(Date.parse(value.replace(/\.(\d{3})\d*Z$/, '.$1Z'))) * NS_PER_MS + BigInt(value.match(/\.(\d+)Z$/)[1].padEnd(9, '0').slice(3));
}
const named = value => typeof value === 'string' && /^supabase_edge_runtime_[a-z][a-z0-9-]{0,95}$/.test(value);
const idValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function clockReceiptBounds(receipt, expectedContainer = localContainer('edge_runtime')) {
  if (!named(expectedContainer) || !receipt || receipt.container !== expectedContainer || !idValid(receipt.containerId)
    || !utcInstant(receipt.hostStartedAt) || !utcInstant(receipt.hostFinishedAt) || !utcInstant(receipt.dockerAt, 9)
    || !/^(0|[1-9][0-9]*)$/.test(receipt.elapsedNs || '') || !/^(0|[1-9][0-9]*)$/.test(receipt.hostSamplingNs || '')) throw new Error('Malformed or foreign Docker clock receipt.');
  const elapsed = BigInt(receipt.elapsedNs), sampling = BigInt(receipt.hostSamplingNs), start = timestampNs(receipt.hostStartedAt), end = timestampNs(receipt.hostFinishedAt);
  // Bracket each Date sample with monotonic readings as well: scheduling
  // during a Date read is measured uncertainty, not an assumed tolerance.
  // Its millisecond resolution never widens the Docker observation window.
  const wall = end - start, difference = wall - elapsed;
  if (wall < 0n || elapsed > BigInt(CLOCK_TIMEOUT_MS) * NS_PER_MS || sampling > elapsed || difference <= -NS_PER_MS - sampling || difference >= NS_PER_MS) {
    throw new Error(`Docker clock read timed out or the host clock changed (wallNs=${wall}; elapsedNs=${elapsed}; differenceNs=${difference}).`);
  }
  const docker = timestampNs(receipt.dockerAt);
  return { lower: docker - end - (NS_PER_MS - 1n), upper: docker - start };
}

export function readEdgeClock({ container = localContainer('edge_runtime'), run = spawnSync,
  now = () => new Date().toISOString(), monotonic = () => process.hrtime.bigint() } = {}) {
  if (!named(container)) throw new Error('Clock reads require the exact local edge container.');
  const options = { encoding: 'utf8', timeout: CLOCK_TIMEOUT_MS, maxBuffer: 4096 };
  const mono = monotonic(), hostStartedAt = now(), startSampleEnd = monotonic();
  const identity = run('docker', ['inspect', '--format', '{{.Name}}\t{{.Id}}\t{{.State.Running}}', container], options);
  const fields = String(identity.stdout || '').trim().split('\t');
  if (identity.status !== 0 || identity.error || fields.length !== 3 || fields[0] !== `/${container}` || !idValid(fields[1]) || fields[2] !== 'true') {
    throw new Error('Cannot identify the exact running edge container for its clock.');
  }
  // Execute by immutable container ID: a same-name replacement cannot be read
  // between inspection and this command.
  const remaining = CLOCK_TIMEOUT_MS - Number(monotonic() - mono) / 1e6;
  if (remaining <= 0) throw new Error('Cannot read the local edge clock within its deadline.');
  const answer = run('docker', ['exec', fields[1], 'date', '-u', '+%Y-%m-%dT%H:%M:%S.%NZ'], { ...options, timeout: Math.max(1, Math.floor(remaining)) });
  const endSampleStart = monotonic(), hostFinishedAt = now(), ended = monotonic();
  const elapsedNs = String(ended - mono), hostSamplingNs = String(startSampleEnd - mono + ended - endSampleStart);
  if (answer.status !== 0 || answer.error) throw new Error('Cannot read the local edge clock within its deadline.');
  const receipt = { container, containerId: fields[1], hostStartedAt, hostFinishedAt, dockerAt: String(answer.stdout || '').trim(), elapsedNs, hostSamplingNs };
  clockReceiptBounds(receipt, container);
  return Object.freeze(receipt);
}

export function dockerClockWindow(before, after, { container = localContainer('edge_runtime'),
  hostStartedAt, hostFinishedAt, maxSpanMs = 86400000 } = {}) {
  const first = clockReceiptBounds(before, container), last = clockReceiptBounds(after, container);
  if (before.containerId !== after.containerId || before.hostFinishedAt > after.hostStartedAt
    || timestampNs(before.dockerAt) > timestampNs(after.dockerAt)
    || Date.parse(after.hostFinishedAt) - Date.parse(before.hostStartedAt) > maxSpanMs
    || first.lower > last.upper || last.lower > first.upper) throw new Error('Docker container or measured clock offset changed across the observation.');
  if (hostStartedAt !== undefined || hostFinishedAt !== undefined) {
    if (!utcInstant(hostStartedAt) || !utcInstant(hostFinishedAt) || hostStartedAt > hostFinishedAt
      || before.hostFinishedAt > hostStartedAt || after.hostStartedAt < hostFinishedAt) throw new Error('Docker clock receipts do not causally bracket the host action.');
  }
  return { since: before.dockerAt, until: after.dockerAt, container, containerId: before.containerId };
}

export function withinDockerWindow(at, window) {
  return timestampNs(at) >= timestampNs(window.since) && timestampNs(at) <= timestampNs(window.until);
}
