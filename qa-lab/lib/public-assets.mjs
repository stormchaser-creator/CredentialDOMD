import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './paths.mjs';

// Match npm run dev/build/pretest: a clean checkout has no ignored PDF assets.
export function prepareQaPublicAssets({ root = REPO_ROOT, quiet = false } = {}) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-credential-portal.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('QA PDF assets could not be prepared. Run npm run build:portal for diagnostics before starting the lab.');
  if (!quiet && result.stdout.trim()) console.log(result.stdout.trim());
}
