-- Administrator access: a standing, view-only, healthcare-only credential share.
--
-- Follows 20260918091000_credential_portal.sql (never edited). Applies cleanly
-- on top of it and is safe to apply twice. Nothing here is granted to anon or
-- authenticated: the credential-portal Edge function (service role) is the only
-- caller, as before.
--
-- What changes:
--   * A grant row can be kind 'standing': one recipient, a purpose, an end date
--     of 14/30/90/180 days (hard cap 180 from creation or last extension), a
--     downloads switch, and a scope jsonb that holds the section and custom
--     category choices. Choices live ON THE GRANT ROW, never as columns on the
--     synced app tables (an unknown top-level key rejects a whole synced row).
--   * What a standing grant shows is evaluated LIVE at every list and file
--     request by an allowlist written here, never derived from COLLECTION_KEYS
--     or the app's "credential" scope. A new table or column stays hidden until
--     someone adds it below on purpose.
--   * Files are owned when storage_path is "<one of clerk_storage_subjects>/<id>"
--     (legacy Clerk subjects count), for both kinds.
--   * Every owner check also asks account_is_closed().
--   * Selection invitations must pass the same healthcare allowlist, checked
--     at creation and on every later request.
--   * Scope refusals (a category not on the server, a malformed scope) are
--     returned as states, never raised, so the owner gets a 4xx they can act on.
--   * The owner list counts file activity and visits over every audit row.
--   * Outbox payloads live at most 1 hour; credential_portal_prune runs every
--     5 minutes through pg_cron and removes closed accounts' grants.
begin;

do $$ begin
  if to_regclass('public.credential_portal_invites') is null then
    raise exception 'apply 20260918091000_credential_portal.sql first';
  end if;
  if to_regprocedure('public.account_is_closed(uuid)') is null then
    raise exception 'account_is_closed prerequisite missing (20260918a_mailbox_account_events.sql)';
  end if;
  if to_regprocedure('public.clerk_storage_subjects(uuid)') is null then
    raise exception 'clerk_storage_subjects prerequisite missing (20260920120000_clerk_identity_continuity.sql)';
  end if;
end $$;

-- Grant row ----------------------------------------------------------------
alter table public.credential_portal_invites
  add column if not exists kind text not null default 'selection',
  add column if not exists purpose text,
  add column if not exists allow_download boolean not null default true,
  add column if not exists scope jsonb not null default '{}'::jsonb,
  add column if not exists extended_at timestamptz,
  add column if not exists last_verified_at timestamptz,
  add column if not exists otp_failures_total integer not null default 0;

alter table public.credential_portal_invites drop constraint if exists credential_portal_invites_kind_check;
alter table public.credential_portal_invites add constraint credential_portal_invites_kind_check
  check (kind in ('selection','standing'));
alter table public.credential_portal_invites drop constraint if exists credential_portal_invites_purpose_check;
alter table public.credential_portal_invites add constraint credential_portal_invites_purpose_check
  check (purpose is null or char_length(purpose) between 1 and 120);
alter table public.credential_portal_invites drop constraint if exists credential_portal_invites_standing_check;
alter table public.credential_portal_invites add constraint credential_portal_invites_standing_check
  check (kind <> 'standing' or (purpose is not null and jsonb_typeof(scope) = 'object'
    and expires_at <= coalesce(extended_at, created_at) + interval '180 days'));

-- Audit --------------------------------------------------------------------
alter table public.credential_portal_audit add column if not exists content_digest text;
alter table public.credential_portal_audit drop constraint if exists credential_portal_audit_content_digest_check;
alter table public.credential_portal_audit add constraint credential_portal_audit_content_digest_check
  check (content_digest is null or content_digest ~ '^[a-f0-9]{64}$');
alter table public.credential_portal_audit drop constraint if exists credential_portal_audit_event_check;
alter table public.credential_portal_audit add constraint credential_portal_audit_event_check
  check (event in ('invitation_created','invitation_revoked','session_verified','documents_listed',
    'document_response_prepared','document_unavailable','summary_listed','download_refused','link_resent','grant_updated'));

create index if not exists credential_portal_audit_invite_time on public.credential_portal_audit(invite_id, created_at desc);
create index if not exists credential_portal_invites_owner on public.credential_portal_invites(owner_profile_id, created_at desc);

-- Owner and path rules -----------------------------------------------------
create or replace function public.credential_portal_owner_ready(p_owner uuid, p_subject text)
returns boolean language sql stable security invoker set search_path=public,pg_temp as $$
 select exists(select 1 from profiles where id=p_owner and auth_user_id=p_subject and access_status='active' and deleted_at is null)
  and not public.account_is_closed(p_owner)
$$;

-- The only file shape the portal will read: "<owned subject>/<document id>".
create or replace function public.credential_portal_owned_path(p_owner uuid, p_path text, p_document uuid)
returns boolean language sql stable security invoker set search_path=public,pg_temp as $$
 select coalesce(p_path ~ '^user_[A-Za-z0-9]+/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and split_part(p_path,'/',2)=p_document::text
  and split_part(p_path,'/',1)=any(public.clerk_storage_subjects(p_owner)), false)
$$;

-- The allowlist ------------------------------------------------------------
-- Sections a standing grant may ever include. Default-on sections are chosen by
-- the owner UI; malpracticeHistory, peerReferences and caseLogs are opt-in there.
-- Custom categories are listed individually in scope.customCategories.
-- Never here: travelDocs, travelExpenses, taxPayments, invoices, deductibles,
-- locumContracts, workLog, encounters, scheduleDays, dutyDays, rotations,
-- taskNotes, shareLog, notificationLog, alertAcks, followUps, identityVault,
-- answerBank.
-- screeningsSensitive (opt-in) holds the screenings the default section leaves
-- out: drug screen reports and any Flagged or Review result.
create or replace function public.credential_portal_shareable_sections()
returns text[] language sql immutable set search_path=public,pg_temp as $$
 select array['licenses','cme','privileges','insurance','education','workHistory','healthRecords','screenings',
  'screeningsSensitive','professionalPhotos','publications','memberships','malpracticeHistory','peerReferences','caseLogs']::text[]
$$;

-- Licences: professional licences, registrations and certifications only.
-- The type must read as one; then the type AND the name are checked for
-- anything that reads as a driver's licence, passport, identity card or civil
-- record, because "Certification" is a first-class type whose name is free
-- text (production holds a driver's licence filed under licences).
drop function if exists public.credential_portal_license_ok(text);
create or replace function public.credential_portal_license_ok(p_type text, p_name text)
returns boolean language sql immutable set search_path=public,pg_temp as $$
 select coalesce(p_type,'') ~* '(medical licen[cs]e|state medical|osteopathic|\mdea\M|controlled substance|board|ecfmg|usmle|comlex|\mbls\M|\macls\M|\matls\M|\mpals\M|\mnrp\M|fluoroscop|laser|certif)'
  and coalesce(p_type,'')||' '||coalesce(p_name,'') !~* '(driver|passport|state id|photo id|id card|identification|real id|\mtsa\M|precheck|global entry|nexus|\mvisa\M|travel|boarding|social security|\mssn\M|birth|green card|citizenship|naturali[sz]ation|marriage|divorce|name change)'
$$;

-- Screenings: the default section shows background, exclusion and similar
-- reports with a clean or pending result. Drug screen reports and Flagged or
-- Review results appear only under the opt-in screeningsSensitive section.
create or replace function public.credential_portal_screening_ok(p_type text, p_name text, p_result text)
returns boolean language sql immutable set search_path=public,pg_temp as $$
 select coalesce(p_type,'')||' '||coalesce(p_name,'') !~* 'drug'
  and coalesce(p_result,'') !~* '(flag|review)'
$$;

-- Insurance: malpractice / professional liability / tail only, matched by
-- pattern because production types are free text.
create or replace function public.credential_portal_insurance_ok(p_type text)
returns boolean language sql immutable set search_path=public,pg_temp as $$
 select coalesce(p_type,'') ~* '(malpractice|professional liability|medical liability|\mtail\M|\mmpl\M|claims[- ]made)'
  and coalesce(p_type,'') !~* '(health|dental|vision|disability|\mlife\M|personal|\mauto|home|renter|umbrella|workers)'
$$;

-- Health records: occupational-health proof only (Vaccination, TB Test, Fit
-- Test, Titer). Never drug screens; never hepatitis C or HIV results.
create or replace function public.credential_portal_health_ok(p_category text, p_type text, p_name text)
returns boolean language sql immutable set search_path=public,pg_temp as $$
 select coalesce(p_category,'') ~* '(vaccinat|immuniz|\mtb\M|tuberculosis|fit test|titer)'
  and coalesce(p_category,'') !~* 'drug'
  and coalesce(p_type,'')||' '||coalesce(p_name,'') !~* '(hepatitis c|hep c|\mhcv\M|\mhiv\M|drug)'
$$;

-- Drop nulls, empty strings, empty arrays and any value sealed on the device.
create or replace function public.credential_portal_clean(p jsonb)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(coalesce(p,'{}'::jsonb)) e
 where e.value <> 'null'::jsonb
  and not (jsonb_typeof(e.value)='string' and (btrim(e.value #>> '{}')='' or (e.value #>> '{}') like 'enc1:%'))
  and not (jsonb_typeof(e.value)='array' and jsonb_array_length(e.value)=0)
$$;

-- A jsonb array of objects reduced to the named keys, cleaned.
create or replace function public.credential_portal_pick_array(p jsonb, p_keys text[])
returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(c order by ord), '[]'::jsonb) from (
  select public.credential_portal_clean((select coalesce(jsonb_object_agg(k, x.item->k), '{}'::jsonb) from unnest(p_keys) k
    where jsonb_typeof(x.item->k) in ('string','number'))) c, x.ord
  from jsonb_array_elements(case when jsonb_typeof(p)='array' then p else '[]'::jsonb end) with ordinality x(item, ord)
  where jsonb_typeof(x.item)='object') q where c <> '{}'::jsonb
$$;

create or replace function public.credential_portal_string_array(p jsonb)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(v order by ord), '[]'::jsonb) from jsonb_array_elements(case when jsonb_typeof(p)='array' then p else '[]'::jsonb end) with ordinality x(v, ord)
 where jsonb_typeof(v)='string' and btrim(v #>> '{}')<>'' and (v #>> '{}') not like 'enc1:%'
$$;

-- Owner-supplied scope. Refusals are ANSWERS, not exceptions: an exception
-- reaches the owner as "not available" (503) and leaves their form stuck on a
-- retry that can never succeed. A category that exists only on the owner's
-- device (its sync failed) or was archived from another device is the usual
-- case, so the answer names the categories.
--
-- Shape only: known keys, arrays of allowlisted section keys and category
-- UUIDs, and not empty.
create or replace function public.credential_portal_scope_shape_ok(p_scope jsonb)
returns boolean language plpgsql immutable set search_path=public,pg_temp as $$
declare k text;
begin
 if p_scope is null or jsonb_typeof(p_scope)<>'object' then return false; end if;
 for k in select jsonb_object_keys(p_scope) loop
  if k not in ('sections','customCategories') then return false; end if;
 end loop;
 if jsonb_typeof(coalesce(p_scope->'sections','[]'::jsonb))<>'array' or jsonb_typeof(coalesce(p_scope->'customCategories','[]'::jsonb))<>'array' then
  return false;
 end if;
 if exists(select 1 from jsonb_array_elements(coalesce(p_scope->'sections','[]'::jsonb)) e
   where jsonb_typeof(e)<>'string' or not ((e #>> '{}')=any(public.credential_portal_shareable_sections()))) then
  return false;
 end if;
 if exists(select 1 from jsonb_array_elements(coalesce(p_scope->'customCategories','[]'::jsonb)) e
   where jsonb_typeof(e)<>'string' or (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  return false;
 end if;
 return jsonb_array_length(coalesce(p_scope->'sections','[]'::jsonb)) + jsonb_array_length(coalesce(p_scope->'customCategories','[]'::jsonb)) > 0;
end $$;

-- Null when the scope can be granted; otherwise {"state":"invalid_scope"} or
-- {"state":"category_unavailable","categories":[ids not live on the server]}.
create or replace function public.credential_portal_scope_problem(p_owner uuid, p_scope jsonb)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare missing jsonb;
begin
 if not public.credential_portal_scope_shape_ok(p_scope) then return jsonb_build_object('state','invalid_scope'); end if;
 select jsonb_agg(distinct c order by c) into missing from jsonb_array_elements_text(coalesce(p_scope->'customCategories','[]'::jsonb)) c
  where not exists(select 1 from custom_categories x where x.id=c::uuid and x.user_id=p_owner and x.archived_at is null);
 if missing is not null then return jsonb_build_object('state','category_unavailable','categories',missing); end if;
 return null;
end $$;

-- Sorted, de-duplicated {"sections":[...],"customCategories":[...]}. Callers
-- ask credential_portal_scope_problem first; this raises only as a backstop.
create or replace function public.credential_portal_normalize_scope(p_owner uuid, p_scope jsonb)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare problem jsonb:=public.credential_portal_scope_problem(p_owner,p_scope); sections jsonb; categories jsonb;
begin
 if problem is not null then raise exception 'scope refused: %', problem->>'state'; end if;
 select coalesce(jsonb_agg(distinct s order by s), '[]'::jsonb) into sections from jsonb_array_elements_text(coalesce(p_scope->'sections','[]'::jsonb)) s;
 select coalesce(jsonb_agg(distinct c order by c), '[]'::jsonb) into categories from jsonb_array_elements_text(coalesce(p_scope->'customCategories','[]'::jsonb)) c;
 return jsonb_build_object('sections',sections,'customCategories',categories);
end $$;

-- Every record a grant shows, with named columns only. Never select *; never
-- notes, custom_fields, favorite, user_id, costs, logins, or free text that can
-- name other people's clients. Filters run on every call, so a record re-typed
-- or re-filed out of scope disappears from a live session.
create or replace function public.credential_portal_records(p_owner uuid, p_scope jsonb)
returns table(section text, record_id uuid, payload jsonb)
language sql stable security invoker set search_path=public,pg_temp as $$
 select 'licenses'::text, l.id, public.credential_portal_clean(jsonb_build_object('type',l.type,'name',l.name,'licenseNumber',l.license_number,
   'state',l.state,'issuedDate',l.issued_date,'expirationDate',l.expiration_date))
 from licenses l where l.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'licenses' and public.credential_portal_license_ok(l.type, l.name)
 union all
 select 'cme', c.id, public.credential_portal_clean(jsonb_build_object('title',c.title,'category',c.category,'hours',c.hours,'date',c.date,
   'provider',c.provider,'certificateNumber',c.certificate_number,'topics',public.credential_portal_string_array(c.topics)))
 from cme c where c.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'cme'
 union all
 select 'privileges', p.id, public.credential_portal_clean(jsonb_build_object('type',p.type,'name',p.name,'facility',p.facility,'city',p.city,
   'state',p.state,'appointmentDate',p.appointment_date,'expirationDate',p.expiration_date))
 from privileges p where p.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'privileges'
 union all
 select 'insurance', i.id, public.credential_portal_clean(jsonb_build_object('type',i.type,'name',i.name,'provider',i.provider,
   'policyNumber',i.policy_number,'coveragePerClaim',i.coverage_per_claim,'coverageAggregate',i.coverage_aggregate,
   'effectiveDate',i.effective_date,'expirationDate',i.expiration_date))
 from insurance i where i.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'insurance' and public.credential_portal_insurance_ok(i.type)
 union all
 select 'healthRecords', h.id, public.credential_portal_clean(jsonb_build_object('category',h.category,'type',h.type,'name',h.name,
   'dateAdministered',h.date_administered,'expirationDate',h.expiration_date,'result',h.result,'resultValue',h.result_value,
   'resultUnits',h.result_units,'referenceRange',h.reference_range,'collectedDate',h.collected_date,'reportedDate',h.reported_date,
   'lab',h.lab,'lotNumber',h.lot_number,'facility',h.facility,
   'doses',public.credential_portal_pick_array(h.doses, array['doseNumber','date','manufacturer','lotNumber','facility'])))
 from health_records h where h.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'healthRecords'
  and public.credential_portal_health_ok(h.category, h.type, h.name)
 union all
 select 'education', e.id, public.credential_portal_clean(jsonb_build_object('type',e.type,'name',e.name,'institution',e.institution,
   'fieldOfStudy',e.field_of_study,'startDate',e.start_date,'graduationDate',e.graduation_date,'honors',e.honors))
 from education e where e.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'education'
 union all
 select 'workHistory', w.id, public.credential_portal_clean(jsonb_build_object('type',w.type,'position',w.position,'employer',w.employer,
   'city',w.city,'state',w.state,'startDate',w.start_date,'endDate',w.end_date,'current',coalesce(w.is_current,w.current),'description',w.description))
 from work_history w where w.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'workHistory'
 union all
 -- Default: no drug screens, no Flagged or Review result. The opt-in
 -- screeningsSensitive section is exactly the rows this one leaves out; its
 -- files are still linked as "screenings:<id>".
 select case when public.credential_portal_screening_ok(s.type, s.name, s.result) then 'screenings' else 'screeningsSensitive' end, s.id,
   public.credential_portal_clean(jsonb_build_object('type',s.type,'name',s.name,'agency',s.agency,
   'fileNumber',s.file_number,'orderDate',s.order_date,'reportDate',s.report_date,'result',s.result,'expirationDate',s.expiration_date,
   'components',public.credential_portal_pick_array(s.components, array['name','scope','status','date'])))
 from screenings s where s.user_id=p_owner
  and coalesce(p_scope->'sections','[]'::jsonb) ? (case when public.credential_portal_screening_ok(s.type, s.name, s.result) then 'screenings' else 'screeningsSensitive' end)
 union all
 select 'professionalPhotos', f.id, public.credential_portal_clean(jsonb_build_object('name',f.name,'dateTaken',f.date_taken))
 from professional_photos f where f.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'professionalPhotos'
 union all
 select 'publications', b.id, public.credential_portal_clean(jsonb_build_object('name',b.name,'citation',b.citation,'year',b.year,
   'doi',b.doi,'pmid',b.pmid,'url',b.url))
 from publications b where b.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'publications'
 union all
 select 'memberships', m.id, public.credential_portal_clean(jsonb_build_object('name',m.name,'organization',m.organization,'role',m.role,
   'startDate',m.start_date,'endDate',m.end_date,'expirationDate',m.expiration_date))
 from professional_memberships m where m.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'memberships'
 union all
 -- Opt-in. The settlement amount is never shown.
 select 'malpracticeHistory', x.id, public.credential_portal_clean(jsonb_build_object('dateOfIncident',x.date_of_incident,'dateFiled',x.date_filed,
   'state',x.state,'outcome',x.outcome,'description',x.description,'facility',x.facility,'insuranceCarrier',x.insurance_carrier,
   'dateResolved',x.date_resolved))
 from malpractice_history x where x.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'malpracticeHistory'
 union all
 -- Opt-in.
 select 'peerReferences', r.id, public.credential_portal_clean(jsonb_build_object('name',r.name,'degree',r.degree,'specialty',r.specialty,
   'institution',r.institution,'relationship',r.relationship,'email',r.email,'phone',r.phone,'knownSince',r.known_since,'yearsKnown',r.years_known))
 from peer_references r where r.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'peerReferences'
 union all
 -- Opt-in, summary columns only: no title, complication, wRVU, source or notes.
 select 'caseLogs', k.id, public.credential_portal_clean(jsonb_build_object('category',k.category,'date',k.date,'facility',k.facility,
   'role',k.role,'cptCodes',k.cpt_codes,'attending',k.attending))
 from case_logs k where k.user_id=p_owner and coalesce(p_scope->'sections','[]'::jsonb) ? 'caseLogs'
 union all
 -- Each custom category only when the owner listed it on this grant.
 select 'customRecords', cr.id, public.credential_portal_clean(jsonb_build_object('categoryId',cc.id,'categoryName',cc.name,
   'name',cr.name,'issuer',cr.issuer,'number',cr.number,'issuedDate',cr.issued_date,'expirationDate',cr.expiration_date,
   'values',(select coalesce(jsonb_agg(jsonb_build_object('label',left(coalesce(nullif(btrim(f.item->>'label'),''),f.item->>'key'),40),
      'value',left(cr.field_values->>(f.item->>'key'),2000)) order by f.ord), '[]'::jsonb)
     from jsonb_array_elements(case when jsonb_typeof(cc.fields)='array' then cc.fields else '[]'::jsonb end) with ordinality f(item, ord)
     where jsonb_typeof(f.item)='object' and coalesce(f.item->>'removedAt','')=''
      and coalesce(f.item->>'key','') ~ '^[a-zA-Z][a-zA-Z0-9]{0,39}$'
      and jsonb_typeof(cr.field_values)='object' and jsonb_typeof(cr.field_values->(f.item->>'key')) in ('string','number')
      and btrim(cr.field_values->>(f.item->>'key'))<>'' and (cr.field_values->>(f.item->>'key')) not like 'enc1:%')))
 from custom_records cr join custom_categories cc on cc.id=cr.category_id and cc.user_id=cr.user_id
 where cr.user_id=p_owner and cc.archived_at is null and coalesce(p_scope->'customCategories','[]'::jsonb) ? cc.id::text
$$;

-- Files a grant shows: linked as exactly "<section>:<record id>" to a record the
-- grant shows right now, owned by path, never a case-log attachment (op notes
-- can carry patient detail), never an inbox arrival, never unfiled.
create or replace function public.credential_portal_scope_documents(p_owner uuid, p_scope jsonb, p_document uuid default null)
returns table(id uuid, name text, mime_type text, size_bytes integer, section text, record_id uuid, storage_path text)
language sql stable security invoker set search_path=public,pg_temp as $$
 select d.id, d.name, coalesce(d.mime_type,'application/octet-stream'),
  coalesce(d.size_bytes, case when d.size between 0 and 2147483647 then d.size::integer end), r.section, r.record_id, d.storage_path
 from documents d
 join public.credential_portal_records(p_owner, p_scope) r
  on d.linked_to = (case when r.section='screeningsSensitive' then 'screenings' else r.section end)||':'||r.record_id::text
 where d.user_id=p_owner and (p_document is null or d.id=p_document)
  and r.section <> 'caseLogs'
  and coalesce(d.type,'') not in ('request-attachment-inbox','cme-certificate-inbox')
  and public.credential_portal_owned_path(p_owner, d.storage_path, d.id)
$$;

create or replace function public.credential_portal_physician(p_owner uuid)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 select coalesce((select public.credential_portal_clean(jsonb_build_object('name',p.name,'degreeType',p.degree_type,'npi',p.npi,
   'specialties',public.credential_portal_string_array(p.specialties),'primaryState',p.primary_state,
   'additionalStates',public.credential_portal_string_array(p.additional_states),'email',p.verified_email))
  from profiles p where p.id=p_owner), '{}'::jsonb)
$$;

-- The one builder behind the recipient summary AND the owner preview.
create or replace function public.credential_portal_view(p_owner uuid, p_scope jsonb)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object(
  'physician', public.credential_portal_physician(p_owner),
  'records', coalesce((select jsonb_agg(jsonb_build_object('section',r.section,'id',r.record_id,'data',r.payload) order by r.section, r.record_id)
    from public.credential_portal_records(p_owner, p_scope) r), '[]'::jsonb),
  'documents', coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'mimeType',d.mime_type,'sizeBytes',d.size_bytes,
    'section',d.section,'recordId',d.record_id) order by d.name, d.id)
    from public.credential_portal_scope_documents(p_owner, p_scope, null) d), '[]'::jsonb))
$$;

-- Selection kind: the same path rule and closed-account checks -------------
-- A selected file must pass the same healthcare allowlist a standing grant
-- uses: linked to a record in any shareable section that passes its filter
-- right now. Custom categories are not included (a selection has no category
-- choice, and uploader-made categories can hold anything). Checked at
-- creation, at verification and on every file request, so a passport scan or
-- an unfiled upload can never be selected, and a file re-filed out of scope
-- after the invitation stops being served. caseLogs is left out of the scope
-- only because its files are never served anyway (scope_documents), and its
-- records are the largest table to build on every call.
create or replace function public.credential_portal_selection_document_ok(p_owner uuid, p_document uuid)
returns boolean language sql stable security invoker set search_path=public,pg_temp as $$
 select exists(select 1 from public.credential_portal_scope_documents(p_owner,
  jsonb_build_object('sections',to_jsonb(array_remove(public.credential_portal_shareable_sections(),'caseLogs')),'customCategories','[]'::jsonb), p_document))
$$;

create or replace function public.credential_portal_creation_capacity(p_owner uuid,p_subject text)
returns boolean language sql security invoker set search_path=public,pg_temp as $$
 select public.credential_portal_owner_ready(p_owner,p_subject)
 and coalesce((select used<20 from credential_portal_limits where scope='owner_invites' and key=p_owner::text and window_start=date_trunc('day',clock_timestamp())),true)
$$;

create or replace function public.credential_portal_create(
 p_id uuid,p_owner uuid,p_subject text,p_email text,p_request uuid,p_fingerprint text,p_token_digest text,p_documents jsonb,p_mail_id uuid,p_encrypted_payload text
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare existing credential_portal_invites%rowtype; d jsonb; expiry timestamptz:=clock_timestamp()+interval '7 days'; total bigint:=0;
begin
 perform 1 from profiles where id=p_owner and auth_user_id=p_subject and access_status='active' and deleted_at is null for update;
 if not found or public.account_is_closed(p_owner) then return jsonb_build_object('state','unavailable'); end if;
 select * into existing from credential_portal_invites where owner_profile_id=p_owner and request_id=p_request;
 if found then
  if existing.request_fingerprint<>p_fingerprint then return jsonb_build_object('state','conflict'); end if;
  return jsonb_build_object('state','existing','id',existing.id);
 end if;
 if jsonb_typeof(p_documents)<>'array' or jsonb_array_length(p_documents) not between 1 and 10 then raise exception 'invalid selection'; end if;
 -- Before the daily quota, so a refused selection costs nothing.
 if exists(select 1 from jsonb_array_elements(p_documents) sel(item)
   where case when jsonb_typeof(sel.item)='object' and coalesce(sel.item->>'id','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then not public.credential_portal_selection_document_ok(p_owner,(sel.item->>'id')::uuid) else true end) then
  return jsonb_build_object('state','not_shareable');
 end if;
 if not credential_portal_limit('owner_invites',p_owner::text,date_trunc('day',clock_timestamp()),20) then return jsonb_build_object('state','limited'); end if;
 insert into credential_portal_invites(id,owner_profile_id,owner_subject,recipient_email,request_id,request_fingerprint,token_digest,expires_at)
 values(p_id,p_owner,p_subject,p_email,p_request,p_fingerprint,p_token_digest,expiry);
 for d in select * from jsonb_array_elements(p_documents) loop
  perform 1 from documents where id=(d->>'id')::uuid and user_id=p_owner and storage_path=d->>'storagePath'
   and public.credential_portal_owned_path(p_owner, storage_path, id)
   and name=d->>'name' and coalesce(mime_type,'application/octet-stream')=d->>'mimeType';
  if not found then raise exception 'document changed'; end if;
  total:=total+(d->>'sizeBytes')::integer;
  if total>31457280 then raise exception 'selection too large'; end if;
  insert into credential_portal_documents(invite_id,document_id,storage_path,content_digest,name,mime_type,size_bytes)
  values(p_id,(d->>'id')::uuid,d->>'storagePath',d->>'digest',d->>'name',d->>'mimeType',(d->>'sizeBytes')::integer);
 end loop;
 insert into credential_portal_outbox(id,invite_id,kind,encrypted_payload,expires_at) values(p_mail_id,p_id,'invite',p_encrypted_payload,least(expiry,clock_timestamp()+interval '1 hour'));
 insert into credential_portal_audit(invite_id,event) values(p_id,'invitation_created');
 return jsonb_build_object('state','created','id',p_id);
end $$;

-- Standing grants ----------------------------------------------------------
create or replace function public.credential_portal_create_standing(
 p_id uuid,p_owner uuid,p_subject text,p_email text,p_request uuid,p_fingerprint text,p_token_digest text,
 p_purpose text,p_days integer,p_allow_download boolean,p_scope jsonb,p_mail_id uuid,p_encrypted_payload text
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare existing credential_portal_invites%rowtype; started timestamptz:=clock_timestamp(); normalized jsonb; expiry timestamptz; problem jsonb;
begin
 perform 1 from profiles where id=p_owner and auth_user_id=p_subject and access_status='active' and deleted_at is null for update;
 if not found or public.account_is_closed(p_owner) then return jsonb_build_object('state','unavailable'); end if;
 select * into existing from credential_portal_invites where owner_profile_id=p_owner and request_id=p_request;
 if found then
  if existing.request_fingerprint<>p_fingerprint then return jsonb_build_object('state','conflict'); end if;
  return jsonb_build_object('state','existing','id',existing.id);
 end if;
 if p_days is null or p_days not in (14,30,90,180) then raise exception 'invalid duration'; end if;
 if p_purpose is null or char_length(btrim(p_purpose)) not between 1 and 120 then raise exception 'invalid purpose'; end if;
 if p_allow_download is null then raise exception 'invalid download setting'; end if;
 problem:=public.credential_portal_scope_problem(p_owner,p_scope);
 if problem is not null then return problem; end if;
 normalized:=public.credential_portal_normalize_scope(p_owner,p_scope);
 if not credential_portal_limit('owner_invites',p_owner::text,date_trunc('day',started),20) then return jsonb_build_object('state','limited'); end if;
 expiry:=started+make_interval(days=>p_days);
 insert into credential_portal_invites(id,owner_profile_id,owner_subject,recipient_email,request_id,request_fingerprint,token_digest,expires_at,
  kind,purpose,allow_download,scope,extended_at)
 values(p_id,p_owner,p_subject,p_email,p_request,p_fingerprint,p_token_digest,expiry,'standing',btrim(p_purpose),p_allow_download,normalized,started);
 insert into credential_portal_outbox(id,invite_id,kind,encrypted_payload,expires_at) values(p_mail_id,p_id,'invite',p_encrypted_payload,least(expiry,clock_timestamp()+interval '1 hour'));
 insert into credential_portal_audit(invite_id,event) values(p_id,'invitation_created');
 return jsonb_build_object('state','created','id',p_id);
end $$;

-- Narrow a live grant: fewer sections or categories, downloads off, or a new
-- end date of 14/30/90/180 days from now (extend or shorten, never past the
-- 180-day cap). Adding anything back needs a new grant.
--
-- Narrowing only ever removes, so the proposed scope is checked for shape and
-- for being a subset of the grant's own scope, never for its categories still
-- being live: a grant whose shared category was later archived must still be
-- narrowable, and must still be able to have downloads turned off.
create or replace function public.credential_portal_update(p_owner uuid,p_subject text,p_invite uuid,p_days integer,p_allow_download boolean,p_scope jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype; next_scope jsonb; started timestamptz:=clock_timestamp();
begin
 if not public.credential_portal_owner_ready(p_owner,p_subject) then return jsonb_build_object('state','unavailable'); end if;
 select * into i from credential_portal_invites where id=p_invite and owner_profile_id=p_owner and owner_subject=p_subject for update;
 if not found or i.kind<>'standing' then return jsonb_build_object('state','unavailable'); end if;
 if i.revoked_at is not null or i.expires_at<=started then return jsonb_build_object('state','ended'); end if;
 if p_days is null and p_allow_download is null and p_scope is null then raise exception 'nothing to change'; end if;
 if p_days is not null and p_days not in (14,30,90,180) then raise exception 'invalid duration'; end if;
 if p_allow_download is true and not i.allow_download then return jsonb_build_object('state','widening'); end if;
 if p_scope is not null then
  if not public.credential_portal_scope_shape_ok(p_scope) then return jsonb_build_object('state','invalid_scope'); end if;
  if exists(select 1 from jsonb_array_elements_text(coalesce(p_scope->'sections','[]'::jsonb)) s where not (coalesce(i.scope->'sections','[]'::jsonb) ? s))
   or exists(select 1 from jsonb_array_elements_text(coalesce(p_scope->'customCategories','[]'::jsonb)) c where not (coalesce(i.scope->'customCategories','[]'::jsonb) ? c)) then
   return jsonb_build_object('state','widening');
  end if;
  select jsonb_build_object(
   'sections',(select coalesce(jsonb_agg(distinct x order by x),'[]'::jsonb) from jsonb_array_elements_text(coalesce(p_scope->'sections','[]'::jsonb)) x),
   'customCategories',(select coalesce(jsonb_agg(distinct x order by x),'[]'::jsonb) from jsonb_array_elements_text(coalesce(p_scope->'customCategories','[]'::jsonb)) x))
   into next_scope;
 end if;
 update credential_portal_invites set
  allow_download=coalesce(p_allow_download,allow_download),
  scope=coalesce(next_scope,scope),
  expires_at=case when p_days is null then expires_at else started+make_interval(days=>p_days) end,
  extended_at=case when p_days is null then extended_at else started end
 where id=i.id;
 insert into credential_portal_audit(invite_id,event) values(i.id,'grant_updated');
 return jsonb_build_object('state','updated','id',i.id);
end $$;

-- A new link for the same grant. The old link, its code and any open visit end.
create or replace function public.credential_portal_resend_link(p_owner uuid,p_subject text,p_invite uuid,p_token_digest text,p_mail_id uuid,p_encrypted_payload text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype;
begin
 if not public.credential_portal_owner_ready(p_owner,p_subject) then return jsonb_build_object('state','unavailable'); end if;
 select * into i from credential_portal_invites where id=p_invite and owner_profile_id=p_owner and owner_subject=p_subject for update;
 if not found or i.kind<>'standing' then return jsonb_build_object('state','unavailable'); end if;
 if i.revoked_at is not null or i.expires_at<=clock_timestamp() then return jsonb_build_object('state','ended'); end if;
 if not credential_portal_limit('owner_links',p_owner::text,date_trunc('day',clock_timestamp()),20) then return jsonb_build_object('state','limited'); end if;
 update credential_portal_invites set token_digest=p_token_digest,otp_version=null,otp_digest=null,otp_expires_at=null,
  otp_attempts=0,otp_failures_total=0,otp_last_sent_at=null where id=i.id;
 delete from credential_portal_sessions where invite_id=i.id;
 update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' when state='failed' then 'failed' else 'suppressed' end,encrypted_payload=null
  where invite_id=i.id and state<>'sent';
 delete from credential_portal_outbox where invite_id=i.id and kind='invite';
 insert into credential_portal_outbox(id,invite_id,kind,encrypted_payload,expires_at)
 values(p_mail_id,i.id,'invite',p_encrypted_payload,least(i.expires_at,clock_timestamp()+interval '1 hour'));
 insert into credential_portal_audit(invite_id,event) values(i.id,'link_resent');
 return jsonb_build_object('state','created','id',i.id,'mailId',p_mail_id);
end $$;

-- Codes and visits ---------------------------------------------------------
-- Selection: 5 sends and 5 wrong codes for the invitation's whole life (as before).
-- Standing: 5 wrong codes per code, 15 wrong codes in total (then the owner
-- sends a new link), 10 code emails per grant per day, 60 s apart.
create or replace function public.credential_portal_claim_otp(
 p_token_digest text,p_email text,p_version uuid,p_digest text,p_mail_id uuid,p_encrypted_payload text,p_recipient_limit_key text
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype; mail credential_portal_outbox%rowtype;
begin
 select * into i from credential_portal_invites where token_digest=p_token_digest and recipient_email=p_email for update;
 if not found or i.revoked_at is not null or i.expires_at<=clock_timestamp() then return jsonb_build_object('state','unavailable'); end if;
 if i.kind='selection' and (i.redeemed_at is not null or i.otp_attempts>=5) then return jsonb_build_object('state','unavailable'); end if;
 if i.kind='standing' and i.otp_failures_total>=15 then return jsonb_build_object('state','unavailable'); end if;
 if not public.credential_portal_owner_ready(i.owner_profile_id,i.owner_subject) then return jsonb_build_object('state','unavailable'); end if;
 select * into mail from credential_portal_outbox where invite_id=i.id and kind='otp' and otp_version=i.otp_version;
 if found and mail.state in ('pending','sending','unknown') and mail.expires_at>clock_timestamp() then return jsonb_build_object('state','retry','mailId',mail.id); end if;
 if (i.kind='selection' and i.otp_sends>=5) or i.otp_last_sent_at>clock_timestamp()-interval '60 seconds' then return jsonb_build_object('state','limited'); end if;
 if i.kind='standing' and not credential_portal_limit('grant_otp_day',i.id::text,date_trunc('day',clock_timestamp()),10) then return jsonb_build_object('state','limited'); end if;
 if not credential_portal_limit('recipient_otp',p_recipient_limit_key,date_trunc('hour',clock_timestamp()),5) then return jsonb_build_object('state','limited'); end if;
 if not credential_portal_limit('owner_otp',i.owner_profile_id::text,date_trunc('hour',clock_timestamp()),50) then return jsonb_build_object('state','limited'); end if;
 update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' when state='failed' then 'failed' else 'suppressed' end,encrypted_payload=null where invite_id=i.id and kind='otp' and state<>'sent';
 update credential_portal_invites set otp_version=p_version,otp_digest=p_digest,otp_expires_at=least(expires_at,clock_timestamp()+interval '10 minutes'),
  otp_sends=otp_sends+1,otp_last_sent_at=clock_timestamp(),otp_attempts=case when kind='standing' then 0 else otp_attempts end where id=i.id;
 insert into credential_portal_outbox(id,invite_id,kind,otp_version,encrypted_payload,expires_at)
 values(p_mail_id,i.id,'otp',p_version,p_encrypted_payload,least(i.expires_at,clock_timestamp()+interval '10 minutes'));
 return jsonb_build_object('state','created','mailId',p_mail_id);
end $$;

create or replace function public.credential_portal_claim_mail(p_id uuid,p_lease uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare m credential_portal_outbox%rowtype; i credential_portal_invites%rowtype;
begin
 -- Lock invitation before outbox everywhere to prevent revocation/send deadlocks.
 select v.* into i from credential_portal_invites v join credential_portal_outbox b on b.invite_id=v.id where b.id=p_id for update of v;
 if not found then return null; end if;
 select * into m from credential_portal_outbox where id=p_id for update;
 if not found or m.state in ('sent','failed','suppressed') then return null; end if;
 if not public.credential_portal_owner_ready(i.owner_profile_id,i.owner_subject) then
  update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' else 'suppressed' end,encrypted_payload=null where id=p_id; return null;
 end if;
 if i.revoked_at is not null or i.expires_at<=clock_timestamp() or m.expires_at<=clock_timestamp()
   or (i.kind='selection' and i.redeemed_at is not null)
   or (i.kind='standing' and i.otp_failures_total>=15)
   or (m.kind='otp' and (i.otp_version is distinct from m.otp_version or i.otp_attempts>=5)) then
  update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' else 'suppressed' end,encrypted_payload=null where id=p_id; return null;
 end if;
 if m.state='sending' and m.lease_until>clock_timestamp() then return null; end if;
 if m.attempts>=5 then
  -- An expired submitting worker is uncertain, never evidence of definitive failure.
  if m.state='sending' then update credential_portal_outbox set state='unknown',lease_token=null,lease_until=null where id=p_id; end if;
  return null;
 end if;
 if m.next_attempt_at>clock_timestamp() then return null; end if;
 update credential_portal_outbox set state='sending',lease_token=p_lease,lease_until=clock_timestamp()+interval '45 seconds',attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '60 seconds' where id=p_id;
 return jsonb_build_object('id',m.id,'encryptedPayload',m.encrypted_payload,'kind',m.kind);
end $$;

create or replace function public.credential_portal_redeem(p_token_digest text,p_email text,p_version uuid,p_otp_digest text,p_session_digest text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype; expiry timestamptz;
begin
 select * into i from credential_portal_invites where token_digest=p_token_digest and recipient_email=p_email for update;
 if not found or i.revoked_at is not null or i.expires_at<=clock_timestamp() or i.otp_attempts>=5
  or i.otp_expires_at is null or i.otp_expires_at<=clock_timestamp() then return null; end if;
 if i.kind='selection' and i.redeemed_at is not null then return null; end if;
 if i.kind='standing' and i.otp_failures_total>=15 then return null; end if;
 if not public.credential_portal_owner_ready(i.owner_profile_id,i.owner_subject) then return null; end if;
 update credential_portal_invites set otp_attempts=otp_attempts+1 where id=i.id;
 if i.otp_version is distinct from p_version or i.otp_digest is distinct from p_otp_digest then
  if i.kind='standing' then update credential_portal_invites set otp_failures_total=otp_failures_total+1 where id=i.id; end if;
  return null;
 end if;
 if i.kind='standing' then
  -- Each visit: a fresh code, one live session of at most 60 minutes. The link
  -- stays usable until the end date; a new visit replaces the previous one.
  expiry:=least(i.expires_at,clock_timestamp()+interval '60 minutes');
  delete from credential_portal_sessions where invite_id=i.id;
  insert into credential_portal_sessions(token_digest,invite_id,expires_at) values(p_session_digest,i.id,expiry);
  update credential_portal_invites set last_verified_at=clock_timestamp(),otp_digest=null,otp_expires_at=null where id=i.id;
  update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' when state='failed' then 'failed' else 'suppressed' end,encrypted_payload=null
   where invite_id=i.id and kind='otp' and state<>'sent';
  insert into credential_portal_audit(invite_id,event) values(i.id,'session_verified');
  return jsonb_build_object('inviteId',i.id,'expiresAt',expiry,'kind','standing','documents','[]'::jsonb);
 end if;
 expiry:=least(i.expires_at,clock_timestamp()+interval '30 minutes');
 insert into credential_portal_sessions(token_digest,invite_id,expires_at) values(p_session_digest,i.id,expiry);
 update credential_portal_invites set redeemed_at=clock_timestamp(),otp_digest=null where id=i.id;
 update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' when state='failed' then 'failed' else 'suppressed' end,encrypted_payload=null where invite_id=i.id and state<>'sent';
 insert into credential_portal_audit(invite_id,event) values(i.id,'session_verified');
 return jsonb_build_object('inviteId',i.id,'expiresAt',expiry,'kind','selection','documents',coalesce((
  select jsonb_agg(jsonb_build_object('id',x.document_id,'name',x.name,'mimeType',x.mime_type,'sizeBytes',x.size_bytes))
  from credential_portal_documents x join documents o on o.id=x.document_id where x.invite_id=i.id and o.user_id=i.owner_profile_id
   and o.storage_path=x.storage_path and public.credential_portal_owned_path(i.owner_profile_id,x.storage_path,x.document_id)
   and o.name=x.name and coalesce(o.mime_type,'application/octet-stream')=x.mime_type
   and public.credential_portal_selection_document_ok(i.owner_profile_id,x.document_id)
 ),'[]'::jsonb));
end $$;

create or replace function public.credential_portal_access(p_session_digest text,p_document_id uuid default null,p_count boolean default true)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype; s credential_portal_sessions%rowtype; d credential_portal_documents%rowtype; sd record; base jsonb;
begin
 select v.* into i from credential_portal_invites v join credential_portal_sessions t on t.invite_id=v.id where t.token_digest=p_session_digest for update of v;
 if not found or i.revoked_at is not null or i.expires_at<=clock_timestamp() then return null; end if;
 select * into s from credential_portal_sessions where token_digest=p_session_digest for update;
 if s.expires_at<=clock_timestamp() or (p_count and s.request_count>=(case when i.kind='standing' then 300 else 100 end)) then return null; end if;
 if i.kind='standing' and i.otp_failures_total>=15 then return null; end if;
 if not public.credential_portal_owner_ready(i.owner_profile_id,i.owner_subject) then return null; end if;
 if p_count then update credential_portal_sessions set request_count=request_count+1 where token_digest=p_session_digest; end if;
 base:=jsonb_build_object('inviteId',i.id,'ownerId',i.owner_profile_id,'ownerSubject',i.owner_subject,'expiresAt',s.expires_at,
  'kind',i.kind,'allowDownload',i.allow_download,'accessEndsAt',i.expires_at,'storageSubjects',to_jsonb(public.clerk_storage_subjects(i.owner_profile_id)));
 if p_document_id is null then return base; end if;
 if i.kind='standing' then
  -- Live: the file must be in scope NOW, not when the grant was made.
  select * into sd from public.credential_portal_scope_documents(i.owner_profile_id,i.scope,p_document_id) limit 1;
  if not found then return null; end if;
  return base||jsonb_build_object('document',jsonb_build_object('document_id',sd.id,'storage_path',sd.storage_path,'name',sd.name,
   'mime_type',sd.mime_type,'size_bytes',sd.size_bytes));
 end if;
 select x.* into d from credential_portal_documents x join documents o on o.id=x.document_id
  where x.invite_id=i.id and x.document_id=p_document_id and o.user_id=i.owner_profile_id
  and o.storage_path=x.storage_path and public.credential_portal_owned_path(i.owner_profile_id,x.storage_path,x.document_id)
  and o.name=x.name and coalesce(o.mime_type,'application/octet-stream')=x.mime_type
  and public.credential_portal_selection_document_ok(i.owner_profile_id,x.document_id);
 if not found then return null; end if;
 return base||jsonb_build_object('document',to_jsonb(d));
end $$;

-- The 5-argument form is replaced by one that also stores the digest of the
-- bytes actually served. Dropped first so PostgREST never sees two overloads.
drop function if exists public.credential_portal_record(text,uuid,text,text,integer);
create or replace function public.credential_portal_record(p_session_digest text,p_document_id uuid,p_event text,p_intent text,p_bytes integer,p_digest text default null)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare access jsonb;
begin
 if p_event not in ('documents_listed','document_response_prepared','document_unavailable','download_refused') then raise exception 'invalid event'; end if;
 if p_event='documents_listed' and (p_document_id is not null or p_intent is not null or p_bytes is not null or p_digest is not null) then raise exception 'invalid list event'; end if;
 if p_event<>'documents_listed' and (p_document_id is null or p_intent not in ('view','download')) then raise exception 'invalid file event'; end if;
 if p_digest is not null and p_digest !~ '^[a-f0-9]{64}$' then raise exception 'invalid digest'; end if;
 access:=public.credential_portal_access(p_session_digest,p_document_id,false);
 if access is null then return false; end if;
 if p_event='document_response_prepared' then
  if access->>'kind'='standing' then
   if p_bytes is null or p_bytes<0 or p_digest is null then raise exception 'invalid response digest'; end if;
  elsif p_bytes is null or p_bytes<>(access->'document'->>'size_bytes')::integer then raise exception 'invalid response size'; end if;
 end if;
 insert into credential_portal_audit(invite_id,document_id,event,intent,bytes_prepared,content_digest)
 values((access->>'inviteId')::uuid,p_document_id,p_event,p_intent,p_bytes,p_digest);
 return true;
end $$;

-- Recipient summary (and the standing document list) in one transaction:
-- access check, live view, audit row.
create or replace function public.credential_portal_session_view(p_session_digest text,p_event text default 'summary_listed')
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare access jsonb; i credential_portal_invites%rowtype;
begin
 if p_event not in ('summary_listed','documents_listed') then raise exception 'invalid event'; end if;
 access:=public.credential_portal_access(p_session_digest,null,false);
 if access is null or access->>'kind'<>'standing' then return null; end if;
 -- Counted against the visit's request budget only once it is known to be standing.
 access:=public.credential_portal_access(p_session_digest,null,true);
 if access is null then return null; end if;
 select * into i from credential_portal_invites where id=(access->>'inviteId')::uuid;
 insert into credential_portal_audit(invite_id,event) values(i.id,p_event);
 return jsonb_build_object('ownerId',i.owner_profile_id,'expiresAt',access->'expiresAt',
  'grant',jsonb_build_object('purpose',i.purpose,'accessEndsAt',i.expires_at,'allowDownload',i.allow_download),
  'view',public.credential_portal_view(i.owner_profile_id,i.scope));
end $$;

-- Owner preview: a proposed scope, or an existing grant exactly as its
-- administrator would see it right now.
create or replace function public.credential_portal_preview(p_owner uuid,p_subject text,p_scope jsonb,p_invite uuid default null)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype; problem jsonb;
begin
 if not public.credential_portal_owner_ready(p_owner,p_subject) then return null; end if;
 if p_invite is not null then
  select * into i from credential_portal_invites where id=p_invite and owner_profile_id=p_owner and owner_subject=p_subject and kind='standing';
  if not found then return null; end if;
  return jsonb_build_object('grant',jsonb_build_object('purpose',i.purpose,'accessEndsAt',i.expires_at,'allowDownload',i.allow_download),
   'view',public.credential_portal_view(p_owner,i.scope));
 end if;
 problem:=public.credential_portal_scope_problem(p_owner,p_scope);
 if problem is not null then return problem; end if;
 return jsonb_build_object('view',public.credential_portal_view(p_owner,public.credential_portal_normalize_scope(p_owner,p_scope)));
end $$;

-- Owner list: status, end date, last visit and per-document activity with the
-- owner's own document names (joined at read time, never copied into audit).
-- documentActivity and visitCount are computed over EVERY audit row of the
-- grant: every summary load writes a row, so a window of recent rows would
-- let ordinary use (or a recipient on purpose) push file activity out of the
-- physician's view. "audit" is only the recent-events list.
create or replace function public.credential_portal_owner_grants(p_owner uuid,p_subject text,p_invite uuid default null)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(g.item order by g.created_at desc, g.id), '[]'::jsonb) from (
  select i.created_at, i.id, jsonb_build_object(
   'id',i.id,'kind',i.kind,'recipientEmail',i.recipient_email,'purpose',i.purpose,'createdAt',i.created_at,'expiresAt',i.expires_at,
   'status',case when i.revoked_at is not null then 'revoked' when i.expires_at<=clock_timestamp() then 'expired'
     when i.kind='standing' and i.otp_failures_total>=15 then 'locked'
     when i.kind='selection' and i.redeemed_at is not null then 'redeemed'
     when i.kind='standing' then 'active' else 'pending' end,
   'allowDownload',i.allow_download,'scope',i.scope,'lastVisitAt',i.last_verified_at,
   'deliveryState',coalesce((select o.state from credential_portal_outbox o where o.invite_id=i.id and o.kind='invite'),'unavailable'),
   'documentCount',(select count(*) from credential_portal_documents x where x.invite_id=i.id),
   'visitCount',(select count(*) from credential_portal_audit x where x.invite_id=i.id and x.event='session_verified'),
   'documentActivity',coalesce((select jsonb_agg(jsonb_build_object('documentId',s.document_id,'documentName',doc.name,
      'views',s.views,'downloads',s.downloads,'refused',s.refused,'last',s.last) order by s.last desc, s.document_id)
     from (select x.document_id,
       count(*) filter (where x.event='document_response_prepared' and x.intent is distinct from 'download') views,
       count(*) filter (where x.event='document_response_prepared' and x.intent='download') downloads,
       count(*) filter (where x.event='download_refused') refused, max(x.created_at) last
      from credential_portal_audit x where x.invite_id=i.id and x.document_id is not null
       and x.event in ('document_response_prepared','download_refused') group by x.document_id) s
     left join documents doc on doc.id=s.document_id and doc.user_id=i.owner_profile_id), '[]'::jsonb),
   'audit',coalesce((select jsonb_agg(jsonb_build_object('event',a.event,'intent',a.intent,'documentId',a.document_id,
      'documentName',doc.name,'createdAt',a.created_at) order by a.created_at desc, a.id desc)
     from (select * from credential_portal_audit x where x.invite_id=i.id order by x.created_at desc, x.id desc limit 200) a
     left join documents doc on doc.id=a.document_id and doc.user_id=i.owner_profile_id), '[]'::jsonb)
  ) item
  from credential_portal_invites i
  where i.owner_profile_id=p_owner and i.owner_subject=p_subject and (p_invite is null or i.id=p_invite)
  order by i.created_at desc limit 100
 ) g
$$;

-- Maintenance --------------------------------------------------------------
create or replace function public.credential_portal_prune()
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype;
begin
 -- Same invitation-first lock order as redeem/revoke/mail. Bound the batch and skip busy invitations.
 for i in select v.* from credential_portal_invites v where v.expires_at<clock_timestamp()-interval '90 days'
   or public.account_is_closed(v.owner_profile_id)
   or (v.otp_digest is not null and v.otp_expires_at<=clock_timestamp())
   or exists(select 1 from credential_portal_outbox o where o.invite_id=v.id and o.expires_at<=clock_timestamp() and o.encrypted_payload is not null)
   or exists(select 1 from credential_portal_sessions s where s.invite_id=v.id and s.expires_at<=clock_timestamp()-interval '1 day')
   order by v.id for update of v skip locked limit 100 loop
  if i.expires_at<clock_timestamp()-interval '90 days' or public.account_is_closed(i.owner_profile_id) then
   -- Closed accounts lose every grant, its recipients and its audit at once.
   delete from credential_portal_invites where id=i.id;
   continue;
  end if;
  update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' else 'suppressed' end,encrypted_payload=null
   where invite_id=i.id and expires_at<=clock_timestamp() and encrypted_payload is not null;
  update credential_portal_invites set otp_digest=null where id=i.id and otp_expires_at<=clock_timestamp() and otp_digest is not null;
  delete from credential_portal_sessions where invite_id=i.id and expires_at<=clock_timestamp()-interval '1 day';
 end loop;
 delete from credential_portal_limits where window_start<clock_timestamp()-interval '2 days';
end $$;

-- Grants: service role only, like every portal function --------------------
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'credential_portal_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;

-- Scheduled the way the other prunes are. Wrapped so applying this file on a
-- database without pg_cron is not an error.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('credential-portal-prune')
      where exists (select 1 from cron.job where jobname = 'credential-portal-prune');
    perform cron.schedule('credential-portal-prune', '*/5 * * * *', 'select public.credential_portal_prune()');
  else
    raise notice 'pg_cron not installed; credential_portal_prune() exists but is not scheduled';
  end if;
end $$;

commit;
notify pgrst, 'reload schema';
