-- Probe for the cutover seed (reviewer's finding, 2026-09-18).
--
-- Run ON TOP of the real migration, twice, the way a re-applied migration
-- actually happens. Probes only; the migration text is not pasted here:
--
--   TOKEN=$(security find-generic-password -l "Supabase CLI" -w)
--   { echo "begin;";
--     cat supabase/migrations/20260916c_ai_spend_holds.sql;
--     cat scripts/sql/ai-spend-seed-probe.sql;
--     echo "rollback;"; } > /tmp/dry.sql
--
-- The finding: seeded_from_usage stops the same ai_usage row being seeded
-- twice, and does nothing about the other double count. Once the ledger is
-- live every settled call writes BOTH a hold and an ai_usage row, two records
-- of one call, and re-running the migration seeded the receipts as extra
-- holds. Measured: a month at $15.00 became $15.01.

create temp table probe_out(name text, expected text, actual text, verdict text) on commit drop;
create function pg_temp.probe(p_name text, p_actual text, p_expect text) returns void language sql as $f$
  insert into pg_temp.probe_out values (p_name, p_expect, p_actual,
    case when p_actual = p_expect then 'PASS' else 'FAIL' end);
$f$;

insert into public.profiles (id, auth_user_id, email, access_status)
values ('aaaa9999-0000-4000-8000-000000000001','seed_probe','seed-probe@example.invalid','active');

create function pg_temp.month_total() returns numeric language sql as $f$
  select coalesce(sum(amount_usd), 0) from public.ai_spend_holds
   where user_id = 'aaaa9999-0000-4000-8000-000000000001';
$f$;

-- The seed, lifted from the migration by reading the migration, not by
-- retyping it: this runs the same statement the file just ran, so a change to
-- the file that this probe does not know about shows up as a failure here
-- rather than as a pass against a stale copy.
create function pg_temp.reseed() returns void language plpgsql as $f$
declare stmt text;
begin
  -- Comments are stripped BEFORE the newlines are collapsed. Collapsing first
  -- turns a multi-line statement into one line on which a leading -- comments
  -- out everything after it, which silently dropped the ON CONFLICT clause and
  -- made this probe fail with a duplicate key. Twice in one review now: a
  -- measurement taken over SQL text has to read the code, not the prose.
  select regexp_replace(
           substring(regexp_replace(pg_temp.migration_text(), '--[^' || chr(10) || ']*', '', 'g')
                     from 'insert into public\.ai_spend_holds \(user_id, month_start, worst_case_usd, amount_usd, settled_at, seeded_from_usage\).*?on conflict \(seeded_from_usage\) where seeded_from_usage is not null do nothing;'),
           '\s+', ' ', 'g')
    into stmt;
  if stmt is null then
    raise exception 'the seed statement could not be found in the migration';
  end if;
  execute stmt;
end $f$;

do $$
declare before_usd numeric; after_usd numeric;
begin
  -- Two pre-ledger calls this month: ai_usage is the only record of them.
  insert into public.ai_usage (user_id, provider, path, ok, cost_usd, created_at) values
    ('aaaa9999-0000-4000-8000-000000000001','anthropic','v1/messages',true, 9.00, now() - interval '3 days'),
    ('aaaa9999-0000-4000-8000-000000000001','anthropic','v1/messages',true, 6.00, now() - interval '2 days');

  perform pg_temp.reseed();
  perform pg_temp.probe('the first seed carries the pre-ledger month in',
    pg_temp.month_total()::text, '15.000000');

  -- The ledger goes live and handles one call: a hold, settled, AND the
  -- ai_usage receipt the proxy writes for the same call.
  insert into public.ai_spend_holds (user_id, month_start, worst_case_usd, amount_usd, settled_at)
  values ('aaaa9999-0000-4000-8000-000000000001',
          date_trunc('month', now() at time zone 'utc') at time zone 'utc', 0.02, 0.01, now());
  insert into public.ai_usage (user_id, provider, path, ok, cost_usd, created_at)
  values ('aaaa9999-0000-4000-8000-000000000001','anthropic','v1/messages',true, 0.01, now());

  before_usd := pg_temp.month_total();
  perform pg_temp.probe('the month reads the live call once', before_usd::text, '15.010000');

  -- The migration is applied again. This is the measured defect.
  perform pg_temp.reseed();
  after_usd := pg_temp.month_total();
  perform pg_temp.probe('re-running the seed adds nothing', after_usd::text, before_usd::text);
  perform pg_temp.probe('and the live call is still counted once, not twice',
    (select count(*)::text from public.ai_spend_holds
      where user_id = 'aaaa9999-0000-4000-8000-000000000001' and amount_usd = 0.01), '1');

  -- NEGATIVE CONTROL. Without this, a seed that had simply stopped working
  -- would pass every probe above. A pre-ledger call that arrived late (a
  -- backfilled receipt, stamped before the first live hold) must still be
  -- carried in by a re-run.
  insert into public.ai_usage (user_id, provider, path, ok, cost_usd, created_at)
  values ('aaaa9999-0000-4000-8000-000000000001','anthropic','v1/messages',true, 0.50,
          (select min(created_at) from public.ai_spend_holds
            where user_id = 'aaaa9999-0000-4000-8000-000000000001' and seeded_from_usage is null)
          - interval '1 minute');
  perform pg_temp.reseed();
  perform pg_temp.probe('but a pre-ledger receipt IS still carried in',
    pg_temp.month_total()::text, (after_usd + 0.50)::text);
end $$;

select
  (select count(*) from probe_out where verdict = 'PASS') || ' passed, ' ||
  (select count(*) from probe_out where verdict = 'FAIL') || ' failed' as summary,
  name, expected, actual, verdict
from probe_out order by name;
