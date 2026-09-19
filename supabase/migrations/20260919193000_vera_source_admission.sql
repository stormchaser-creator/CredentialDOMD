begin;

create table if not exists public.vera_source_settings (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false
);
insert into public.vera_source_settings(singleton,enabled) values(true,false) on conflict do nothing;
create table if not exists public.vera_source_admission (
  utc_day date not null,
  subject text not null,
  requests integer not null check(requests between 1 and 1000),
  primary key(utc_day,subject)
);
alter table public.vera_source_settings enable row level security;
alter table public.vera_source_admission enable row level security;
revoke all on public.vera_source_settings,public.vera_source_admission from public,anon,authenticated,service_role;

-- Caller identity is verified by the endpoint; the service RPC rechecks the
-- exact current profile/Clerk pair and active access. Email/admin is never used.
create or replace function public.admit_vera_source(p_profile uuid,p_subject text,p_source_id text)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare d date := (clock_timestamp() at time zone 'UTC')::date;
  n integer; total_n integer;
begin
  if p_subject is null or p_subject !~ '^user_[A-Za-z0-9]+$' or p_source_id is null
    or p_source_id not in ('oh-cme-general','oh-pain-clinic','dea-mate') then return 'denied'; end if;
  perform 1 from public.vera_source_settings where singleton and enabled for share;
  if not found then return 'disabled'; end if;
  -- One short global daily lock makes global + account admission atomic across
  -- isolates, including requests served from the in-memory public cache.
  perform pg_advisory_xact_lock(951, d - date '2000-01-01');
  perform 1 from public.profiles where id=p_profile and auth_user_id=p_subject and access_status='active' for share;
  if not found then return 'denied'; end if;
  select coalesce(sum(requests),0)::integer into total_n from public.vera_source_admission where utc_day=d;
  select requests into n from public.vera_source_admission where utc_day=d and subject=p_subject;
  if total_n >= 1000 or coalesce(n,0) >= 30 then return 'quota'; end if;
  insert into public.vera_source_admission values(d,p_subject,1)
    on conflict(utc_day,subject) do update set requests=vera_source_admission.requests+1;
  return 'allowed';
end; $$;
revoke all on function public.admit_vera_source(uuid,text,text) from public,anon,authenticated;
grant execute on function public.admit_vera_source(uuid,text,text) to service_role;

commit;
