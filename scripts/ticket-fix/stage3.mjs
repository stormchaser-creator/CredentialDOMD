// Stage 3 host steps for run.mjs: what binds a test to a checklist item, the
// host's check of every claim in the agent's reply, the work the host itself
// knows is left, and the record the reply step (ticket-agent-context.mjs
// --record-and-reply) renders the customer's reply from.
//
// A test binds an item only when the host produced the binding (stage 3
// review): a reproduction test the host recorded failing on base this run, a
// declared test of a change the host committed and whose gates ran it green at
// head, or a test a released, release-verified run bound to an item its
// reviewer found met. A worker's declared test with no change behind it binds
// nothing: an existing passing test would otherwise "pin" any item.
//
// A claim is shown to the customer only when the host verified it here:
//   test  the test is bound to the claim's item, and it passed in this run's
//         gates at the head that was released and verified (G7), or (a test a
//         released run bound) the host ran it at the base, and the live build
//         contains that base. A claim about the customer's own stored records,
//         or that something is absent, is never confirmed by a test.
//   file  the quoted text is at the cited line in the live build (claims.mjs)
// A claim that names a phone, tablet, browser or mail client is never
// verified: nothing here runs there (c0aa1d32).
import { promises as fs, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { gitRunner, readLiveBuild, fetchLiveBuild } from './reply.mjs';
import { verifyClaim, parseClaimEvidence, namesDevice, testCannotConfirm } from './claims.mjs';
import { itemFollowUpWork, heldFollowUpWork } from './checklist.mjs';
import { gateWorktree } from './worktree.mjs';
import { runTestFile, greenVerdict, TEST_FILE } from './gates/tests.mjs';
import { RUN_NAME } from './merge.mjs';

const testId = t => `${t.file}::${t.name}`;
const splitTest = id => { const i = id.indexOf('::'); return { file: id.slice(0, i), name: id.slice(i + 2) }; };

// Tests the worker may cite for items (its reply is checked against these
// before the gates run): the reproduction recorded failing on base and the
// declared tests it names, each with the ac_id it names. Which of them binds
// anything is hostBindings' decision.
export function runBindings({ repro = null, declared = [], items = [] }) {
  const ids = new Set(items.map(i => i.id));
  const out = {};
  const add = (ac, id) => { if (ids.has(ac)) (out[ac] ??= []).includes(id) || out[ac].push(id); };
  for (const t of repro?.tests ?? []) if (t.on_base === 'red' && t.ac_id) add(t.ac_id, testId(t));
  for (const t of declared) if (t?.ac_id && typeof t.file === 'string' && typeof t.name === 'string') add(t.ac_id, testId(t));
  return out;
}
// The tests this run bound, as the host trusts them: the reproduction
// recorded failing on base, and the declared tests of the committed change
// (declared: the step's, with ac_id) that gates.json lists as valid, in the
// diff and green at head. No gates (no commit, or none run): no declared test.
export function hostBindings({ repro = null, declared = [], gates = null, items = [] }) {
  const green = new Set((gates?.green ?? []).filter(t => t.status === 'green').map(testId));
  const listed = new Set((gates?.declared ?? []).filter(t => t.valid && t.in_diff).map(testId));
  return runBindings({ repro, items, declared: gates ? declared.filter(t => typeof t?.file === 'string' && typeof t?.name === 'string' && listed.has(testId(t)) && green.has(testId(t))) : [] });
}
// Tests a released run of this ticket bound to items its reviewer found met.
export function priorBindings(work, ticket) {
  const out = {};
  let names = [];
  try { names = readdirSync(path.join(work, 'runs')); } catch { return out; }
  for (const name of names.filter(n => RUN_NAME.test(n) && n.startsWith(ticket.slice(0, 8)))) {
    try {
      const run = JSON.parse(readFileSync(path.join(work, 'runs', name, 'run.json'), 'utf8'));
      if (run.ticket !== ticket || run.status !== 'released' || !run.release?.verified) continue;
      for (const [ac, tests] of Object.entries(run.bindings_met ?? {})) for (const t of tests) (out[ac] ??= []).includes(t) || out[ac].push(t);
    } catch { /* an unreadable record binds nothing */ }
  }
  return out;
}
export function mergeBindings(...maps) {
  const out = {};
  for (const map of maps) for (const [ac, tests] of Object.entries(map ?? {})) for (const t of tests) (out[ac] ??= []).includes(t) || out[ac].push(t);
  return out;
}

// The host's verdict on each claim in the worker's reply.
//   code: { released: bool (G7 verified), green: Set(test ids green at head) }
//   bindings: {ac: [test ids]} this run bound, as the host trusts them
//             (hostBindings); prior: {ac: [test ids]} released runs bound
//   runAtBase(files) -> Map(file -> run) runs test files at base (sandboxed)
export async function verifyAgentClaims({ claims = [], repo, base, code = {}, bindings = {}, prior = {}, fetchBuild = fetchLiveBuild, runAtBase, binary = 'git' }) {
  const git = gitRunner(repo, { binary });
  const live = await readLiveBuild(git, fetchBuild);
  const baseLive = Boolean(live.commit && git.isAncestor(base, live.commit));
  const parsed = claims.map((c, index) => ({ index, ac_id: c.ac_id, text: c.text, ...parseClaimEvidence(c.evidence, `claims[${index}]`) }));
  const own = (ac, id) => (bindings[ac] ?? []).includes(id);
  const earlier = (ac, id) => (prior[ac] ?? []).includes(id);
  const thisChange = p => code.released && code.green?.has(p.evidence.ref) && own(p.ac_id, p.evidence.ref);
  // Only a test a released run bound to the claim's item is run at the base.
  const baseFiles = [...new Set(parsed.filter(p => p.evidence?.kind === 'test' && !thisChange(p) && earlier(p.ac_id, p.evidence.ref) && !testCannotConfirm(p.text))
    .map(p => splitTest(p.evidence.ref).file).filter(f => TEST_FILE.test(f)))];
  let runs = new Map();
  if (baseFiles.length && baseLive && runAtBase) {
    try { runs = await runAtBase(baseFiles); } catch { runs = new Map(); }
  }
  return parsed.map(p => {
    const verdict = { index: p.index, ac_id: p.ac_id, verified: false, kind: p.evidence?.kind ?? null, reason: '' };
    if (!p.evidence || p.problems.length) return { ...verdict, reason: 'no usable evidence' };
    if (namesDevice(p.text)) return { ...verdict, reason: 'a result on a device is never confirmed here: not tested on that device' };
    if (p.evidence.kind === 'file') {
      const r = verifyClaim({ text: p.text, evidence: p.evidence }, { live, fileAtLive: file => (live.commit ? git.fileAt(live.commit, file) : null) });
      return { ...verdict, verified: r.verified, reason: r.reason };
    }
    const id = p.evidence.ref;
    verdict.test = id;
    const cannot = testCannotConfirm(p.text);
    if (cannot) return { ...verdict, reason: cannot };
    if (thisChange(p)) return { ...verdict, verified: true, source: 'this_change', reason: 'passed in this run\'s gates at the released head' };
    if (!earlier(p.ac_id, id)) return { ...verdict, reason: own(p.ac_id, id) ? 'this run\'s test for the item, and this run\'s change is not released and verified' : 'test not bound to this item' };
    const { file, name } = splitTest(id);
    if (!TEST_FILE.test(file)) return { ...verdict, reason: 'not a repository test file' };
    if (!baseLive) return { ...verdict, reason: `not live yet: ${live.error || 'the live build does not contain the base'}` };
    const run = runs.get(file);
    if (!run) return { ...verdict, reason: 'the host could not run the test at the base' };
    const status = greenVerdict(run, { file, name });
    return status === 'green' ? { ...verdict, verified: true, source: 'base', reason: `a released run's test for the item, passed at ${base.slice(0, 12)}, which the live build contains` }
      : { ...verdict, reason: `the test ${status.replace(/_/g, ' ')} at the base` };
  });
}
// Runs test files at a commit in a fresh gate worktree under the gates
// sandbox (no network, no credential).
export function baseTestRunner({ repo, work, commit, modules = null, env, sandbox = null, binary = 'git' }) {
  return async files => {
    const gate = await gateWorktree({ repo, work, commit, modules, binary, label: 'claims' });
    try {
      const out = new Map();
      for (const file of files) if (existsSync(path.join(gate.dir, file))) out.set(file, await runTestFile({ dir: gate.dir, tmp: gate.tmp, file, env, sandbox }));
      return out;
    } finally { await gate.remove(); }
  };
}

// Items an observation supports, when the reviewer or confirmer disputed it
// or never judged it.
export function disputedItems(observations = [], verdicts = {}) {
  const out = new Set();
  for (const o of observations) if (verdicts[o.attachment] !== 'agree') for (const id of o.supports ?? []) out.add(id);
  return out;
}
// Work the host knows is left, whatever the worker's summary says (design
// G1: every item that is not done has its own follow-up).
//   attachments  the model view; unavailable ones are retried, unsupported
//                ones (a Word, Excel, CSV or text file: the runner opens
//                images and PDFs only) go to the owner once, never retried
//   finals       the host's decision per item
//   waiting      the worker asked the customer a question, or recorded work
//                for the owner: the items it left open wait on that answer
//                (the case is waiting_customer or waiting_owner, never
//                complete), not on another model run
//   items        the checklist: a device probe waits on the customer's check
export function hostFollowUps({ attachments = [], finals = [], waiting = false, items = [] }) {
  const out = [];
  const probe = new Set(items.filter(i => i.kind === 'device_probe').map(i => i.id));
  for (const a of attachments.filter(x => x.target && x.access === 'unavailable')) {
    out.push({ work: `Retrieve and review attachment ${a.attachment} (${a.storage_path})`, owner: 'support_worker', next_action: `The host could not deliver it (${String(a.reason ?? 'unknown').slice(0, 120)}); the next run downloads it again` });
  }
  for (const a of attachments.filter(x => x.target && x.access === 'unsupported')) {
    out.push({ work: `Open attachment ${a.attachment} (${a.storage_path}) yourself`, owner: 'support_owner', next_action: 'The runner opens images and PDFs only, so no session has seen this file; read it and add what matters to the ticket' });
  }
  for (const f of finals) {
    if (f.state === 'in_progress') out.push({ work: heldFollowUpWork(f.id), owner: 'support_worker', next_action: `After the owner merges the held run, cite ${f.id}'s test on the live build` });
    else if (f.detail === 'new') out.push({ work: `Work on ${f.id}, added to the checklist after this run's worker`, owner: 'support_worker', next_action: `The next run takes ${f.id} up` });
    else if (['not_done', 'partial'].includes(f.state) && !waiting && !probe.has(f.id)) out.push({ work: itemFollowUpWork(f.id), owner: 'support_worker', next_action: `The next run works on ${f.id} until the host can decide it done` });
  }
  return out;
}

export async function writeStage3(file, record) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
  return file;
}
