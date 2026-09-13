-- The rest of what the anon key could reach, and two tables that are not ours
-- (2026-09-13, second pass).
--
-- 1. net.http_get, net.http_post and net.http_delete carry the EXECUTE grant
--    Postgres gives PUBLIC at creation, so anon and authenticated hold them
--    through PUBLIC. That is the primitive behind the advisor's "pg_net is
--    installed in the public schema" warning: a role that can call it can make
--    the DATABASE issue an arbitrary HTTP request, from inside the network,
--    and every cron job here posts to our own functions with the hook secret
--    in the header. This file cannot fix it and says so below; it is also not
--    reachable, which is the part that was checked rather than assumed.
--
-- 2. Six tables in this database belong to Superhuman90, from before that app
--    got its own project (it points at a different one now). Zero rows, no
--    inbound foreign keys, nothing in this repo or on this machine reads the
--    copies here. They are dropped: a table nobody owns is surface nobody
--    watches. The definitions are kept below, so recreating them is a paste.
--
-- --   create table public.exercise_swaps (id uuid not null default gen_random_uuid(), device_id text not null, week integer not null, day integer not null, original_exercise text not null, swapped_exercise text not null, created_at timestamp with time zone default now());
-- --   create table public.food_entries (id uuid not null default gen_random_uuid(), device_id text not null, date date not null, entry_id bigint not null, food_text text not null, logged_at text, items jsonb default '[]'::jsonb, calories integer default 0, protein integer default 0, carbs integer default 0, fat integer default 0, created_at timestamp with time zone default now());
-- --   create table public.habit_log (id uuid not null default gen_random_uuid(), device_id text not null, date date not null, h0 boolean default false, h1 boolean default false, h2 boolean default false, h3 boolean default false, h4 boolean default false, h5 boolean default false, h6 boolean default false, h7 boolean default false, created_at timestamp with time zone default now(), updated_at timestamp with time zone default now());
-- --   create table public.habit_notes (id uuid not null default gen_random_uuid(), device_id text not null, date date not null, habit_index integer not null, note text default ''::text, created_at timestamp with time zone default now(), updated_at timestamp with time zone default now());
-- --   create table public.step_log (id uuid not null default gen_random_uuid(), device_id text not null, date date not null, steps integer not null, created_at timestamp with time zone default now());
-- --   create table public.workout_selection (id uuid not null default gen_random_uuid(), device_id text not null, date date not null, day integer not null, label text not null, created_at timestamp with time zone default now());
-- --   CREATE UNIQUE INDEX exercise_swaps_pkey ON public.exercise_swaps USING btree (id);
-- --   CREATE UNIQUE INDEX exercise_swaps_device_id_week_day_original_exercise_key ON public.exercise_swaps USING btree (device_id, week, day, original_exercise);
-- --   CREATE UNIQUE INDEX food_entries_pkey ON public.food_entries USING btree (id);
-- --   CREATE UNIQUE INDEX food_entries_device_id_entry_id_key ON public.food_entries USING btree (device_id, entry_id);
-- --   CREATE INDEX idx_food_entries_device_date ON public.food_entries USING btree (device_id, date);
-- --   CREATE UNIQUE INDEX habit_log_pkey ON public.habit_log USING btree (id);
-- --   CREATE UNIQUE INDEX habit_log_device_id_date_key ON public.habit_log USING btree (device_id, date);
-- --   CREATE INDEX idx_habit_log_device_date ON public.habit_log USING btree (device_id, date);
-- --   CREATE UNIQUE INDEX habit_notes_pkey ON public.habit_notes USING btree (id);
-- --   CREATE UNIQUE INDEX habit_notes_device_id_date_habit_index_key ON public.habit_notes USING btree (device_id, date, habit_index);
-- --   CREATE UNIQUE INDEX step_log_pkey ON public.step_log USING btree (id);
-- --   CREATE UNIQUE INDEX step_log_device_id_date_key ON public.step_log USING btree (device_id, date);
-- --   CREATE UNIQUE INDEX workout_selection_pkey ON public.workout_selection USING btree (id);
-- --   CREATE UNIQUE INDEX workout_selection_device_id_date_key ON public.workout_selection USING btree (device_id, date);

-- ─── 1. Only the database owner and the service role may make HTTP calls ─────
-- postgres runs the cron jobs; the SECURITY DEFINER triggers (welcome_new_lead,
-- notify_ticket_reply) and the dispatch_* functions are owned by postgres and
-- keep running as postgres, so nothing that uses pg_net today notices.

-- Nothing to run for pg_net. The attempt is left here as the record, because
-- the natural next move is to try exactly this and read the silence as
-- success: `revoke ... from public` on a function you do not own raises a
-- WARNING, not an error, and changes nothing. net and every function in it
-- are owned by supabase_admin, a superuser this project's postgres role is
-- not a member of. Only Supabase can change those grants.
--
-- It does not matter today, and this is the reasoning rather than a hope:
-- PostgREST is configured with db_schema = "public, graphql_public", so the
-- net schema has no route through the API. Asked for it by name the API
-- answers "Invalid schema: net" (PGRST106), and /rest/v1/rpc/http_post
-- resolves against public, where no such function exists (PGRST202). Both
-- checked with the anon key. No SECURITY INVOKER function in public calls
-- net.*, so there is no indirect path either: the five callers
-- (welcome_new_lead, notify_ticket_reply, dispatch_guide_emails,
-- dispatch_monthly_backups and the send-reminders cron command) are all
-- SECURITY DEFINER owned by postgres, or cron commands running as postgres.
--
-- What would make it matter: adding net to the exposed schema list, or
-- writing a SECURITY INVOKER function in public that calls net.http_post.
-- Neither should ever happen, and now there is a note saying why.

-- ─── 2. The six tables that are not this project's ──────────────────────────
drop table if exists public.exercise_swaps;
drop table if exists public.food_entries;
drop table if exists public.habit_log;
drop table if exists public.habit_notes;
drop table if exists public.step_log;
drop table if exists public.workout_selection;

notify pgrst, 'reload schema';
