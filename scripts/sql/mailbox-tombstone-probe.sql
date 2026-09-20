-- Probes for the terminal-deletion invariant (reviewer's findings, 2026-09-18).
--
-- This file is the PROBES ONLY. It is run on top of the real migration files
-- rather than a pasted copy of them, so it cannot pass against a stale
-- transcription of the thing it is testing:
--
--   TOKEN=$(security find-generic-password -l "Supabase CLI" -w)
--   { echo "begin;";
--     cat supabase/migrations/20260915d_verified_mailbox.sql \
--         supabase/migrations/20260916b_mailbox_claims.sql \
--         supabase/migrations/20260918a_mailbox_account_events.sql \
--         scripts/sql/mailbox-tombstone-probe.sql;
--     echo "rollback;"; } > /tmp/dry.sql
--   python3 -c 'import json,sys; print(json.dumps({"query": open("/tmp/dry.sql").read()}))' > /tmp/q.json
--   curl -s -X POST \
--     "https://api.supabase.com/v1/projects/hkpnnsjcwprrwobmpqyy/database/query" \
--     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @/tmp/q.json
--
-- The three cases:
--   1. pending challenge -> user.deleted -> submit the original token. The
--      reviewer got a live confirmed route for a deleted account and
--      profiles.deleted_at stayed null.
--   2. a provider event with a LATER clock claims an address the closed
--      account never held.
--   3. the same two against an OPEN account, which must still work. Without
--      these the first two pass by refusing everything.

create temp table probe_out(name text, expected text, actual text, verdict text) on commit drop;
-- The function body with its comments removed. The first version of the lock
-- order probe below read pg_get_functiondef directly and reported that
-- apply_account_mailbox never locks forwarding_addresses, when it does: a
-- COMMENT naming the lock order matched the pattern first and swallowed the
-- statement after it. A structural check that can be satisfied by prose is not
-- a structural check.
-- Guarded by prokind. pg_get_functiondef RAISES on an aggregate ("array_agg is
-- an aggregate function"), and a WHERE clause does not promise evaluation
-- order: on the live database the schema filter happened to run first, and on
-- a disposable PostgreSQL 17 cluster it did not, so a probe that had passed
-- 36 of 36 stopped dead on a catalog row it was never meant to read. A check
-- that passes by planner luck is not a check. Anything that is not a plain
-- function reads as empty, which no pattern below can match.
create function pg_temp.code_of(p_oid oid) returns text language sql stable as $c$
  select case when (select prokind from pg_proc where oid = p_oid) = 'f'
              then regexp_replace(pg_get_functiondef(p_oid), '--[^' || chr(10) || ']*', '', 'g')
              else '' end;
$c$;

create function pg_temp.probe(p_name text, p_actual text, p_expect text) returns void language sql as $f$
  insert into pg_temp.probe_out values (p_name, p_expect, p_actual,
    case when p_actual = p_expect then 'PASS' else 'FAIL' end);
$f$;

-- The shape the reviewer's deadlock had: the challenge row taken before the
-- account fence. Never called; it exists to be measured.
create function pg_temp.deadlock_shape() returns void language plpgsql as $d$
begin
  perform 1 from public.forwarding_addresses where id is not null for update;
  perform 1 from public.profiles where id is not null for update;
  perform 1 from public.mailbox_claims where address is not null for update;
end $d$;

insert into public.profiles (id, auth_user_id, email, access_status) values
  ('eeee0000-0000-4000-8000-00000000000d','tomb_deleted','tomb-deleted@example.invalid','active'),
  ('eeee0000-0000-4000-8000-00000000000e','tomb_open','tomb-open@example.invalid','active');

-- Each account has a PENDING challenge on an address it does not hold yet.
insert into public.forwarding_addresses (id, user_id, email, token_hash, token_expires_at) values
  ('ffff0000-0000-4000-8000-00000000000d','eeee0000-0000-4000-8000-00000000000d',
   'pending-deleted@example.invalid','hash_deleted', now() + interval '2 days'),
  ('ffff0000-0000-4000-8000-00000000000e','eeee0000-0000-4000-8000-00000000000e',
   'pending-open@example.invalid','hash_open', now() + interval '2 days');

do $$
declare r jsonb;
begin
  -- ── 1. The reviewer's exact sequence ──────────────────────────────────
  r := public.apply_account_mailbox('eeee0000-0000-4000-8000-00000000000d', 1000, null, true);
  perform pg_temp.probe('user.deleted closes the account', r->>'outcome', 'terminal');
  perform pg_temp.probe('and leaves a durable tombstone',
    (select count(*)::text from public.account_tombstones
      where profile_id = 'eeee0000-0000-4000-8000-00000000000d'), '1');
  perform pg_temp.probe('which account_is_closed answers from',
    public.account_is_closed('eeee0000-0000-4000-8000-00000000000d')::text, 'true');

  r := public.confirm_forwarding_claim('hash_deleted', 2000);
  -- 'refused', not 'terminal_account': the terminal path cleared the token, so
  -- the lookup finds nothing and the tombstone check never gets asked. That is
  -- the outer of the two refusals. The inner one is exercised below, against
  -- an account closed the OTHER way, where the token does survive.
  perform pg_temp.probe('the original token confirms NOTHING afterwards',
    r->>'outcome', 'refused');
  perform pg_temp.probe('and no route exists for the closed account',
    (select count(*)::text from public.mailbox_claims
      where address = 'pending-deleted@example.invalid' and profile_id is not null), '0');
  perform pg_temp.probe('the pending token is gone at the source too',
    (select coalesce(token_hash, '(null)') from public.forwarding_addresses
      where id = 'ffff0000-0000-4000-8000-00000000000d'), '(null)');

  -- ── 2. A provider event whose clock runs ahead of the deletion ─────────
  r := public.apply_account_mailbox('eeee0000-0000-4000-8000-00000000000d', 999999,
                                    'never-held@example.invalid', false);
  perform pg_temp.probe('a later-clock provider event claims nothing either',
    r->>'outcome', 'terminal_account');
  perform pg_temp.probe('and wrote no claim row',
    (select count(*)::text from public.mailbox_claims
      where address = 'never-held@example.invalid'), '0');
  perform pg_temp.probe('nor put the mailbox back on the profile',
    (select coalesce(verified_email, '(null)') from public.profiles
      where id = 'eeee0000-0000-4000-8000-00000000000d'), '(null)');

  -- ── 3. NEGATIVE CONTROLS: the open account must still work ────────────
  -- Without these, a function that refused everything would pass above.
  r := public.confirm_forwarding_claim('hash_open', 2000);
  perform pg_temp.probe('an open account still confirms its own challenge',
    r->>'outcome', 'confirmed');
  perform pg_temp.probe('and the route is live',
    (select profile_id::text from public.mailbox_claims
      where address = 'pending-open@example.invalid'),
    'eeee0000-0000-4000-8000-00000000000e');
  r := public.apply_account_mailbox('eeee0000-0000-4000-8000-00000000000e', 3000,
                                    'provider-open@example.invalid', false);
  perform pg_temp.probe('and a provider event still lands on it', r->>'outcome', 'claimed');

  -- ── 3b. The other door: an account deleted by delete-account ──────────
  -- delete-account writes profiles.deleted_at, and every account closed before
  -- this migration existed has that and no tombstone row. Its pending tokens
  -- were never cleared, so this is the case where the confirm-time check is
  -- the only thing standing between a deleted account and a live route.
  update public.profiles set deleted_at = now()
   where id = 'eeee0000-0000-4000-8000-00000000000e';
  insert into public.forwarding_addresses (id, user_id, email, token_hash, token_expires_at)
  values ('ffff0000-0000-4000-8000-00000000000f','eeee0000-0000-4000-8000-00000000000e',
          'historic-pending@example.invalid','hash_historic', now() + interval '2 days');
  perform pg_temp.probe('a deleted_at profile reads as closed with no tombstone row',
    public.account_is_closed('eeee0000-0000-4000-8000-00000000000e')::text, 'true');
  r := public.confirm_forwarding_claim('hash_historic', 4000);
  perform pg_temp.probe('and its surviving token is refused at confirm time',
    r->>'outcome', 'terminal_account');
  perform pg_temp.probe('with no route written',
    (select count(*)::text from public.mailbox_claims
      where address = 'historic-pending@example.invalid'), '0');
  r := public.apply_account_mailbox('eeee0000-0000-4000-8000-00000000000e', 999999,
                                    'historic-provider@example.invalid', false);
  perform pg_temp.probe('and a provider event is refused for it too',
    r->>'outcome', 'terminal_account');

  -- ── 4. The lock order, read off the deployed definitions ──────────────
  -- Not a comment claiming an order: the order each function actually takes,
  -- extracted from its body. The deadlock the reviewer hit was confirm taking
  -- forwarding_addresses before profiles while remove took profiles first.
  -- Ranks: profiles 1, forwarding_addresses 2, mailbox_claims 3. Deadlock
  -- freedom is exactly "the ranks never go backwards inside one function",
  -- which tolerates a function locking a relation repeatedly or not at all.
  -- Repeats and absences are fine; going backwards is the bug.
  perform pg_temp.probe('no path locks these relations out of order',
    (select coalesce(string_agg(f.proname || ': ' || f.seq, ' | ' order by f.proname), '(none)')
       from (
         select p.proname,
                (select string_agg(m[1], '->' order by m.i)
                   from regexp_matches(pg_temp.code_of(p.oid),
                          '(profiles|forwarding_addresses|mailbox_claims)[^;]*? for update', 'g')
                        with ordinality as m(m, i)) as seq
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('apply_account_mailbox','confirm_forwarding_claim','remove_forwarding_claim')
       ) f
      where exists (
        select 1 from (
          select row_number() over () as i,
                 case w when 'profiles' then 1 when 'forwarding_addresses' then 2 else 3 end as rank
            from unnest(string_to_array(f.seq, '->')) as w
        ) r1 join (
          select row_number() over () as i,
                 case w when 'profiles' then 1 when 'forwarding_addresses' then 2 else 3 end as rank
            from unnest(string_to_array(f.seq, '->')) as w
        ) r2 on r2.i > r1.i and r2.rank < r1.rank)),
    '(none)');

  -- ── 5. The domain lock, which is what actually stops the crossed
  --       transfer the reviewer found. Ordering the locks could not: which
  --       profile gets displaced is only learnable by reading a claim that
  --       must already be locked. So every mutator serializes on one key.
  perform pg_temp.probe('every mailbox mutator takes the domain lock',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('apply_account_mailbox','confirm_forwarding_claim','remove_forwarding_claim')
        and pg_temp.code_of(p.oid) like '%mailbox_domain_lock()%'), '3');

  perform pg_temp.probe('and takes it BEFORE any row lock',
    (select coalesce(string_agg(p.proname, ', ' order by p.proname), '(none)')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('apply_account_mailbox','confirm_forwarding_claim','remove_forwarding_claim')
        and position('mailbox_domain_lock()' in pg_temp.code_of(p.oid))
            > position(' for update' in pg_temp.code_of(p.oid))), '(none)');

  perform pg_temp.probe('on exactly one key, so they serialize against each other',
    (select count(distinct substring(pg_get_functiondef(p.oid) from 'pg_advisory_xact_lock\([^)]*\)'))::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'mailbox_domain_lock'), '1');

  perform pg_temp.probe('and closure is re-asked after the fence, not only before it',
    (select case when (length(pg_temp.code_of(p.oid))
                       - length(replace(pg_temp.code_of(p.oid), 'account_is_closed', ''))) / length('account_is_closed') >= 2
                 then 'twice' else 'once' end
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'confirm_forwarding_claim'), 'twice');

  -- ── 5b. NO writer escapes the domain lock ─────────────────────────────
  -- Named functions were the reviewer's finding; this is the invariant behind
  -- it. After the whole chain has applied, every function in public that
  -- WRITES mailbox_claims must take the domain lock. Naming claim_mailbox and
  -- revoke_mailbox would pass while the next forgotten writer walks straight
  -- past it.
  perform pg_temp.probe('every writer of mailbox_claims takes the domain lock',
    (select coalesce(string_agg(p.proname, ', ' order by p.proname), '(none)')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname <> 'mailbox_domain_lock'
        and pg_temp.code_of(p.oid) ~* '(insert into|update|delete from)[[:space:]]+public\.mailbox_claims'
        and pg_temp.code_of(p.oid) not like '%mailbox_domain_lock()%'),
    '(none)');
  perform pg_temp.probe('and the retired single-address writers are gone',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('claim_mailbox','revoke_mailbox')), '0');

  -- ── 6. The crossed transfer itself, applied in both directions. Cannot
  --       prove absence of deadlock from one session, but it CAN prove the
  --       transfers land correctly and the displaced mirrors are cleared.
  insert into public.profiles (id, auth_user_id, email, access_status) values
    ('eeee0000-0000-4000-8000-0000000000aa','cross_a','cross-a@example.invalid','active'),
    ('eeee0000-0000-4000-8000-0000000000bb','cross_b','cross-b@example.invalid','active');
  r := public.apply_account_mailbox('eeee0000-0000-4000-8000-0000000000aa', 100, 'x@example.invalid', false);
  perform pg_temp.probe('A takes X', r->>'outcome', 'claimed');
  r := public.apply_account_mailbox('eeee0000-0000-4000-8000-0000000000bb', 100, 'y@example.invalid', false);
  perform pg_temp.probe('B takes Y', r->>'outcome', 'claimed');
  r := public.apply_account_mailbox('eeee0000-0000-4000-8000-0000000000aa', 200, 'y@example.invalid', false);
  perform pg_temp.probe('A takes Y from B', r->>'outcome', 'claimed');
  -- 200 exactly, against a row A's release just stamped at 200: the tie the
  -- design refuses on purpose, because one clock claiming two different things
  -- means one of them is wrong and nothing here can tell which. Pinned so it
  -- is a decision rather than an accident. (My first fixture used 200 here and
  -- read the deliberate refusal as a defect.)
  r := public.apply_account_mailbox('eeee0000-0000-4000-8000-0000000000bb', 200, 'x@example.invalid', false);
  perform pg_temp.probe('a same-clock counter-claim moves nothing', r->>'outcome', 'held');
  perform pg_temp.probe('and leaves the address routing to nobody rather than to a guess',
    (select coalesce(profile_id::text, 'nobody') from public.mailbox_claims where address = 'x@example.invalid'), 'nobody');

  -- One millisecond later, which is what two real provider events look like.
  r := public.apply_account_mailbox('eeee0000-0000-4000-8000-0000000000bb', 201, 'x@example.invalid', false);
  perform pg_temp.probe('B takes X from A', r->>'outcome', 'claimed');
  perform pg_temp.probe('X now routes to B',
    (select profile_id::text from public.mailbox_claims where address = 'x@example.invalid'),
    'eeee0000-0000-4000-8000-0000000000bb');
  perform pg_temp.probe('Y now routes to A',
    (select profile_id::text from public.mailbox_claims where address = 'y@example.invalid'),
    'eeee0000-0000-4000-8000-0000000000aa');
  perform pg_temp.probe('and neither displaced mirror was left behind',
    (select coalesce(string_agg(coalesce(verified_email, 'null'), ',' order by id), '(none)')
       from public.profiles where id in ('eeee0000-0000-4000-8000-0000000000aa','eeee0000-0000-4000-8000-0000000000bb')),
    'y@example.invalid,x@example.invalid');

  -- NEGATIVE CONTROL for the check above. A rank test that never fires is
  -- indistinguishable from one that cannot fire, so here is a function that
  -- takes the locks in the order the reviewer's deadlock actually took them
  -- (forwarding_addresses, then profiles) and the same expression run over it.
  perform pg_temp.probe('and the check catches the reviewer''s deadlock order',
    (select case when exists (
       select 1 from (
         select row_number() over () as i,
                case w when 'profiles' then 1 when 'forwarding_addresses' then 2 else 3 end as rank
           from unnest(string_to_array(
                  (select string_agg(m[1], '->' order by m.i)
                     from regexp_matches(pg_temp.code_of('pg_temp.deadlock_shape'::regproc::oid),
                            '(profiles|forwarding_addresses|mailbox_claims)[^;]*? for update', 'g')
                          with ordinality as m(m, i)), '->')) as w
       ) r1 join (
         select row_number() over () as i,
                case w when 'profiles' then 1 when 'forwarding_addresses' then 2 else 3 end as rank
           from unnest(string_to_array(
                  (select string_agg(m[1], '->' order by m.i)
                     from regexp_matches(pg_temp.code_of('pg_temp.deadlock_shape'::regproc::oid),
                            '(profiles|forwarding_addresses|mailbox_claims)[^;]*? for update', 'g')
                          with ordinality as m(m, i)), '->')) as w
       ) r2 on r2.i > r1.i and r2.rank < r1.rank)
     then 'caught' else 'MISSED' end),
    'caught');

  -- And the sequences themselves, recorded so a reader can see what was
  -- measured rather than trust the verdict above.
  insert into pg_temp.probe_out
  select 'lock sequence: ' || p.proname, '(recorded)',
         coalesce((select string_agg(m[1], '->' order by m.i)
                     from regexp_matches(pg_temp.code_of(p.oid),
                            '(profiles|forwarding_addresses|mailbox_claims)[^;]*? for update', 'g')
                          with ordinality as m(m, i)), '(none)'), 'PASS'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('apply_account_mailbox','confirm_forwarding_claim','remove_forwarding_claim');
end $$;

select
  (select count(*) from probe_out where verdict = 'PASS') || ' passed, ' ||
  (select count(*) from probe_out where verdict = 'FAIL') || ' failed' as summary,
  name, expected, actual, verdict
from probe_out order by name;
