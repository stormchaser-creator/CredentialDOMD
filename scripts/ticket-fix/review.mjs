// G4: independent review of an agent diff (design G4 with the critique's
// amendments).
//
// A fresh claude-opus-5-5 session at effort high, read-only (Read, Grep,
// Glob; no Bash, so none of git's program-running options), its own config
// directory, working in the worktree at head. It sees the ticket thread (the
// checklist, once G1 exists), the attachment references, the full base..head
// diff, gates.json, the protected-path report and the blast radius. It does
// NOT see the worker's reply, summary or assessment: the reviewer judges the
// change against the ticket, not against the worker's account of it.
//
// The host then checks the verdict: every citation's snippet must be found
// within 2 lines of file:line at head (an invented citation gets one fresh
// rerun, then fails), and the pass rule below: every met or partial item
// needs a verified citation into the change (a file the diff touched or a
// test gates.json lists), and a missed path the reviewer names is not an
// approval, whatever its verdict says (stage 2 review, findings 15 and 16).
// A diff touching billing, pay or invoice math, or sync code, gets two
// separate reviews and both must pass.
//
// Stage 3 (G1, G6): the reviewer rules on the frozen checklist, one verdict
// per item id (an item the change does not attempt is "not_addressed"; an
// item a test of this change pins may not be); it gives a verdict on every
// sentence the extractor judged not to be an ask, and names asks nothing
// covers (the host turns either into a new item); and it opens every
// attachment of the ticket and confirms or disputes what the fixer says it
// shows. A disputed or unjudged observation is not an approval. For a run
// with no change to review, confirmChecklist() asks the same questions of a
// read-only session (role "confirm").
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, attrFrom, DIFF_TEXT, MEDIA_EXCLUDES } from './worktree.mjs';
import { globRegExp, loadJSON, PROTECTED_CONFIG } from './gates/owner-rules.mjs';
import { PERSISTENCE_FILES } from './gates/tests.mjs';
import { KINDS } from './checklist.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REVIEW_PROMPT = path.join(HERE, 'review-prompt.md');
export const EVIDENCE_MARKER = '\n\n## Untrusted support evidence supplied by the runner\n';
const DIFF_LIMIT = 400000;

const str = (max, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
const CITATION = { type: 'object', additionalProperties: false, properties: { file: str(300), line: { type: 'integer', minimum: 1 }, snippet: str(300) }, required: ['file', 'line', 'snippet'] };
export const ITEM_VERDICTS = Object.freeze(['met', 'partial', 'not_met', 'not_addressed', 'cannot_verify']);
// What the reviewer (and the confirmer) says about the checklist's edges.
const OBSERVATIONS = { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, properties: {
  attachment: str(12), verdict: { enum: ['agree', 'disagree'] }, why: str(600) }, required: ['attachment', 'verdict', 'why'] } };
const NON_ASKS = { type: 'array', maxItems: 60, items: { type: 'object', additionalProperties: false, properties: {
  index: { type: 'integer', minimum: 0 }, verdict: { enum: ['ask', 'not_ask'] }, requirement: str(120, 0), kind: { enum: [...KINDS, 'none'] }, why: str(600) },
  required: ['index', 'verdict', 'requirement', 'kind', 'why'] } };
const MISSED_ASKS = { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, properties: {
  source_id: str(40), quote: str(300), requirement: str(120), kind: { enum: KINDS }, why: str(600) }, required: ['source_id', 'quote', 'requirement', 'kind', 'why'] } };
export const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  items: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', additionalProperties: false, properties: {
    ac_id: str(12), requirement: str(300), verdict: { enum: ITEM_VERDICTS }, citations: { type: 'array', maxItems: 10, items: CITATION } },
    required: ['ac_id', 'requirement', 'verdict', 'citations'] } },
  observations: OBSERVATIONS, non_asks: NON_ASKS, missed_asks: MISSED_ASKS,
  regressions: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: {
    ...CITATION.properties, scenario: str(600), severity: { enum: ['high', 'medium', 'low'] } }, required: ['file', 'line', 'snippet', 'scenario', 'severity'] } },
  missed_paths: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: { ...CITATION.properties, why: str(600) }, required: ['file', 'line', 'snippet', 'why'] } },
  test_changes: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: {
    file: str(300), test: str(300), verdict: { enum: ['justified', 'unjustified'] }, why: str(600) }, required: ['file', 'test', 'verdict', 'why'] } },
  sibling_exclusions: { type: 'array', maxItems: 60, items: { type: 'object', additionalProperties: false, properties: {
    group: str(200), member: str(300), reason: str(600) }, required: ['group', 'member', 'reason'] } },
  verdict: { enum: ['approve', 'revise', 'block'] },
  summary: str(2000),
}, required: ['items', 'observations', 'non_asks', 'missed_asks', 'regressions', 'missed_paths', 'test_changes', 'sibling_exclusions', 'verdict', 'summary'] };
// The confirmer's result: the review's checklist-edge questions only.
export const CONFIRM_SCHEMA = { title: 'ticket-confirm', type: 'object', additionalProperties: false, properties: {
  observations: OBSERVATIONS, non_asks: NON_ASKS, missed_asks: MISSED_ASKS, summary: str(2000) }, required: ['observations', 'non_asks', 'missed_asks', 'summary'] };

function checkShape(value, schema) {
  if (schema.enum) { if (!schema.enum.includes(value)) throw Error('Review value outside its enum'); return; }
  if (schema.type === 'string') { if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > schema.maxLength || value.includes('\0')) throw Error('Invalid review text'); return; }
  if (schema.type === 'integer') { if (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity)) throw Error('Invalid review line'); return; }
  if (schema.type === 'array') { if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > schema.maxItems) throw Error('Invalid review list'); value.forEach(v => checkShape(v, schema.items)); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !(k in schema.properties)) || schema.required.some(k => !(k in value))) throw Error('Invalid review object');
    for (const [key, child] of Object.entries(schema.properties)) checkShape(value[key], child);
  }
}
export function validateReview(review, schema = REVIEW_SCHEMA) { checkShape(review, schema); return review; }

const norm = text => String(text).replace(/\s+/g, ' ').trim();
const safeFile = file => typeof file === 'string' && !path.isAbsolute(file) && !file.split('/').includes('..') && /^[\w.@()/+ -]+$/.test(file);
// Every citation in the review, with where it came from.
export const citationsIn = review => [
  ...review.items.flatMap((item, i) => item.citations.map(c => ({ ...c, where: `items[${i}]` }))),
  ...review.regressions.map((c, i) => ({ ...c, where: `regressions[${i}]` })),
  ...review.missed_paths.map((c, i) => ({ ...c, where: `missed_paths[${i}]` })),
];
// A snippet must be real code at head: found in the lines within 2 of the
// cited line, and long enough to mean something (a "}" is everywhere).
export function verifyCitations(review, readFile) {
  const invented = [];
  for (const c of citationsIn(review)) {
    const snippet = norm(c.snippet);
    let text = null;
    if (safeFile(c.file)) { try { text = readFile(c.file); } catch { text = null; } }
    if (text === null || snippet.replace(/\s/g, '').length < 10) { invented.push({ where: c.where, file: c.file, line: c.line, why: text === null ? 'no such file' : 'snippet too short to locate' }); continue; }
    const lines = text.split('\n');
    const window = norm(lines.slice(Math.max(0, c.line - 3), c.line + 2).join(' '));
    if (!window.includes(snippet)) invented.push({ where: c.where, file: c.file, line: c.line, why: 'snippet not within 2 lines of the cited line' });
  }
  return invented;
}

// The files a citation may point into: what the diff touched and the tests
// gates.json lists (reproduction, declared, green). null: not known (no
// gates), so only the citation count is checked.
export function citableFiles(gates) {
  if (!gates?.diff?.files) return null;
  return new Set([...gates.diff.files, ...(gates.repro?.tests ?? []).map(t => t.file), ...(gates.declared ?? []).map(t => t.file), ...(gates.green ?? []).map(t => t.file)].filter(Boolean));
}

// The checklist edges, shared by the reviewer and the confirmer: every
// observation the fixer gave is confirmed, every pending non-ask judged.
//   stage3 { items, bound: {ac: [tests]}, observations, non_asks }
export function edgeReasons(review, stage3) {
  const reasons = [];
  if (!stage3) return reasons;
  for (const o of stage3.observations ?? []) {
    const verdicts = (review.observations ?? []).filter(v => v.attachment === o.attachment);
    if (verdicts.length !== 1) reasons.push(`observation ${o.attachment} was not judged exactly once`);
    else if (verdicts[0].verdict !== 'agree') reasons.push(`observation ${o.attachment} is disputed`);
  }
  for (const n of (stage3.non_asks ?? []).filter(x => x.verdict === null)) {
    if (!(review.non_asks ?? []).some(v => v.index === n.index)) reasons.push(`not-an-ask ${n.index} was not judged`);
  }
  return reasons;
}
// The pass rule for one review, given what the host knows.
export function reviewVerdict(review, { invented = [], gates = null, blast = null, stage3 = null } = {}) {
  const reasons = [];
  if (invented.length) reasons.push(`${invented.length} citation(s) not found at head`);
  if (review.verdict !== 'approve') reasons.push(`verdict ${review.verdict}`);
  if (review.items.some(i => i.verdict === 'not_met')) reasons.push('an item is not met');
  if (stage3?.items) {
    const ids = stage3.items.map(i => i.id);
    for (const id of ids) if (review.items.filter(i => i.ac_id === id).length !== 1) reasons.push(`item ${id} needs exactly one verdict`);
    for (const item of review.items) if (!ids.includes(item.ac_id)) reasons.push(`item ${String(item.ac_id).slice(0, 12)} is not on the checklist`);
    for (const [id, tests] of Object.entries(stage3.bound ?? {})) {
      const verdict = review.items.find(i => i.ac_id === id)?.verdict;
      if (tests.length && verdict && !['met', 'partial', 'not_met'].includes(verdict)) reasons.push(`item ${id} is pinned by a test of this change but judged ${verdict}`);
    }
  }
  reasons.push(...edgeReasons(review, stage3));
  // Finding 16: a met or partial item stands on at least one citation the
  // host verified, into the change itself.
  const bad = new Set(invented.map(x => `${x.where}|${x.file}|${x.line}`));
  const citable = citableFiles(gates);
  review.items.forEach((item, i) => {
    if (!['met', 'partial'].includes(item.verdict)) return;
    const good = item.citations.filter(c => !bad.has(`items[${i}]|${c.file}|${c.line}`) && (!citable || citable.has(c.file)));
    if (!good.length) reasons.push(`item ${item.ac_id ?? i + 1} is ${item.verdict} without a verified citation into the change`);
  });
  if (review.regressions.some(r => r.severity === 'high')) reasons.push('a high-severity regression');
  // Finding 15: a path the reviewer says was missed means the change is
  // incomplete, whatever the verdict.
  for (const m of review.missed_paths) reasons.push(`missed path ${m.file}:${m.line}`);
  for (const e of review.sibling_exclusions) {
    if (review.missed_paths.some(m => m.file === e.member)) reasons.push(`sibling ${e.member} is both excluded and named as missed`);
  }
  if (review.test_changes.some(t => t.verdict === 'unjustified')) reasons.push('an unjustified test change');
  for (const change of gates?.diff?.test_changes ?? []) {
    if (!review.test_changes.some(t => t.file === change.file)) reasons.push(`the changed test file ${change.file} was not reviewed`);
  }
  for (const group of blast?.sibling_groups ?? []) {
    for (const member of group.untouched) {
      if (!review.sibling_exclusions.some(e => e.member === member && norm(e.reason).length >= 10)) reasons.push(`untouched sibling ${member} (${group.name}) was not excluded with a reason`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

// Two reviews for money math and sync code (design G4; critique: not for
// size alone).
export function isRisky(files, { persistence = null, config = loadJSON(PROTECTED_CONFIG) } = {}) {
  const money = config.money_literal_paths.filter(p => p.startsWith('src/'));
  return files.some(f => money.some(p => globRegExp(p).test(f)) || PERSISTENCE_FILES.includes(f) || /(?:billing|pricing|invoice|dutyPay|tax|payroll|sync)/i.test(f)) ||
    Boolean(persistence?.triggered);
}

// The reviewer's input: prompt, host facts, then the ticket evidence. The
// worker's result is never passed in; prior saved reviews (earlier drafts)
// are removed from the evidence too.
const fence = (title, value) => `### ${title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\n`;
// The checklist, the non-asks, the hints and the attachments with the fixer's
// observations (stage 3). Host facts: the ids, quotes and paths are the
// host's; the observations are the fixer's claims, to be checked.
export function stage3Facts(stage3) {
  if (!stage3) return '';
  let text = fence('Checklist (frozen by the host: one item verdict per id)', stage3.items.map(i => ({ id: i.id, requirement: i.requirement, kind: i.kind, surface: i.surface, source_id: i.source_id, quote: i.quote })));
  if (Object.keys(stage3.bound ?? {}).length) text += fence('Tests of this change bound to items', stage3.bound);
  const pending = (stage3.non_asks ?? []).filter(n => n.verdict === null);
  if (pending.length) text += fence('Judged NOT to be asks by the extractor (a verdict on every index)', pending.map(n => ({ index: n.index, source_id: n.source_id, quote: n.quote, reason: n.reason })));
  if ((stage3.hints ?? []).length) text += fence('Sentences no item quotes (host hint: check for a dropped ask)', stage3.hints);
  if ((stage3.attachments ?? []).length) {
    text += fence('Attachments (Read each local_path; they are the customer\'s files)', stage3.attachments.map(a => ({ attachment: a.attachment, source_id: a.source_id, target: a.target,
      ...(a.local_path ? { local_path: a.local_path, media_type: a.media_type } : { unavailable: a.reason }) })));
    text += fence('What the fixer says each attachment shows (confirm or dispute each)', stage3.observations ?? []);
  }
  return text;
}
export function reviewInput({ prompt, context, diff, gates, protectedReport, blast, base, head, stage3 = null }) {
  const evidence = { ...context };
  delete evidence.prior_reviews;
  const clipped = diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n[diff truncated at ${DIFF_LIMIT} characters; read the files for the rest]\n` : diff;
  return `${prompt}\n\n## Host facts (trusted, produced by the runner)\n\nBase: ${base}\nHead: ${head}\n\n${stage3Facts(stage3)}### gates.json\n\n\`\`\`json\n${JSON.stringify(gates, null, 2)}\n\`\`\`\n\n` +
    `### Protected paths (G11)\n\n\`\`\`json\n${JSON.stringify(protectedReport, null, 2)}\n\`\`\`\n\n### Blast radius\n\n\`\`\`json\n${JSON.stringify(blast, null, 2)}\n\`\`\`\n\n` +
    `### Diff base..head\n\n\`\`\`diff\n${clipped}\`\`\`${EVIDENCE_MARKER}${JSON.stringify(evidence)}`;
}

// The worker's revise prompt: the reviewer's findings with their citations.
export function reviseInput(reviews) {
  const lines = ['An independent reviewer did not approve your change, so nothing was merged. Its findings (file:line: why):'];
  for (const review of reviews) {
    for (const item of review.items.filter(i => !['met', 'not_addressed'].includes(i.verdict))) lines.push(`- ${item.ac_id ?? ''} ${item.verdict}: ${item.requirement}${item.citations.length ? ` (${item.citations.map(c => `${c.file}:${c.line}`).join(', ')})` : ''}`);
    for (const o of (review.observations ?? []).filter(x => x.verdict === 'disagree')) lines.push(`- the reviewer disputes your observation of ${o.attachment}: ${o.why}`);
    for (const r of review.regressions) lines.push(`- regression (${r.severity}) ${r.file}:${r.line}: ${r.scenario}`);
    for (const m of review.missed_paths) lines.push(`- missed path ${m.file}:${m.line}: ${m.why}`);
    for (const t of review.test_changes.filter(x => x.verdict === 'unjustified')) lines.push(`- unjustified test change ${t.file} "${t.test}": ${t.why}`);
  }
  lines.push('Change the code and tests to address these, keep the reproduction files as they are, then return the structured result again for the same target_id. Do not claim anything is fixed or released in the reply.');
  return lines.join('\n').slice(0, 12000);
}

// Runs the review (twice when risky). launch(input) returns
// { ok, output: { structured_output } , reason }. Each review whose citations
// do not check out gets ONE fresh rerun.
export async function reviewDiff({ dir, base, head, context, gates, protectedReport, blast, launch, prompt = readFileSync(REVIEW_PROMPT, 'utf8'), binary = 'git', risky = null, stage3 = null }) {
  const diff = git(dir, [...attrFrom(base), 'diff', ...DIFF_TEXT, base, head, '--', '.', ...MEDIA_EXCLUDES], { binary });
  const input = reviewInput({ prompt, context, diff, gates, protectedReport, blast, base, head, stage3 });
  const count = (risky ?? isRisky(gates?.diff?.files ?? [], { persistence: gates?.persistence })) ? 2 : 1;
  const readFile = file => readFileSync(path.join(dir, file), 'utf8');
  const reviews = [];
  for (let n = 0; n < count; n++) {
    let attempt = 0, entry = null;
    while (attempt < 2) {
      attempt++;
      const r = await launch(input, { index: n, attempt });
      if (!r.ok) { entry = { ok: false, reason: r.reason ?? 'review session failed', attempt }; continue; }
      let review;
      try { review = validateReview(r.output.structured_output); } catch (error) { entry = { ok: false, reason: error.message, attempt }; continue; }
      const invented = verifyCitations(review, readFile);
      entry = { ok: true, review, invented, attempt, reads: r.reads ?? [], ...reviewVerdict(review, { invented, gates, blast, stage3 }), cost_usd: r.output.total_cost_usd ?? null };
      if (!invented.length) break;
    }
    reviews.push(entry);
  }
  const verdicts = reviews.map(r => (r.ok ? r.review.verdict : 'failed'));
  const reasons = reviews.flatMap((r, i) => (r.ok ? r.reasons : [`review ${i + 1}: ${r.reason}`]).map(x => (count > 1 ? `review ${i + 1}: ${x}` : x)));
  if (count > 1 && new Set(verdicts).size > 1) reasons.push(`the two reviews disagree (${verdicts.join(' vs ')})`);
  const pass = reviews.every(r => r.ok && r.pass) && reasons.length === 0;
  // A review that names a missed path, or disputes what an attachment shows,
  // sends the worker round once, even when its verdict said approve.
  const revise = !pass && reviews.every(r => r.ok && !r.invented.length) && !verdicts.includes('block') &&
    (verdicts.includes('revise') || reviews.some(r => r.ok && (r.review.missed_paths.length > 0 || (r.review.observations ?? []).some(o => o.verdict === 'disagree'))));
  return { pass, revise, count, reviews: reviews.map(r => (r.ok ? { verdict: r.review.verdict, pass: r.pass, reasons: r.reasons, invented: r.invented, attempts: r.attempt, review: r.review, cost_usd: r.cost_usd, reads: r.reads } : { verdict: 'failed', pass: false, reasons: [r.reason], attempts: r.attempt })), reasons,
    ...combineEdges(reviews.filter(r => r.ok).map(r => r.review)) };
}

// One answer from one or two reviews (or a confirmer): the worst item verdict
// per id, an observation agreed only if every review agreed, a non-ask an ask
// if any review says so, and every missed ask.
const RANK = ['not_met', 'not_addressed', 'cannot_verify', 'partial', 'met'];
export function combineEdges(reviews) {
  const items = {}, observations = {};
  const nonAsks = new Map(), missed = [];
  for (const review of reviews) {
    for (const item of review.items ?? []) if (item.ac_id) items[item.ac_id] = item.ac_id in items && RANK.indexOf(items[item.ac_id]) < RANK.indexOf(item.verdict) ? items[item.ac_id] : item.verdict;
    for (const o of review.observations ?? []) observations[o.attachment] = observations[o.attachment] === 'disagree' ? 'disagree' : o.verdict;
    for (const n of review.non_asks ?? []) if (!nonAsks.has(n.index) || n.verdict === 'ask') nonAsks.set(n.index, n);
    missed.push(...(review.missed_asks ?? []));
  }
  // An observation not every review judged is not confirmed.
  for (const id of Object.keys(observations)) if (reviews.some(r => !(r.observations ?? []).some(o => o.attachment === id))) observations[id] = 'unconfirmed';
  return { item_verdicts: items, observation_verdicts: observations, non_ask_verdicts: [...nonAsks.values()], missed_asks: missed };
}

// For a run with no change to review: a read-only session judges what the
// fixer says the attachments show, the non-asks and any dropped ask. launch
// as for reviewDiff. Returns combineEdges' shape plus pass and reasons.
export async function confirmChecklist({ context, stage3, launch, prompt }) {
  const evidence = { ...context };
  delete evidence.prior_reviews;
  const input = `${prompt}\n\n## Host facts (trusted, produced by the runner)\n\n${stage3Facts(stage3)}${EVIDENCE_MARKER}${JSON.stringify(evidence)}`;
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await launch(input, { index: 0, attempt });
    if (!r.ok) { last = r.reason ?? 'confirm session failed'; continue; }
    let review;
    try { review = validateReview(r.output.structured_output, CONFIRM_SCHEMA); } catch (error) { last = error.message; continue; }
    const reasons = edgeReasons(review, stage3);
    return { pass: reasons.length === 0, reasons, review, reads: r.reads ?? [], ...combineEdges([review]) };
  }
  return { pass: false, reasons: [`confirm: ${last}`], review: null, reads: [], item_verdicts: {}, observation_verdicts: {}, non_ask_verdicts: [], missed_asks: [] };
}
