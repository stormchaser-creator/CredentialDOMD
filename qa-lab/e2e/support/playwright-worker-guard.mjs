// Playwright 1.63.0 reads navigator.serviceWorker outside a try in its
// serviceWorkers:'block' initializer. WebKit throws for opaque sandbox frames.
// Patch only that pinned initializer in task-owned dependencies. Normal frames
// retain Playwright's registration blocker; opaque frames cannot use workers.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export const original = "if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };";
export const replacement = "try { const worker = navigator.serviceWorker; if (worker) worker.register = async () => { console.warn('Service Worker registration blocked by Playwright'); }; } catch (error) { if (error?.name !== 'SecurityError') throw error; }";
export function patchWorkerGuard(repoRoot) {
  const root = realpathSync(repoRoot);
  const core = realpathSync(path.join(root, 'node_modules/playwright-core'));
  if (!core.startsWith(root + path.sep)) throw new Error('QA worker guard requires private dependencies inside this checkout; refusing shared node_modules');
  const version = JSON.parse(readFileSync(path.join(core, 'package.json'), 'utf8')).version;
  if (version !== '1.63.0') throw new Error(`Review the QA worker guard for Playwright ${version}; expected 1.63.0`);
  const file = path.join(core, 'lib/coreBundle.js');
  const source = readFileSync(file, 'utf8');
  if (source.includes(replacement) && !source.includes(original)) return { version, changed: false };
  if (source.split(original).length !== 2 || source.includes(replacement)) throw new Error('Unexpected Playwright worker initializer; refusing patch');
  writeFileSync(file, source.replace(original, replacement));
  return { version, changed: true };
}
