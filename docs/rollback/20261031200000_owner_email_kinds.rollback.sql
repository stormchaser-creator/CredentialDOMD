-- Rollback for supabase/migrations/20261031200000_owner_email_kinds.sql.
-- Restores owner_notify_claim as 20261014110000 defined it: every kind the
-- notifier's rows return is emailed again.
-- No top-level transaction: run it with apply-migration.sh.

create or replace function public.owner_notify_claim(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.owner_notify_settings%rowtype; retry public.owner_notify_sends%rowtype; v_send uuid; picked jsonb; n integer;
begin
  perform pg_advisory_xact_lock(hashtext('owner_notify_claim'));
  select * into s from public.owner_notify_settings where singleton;
  if not found or not s.enabled then return jsonb_build_object('state', 'off'); end if;
  delete from public.owner_notify_ledger where claimed_at < now() - interval '30 days';
  -- An email not confirmed sent: the same text again, under the same key.
  select * into retry from public.owner_notify_sends
   where status <> 'sent' and attempts < 5 and created_at > now() - interval '23 hours' and body is not null
     and (status <> 'pending' or coalesce(last_attempt_at, created_at) < now() - interval '5 minutes')
     and (last_attempt_at is null or last_attempt_at <= now() - (interval '10 minutes' * power(2, greatest(attempts - 1, 0))))
   order by created_at limit 1 for update skip locked;
  if found then
    update public.owner_notify_sends set status = 'pending', attempts = attempts + 1, last_attempt_at = now() where id = retry.id;
    return jsonb_build_object('state', 'retry', 'sendId', retry.id, 'attempt', retry.attempts + 1, 'subject', retry.subject, 'body', retry.body);
  end if;
  -- A claim whose text never got stored (its function died before prepare): its keys go back.
  delete from public.owner_notify_ledger l using public.owner_notify_sends d
   where l.send_id = d.id and d.body is null and d.status = 'pending' and d.created_at < now() - interval '5 minutes';
  delete from public.owner_notify_sends where body is null and status = 'pending' and created_at < now() - interval '5 minutes';
  with fresh as (
    select r.* from public.owner_notify_rows(greatest(s.started_at, now() - interval '7 days')) r
     where not exists (select 1 from public.owner_notify_ledger l where l.key = r.key)
     order by r.created_at limit greatest(1, least(coalesce(p_limit, 100), 200))
  ), dedup as (select distinct on (key) * from fresh order by key, created_at)
  select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at), '[]'::jsonb), count(*) into picked, n from dedup d;
  if n = 0 then return jsonb_build_object('state', 'none'); end if;
  insert into public.owner_notify_sends (row_count, attempts, last_attempt_at) values (n, 1, now()) returning id into v_send;
  insert into public.owner_notify_ledger (key, send_id) select x->>'key', v_send from jsonb_array_elements(picked) x on conflict (key) do nothing;
  return jsonb_build_object('state', 'new', 'sendId', v_send, 'attempt', 1, 'rows', picked);
end $$;

drop function if exists public.owner_notify_email_kinds();
