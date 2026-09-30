// How one run of the journeys is set up (npm run qa:e2e), read from its
// environment. Shared by the runner (run.mjs), the Playwright configuration,
// the results reporter and the journeys, so all four agree.
//
// Several authors (people or agents) may run different spec files against ONE
// running lab at the same time. Parallel-safe mode keeps each run to its own
// files and stops any run from taking the lab away from the others:
//
//   QA_E2E_RESULTS=<file.json>  this run's results instead of .generated/results.json.
//                               Playwright's traces and HTML report go beside it, in
//                               <file>-e2e/artifacts and <file>-e2e/html: Playwright
//                               empties its output folder when a run starts and its
//                               report folder when a run ends, so shared folders would
//                               delete another run's traces mid-run. The file must be
//                               under qa-lab/.generated/ (gitignored) or outside the
//                               repository; a relative path is taken from where npm was run.
//   QA_E2E_NO_RESTART=1         never restart the lab's PostgREST (the runner only
//                               counts sessions stuck re-running a refused
//                               admin_change_profile_access; the owner-controls journey
//                               ends its own with pg_terminate_backend instead of a restart).
//
// Either one turns parallel-safe mode on, which also refuses --fresh (it wipes the
// database everyone is using) and never starts or stops the lab (a lab a run
// started would be stopped under the others when that run ends).
import path from 'node:path';
import { GENERATED_DIR, REPO_ROOT } from '../../lib/paths.mjs';

export const DEFAULT_RESULTS_JSON = path.join(GENERATED_DIR, 'results.json');
export const DEFAULT_E2E_DIR = path.join(GENERATED_DIR, 'e2e');

/** An on/off environment switch: 1, true, yes or on (any case) is on. */
export function envFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

const inside = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The results file of this run: QA_E2E_RESULTS (absolute, or relative to where
 * npm was run: INIT_CWD, else the working directory), or the default
 * qa-lab/.generated/results.json. Refuses a file that is not .json, one inside
 * the repository but outside qa-lab/.generated/ (it would be committed to a
 * public repository), and the default file itself (not a run's own).
 */
export function resultsFile(env = process.env, cwd = process.cwd()) {
  const raw = String(env.QA_E2E_RESULTS ?? '').trim();
  if (!raw) return DEFAULT_RESULTS_JSON;
  const file = path.resolve(env.INIT_CWD || cwd, raw);
  if (!/\.json$/i.test(file)) throw new Error(`QA_E2E_RESULTS must name a .json file: ${file}`);
  if (inside(REPO_ROOT, file) && !inside(GENERATED_DIR, file)) {
    throw new Error(`QA_E2E_RESULTS must be under qa-lab/.generated/ (gitignored) or outside the repository, not ${path.relative(REPO_ROOT, file)} (the repository is public)`);
  }
  if (file === DEFAULT_RESULTS_JSON) throw new Error('QA_E2E_RESULTS names the shared qa-lab/.generated/results.json; give this run a file of its own, e.g. qa-lab/.generated/runs/<name>.json');
  return file;
}

/** Where this run writes: its results file, Playwright's output folder (traces) and its HTML report. */
export function runOutputs(env = process.env, cwd = process.cwd()) {
  const results = resultsFile(env, cwd);
  if (results === DEFAULT_RESULTS_JSON) {
    return { results, artifacts: path.join(DEFAULT_E2E_DIR, 'artifacts'), html: path.join(DEFAULT_E2E_DIR, 'html'), own: false };
  }
  const base = `${results.replace(/\.json$/i, '')}-e2e`;
  return { results, artifacts: path.join(base, 'artifacts'), html: path.join(base, 'html'), own: true };
}

/** True when this run is one of several on a shared lab (QA_E2E_RESULTS or QA_E2E_NO_RESTART set). */
export function parallelSafe(env = process.env) {
  return String(env.QA_E2E_RESULTS ?? '').trim() !== '' || envFlag(env.QA_E2E_NO_RESTART);
}

/** True when nothing in this run may restart the lab's PostgREST. */
export function noRestart(env = process.env) {
  return parallelSafe(env);
}
