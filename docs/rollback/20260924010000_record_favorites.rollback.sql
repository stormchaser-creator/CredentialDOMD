-- Rollback for 20260924010000_record_favorites.sql.
--
-- ORDER MATTERS. Revert the CLIENT first, then run this.
-- While a deployed client still writes `favorite`, dropping the column makes
-- PostgREST reject the WHOLE row with PGRST204 on every save to that table,
-- not merely the star. That is worse than leaving the column in place.
--
-- The column is additive and inert when unused, so there is rarely a reason to
-- run this at all. Prefer reverting the client and leaving the column.

begin;

do $$
declare t text;
begin
  foreach t in array array[
    'licenses','cme','privileges','insurance','health_records','education',
    'case_logs','work_history','peer_references','malpractice_history',
    'documents','share_log','notification_log','locum_contracts','work_log',
    'encounters','screenings','alert_acks','follow_ups','professional_photos',
    'publications','travel_docs','travel_expenses','tax_payments',
    'schedule_days','task_notes','duty_days','professional_memberships',
    'invoices','deductibles','rotations'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I drop column if exists favorite', t);
    end if;
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';
