// Stage 3 host steps for run.mjs: what binds a test to a checklist item, the
// host's check of every claim in the agent's reply, the work the host itself
// knows is left, and the record the reply step (ticket-agent-context.mjs
// --record-and-reply) renders the customer's reply from.
//
// A claim is shown to the customer only when the host verified it here:
//   test  the test passed in this run's gates at the head that was released
//         and verified (G7), or the host ran it at the base, and the live
//         build contains that base
//   file  the quoted text is at the cited line in the live build (claims.mjs)
// A claim that names a phone, tablet, browser or mail client is never
// verified: nothing here runs there (c0aa1d32).
import { promises as fs, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { gitRunner, readLiveBuild, fetchLiveBuild } from './reply.mjs';
import { verifyClaim, parseClaimEvidence, namesDevice } from './claims.mjs';
import { gateWorktree } from './worktree.mjs';
import { runTestFile, greenVerdict, TEST_FILE } from './gates/tests.mjs';
import { RUN_NAME } from './merge.mjs';

const testId = t => `${t.file}::${t.name}`;
const splitTest = id => { const i = id.indexOf('::'); return { file: id.slice(0, i), name: id.slice(i + 2) }; };

// Tests bound to items by this run: the reproduction (recorded failing on
// base) and the fixer's declared tests, each with the ac_id it names.
export function runBindings({ repro = null, declared = [], items = [] }) {
  const ids = new Set(items.map(i => i.id));
  const out = {};
  const add = (ac, id) => { if (ids.has(ac)) (out[ac] ??= []).includes(id) || out[ac].push(id); };
  for (const t of repro?.tests ?? []) if (t.on_base === 'red' && t.ac_id) add(t.ac_id, testId(t));
  for (const t of declared) if (t?.ac_id && typeof t.file === 'string' && typeof t.name === 'string') add(t.ac_id, testId(t));
  return out;
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
//   runAtBase(files) -> Map(file -> run) runs test files at base (sandboxed)
export async function verifyAgentClaims({ claims = [], repo, base, code = {}, fetchBuild = fetchLiveBuild, runAtBase, binary = 'git' }) {
  const git = gitRunner(repo, { binary });
  const live = await readLiveBuild(git, fetchBuild);
  const baseLive = Boolean(live.commit && git.isAncestor(base, live.commit));
  const parsed = claims.map((c, index) => ({ index, ac_id: c.ac_id, text: c.text, ...parseClaimEvidence(c.evidence, `claims[${index}]`) }));
  const baseFiles = [...new Set(parsed.filter(p => p.evidence?.kind === 'test' && !(code.released && code.green?.has(p.evidence.ref)))
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
    if (code.released && code.green?.has(id)) return { ...verdict, verified: true, source: 'this_change', reason: 'passed in this run\'s gates at the released head' };
    const { file, name } = splitTest(id);
    if (!TEST_FILE.test(file)) return { ...verdict, reason: 'not a repository test file' };
    if (!baseLive) return { ...verdict, reason: `not live yet: ${live.error || 'the live build does not contain the base'}` };
    const run = runs.get(file);
    if (!run) return { ...verdict, reason: 'the host could not run the test at the base' };
    const status = greenVerdict(run, { file, name });
    return status === 'green' ? { ...verdict, verified: true, source: 'base', reason: `passed at ${base.slice(0, 12)}, which the live build contains` }
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
// Work the host knows is left, whatever the worker's summary says.
export function hostFollowUps({ attachments = [], finals = [] }) {
  const out = [];
  for (const a of attachments.filter(x => x.target && x.access === 'unavailable')) {
    out.push({ work: `Retrieve and review attachment ${a.attachment} (${a.storage_path})`, owner: 'support_worker', next_action: `The host could not deliver it (${String(a.reason ?? 'unknown').slice(0, 120)}); the next run downloads it again` });
  }
  for (const f of finals) {
    if (f.state === 'in_progress') out.push({ work: `Confirm ${f.id} once its held change is released`, owner: 'support_worker', next_action: `After the owner merges the held run, cite ${f.id}'s test on the live build` });
    if (f.detail === 'new') out.push({ work: `Work on ${f.id}, added to the checklist after this run's worker`, owner: 'support_worker', next_action: `The next run takes ${f.id} up` });
  }
  return out;
}

export async function writeStage3(file, record) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
  return file;
}
