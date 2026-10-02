-- docs/rollback/20261002060000_credential_portal_app_licenses.rollback.sql
-- Rollback for 20261002060000_credential_portal_app_licenses.sql.
--
-- Restores the physician-only licence check of 20260925040000 and drops the
-- app licence type list. PA and NP licence, prescriptive authority and
-- practice agreement records (and their files) leave every live grant at the
-- next view, and selecting one of their files is refused again (409
-- document_not_shareable). Grant and invitation rows are not touched.
-- Idempotent.
create or replace function public.credential_portal_license_ok(p_type text, p_name text)
returns boolean language sql immutable set search_path=public,pg_temp as $$
 select coalesce(p_type,'') ~* '(medical licen[cs]e|state medical|osteopathic|\mdea\M|controlled substance|board|ecfmg|usmle|comlex|\mbls\M|\macls\M|\matls\M|\mpals\M|\mnrp\M|fluoroscop|laser|certif)'
  and coalesce(p_type,'')||' '||coalesce(p_name,'') !~* '(driver|passport|state id|photo id|id card|identification|real id|\mtsa\M|precheck|global entry|nexus|\mvisa\M|travel|boarding|social security|\mssn\M|birth|green card|citizenship|naturali[sz]ation|marriage|divorce|name change)'
$$;
revoke all on function public.credential_portal_license_ok(text,text) from public, anon, authenticated;
grant execute on function public.credential_portal_license_ok(text,text) to service_role;
drop function if exists public.credential_portal_license_types();
