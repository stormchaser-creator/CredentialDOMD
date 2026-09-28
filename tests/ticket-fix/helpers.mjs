// Shared synthetic fixtures for tests/ticket-fix. Nothing here is real ticket
// text, a real name, a real email or a production value.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRunner } from '../../scripts/ticket-fix/reply.mjs';

export const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const TICKET = uuid(4242);
export const OWNER = uuid(9001);

function git(dir, args, date = null) {
  const env = date ? { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : process.env;
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=Synthetic Tester', '-c', 'user.email=tester@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env });
  if (r.status !== 0) throw Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
// A throwaway repository with committed files; commit() adds more and
// returns the new full SHA.
export function tempRepo(files) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ticket-fix-repo-')));
  git(dir, ['init', '-q', '-b', 'main']);
  const write = entries => {
    for (const [file, content] of Object.entries(entries)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
  };
  // date: an ISO time for the commit, e.g. one "pulled in" from before a run.
  const commit = (entries, message = 'Synthetic change', date = null) => {
    write(entries);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', message], date);
    return git(dir, ['rev-parse', 'HEAD']);
  };
  const first = commit(files, 'Synthetic base');
  return { dir, first, commit, write, git: gitRunner(dir), run: args => git(dir, args), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
export function privateDir(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
// A version.json stand-in: the live build is the given commit.
export const liveBuild = sha => async () => ({ build: `20260928T1200-${sha.slice(0, 7)}`, short: sha.slice(0, 7) });
export const noBuild = async () => { throw Error('offline'); };
