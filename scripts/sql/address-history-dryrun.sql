begin;
create temp table probe_out(name text, expected text, actual text, verdict text) on commit drop;
insert into public.profiles (id, auth_user_id, email, access_status) values ('eeee5555-0000-4000-8000-00000000000a','probe_addr','probe-addr@example.invalid','active'),('eeee5555-0000-4000-8000-00000000000b','probe_addr2','probe-addr2@example.invalid','active');
-- Previous addresses, because every application asks for them (2026-09-18).
--
-- Hospital credentialing applications and CVOs ask for an address history,
-- usually five years and sometimes ten, and what they actually verify is that
-- it has NO GAPS. A physician who hands over three addresses with four months
-- unaccounted for gets the application returned, which is a fortnight.
--
-- Same shape as work_history, which is the closest thing already here: one
-- table, owner-scoped RLS through current_profile_id(), snake_case columns the
-- client maps from camelCase in src/lib/supabase.js.
--
-- The CURRENT address is a row here too, flagged, rather than read from
-- profiles.address. profiles.address is the mailing address a document gets
-- sent to, which is a different question, and an application wants ONE
-- unbroken list ending today. Keeping both halves in one table is what stops
-- them drifting.

create table if not exists public.address_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  street text,
  unit text,
  city text,
  state text,
  postal_code text,
  country text,
  start_date date,
  end_date date,
  is_current boolean default false,
  notes text,
  custom_fields jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- The only query the app makes: this physician's own rows, oldest first.
create index if not exists address_history_user_idx
  on public.address_history (user_id, start_date);

alter table public.address_history enable row level security;

-- Identical in shape to work_history_owner: the physician's own rows and
-- nothing else, for every verb.
drop policy if exists address_history_owner on public.address_history;
create policy address_history_owner on public.address_history
  for all to authenticated
  using (user_id = public.current_profile_id())
  with check (user_id = public.current_profile_id());

comment on table public.address_history is
  'Where the physician has lived, for the address history every credentialing application asks for. The row flagged is_current is where they live now; profiles.address remains the mailing address, which is a different question. src/utils/addressHistory.js is what checks the list for the gaps an application is returned for.';

notify pgrst, 'reload schema';
create function pg_temp.rec(n text,e text,a text) returns void language sql as $f$
  insert into pg_temp.probe_out values (n,e,a, case when e=a then 'PASS' else 'FAIL' end) $f$;
create function pg_temp.probe(n text, sub text, sql text, expect text) returns void language plpgsql as $f$
declare got text; begin
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub',sub,'role','authenticated')::text, true);
    execute sql; got := 'ok';
  exception when others then got := 'blocked'; end;
  execute 'set local role postgres';
  insert into pg_temp.probe_out values (n, expect, got, case when got=expect then 'PASS' else 'FAIL' end);
end $f$;

insert into public.address_history (id, user_id, street, city, state, start_date, end_date)
values ('ffff6666-0000-4000-8000-000000000001','eeee5555-0000-4000-8000-00000000000a','9 Old St','Boulder','CO','2019-01-01','2021-06-30');

select pg_temp.probe('the owner reads their own row','probe_addr',
  $q$select 1 from public.address_history where id='ffff6666-0000-4000-8000-000000000001'$q$,'ok');
select pg_temp.rec('and actually sees it','1',
  (select count(*)::text from public.address_history where user_id='eeee5555-0000-4000-8000-00000000000a'));
select pg_temp.probe('the owner may add their own','probe_addr',
  $q$insert into public.address_history (user_id, street, city, state, start_date) values ('eeee5555-0000-4000-8000-00000000000a','1 Now Rd','Denver','CO','2024-03-01')$q$,'ok');
select pg_temp.probe('but NOT one owned by somebody else','probe_addr',
  $q$insert into public.address_history (user_id, street, city) values ('eeee5555-0000-4000-8000-00000000000b','Sneaky','Nowhere')$q$,'blocked');

-- another physician must not see or touch it. Counted INSIDE a function that
-- drops back to postgres before writing the result, because the probe table
-- is not the authenticated role's to write.
create function pg_temp.count_as(n text, sub text, expect text) returns void language plpgsql as $f$
declare got text; begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub',sub,'role','authenticated')::text, true);
  select count(*)::text into got from public.address_history;
  execute 'set local role postgres';
  insert into pg_temp.probe_out values (n, expect, got, case when got=expect then 'PASS' else 'FAIL' end);
end $f$;
select pg_temp.count_as('a different physician sees NOTHING','probe_addr2','0');
select pg_temp.count_as('the owner sees their own two','probe_addr','2');

select pg_temp.probe('and cannot delete another''s row','probe_addr2',
  $q$delete from public.address_history where id='ffff6666-0000-4000-8000-000000000001'$q$,'ok');
select pg_temp.rec('the row survives that delete','1',
  (select count(*)::text from public.address_history where id='ffff6666-0000-4000-8000-000000000001'));
select pg_temp.rec('it IS on delete cascade','1',
  (select count(*)::text from pg_constraint where conrelid='public.address_history'::regclass and contype='f' and confdeltype='c'));
select pg_temp.rec('RLS is on','true',
  (select relrowsecurity::text from pg_class where oid='public.address_history'::regclass));
select name, expected, actual, verdict from pg_temp.probe_out;
rollback;
