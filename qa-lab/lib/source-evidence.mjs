// Hash source bytes, never emit source contents or environment values into reports.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.mjs';

const appInput = name => /^(src\/|public\/|supabase\/functions\/_shared\/|qa-lab\/(?:app|lib)\/|scripts\/|index\.html$|package(?:-lock)?\.json$|vite\.config\.)/.test(name);
export function captureSource(root = REPO_ROOT) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const names = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  const full = createHash('sha256'), app = createHash('sha256');
  for (const name of names) {
    const file = path.join(root, name);
    let bytes;
    try { bytes = lstatSync(file).isSymbolicLink() ? Buffer.from(`link:${readlinkSync(file)}`) : readFileSync(file); }
    catch (e) { if (e.code === 'ENOENT') bytes = Buffer.from('deleted'); else throw e; }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const entry = `${name.length}:${name}:${digest}\n`;
    full.update(entry);
    if (appInput(name)) app.update(entry);
  }
  return { head: git(['rev-parse', 'HEAD']).trim(), dirty: !!git(['status', '--porcelain']).trim(),
    fingerprint: full.digest('hex'), appFingerprint: app.digest('hex') };
}

export function appEvidenceProblem(runtime, current) {
  if (runtime?.mode !== 'preview') return 'QA verification requires a production-mode preview build.';
  if (!runtime?.buildSource?.appFingerprint) return 'The running app has no captured build fingerprint; restart qa:lab to rebuild it.';
  if (runtime.buildSource.appFingerprint !== current.appFingerprint) return 'App source changed since the running build; restart qa:lab to rebuild it.';
  return null;
}
