-- At most one owner alert a day when the intake's model reading fails.
-- File: supabase/migrations/20261117120000_intake_ai_alerts.sql
-- Rollback: docs/rollback/20261117120000_intake_ai_alerts.rollback.sql
--
-- WHY. The Anthropic intake key ran out of credit on 2026-11-05 and every
-- forward to docs@ was read by the keyword rules for twelve days before
-- anyone noticed. email-inbound (_shared/intakeAiAlert.mjs) can now email the
-- owner when a provider answers with an error, but only when the function's
-- INTAKE_AI_FAILURE_ALERTS is on, and never more than once in 24 hours.
--
-- WHAT.
--   intake_ai_alerts: one row per alert claimed (provider names, a short why,
--     when it was sent). Service role only; rows older than 30 days are
--     dropped by the next claim.
--   claim_intake_ai_alert(provider, detail): the row's id when no alert was
--     claimed in the last 24 hours, else null. Serialised by an advisory
--     lock, so two failing emails at once claim one alert. A failed send
--     deletes its row (the function does that), so the next failure retries.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

create table if not exists public.intake_ai_alerts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  provider text not null check (length(provider) <= 40),
  detail text not null default '' check (length(detail) <= 500),
  sent_at timestamptz
);
create index if not exists intake_ai_alerts_created_at on public.intake_ai_alerts (created_at desc);
alter table public.intake_ai_alerts enable row level security;
revoke all on public.intake_ai_alerts from public, anon, authenticated, service_role;
grant select, update, delete on public.intake_ai_alerts to service_role;

create or replace function public.claim_intake_ai_alert(p_provider text, p_detail text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('claim_intake_ai_alert'));
  delete from public.intake_ai_alerts where created_at < now() - interval '30 days';
  if exists (select 1 from public.intake_ai_alerts where created_at > now() - interval '24 hours') then
    return null;
  end if;
  insert into public.intake_ai_alerts (provider, detail)
    values (left(coalesce(p_provider, ''), 40), left(coalesce(p_detail, ''), 500))
    returning id into v_id;
  return v_id;
end
$$;
revoke all on function public.claim_intake_ai_alert(text, text) from public, anon, authenticated;
grant execute on function public.claim_intake_ai_alert(text, text) to service_role;

comment on table public.intake_ai_alerts is
  'Owner alerts for a failing intake model reading (email-inbound, INTAKE_AI_FAILURE_ALERTS). At most one per 24 hours, claimed by claim_intake_ai_alert. Service role only.';

notify pgrst, 'reload schema';
