-- CredentialDOMD QA lab seed: the configuration rows the app and its functions
-- read before any member exists. Applied by qa-lab/apply-schema.mjs after the
-- reconstructed schema, in one transaction.
--
-- THE REPOSITORY IS PUBLIC. This file holds configuration only: no profiles, no
-- member data, no secrets. The only addresses are synthetic, on the reserved
-- test domain qa.credentialdomd.test (tests/qa-lab/seed.test.mjs enforces it).
--
-- Copied from production on 2026-09-29 (configuration tables only; parity.mjs
-- compares these rows with production on every run, so drift is reported):
--   public.access_policy_settings  (singleton: launch gates and price phase)
--   public.vera_source_settings    (singleton)
-- Synthetic, because production's rows hold member mailboxes:
--   public.limited_beta_cohorts, public.limited_founding_programs,
--   public.limited_founding_slots  (a TEST-MODE founding program, livemode = false,
--   with two synthetic promised places, built by the same functions production uses)
-- Deliberately empty:
--   public.app_secrets (production AI keys), public.app_admins and every member table.

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

-- 2. A sealed synthetic cohort and the test-mode founding program (capacity 100).
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

-- 3. Production's gate values (as of 2026-09-29): checkout and public founding on.
update public.access_policy_settings
   set limited_checkout_enabled = true,
       public_founding_enabled = true
 where singleton;

reset role;
