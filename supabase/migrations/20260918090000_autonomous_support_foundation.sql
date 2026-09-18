-- Staged foundation only. No scheduler, existing trigger or live function is replaced.
-- Existing support conversations are reused. All new RPCs are service-role only.
begin;
do $$ begin
  if to_regclass('public.support_tickets') is null or to_regclass('public.support_messages') is null
    or to_regclass('public.profiles') is null or to_regclass('public.app_admins') is null
    or to_regclass('public.forwarding_addresses') is null then
    raise exception 'Support requires existing tickets/messages/profiles/admins/verified forwarding schema';
  end if;
end $$;

create table if not exists public.support_operations_config (
  singleton boolean primary key default true check(singleton),
  mode text not null default 'disabled' check(mode in ('disabled','shadow','active')),
  publication_enabled boolean not null default false,
  outbound_enabled boolean not null default false,
  canary_verified_at timestamptz,
  policy_version text not null default 'support-2026-09-v1',
  check(not (publication_enabled or outbound_enabled) or (mode='active' and canary_verified_at is not null)),
  check(not outbound_enabled or publication_enabled)
);
insert into public.support_operations_config(singleton) values(true) on conflict do nothing;
create table if not exists public.support_actors (
  id uuid primary key, name text not null, enabled boolean not null default true
);
insert into public.support_actors values('00000000-0000-4000-8000-000000000018','CredentialDO Support',true) on conflict do nothing;
create table if not exists public.support_ticket_state (
  ticket_id uuid primary key references public.support_tickets(id) on delete cascade,
  input_seq bigint not null default 0,
  last_answered_seq bigint not null default 0,
  paused boolean not null default false,
  workflow_state text not null default 'open' check(workflow_state in ('open','waiting_user','escalated','resolved')),
  check(input_seq>=last_answered_seq and last_answered_seq>=0)
);
create table if not exists public.support_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  source_kind text not null check(source_kind in ('ticket','message')),
  source_id uuid not null,
  input_seq bigint not null,
  content_hash text not null,
  input_text text not null check(length(input_text)<=10200),
  created_at timestamptz not null default clock_timestamp(),
  unique(source_kind,source_id), unique(ticket_id,input_seq)
);
create table if not exists public.support_intake_requests (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null,
  request_hash text not null,
  ticket_id uuid references public.support_tickets(id) on delete cascade,
  message_id uuid references public.support_messages(id) on delete cascade,
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key(profile_id,request_id)
);
create table if not exists public.support_jobs (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  event_id uuid not null references public.support_events(id) on delete cascade,
  kind text not null check(kind in ('receipt','answer')),
  input_seq bigint not null,
  state text not null default 'queued' check(state in ('queued','running','retry','draft','completed','superseded','dead')),
  run_after timestamptz not null default clock_timestamp(),
  attempts integer not null default 0 check(attempts>=0),
  lease_token uuid, lease_until timestamptz,
  policy_version text,
  result jsonb,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  unique(event_id,kind)
);
create index if not exists support_jobs_due on public.support_jobs(state,run_after,created_at);
create table if not exists public.support_knowledge (
  id text primary key,
  revision text not null,
  questions text[] not null,
  answer text not null check(length(answer) between 1 and 4000),
  source_url text not null check(source_url like 'https://credentialdomd.com/%'),
  approved boolean not null default false,
  expires_at timestamptz not null
);
create table if not exists public.support_mail_bindings (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  forwarding_id uuid not null references public.forwarding_addresses(id) on delete cascade,
  verified_at timestamptz not null,
  email text not null,
  version uuid not null default gen_random_uuid(),
  revoked_at timestamptz
);
create table if not exists public.support_outbox (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.support_jobs(id) on delete cascade,
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  message_id uuid references public.support_messages(id) on delete cascade,
  binding_version uuid,
  recipient text,
  subject text not null,
  body text not null,
  provider text not null default 'resend' check(provider='resend'),
  state text not null default 'draft' check(state in ('draft','queued','leased','sending','accepted','delivered','unknown','suppressed','failed','bounced','complained')),
  lease_token uuid, lease_until timestamptz,
  attempt_id uuid,
  first_submitted_at timestamptz,
  provider_message_id text,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  accepted_at timestamptz, delivered_at timestamptz,
  check(state not in ('queued','leased','sending','accepted','delivered') or (recipient is not null and binding_version is not null))
);
create unique index if not exists support_outbox_provider_id on public.support_outbox(provider,provider_message_id) where provider_message_id is not null;
create table if not exists public.support_provider_receipts (
  provider text not null check(provider='resend'), event_id text not null,
  outbox_id uuid not null references public.support_outbox(id) on delete cascade,
  provider_message_id text not null,
  kind text not null check(kind in ('accepted','delivered','bounced','complained')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(provider,event_id)
);
create table if not exists public.support_approvals (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  capability text not null check(capability in ('release_code','refund_payment','change_identity','change_access','delete_data','change_clinical_rule','change_policy','new_spend')),
  action jsonb not null check(jsonb_typeof(action)='object'), action_hash text not null,
  state text not null default 'pending' check(state in ('pending','approved','denied','executing','succeeded','unknown','failed')),
  expires_at timestamptz not null,
  approved_by uuid references public.profiles(id), approved_at timestamptz,
  execution_id uuid unique, provider_reference text,
  created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists support_approval_pending on public.support_approvals(ticket_id,capability,action_hash) where state in ('pending','approved','executing','unknown');

-- A service identity cannot log in and is not an app admin or physician profile.
alter table public.support_messages add column if not exists support_actor_id uuid references public.support_actors(id);
alter table public.support_messages add column if not exists support_job_id uuid references public.support_jobs(id);
alter table public.support_messages alter column author_id drop not null;
create unique index if not exists support_messages_job_unique on public.support_messages(support_job_id) where support_job_id is not null;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.support_messages'::regclass and conname='support_message_actor_shape') then
    alter table public.support_messages add constraint support_message_actor_shape check((
      (support_actor_id is null and support_job_id is null and author_id is not null)
      or (support_actor_id='00000000-0000-4000-8000-000000000018' and support_job_id is not null and author_id is null and is_admin_reply=true)
    ) is true);
  end if;
end $$;
create or replace function public.support_guard_actor() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if current_user not in ('postgres','service_role') then
    if new.support_actor_id is not null or new.support_job_id is not null or new.author_id is null
      or (tg_op='UPDATE' and (old.support_actor_id is not null or old.support_job_id is not null)) then
      raise exception 'Support service identity is protected' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists support_foundation_guard_actor on public.support_messages;
create trigger support_foundation_guard_actor before insert or update on public.support_messages for each row execute function public.support_guard_actor();

-- Lock order throughout: ticket -> ticket state -> job. No external I/O in SQL.
create or replace function public.support_ingest(p_ticket_id uuid,p_message_id uuid default null) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare t public.support_tickets%rowtype; m public.support_messages%rowtype; e public.support_events%rowtype;
  txt text; source text; sid uuid; fingerprint text; seq bigint; eid uuid; mode_now text;
begin
  select * into t from public.support_tickets where id=p_ticket_id for update;
  if not found then raise exception 'Ticket unavailable'; end if;
  if p_message_id is null then txt:=left(t.body,10000); source:='ticket'; sid:=t.id;
  else
    select * into m from public.support_messages where id=p_message_id and ticket_id=t.id;
    if not found or m.author_id is distinct from t.user_id or m.support_actor_id is not null then raise exception 'Customer message unavailable'; end if;
    txt:=left(m.body,10000); source:='message'; sid:=m.id;
  end if;
  fingerprint:=encode(sha256(convert_to(txt,'UTF8')),'hex');
  select * into e from public.support_events where source_kind=source and source_id=sid;
  if found then
    if e.ticket_id<>t.id or e.content_hash<>fingerprint then raise exception 'Source event changed'; end if;
    return jsonb_build_object('state','duplicate','event_id',e.id,'input_seq',e.input_seq);
  end if;
  insert into public.support_ticket_state(ticket_id) values(t.id) on conflict do nothing;
  update public.support_ticket_state set input_seq=input_seq+1,workflow_state='open' where ticket_id=t.id returning input_seq into seq;
  insert into public.support_events(ticket_id,source_kind,source_id,input_seq,content_hash,input_text)
    values(t.id,source,sid,seq,fingerprint,txt) returning id into eid;
  insert into public.support_jobs(ticket_id,event_id,kind,input_seq) values(t.id,eid,'answer',seq);
  if source='ticket' then insert into public.support_jobs(ticket_id,event_id,kind,input_seq) values(t.id,eid,'receipt',seq); end if;
  select mode into mode_now from public.support_operations_config where singleton;
  return jsonb_build_object('state','queued','mode',mode_now,'event_id',eid,'input_seq',seq);
end $$;

-- New authenticated intake can commit the customer record and its jobs together.
-- p_profile_id is the broker's verified Clerk identity, never a request field.
create or replace function public.support_submit(
  p_profile_id uuid,p_request_id uuid,p_ticket_id uuid,p_subject text,p_body text,p_category text default 'other',p_priority text default 'normal'
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare fingerprint text; prior public.support_intake_requests%rowtype; tid uuid; mid uuid; result_value jsonb;
begin
  if p_request_id is null or not exists(select 1 from public.profiles where id=p_profile_id and access_status='active') then raise exception 'Active account required'; end if;
  if p_ticket_id is null then p_category:=case p_category when 'feedback' then 'other' when 'idea' then 'feature_request' else p_category end; end if;
  if p_body is null or length(trim(p_body)) not between 1 and 10000 then raise exception 'Invalid message'; end if;
  if p_ticket_id is null and (p_subject is null or length(trim(p_subject)) not between 3 and 200 or length(trim(p_body))<10
    or p_category is null or p_category not in ('bug','billing','feature_request','data_issue','compliance','other')
    or p_priority is null or p_priority not in ('low','normal','high','urgent')) then raise exception 'Invalid ticket'; end if;
  if p_ticket_id is not null and (p_subject is not null or p_category is distinct from 'other' or p_priority is distinct from 'normal') then raise exception 'Reply cannot change ticket fields'; end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('ticket',p_ticket_id,'subject',p_subject,'body',p_body,'category',p_category,'priority',p_priority)::text,'UTF8')),'hex');
  -- Serialize per-profile admission so concurrent unique IDs cannot exceed caps.
  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text,918));
  insert into public.support_intake_requests(profile_id,request_id,request_hash) values(p_profile_id,p_request_id,fingerprint) on conflict do nothing;
  select * into prior from public.support_intake_requests where profile_id=p_profile_id and request_id=p_request_id for update;
  if prior.request_hash<>fingerprint then raise exception 'Idempotency payload changed'; end if;
  if prior.result is not null then return prior.result||jsonb_build_object('duplicate',true); end if;
  if (select count(*) from public.support_intake_requests where profile_id=p_profile_id and created_at>clock_timestamp()-interval '1 hour')>20
    or (select count(*) from public.support_intake_requests where profile_id=p_profile_id and created_at>clock_timestamp()-interval '24 hours')>60 then raise exception 'Support intake rate limited'; end if;
  if p_ticket_id is null then
    insert into public.support_tickets(user_id,subject,body,category,priority) values(p_profile_id,trim(p_subject),trim(p_body),p_category,p_priority) returning id into tid;
  else
    select id into tid from public.support_tickets where id=p_ticket_id and user_id=p_profile_id for update;
    if tid is null then raise exception 'Ticket unavailable'; end if;
    insert into public.support_messages(ticket_id,author_id,body,is_admin_reply) values(tid,p_profile_id,trim(p_body),false) returning id into mid;
    update public.support_tickets set status='open',archived_at=null,resolved_at=null where id=tid;
  end if;
  result_value:=public.support_ingest(tid,mid)||jsonb_build_object('ticket_id',tid,'message_id',mid,'duplicate',false);
  update public.support_intake_requests set ticket_id=tid,message_id=mid,result=result_value where profile_id=p_profile_id and request_id=p_request_id;
  return result_value;
end $$;

create or replace function public.support_claim_job(p_kind text) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare c public.support_operations_config%rowtype; j public.support_jobs%rowtype; token uuid;
begin
  if p_kind not in ('receipt','answer') then raise exception 'Invalid job kind'; end if;
  select * into c from public.support_operations_config where singleton;
  if c.singleton is distinct from true or c.mode='disabled' then return jsonb_build_object('state','disabled'); end if;
  update public.support_jobs set state='dead',last_error='attempt_limit',lease_token=null,lease_until=null
    where kind=p_kind and attempts>=5 and (state in ('queued','retry') or (state='running' and lease_until<=clock_timestamp()));
  select q.* into j from public.support_jobs q join public.support_ticket_state s on s.ticket_id=q.ticket_id join public.support_tickets t on t.id=q.ticket_id
    where q.kind=p_kind and not s.paused and t.status not in ('resolved','closed') and q.attempts<5 and q.run_after<=clock_timestamp()
      and (q.state in ('queued','retry') or (q.state='running' and q.lease_until<=clock_timestamp()))
    order by q.created_at,q.id for update of q skip locked limit 1;
  if not found then return jsonb_build_object('state','idle'); end if;
  token:=gen_random_uuid();
  update public.support_jobs set state='running',attempts=attempts+1,lease_token=token,
    lease_until=clock_timestamp()+interval '90 seconds',policy_version=c.policy_version where id=j.id;
  return jsonb_build_object('state','claimed','id',j.id,'ticket_id',j.ticket_id,'kind',j.kind,'input_seq',j.input_seq,
    'token',token,'policy_version',c.policy_version,'mode',c.mode,
    'input',(select input_text from public.support_events where id=j.event_id));
end $$;

create or replace function public.support_complete_job(p_job_id uuid,p_token uuid,p_knowledge_id text default null,p_knowledge_revision text default null)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.support_jobs%rowtype; s public.support_ticket_state%rowtype; c public.support_operations_config%rowtype;
  t public.support_tickets%rowtype; k public.support_knowledge%rowtype; b public.support_mail_bindings%rowtype;
  txt text; result_kind text; message uuid; outbox uuid; publish boolean; email_state text;
begin
  select * into j from public.support_jobs where id=p_job_id;
  if not found then raise exception 'Job unavailable'; end if;
  select * into t from public.support_tickets where id=j.ticket_id for update;
  select * into s from public.support_ticket_state where ticket_id=j.ticket_id for update;
  select * into j from public.support_jobs where id=p_job_id for update;
  select * into c from public.support_operations_config where singleton;
  if j.state in ('draft','completed') and j.lease_token=p_token then return jsonb_build_object('state','duplicate'); end if;
  if j.state<>'running' or j.lease_token is distinct from p_token or p_token is null or j.lease_until<=clock_timestamp() then return jsonb_build_object('state','fenced'); end if;
  if c.singleton is distinct from true or c.mode='disabled' or s.paused or t.status in ('resolved','closed') or j.policy_version<>c.policy_version then
    update public.support_jobs set state='retry',lease_token=null,lease_until=null,last_error='policy_paused' where id=j.id;
    return jsonb_build_object('state','paused');
  end if;
  if j.input_seq<>s.input_seq then
    update public.support_jobs set state='superseded',lease_until=null where id=j.id;
    return jsonb_build_object('state','superseded');
  end if;
  if j.kind='receipt' then
    txt:='Your support request has been received. You can see replies and add details in More > Support > Your tickets. Please leave passwords, API keys and patient information out of your message.';
    result_kind:='receipt';
  elsif p_knowledge_id is not null then
    select * into k from public.support_knowledge where id=p_knowledge_id and revision=p_knowledge_revision and approved and expires_at>clock_timestamp();
    if not found or not (lower(trim((select input_text from public.support_events where id=j.event_id)))=any(k.questions)) then raise exception 'Approved exact knowledge answer unavailable'; end if;
    txt:=k.answer||E'\n\n'||k.source_url; result_kind:='public_answer';
  else
    txt:='Your request needs further review. It is still open, and an update will appear in this ticket. Please use this thread for any additional details.';
    result_kind:='escalation';
  end if;
  publish:=c.mode='active' and c.publication_enabled and c.canary_verified_at is not null;
  if publish then
    if not exists(select 1 from public.support_actors where id='00000000-0000-4000-8000-000000000018' and enabled) then raise exception 'Support actor disabled'; end if;
    insert into public.support_messages(ticket_id,author_id,body,is_admin_reply,support_actor_id,support_job_id)
      values(t.id,null,txt,true,'00000000-0000-4000-8000-000000000018',j.id) returning id into message;
  end if;
  select mb.* into b from public.support_mail_bindings mb join public.forwarding_addresses f on f.id=mb.forwarding_id
    where mb.profile_id=t.user_id and mb.revoked_at is null and f.user_id=mb.profile_id and f.verified_at=mb.verified_at
      and lower(trim(f.email))=mb.email and f.verified_at is not null;
  email_state:=case when not publish then 'draft' when not c.outbound_enabled then 'draft' when b.profile_id is null then 'suppressed' else 'queued' end;
  insert into public.support_outbox(job_id,ticket_id,message_id,binding_version,recipient,subject,body,state,error_code)
    values(j.id,t.id,message,b.version,b.email,'Update on your CredentialDO support request',txt,email_state,
      case when publish and b.profile_id is null then 'verified_recipient_required' else null end) returning id into outbox;
  update public.support_jobs set state=case when publish then 'completed' else 'draft' end,lease_until=null,
    result=jsonb_build_object('kind',result_kind,'body',txt,'knowledge_id',p_knowledge_id,'knowledge_revision',p_knowledge_revision,
      'message_id',message,'outbox_id',outbox,'published',publish) where id=j.id;
  if j.kind='answer' and publish then update public.support_ticket_state set last_answered_seq=j.input_seq,
    workflow_state=case when result_kind='escalation' then 'escalated' else 'waiting_user' end where ticket_id=t.id; end if;
  return jsonb_build_object('state',case when publish then 'published' else 'draft' end,'kind',result_kind,'message_id',message,'outbox_id',outbox,'email_state',email_state);
end $$;

create or replace function public.support_bind_mailbox(p_profile_id uuid,p_forwarding_id uuid) returns uuid
language plpgsql security invoker set search_path=public,pg_temp as $$
declare email_value text; verified timestamptz; version_value uuid:=gen_random_uuid();
begin
  select lower(trim(email)),verified_at into email_value,verified from public.forwarding_addresses where id=p_forwarding_id and user_id=p_profile_id and verified_at is not null;
  if not found or email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Verified mailbox required'; end if;
  insert into public.support_mail_bindings(profile_id,forwarding_id,verified_at,email,version)
    values(p_profile_id,p_forwarding_id,verified,email_value,version_value)
    on conflict(profile_id) do update set forwarding_id=excluded.forwarding_id,verified_at=excluded.verified_at,email=excluded.email,version=excluded.version,revoked_at=null;
  return version_value;
end $$;

create or replace function public.support_claim_outbox() returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare c public.support_operations_config%rowtype; o public.support_outbox%rowtype; token uuid:=gen_random_uuid();
begin
  select * into c from public.support_operations_config where singleton;
  if c.singleton is distinct from true or c.mode<>'active' or not c.outbound_enabled or not c.publication_enabled or c.canary_verified_at is null then return jsonb_build_object('state','disabled'); end if;
  -- Expired submission is UNKNOWN, never another queued send.
  update public.support_outbox set state='unknown',error_code='submission_lease_expired',lease_token=null,lease_until=null where state='sending' and lease_until<=clock_timestamp();
  select * into o from public.support_outbox where state='queued' or (state='leased' and lease_until<=clock_timestamp()) order by created_at,id for update skip locked limit 1;
  if not found then return jsonb_build_object('state','idle'); end if;
  update public.support_outbox set state='leased',lease_token=token,lease_until=clock_timestamp()+interval '45 seconds' where id=o.id;
  return jsonb_build_object('state','claimed','id',o.id,'token',token);
end $$;

create or replace function public.support_begin_send(p_outbox_id uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare o public.support_outbox%rowtype; c public.support_operations_config%rowtype; attempt uuid:=gen_random_uuid();
begin
  select * into o from public.support_outbox where id=p_outbox_id for update;
  select * into c from public.support_operations_config where singleton;
  if o.id is null or o.state<>'leased' or o.lease_token is distinct from p_token or p_token is null or o.lease_until<=clock_timestamp() then return jsonb_build_object('state','fenced'); end if;
  if c.singleton is distinct from true or c.mode<>'active' or not c.outbound_enabled or not c.publication_enabled or c.canary_verified_at is null then return jsonb_build_object('state','disabled'); end if;
  if not exists(select 1 from public.support_jobs j
    join public.support_ticket_state s on s.ticket_id=j.ticket_id
    join public.support_tickets t on t.id=j.ticket_id
    join public.profiles p on p.id=t.user_id
    where j.id=o.job_id and j.state='completed' and j.input_seq=s.input_seq and not s.paused
      and j.policy_version=c.policy_version and p.access_status='active' and t.status not in ('resolved','closed'))
    or not exists(select 1 from public.support_actors where id='00000000-0000-4000-8000-000000000018' and enabled) then
    update public.support_outbox set state='suppressed',error_code='response_superseded_or_paused',lease_token=null,lease_until=null where id=o.id;
    return jsonb_build_object('state','suppressed');
  end if;
  if not exists(select 1 from public.support_mail_bindings b join public.forwarding_addresses f on f.id=b.forwarding_id
    join public.support_tickets t on t.user_id=b.profile_id where t.id=o.ticket_id and b.version=o.binding_version and b.email=o.recipient
      and b.revoked_at is null and f.user_id=b.profile_id and f.verified_at=b.verified_at and lower(trim(f.email))=b.email)
    or exists(select 1 from public.support_outbox where recipient=o.recipient and state in ('bounced','complained')) then
    update public.support_outbox set state='suppressed',error_code='recipient_unverified_or_suppressed',lease_token=null,lease_until=null where id=o.id;
    return jsonb_build_object('state','suppressed');
  end if;
  update public.support_outbox set state='sending',attempt_id=attempt,first_submitted_at=coalesce(first_submitted_at,clock_timestamp()),
    lease_until=clock_timestamp()+interval '60 seconds' where id=o.id;
  return jsonb_build_object('state','sending','id',o.id,'attempt_id',attempt,'recipient',o.recipient,'subject',o.subject,'body',o.body,'idempotency_key','support/'||o.id);
end $$;

create or replace function public.support_finish_send(p_outbox_id uuid,p_attempt_id uuid,p_outcome text,p_provider_id text default null) returns text
language plpgsql security invoker set search_path=public,pg_temp as $$
declare o public.support_outbox%rowtype;
begin
  if p_outcome not in ('accepted','unknown','failed') then raise exception 'Invalid outcome'; end if;
  if p_outcome='accepted' and (p_provider_id is null or length(p_provider_id) not between 1 and 200) then raise exception 'Provider acceptance ID required'; end if;
  select * into o from public.support_outbox where id=p_outbox_id for update;
  if not found or o.attempt_id is distinct from p_attempt_id or p_attempt_id is null then return 'fenced'; end if;
  if o.state in ('accepted','delivered','bounced','complained') then
    if p_provider_id is not null and o.provider_message_id is distinct from p_provider_id then raise exception 'Provider ID mismatch'; end if;
    return 'duplicate';
  end if;
  if o.state not in ('sending','unknown') then return 'fenced'; end if;
  update public.support_outbox set state=p_outcome,provider_message_id=p_provider_id,
    accepted_at=case when p_outcome='accepted' then clock_timestamp() else accepted_at end,
    error_code=case when p_outcome='accepted' then null else 'submission_'||p_outcome end,lease_token=null,lease_until=null where id=o.id;
  return p_outcome;
end $$;

create or replace function public.support_record_receipt(p_event_id text,p_outbox_id uuid,p_provider_id text,p_kind text) returns text
language plpgsql security invoker set search_path=public,pg_temp as $$
declare o public.support_outbox%rowtype; r public.support_provider_receipts%rowtype;
begin
  if length(p_event_id) not between 1 and 200 or length(p_provider_id) not between 1 and 200 or p_kind not in ('accepted','delivered','bounced','complained') then raise exception 'Invalid provider receipt'; end if;
  select * into o from public.support_outbox where id=p_outbox_id for update;
  if not found or o.first_submitted_at is null then raise exception 'Submission unavailable'; end if;
  select * into r from public.support_provider_receipts where provider='resend' and event_id=p_event_id;
  if found then
    if r.outbox_id<>p_outbox_id or r.provider_message_id<>p_provider_id or r.kind<>p_kind then raise exception 'Provider event collision'; end if;
    return 'duplicate';
  end if;
  if o.provider_message_id is not null and o.provider_message_id<>p_provider_id then raise exception 'Provider ID mismatch'; end if;
  insert into public.support_provider_receipts(provider,event_id,outbox_id,provider_message_id,kind) values('resend',p_event_id,p_outbox_id,p_provider_id,p_kind);
  update public.support_outbox set provider_message_id=p_provider_id,
    state=case when o.state='complained' or p_kind='complained' then 'complained' when o.state='bounced' or p_kind='bounced' then 'bounced'
      when o.state='delivered' or p_kind='delivered' then 'delivered' else 'accepted' end,
    accepted_at=coalesce(accepted_at,clock_timestamp()),delivered_at=case when p_kind='delivered' then clock_timestamp() else delivered_at end,
    lease_token=null,lease_until=null,error_code=null where id=o.id;
  return 'recorded';
end $$;

create or replace function public.support_request_approval(p_ticket_id uuid,p_capability text,p_action jsonb) returns uuid
language plpgsql security invoker set search_path=public,pg_temp as $$
declare fingerprint text; result_id uuid;
begin
  if jsonb_typeof(p_action)<>'object' or octet_length(p_action::text)>8192 then raise exception 'Invalid action'; end if;
  perform 1 from public.support_tickets where id=p_ticket_id for update;
  if not found then raise exception 'Ticket unavailable'; end if;
  fingerprint:=encode(sha256(convert_to(p_action::text,'UTF8')),'hex');
  select id into result_id from public.support_approvals where ticket_id=p_ticket_id and capability=p_capability and action_hash=fingerprint and state in ('pending','approved','executing','unknown');
  if result_id is not null then return result_id; end if;
  insert into public.support_approvals(ticket_id,capability,action,action_hash,expires_at) values(p_ticket_id,p_capability,p_action,fingerprint,clock_timestamp()+interval '24 hours') returning id into result_id;
  return result_id;
end $$;
create or replace function public.support_decide_approval(p_id uuid,p_clerk_sub text,p_approve boolean) returns text
language plpgsql security invoker set search_path=public,pg_temp as $$
declare owner_id uuid; a public.support_approvals%rowtype;
begin
  select p.id into owner_id from public.profiles p join public.app_admins aa on aa.profile_id=p.id where p.auth_user_id=p_clerk_sub;
  if owner_id is null then raise exception 'Owner approval required' using errcode='42501'; end if;
  select * into a from public.support_approvals where id=p_id for update;
  if not found or a.state<>'pending' or a.expires_at<=clock_timestamp() or p_approve is null then raise exception 'Approval unavailable'; end if;
  update public.support_approvals set state=case when p_approve then 'approved' else 'denied' end,approved_by=owner_id,approved_at=clock_timestamp() where id=p_id;
  return case when p_approve then 'approved' else 'denied' end;
end $$;
create or replace function public.support_claim_approval(p_id uuid,p_capability text,p_action_hash text) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.support_approvals%rowtype; execution uuid:=gen_random_uuid();
begin
  select * into a from public.support_approvals where id=p_id for update;
  if not found or a.state<>'approved' or a.expires_at<=clock_timestamp() or a.capability is distinct from p_capability or a.action_hash is distinct from p_action_hash
    or not exists(select 1 from public.app_admins where profile_id=a.approved_by) then return jsonb_build_object('state','denied'); end if;
  update public.support_approvals set state='executing',execution_id=execution where id=p_id;
  return jsonb_build_object('state','claimed','execution_id',execution,'action',a.action);
end $$;
create or replace function public.support_settle_approval(p_execution_id uuid,p_outcome text,p_reference text default null) returns text
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if p_outcome not in ('succeeded','unknown','failed') or (p_outcome='succeeded' and nullif(p_reference,'') is null) then raise exception 'Execution evidence required'; end if;
  update public.support_approvals set state=p_outcome,provider_reference=p_reference where execution_id=p_execution_id and state in ('executing','unknown');
  return case when found then p_outcome else 'fenced' end;
end $$;

-- No new table is exposed to clients, even if a permissive policy is later added.
do $$ declare name text; fn record; begin
  foreach name in array array['support_operations_config','support_actors','support_ticket_state','support_intake_requests','support_events','support_jobs','support_knowledge','support_mail_bindings','support_outbox','support_provider_receipts','support_approvals'] loop
    execute format('alter table public.%I enable row level security',name);
    execute format('revoke all on public.%I from public,anon,authenticated',name);
    execute format('grant select,insert,update,delete on public.%I to service_role',name);
  end loop;
  for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('support_guard_actor','support_ingest','support_submit','support_claim_job','support_complete_job','support_bind_mailbox','support_claim_outbox','support_begin_send','support_finish_send','support_record_receipt','support_request_approval','support_decide_approval','support_claim_approval','support_settle_approval') loop
    execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
    execute format('grant execute on function %s to service_role',fn.signature);
  end loop;
end $$;
commit;
