-- Supabase grants anon/authenticated EXECUTE directly through public-schema
-- defaults. Revoking PUBLIC alone did not close this arbitrary-profile probe.
-- Supported callers use the owner via SECURITY DEFINER or the service role.
-- Preserve those callers; do not change the function body, data, or rollout gates.
begin;
revoke all on function public.account_is_closed(uuid) from public, anon, authenticated;
grant execute on function public.account_is_closed(uuid) to postgres, service_role;
commit;
