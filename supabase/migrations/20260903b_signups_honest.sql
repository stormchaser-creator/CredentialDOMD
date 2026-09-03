-- The Signups number counted rows, not signups (2026-09-03).
--
-- admin_signups_daily counted every profile carrying an auth_user_id. On this
-- project that was 8, of which:
--   * 1 is the founder's own admin account, and
--   * 3 are abandoned starts from July with no email, no name, never signed
--     in, still pending: Clerk creates the profile when someone begins signup,
--     and nothing removes it when they walk away.
-- So the panel read 8 when four people had actually signed up. The view now
-- separates the three states instead of adding them together, and the extra
-- columns are additive so an older client reading only day/signups still
-- works, it just gets the correct number.

create or replace view public.admin_signups_daily as
select date_trunc('day', p.created_at)                    as day,
       count(*) filter (
         where a.profile_id is null
           and p.email is not null and p.email <> ''
       )                                                  as signups,
       count(*) filter (
         where p.email is null or p.email = ''
       )                                                  as abandoned,
       count(*) filter (where a.profile_id is not null)    as admin_accounts
  from public.profiles p
  left join public.app_admins a on a.profile_id = p.id
 where p.auth_user_id is not null
   and p.created_at > now() - interval '90 days'
 group by 1
 order by 1 desc;

comment on view public.admin_signups_daily is
  'Daily account creation for the admin panel. signups = a person who finished signup (has an email) and is not an admin. abandoned = a Clerk profile created when someone began signup and never returned (no email). admin_accounts = the founder''s own. Counting all three together is what made this panel read 8 when four people had signed up.';
