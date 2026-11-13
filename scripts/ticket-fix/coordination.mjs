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
// rejections from its own run records (never from model output). A model's
// note can add a restriction (a rejected approach, a route away from the
// worker) but never grants a retry: a basis is accepted only when the host
// validates it against the database or git, and a plan only from the
// operator or the owner (TICKET_ACTOR). Routing to the worker happens only
// through an accepted basis. Nothing here loosens a gate, an approval, the
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
  if (Object.keys(routed).length > 500) throw Error('Routed tickets exceed bound; operator review required');
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

// What the host saw of one finished run: its own run record (run.json) and
// gate record (gates.json), never the model's output. route says who can
// take the next step: device (only a phone shows it), eric (the protected
// billing or security rules stopped it), operator (it needs files the worker
// may not edit), else worker.
export function classifyRun({ run = {}, gates = null, exit, repo = null, readSource = null }) {
  const status = String(run.status ?? '');
  const ok = (exit === 0 || exit === '0') && ['merged', 'released', 'no_code', 'held', 'answered', 'replied'].includes(status);
  const review = Array.isArray(run.review?.reasons) ? run.review.reasons : [];
  const missed = [...new Set(review.flatMap(r => [...String(r).matchAll(/missed path ([^\s:;,]+)/g)].map(m => m[1])))].slice(0, 10);
  const diff = gates?.diff ?? {};
  const hits = Array.isArray(run.protected?.hits) ? run.protected.hits : [];
  const violating = Array.isArray(run.violating) ? run.violating.map(String) : [];
  // A failing new test that imports code outside the editable set (11-12:
  // cc9830e4's tests imported supabase/functions/_shared, which only an
  // operator can change and deploy).
  const failingTests = [...new Set((Array.isArray(gates?.green) ? gates.green : []).filter(g => g?.status && g.status !== 'passed').map(g => String(g.file)))];
  const read = readSource ?? (file => (repo && /^[0-9a-f]{40}$/.test(run.head ?? '') ? gitShow(repo, run.head, file) : null));
  const imported = [];
  for (const file of failingTests.slice(0, 10)) {
    const source = read(file);
    if (source) imported.push(...relativeImports(file, source).filter(p => !isEditable(p)));
  }
  const outOfScope = [...new Set([...violating.filter(p => !isEditable(p)), ...imported])].sort().slice(0, 20);
  const device = String(exit) === '9' || status === 'needs_device';
  const protectedStop = run.protected?.protected === true && !ok;
  const route = ok ? 'worker' : device ? 'device' : protectedStop ? 'eric' : outOfScope.length || status === 'release_failed' ? 'operator' : 'worker';
  const cause = ok ? null : clip(run.reason ?? (String(exit) === 'record' ? 'the host could not record the result' : `exit ${exit}`), 400);
  return {
    run: run.id ?? null, at: run.finished_at ?? run.started_at ?? null, exit: String(exit), status: status || null, ok, cause,
    gate_failures: Array.isArray(run.gates_failures) ? run.gates_failures.slice(0, 10) : [],
    review_reasons: review.slice(0, 8).map(r => clip(r, 200)), missed_paths: missed,
    product_files: (Array.isArray(diff.product) ? diff.product : []).slice(0, 20),
    test_files: (Array.isArray(diff.files) ? diff.files.filter(f => String(f).startsWith('tests/')) : []).slice(0, 20),
    failing_tests: failingTests.slice(0, 10),
    protected_hits: hits.slice(0, 10).map(h => ({ path: clip(h.path, 160), rule: clip(h.rule, 40) })),
    out_of_scope: outOfScope, route,
  };
}
// The files a basis must touch to count as addressing a failure.
export const relevantPaths = failure => [...new Set([...(failure?.product_files ?? []), ...(failure?.missed_paths ?? []), ...(failure?.out_of_scope ?? []),
  ...(failure?.failing_tests ?? []), ...(failure?.protected_hits ?? []).map(h => h.path)])].sort();

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
  if (failure.ok || (!failure.review_reasons.length && !failure.gate_failures.length && !failure.protected_hits.length && !failure.out_of_scope.length)) return null;
  const changed = failure.product_files.length ? `changed ${failure.product_files.join(', ')}` : failure.test_files.length ? `added tests only (${failure.test_files.join(', ')})` : 'changed nothing that was kept';
  const why = [failure.review_reasons.length ? `review: ${failure.review_reasons.join('; ')}` : '', failure.gate_failures.length ? `gates failed: ${failure.gate_failures.join(', ')}` : '',
    failure.protected_hits.length ? `protected: ${failure.protected_hits.map(h => `${h.path} (${h.rule})`).join(', ')}` : '',
    failure.out_of_scope.length ? `needs files outside the worker's reach: ${failure.out_of_scope.join(', ')}` : ''].filter(Boolean).join('; ');
  return { summary: clip(`Run ${failure.run}: ${changed}; ${why}`, 600), source: failure.review_reasons.length ? 'host_review' : 'host_gates' };
}

// Records one run the host finished (ticket-agent.sh, inside the runner's
// own lock, so no other writer runs). Exits that say nothing about the
// ticket (the usage limit, a stop from outside, another target's time) are
// never recorded.
export async function recordAttempt(state, ticket, { run, gates = null, exit, repo = null, readSource = null, now = Date.now() }) {
  ticketId(ticket);
  if (['8', '143'].includes(String(exit))) return null;
  const record = await readLedger(state, ticket);
  const failure = classifyRun({ run, gates, exit, repo, readSource });
  if (failure.run && record.attempts.some(a => a.run === failure.run && a.exit === failure.exit)) return record;
  const at = new Date(now).toISOString();
  record.attempts = [...record.attempts, { run: failure.run, at: failure.at ?? at, exit: failure.exit, status: failure.status, ok: failure.ok, cause: failure.cause }].slice(-ATTEMPTS_KEPT);
  if (failure.ok) return writeLedger(state, record);
  record.last_failure = failure;
  record.basis_attempts = (Number.isInteger(record.basis_attempts) ? record.basis_attempts : 0) + 1;
  const rejected = hostRejection(failure);
  if (rejected && !record.rejected_approaches.some(r => r.run === failure.run)) {
    record.rejected_approaches = [...record.rejected_approaches, { id: nextId(record.rejected_approaches, 'RA'), at: failure.at ?? at, by: 'host', run: failure.run, ...rejected }].slice(-REJECTED_KEPT);
  }
  // The host only ever routes away from the worker; back to it takes a basis.
  if (record.owner === 'worker' && failure.route !== 'worker') {
    setOwner(record, failure.route, { by: 'host', at, reason: `run ${failure.run}: ${failure.route === 'device' ? 'needs a device reproduction'
      : failure.route === 'eric' ? `a refused change in protected code (${failure.protected_hits.map(h => h.path).join(', ')}): the owner decides` : `needs ${failure.out_of_scope.join(', ')}`}` });
  }
  if (record.owner === 'worker' && record.basis_attempts >= ATTEMPTS_PER_BASIS && record.bases.length >= MAX_BASES) {
    setOwner(record, 'operator', { by: 'host', at, reason: `every retry basis (${MAX_BASES}) is used and its ${ATTEMPTS_PER_BASIS} attempts failed` });
  }
  return writeLedger(state, record);
}

// A stall is a failure too: three runs that each finished without finishing
// the work (a held reply, items left open) record no failed run, yet a
// retry must answer something. The queue records it once per stall (at: the
// last attempt), under an id of the run shape that a basis names.
export async function recordStall(state, ticket, { at, runId = null }) {
  ticketId(ticket);
  const when = Date.parse(at ?? '');
  if (!Number.isFinite(when)) return null;
  const record = await readLedger(state, ticket);
  const last = Date.parse(record.last_failure?.at ?? '');
  if (Number.isFinite(last) && last >= when) return record;
  const id = /^[0-9a-f]{16}$/.test(runId ?? '') ? runId : when.toString(16).padStart(16, '0').slice(-16);
  const run = `${ticket.slice(0, 8)}-${id}`;
  record.last_failure = { run, at: new Date(when).toISOString(), exit: 'stalled', status: 'stalled', ok: false,
    cause: 'three attempts ended without finishing every item (stalled)', gate_failures: [], review_reasons: [], missed_paths: [], product_files: [],
    test_files: [], failing_tests: [], protected_hits: [], out_of_scope: [], route: 'worker' };
  record.attempts = [...record.attempts, { run, at: record.last_failure.at, exit: 'stalled', status: 'stalled', ok: false, cause: record.last_failure.cause }].slice(-ATTEMPTS_KEPT);
  return writeLedger(state, record);
}

// A rejection or a route away from the worker: restrictions any actor may
// record (a model's note can never widen what a run may do).
export async function rejectApproach(state, ticket, { summary, source, by, now = Date.now() }) {
  const record = await readLedger(state, ticketId(ticket));
  const entry = { id: nextId(record.rejected_approaches, 'RA'), at: new Date(now).toISOString(), by: actor(by),
    source: oneLine(source, 160, 'Where the rejection was decided (TICKET_APPROACH_SOURCE)'), summary: oneLine(summary, 400, 'The rejected approach (TICKET_APPROACH)') };
  if (record.rejected_approaches.some(r => r.summary === entry.summary)) throw Error('That approach is already recorded as rejected');
  record.rejected_approaches = [...record.rejected_approaches, entry].slice(-REJECTED_KEPT);
  return writeLedger(state, record);
}
export async function routeTicket(state, ticket, owner, { reason, by, now = Date.now() }) {
  const record = await readLedger(state, ticketId(ticket));
  if (owner === 'worker') throw Error('A ticket goes back to the worker only on a validated basis: --retry');
  if (!OWNERS.includes(owner)) throw Error(`Owner is one of ${OWNERS.join(', ')}`);
  setOwner(record, owner, { by: actor(by), at: new Date(now).toISOString(), reason: oneLine(reason, 300, 'Why (TICKET_ROUTE_NOTE)') });
  return writeLedger(state, record);
}

const gitOut = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', timeout: 30000 });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim() };
};
// Checks a proposed retry basis against the record, the database and git.
// Returns what is stored with it. Throws with the reason it does not count.
//   message  a reporter's message on this ticket, newer than the failure
//   commit   a commit on origin/main, newer than the failure, not the
//            ticket agent's own, touching a file the failure names
//   plan     an approved revised plan (operator or owner only) naming the
//            failure and every rejected approach
// Every basis says in one line how it addresses the failure, naming that
// failure's run id; a message or a commit by itself never qualifies.
export async function validateBasis(state, ticket, record, { kind, ref, addresses, by, query = null, repo = null, mainRef = 'origin/main' }) {
  const who = actor(by);
  const failure = record.last_failure;
  if (!failure) throw Error('No failed run is recorded for this ticket; there is nothing to retry');
  if (record.bases.length >= MAX_BASES) throw Error(`Both retry bases (${MAX_BASES}) are used; the operator owns this ticket`);
  const runId = String(failure.run ?? '').match(RUN_NAME)?.[2] ?? null;
  const how = oneLine(addresses, 400, 'How this addresses the last failure (TICKET_RETRY_ADDRESSES)');
  if (!runId || !how.includes(runId)) throw Error(`Name the failed run it addresses (${runId ?? 'unknown'}) in TICKET_RETRY_ADDRESSES`);
  if (record.owner === 'device') throw Error('A device check is recorded with --resolve-item … confirmed, not retried');
  const failedAt = Date.parse(failure.at ?? '');
  if (!Number.isFinite(failedAt)) throw Error('The recorded failure has no time');
  if (kind === 'message') {
    if (record.owner !== 'worker') throw Error(`Routed to ${record.owner}: a message alone does not send it back to the worker`);
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
  if (kind === 'commit') {
    if (record.owner === 'eric') throw Error('A protected billing or security stop needs the owner\'s decision in an approved plan, not a commit');
    if (!repo) throw Error('A commit basis is checked in the repository');
    if (!SHA.test(ref || '')) throw Error('A commit basis names the commit');
    const sha = gitOut(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!sha.ok) throw Error('No such commit');
    if (!gitOut(repo, ['merge-base', '--is-ancestor', sha.out, mainRef]).ok) throw Error(`That commit is not on ${mainRef}`);
    const [email, time] = gitOut(repo, ['show', '-s', '--format=%ce%n%ct', sha.out]).out.split('\n');
    if (AGENT_COMMITTER.test(email ?? '')) throw Error('A ticket agent\'s own commit is not new evidence');
    if (!(Number(time) * 1000 > failedAt)) throw Error('That commit is not newer than the failed run');
    const files = gitOut(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', sha.out]).out.split('\n').filter(Boolean);
    const relevant = relevantPaths(failure);
    const touched = files.filter(f => relevant.includes(f));
    if (!touched.length) throw Error(`That commit touches none of the files the failure names (${relevant.join(', ') || 'none recorded'})`);
    if (failure.out_of_scope.length && !failure.out_of_scope.some(p => files.includes(p))) throw Error(`The failure needs ${failure.out_of_scope.join(', ')}; that commit changes none of them`);
    return { commit: sha.out, touched };
  }
  if (kind === 'plan') {
    if (who === 'supervisor') throw Error('A revised plan is approved by the operator or the owner, not the supervisor');
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
    if (record.owner === 'eric' && !/^Owner decision:\s*\S.{8,}/m.test(text)) throw Error('A protected stop needs the owner\'s decision, with where he gave it, on an "Owner decision:" line');
    return { plan: name, plan_bytes: Buffer.byteLength(text) };
  }
  throw Error('A retry basis is a message, a commit or a plan');
}

export async function acceptBasis(state, ticket, record, { kind, ref, addresses, by, validated, now = Date.now() }) {
  const at = new Date(now).toISOString();
  const entry = { id: nextId(record.bases, 'RB'), kind, ref: String(ref), at, by, addresses: addresses.trim(), failure_run: record.last_failure.run, validated };
  record.bases = [...record.bases, entry];
  record.basis_attempts = 0;
  setOwner(record, 'worker', { by, at, reason: `${entry.id}: ${kind} ${String(ref).slice(0, 60)}` });
  await writeLedger(state, record);
  return entry;
}

// What the worker and the reproduction session are shown (bounded): who owns
// it, the last failure, the approaches never to repeat, and the basis this
// retry runs on.
export function coordinationView(record) {
  if (!record || (!record.last_failure && !record.rejected_approaches?.length)) return null;
  const f = record.last_failure;
  return {
    owner: record.owner,
    rule: 'Never repeat a rejected approach. If the only remaining fix needs files outside src/, tests/, public/ and landing/, or changes a protected billing, pricing, consent, legal or sign-in rule, do not attempt it: leave a support_owner follow-up naming those files and stop.',
    last_failure: f ? { run: f.run, at: f.at, cause: f.cause, gate_failures: f.gate_failures, review_reasons: f.review_reasons, missed_paths: f.missed_paths,
      product_files: f.product_files, failing_tests: f.failing_tests, protected_hits: f.protected_hits, out_of_scope: f.out_of_scope } : null,
    rejected_approaches: (record.rejected_approaches ?? []).slice(-12).map(r => ({ id: r.id, source: r.source, summary: clip(r.summary, 400) })),
    retry_basis: record.bases?.length ? (({ id, kind, addresses, failure_run }) => ({ id, kind, addresses, failure_run }))(record.bases.at(-1)) : null,
    attempts_on_this_basis: record.basis_attempts ?? 0,
  };
}
