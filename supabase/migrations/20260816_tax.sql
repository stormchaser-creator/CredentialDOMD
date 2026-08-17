-- Tax Prep filing profile (2026-08-16).
-- profiles.tax_prep (jsonb) already exists (20260811_tax_prep.sql). No schema
-- change: the estimator now reads two more keys from it, residentState
-- (2-letter, null until set) and filingStatus ('mfj' | 'single' | 'mfs' |
-- 'hoh', null until set). Nothing is defaulted in code; each user picks both
-- in Finance > Tax Prep before any estimate is shown.
--
-- Founder profile: merge residentState/filingStatus into the existing jsonb
-- (keeps entity, scorpSalary, otherIncome, priorYearTax as they are).
-- NOT applied by the tax worktree; run when the owner is ready.
update public.profiles
   set tax_prep = coalesce(tax_prep, '{}'::jsonb)
                  || jsonb_build_object('residentState', 'CA', 'filingStatus', 'mfj'),
       updated_at = now()
 where id = 'a676337e-16be-44be-a4c3-9b28b16a3966';
