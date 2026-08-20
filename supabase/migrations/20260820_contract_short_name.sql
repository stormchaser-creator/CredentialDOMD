-- Short display name for a locum agreement (e.g. "ANMG" for
-- "Arrowhead Neurosurgical Medical Group"). Optional; the full facility
-- name stays canonical for credentialing exports. Shown in the RVU picker,
-- case log, and locum lists.
alter table public.locum_contracts add column if not exists short_name text;
