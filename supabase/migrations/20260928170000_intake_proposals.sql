-- Informational mail entered in the app (2026-09-28).
--
-- The owner's rule, after an agency's informational letter about his
-- malpractice coverage was read as a request: "the docs was supposed to
-- enter the malpractice into the app and not create a email back". An email
-- forwarded to docs@ (or cme@) that asks for nothing now emails nobody.
-- email-inbound enters what it states instead (supabase/functions/_shared/
-- intakeFacts.mjs): on a positively authenticated forward it writes the
-- record itself, and on any other it only proposes it. This table is where
-- the app finds what happened, one row per email:
--
--   sender, summary   "From <sender>: <summary>" in More > Requests and on Home
--   verified          the forward was positively authenticated, so facts were
--                     written rather than proposed
--   items             what was done or offered, each with a state the app
--                     moves on (src/utils/intakeProposals.js):
--                       record  a fact: "written" (Undo in the app deletes the
--                               record with a tombstone, or puts back what an
--                               append changed) or "proposed" (Add goes
--                               through the app's own addItem / editItem;
--                               Dismiss), then "added", "dismissed", "undone"
--                       link    an unverified forward's agreement, offered for
--                               the agency's contract on one tap
--                       file    what happened to an attachment, to read
--                     No identifying number is ever in it: the host drops a
--                     fact whose value or source carries one.
--   status            new until the physician is done with it
--
-- Owner-only. The owner may read their rows and change status and items
-- (column grants), nothing else; only the service role inserts, and there is
-- no delete for the owner (the rows go with the account: on delete cascade,
-- and delete-account's USER_TABLES). items is capped at 4 KB, the same cap
-- intake_corrections has, so a row stays a note and not a store.
--
-- It also lets intake_corrections record the physician's answers to these
-- proposals (dismiss_record, edit_record, undo_record), which the next
-- reading learns from.
--
-- Idempotent: safe to run twice. Additive apart from the corrections check,
-- which it widens. Rollback: docs/rollback/20260928170000_intake_proposals.rollback.sql.

create table if not exists public.intake_proposals (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  -- The inbound_emails ledger row, when known. No foreign key, as in
  -- intake_corrections: that table is service-role only.
  inbound_email_id  uuid,
  -- The forward's Message-ID: one row per email, so a redelivered webhook
  -- cannot add a second.
  message_id        text not null,
  sender            text not null default '',
  summary           text not null default '',
  verified          boolean not null default false,
  status            text not null default 'new',
  items             jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'intake_proposals_status_check') then
    alter table public.intake_proposals add constraint intake_proposals_status_check
      check (status in ('new', 'done', 'dismissed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'intake_proposals_shape_check') then
    alter table public.intake_proposals add constraint intake_proposals_shape_check
      check (jsonb_typeof(items) = 'array'
        and pg_column_size(items) <= 4096
        and char_length(sender) <= 120
        and char_length(summary) <= 300
        and char_length(message_id) <= 1000);
  end if;
end $$;

create unique index if not exists idx_intake_proposals_user_message
  on public.intake_proposals (user_id, message_id);
create index if not exists idx_intake_proposals_user_status
  on public.intake_proposals (user_id, status, created_at desc);

alter table public.intake_proposals enable row level security;

revoke all on table public.intake_proposals from anon;
revoke all on table public.intake_proposals from authenticated;
grant select on table public.intake_proposals to authenticated;
-- The owner answers a note (its status, and each item's state); who sent it,
-- what it said and whether it was verified are the server's.
grant update (status, items, updated_at) on table public.intake_proposals to authenticated;
grant all on table public.intake_proposals to service_role;

drop policy if exists intake_proposals_owner_select on public.intake_proposals;
create policy intake_proposals_owner_select on public.intake_proposals
  for select to authenticated
  using (user_id = public.current_profile_id());

drop policy if exists intake_proposals_owner_update on public.intake_proposals;
create policy intake_proposals_owner_update on public.intake_proposals
  for update to authenticated
  using (user_id = public.current_profile_id())
  with check (user_id = public.current_profile_id());

comment on table public.intake_proposals is
  'What email intake entered or proposed from an informational email (no email is sent for one): sender, summary and items the physician adds, dismisses or undoes in the app. Owner select and update of status/items; service-role insert. Items capped at 4 KB, no identifying numbers.';

-- The physician's answers to these proposals are corrections too.
do $$
begin
  if to_regclass('public.intake_corrections') is not null then
    alter table public.intake_corrections drop constraint if exists intake_corrections_action_check;
    alter table public.intake_corrections add constraint intake_corrections_action_check
      check (action in ('dismiss_request', 'edit_cover_note', 'move_document', 'relink_document', 'keep_as_document',
                        'dismiss_record', 'edit_record', 'undo_record'));
  end if;
end $$;

notify pgrst, 'reload schema';
