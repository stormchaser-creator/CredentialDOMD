// The tables the owner notifier reads, in production's shapes trimmed to the
// columns it reads (2026-09-29). Shared by the iMessage notifier's tests
// (signup-notify.test.mjs) and the email notifier's (owner-notify-email-sql).
export const BASE = `
create table profiles(id uuid primary key, auth_user_id text, name text, email text, created_at timestamptz default now());
create table app_admins(profile_id uuid primary key);
create function public.is_admin(p uuid) returns boolean language sql stable as $$ select exists(select 1 from app_admins where profile_id = p) $$;
create table early_access_leads(id uuid primary key default gen_random_uuid(), email text, name text, source text, waitlist boolean, created_at timestamptz default now());
create table founding_signups(id uuid primary key default gen_random_uuid(), name text, email text, created_at timestamptz default now());
create table waitlist_attempts(id uuid primary key default gen_random_uuid(), name text, email text, stage text, created_at timestamptz default now());
create table support_tickets(id uuid primary key, user_id uuid, subject text, created_at timestamptz default now());
create table support_messages(id uuid primary key, ticket_id uuid, author_id uuid, body text not null, is_admin_reply boolean default false,
  created_at timestamptz default now(), attachment_path text, client_request_id uuid, verification_id uuid, emailed_at timestamptz);
create table client_errors(id uuid primary key default gen_random_uuid(), auth_user_id text, kind text, message text, created_at timestamptz default now());
create table beta_access(id uuid primary key default gen_random_uuid(), email text, name text, status text, invite_sent_at timestamptz, activated_at timestamptz);
`;
export const OPTIONAL = `
create table feedback(id uuid primary key default gen_random_uuid(), user_id uuid, rating smallint, message text, context_page text, created_at timestamptz default now());
create table billing_checkout_attempts(profile_id uuid, livemode boolean, attempt_id uuid unique, offer_id text, state text, created_at timestamptz default now(), primary key(profile_id, livemode));
create table limited_billing_quotes(attempt_id uuid primary key, profile_id uuid, livemode boolean, offer_id text, price_phase text, annual_cents integer, created_at timestamptz default now());
create table limited_paid_purchase_history(subscription_id text, livemode boolean, profile_id uuid, quote_id uuid, first_verified_invoice_id text,
  first_verified_paid_at timestamptz, offer_id text, price_phase text, annual_cents integer, primary key(subscription_id, livemode));
create table access_purchase_receipts(invoice_id text, livemode boolean, profile_id uuid, subscription_id text, price_phase text, annual_cents integer, paid_at timestamptz);
create table billing_subscriptions(profile_id uuid, livemode boolean, subscription_id text, offer_id text, status text, membership_active boolean, updated_at timestamptz default now());
create table lifetime_gift_reservations(id uuid primary key, email text, livemode boolean, claimed_profile_id uuid, claimed_at timestamptz, revoked_at timestamptz);
create table invite_to_join_sends(id uuid primary key, invited_by uuid, email text not null, name text, status text not null, explicit_resend boolean not null default false,
  offer_phase text not null, offer_annual_cents integer not null, provider_id text, created_at timestamptz default now(), sent_at timestamptz, updated_at timestamptz default now());
create table limited_refund_requests(id uuid primary key, profile_id uuid, livemode boolean, offer_id text, amount_cents integer, paid_at timestamptz,
  state text not null default 'requested', subscription_canceled_at timestamptz, refund_id text, refund_status text, error_code text, support_ticket_id uuid,
  lease_until timestamptz, requested_at timestamptz default now(), updated_at timestamptz default now());
`;
