// Playwright reporter: turns the journeys' qa.feature / qa.bug records into
// qa-lab/.generated/results.json, keyed by checklist id.
//
// The checklist (features.json, 261 features with steps and expected results)
// lives outside this public repository; its path comes from QA_FEATURES or
// defaults to ../qa-data/features.json beside the worktree. Without it the
// results still list every feature a journey touched.
//
// Status of one checklist id across every journey that touched it:
//   fail     any journey's stretch for it failed (a check, or the stretch threw)
//   pass     at least one journey passed it and none failed it
//   blocked  journeys reached it only to record that the lab cannot exercise
//            it, or never reached it because an earlier stretch failed
//   not_run  no journey covers it yet
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GENERATED_DIR, REPO_ROOT } from '../../lib/paths.mjs';

export const RESULTS_JSON = path.join(GENERATED_DIR, 'results.json');
export function featuresPath() {
  return process.env.QA_FEATURES || path.resolve(REPO_ROOT, '..', 'qa-data', 'features.json');
}

const RANK = { fail: 3, pass: 2, blocked: 1, not_run: 0 };

export default class ResultsReporter {
  constructor(options = {}) { this.options = options; this.tests = []; this.started = new Date(); }

  onTestEnd(test, result) {
    const parse = (type) => result.annotations.concat(test.annotations).filter((a) => a.type === type).map((a) => { try { return JSON.parse(a.description); } catch { return null; } }).filter(Boolean);
    const seen = new Set();
    const features = parse('qa-feature').filter((f) => { const k = JSON.stringify(f); if (seen.has(k)) return false; seen.add(k); return true; });
    const bugSeen = new Set();
    const bugs = parse('qa-bug').filter((b) => { const k = JSON.stringify(b); if (bugSeen.has(k)) return false; bugSeen.add(k); return true; });
    const tags = test.tags.map((t) => t.replace(/^@/, '')).filter((t) => /^[A-Z]+-\d{3}$/.test(t));
    const shots = result.attachments.filter((a) => a.contentType === 'image/png' && a.path).map((a) => a.path);
    this.tests.push({
      title: test.titlePath().slice(1).join(' > '), file: path.relative(REPO_ROOT, test.location.file), status: result.status,
      durationMs: result.duration, retry: result.retry, tags, features, bugs, shots,
      error: result.error ? String(result.error.message || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 12).join('\n') : null,
    });
  }

  onEnd(fullResult) {
    // Nothing ran (--list, or a filter that matched nothing): keep the last results.
    if (!this.tests.length) return;
    // Keep only the last attempt of each test.
    const last = new Map();
    for (const t of this.tests) last.set(`${t.file}::${t.title}`, t);
    const journeys = [...last.values()];

    let checklist = [];
    const fp = featuresPath();
    if (existsSync(fp)) { try { checklist = JSON.parse(readFileSync(fp, 'utf8')); } catch { checklist = []; } }
    const byId = new Map(checklist.map((f) => [f.id, f]));

    const out = {};
    const touch = (id) => (out[id] ||= { status: 'not_run', name: byId.get(id)?.name || null, priority: byId.get(id)?.priority || null, area: byId.get(id)?.area || null, evidence: [] });
    for (const f of checklist) touch(f.id);
    for (const j of journeys) {
      const recorded = new Set();
      for (const f of j.features) {
        recorded.add(f.id);
        const entry = touch(f.id);
        const status = f.status === 'blocked' ? 'blocked' : f.status;
        entry.evidence.push({ journey: j.title, file: j.file, status, stretch: f.title || undefined, checks: f.checks, screenshots: f.shots, error: f.error, reason: f.reason });
        if (RANK[status] > RANK[entry.status]) entry.status = status;
      }
      // Tagged but never reached: blocked by the failure before it.
      for (const id of j.tags) {
        if (recorded.has(id)) continue;
        const entry = touch(id);
        const status = j.status === 'passed' ? 'pass' : 'blocked';
        entry.evidence.push({ journey: j.title, file: j.file, status, reason: j.status === 'passed' ? 'journey passed' : `not reached: the journey stopped earlier (${j.status}${j.error ? `: ${j.error.split('\n')[0]}` : ''})`, screenshots: j.shots });
        if (RANK[status] > RANK[entry.status]) entry.status = status;
      }
    }
    const summary = { pass: 0, fail: 0, blocked: 0, not_run: 0 };
    for (const v of Object.values(out)) summary[v.status] += 1;
    const byPriority = {};
    for (const v of Object.values(out)) { const p = v.priority || 'unknown'; byPriority[p] ||= { pass: 0, fail: 0, blocked: 0, not_run: 0 }; byPriority[p][v.status] += 1; }

    const results = {
      generatedAt: new Date().toISOString(), startedAt: this.started.toISOString(), runStatus: fullResult.status,
      checklist: existsSync(fp) ? { path: fp, features: checklist.length } : { path: fp, missing: true },
      summary, byPriority,
      journeys: journeys.map((j) => ({ title: j.title, file: j.file, status: j.status, durationMs: j.durationMs, features: [...new Set([...j.features.map((f) => f.id), ...j.tags])], error: j.error, screenshots: j.shots })),
      bugs: journeys.flatMap((j) => j.bugs),
      features: Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b))),
    };
    mkdirSync(path.dirname(RESULTS_JSON), { recursive: true });
    const file = this.options.outputFile || RESULTS_JSON;
    writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
    console.log(`\nqa-e2e: results ${file}\n  features: ${summary.pass} pass, ${summary.fail} fail, ${summary.blocked} blocked, ${summary.not_run} not run; bugs recorded: ${results.bugs.length}`);
  }

  printsToStdio() { return false; }
}
