-- Secrets written into the catalog in plain text. Zero rows is a pass.
--
-- Function bodies, view definitions, object comments and cron commands are
-- readable by any role that can query the catalog, so no secret belongs in
-- any of them. Two independent checks, so neither has to be complete alone:
--   header  the x-hook-secret header name followed by a quoted value, as a
--           jsonb_build_object pair or as a JSON key.
--   vault   the value of any Vault secret, in whatever form it appears.
-- Comments inside bodies are NOT stripped: a secret in a comment still leaks.
--
-- Production: POST it to the management API query endpoint (read only).
-- tests/hook-secret-vault.test.mjs runs this same file against a disposable
-- database, before the migration (must find every copy) and after (none).
with vault_values as (
  select name, decrypted_secret as value
    from vault.decrypted_secrets
   where length(coalesce(decrypted_secret, '')) >= 12
), texts as (
  select 'function' as kind, p.oid::regprocedure::text as object, p.prosrc as body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema')
  union all
  select 'view', schemaname || '.' || viewname, definition
    from pg_views
   where schemaname not in ('pg_catalog', 'information_schema')
  union all
  select 'comment', classoid::regclass::text || ' ' || objoid::text, description
    from pg_description
  union all
  select 'cron', 'cron job ' || jobname, command
    from cron.job
)
select t.kind, t.object, 'x-hook-secret header literal' as finding
  from texts t
 where t.body ~* $re$'x-hook-secret'\s*,\s*'[^']+'$re$
    or t.body ~* $re$"x-hook-secret"\s*:\s*"[^"]+"$re$
union
select t.kind, t.object, 'value of vault secret ' || v.name
  from texts t
  join vault_values v on strpos(t.body, v.value) > 0
order by 1, 2, 3;
