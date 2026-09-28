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
// rerun, then fails), and the pass rule below. A diff touching billing, pay
// or invoice math, or sync code, gets two separate reviews and both must pass.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './worktree.mjs';
import { globRegExp, loadJSON, PROTECTED_CONFIG } from './gates/owner-rules.mjs';
import { PERSISTENCE_FILES } from './gates/tests.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REVIEW_PROMPT = path.join(HERE, 'review-prompt.md');
export const EVIDENCE_MARKER = '\n\n## Untrusted support evidence supplied by the runner\n';
const DIFF_LIMIT = 400000;

const str = (max, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
const CITATION = { type: 'object', additionalProperties: false, properties: { file: str(300), line: { type: 'integer', minimum: 1 }, snippet: str(300) }, required: ['file', 'line', 'snippet'] };
export const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  items: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', additionalProperties: false, properties: {
    requirement: str(300), verdict: { enum: ['met', 'partial', 'not_met', 'cannot_verify'] }, citations: { type: 'array', maxItems: 10, items: CITATION } },
    required: ['requirement', 'verdict', 'citations'] } },
  regressions: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: {
    ...CITATION.properties, scenario: str(600), severity: { enum: ['high', 'medium', 'low'] } }, required: ['file', 'line', 'snippet', 'scenario', 'severity'] } },
  missed_paths: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: { ...CITATION.properties, why: str(600) }, required: ['file', 'line', 'snippet', 'why'] } },
  test_changes: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: {
    file: str(300), test: str(300), verdict: { enum: ['justified', 'unjustified'] }, why: str(600) }, required: ['file', 'test', 'verdict', 'why'] } },
  sibling_exclusions: { type: 'array', maxItems: 60, items: { type: 'object', additionalProperties: false, properties: {
    group: str(200), member: str(300), reason: str(600) }, required: ['group', 'member', 'reason'] } },
  verdict: { enum: ['approve', 'revise', 'block'] },
  summary: str(2000),
}, required: ['items', 'regressions', 'missed_paths', 'test_changes', 'sibling_exclusions', 'verdict', 'summary'] };

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
export function validateReview(review) { checkShape(review, REVIEW_SCHEMA); return review; }

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

// The pass rule for one review, given what the host knows.
export function reviewVerdict(review, { invented = [], gates = null, blast = null } = {}) {
  const reasons = [];
  if (invented.length) reasons.push(`${invented.length} citation(s) not found at head`);
  if (review.verdict !== 'approve') reasons.push(`verdict ${review.verdict}`);
  if (review.items.some(i => i.verdict === 'not_met')) reasons.push('an item is not met');
  if (review.regressions.some(r => r.severity === 'high')) reasons.push('a high-severity regression');
  if (review.test_changes.some(t => t.verdict === 'unjustified')) reasons.push('an unjustified test change');
  for (const change of gates?.diff?.test_changes ?? []) {
    if (!review.test_changes.some(t => t.file === change.file)) reasons.push(`the changed assertions in ${change.file} were not reviewed`);
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
export function reviewInput({ prompt, context, diff, gates, protectedReport, blast, base, head }) {
  const evidence = { ...context };
  delete evidence.prior_reviews;
  const clipped = diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n[diff truncated at ${DIFF_LIMIT} characters; read the files for the rest]\n` : diff;
  return `${prompt}\n\n## Host facts (trusted, produced by the runner)\n\nBase: ${base}\nHead: ${head}\n\n### gates.json\n\n\`\`\`json\n${JSON.stringify(gates, null, 2)}\n\`\`\`\n\n` +
    `### Protected paths (G11)\n\n\`\`\`json\n${JSON.stringify(protectedReport, null, 2)}\n\`\`\`\n\n### Blast radius\n\n\`\`\`json\n${JSON.stringify(blast, null, 2)}\n\`\`\`\n\n` +
    `### Diff base..head\n\n\`\`\`diff\n${clipped}\`\`\`${EVIDENCE_MARKER}${JSON.stringify(evidence)}`;
}

// The worker's revise prompt: the reviewer's findings with their citations.
export function reviseInput(reviews) {
  const lines = ['An independent reviewer did not approve your change, so nothing was merged. Its findings (file:line: why):'];
  for (const review of reviews) {
    for (const item of review.items.filter(i => i.verdict !== 'met')) lines.push(`- ${item.verdict}: ${item.requirement}${item.citations.length ? ` (${item.citations.map(c => `${c.file}:${c.line}`).join(', ')})` : ''}`);
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
export async function reviewDiff({ dir, base, head, context, gates, protectedReport, blast, launch, prompt = readFileSync(REVIEW_PROMPT, 'utf8'), binary = 'git', risky = null }) {
  const diff = git(dir, ['diff', '--no-color', '--no-ext-diff', base, head], { binary });
  const input = reviewInput({ prompt, context, diff, gates, protectedReport, blast, base, head });
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
      entry = { ok: true, review, invented, attempt, ...reviewVerdict(review, { invented, gates, blast }), cost_usd: r.output.total_cost_usd ?? null };
      if (!invented.length) break;
    }
    reviews.push(entry);
  }
  const verdicts = reviews.map(r => (r.ok ? r.review.verdict : 'failed'));
  const reasons = reviews.flatMap((r, i) => (r.ok ? r.reasons : [`review ${i + 1}: ${r.reason}`]).map(x => (count > 1 ? `review ${i + 1}: ${x}` : x)));
  if (count > 1 && new Set(verdicts).size > 1) reasons.push(`the two reviews disagree (${verdicts.join(' vs ')})`);
  const pass = reviews.every(r => r.ok && r.pass) && reasons.length === 0;
  const revise = !pass && reviews.every(r => r.ok && !r.invented.length) && verdicts.includes('revise') && !verdicts.includes('block');
  return { pass, revise, count, reviews: reviews.map(r => (r.ok ? { verdict: r.review.verdict, pass: r.pass, reasons: r.reasons, invented: r.invented, attempts: r.attempt, review: r.review, cost_usd: r.cost_usd } : { verdict: 'failed', pass: false, reasons: [r.reason], attempts: r.attempt })), reasons };
}
