-- docs/rollback/20260925131000_member_support_view.rollback.sql
-- Rollback for 20260925131000_member_support_view.sql (ticket d45e857c, phase 2).
--
-- ORDER MATTERS. First stop the edge function (unset
-- MEMBER_SUPPORT_VIEW_ENABLED, or undeploy admin-member-view), then revert
-- the client (Settings > Support access and Admin > Accounts > View as
-- member), then run this. A client still deployed shows "Support access is
-- not available" instead of breaking, but scripts/check-tables-exist.mjs
-- will refuse the next deploy of that client.
--
-- Refuses to drop the view log while it holds rows: it is the member's record
-- of who looked at their account. Export it (select * from
-- public.member_view_events) or keep the table; it is inert with no function.

begin;

do $$
begin
  if to_regclass('public.member_view_events') is not null and exists (select 1 from public.member_view_events) then
    raise exception 'member_support_view rollback: member_view_events holds rows; export them or keep the table';
  end if;
end $$;

drop function if exists public.member_view_session_end(uuid, text, uuid);
drop function if exists public.member_view_file_record(uuid, text, uuid, uuid, text);
drop function if exists public.member_view_session_check(uuid, text, uuid);
drop function if exists public.member_view_session_start(uuid, text, uuid, text, uuid);
drop function if exists public.admin_member_view_grants();
drop function if exists public.member_view_grant_end();
drop function if exists public.member_view_grant_open();
drop function if exists public.member_view_status();
drop function if exists public.member_view_session_state(uuid, uuid);
drop function if exists public.member_view_actor_ok(uuid, text);
drop function if exists public.member_view_close_expired(uuid);
drop function if exists public.member_view_member();
drop function if exists public.member_view_grant_json(public.member_view_grants);

drop table if exists public.member_view_events;
drop table if exists public.member_view_sessions;
drop table if exists public.member_view_grants;

commit;
