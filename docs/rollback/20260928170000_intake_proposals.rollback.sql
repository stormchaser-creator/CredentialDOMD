-- Rollback for 20260928170000_intake_proposals.sql.
--
-- Drops the table of informational-mail notes and narrows intake_corrections
-- back to its first five actions. Run it only with an email-inbound that no
-- longer writes intake_proposals (the previous deploy): the current one logs
-- "intake note" errors and still enters records, but the app would have
-- nothing to show them with. The records the notes describe stay where they
-- are; only the notes, and the corrections that answered them, are gone.

drop table if exists public.intake_proposals;

do $$
begin
  if to_regclass('public.intake_corrections') is not null then
    delete from public.intake_corrections where action in ('dismiss_record', 'edit_record', 'undo_record');
    alter table public.intake_corrections drop constraint if exists intake_corrections_action_check;
    alter table public.intake_corrections add constraint intake_corrections_action_check
      check (action in ('dismiss_request', 'edit_cover_note', 'move_document', 'relink_document', 'keep_as_document'));
  end if;
end $$;

notify pgrst, 'reload schema';
