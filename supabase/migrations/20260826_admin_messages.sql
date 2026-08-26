-- Admin-to-physician messaging (2026-08-26).
--
-- A private channel between Eric and each physician, separate from support
-- tickets: he can send a note to one physician or broadcast to everyone, it
-- shows as a card on their home dashboard, and they can reply. Replies land
-- in the admin Messages tab. No public/social surface — see support ticket
-- 3d708c3b for the scoping discussion.
--
-- admin_messages: the top-level note. recipient_id null = broadcast to every
-- active physician; a value = sent to that one profile.
--
-- admin_message_replies: one row per reply. user_id is whose thread the
-- reply belongs to — for a targeted message it's always the recipient; for
-- a broadcast, each physician who replies gets their own thread scoped by
-- user_id, so one broadcast can fan out into many private conversations
-- without physicians seeing each other's replies.

create table if not exists public.admin_messages (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references public.profiles(id),
  recipient_id uuid references public.profiles(id),   -- null = broadcast
  subject      text,
  body         text not null,
  created_at   timestamptz not null default now()
);

create table if not exists public.admin_message_replies (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid not null references public.admin_messages(id) on delete cascade,
  user_id        uuid not null references public.profiles(id),  -- whose thread
  author_id      uuid not null references public.profiles(id),  -- who wrote this reply
  body           text not null,
  is_admin_reply boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists idx_admin_messages_recipient
  on public.admin_messages (recipient_id, created_at desc);

create index if not exists idx_admin_message_replies_thread
  on public.admin_message_replies (message_id, user_id, created_at);

alter table public.admin_messages enable row level security;
alter table public.admin_message_replies enable row level security;

revoke all on table public.admin_messages from anon;
revoke all on table public.admin_messages from authenticated;
grant select, insert on table public.admin_messages to authenticated;

revoke all on table public.admin_message_replies from anon;
revoke all on table public.admin_message_replies from authenticated;
grant select, insert on table public.admin_message_replies to authenticated;

drop policy if exists admin_messages_select on public.admin_messages;
create policy admin_messages_select on public.admin_messages
  for select to authenticated
  using (
    is_admin(public.current_profile_id())
    or recipient_id = public.current_profile_id()
    or recipient_id is null
  );

drop policy if exists admin_messages_insert on public.admin_messages;
create policy admin_messages_insert on public.admin_messages
  for insert to authenticated
  with check (
    is_admin(public.current_profile_id())
    and sender_id = public.current_profile_id()
  );

drop policy if exists admin_message_replies_select on public.admin_message_replies;
create policy admin_message_replies_select on public.admin_message_replies
  for select to authenticated
  using (
    is_admin(public.current_profile_id())
    or user_id = public.current_profile_id()
  );

drop policy if exists admin_message_replies_insert on public.admin_message_replies;
create policy admin_message_replies_insert on public.admin_message_replies
  for insert to authenticated
  with check (
    author_id = public.current_profile_id()
    and (
      is_admin(public.current_profile_id())
      or (
        user_id = public.current_profile_id()
        and exists (
          select 1 from public.admin_messages m
          where m.id = message_id
            and (m.recipient_id = public.current_profile_id() or m.recipient_id is null)
        )
      )
    )
  );

comment on table public.admin_messages is
  'Admin-to-physician notes, individual or broadcast (recipient_id null). Admin insert only; owner + admin select.';
comment on table public.admin_message_replies is
  'Replies to admin_messages, threaded per (message_id, user_id) so broadcast replies stay private between the admin and each physician.';

-- Admin's Messages tab: one row per sent message, with recipient email
-- (null for broadcast) and reply-thread count.
create or replace view public.admin_messages_overview as
  select
    m.id, m.subject, m.body, m.created_at, m.recipient_id,
    p.email as recipient_email,
    p.name as recipient_name,
    (select count(*) from public.admin_message_replies r where r.message_id = m.id) as reply_count
  from public.admin_messages m
  left join public.profiles p on p.id = m.recipient_id
  where is_admin(public.current_profile_id())
  order by m.created_at desc;

-- Admin's per-message reply threads, one row per physician who has replied.
create or replace view public.admin_message_reply_threads as
  select
    r.message_id,
    r.user_id,
    p.email as user_email,
    p.name as user_name,
    count(*) as reply_count,
    max(r.created_at) as last_reply_at
  from public.admin_message_replies r
  left join public.profiles p on p.id = r.user_id
  where is_admin(public.current_profile_id())
  group by r.message_id, r.user_id, p.email, p.name;

-- A physician's own inbox: messages addressed to them plus every broadcast.
create or replace view public.my_admin_messages as
  select m.id, m.subject, m.body, m.created_at, m.recipient_id
  from public.admin_messages m
  where m.recipient_id = public.current_profile_id() or m.recipient_id is null
  order by m.created_at desc;

grant select on public.admin_messages_overview to authenticated;
grant select on public.admin_message_reply_threads to authenticated;
grant select on public.my_admin_messages to authenticated;

notify pgrst, 'reload schema';
