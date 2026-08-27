-- track_pv: reject missing/empty path instead of counting it as '/' (2026-08-27).
--
-- The original normalization (20260827_page_views.sql) folded a null or
-- empty p_path into '/', so a beacon body with no 'p' key at all was
-- silently counted as a homepage view, inflating the '/' counter with
-- garbage. A real homepage view always sends p='/'. This recreates the
-- function with an early PT400 (-> HTTP 400 through PostgREST) when p_path
-- is null or trims to empty; '/' itself still trims to '/', not '', so
-- legitimate homepage beacons are unaffected. Everything after the guard is
-- unchanged from 20260827_page_views.sql.

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
  -- A beacon with no path is malformed, not a homepage view. Reject it
  -- before any normalization can fold it into '/'.
  ----------------------------------------------------------------------------
  if v_path = '' then
    raise sqlstate 'PT400' using message = 'path required';
  end if;

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
  'Public pageview counter. Requires a non-empty path (PT400 otherwise), whitelists it (/, /locums, /states/*, /app/*), reduces referrer to its registrable domain, upserts hits+1 into page_views. Stores no visitor data.';

revoke execute on function public.track_pv(text, text) from public, authenticated;
grant  execute on function public.track_pv(text, text) to anon, service_role;

notify pgrst, 'reload schema';
