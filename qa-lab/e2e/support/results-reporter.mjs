// Playwright reporter: turns the journeys' qa.feature / qa.bug records into
// qa-lab/.generated/results.json, keyed by checklist id (or into this run's own
// file with QA_E2E_RESULTS, parallel-safe mode: support/run-options.mjs).
//
// The required feature checklist is tracked as qa-lab/checklist.json. QA_FEATURES
// can select another checklist. Missing or invalid manifests fail the run;
// observed journey evidence is still written so the failure is diagnosable.
//
// Status of one checklist id across every journey that touched it:
//   fail       any journey's stretch for it failed (a check, or the stretch threw)
//   by_design  none failed it, and a journey recorded (qa.byDesign) that the
//              product differs from the checklist's expectation on purpose, or
//              in a way verified not to be a product bug (the reason is in
//              the evidence)
//   partial    some evidence passed (or is by design), but another required
//              stretch was blocked or never recorded evidence
//   pass       every recorded stretch passed, with no blocked stretches
//   blocked    journeys reached it only to record that the lab cannot exercise
//              it, or never reached it because an earlier stretch failed
//   not_run    no journey covers it yet
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { DEFAULT_RESULTS_JSON, resultsFile } from './run-options.mjs';
import { safeMembershipEvidence } from './membership-responses.mjs';

/** The shared default results file; a run with QA_E2E_RESULTS writes its own (resultsFile()). */
export const RESULTS_JSON = DEFAULT_RESULTS_JSON;
export function featuresPath() {
  return process.env.QA_FEATURES || path.join(REPO_ROOT, 'qa-lab', 'checklist.json');
}

const STATUSES = new Set(['fail', 'by_design', 'pass', 'blocked', 'not_run']);
/** ANSI colour codes in Playwright's error text (built from the ESC code so no control character sits in a regex literal). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const EMPTY = () => ({ pass: 0, fail: 0, partial: 0, blocked: 0, by_design: 0, not_run: 0 });

function evidenceStatus(evidence) {
  const statuses = new Set(evidence.map((e) => e.status));
  if (statuses.has('fail')) return 'fail';
  const completed = statuses.has('pass') || statuses.has('by_design');
  if (completed && (statuses.has('blocked') || statuses.has('not_run'))) return 'partial';
  if (statuses.has('by_design')) return 'by_design';
  if (statuses.has('pass')) return 'pass';
  return statuses.has('blocked') ? 'blocked' : 'not_run';
}

function readChecklist(fp) {
  if (!existsSync(fp)) return { rows: [], info: { path: fp, missing: true } };
  try {
    const rows = JSON.parse(readFileSync(fp, 'utf8'));
    if (!Array.isArray(rows) || !rows.length) throw new Error('Expected a nonempty array of features');
    const ids = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !/^[A-Z]+-\d{3}$/.test(row.id || '')) throw new Error('Every feature needs a valid checklist id');
      if (ids.has(row.id)) throw new Error(`Duplicate feature id: ${row.id}`);
      ids.add(row.id);
    }
    return { rows, info: { path: fp, features: rows.length } };
  } catch {
    // Do not print parser errors: their excerpts may contain private checklist data.
    return { rows: [], info: { path: fp, invalid: true, error: 'Checklist must be valid JSON containing a nonempty array of uniquely identified features.' } };
  }
}

export default class ResultsReporter {
  constructor(options = {}) { this.options = options; this.tests = []; this.started = new Date(); }

  onTestEnd(test, result) {
    const parse = (type) => result.annotations.concat(test.annotations).filter((a) => a.type === type).map((a) => { try { return JSON.parse(a.description); } catch { return null; } }).filter(Boolean);
    const seen = new Set();
    const features = parse('qa-feature').filter((f) => { const k = JSON.stringify(f); if (seen.has(k)) return false; seen.add(k); return true; });
    const bugSeen = new Set();
    const bugs = parse('qa-bug').filter((b) => { const k = JSON.stringify(b); if (bugSeen.has(k)) return false; bugSeen.add(k); return true; });
    // Playwright exposes the same annotation through test and result. Dedup
    // those copies only, never observations from different attempts.
    const healthSeen = new Set();
    const healthClaims = parse('qa-health-client').filter(claim => { const key = JSON.stringify(claim); if (healthSeen.has(key)) return false; healthSeen.add(key); return true; });
    const uniqueAnnotations = type => {
      const seen = new Set();
      return parse(type).filter(row => { const key = JSON.stringify(row); if (seen.has(key)) return false; seen.add(key); return true; });
    };
    const edgeRequests = uniqueAnnotations('qa-health-edge-request');
    const edgeClaims = uniqueAnnotations('qa-health-edge-claim');
    const membershipResponses = uniqueAnnotations('qa-membership-response').map(safeMembershipEvidence);
    const tags = test.tags.map((t) => t.replace(/^@/, '')).filter((t) => /^[A-Z]+-\d{3}$/.test(t));
    const shots = result.attachments.filter((a) => a.contentType === 'image/png' && a.path).map((a) => a.path);
    const browser = parse('qa-browser').find(row => ['chromium', 'webkit', 'firefox'].includes(row.name))?.name || null;
    this.tests.push({
      browser,
      title: test.titlePath().slice(1).join(' > '), file: path.relative(REPO_ROOT, test.location.file), status: result.status,
      durationMs: result.duration, retry: result.retry, repeatEachIndex: test.repeatEachIndex || 0, tags, features, bugs, shots, healthClaims, edgeRequests, edgeClaims, membershipResponses,
      error: result.error ? String(result.error.message || '').replace(ANSI, '').split('\n').slice(0, 12).join('\n') : null,
    });
  }

  onEnd(fullResult) {
    // Nothing ran (--list, or a filter that matched nothing): keep the last results.
    if (!this.tests.length) return;
    // Keep only the last attempt of each test.
    const last = new Map();
    for (const t of this.tests) last.set(`${t.file}::${t.title}`, t);
    const journeys = [...last.values()];

    const fp = featuresPath();
    const { rows: checklist, info: checklistInfo } = readChecklist(fp);
    const byId = new Map(checklist.map((f) => [f.id, f]));

    const out = Object.create(null);
    const touch = (id) => (out[id] ||= { status: 'not_run', name: byId.get(id)?.name || null, priority: byId.get(id)?.priority || null, area: byId.get(id)?.area || null, evidence: [] });
    for (const f of checklist) touch(f.id);
    for (const j of journeys) {
      const recorded = new Set();
      for (const f of j.features) {
        recorded.add(f.id);
        const entry = touch(f.id);
        const status = STATUSES.has(f.status) ? f.status : 'fail';
        entry.evidence.push({ journey: j.title, file: j.file, status, stretch: f.title || undefined, checks: f.checks, screenshots: f.shots, error: f.error, reason: f.reason });
      }
      // A tag names intended coverage, never evidence that the feature worked.
      for (const id of j.tags) {
        if (recorded.has(id)) continue;
        const entry = touch(id);
        entry.evidence.push({ journey: j.title, file: j.file, status: 'blocked', reason: j.status === 'passed' ? 'tagged but no feature evidence was recorded' : `not reached: the journey stopped earlier (${j.status}${j.error ? `: ${j.error.split('\n')[0]}` : ''})`, screenshots: j.shots });
      }
    }
    for (const entry of Object.values(out)) entry.status = evidenceStatus(entry.evidence);
    const summary = EMPTY();
    for (const v of Object.values(out)) summary[v.status] += 1;
    const byPriority = {};
    for (const v of Object.values(out)) { const p = v.priority || 'unknown'; byPriority[p] ||= EMPTY(); byPriority[p][v.status] += 1; }

    const checklistUnavailable = checklistInfo.invalid || checklistInfo.missing;
    const runStatus = checklistUnavailable ? 'failed' : fullResult.status;
    const bugs = journeys.flatMap((j) => j.bugs);
    // This is readiness of the local lab coverage only. It never certifies
    // provider delivery, a production deployment, or real-device acceptance.
    const reasons = [];
    if (checklistInfo.invalid) reasons.push({ code: 'invalid-checklist', detail: checklistInfo.error });
    if (checklistInfo.missing) reasons.push({ code: 'missing-checklist', detail: 'The full set of required features is unavailable.' });
    if (runStatus !== 'passed') reasons.push({ code: 'run-not-passed', detail: runStatus });
    if (bugs.length) reasons.push({ code: 'recorded-bugs', count: bugs.length });
    for (const [id, entry] of Object.entries(out)) {
      if (!['pass', 'by_design'].includes(entry.status)) reasons.push({ code: 'incomplete-feature', feature: id, status: entry.status });
      if (checklist.length && !byId.has(id)) reasons.push({ code: 'unknown-feature', feature: id });
    }

    const results = {
      generatedAt: new Date().toISOString(), startedAt: this.started.toISOString(), runStatus,
      checklist: checklistInfo,
      summary, byPriority,
      browserEngines: Object.fromEntries([...new Set(journeys.map(j => j.browser || "unrecorded"))].map(name => [name, journeys.filter(j => (j.browser || "unrecorded") === name).length])),
      readiness: { scope: 'local-lab', ready: reasons.length === 0, reasons },
      journeys: journeys.map((j) => ({ title: j.title, file: j.file, status: j.status, durationMs: j.durationMs, browser: j.browser, features: [...new Set([...j.features.map((f) => f.id), ...j.tags])], error: j.error, screenshots: j.shots })),
      bugs,
      // Health covers the entire run, including failed/retried attempts whose
      // feature verdict was superseded. Final lab collection verifies these IDs.
      // Diagnostics only: retain every attempt, including passing journeys. Never reduce health errors here.
      membershipResponses: this.tests.flatMap(j => (j.membershipResponses || []).map(row => ({ ...row,
        test: j.title, file: j.file, retry: j.retry, repeatEachIndex: j.repeatEachIndex, attemptStatus: j.status }))),
      healthClientClaims: this.tests.flatMap(j => j.healthClaims.map(claim => ({ ...claim,
        test: j.title, file: j.file, retry: j.retry, repeatEachIndex: j.repeatEachIndex, attemptStatus: j.status }))),
      healthEdgeRequests: this.tests.flatMap(j => j.edgeRequests.map(row => ({ ...row,
        test: j.title, file: j.file, retry: j.retry, repeatEachIndex: j.repeatEachIndex, attemptStatus: j.status }))),
      healthEdgeClaims: this.tests.flatMap(j => j.edgeClaims.map(row => ({ ...row,
        test: j.title, file: j.file, retry: j.retry, repeatEachIndex: j.repeatEachIndex, attemptStatus: j.status }))),
      // What journeys found to differ from the checklist on purpose (or verified not a product bug), with why.
      byDesign: journeys.flatMap((j) => j.features.filter((f) => f.status === 'by_design').map((f) => ({ feature: f.id, finding: f.title || null, reason: f.reason || null, journey: j.title, file: j.file }))),
      features: Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b))),
    };
    const file = this.options.outputFile || resultsFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
    console.log(`\nqa-e2e: results ${file}\n  features: ${summary.pass} pass, ${summary.fail} fail, ${summary.partial} partial, ${summary.by_design} by design, ${summary.blocked} blocked, ${summary.not_run} not run; bugs recorded: ${results.bugs.length}; local coverage ready: ${results.readiness.ready}`);
    if (checklistUnavailable) return { status: 'failed' };
  }

  printsToStdio() { return false; }
}
