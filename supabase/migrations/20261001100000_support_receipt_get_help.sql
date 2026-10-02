-- 20261001100000_support_receipt_get_help.sql
--
-- The support receipt names the menu as it now reads. The More menu item
-- "Support" is "Get help" since the outgoing-text fixes (fix/sent-formatting),
-- and the ticket reply email already says "More > Get help > Your tickets".
-- The receipt support_complete_job writes still said "More > Support > Your
-- tickets", a menu item the member cannot find.
--
-- support_complete_job as 20260918090000_autonomous_support_foundation.sql
-- defines it, with that one sentence changed and nothing else
-- (tests/support/receipt-get-help-migration.test.mjs holds the two in step).
-- Its grants are restated the way the foundation sets them: service_role only.
--
-- Production (read-only check, 2026-10-01): the support foundation is not
-- applied there yet (no support_complete_job), so this runs after it in
-- migration order and changes no live behaviour until the foundation ships.
begin;
do $$ begin
  if to_regprocedure('public.support_complete_job(uuid,uuid,text,text)') is null then
    raise exception 'support_complete_job is missing: apply 20260918090000_autonomous_support_foundation.sql first';
  end if;
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
    txt:='Your support request has been received. You can see replies and add details in More > Get help > Your tickets. Please leave passwords, API keys and patient information out of your message.';
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

revoke all on function public.support_complete_job(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.support_complete_job(uuid,uuid,text,text) to service_role;
commit;
