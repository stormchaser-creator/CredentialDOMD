-- First-party pageview counts (2026-08-27).
--
-- The marketing site has no analytics; the owner is flying blind on whether
-- the 51 /states/* SEO pages get any traffic. This adds counts and nothing
-- else. Privacy posture: no cookies, no localStorage identifiers, no IP
-- storage, no user agents, no fingerprinting, no per-visit rows. The unit of
-- storage is (day, path, referrer domain) -> hit count; nothing in the table
-- can identify a visitor.
--
-- Write path: landing pages fire navigator.sendBeacon('/api/pv', ...) to the
-- same-origin Cloudflare Worker (cloudflare/credentialdomd-api/worker.js),
-- which relays to the SECURITY DEFINER RPC track_pv with the anon key. Anon
-- has zero table access; the RPC is the only anon-reachable write path, the
-- same pattern as waitlist_signup (20260816_ratelimit.sql). The Worker adds
-- a per-IP best-effort cap in front (60 calls / 10 min).
--
-- HTTP mapping through PostgREST (what the Worker sees):
--   PT400  path not tracked / malformed -> 400
--   (void return)                       -> 204 on success
-- The beacon ignores the response either way.

------------------------------------------------------------------------------
-- 1. Table: daily counters, nothing per-visitor
------------------------------------------------------------------------------
create table if not exists public.page_views (
  day             date not null default current_date,
  path            text not null,
  referrer_domain text not null default 'direct',
  hits            int  not null default 0,
  primary key (day, path, referrer_domain)
);

comment on table public.page_views is
  'Daily pageview counters per (path, referrer domain). Counts only: no cookies, IPs, UAs, or per-visit rows. Written solely via track_pv(); read by service_role only.';

alter table public.page_views enable row level security;
-- No policies on purpose. service_role bypasses RLS and reads it (Admin /
-- SQL editor); anon and authenticated can neither read nor write the table.
revoke all on table public.page_views from anon, authenticated;
grant select on table public.page_views to service_role;

------------------------------------------------------------------------------
-- 2. track_pv: the only anon write path
------------------------------------------------------------------------------
create or replace function public.track_pv(
  p_path text default null,
  p_ref  text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_path   text := lower(trim(coalesce(p_path, '')));
  v_ref    text := lower(trim(coalesce(p_ref, '')));
  v_host   text;
  v_dom    text;
  v_labels text[];
  v_n      int;
  v_rows   int;
begin
  ----------------------------------------------------------------------------
  -- Path: strip query/hash, normalize index.html and trailing slash, cap
  -- length, then whitelist to the site's known prefixes. Anything else is a
  -- 400; garbage never creates rows.
  ----------------------------------------------------------------------------
  v_path := split_part(split_part(v_path, '?', 1), '#', 1);
  v_path := regexp_replace(v_path, '/index\.html$', '/');
  v_path := coalesce(nullif(rtrim(v_path, '/'), ''), '/');

  if length(v_path) > 100
     or v_path !~ '^/[a-z0-9/_.~%-]*$'
     or not (v_path = '/'
             or v_path = '/locums'
             or v_path like '/states/%'
             or v_path like '/app/%') then
    raise sqlstate 'PT400' using message = 'path not tracked';
  end if;

  ----------------------------------------------------------------------------
  -- Referrer: reduce to the registrable domain server-side so the full URL
  -- (which can carry search terms or tokens) is never stored. Approximation
  -- of the Public Suffix List: last two labels, or last three for a short
  -- list of common two-level suffixes. Unparseable input folds to 'other'.
  ----------------------------------------------------------------------------
  if v_ref = '' then
    v_dom := 'direct';
  else
    v_host := regexp_replace(v_ref, '^[a-z][a-z0-9+.-]*:/*', '');  -- scheme
    v_host := split_part(split_part(split_part(v_host, '/', 1), '?', 1), '#', 1);
    v_host := regexp_replace(v_host, '^[^@]*@', '');               -- userinfo
    v_host := split_part(v_host, ':', 1);                          -- port
    if v_host !~ '^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$'               -- needs a dot
       or v_host ~ '^[0-9.]+$' then                                -- bare IPv4
      v_dom := 'other';
    else
      v_labels := string_to_array(v_host, '.');
      v_n := array_length(v_labels, 1);
      if v_n <= 2 then
        v_dom := v_host;
      elsif (v_labels[v_n - 1] || '.' || v_labels[v_n]) in
            ('co.uk','org.uk','ac.uk','gov.uk','me.uk',
             'co.jp','ne.jp','or.jp',
             'com.au','net.au','org.au',
             'co.nz','co.in','co.za','co.kr',
             'com.br','com.mx','com.sg','com.hk','com.ar','com.tr') then
        v_dom := v_labels[v_n - 2] || '.' || v_labels[v_n - 1] || '.' || v_labels[v_n];
      else
        v_dom := v_labels[v_n - 1] || '.' || v_labels[v_n];
      end if;
    end if;
    v_dom := left(v_dom, 100);
  end if;

  ----------------------------------------------------------------------------
  -- Sanity caps (approximate on purpose; these are abuse ceilings, not
  -- accounting). Row cardinality per day is bounded: past 2,000 rows/day new
  -- referrer variants fold into 'other'; past 3,000 everything folds into
  -- ('/other','other'). Each call increments by exactly 1, and a single row
  -- stops counting at 100,000 hits/day.
  ----------------------------------------------------------------------------
  select count(*) into v_rows from public.page_views where day = current_date;
  if v_rows >= 3000 then
    v_path := '/other';
    v_dom  := 'other';
  elsif v_rows >= 2000
        and not exists (select 1 from public.page_views
                         where day = current_date
                           and path = v_path
                           and referrer_domain = v_dom) then
    v_dom := 'other';
  end if;

  insert into public.page_views as pv (day, path, referrer_domain, hits)
  values (current_date, v_path, v_dom, 1)
  on conflict (day, path, referrer_domain)
  do update set hits = pv.hits + 1
  where pv.hits < 100000;
end;
$$;

comment on function public.track_pv(text, text) is
  'Public pageview counter. Whitelists path (/, /locums, /states/*, /app/*), reduces referrer to its registrable domain, upserts hits+1 into page_views. Stores no visitor data. Raises PT400 on untracked paths.';

revoke execute on function public.track_pv(text, text) from public, authenticated;
grant  execute on function public.track_pv(text, text) to anon, service_role;

-- Make the new RPC visible to PostgREST immediately.
notify pgrst, 'reload schema';

------------------------------------------------------------------------------
-- 3. Readback (owner: Supabase SQL editor, or the management API as
--    service_role/postgres; anon and authenticated cannot run these).
--
-- Daily hits per path, last 30 days:
--
--   select day, path, sum(hits) as hits
--     from public.page_views
--    where day > current_date - 30
--    group by day, path
--    order by day desc, hits desc;
--
-- Where traffic comes from, last 30 days:
--
--   select referrer_domain, sum(hits) as hits
--     from public.page_views
--    where day > current_date - 30
--    group by referrer_domain
--    order by hits desc;
--
-- Are the state pages working at all (one number):
--
--   select sum(hits) from public.page_views
--    where day > current_date - 30 and path like '/states/%';
------------------------------------------------------------------------------
