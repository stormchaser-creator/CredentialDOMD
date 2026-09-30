#!/usr/bin/env node
// npm run qa:founding-reset: gives the lab's $99 founding places back, and
// changes nothing else.
//
//   npm run qa:founding-reset                   free every public place a journey took more than 15 minutes ago
//   npm run qa:founding-reset -- --min-age 0    ... whatever its age (only when no journey is running)
//   npm run qa:founding-reset -- --dry-run      say what it would free; change nothing
//
// Every journey that pays takes one of the lab's 96 public founding places: a
// row in public.limited_founding_slots with no promise_email. Once 100 rows
// exist the gate offers the early-bird price and the "$99" checks fail for a
// lab reason. This deletes only those rows, in both billing modes. It never
// touches the promised places the seed made (promise_email set), the members,
// their subscriptions, receipts or quotes, or any other table, so nothing else
// in the lab is wiped (npm run qa:e2e -- --fresh rebuilds everything instead).
//
// Safe while other journeys run:
//   * it takes the advisory locks the product's claim, settle and release
//     functions take (pg_advisory_xact_lock(8222, 1) live, (8222, 0) test), so a
//     checkout claiming a place waits for the reset, or the reset for it;
//   * a place younger than --min-age (default 15 minutes, longer than any
//     journey's timeout) is kept: its journey may still be running, and every
//     later Stripe event for that member (the invoice, a portal cancel) goes
//     through settle_limited_billing_subscription, which raises "founding
//     allocation missing" once the member's place is gone.
// A member whose place was freed keeps their paid membership in the lab.
//
// The LOCAL lab database only: qa-lab/lib/local-db.mjs refuses any other host,
// and the statement refuses a database without the lab's seed (qa_lab.seed_version).
import { parseArgs } from 'node:util';
import { localExec, localJson } from './lib/local-db.mjs';
import { isMain } from './lib/paths.mjs';

export const DEFAULT_MIN_AGE_MINUTES = 15;
/** The key of the advisory lock the product's founding functions take (second key: 1 live, 0 test). */
export const FOUNDING_LOCK_KEY = 8222;
/** Places per program (limited_founding_slots.slot is 1..100). */
export const FOUNDING_CAPACITY = 100;

/** A whole number of minutes, 0 or more. */
export function minAgeMinutes(value = DEFAULT_MIN_AGE_MINUTES) {
  const n = typeof value === 'number' ? value : /^\d+$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 525600) throw new Error(`--min-age must be a whole number of minutes, 0 or more (got ${value})`);
  return n;
}

/**
 * The reset as one transaction: the lab check and both founding locks, then
 * the delete of public places (no promise_email) older than the age, then one
 * JSON line of what was freed and what was kept; rolled back for a dry run.
 */
export function foundingResetSql({ minAge = DEFAULT_MIN_AGE_MINUTES, dryRun = false } = {}) {
  const age = minAgeMinutes(minAge);
  return `begin;
do $$ begin
  if to_regclass('qa_lab.seed_version') is null then
    raise exception 'not the QA lab database (no qa_lab.seed_version): refusing to change founding places';
  end if;
  perform pg_advisory_xact_lock(${FOUNDING_LOCK_KEY}, 1);
  perform pg_advisory_xact_lock(${FOUNDING_LOCK_KEY}, 0);
end $$;
with freed as (
  delete from public.limited_founding_slots
   where promise_email is null
     and created_at < clock_timestamp() - make_interval(mins => ${age})
  returning livemode, state
)
select json_build_object(
  'freed', (select count(*) from freed),
  'byState', (select coalesce(json_object_agg(k, n), '{}'::json) from (
     select case when livemode then 'live' else 'test' end || ' ' || state as k, count(*) as n from freed group by 1) t),
  'kept', (select count(*) from public.limited_founding_slots where promise_email is null) - (select count(*) from freed),
  'minAgeMinutes', ${age},
  'dryRun', ${dryRun ? 'true' : 'false'});
${dryRun ? 'rollback' : 'commit'};`;
}

/** Public founding places left in each mode (100 minus every slot row, promised or taken), and the offer's state. */
export function foundingPlaces() {
  return localJson(`select json_build_object(
    'live', json_build_object('left', ${FOUNDING_CAPACITY} - count(*) filter (where livemode), 'taken', count(*) filter (where livemode and promise_email is null),
      'promised', count(*) filter (where livemode and promise_email is not null), 'offer', public.founding_public_state(true)),
    'test', json_build_object('left', ${FOUNDING_CAPACITY} - count(*) filter (where not livemode), 'taken', count(*) filter (where not livemode and promise_email is null),
      'promised', count(*) filter (where not livemode and promise_email is not null), 'offer', public.founding_public_state(false)))
    from public.limited_founding_slots`);
}

/** Runs the reset against the local lab database; returns what it freed and kept, and the places before and after. */
export function resetFoundingPlaces({ minAge = DEFAULT_MIN_AGE_MINUTES, dryRun = false } = {}) {
  const before = foundingPlaces();
  const out = localExec(foundingResetSql({ minAge, dryRun }));
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
  if (!line) throw new Error(`the founding reset returned nothing readable: ${out.slice(0, 200)}`);
  const result = JSON.parse(line);
  return { ...result, before, after: dryRun ? before : foundingPlaces() };
}

/** One line per mode, for the runner and the command. */
export function describeReset(r) {
  const verb = r.dryRun ? 'would free' : 'freed';
  const modes = ['live', 'test'].map((m) => {
    const states = Object.entries(r.byState || {}).filter(([k]) => k.startsWith(`${m} `)).map(([k, n]) => `${n} ${k.slice(m.length + 1)}`);
    const freed = states.length ? states.join(', ') : 'none';
    const after = r.dryRun ? r.before[m].left + states.reduce((n, s) => n + Number(s.split(' ')[0]), 0) : r.after[m].left;
    return `${m}: ${r.before[m].left} -> ${after} public places left (${verb}: ${freed})`;
  });
  const kept = r.kept ? [`kept ${r.kept} place(s) taken in the last ${r.minAgeMinutes} minutes (a journey may still be using them; --min-age 0 frees them too, when nothing is running)`] : [];
  return [...modes, ...kept];
}

export function runFoundingReset(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'min-age': { type: 'string', default: String(DEFAULT_MIN_AGE_MINUTES) }, 'dry-run': { type: 'boolean', default: false },
  } });
  const r = resetFoundingPlaces({ minAge: minAgeMinutes(values['min-age']), dryRun: values['dry-run'] });
  for (const line of describeReset(r)) console.log(`qa-founding-reset: ${line}`);
  if (!r.dryRun) console.log(`qa-founding-reset: the live offer is ${r.after.live.offer}`);
  return r;
}

if (isMain(import.meta.url)) {
  try { runFoundingReset(); } catch (e) { console.error(`qa-founding-reset: ${e.message}`); process.exit(1); }
}
