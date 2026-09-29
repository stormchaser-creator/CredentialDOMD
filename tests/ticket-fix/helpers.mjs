// Shared synthetic fixtures for tests/ticket-fix. Nothing here is real ticket
// text, a real name, a real email or a production value.
import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRunner, sha256Hex, hmacMessage } from '../../scripts/ticket-fix/reply.mjs';

export const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const TICKET = uuid(4242);
export const OWNER = uuid(9001);

function git(dir, args, date = null, committer = null) {
  const env = { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}),
    ...(committer ? { GIT_COMMITTER_NAME: 'CredentialDOMD Ticket Agent', GIT_COMMITTER_EMAIL: committer } : {}) };
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
  // date: an ISO time for the commit; committer: the run identity a
  // ticket-agent.sh model commits with (null: the synthetic tester).
  const commit = (entries, message = 'Synthetic change', date = null, committer = null) => {
    write(entries);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', message], date, committer);
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

// The verification recipe, restated for tests: a row the database accepts
// for this body (or refuses, with the wrong key). reply.mjs does not export
// its signer; it signs only replies it prepared and checked itself.
export function signForTest({ ticketId, body, report = { path: 'test' }, secret, id = randomUUID() }) {
  const verification = { id, ticket_id: ticketId, body_sha256: sha256Hex(body), report };
  return { ...verification, hmac: createHmac('sha256', Buffer.from(secret, 'utf8')).update(hmacMessage(verification), 'utf8').digest('hex') };
}
// The committer identity ticket-agent.sh gives one run's model.
export const runCommitter = (id = '0123456789abcdef') => `ticket-agent+${id}@credentialdomd.invalid`;
