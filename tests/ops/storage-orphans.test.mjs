// QA OPS-011: scripts/storage-orphans.mjs
//   * printed `delete from storage.objects` as the remedy, which removes only
//     the metadata row and leaves the file bytes billed and invisible;
//   * matched folders only to profiles.auth_user_id, so a bound continuity
//     account's original folder read "no matching profile", and a document
//     stored at <original subject>/<doc id> was not recognised as claimed.
// The query runs on a disposable PostgreSQL with the production
// clerk_storage_subjects() read out of its migration. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pgSkip } from '../credential-portal/postgresFixture.mjs';
import { startPostgres } from './pg.mjs';
import { QUERY, removalScript } from '../../scripts/storage-orphans.mjs';

test('the printed remedy removes files through the Storage API, in batches, never with SQL', () => {
  const keys = Array.from({ length: 3 }, (_, i) => `user_synthetic${i}/0000000${i}-orphan`);
  const script = removalScript(keys);
  assert.doesNotMatch(script.replace(/^\/\/.*$/gm, ''), /delete\s+from\s+storage\.objects|allow_delete_query/i);
  assert.match(script, /storage\.from\("documents"\)\.remove\(keys\.slice\(i, i \+ 100\)\)/);
  for (const k of keys) assert.ok(script.includes(JSON.stringify(k)), k);
  assert.match(script, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/, 'the key comes from the environment, never the file');
});

const continuity = fs.readFileSync(new URL('../../supabase/migrations/20260920120000_clerk_identity_continuity.sql', import.meta.url), 'utf8');
const SUBJECTS = continuity.match(/create or replace function public\.clerk_storage_subjects\(p_profile uuid\)[\s\S]*?\$\$;/)[0];

const P1 = '00000000-0000-4000-8000-0000000000c1', P2 = '00000000-0000-4000-8000-0000000000c2';
const D_PATH = '00000000-0000-4000-8000-00000000d001', D_NEW = '00000000-0000-4000-8000-00000000d002', D_OLD = '00000000-0000-4000-8000-00000000d003';

test('on PostgreSQL: a bound account\'s original folder is an existing account, and its <subject>/<doc id> files are claimed', { skip: pgSkip(), timeout: 60000 }, async (t) => {
  const pg = await startPostgres(58475, 'storage-orphans');
  t.after(() => pg.close());
  await pg.sql(`
    create schema storage;
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb, created_at timestamptz default now());
    create table public.profiles (id uuid primary key, auth_user_id text);
    create table public.documents (id uuid primary key, user_id uuid, storage_path text);
    create table public.clerk_continuity_accounts (id uuid primary key default gen_random_uuid(), profile_id uuid, source_subject text, state text, target_subject text);
    ${SUBJECTS}
    insert into public.profiles values ('${P1}', 'user_NEW1'), ('${P2}', 'user_PLAIN2');
    insert into public.clerk_continuity_accounts (profile_id, source_subject, state, target_subject) values ('${P1}', 'user_OLD1', 'bound', 'user_NEW1');
    insert into public.documents values
      ('${D_PATH}', '${P1}', 'user_OLD1/${D_PATH}'),
      ('${D_NEW}', '${P1}', null),
      ('${D_OLD}', '${P1}', null);
    insert into storage.objects (bucket_id, name, metadata) values
      ('documents', 'user_OLD1/${D_PATH}', '{"size": 10}'),
      ('documents', 'user_NEW1/${D_NEW}', '{"size": 10}'),
      ('documents', 'user_OLD1/${D_OLD}', '{"size": 10}'),
      ('documents', 'user_OLD1/00000000-0000-4000-8000-00000000dead', '{"size": 7}'),
      ('documents', 'user_GONE9/00000000-0000-4000-8000-00000000beef', '{"size": 5}'),
      ('documents', 'user_PLAIN2/00000000-0000-4000-8000-00000000feed', '{"size": 3}'),
      ('documents', 'tickets/x/screenshot-0.png', '{"size": 1}'),
      ('backups', 'user_GONE9/2026-09/backup.zip', '{"size": 1}');`);
  const rows = await pg.rows(QUERY);
  assert.deepEqual(rows.map((r) => [r.name, r.owner_exists]), [
    ['user_GONE9/00000000-0000-4000-8000-00000000beef', false],
    ['user_OLD1/00000000-0000-4000-8000-00000000dead', true],
    ['user_PLAIN2/00000000-0000-4000-8000-00000000feed', true],
  ], 'the file stored under the original subject with no storage_path is claimed; the original folder is an existing account');
});
