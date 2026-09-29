-- Backfill the provider-verified mailbox for accounts the broken webhook missed.
--
-- NOT A MIGRATION, AND A NO-OP AS COMMITTED: `pairs` below is empty, so
-- running this file unchanged writes nothing. It is run once, by hand, after
-- clerk-webhook with the CONSOLE_LOG fix is deployed.
--
-- PREFER THE ADMIN TOOL. Since 20260928191000, Admin > Users > "Repair sign-in
-- emails" (the admin-mailbox-repair function, calling
-- public.repair_account_mailboxes) does what this file does, reading Clerk
-- itself with the function's CLERK_SECRET_KEY: same users, same address,
-- same clock, same apply_account_mailbox call. It previews first, answers
-- counts only, and a second run writes nothing. It ALSO runs the identity
-- continuity check the production webhook runs before any mailbox write
-- (claim_clerk_continuity, 20260920120000), which this file does not: it
-- holds back a user whose subject or address matches a continuity
-- reservation that is not bound to that user's own profile, or whose bound
-- profile is revoked, and refuses everything while the run is disabled.
-- This file stays as the by-hand path if the function cannot be deployed;
-- then remove every such user from `pairs` before running it.
--
-- Why it is needed. From 2026-09-20 19:39Z to the fix, clerk-webhook threw
-- `ReferenceError: CONSOLE_LOG is not defined` on every user.created and
-- user.updated, after the profile write and before the mailbox write. So no
-- account has a provider claim in public.mailbox_claims and
-- profiles.verified_email is null on every profile (12 of 12 on 2026-09-28).
-- The fixed webhook only repairs an account when Clerk next sends a
-- user.updated for it, which for most members is not soon: signing in sends
-- session.created, which is ignored. This does the existing set at once.
--
-- Why it goes through public.apply_account_mailbox and not an UPDATE. Since
-- 20260918a, email-inbound routes on mailbox_claims; profiles.verified_email
-- is the mirror. The DO block in 20260915d_verified_mailbox.sql writes the
-- mirror only, so running THAT today would show an address as verified in
-- Settings while forwarded documents from it are still refused. This file
-- calls the same function, with the same arguments, the webhook would have
-- called: the ledger and the mirror move together, in one transaction, under
-- the same domain lock, fence and displacement rules.
--
-- Where the input comes from: Clerk's CURRENT state, never a replay. The rule
-- in 20260915d stands: a replayed webhook event is a genuine assertion about
-- the past, and replaying old events is how a withdrawn route comes back. Do
-- not use "Recover failed messages" for the eight days of 500s either; read
-- the users as they are now.
--
-- The clock is Clerk's own user.updated_at, which is exactly what the webhook
-- stamps (verifiedMailbox.ts eventClock). That makes this equivalent to the
-- webhook receiving each member's latest event: any older event still in
-- flight is refused as stale, and any genuinely newer one still applies. (The
-- 20260915d block stamped now() instead, which would also refuse a real change
-- made between reading Clerk and running the block.)
--
-- Which address: the PRIMARY address, and only when Clerk shows it verified.
-- In production clerk-webhook refuses an identity whose primary is not
-- verified (readProductionIdentity, before the mailbox step), and it refuses
-- banned or locked users the same way. The one step of the webhook this file
-- does not repeat is the continuity check above.
--
-- Getting `pairs`, read-only, with the PRODUCTION Clerk secret key (Clerk
-- dashboard > API keys, sk_live_...). Up to 500 users per page; there are
-- about a dozen today.
--
--   curl -s -G https://api.clerk.com/v1/users --data-urlencode limit=500 \
--     -H "Authorization: Bearer $CLERK_SECRET_KEY" \
--   | jq -c '[ .[] | select(.banned != true and .locked != true)
--              | . as $u
--              | ($u.email_addresses[] | select(.id == $u.primary_email_address_id
--                                            and .verification.status == "verified")) as $p
--              | {auth_user_id: $u.id, email: $p.email_address, updated_ms: $u.updated_at} ]'
--
-- THE REPOSITORY IS PUBLIC. Paste the output into a COPY of this file outside
-- the repository (or straight into the Supabase SQL editor), never into this
-- file. Run as postgres (the SQL editor's role).
--
-- Idempotent. An account that already holds this address at this clock or
-- later is skipped before any write, so a second run changes nothing, not
-- even updated_at. An account whose recorded event is newer than Clerk's
-- clock (the fixed webhook got there first) is answered 'stale' by the
-- function and left alone.
--
-- Afterwards, re-measure (expect active_no_route to fall from 7):
--   select count(*) filter (where access_status = 'active') as active,
--          count(*) filter (where access_status = 'active' and not exists (
--            select 1 from public.mailbox_claims c where c.profile_id = p.id)) as active_no_route,
--          count(verified_email) as with_verified_email
--     from public.profiles p;
--
-- Known interaction, same as the webhook: when the verified primary is also
-- an address the SAME account confirmed as a forwarding address, the function
-- turns that claim's proof from 'confirmed' into 'provider'. It keeps routing.
-- Before 20260928191000 it stopped routing if the member later changed their
-- Clerk primary, because a provider event released the account's other
-- provider claims while the forwarding row still said Confirmed. Since then a
-- released provider claim goes back to 'confirmed' when the same account
-- still holds a confirmed forwarding row for it, so the route follows the row.
-- Apply that migration before running this file.

do $$
declare
  pairs jsonb := '[]'::jsonb; -- FILL AT RUN TIME, in a copy. Never commit real addresses.
  r record;
  v_result jsonb;
  v_outcome text;
  n_input int;
  n_distinct int;
  n_unmatched int;
  n_closed int;
  n_skipped int := 0;
  n_applied int := 0;
  tally jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(pairs) <> 'array' then
    raise exception 'pairs must be a JSON array';
  end if;

  select count(*), count(distinct x.auth_user_id)
    into n_input, n_distinct
    from jsonb_to_recordset(pairs) as x(auth_user_id text, email text, updated_ms bigint);
  if n_input = 0 then
    raise notice 'verified mailbox backfill: pairs is empty, nothing to do';
    return;
  end if;
  -- One Clerk user, one current state. Two rows for one subject means the
  -- input was stitched together from more than one read; refuse it whole.
  if n_distinct <> n_input then
    raise exception 'pairs lists a Clerk user more than once (% rows, % users)', n_input, n_distinct;
  end if;

  select count(*) into n_unmatched
    from jsonb_to_recordset(pairs) as x(auth_user_id text, email text, updated_ms bigint)
   where not exists (select 1 from public.profiles p where p.auth_user_id = x.auth_user_id);

  -- A closed account takes nothing (apply_account_mailbox would refuse it
  -- too); counted so the tally adds up.
  select count(*) into n_closed
    from jsonb_to_recordset(pairs) as x(auth_user_id text, email text, updated_ms bigint)
    join public.profiles p on p.auth_user_id = x.auth_user_id
   where p.deleted_at is not null;

  for r in
    select p.id as profile_id,
           lower(btrim(x.email)) as address,
           x.updated_ms,
           p.verified_email,
           p.verified_email_event_ms
      from jsonb_to_recordset(pairs) as x(auth_user_id text, email text, updated_ms bigint)
      join public.profiles p on p.auth_user_id = x.auth_user_id
     where p.deleted_at is null
     order by p.id
  loop
    if r.address is null or r.address = '' or r.updated_ms is null or r.updated_ms <= 0 then
      raise exception 'profile %: input row has no usable address or clock', left(r.profile_id::text, 8);
    end if;

    -- Already there: no call, no write, no updated_at bump.
    if lower(r.verified_email) = r.address and coalesce(r.verified_email_event_ms, 0) >= r.updated_ms then
      n_skipped := n_skipped + 1;
      continue;
    end if;

    v_result := public.apply_account_mailbox(r.profile_id, r.updated_ms, r.address, false);
    v_outcome := coalesce(v_result ->> 'outcome', 'no answer');
    n_applied := n_applied + 1;
    tally := jsonb_set(tally, array[v_outcome], to_jsonb(coalesce((tally ->> v_outcome)::int, 0) + 1));
    -- Profile prefix and outcome only: no address in the log.
    raise notice 'profile %: %', left(r.profile_id::text, 8), v_outcome;
  end loop;

  raise notice 'verified mailbox backfill: % input row(s), % with no profile, % closed, % already current, % applied %',
    n_input, n_unmatched, n_closed, n_skipped, n_applied, tally;
end $$;
