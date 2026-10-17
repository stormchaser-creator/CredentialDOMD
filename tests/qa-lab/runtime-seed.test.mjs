import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startPostgres } from '../ops/pg.mjs';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { assertRuntimeSeedCounts, RUNTIME_SEED_COUNTS_SQL, seedFileVersion } from '../../qa-lab/apply-schema.mjs';

const seed = readFileSync(new URL('../../qa-lab/seed.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../supabase/migrations/20260930220000_reminder_delivery_queue.sql', import.meta.url), 'utf8');
const added = ['reminder_email_drain', 'support_operations_config', 'owner_notify_settings'];
const insert = name => {
  const found = seed.match(new RegExp(`insert into public\\.${name}\\s*\\([^;]+;`, 'i'));
  assert.ok(found, `${name} has its migration-created bootstrap row in the seed`);
  return found[0];
};

test('catalog-only QA bootstrap restores worker/configuration rows without resetting a held lease or operator settings', { skip: pgSkip(), timeout: withSlotWait(30000) }, async t => {
  const pg = await startPostgres(59817, 'qa-runtime-seed');
  t.after(() => pg.close());
  await pg.sql(`create role anon; create role authenticated; create role service_role;
    create table public.profiles(id uuid primary key);
    create table public.access_policy_settings(singleton boolean primary key);
    create table public.vera_source_settings(singleton boolean primary key);
    create table public.welcome_email_settings(singleton boolean primary key);
    create table public.support_operations_config(singleton boolean primary key, mode text default 'disabled');
    create table public.owner_notify_settings(singleton boolean primary key, enabled boolean default true);
    insert into public.access_policy_settings values(true);
    insert into public.vera_source_settings values(true);
    insert into public.welcome_email_settings values(true);`);
  // Recreate what catalog extraction produces: real queue DDL and claim
  // function, with the migration's INSERT omitted because it is not DDL.
  const schemaOnly = migration.slice(migration.indexOf('create table if not exists public.reminder_email_queue'), migration.indexOf('create or replace function public.reminder_queue_payload'))
    .replace(/insert into public\.reminder_email_drain\(singleton\) values\(true\) on conflict do nothing;/, '');
  await pg.sql(schemaOnly);
  await pg.sql(`insert into public.profiles values('00000000-0000-4000-8000-000000000001');
    insert into public.reminder_email_queue(profile_id,reminder_day) values('00000000-0000-4000-8000-000000000001',current_date);`);
  const counts = async () => JSON.parse(await pg.sql(RUNTIME_SEED_COUNTS_SQL));
  assert.throws(() => assertRuntimeSeedCounts(null), /QA runtime seed rows missing/);
  const before = await counts();
  assert.throws(() => assertRuntimeSeedCounts(before), /reminder_email_drain, support_operations_config, owner_notify_settings/);
  assert.equal(await pg.sql('select count(*) from public.reminder_queue_claim(1)'), '0', 'the schema-only defect silently claims nothing');
  assert.equal(await pg.sql('select attempts from public.reminder_email_queue'), '0');

  for (const name of added) await pg.sql(insert(name));
  const after = await counts();
  assert.doesNotThrow(() => assertRuntimeSeedCounts(after));
  assert.equal(await pg.sql('select mode from public.support_operations_config'), 'disabled');
  assert.equal(await pg.sql('select count(*) from public.reminder_queue_claim(1)'), '1', 'the worker can now claim its pending job');
  const lease = await pg.sql('select lease_token::text from public.reminder_email_drain');
  assert.ok(lease);
  await pg.sql("update public.owner_notify_settings set enabled=false; update public.support_operations_config set mode='shadow'");
  for (const name of added) await pg.sql(insert(name));
  assert.equal(await pg.sql('select lease_token::text from public.reminder_email_drain'), lease, 'bootstrap never resets an active lease');
  assert.equal(await pg.sql('select enabled from public.owner_notify_settings'), 'f', 'an explicit operator pause stays paused');
  assert.equal(await pg.sql('select mode from public.support_operations_config'), 'shadow');
  assert.equal(await pg.sql('select count(*) from public.reminder_queue_claim(1)'), '0', 'a second drain remains excluded');
  assert.equal(seedFileVersion(seed), 5, 'older lab databases must be rebuilt instead of silently reused');
});

