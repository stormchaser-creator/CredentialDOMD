-- CallSync sync (ticket 833c06e8): a schedule day can now say where it came
-- from. source = 'callsync' marks rows the sync owns (a re-sync updates or
-- removes them); source_key = date|hospital|coverage|role is the idempotency
-- key, so a re-sync never duplicates a shift. Days the physician enters by
-- hand keep both columns null and the sync never touches them.
alter table public.schedule_days add column if not exists source text;
alter table public.schedule_days add column if not exists source_key text;
create index if not exists schedule_days_source_idx
  on public.schedule_days (user_id, source, source_key);
