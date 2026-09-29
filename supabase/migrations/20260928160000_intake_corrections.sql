-- Intake corrections (2026-09-28).
--
-- On 2026-09-28 the owner forwarded an agency consultant's informational
-- letter to docs@; it was read as a request and the reply went to the agency
-- on one tap. email-inbound now READS each docs@ and cme@ email with one model
-- call before anything is decided (_shared/intakeUnderstanding.mjs), and this
-- table is how it learns from the physician: every time they correct what
-- intake did, the app writes one row here, and the account's last ten rows go
-- into the prompt as short examples (intakeUnderstanding.mjs
-- correctionExamples; the app side is src/utils/intakeCorrections.js).
--
--   action   dismiss_request    a request row was dismissed
--            edit_cover_note    the drafted reply was edited before sending
--            move_document      an emailed document left the inbox for a record
--            relink_document    an emailed document was moved to another record
--            keep_as_document   "Keep as plain document" instead of filing it
--   before   what intake did, after   what the physician did instead:
--            kinds, sections, statuses and ask texts scrubbed of addresses,
--            numbers and names. Never an email body, never a file, never a
--            personal identifier. Bounded in size by the insert policy.
--
-- Owner-only. The owner may read, add and delete their own rows and nothing
-- else; there is no update (a correction is a record of what happened) and no
-- admin policy. email-inbound reads with the service role. The rows go with
-- the account (on delete cascade, and delete-account's USER_TABLES).
--
-- Idempotent: safe to run twice. Additive: nothing existing is altered.
-- Rollback: docs/rollback/20260928160000_intake_corrections.rollback.sql.

create table if not exists public.intake_corrections (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  -- The inbound_emails ledger row the correction is about, when known. No
  -- foreign key: that table is service-role only, and a key would let a
  -- client learn whether a ledger id exists from the error it gets back.
  inbound_email_id  uuid,
  request_id        uuid references public.document_requests(id) on delete set null,
  action            text not null,
  before            jsonb not null default '{}'::jsonb,
  after             jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'intake_corrections_action_check') then
    alter table public.intake_corrections add constraint intake_corrections_action_check
      check (action in ('dismiss_request', 'edit_cover_note', 'move_document', 'relink_document', 'keep_as_document'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'intake_corrections_shape_check') then
    alter table public.intake_corrections add constraint intake_corrections_shape_check
      check (jsonb_typeof(before) = 'object' and jsonb_typeof(after) = 'object');
  end if;
end $$;

create index if not exists idx_intake_corrections_user_created
  on public.intake_corrections (user_id, created_at desc);

alter table public.intake_corrections enable row level security;

-- Default grants would let anon and authenticated at the table if a policy
-- ever appeared; revoke, then grant back only what the policies below use.
revoke all on table public.intake_corrections from anon;
revoke all on table public.intake_corrections from authenticated;
grant select, insert, delete on table public.intake_corrections to authenticated;
grant all on table public.intake_corrections to service_role;

drop policy if exists intake_corrections_owner_select on public.intake_corrections;
create policy intake_corrections_owner_select on public.intake_corrections
  for select to authenticated
  using (user_id = public.current_profile_id());

-- A row names only the owner's own request, and stays small: this is a
-- short record of a choice, not a place to store anything else.
drop policy if exists intake_corrections_owner_insert on public.intake_corrections;
create policy intake_corrections_owner_insert on public.intake_corrections
  for insert to authenticated
  with check (
    user_id = public.current_profile_id()
    and (request_id is null or exists (
      select 1 from public.document_requests r where r.id = request_id and r.user_id = public.current_profile_id()))
    and pg_column_size(before) <= 4096
    and pg_column_size(after) <= 4096
  );

drop policy if exists intake_corrections_owner_delete on public.intake_corrections;
create policy intake_corrections_owner_delete on public.intake_corrections
  for delete to authenticated
  using (user_id = public.current_profile_id());

comment on table public.intake_corrections is
  'The physician''s corrections to what email intake did (dismissed requests, edited cover notes, moved or kept documents). The last ten per account are examples in the intake understanding prompt. Owner select/insert/delete, service-role read. No personal identifiers.';

notify pgrst, 'reload schema';
