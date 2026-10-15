#!/usr/bin/env node
// Human review of ONE explicit QA run. Never reads credentials or guesses the
// tested revision from the current checkout. Output is self-contained/local.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GENERATED_DIR, QA_LAB_DIR, isMain } from './lib/paths.mjs';
import { assessLabHealth } from './lib/health-evidence.mjs';
import { reconcileHealthClaims } from './lib/health-claims.mjs';
import { reconcileStripeRetries } from './lib/stripe-retry-evidence.mjs';
import { reconcileEdgeClaims } from './lib/edge-health-claims.mjs';
import { escapeHtml, redact } from './lib/report-safety.mjs';
export { escapeHtml, redact } from './lib/report-safety.mjs';

export const STATUSES = Object.freeze(['fail', 'partial', 'blocked', 'not_run', 'by_design', 'pass']);
const labels = { fail: 'Failed', partial: 'Partial', blocked: 'Blocked', not_run: 'Not run', by_design: 'By design', pass: 'Passed' };
const complete = status => status === 'pass' || status === 'by_design';
const list = value => Array.isArray(value) ? value : [];

const text = value => redact(typeof value === 'string' || typeof value === 'number' ? value : '');
const texts = value => list(value).map(text).filter(Boolean);
const statusOf = value => STATUSES.includes(value) ? value : 'fail';

function evidenceRow(value) {
  const checks = list(value?.checks).map(c => ({ name: text(c?.name), ok: c?.ok === true, detail: text(c?.detail) }));
  const status = checks.some(c => !c.ok) ? 'fail' : statusOf(value?.status);
  return { status, journey: text(value?.journey), file: text(value?.file), stretch: text(value?.stretch),
    reason: text(value?.reason), error: text(value?.error), checks, screenshots: texts(value?.screenshots) };
}
function bugRow(value) {
  return { feature: text(value?.feature), title: text(value?.title), severity: text(value?.severity), step: text(value?.step),
    expected: text(value?.expected), actual: text(value?.actual), journey: text(value?.journey), screenshot: text(value?.screenshot) };
}
function aggregate(entry, evidence) {
  if (!entry) return 'not_run';
  const claimed = statusOf(entry.status);
  if (claimed === 'fail' || evidence.some(e => e.status === 'fail')) return 'fail';
  if (!evidence.length) return complete(claimed) ? 'blocked' : claimed;
  const statuses = [claimed, ...evidence.map(e => e.status)];
  if (statuses.includes('partial') || (statuses.some(complete) && statuses.some(s => !complete(s)))) return 'partial';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('not_run')) return 'not_run';
  return statuses.includes('by_design') ? 'by_design' : 'pass';
}

/** Only whitelisted fields reach the review JSON, never arbitrary result metadata. */
export function buildReview(checklist, results = null, { resultsPath = '', generatedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(checklist) || !checklist.length) throw new Error('Checklist must be a nonempty array.');
  const ids = new Set();
  for (const item of checklist) {
    if (!item || !/^[A-Z]+-\d{3}$/.test(item.id) || ids.has(item.id)) throw new Error('Checklist needs unique feature ids.');
    ids.add(item.id);
  }
  if (results !== null && (!results || typeof results !== 'object' || Array.isArray(results)
      || !results.features || typeof results.features !== 'object' || Array.isArray(results.features))) throw new Error('Results must contain a features object.');
  const bugs = list(results?.bugs).map(bugRow);
  const all = [...checklist];
  for (const [id, observed] of Object.entries(results?.features || {})) {
    if (!ids.has(id)) all.push({ id: text(id), name: text(observed?.name) || 'Unlisted observed feature', area: 'UNLISTED', priority: 'Unassigned', unlisted: true });
  }
  const tasks = all.map(item => {
    const entry = results?.features?.[item.id];
    const evidence = list(entry?.evidence).map(evidenceRow);
    const taskBugs = bugs.filter(b => b.feature === item.id);
    const status = taskBugs.length ? 'fail' : aggregate(entry, evidence);
    const reasons = evidence.flatMap(e => [e.reason, e.error].filter(Boolean));
    if (!entry) reasons.push('No result for this checklist item in the selected run.');
    else if (!evidence.length && complete(entry.status)) reasons.push('Completion was reported without recorded feature evidence.');
    if (item.unlisted) reasons.push('This observed feature is absent from the selected checklist.');
    if (taskBugs.length) reasons.push(`${taskBugs.length} bug(s) recorded for this feature in the selected run.`);
    if (!reasons.length && ['blocked', 'partial'].includes(status)) reasons.push(`The source marked this item ${status}, but did not capture an explanation.`);
    return { id: text(item.id), name: text(item.name), area: text(item.area), priority: text(item.priority),
      roles: texts(item.roles), where: text(item.where), steps: texts(item.steps), expected: text(item.expected),
      serverChecks: texts(item.server_checks), tests: texts(item.tests), unlisted: !!item.unlisted, status, reasons: [...new Set(reasons)], evidence,
      failedChecks: evidence.flatMap(e => e.checks.filter(c => !c.ok).map(c => ({ ...c, journey: e.journey }))), bugs: taskBugs };
  });
  const summary = Object.fromEntries(STATUSES.map(s => [s, tasks.filter(t => t.status === s).length]));
  const byArea = Object.create(null);
  for (const task of tasks) { byArea[task.area] ||= Object.fromEntries(STATUSES.map(s => [s, 0])); byArea[task.area][task.status]++; }
  const captured = results?.source || results?.testedSource;
  const source = captured && typeof captured === 'object' ? {
    head: /^[a-f0-9]{7,64}$/i.test(captured.head || '') ? captured.head : null,
    dirty: typeof captured.dirty === 'boolean' ? captured.dirty : null,
    fingerprint: /^[a-f0-9]{64}$/i.test(captured.fingerprint || '') ? captured.fingerprint : null,
  } : null;
  const runStatus = results ? text(results.runStatus) || 'unknown' : 'not_run';
  const reasons = texts(list(results?.readiness?.reasons).map(r => `${text(r?.code)}${r?.feature ? ` ${text(r.feature)}` : ''}${r?.detail ? `: ${text(r.detail)}` : ''}`));
  if (!results) reasons.push('No result file was found. All checklist items remain unverified.');
  if (runStatus !== 'passed') reasons.push(`Selected run status: ${runStatus}.`);
  if (tasks.some(t => !complete(t.status))) reasons.push('The checklist contains failed or incomplete items.');
  if (tasks.some(t => t.unlisted)) reasons.push('Unlisted observed features need checklist review.');
  if (bugs.length) reasons.push(`${bugs.length} bug(s) remain recorded in this run.`);
  if (list(results?.journeys).some(j => j?.status !== 'passed')) reasons.push('One or more recorded journeys did not pass.');
  if (results?.readiness?.ready === false && !reasons.length) reasons.push('The source results did not mark local coverage ready.');
  const claims = results?.healthClientClaims !== undefined || results?.labHealth?.clientErrorObservations !== undefined
    ? reconcileHealthClaims(results?.labHealth, results?.healthClientClaims || []) : null;
  const billingRetries = reconcileStripeRetries(results?.labHealth, results?.billingDeliveryAudit);
  const edgeClaims = reconcileEdgeClaims(results?.labHealth, results?.healthEdgeRequests || [], results?.healthEdgeClaims || [], results?.billingDeliveryAudit);
  const priorProblems = claims ? claims.problems : results?.labHealth?.claimProblems;
  const claimProblems = priorProblems === undefined ? [] : Array.isArray(priorProblems) ? priorProblems
    : [{ code: 'invalid-health-claim', detail: 'Health claim reconciliation is malformed.' }];
  const health = assessLabHealth({ ...results?.labHealth, claimProblems: [...claimProblems, ...billingRetries.problems, ...edgeClaims.problems, ...(results?.billingAuditFence?.settled === false ? [{ code: 'unsettled-delivery-audit', detail: 'Local provider work did not settle inside the 15-second evidence fence.' }] : [])] },
    [...(claims ? claims.evidence : list(results?.healthIntentionalEvidence).filter(value => value?.kind === 'client')), ...billingRetries.evidence, ...edgeClaims.evidence]);
  health.billingRetries = billingRetries.summary;
  health.edgeClaims = { matchedOccurrences: edgeClaims.matched.reduce((count, claim) => count + (claim.observationIds?.length || 1), 0) };
  if (claims) health.claims = { matchedRows: claims.matched.length, absentAtCollection: claims.absent.length };
  for (const reason of health.reasons) reasons.push(`Health: ${reason.detail}`);
  return { schemaVersion: 1, scope: 'local-lab', generatedAt, resultsPath: text(resultsPath),
    run: { startedAt: text(results?.startedAt), generatedAt: text(results?.generatedAt), status: runStatus, source,
      browser: { engine: text(results?.browser?.browserName), channel: text(results?.browser?.channel) } },
    limits: 'Synthetic accounts and local provider mocks. This report does not verify production deployment, real email/SMS delivery, live payments, real-device behavior, or freedom from all bugs.',
    checklistItems: checklist.length, summary, byArea, health, readiness: { ready: reasons.length === 0, reasons: [...new Set(reasons)] }, tasks, bugs,
    journeys: list(results?.journeys).map(j => ({ title: text(j?.title), file: text(j?.file), status: text(j?.status), error: text(j?.error),
      durationMs: Number.isFinite(j?.durationMs) ? j.durationMs : null, features: texts(j?.features) })) };
}

const e = escapeHtml;
const bullets = values => values.length ? `<ul>${values.map(v => `<li>${e(v)}</li>`).join('')}</ul>` : '';
const block = (label, value) => value ? `<p><strong>${e(label)}</strong> ${e(value)}</p>` : '';
const issue = bug => `<div class="issue"><h4>${e(bug.title || 'Recorded bug')} <small>${e(bug.severity)}</small></h4>${block('Step:', bug.step)}${block('Expected:', bug.expected)}${block('Actual:', bug.actual)}${block('Journey:', bug.journey)}</div>`;

export function renderHtml(review) {
  const counts = STATUSES.map(s => `<button type="button" class="count ${s}" data-filter="${s}" aria-pressed="false"><b>${review.summary[s]}</b><span>${labels[s]}</span></button>`).join('');
  const source = review.run.source;
  const provenance = source ? `${source.head ? `Captured HEAD: ${source.head}` : 'Tested HEAD not captured'} · ${source.dirty === null ? 'Dirty state not captured' : source.dirty ? 'Working tree was dirty' : 'Working tree was clean'}${source.fingerprint ? ` · Fingerprint: ${source.fingerprint}` : ' · Fingerprint not captured'}` : 'Tested revision and working-tree fingerprint were not captured in this result file.';
  const tasks = review.tasks.map(task => `<article class="task" data-status="${task.status}" data-search="${e(`${task.id} ${task.name} ${task.area} ${task.roles.join(' ')}`.toLowerCase())}">
    <details ${complete(task.status) ? '' : 'open'}><summary><span class="pill ${task.status}">${labels[task.status]}</span><span class="task-title"><b>${e(task.id)} · ${e(task.name)}</b><small>${e(task.area)} · ${e(task.priority)}${task.roles.length ? ` · ${e(task.roles.join(', '))}` : ''}</small></span></summary>
    <div class="task-body">${block('Where:', task.where)}${block('Expected:', task.expected)}
    ${task.reasons.length ? `<div class="reasons"><h4>What needs attention</h4>${bullets(task.reasons)}</div>` : ''}
    ${task.failedChecks.length ? `<h4>Failed checks</h4>${bullets(task.failedChecks.map(c => `${c.name}${c.detail ? ` — ${c.detail}` : ''}${c.journey ? ` (${c.journey})` : ''}`))}` : ''}
    ${task.bugs.map(issue).join('')}
    ${task.steps.length ? `<details class="sub"><summary>Planned steps (${task.steps.length})</summary><ol>${task.steps.map(s => `<li>${e(s)}</li>`).join('')}</ol></details>` : ''}
    ${task.evidence.length ? `<details class="sub"><summary>Recorded evidence (${task.evidence.length})</summary>${task.evidence.map(ev => `<section class="evidence"><h4>${labels[ev.status]} · ${e(ev.stretch || ev.journey || 'Feature stretch')}</h4>${block('Journey:', ev.journey)}${block('Spec:', ev.file)}${block('Reason:', ev.reason)}${block('Error:', ev.error)}${bullets(ev.checks.map(c => `${c.ok ? 'PASS' : 'FAIL'} · ${c.name}${c.detail ? ` — ${c.detail}` : ''}`))}${ev.screenshots.length ? `<h5>Screenshot paths (local evidence)</h5>${bullets(ev.screenshots)}` : ''}</section>`).join('')}</details>` : ''}
    ${task.tests.length || task.serverChecks.length ? `<details class="sub"><summary>Related tests and server checks</summary>${bullets([...task.tests, ...task.serverChecks])}</details>` : ''}
    </div></details></article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>CredentialDOMD · QA task review</title>
<style>
:root{font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172c3b;background:#f5f4ef}*{box-sizing:border-box}body{margin:0}header{background:#123547;color:#f7faf9;padding:44px max(24px,calc((100vw - 1180px)/2)) 30px}.eyebrow{letter-spacing:.14em;font-size:.75rem;text-transform:uppercase;color:#a9cec9}h1{font-size:clamp(1.8rem,4vw,2.8rem);line-height:1.15;margin:8px 0 18px}header p{max-width:850px;margin:9px 0}main{max-width:1228px;margin:auto;padding:28px 24px 60px}h2{font-size:1.3rem}h4{margin:15px 0 6px}h5{margin-bottom:3px}.status-line{color:#bde1dc;font-weight:650}.meta{font-size:.8rem;color:#d0dedf;overflow-wrap:anywhere}.counts{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:22px 0}.count{border:1px solid #d2dcdb;border-radius:10px;background:white;padding:14px 12px;text-align:left;font:inherit;color:inherit;cursor:pointer}.count b{display:block;font-size:1.9rem;line-height:1.2}.count span{font-size:.85rem}.count[aria-pressed=true]{outline:3px solid #245d67;outline-offset:2px}.toolbar{display:flex;gap:14px;align-items:end;flex-wrap:wrap;margin:24px 0 14px}.search{flex:1;min-width:220px}label{display:block;font-size:.8rem;font-weight:650;margin-bottom:5px}input,select,.all{font:inherit;color:inherit;border:1px solid #aabbbd;border-radius:7px;background:#fff;padding:11px 13px}input{width:100%}.all{cursor:pointer}.visible{font-size:.85rem;color:#52646a;margin:10px 0}.task{background:#fff;border:1px solid #d8e0df;border-radius:10px;margin:10px 0;overflow:hidden}.task summary{display:flex;align-items:center;gap:16px;cursor:pointer;padding:17px 20px;list-style:none}.task summary:before{content:'+';font-weight:bold;color:#436a73}.task details[open]>summary:before{content:'−'}.task-title{min-width:0;flex:1}.task-title b{display:block;font-size:.97rem}.task-title small{display:block;color:#607078;margin-top:3px}.pill{display:inline-block;min-width:80px;text-align:center;font-size:.75rem;font-weight:650;padding:5px 8px;border-radius:5px;background:#edf1f2;color:#455966}.fail{color:#962c23}.pill.fail,.count.fail{background:#fff1ed}.partial{color:#8b5319}.pill.partial{background:#fff1d8}.blocked{color:#64528a}.pill.blocked{background:#eee9f7}.not_run{color:#596b77}.pill.not_run{background:#edf1f4}.pass{color:#21685b}.pill.pass{background:#e6f3ed}.by_design{color:#326174}.pill.by_design{background:#e8f3f7}.task-body{padding:0 22px 22px 55px;overflow-wrap:anywhere;font-size:.9rem}.task-body p{margin:8px 0;white-space:pre-wrap}li{margin:5px 0}ul,ol{padding-left:23px}.reasons{border-left:3px solid #b9874b;padding:1px 14px;background:#faf7ef;margin:15px 0}.issue{border-left:3px solid #b84837;padding:1px 14px 12px;background:#fff5f1;margin:15px 0}.issue small{font-weight:400}.sub{border-top:1px solid #e1e8e6;margin-top:13px}.task .sub summary{padding:12px 0;font-size:.85rem;font-weight:600}.evidence{border-top:1px dashed #d3dfde;padding-bottom:10px}.notice{background:#eaf0ee;border-radius:9px;padding:15px 19px;font-size:.9rem}.notice p{margin:5px 0}.failures{margin-top:32px}.empty{padding:30px;background:white;border-radius:10px}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #187c8b;outline-offset:3px}[hidden]{display:none!important}footer{margin-top:30px;font-size:.8rem;color:#566970}@media(max-width:700px){.counts{grid-template-columns:repeat(3,1fr)}header{padding-top:30px}.task summary{padding:14px 12px;gap:8px}.task-body{padding:0 15px 18px}.pill{min-width:67px}main{padding:20px 15px}.task-title b{font-size:.9rem}}@media print{.toolbar,.counts{display:none}.task{break-inside:avoid}header{color:#172c3b;background:white;padding:0}.meta,.status-line,.eyebrow{color:#172c3b}}
</style></head><body><header><div class="eyebrow">CredentialDOMD / Operational quality</div><h1>QA task review</h1><p class="status-line">${review.readiness.ready ? 'Recorded local coverage passed' : 'Verification remains incomplete'}</p><p>${e(review.limits)}</p><p class="meta">Selected run: ${e(review.run.status)} · Browser: ${e(review.run.browser?.engine || 'not captured')}${review.run.browser?.channel ? ` (${e(review.run.browser.channel)})` : ''} · Started: ${e(review.run.startedAt || 'not captured')} · Results saved: ${e(review.run.generatedAt || 'not captured')}</p><p class="meta">${e(provenance)}</p><p class="meta">Evidence file: ${e(review.resultsPath || 'not specified')} · Review generated: ${e(review.generatedAt)}</p></header>
<main><section class="notice"><p><strong>${review.checklistItems} required checklist items</strong> · ${review.bugs.length} recorded bugs · ${review.journeys.length} journeys in this result file.</p><p>Passed means the recorded local checks passed. By design means a documented behavior difference. Missing, partial and blocked work remains open.</p>${review.readiness.reasons.length ? `<details><summary>Why coverage is not ready</summary>${bullets(review.readiness.reasons)}</details>` : ''}</section>
<section class="notice failures"><h2>Operational health · ${review.health.ready ? 'checked' : 'needs review'}</h2><p>${e(review.health.scope)}</p><p>Client errors: ${review.health.counts.client ?? 'unavailable'} · Edge errors: ${review.health.counts.edge ?? 'unavailable'} · Resurrected records: ${review.health.counts.zombies ?? 'unavailable'} · Runaway database retries: ${review.health.counts.runaway ?? 'unavailable'}</p>${review.health.claims ? `<p>Verified intentional client rows: ${review.health.claims.matchedRows} · Claimed rows absent from the final collection: ${review.health.claims.absentAtCollection}. Absent rows do not explain any surviving error.</p>` : ''}${review.health.edgeClaims ? `<p>Verified intentional edge occurrences: ${review.health.edgeClaims.matchedOccurrences}. Every claim is checked against timestamped raw logs and its recorded HTTP response.</p>` : ''}${bullets(review.health.reasons.map(r => r.detail))}${review.health.unclassified.length ? `<h4>Unclassified observed errors</h4>${bullets(review.health.unclassified.map(r => `${r.kind}: ${r.message} (${r.count} occurrence${r.count === 1 ? '' : 's'})`))}` : ''}${review.health.intentional.length ? `<details><summary>Expected or resolved error evidence (${review.health.intentional.length})</summary>${bullets(review.health.intentional.map(r => `${r.classification === 'resolved_retry' ? 'Resolved retry' : 'Deliberate test fault'} · ${r.kind}: ${r.message} (${r.count}) — ${r.reason} — ${r.test}`))}</details>` : ''}</section>
<div class="counts" aria-label="Filter by status">${counts}</div>
<div class="toolbar"><div class="search"><label for="search">Search area, task name, ID or role</label><input id="search" type="search" placeholder="For example: billing, doctor, AUTH-001"></div><div><label for="status">Status</label><select id="status"><option value="all">All statuses</option><option value="open">Needs attention</option>${STATUSES.map(s => `<option value="${s}">${labels[s]}</option>`).join('')}</select></div><button class="all" id="reset" type="button">Reset filters</button></div>
<p id="visible" class="visible" role="status" aria-live="polite">${review.tasks.length} tasks shown</p><div id="tasks">${tasks}</div><p class="empty" id="empty" hidden>No tasks match these filters.</p>
${review.bugs.some(b => !b.feature || !review.tasks.some(t => t.id === b.feature)) ? `<section class="failures"><h2>Other recorded bugs</h2>${review.bugs.filter(b => !b.feature || !review.tasks.some(t => t.id === b.feature)).map(issue).join('')}</section>` : ''}
${review.journeys.some(j => j.status !== 'passed') ? `<section class="failures"><h2>Journeys that did not pass</h2>${review.journeys.filter(j => j.status !== 'passed').map(j => `<div class="issue"><h4>${e(j.title)} · ${e(j.status)}</h4>${block('Spec:', j.file)}${block('Error:', j.error)}</div>`).join('')}</section>` : ''}
<footer>Local review only. All data is embedded in this file; no external scripts, fonts, trackers or network requests. Run metadata describes only what the selected input captured.</footer></main>
<script>
const search=document.getElementById('search'),status=document.getElementById('status'),tasks=[...document.querySelectorAll('.task')],buttons=[...document.querySelectorAll('[data-filter]')];
function filter(){const q=search.value.trim().toLowerCase(),s=status.value;let count=0;for(const task of tasks){const match=(s==='all'||task.dataset.status===s||(s==='open'&&!['pass','by_design'].includes(task.dataset.status)))&&task.dataset.search.includes(q);task.hidden=!match;if(match)count++;}document.getElementById('visible').textContent=count+' of '+tasks.length+' tasks shown';document.getElementById('empty').hidden=count>0;for(const b of buttons)b.setAttribute('aria-pressed',String(b.dataset.filter===s));}
search.addEventListener('input',filter);status.addEventListener('change',filter);for(const b of buttons)b.addEventListener('click',()=>{status.value=b.dataset.filter;filter();});document.getElementById('reset').addEventListener('click',()=>{search.value='';status.value='all';filter();});filter();
</script></body></html>`;
}

export function writeReview({ checklistFile = path.join(QA_LAB_DIR, 'checklist.json'), resultsFile = path.join(GENERATED_DIR, 'results.json'), outDir = path.join(GENERATED_DIR, 'review') } = {}) {
  const checklist = JSON.parse(readFileSync(checklistFile, 'utf8'));
  const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : null;
  const review = buildReview(checklist, results, { resultsPath: path.resolve(resultsFile) });
  mkdirSync(outDir, { recursive: true });
  const json = path.resolve(outDir, 'review.json'), html = path.resolve(outDir, 'index.html');
  writeFileSync(json, JSON.stringify(review, null, 2) + '\n');
  writeFileSync(html, renderHtml(review));
  return { html, json, review };
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { results: { type: 'string' }, out: { type: 'string' }, checklist: { type: 'string' } }, strict: true });
    const out = writeReview({ resultsFile: values.results, outDir: values.out, checklistFile: values.checklist });
    console.log(`QA review: ${out.html}\nEvidence: ${out.json}\nLocal coverage ready: ${out.review.readiness.ready}; ${out.review.tasks.length} tasks; ${out.review.bugs.length} recorded bugs.`);
  } catch { console.error('qa:report could not render the selected files. Check the JSON input shapes, paths and output permissions.'); process.exitCode = 1; }
}
