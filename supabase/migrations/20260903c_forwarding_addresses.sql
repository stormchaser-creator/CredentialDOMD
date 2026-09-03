-- Forwarding addresses (2026-09-03).
--
-- Credentialing mail lands at a work address. A physician who signed up as
-- name@gmail.com forwards it from name@hospital.org, and email-inbound
-- (matchProfile) refuses the message because it matches the sender against
-- profiles.email only. This table is the second place that matcher looks:
-- extra addresses a physician has registered and CONFIRMED.
--
-- The security property this table exists to hold: a verified row routes a
-- forwarded credentialing email, attachments and all, into the account that
-- owns it. So an address is usable only after the person holding that mailbox
-- clicks a link sent to it, and a verified address belongs to exactly one
-- account.
--
--   forwarding_addresses_verified_email_key
--     partial unique index on lower(email) WHERE verified_at is not null.
--     Two accounts may both have the address pending; the first to click
--     verifies, and the forwarding-address function deletes the loser's
--     pending row. The index, not the function, is what makes that true.
--
--   token_hash is the SHA-256 hash of the 32 random bytes emailed to the
--   address. The raw token is never stored, logged or returned. Verifying
--   clears the hash, so a link works once, and token_expires_at retires it
--   after 24 hours whether or not anyone clicks.
--
-- Reads: the owner may select their own rows, MINUS token_hash, which is
-- excluded at the grant (column-level SELECT), so no client role can read the
-- column even through a policy that lets the row through. The owner may
-- insert (user_id, email only: a row a client writes carries no token and
-- verifies nothing) and delete their own rows. Everything that matters is done
-- by the forwarding-address edge function with the service role.
--
-- forwarding_address_sends is the per-account send ledger behind the "10
-- confirmation emails per account per day" cap. It lives outside
-- forwarding_addresses on purpose: the owner may delete an address row, and a
-- cap counted from rows the sender can delete is not a cap. It holds no
-- address, only which account sent and when. Service role only.
--
-- NOT APPLIED by the worktree checkout. Applied to hkpnnsjcwprrwobmpqyy on
-- 2026-09-03 through the management API.

create table if not exists public.forwarding_addresses (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  email             text not null,                 -- stored lowercased and trimmed
  verified_at       timestamptz,                   -- null = pending, set = usable by email-inbound
  token_hash        text,                          -- sha256 hex of the emailed token; cleared on verify
  token_expires_at  timestamptz,
  last_sent_at      timestamptz,                   -- last confirmation email for THIS address (10 minute floor)
  created_at        timestamptz default now()
);

-- Stored normalized, so every lookup (here and in email-inbound) can compare
-- exactly. A client with the INSERT grant cannot slip 'Foo@Bar.com' past the
-- uniqueness checks by writing it in another case.
alter table public.forwarding_addresses drop constraint if exists forwarding_addresses_email_normalized;
alter table public.forwarding_addresses add constraint forwarding_addresses_email_normalized
  check (email = lower(btrim(email)) and position('@' in email) > 1 and length(email) between 6 and 254);

-- One account per verified address. Pending duplicates are allowed.
create unique index if not exists forwarding_addresses_verified_email_key
  on public.forwarding_addresses (lower(email)) where verified_at is not null;

-- An account lists an address once, verified or not.
create unique index if not exists forwarding_addresses_owner_email_key
  on public.forwarding_addresses (user_id, lower(email));

create index if not exists idx_forwarding_addresses_user
  on public.forwarding_addresses (user_id, created_at desc);

-- The verify GET looks a row up by hash; email-inbound looks one up by address.
create index if not exists idx_forwarding_addresses_token
  on public.forwarding_addresses (token_hash) where token_hash is not null;

create index if not exists idx_forwarding_addresses_verified_lookup
  on public.forwarding_addresses (email) where verified_at is not null;

alter table public.forwarding_addresses enable row level security;

revoke all on table public.forwarding_addresses from anon;
revoke all on table public.forwarding_addresses from authenticated;
-- token_hash is deliberately absent from this list, and there is no UPDATE grant.
grant select (id, user_id, email, verified_at, token_expires_at, last_sent_at, created_at)
  on table public.forwarding_addresses to authenticated;
grant insert (user_id, email) on table public.forwarding_addresses to authenticated;
grant delete on table public.forwarding_addresses to authenticated;

drop policy if exists forwarding_addresses_owner_select on public.forwarding_addresses;
create policy forwarding_addresses_owner_select on public.forwarding_addresses
  for select to authenticated
  using (user_id = public.current_profile_id());

drop policy if exists forwarding_addresses_owner_insert on public.forwarding_addresses;
create policy forwarding_addresses_owner_insert on public.forwarding_addresses
  for insert to authenticated
  with check (user_id = public.current_profile_id());

drop policy if exists forwarding_addresses_owner_delete on public.forwarding_addresses;
create policy forwarding_addresses_owner_delete on public.forwarding_addresses
  for delete to authenticated
  using (user_id = public.current_profile_id());

comment on table public.forwarding_addresses is
  'Extra sender addresses a physician has confirmed for email forwarding. email-inbound matches a sender here when profiles.email misses. Verified addresses are unique across accounts (partial unique index). Owner select (no token_hash) / insert / delete; the forwarding-address function does the real work with the service role.';
comment on column public.forwarding_addresses.token_hash is
  'SHA-256 hex of the confirmation token. Never granted to a client role; cleared on verify so a link works once.';

-- ── Send ledger: the per-account daily cap ───────────────────────────────────
create table if not exists public.forwarding_address_sends (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references public.profiles(id) on delete cascade,
  sent_at  timestamptz not null default now()
);

create index if not exists idx_forwarding_address_sends_user_time
  on public.forwarding_address_sends (user_id, sent_at desc);

alter table public.forwarding_address_sends enable row level security;
revoke all on table public.forwarding_address_sends from anon;
revoke all on table public.forwarding_address_sends from authenticated;
-- No policies at all: service role only, by design.

comment on table public.forwarding_address_sends is
  'One row per confirmation email sent by the forwarding-address function. Counted for the 10-per-account-per-day cap. Kept out of forwarding_addresses because the owner can delete address rows. Service role only.';

notify pgrst, 'reload schema';
