-- Readiness only. No client table/RPC grants; the disabled Edge handler is the only entry point.
-- Token tables contain digests. Delivery payloads are short-lived AES-GCM ciphertext.
begin;
create table if not exists public.credential_portal_invites (
 id uuid primary key,
 owner_profile_id uuid not null references public.profiles(id) on delete cascade,
 owner_subject text not null,
 recipient_email text not null,
 request_id uuid not null,
 request_fingerprint text not null,
 token_digest text not null unique check(token_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '7 days',
 revoked_at timestamptz, redeemed_at timestamptz,
 otp_version uuid, otp_digest text, otp_expires_at timestamptz,
 otp_attempts integer not null default 0,
 otp_sends integer not null default 0,
 otp_last_sent_at timestamptz,
 unique(owner_profile_id,request_id)
);
create table if not exists public.credential_portal_documents (
 invite_id uuid not null references public.credential_portal_invites(id) on delete cascade,
 document_id uuid not null references public.documents(id) on delete cascade,
 storage_path text not null,
 content_digest text not null check(content_digest ~ '^[a-f0-9]{64}$'),
 name text not null, mime_type text not null, size_bytes integer not null check(size_bytes between 0 and 10485760),
 primary key(invite_id,document_id)
);
create table if not exists public.credential_portal_sessions (
 token_digest text primary key check(token_digest ~ '^[a-f0-9]{64}$'),
 invite_id uuid not null unique references public.credential_portal_invites(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 request_count integer not null default 0
);
create table if not exists public.credential_portal_outbox (
 id uuid primary key,
 invite_id uuid not null references public.credential_portal_invites(id) on delete cascade,
 kind text not null check(kind in ('invite','otp')),
 otp_version uuid,
 encrypted_payload text,
 state text not null default 'pending' check(state in ('pending','sending','sent','unknown','failed','suppressed')),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 lease_token uuid, lease_until timestamptz,
 attempts integer not null default 0, next_attempt_at timestamptz,
 provider_id text,
 unique(invite_id,kind,otp_version)
);
create unique index if not exists credential_portal_invite_mail_unique on public.credential_portal_outbox(invite_id) where kind='invite';
create table if not exists public.credential_portal_audit (
 id bigint generated always as identity primary key,
 invite_id uuid not null references public.credential_portal_invites(id) on delete cascade,
 document_id uuid,
 event text not null check(event in ('invitation_created','invitation_revoked','session_verified','documents_listed','document_response_prepared','document_unavailable')),
 intent text check(intent in ('view','download')),
 bytes_prepared integer,
 created_at timestamptz not null default clock_timestamp()
);
create table if not exists public.credential_portal_limits (
 scope text not null, key text not null, window_start timestamptz not null, used integer not null,
 primary key(scope,key,window_start)
);
do $$ declare t text; begin
 foreach t in array array['credential_portal_invites','credential_portal_documents','credential_portal_sessions','credential_portal_outbox','credential_portal_audit','credential_portal_limits'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;

-- Cheap rejection before hashing owned files; create() remains authoritative under concurrency.
create or replace function public.credential_portal_creation_capacity(p_owner uuid,p_subject text)
returns boolean language sql security invoker set search_path=public,pg_temp as $$
 select exists(select 1 from profiles where id=p_owner and auth_user_id=p_subject and access_status='active')
 and coalesce((select used<20 from credential_portal_limits where scope='owner_invites' and key=p_owner::text and window_start=date_trunc('day',clock_timestamp())),true)
$$;
grant usage,select on sequence public.credential_portal_audit_id_seq to service_role;

create or replace function public.credential_portal_limit(p_scope text,p_key text,p_window timestamptz,p_max integer)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_max<1 then return false; end if;
 insert into credential_portal_limits(scope,key,window_start,used) values(p_scope,p_key,p_window,1)
 on conflict(scope,key,window_start) do update set used=credential_portal_limits.used+1 where credential_portal_limits.used<p_max;
 return found;
end $$;

create or replace function public.credential_portal_create(
 p_id uuid,p_owner uuid,p_subject text,p_email text,p_request uuid,p_fingerprint text,p_token_digest text,p_documents jsonb,p_mail_id uuid,p_encrypted_payload text
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare existing credential_portal_invites%rowtype; d jsonb; expiry timestamptz:=clock_timestamp()+interval '7 days'; total bigint:=0;
begin
 perform 1 from profiles where id=p_owner and auth_user_id=p_subject and access_status='active' for update;
 if not found then raise exception 'owner unavailable'; end if;
 select * into existing from credential_portal_invites where owner_profile_id=p_owner and request_id=p_request;
 if found then
  if existing.request_fingerprint<>p_fingerprint then return jsonb_build_object('state','conflict'); end if;
  return jsonb_build_object('state','existing','id',existing.id);
 end if;
 if jsonb_typeof(p_documents)<>'array' or jsonb_array_length(p_documents) not between 1 and 10 then raise exception 'invalid selection'; end if;
 if not credential_portal_limit('owner_invites',p_owner::text,date_trunc('day',clock_timestamp()),20) then return jsonb_build_object('state','limited'); end if;
 insert into credential_portal_invites(id,owner_profile_id,owner_subject,recipient_email,request_id,request_fingerprint,token_digest,expires_at)
 values(p_id,p_owner,p_subject,p_email,p_request,p_fingerprint,p_token_digest,expiry);
 for d in select * from jsonb_array_elements(p_documents) loop
  perform 1 from documents where id=(d->>'id')::uuid and user_id=p_owner and storage_path=p_subject||'/'||(d->>'id')
   and name=d->>'name' and coalesce(mime_type,'application/octet-stream')=d->>'mimeType';
  if not found or d->>'storagePath'<>p_subject||'/'||(d->>'id') then raise exception 'document changed'; end if;
  total:=total+(d->>'sizeBytes')::integer;
  if total>31457280 then raise exception 'selection too large'; end if;
  insert into credential_portal_documents(invite_id,document_id,storage_path,content_digest,name,mime_type,size_bytes)
  values(p_id,(d->>'id')::uuid,d->>'storagePath',d->>'digest',d->>'name',d->>'mimeType',(d->>'sizeBytes')::integer);
 end loop;
 insert into credential_portal_outbox(id,invite_id,kind,encrypted_payload,expires_at) values(p_mail_id,p_id,'invite',p_encrypted_payload,least(expiry,clock_timestamp()+interval '23 hours'));
 insert into credential_portal_audit(invite_id,event) values(p_id,'invitation_created');
 return jsonb_build_object('state','created','id',p_id);
end $$;

create or replace function public.credential_portal_claim_otp(
 p_token_digest text,p_email text,p_version uuid,p_digest text,p_mail_id uuid,p_encrypted_payload text,p_recipient_limit_key text
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype; mail credential_portal_outbox%rowtype;
begin
 select * into i from credential_portal_invites where token_digest=p_token_digest and recipient_email=p_email for update;
 if not found or i.revoked_at is not null or i.redeemed_at is not null or i.expires_at<=clock_timestamp() or i.otp_attempts>=5 then return jsonb_build_object('state','unavailable'); end if;
 if not exists(select 1 from profiles where id=i.owner_profile_id and auth_user_id=i.owner_subject and access_status='active') then return jsonb_build_object('state','unavailable'); end if;
 select * into mail from credential_portal_outbox where invite_id=i.id and kind='otp' and otp_version=i.otp_version;
 if found and mail.state in ('pending','sending','unknown') and mail.expires_at>clock_timestamp() then return jsonb_build_object('state','retry','mailId',mail.id); end if;
 if i.otp_sends>=5 or i.otp_last_sent_at>clock_timestamp()-interval '60 seconds' then return jsonb_build_object('state','limited'); end if;
 if not credential_portal_limit('recipient_otp',p_recipient_limit_key,date_trunc('hour',clock_timestamp()),5) then return jsonb_build_object('state','limited'); end if;
 if not credential_portal_limit('owner_otp',i.owner_profile_id::text,date_trunc('hour',clock_timestamp()),50) then return jsonb_build_object('state','limited'); end if;
 update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' when state='failed' then 'failed' else 'suppressed' end,encrypted_payload=null where invite_id=i.id and kind='otp' and state<>'sent';
 update credential_portal_invites set otp_version=p_version,otp_digest=p_digest,otp_expires_at=least(expires_at,clock_timestamp()+interval '10 minutes'),otp_sends=otp_sends+1,otp_last_sent_at=clock_timestamp() where id=i.id;
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
 if m.state in ('sent','failed','suppressed') then return null; end if;
 if not exists(select 1 from profiles where id=i.owner_profile_id and auth_user_id=i.owner_subject and access_status='active') then
  update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' else 'suppressed' end,encrypted_payload=null where id=p_id; return null;
 end if;
 if i.revoked_at is not null or i.redeemed_at is not null or i.expires_at<=clock_timestamp() or m.expires_at<=clock_timestamp()
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

create or replace function public.credential_portal_finish_mail(p_id uuid,p_lease uuid,p_state text,p_provider_id text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_state not in ('sent','unknown','failed') then raise exception 'invalid delivery state'; end if;
 if p_state='sent' and (p_provider_id is null or length(trim(p_provider_id)) not between 1 and 200) then raise exception 'provider acceptance id required'; end if;
 update credential_portal_outbox set state=p_state,provider_id=p_provider_id,encrypted_payload=case when p_state in ('sent','failed') then null else encrypted_payload end,lease_until=null,lease_token=null
 where id=p_id and state='sending' and lease_token=p_lease;
 return found;
end $$;

create or replace function public.credential_portal_redeem(p_token_digest text,p_email text,p_version uuid,p_otp_digest text,p_session_digest text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype; expiry timestamptz;
begin
 select * into i from credential_portal_invites where token_digest=p_token_digest and recipient_email=p_email for update;
 if not found or i.revoked_at is not null or i.redeemed_at is not null or i.expires_at<=clock_timestamp() or i.otp_attempts>=5
  or i.otp_expires_at is null or i.otp_expires_at<=clock_timestamp() then return null; end if;
 if not exists(select 1 from profiles where id=i.owner_profile_id and auth_user_id=i.owner_subject and access_status='active') then return null; end if;
 update credential_portal_invites set otp_attempts=otp_attempts+1 where id=i.id;
 if i.otp_version is distinct from p_version or i.otp_digest is distinct from p_otp_digest then return null; end if;
 expiry:=least(i.expires_at,clock_timestamp()+interval '30 minutes');
 insert into credential_portal_sessions(token_digest,invite_id,expires_at) values(p_session_digest,i.id,expiry);
 update credential_portal_invites set redeemed_at=clock_timestamp(),otp_digest=null where id=i.id;
 update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' when state='failed' then 'failed' else 'suppressed' end,encrypted_payload=null where invite_id=i.id and state<>'sent';
 insert into credential_portal_audit(invite_id,event) values(i.id,'session_verified');
 return jsonb_build_object('inviteId',i.id,'expiresAt',expiry,'documents',coalesce((
  select jsonb_agg(jsonb_build_object('id',x.document_id,'name',x.name,'mimeType',x.mime_type,'sizeBytes',x.size_bytes))
  from credential_portal_documents x join documents o on o.id=x.document_id where x.invite_id=i.id and o.user_id=i.owner_profile_id
   and o.storage_path=x.storage_path and x.storage_path=i.owner_subject||'/'||x.document_id::text and o.name=x.name and coalesce(o.mime_type,'application/octet-stream')=x.mime_type
 ),'[]'::jsonb));
end $$;

create or replace function public.credential_portal_record(p_session_digest text,p_document_id uuid,p_event text,p_intent text,p_bytes integer)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare access jsonb;
begin
 if p_event not in ('documents_listed','document_response_prepared','document_unavailable') then raise exception 'invalid event'; end if;
 if p_event='documents_listed' and (p_document_id is not null or p_intent is not null or p_bytes is not null) then raise exception 'invalid list event'; end if;
 if p_event<>'documents_listed' and (p_document_id is null or p_intent not in ('view','download')) then raise exception 'invalid file event'; end if;
 access:=credential_portal_access(p_session_digest,p_document_id,false);
 if access is null then return false; end if;
 if p_event='document_response_prepared' and (p_bytes is null or p_bytes<>(access->'document'->>'size_bytes')::integer) then raise exception 'invalid response size'; end if;
 insert into credential_portal_audit(invite_id,document_id,event,intent,bytes_prepared) values((access->>'inviteId')::uuid,p_document_id,p_event,p_intent,p_bytes);
 return true;
end $$;

create or replace function public.credential_portal_access(p_session_digest text,p_document_id uuid default null,p_count boolean default true)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype; s credential_portal_sessions%rowtype; d credential_portal_documents%rowtype;
begin
 select v.* into i from credential_portal_invites v join credential_portal_sessions t on t.invite_id=v.id where t.token_digest=p_session_digest for update of v;
 if not found or i.revoked_at is not null or i.expires_at<=clock_timestamp() then return null; end if;
 select * into s from credential_portal_sessions where token_digest=p_session_digest for update;
 if s.expires_at<=clock_timestamp() or (p_count and s.request_count>=100) then return null; end if;
 if not exists(select 1 from profiles where id=i.owner_profile_id and auth_user_id=i.owner_subject and access_status='active') then return null; end if;
 if p_count then update credential_portal_sessions set request_count=request_count+1 where token_digest=p_session_digest; end if;
 if p_document_id is null then return jsonb_build_object('inviteId',i.id,'ownerId',i.owner_profile_id,'ownerSubject',i.owner_subject,'expiresAt',s.expires_at); end if;
 select x.* into d from credential_portal_documents x join documents o on o.id=x.document_id
  where x.invite_id=i.id and x.document_id=p_document_id and o.user_id=i.owner_profile_id
  and o.storage_path=x.storage_path and x.storage_path=i.owner_subject||'/'||x.document_id::text
  and o.name=x.name and coalesce(o.mime_type,'application/octet-stream')=x.mime_type;
 if not found then return null; end if;
 return jsonb_build_object('inviteId',i.id,'ownerId',i.owner_profile_id,'ownerSubject',i.owner_subject,'expiresAt',s.expires_at,'document',to_jsonb(d));
end $$;

create or replace function public.credential_portal_revoke(p_owner uuid,p_subject text,p_invite uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 perform 1 from profiles where id=p_owner and auth_user_id=p_subject;
 if not found then return false; end if;
 update credential_portal_invites set revoked_at=coalesce(revoked_at,clock_timestamp()),otp_digest=null where id=p_invite and owner_profile_id=p_owner and owner_subject=p_subject;
 if not found then return false; end if;
 update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' when state='failed' then 'failed' else 'suppressed' end,encrypted_payload=null where invite_id=p_invite and state<>'sent';
 if not exists(select 1 from credential_portal_audit where invite_id=p_invite and event='invitation_revoked') then insert into credential_portal_audit(invite_id,event) values(p_invite,'invitation_revoked'); end if;
 return true;
end $$;

-- Run this bounded maintenance RPC on a private schedule before enabling mail.
create or replace function public.credential_portal_prune()
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare i credential_portal_invites%rowtype;
begin
 -- Same invitation-first lock order as redeem/revoke/mail. Bound the batch and skip busy invitations.
 for i in select v.* from credential_portal_invites v where v.expires_at<clock_timestamp()-interval '90 days'
   or (v.otp_digest is not null and v.otp_expires_at<=clock_timestamp())
   or exists(select 1 from credential_portal_outbox o where o.invite_id=v.id and o.expires_at<=clock_timestamp() and o.encrypted_payload is not null)
   or exists(select 1 from credential_portal_sessions s where s.invite_id=v.id and s.expires_at<=clock_timestamp()-interval '1 day')
   order by v.id for update of v skip locked limit 100 loop
  update credential_portal_outbox set state=case when state in ('sending','unknown') then 'unknown' else 'suppressed' end,encrypted_payload=null
   where invite_id=i.id and expires_at<=clock_timestamp() and encrypted_payload is not null;
  update credential_portal_invites set otp_digest=null where id=i.id and otp_expires_at<=clock_timestamp() and otp_digest is not null;
  delete from credential_portal_sessions where invite_id=i.id and expires_at<=clock_timestamp()-interval '1 day';
  if i.expires_at<clock_timestamp()-interval '90 days' then delete from credential_portal_invites where id=i.id; end if;
 end loop;
 delete from credential_portal_limits where window_start<clock_timestamp()-interval '2 days';
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'credential_portal_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
