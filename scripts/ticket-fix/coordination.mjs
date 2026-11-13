// One coordination record per ticket (owner request, 2026-11-13): who owns
// the next step, why the last run failed, which approaches were already
// rejected, and the validated evidence each retry was allowed on.
//
// Why: parked and stalled tickets used to come back by themselves a day
// later, twice, whatever had changed (reviveParked). cc9830e4 was retried on
// an approach the operator had rejected on 11-09 and 11-12, each run writing
// a failing test that needed supabase/ edits no worker may make; de954247
// kept hitting the billing protections; c39ed1e5's review caught the same
// never-settling Loading screen. The worker never saw any of that: its
// session starts with a fresh config and sees only the case history.
//
// <state>/coordination/<ticket>.json (owner-only, like the case files):
//   owner               worker | operator | eric | device: who takes the
//                       next step. Only the worker owner is queued.
//   owner_history       each change, who made it and why
//   attempts            the newest ATTEMPTS_KEPT runs, as the host saw them
//   last_failure        the newest failed run: its cause, gates, review
//                       reasons, files, protected hits, out-of-scope paths
//   rejected_approaches RA-n: approaches that must not be tried again, with
//                       where the rejection came from (the host's gates or
//                       review, or a person's record)
//   bases               RB-n: each validated retry basis (a reporter
//                       message, a commit on main, an approved plan), with
//                       how it addresses the failure it answers
//   basis_attempts      failed runs since the last accepted basis
//
// Authority: the host writes attempts, last_failure and the host-sourced
// rejections from its own run records (never from model output). Anyone may
// add a restriction (a rejected approach, an escalating route). Back to the
// worker only on a basis the host validates against the database or git AND
// the operator or the owner accepts (TICKET_ACTOR); the supervisor, an
// unattended model session, only proposes. A protected stop takes the
// owner's decision in a plan. Nothing here loosens a gate, an approval, the
// sandbox, the tests, the review or the protected billing and security rules:
// a retried run goes through all of them again.
import { promises as fs, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEditable } from './worktree.mjs';

export const OWNERS = Object.freeze(['worker', 'operator', 'eric', 'device']);
// Who may run a host command that changes the record. Declared by the caller
// (ops-supervisor.sh sets supervisor); see the limitation in the docs.
export const ACTORS = Object.freeze(['operator', 'supervisor', 'owner']);
// Failed runs one basis buys (the shell parks at three in a row too).
export const ATTEMPTS_PER_BASIS = 3;
// Accepted bases per ticket; past them the operator owns it for good.
export const MAX_BASES = 2;
// At most one of those may be a revised plan.
export const MAX_PLANS = 1;
const ATTEMPTS_KEPT = 20;
const REJECTED_KEPT = 30;
const LEDGER_MAX = 64 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RUN_NAME = /^([a-f0-9]{8})-([a-f0-9]{16})$/;
const SHA = /^[0-9a-f]{7,40}$/;
const AGENT_COMMITTER = /^ticket-agent(\+[0-9a-f]{16})?@credentialdomd\.invalid$/;
export const PLAN_FILE = /^([a-f0-9]{8})-[a-z0-9-]{1,40}\.md$/;
const PLAN_MAX = 8 * 1024;

const clip = (value, max) => { const s = String(value ?? ''); return s.length <= max ? s : `${s.slice(0, max - 1)}…`; };
const oneLine = (value, max, what) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\n\r\0]/.test(value)) throw Error(`${what}: one line, at most ${max} characters`);
  return value.trim();
};
function ticketId(value) { if (!UUID.test(value || '')) throw Error('Invalid support ID'); return value; }
export function actor(value) {
  if (!ACTORS.includes(value)) throw Error(`Say who is acting: TICKET_ACTOR=${ACTORS.join('|')}`);
  return value;
}

export const ledgerDir = state => path.join(state, 'coordination');
export const ledgerFile = (state, ticket) => path.join(ledgerDir(state), `${ticketId(ticket)}.json`);
export const planDir = state => path.join(ledgerDir(state), 'plans');
export const emptyLedger = ticket => ({ version: 1, target_id: ticket, owner: 'worker', owner_history: [], attempts: [], last_failure: null,
  rejected_approaches: [], bases: [], basis_attempts: 0 });

function privateFile(file, max) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > max) throw Error('Invalid private coordination file');
}
export async function readLedger(state, ticket) {
  const file = ledgerFile(state, ticket);
  try { privateFile(file, LEDGER_MAX); } catch (error) { if (error.code === 'ENOENT') return emptyLedger(ticket); throw error; }
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  if (record.target_id !== ticket || !OWNERS.includes(record.owner)) throw Error('Coordination record mismatch');
  return { ...emptyLedger(ticket), ...record };
}
export async function writeLedger(state, record) {
  await fs.mkdir(ledgerDir(state), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(record, null, 2);
  if (Buffer.byteLength(text) > LEDGER_MAX) throw Error('Coordination record exceeds its bound');
  const file = ledgerFile(state, record.target_id);
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, file);
  return record;
}
// Every ticket the coordination folder routes away from the worker.
export async function routedTickets(state) {
  let names;
  try { names = await fs.readdir(ledgerDir(state)); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const routed = {};
  for (const name of names) {
    const ticket = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!UUID.test(ticket)) continue;
    const record = await readLedger(state, ticket);
    if (record.owner !== 'worker') routed[ticket] = record.owner;
  }
  if (Object.keys(routed).length > 5000) throw Error('Routed tickets exceed bound; operator review required');
  return routed;
}

// The paths a test imports by a relative specifier, resolved from the repo
// root (only those that stay inside it).
export function relativeImports(file, source) {
  const out = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g;
  for (const m of String(source).matchAll(re)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
    if (!resolved.startsWith('../') && resolved !== '..') out.add(resolved);
  }
  return [...out].sort();
}
const gitShow = (repo, rev, file) => {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'show', `${rev}:${file}`], { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};

// The gates write 'green' or 'failed' per reproduction test (gates/tests.mjs).
const PASSED = new Set(['green', 'passed', 'skipped']);
// Repo-relative paths named in this run's own owner follow-ups that the
// worker may not edit (its "this needs an operator" stop). Only this run's
// result (caseRecord.assessment.follow_up), never older notes.
const PATH_NAMED = /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*[A-Za-z0-9_])/g;
export function ownerFollowUpPaths(caseRecord) {
  const out = new Set();
  for (const f of Array.isArray(caseRecord?.assessment?.follow_up) ? caseRecord.assessment.follow_up : []) {
    if (f?.owner !== 'support_owner') continue;
    for (const m of `${f.work ?? ''} ${f.next_action ?? ''}`.matchAll(PATH_NAMED)) {
      const p = m[1].replace(/^\.\//, '');
      if (p.startsWith('/') || p.includes('..') || /^https?:/.test(p) || !/[./]/.test(p)) continue;
      if (!isEditable(p)) out.add(p);
    }
  }
  return [...out].sort().slice(0, 10);
}

// What the host saw of one finished run: its own run record (run.json) and
// gate record (gates.json), never the model's output (only this run's owner
// follow-ups, which can only route a ticket away from the worker).
//   device    only a phone shows it
//   eric      a change the gates or the review refused touched protected code
//   operator  it needs files the worker may not edit, or the release failed
//   worker    otherwise
// A host recording failure (exit 'record') is the host's: never a route, a
// rejection or a counted attempt.
export function classifyRun({ run = {}, gates = null, exit, repo = null, readSource = null, caseRecord = null }) {
  const status = String(run.status ?? '');
  const hostFailure = String(exit) === 'record';
  const ran = (exit === 0 || exit === '0') && ['merged', 'released', 'no_code', 'held', 'answered', 'replied'].includes(status);
  const review = Array.isArray(run.review?.reasons) ? run.review.reasons : [];
  const missed = [...new Set(review.flatMap(r => [...String(r).matchAll(/missed path ([^\s:;,]+)/g)].map(m => m[1])))].slice(0, 10);
  const diff = gates?.diff ?? {};
  const hits = Array.isArray(run.protected?.hits) ? run.protected.hits : [];
  const violating = Array.isArray(run.violating) ? run.violating.map(String) : [];
  const failingTests = [...new Set((Array.isArray(gates?.green) ? gates.green : []).filter(g => g?.status && !PASSED.has(g.status)).map(g => String(g.file)))];
  const read = readSource ?? (file => (repo && /^[0-9a-f]{40}$/.test(run.head ?? '') ? gitShow(repo, run.head, file) : null));
  const imported = [];
  for (const file of failingTests.slice(0, 10)) {
    const source = read(file);
    if (source) imported.push(...relativeImports(file, source).filter(p => !isEditable(p)));
  }
  // The worker's own stop: a run that finished but left the fix to an
  // operator (its prompt: name the files and stop).
  const stopPaths = hostFailure ? [] : ownerFollowUpPaths(caseRecord);
  const outOfScope = [...new Set([...violating.filter(p => !isEditable(p)), ...imported, ...stopPaths])].sort().slice(0, 20);
  const stopped = ran && stopPaths.length > 0;
  const ok = ran && !stopped;
  const device = String(exit) === '9' || status === 'needs_device';
  const refused = status === 'refused' && !hostFailure;
  const protectedStop = refused && run.protected?.protected === true;
  const route = ok || hostFailure ? 'worker' : device ? 'device' : protectedStop ? 'eric' : outOfScope.length || status === 'release_failed' ? 'operator' : 'worker';
  const cause = ok ? null : stopped ? clip(`the worker stopped: the fix needs ${stopPaths.join(', ')}`, 400)
    : clip(run.reason ?? (hostFailure ? 'the host could not record the result' : `exit ${exit}`), 400);
  return {
    run: run.id ?? null, at: run.finished_at ?? run.started_at ?? null, exit: String(exit), status: (stopped ? 'stopped' : status) || null, ok, cause, refused, host_failure: hostFailure,
    gate_failures: Array.isArray(run.gates_failures) ? run.gates_failures.slice(0, 10) : [],
    review_reasons: review.slice(0, 8).map(r => clip(r, 200)), missed_paths: missed,
    product_files: (Array.isArray(diff.product) ? diff.product : []).slice(0, 20),
    test_files: (Array.isArray(diff.files) ? diff.files.filter(f => String(f).startsWith('tests/')) : []).slice(0, 20),
    failing_tests: failingTests.slice(0, 10),
    protected_hits: hits.slice(0, 10).map(h => ({ path: clip(h.path, 160), rule: clip(h.rule, 40) })),
    out_of_scope: outOfScope, route,
  };
}
// The files the failure itself implicates, which a commit basis must
// change: the reviewer's missed paths and the out-of-scope files. Not the
// files the refused run happened to edit, nor the failing tests (editing a
// test never fixes the bug it shows).
export const relevantPaths = failure => [...new Set([...(failure?.missed_paths ?? []), ...(failure?.out_of_scope ?? [])])].sort();
// A protected stop: the owner decides, through a plan with his decision,
// whoever owns the ticket now (review: rerouting must not escape it).
export const protectedFailure = (record) => {
  const f = record.last_failure;
  if (f?.route === 'eric' || f?.protected_hits?.length) return true;
  const since = record.bases.at(-1)?.at ?? '';
  return record.owner_history.some(h => h.owner === 'eric' && String(h.at) >= since);
};

function nextId(list, prefix) { return `${prefix}-${1 + list.reduce((n, e) => Math.max(n, Number(String(e.id ?? '').split('-')[1]) || 0), 0)}`; }
function setOwner(record, owner, { by, reason, at }) {
  if (!OWNERS.includes(owner)) throw Error(`Owner is one of ${OWNERS.join(', ')}`);
  if (record.owner === owner) return;
  record.owner = owner;
  record.owner_history = [...record.owner_history, { owner, at, by, reason: clip(reason, 300) }].slice(-20);
}
// The approach a refused change took, as the host's gates or review
// rejected it: never to be tried again as it was.
function hostRejection(failure) {
  if (failure.ok || failure.host_failure || !(failure.refused || ['2', '5'].includes(failure.exit)) || (!failure.review_reasons.length && !failure.gate_failures.length && !failure.protected_hits.length && !failure.out_of_scope.length)) return null;
  const changed = failure.product_files.length ? `changed ${failure.product_files.join(', ')}` : failure.test_files.length ? `added tests only (${failure.test_files.join(', ')})` : 'changed nothing that was kept';
  const why = [failure.review_reasons.length ? `review: ${failure.review_reasons.join('; ')}` : '', failure.gate_failures.length ? `gates failed: ${failure.gate_failures.join(', ')}` : '',
    failure.protected_hits.length ? `protected: ${failure.protected_hits.map(h => `${h.path} (${h.rule})`).join(', ')}` : '',
    failure.out_of_scope.length ? `needs files outside the worker's reach: ${failure.out_of_scope.join(', ')}` : ''].filter(Boolean).join('; ');
  return { summary: clip(`Run ${failure.run}: ${changed}; ${why}`, 600), source: failure.review_reasons.length ? 'host_review' : 'host_gates' };
}
const SYNTHETIC = new Set(['stalled', 'parked']);
const PATH_KEYS = ['missed_paths', 'product_files', 'test_files', 'failing_tests', 'out_of_scope'];
const merge = (a, b, n = 20) => [...new Set([...(a ?? []), ...(b ?? [])])].sort().slice(0, n);
function routeAway(record, failure, at) {
  if (record.owner !== 'worker' || failure.route === 'worker') return;
  setOwner(record, failure.route, { by: 'host', at, reason: `run ${failure.run}: ${failure.route === 'device' ? 'needs a device reproduction'
    : failure.route === 'eric' ? `a refused change in protected code (${failure.protected_hits.map(h => h.path).join(', ')}): the owner decides`
    : failure.status === 'release_failed' ? 'the release check failed' : `needs ${failure.out_of_scope.join(', ')}`}` });
}

// Records one run the host finished (ticket-agent.sh, inside the runner's
// own lock, so no other writer runs). Exits that say nothing about the
// ticket (the usage limit, a stop from outside) are never recorded.
export async function recordAttempt(state, ticket, { run, gates = null, exit, repo = null, readSource = null, caseRecord = null, now = Date.now() }) {
  ticketId(ticket);
  if (['8', '143'].includes(String(exit))) return null;
  const record = await readLedger(state, ticket);
  const failure = classifyRun({ run, gates, exit, repo, readSource, caseRecord });
  // One entry per run, whichever step recorded it first (a backfill replays
  // runs the runner already recorded).
  if (failure.run && record.attempts.some(a => a.run === failure.run)) return record;
  const at = new Date(now).toISOString();
  record.attempts = [...record.attempts, { run: failure.run, at: failure.at ?? at, exit: failure.exit, status: failure.status, ok: failure.ok, cause: failure.cause, ...(failure.host_failure ? { host_failure: true } : {}) }]
    .sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-ATTEMPTS_KEPT);
  // A host recording failure is logged, never counted or routed.
  if (failure.host_failure) return writeLedger(state, record);
  if (failure.ok) {
    if (['merged', 'released'].includes(failure.status)) record.basis_attempts = 0;
    return writeLedger(state, record);
  }
  const rejected = hostRejection(failure);
  if (rejected && !record.rejected_approaches.some(r => r.run === failure.run)) {
    record.rejected_approaches = [...record.rejected_approaches, { id: nextId(record.rejected_approaches, 'RA'), at: failure.at ?? at, by: 'host', run: failure.run, ...rejected }]
      .sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-REJECTED_KEPT);
  }
  routeAway(record, failure, at);
  const stored = record.last_failure;
  const newer = Date.parse(failure.at ?? at), storedAt = Date.parse(stored?.at ?? '');
  if (Number.isFinite(storedAt) && Number.isFinite(newer) && newer < storedAt) {
    // An older run (a backfill). It never replaces a newer real failure, but
    // a placeholder stall or park (no run record) takes its cause and files.
    if (SYNTHETIC.has(stored.status) && (!stored.after_at || stored.after_at < failure.at)) {
      for (const k of PATH_KEYS) stored[k] = merge(stored[k], failure[k]);
      stored.protected_hits = [...(stored.protected_hits ?? []), ...failure.protected_hits].slice(0, 10);
      Object.assign(stored, { after: failure.run, after_at: failure.at, after_cause: failure.cause, gate_failures: failure.gate_failures, review_reasons: failure.review_reasons });
      if (stored.route === 'worker') stored.route = failure.route;
    }
    exhausted(record, at);
    return writeLedger(state, record);
  }
  record.last_failure = failure;
  if (failure.status !== 'stopped') record.basis_attempts = (Number.isInteger(record.basis_attempts) ? record.basis_attempts : 0) + 1;
  exhausted(record, at);
  return writeLedger(state, record);
}
// Every basis used and its attempts failed: the operator owns it.
export const countedBases = record => record.bases.filter(b => b.kind !== 'device_confirmed').length;
function exhausted(record, at) {
  if (record.owner === 'worker' && record.basis_attempts >= ATTEMPTS_PER_BASIS && countedBases(record) >= MAX_BASES) {
    setOwner(record, 'operator', { by: 'host', at, reason: `every retry basis (${MAX_BASES}) is used and its ${ATTEMPTS_PER_BASIS} attempts failed` });
  }
}

// A stall: three runs that each ended without finishing the work. When the
// last failure is the run the stall came from (it failed at or after the
// stall's last attempt), that failure stays and is marked stalled, keeping
// its real cause. Otherwise (held replies, items left open) the stall is
// recorded as a failure of its own, under an id of the run shape a basis
// names, keeping the previous failure's files. A park with no failure on
// record (from before 2026-11-13) is recorded the same way; a later
// --backfill fills in its cause and files (recordAttempt).
export async function recordStall(state, ticket, { at, runId = null, status = 'stalled' }) {
  ticketId(ticket);
  const when = Date.parse(at ?? '');
  if (!Number.isFinite(when)) return null;
  const record = await readLedger(state, ticket);
  const stamp = new Date(when).toISOString();
  const last = Date.parse(record.last_failure?.at ?? '');
  if (Number.isFinite(last) && last >= when) {
    if (record.last_failure.stalled) return record;
    record.last_failure.stalled = true;
  } else {
    const id = /^[0-9a-f]{16}$/.test(runId ?? '') ? runId : when.toString(16).padStart(16, '0').slice(-16);
    const run = `${ticket.slice(0, 8)}-${id}`;
    const prior = record.last_failure ?? {};
    record.last_failure = { run, at: stamp, exit: status, status, ok: false, refused: false, host_failure: false,
      cause: status === 'parked' ? 'parked after failed runs (no run record kept)' : 'three attempts ended without finishing every item (stalled)',
      gate_failures: [], review_reasons: [], ...Object.fromEntries(PATH_KEYS.map(k => [k, Array.isArray(prior[k]) ? prior[k] : []])),
      protected_hits: Array.isArray(prior.protected_hits) ? prior.protected_hits : [], route: prior.route ?? 'worker',
      ...(prior.run ? { after: prior.run, after_at: prior.at, after_cause: prior.cause } : {}) };
    if (!record.attempts.some(a => a.run === run)) record.attempts = [...record.attempts, { run, at: stamp, exit: status, status, ok: false, cause: record.last_failure.cause }].slice(-ATTEMPTS_KEPT);
  }
  record.basis_attempts = Math.max(Number.isInteger(record.basis_attempts) ? record.basis_attempts : 0, ATTEMPTS_PER_BASIS);
  exhausted(record, stamp);
  return writeLedger(state, record);
}

// Restrictions: a rejected approach any actor may record.
export async function rejectApproach(state, ticket, { summary, source, by, now = Date.now() }) {
  const record = await readLedger(state, ticketId(ticket));
  const entry = { id: nextId(record.rejected_approaches, 'RA'), at: new Date(now).toISOString(), by: actor(by),
    source: oneLine(source, 160, 'Where the rejection was decided (TICKET_APPROACH_SOURCE)'), summary: oneLine(summary, 400, 'The rejected approach (TICKET_APPROACH)') };
  if (record.rejected_approaches.some(r => r.summary === entry.summary)) throw Error('That approach is already recorded as rejected');
  record.rejected_approaches = [...record.rejected_approaches, entry].slice(-REJECTED_KEPT);
  return writeLedger(state, record);
}
// Routing. Never to the worker (that takes a basis). The supervisor only
// escalates (to the operator or the owner); a protected stop leaves the
// owner only by his own route; only the host routes to a device.
export async function routeTicket(state, ticket, owner, { reason, by, now = Date.now() }) {
  const record = await readLedger(state, ticketId(ticket));
  const who = actor(by);
  if (owner === 'worker') throw Error('A ticket goes back to the worker only on a validated basis: --retry');
  if (!OWNERS.includes(owner)) throw Error(`Owner is one of ${OWNERS.join(', ')}`);
  if (owner === 'device') throw Error('Only the host routes a ticket to a device (a run that needs a device reproduction)');
  if (record.owner === 'eric' && who !== 'owner') throw Error('A protected stop leaves the owner only by his own route');
  if (who === 'supervisor' && record.owner === 'device') throw Error('A device ticket returns with --device-confirmed, by the operator or the owner');
  setOwner(record, owner, { by: who, at: new Date(now).toISOString(), reason: oneLine(reason, 300, 'Why (TICKET_ROUTE_NOTE)') });
  return writeLedger(state, record);
}

const gitOut = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', timeout: 30000 });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim() };
};
// Checks a retry basis against the record, the database and git. Returns
// what is stored with it; throws with the reason it does not count. The
// host's checks are the authority, and only the operator or the owner
// accepts a basis: the supervisor (an unattended model session) proposes
// (retryCase), it never grants a retry on its own note.
//   message     the reporter's, on this ticket, newer than the failure
//               (worker-owned only)
//   commit      on origin/main, newer than the failure, not the agent's own,
//               not a merge or a revert, with a non-whitespace change to a
//               file the failure implicates (relevantPaths); never for a
//               protected stop
//   resolution  an item resolved by a checked confirmation or an applied
//               data fix recorded after the failure (worker-owned only)
//   plan        coordination/plans/<ticket8>-<name>.md: an Approach line,
//               the failed run, every RA-n; for a protected stop, the
//               owner's decision
// Every basis names the failed run it answers (TICKET_RETRY_ADDRESSES).
export async function validateBasis(state, ticket, record, { kind, ref, addresses, by, query = null, repo = null, mainRef = 'origin/main', caseRecord = null }) {
  actor(by);
  const failure = record.last_failure;
  if (!failure) throw Error('No failed run is recorded for this ticket; there is nothing to retry');
  if (countedBases(record) >= MAX_BASES) throw Error(`Both retry bases (${MAX_BASES}) are used; the operator owns this ticket`);
  const runId = String(failure.run ?? '').match(RUN_NAME)?.[2] ?? null;
  const how = oneLine(addresses, 400, 'How this addresses the last failure (TICKET_RETRY_ADDRESSES)');
  if (!runId || !how.includes(runId)) throw Error(`Name the failed run it addresses (${runId ?? 'unknown'}) in TICKET_RETRY_ADDRESSES`);
  if (record.owner === 'device') throw Error('A device ticket returns with --device-confirmed');
  const failedAt = Date.parse(failure.at ?? '');
  if (!Number.isFinite(failedAt)) throw Error('The recorded failure has no time');
  const guarded = protectedFailure(record);
  if (guarded && kind !== 'plan') throw Error('A protected stop needs the owner\'s decision in an approved plan');
  if (kind === 'message' || kind === 'resolution') {
    if (record.owner !== 'worker') throw Error(`Routed to ${record.owner}: a ${kind} alone does not send it back to the worker`);
  }
  if (kind === 'message') {
    if (!UUID.test(ref || '')) throw Error('A message basis names the message id');
    if (!query) throw Error('A message basis is checked against the thread: TICKET_DATABASE_TOKEN is required');
    const { reporterMessageSQL } = await import('../ticket-agent-context.mjs');
    const { isCustomerMessage } = await import('./checklist.mjs');
    const rows = await query(reporterMessageSQL(ticket, ref));
    const m = rows[0];
    if (rows.length !== 1 || !isCustomerMessage(m, { owner_id: m.owner_id, approval: { from_admin: m.from_admin === true } })) throw Error('That message is not one the reporter wrote on this ticket');
    if (!(Date.parse(m.created_at) > failedAt)) throw Error('That message is not newer than the failed run');
    return { message_at: m.created_at };
  }
  if (kind === 'resolution') {
    const r = caseRecord?.resolutions?.[ref];
    if (!/^AC-\d{1,3}$/.test(ref || '') || !r) throw Error('A resolution basis names an item the host recorded as resolved');
    if (!['confirmed', 'data_fix'].includes(r.kind)) throw Error('Only a checked confirmation or an applied data fix is evidence; an owner decision needs a plan');
    if (!(Date.parse(r.at) > failedAt)) throw Error('That resolution is not newer than the failed run');
    return { item: ref, kind: r.kind, ...(r.message_id ? { message_id: r.message_id } : {}), ...(r.evidence ? { evidence: r.evidence } : {}) };
  }
  if (kind === 'commit') {
    if (!repo) throw Error('A commit basis is checked in the repository');
    if (!SHA.test(ref || '')) throw Error('A commit basis names the commit');
    const sha = gitOut(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!sha.ok) throw Error('No such commit');
    if (!gitOut(repo, ['merge-base', '--is-ancestor', sha.out, mainRef]).ok) throw Error(`That commit is not on ${mainRef}`);
    const [email, time, parents = '', subject = ''] = gitOut(repo, ['show', '-s', '--format=%ce%n%ct%n%P%n%s', sha.out]).out.split('\n');
    if (AGENT_COMMITTER.test(email ?? '')) throw Error('A ticket agent\'s own commit is not new evidence');
    if (!(Number(time) * 1000 > failedAt)) throw Error('That commit is not newer than the failed run');
    const parentList = parents.split(' ').filter(Boolean);
    if (parentList.length > 1) throw Error('Name the commit that changed the file, not a merge');
    if (/^Revert\b/.test(subject)) throw Error('A revert is not a fix');
    const relevant = relevantPaths(failure);
    if (!relevant.length) throw Error('The failure implicates no file a commit could change; answer it with a revised plan');
    const base = parentList[0] ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    // Added or changed (not deleted, renames as delete plus add), with a
    // change beyond whitespace.
    const touched = gitOut(repo, ['diff', '--no-renames', '-w', '--ignore-blank-lines', '--numstat', base, sha.out, '--', ...relevant]).out.split('\n').filter(Boolean)
      .map(l => l.split('\t')).filter(([add, , file]) => Number(add) > 0 && relevant.includes(file)).map(([, , file]) => file);
    if (!touched.length) throw Error(`That commit adds no non-whitespace change to the files the failure names (${relevant.join(', ')})`);
    if (failure.out_of_scope.length && !failure.out_of_scope.some(p => touched.includes(p))) throw Error(`The failure needs ${failure.out_of_scope.join(', ')}; that commit changes none of them`);
    return { commit: sha.out, touched };
  }
  if (kind === 'plan') {
    if (record.bases.filter(b => b.kind === 'plan').length >= MAX_PLANS) throw Error('This ticket already used its revised plan; the operator owns it');
    const name = String(ref ?? '');
    if (!PLAN_FILE.test(name) || name.slice(0, 8) !== ticket.slice(0, 8)) throw Error('A plan is a file in coordination/plans named <ticket8>-<name>.md');
    const file = path.join(planDir(state), name);
    privateFile(file, PLAN_MAX);
    const text = readFileSync(file, 'utf8');
    if (!/^Approach:\s*\S/m.test(text)) throw Error('The plan says its approach on an "Approach:" line');
    if (!text.includes(runId)) throw Error(`The plan names the failed run it answers (${runId})`);
    const missing = record.rejected_approaches.filter(r => !new RegExp(`\\b${r.id}\\b`).test(text)).map(r => r.id);
    if (missing.length) throw Error(`The plan says how it differs from each rejected approach; missing ${missing.join(', ')}`);
    if (guarded && !/^Owner decision:\s*\S.{8,}/m.test(text)) throw Error('A protected stop needs the owner\'s decision, with where he gave it, on an "Owner decision:" line');
    return { plan: name, plan_bytes: Buffer.byteLength(text) };
  }
  throw Error('A retry basis is a message, a commit, a resolution or a plan');
}
// Who may accept a validated basis: a person (the operator or the owner),
// or, for a plan on a protected stop, the owner or the operator relaying his
// recorded decision.
export function acceptingActor(by) {
  const who = actor(by);
  if (who === 'supervisor') return false;
  return true;
}

export async function acceptBasis(state, ticket, record, { kind, ref, addresses, by, validated, now = Date.now() }) {
  const at = new Date(now).toISOString();
  const entry = { id: nextId(record.bases, 'RB'), kind, ref: String(ref), at, by, addresses: String(addresses).trim(), failure_run: record.last_failure?.run ?? null, validated };
  record.bases = [...record.bases, entry];
  record.basis_attempts = 0;
  record.proposals = (record.proposals ?? []).filter(p => !(p.kind === kind && p.ref === String(ref)));
  setOwner(record, 'worker', { by, at, reason: `${entry.id}: ${kind} ${String(ref).slice(0, 60)}` });
  await writeLedger(state, record);
  return entry;
}
// The supervisor's proposal: validated now, accepted later by a person.
export async function proposeBasis(state, record, { kind, ref, addresses, by, validated, now = Date.now() }) {
  const entry = { kind, ref: String(ref), at: new Date(now).toISOString(), by, addresses: String(addresses).trim(), failure_run: record.last_failure?.run ?? null, validated };
  record.proposals = [...(record.proposals ?? []).filter(p => !(p.kind === kind && p.ref === entry.ref)), entry].slice(-10);
  await writeLedger(state, record);
  return entry;
}

// What the worker and the reproduction session are shown (bounded): who owns
// it, the last failure (with the real run a stall or park came after), the
// approaches never to repeat, and the basis this retry runs on.
export function coordinationView(record) {
  if (!record || (!record.last_failure && !record.rejected_approaches?.length)) return null;
  const f = record.last_failure;
  return {
    owner: record.owner,
    rule: 'Never repeat a rejected approach. If the only remaining fix needs files outside src/, tests/, public/ and landing/, or changes a protected billing, pricing, consent, legal or sign-in rule, do not attempt it: leave a support_owner follow-up naming those files and stop.',
    last_failure: f ? { run: f.run, at: f.at, cause: f.cause, ...(f.after ? { after: f.after, after_cause: f.after_cause ?? null } : {}), ...(f.stalled ? { stalled: true } : {}),
      gate_failures: f.gate_failures, review_reasons: f.review_reasons, missed_paths: f.missed_paths,
      product_files: f.product_files, failing_tests: f.failing_tests, protected_hits: f.protected_hits, out_of_scope: f.out_of_scope } : null,
    rejected_approaches: (record.rejected_approaches ?? []).slice(-12).map(r => ({ id: r.id, source: r.source, summary: clip(r.summary, 400) })),
    retry_basis: record.bases?.length ? (({ id, kind, addresses, failure_run }) => ({ id, kind, addresses, failure_run }))(record.bases.at(-1)) : null,
    attempts_on_this_basis: record.basis_attempts ?? 0,
  };
}
