-- The Admin > Signups "Webpage visits" panel went blank after 2026-09-01, and
-- the traffic had not stopped. There are two tables.
--
-- page_visits is the original raw-row table (one row per pageview, path,
-- referrer, created_at). page_views is the counter table the /api/pv beacon
-- has written through the track_pv RPC since 20260827_page_views.sql: one row
-- per (day, path, referrer_domain) with a hits count, which is what keeps the
-- beacon from storing anything per visitor.
--
-- The beacon moved. The admin view did not, so it kept reading a table that
-- stopped being written. Real traffic over those "empty" days was 31, 47, 20
-- and 16 hits.
--
-- This reads page_views from its first day onward and page_visits only for the
-- days before that, so the history from 2026-08-10 stays on the chart and the
-- overlap (2026-08-27 to 2026-09-01, when both were being written) is not
-- counted twice.

CREATE OR REPLACE VIEW public.admin_visits_daily AS
WITH cutover AS (
  SELECT COALESCE(min(day), CURRENT_DATE) AS first_day FROM public.page_views
),
counted AS (
  SELECT
    v.day                                                        AS day,
    sum(v.hits)                                                  AS visits,
    sum(v.hits) FILTER (WHERE v.path IN ('/', '/index.html'))     AS home,
    sum(v.hits) FILTER (WHERE v.path LIKE '/states/%')            AS state_pages,
    -- referrer_domain is 'direct' when the visit carried no referrer, and the
    -- RPC reduces a referrer to its registrable domain before storing it.
    sum(v.hits) FILTER (WHERE v.referrer_domain NOT IN ('direct', 'credentialdomd.com')) AS referred
  FROM public.page_views v
  GROUP BY v.day
),
legacy AS (
  SELECT
    p.created_at::date                                            AS day,
    count(*)                                                      AS visits,
    count(*) FILTER (WHERE p.path IN ('/', '/index.html'))         AS home,
    count(*) FILTER (WHERE p.path LIKE '/states/%')                AS state_pages,
    count(*) FILTER (WHERE p.referrer <> '' AND p.referrer NOT LIKE '%credentialdomd.com%') AS referred
  FROM public.page_visits p, cutover c
  WHERE p.created_at::date < c.first_day
  GROUP BY p.created_at::date
)
SELECT day, visits::bigint, home::bigint, state_pages::bigint, referred::bigint
FROM (SELECT * FROM counted UNION ALL SELECT * FROM legacy) s
WHERE public.is_admin(public.current_profile_id())
ORDER BY day DESC;

GRANT SELECT ON public.admin_visits_daily TO authenticated;
