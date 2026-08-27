-- Optional per-license CME cycle start.
--
-- The compliance engine anchors the counting window to the license expiration
-- and walks back one state cycle. That is wrong whenever the CME clock did not
-- start a full cycle back, and the physician had no way to say so:
--   * A CA DO's FIRST CME requirement period runs from initial licensure to the
--     first license expiration and may be LONGER than 24 months
--     (16 CCR 1635(b), (d)) - hours logged before the derived start were being
--     silently discarded.
--   * A physician whose clock started at training completion needs a SHORTER
--     window than a full cycle back.
-- When set, the window becomes [cme_cycle_start, expiration_date]. When null,
-- behavior is unchanged. It moves the WINDOW only; the hour requirement always
-- comes from the state rule set.
--
-- The column is REQUIRED, not optional: src/lib/supabase.js toSnakeObj writes
-- every field on the record as a column, so a license carrying cmeCycleStart
-- with no matching column fails the entire row write.
alter table public.licenses add column if not exists cme_cycle_start date;

comment on column public.licenses.cme_cycle_start is
  'Optional start of the CME counting window for this license. Null = a full state cycle back from expiration_date (the default). Moves the window only; never the required hour count.';
