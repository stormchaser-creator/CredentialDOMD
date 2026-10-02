-- Administrator access shares a PA's and an NP's licences, not only a
-- physician's (release/goal3 lab, 2026-10-02).
-- File: supabase/migrations/20261002060000_credential_portal_app_licenses.sql
-- Rollback: docs/rollback/20261002060000_credential_portal_app_licenses.rollback.sql
--
-- WHY. credential_portal_license_ok (20260925040000) decides which Licenses
-- records, and so which of their files, a standing administrator grant shows
-- and a one-time invitation may select. It matched physician licence words
-- only. A PA's "State Physician Assistant License", an NP's "APRN License (NP)"
-- and "RN License", and "Prescriptive Authority", "Practice Agreement", "PANCE"
-- and "NCLEX-RN" records were left out of every grant, and selecting one of
-- their files was refused (409 document_not_shareable), while the app tells a
-- PA or NP member that their licences are in Licenses.
--
-- WHAT. Only the type check changes. A licence record's type passes when it is
--   * matched by the physician pattern of 20260925040000, unchanged, or
--   * one the app offers for any profession (credential_portal_license_types,
--     the same list as ALL_LICENSE_TYPES in src/constants/credentialTypes.js
--     without "Other"; tests/credential-portal/app-licenses.test.mjs fails when
--     the two differ), or
--   * a typed variant the app itself reads as a PA, APRN or RN licence, a
--     prescriptive authority or a practice agreement (licenseKindOf in
--     src/constants/professions.js; the same test compares the two). A JS "."
--     never crosses a line break and a Postgres ARE "." does, so the APRN and
--     RN patterns spell the JS "." as [^\n\r\u2028\u2029]: "APRN" and
--     "license" on two lines of a type are not read as an APRN licence by the
--     app and are not shared here either.
--     Likewise the leading space the RN, prescriptive authority and
--     practice agreement patterns allow is spelled as the JS "\s" class
--     ([\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]),
--     not as the Postgres "\s": production's database uses the ICU locale,
--     where "\s" also matches U+001C-U+001F and U+0085, so "\x1fRN License",
--     which the app does not read as an RN licence, would have been shared,
--     and "\ufeffRN License", which it does, refused. Under ICU, "\y" counts
--     non-ASCII letters as word characters where the JS "\b" does not; that
--     can only refuse a type the app reads (fail closed), never share one.
-- The name check is the 20260925040000 line, byte for byte, applied to every
-- record as before: the type and the name together are refused for any
-- identity, travel, boarding or birth word. "Other" is still never shared, and
-- the owner, path and section checks in credential_portal_records and
-- credential_portal_scope_documents are not touched. Every record shared
-- before is still shared; every record refused before for its name is still
-- refused, whatever its type.
--
-- Known limitation, accepted: a licence whose type or name contains one of
-- those words ("Compact licence for travel assignments", "Birth center
-- collaborative agreement") is not shared. When the word is in the name,
-- renaming the record shares it. When it is in the type (a free-text type
-- from an import or the scanner, such as "RN License (travel)"), renaming does
-- not: changing the type to one the app lists shares it, since no listed type
-- contains such a word. The administrator-access preview lists only what is
-- shared, so the record simply does not appear there.
--
-- Idempotent. No top-level transaction: the Supabase CLI wraps the file.

do $$
begin
  if to_regprocedure('public.credential_portal_license_ok(text,text)') is null then
    raise exception 'credential_portal_app_licenses: public.credential_portal_license_ok(text,text) is missing (20260925040000)';
  end if;
end $$;

-- Every licence type the app offers a member of any profession, except
-- "Other". Kept equal to ALL_LICENSE_TYPES by app-licenses.test.mjs.
create or replace function public.credential_portal_license_types()
returns text[] language sql immutable set search_path=public,pg_temp as $$
 select array[
  'State Medical License','DEA Registration','State Controlled Substance','Board Certification (ABMS)','ECFMG Certificate','USMLE',
  'BLS Certification','ACLS Certification','ATLS Certification','Fluoroscopy Permit','Laser Safety Certificate','Certification',
  'State Medical License (DO)','State Medical License (MD-equiv)','Board Certification (AOA)','COMLEX',
  'State Physician Assistant License','Prescriptive Authority','Practice Agreement','Board Certification (NCCPA)','PANCE','PALS Certification',
  'APRN License (NP)','RN License','RN License (Multistate)','Board Certification (AANPCB)','Board Certification (ANCC)',
  'Board Certification (PNCB)','Board Certification (NCC)','Board Certification (AACN)','NCLEX-RN','NRP Certification'
 ]::text[]
$$;

-- Licences: professional licences, registrations and certifications only.
-- The type must read as one; then the type AND the name are checked, exactly
-- as on 2026-09-25, for anything that reads as a driver's licence, passport,
-- identity card, travel or civil record, because "Certification" is a
-- first-class type whose name is free text (production holds a driver's
-- licence filed under licences).
create or replace function public.credential_portal_license_ok(p_type text, p_name text)
returns boolean language sql immutable set search_path=public,pg_temp as $$
 select (
   coalesce(p_type,'') ~* '(medical licen[cs]e|state medical|osteopathic|\mdea\M|controlled substance|board|ecfmg|usmle|comlex|\mbls\M|\macls\M|\matls\M|\mpals\M|\mnrp\M|fluoroscop|laser|certif)'
   or btrim(coalesce(p_type,'')) = any(public.credential_portal_license_types())
   or coalesce(p_type,'') ~* 'physician([''‘’ʼ′]?s)? (assistant|associate) licen[sc]e'
   or coalesce(p_type,'') ~* '\y(aprn|arnp|crnp|apn|nurse practitioner)\y[^\n\r\u2028\u2029]*\y(licen[sc]e|certificate|certification|recognition|approval|registration)\y'
   or coalesce(p_type,'') ~* '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*(rn|registered nurse)\y[^\n\r\u2028\u2029]*licen[sc]e'
   or coalesce(p_type,'') ~* '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*(prescriptive authority|practice agreement)\y'
  )
  and coalesce(p_type,'')||' '||coalesce(p_name,'') !~* '(driver|passport|state id|photo id|id card|identification|real id|\mtsa\M|precheck|global entry|nexus|\mvisa\M|travel|boarding|social security|\mssn\M|birth|green card|citizenship|naturali[sz]ation|marriage|divorce|name change)'
$$;

-- Service role only, like every credential_portal_ function.
revoke all on function public.credential_portal_license_types() from public, anon, authenticated;
grant execute on function public.credential_portal_license_types() to service_role;
revoke all on function public.credential_portal_license_ok(text,text) from public, anon, authenticated;
grant execute on function public.credential_portal_license_ok(text,text) to service_role;
