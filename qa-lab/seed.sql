-- CredentialDOMD QA lab seed: the configuration rows the app and its functions
-- read before any member exists. Applied by qa-lab/apply-schema.mjs after the
-- reconstructed schema, in one transaction.
--
-- THE REPOSITORY IS PUBLIC. This file holds configuration only: no profiles, no
-- member data, no secrets. The only addresses are synthetic, on the reserved
-- test domain qa.credentialdomd.test (tests/qa-lab/public-repo-safety.test.mjs enforces it).
--
-- Copied from production on 2026-09-29 (configuration tables only; parity.mjs
-- compares these rows with production on every run, so drift is reported):
--   public.access_policy_settings  (singleton: launch gates and price phase)
--   public.vera_source_settings    (singleton)
--   public.welcome_email_settings  (singleton, OFF: the paid-member welcome email
--                                   sends nothing until the owner approves it in
--                                   Admin > Emails; the migration inserts this row,
--                                   and without it that screen says "settings missing")
-- Synthetic, because production's rows hold member mailboxes:
--   public.limited_beta_cohorts, public.limited_founding_programs,
--   public.limited_founding_slots  (founding programs built by the same functions
--   production uses. LIVE mode, the mode the lab runs like production (see
--   qa-lab/lib/functions-env.mjs): as many promised places as production's program
--   has (4, read-only aggregate on 2026-09-29), so public places, founding numbers
--   and the point where $99 closes match live (96 public places). qa:parity compares
--   the live program's promise count and promised places with production's. TEST
--   mode: two promised places, lab-only (parity explains it).)
--   public.clerk_continuity_runs / _accounts / _events  (an enabled continuity run
--   for the lab's own Clerk issuers, as production has one for its issuers, with one
--   synthetic legacy member; built by stage_clerk_continuity)
-- Deliberately empty:
--   public.app_secrets (production AI keys; `npm run qa:lab` later stores two random
--   lab placeholders there so ai-proxy has a key to send to the mock AI),
--   public.app_admins and every member table.

set role postgres;

-- 1. Gates closed first: prepare_founding_program() refuses to run while
--    checkout or public founding allocation is on.
insert into public.access_policy_settings
  (singleton, policy_version, enforcement_enabled, price_phase, limited_checkout_enabled,
   limited_invitation_enabled, limited_self_service_enabled, limited_self_service_price_phase,
   public_founding_enabled)
values
  (true, '2026-09-19-credential-practice-v1', true, 'founding', false,
   false, true, 'founding',
   false);

insert into public.vera_source_settings (singleton, enabled) values (true, false);

insert into public.welcome_email_settings (singleton, enabled) values (true, false);

-- 2. Sealed synthetic cohorts and the founding programs (capacity 100 each).
--    Test mode: two promised places (lab-only; production has no test-mode program).
select public.seal_limited_free_beta_cohort(
  'qa_lab_founding_promises',
  encode(sha256(convert_to('["qa-promised-1@qa.credentialdomd.test","qa-promised-2@qa.credentialdomd.test"]', 'UTF8')), 'hex'),
  '["qa-promised-1@qa.credentialdomd.test","qa-promised-2@qa.credentialdomd.test"]'::jsonb,
  'QA lab synthetic cohort: two test addresses, not production data');

select public.prepare_founding_program(
  false,
  'qa_lab_founding_promises',
  encode(sha256(convert_to('["qa-promised-1@qa.credentialdomd.test","qa-promised-2@qa.credentialdomd.test"]', 'UTF8')), 'hex'),
  2);

-- Live mode (production's only program is livemode = true, with 4 promised places,
-- and the lab runs CREDENTIALDOMD_BILLING_MODE=live against its mock Stripe).
select public.seal_limited_free_beta_cohort(
  'qa_lab_founding_promises_live',
  encode(sha256(convert_to('["qa-promised-1@qa.credentialdomd.test","qa-promised-2@qa.credentialdomd.test","qa-promised-3@qa.credentialdomd.test","qa-promised-4@qa.credentialdomd.test"]', 'UTF8')), 'hex'),
  '["qa-promised-1@qa.credentialdomd.test","qa-promised-2@qa.credentialdomd.test","qa-promised-3@qa.credentialdomd.test","qa-promised-4@qa.credentialdomd.test"]'::jsonb,
  'QA lab synthetic cohort: four test addresses (production promised four founding places), not production data');

select public.prepare_founding_program(
  true,
  'qa_lab_founding_promises_live',
  encode(sha256(convert_to('["qa-promised-1@qa.credentialdomd.test","qa-promised-2@qa.credentialdomd.test","qa-promised-3@qa.credentialdomd.test","qa-promised-4@qa.credentialdomd.test"]', 'UTF8')), 'hex'),
  4);

-- 2b. Clerk continuity for the lab's issuers. Production has an enabled run whose
--     target is its Clerk issuer, so every sign-in goes through
--     initialize-clerk-profile and a direct profile insert is refused
--     (clerk_continuity_insert_lock). The lab mirrors that for its own issuers
--     (qa-lab/lib/lab-config.mjs: LAB_ISSUER, LAB_LEGACY_ISSUER). One synthetic
--     legacy member, never a real account: [profile, legacy subject, verified
--     primary email, legacy updated ms, legacy created ms, lifetime eligible].
with m(members) as (select '[[null, "user_qalegacy1", "qa-legacy-1@qa.credentialdomd.test", 1789000000000, 1788000000000, false]]'::jsonb)
select public.stage_clerk_continuity(
  'c1a0c1a0-0000-4000-8000-000000000001'::uuid,
  'https://clerk-legacy.qa.credentialdomd.test',
  'https://clerk.qa.credentialdomd.test',
  '2026-09-29T00:00:00Z'::timestamptz,
  (select encode(sha256(convert_to('[' || string_agg(value::text, ',' order by (value->>1) collate "C") || ']', 'UTF8')), 'hex') from jsonb_array_elements(members)),
  members)
from m;

select public.set_clerk_continuity_enabled(
  'c1a0c1a0-0000-4000-8000-000000000001'::uuid,
  (select r.manifest_sha256 from public.clerk_continuity_runs r where r.id = 'c1a0c1a0-0000-4000-8000-000000000001'::uuid),
  true);

-- 3. Production's gate values (as of 2026-09-29): checkout and public founding on.
update public.access_policy_settings
   set limited_checkout_enabled = true,
       public_founding_enabled = true
 where singleton;

reset role;

-- 4. Which seed this database holds. qa-lab/apply-schema.mjs compares it with
--    this file and refuses to run the lab on an older seed (rebuild instead).
create table if not exists qa_lab.seed_version (version integer not null, applied_at timestamptz not null default now());
insert into qa_lab.seed_version (version) values (4);
