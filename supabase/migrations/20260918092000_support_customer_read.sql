-- Additive owner-scoped reads for the disabled support-operations client.
-- These service-only RPCs never trust editable email or is_admin_reply as proof of identity.
begin;
create or replace function public.support_customer_actor(p_author uuid,p_actor uuid,p_job uuid,p_admin_flag boolean,p_owner uuid)
returns text language sql stable security invoker set search_path=public,pg_temp as $$
  select case
    when p_author is null and p_actor='00000000-0000-4000-8000-000000000018' and p_job is not null then 'automated'
    when p_author=p_owner and p_admin_flag is not true then 'you'
    when p_author=p_owner then 'account'
    when p_author is not null and exists(select 1 from public.app_admins where profile_id=p_author) then 'support'
    else 'unknown' end
$$;

create or replace function public.support_list_customer_tickets(p_profile_id uuid)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.profiles where id=p_profile_id) then return null; end if;
  return jsonb_build_object('tickets',coalesce((
    select jsonb_agg(to_jsonb(q) order by q.updated_at desc,q.id desc) from (
      select t.id,left(t.subject,200) as subject,t.status,t.created_at,t.updated_at,t.archived_at,
        (select r.request_id from public.support_intake_requests r where r.profile_id=p_profile_id and r.ticket_id=t.id and r.message_id is null limit 1) as request_id,
        coalesce(m.created_at,t.created_at) as last_message_at,
        case when m.id is null then 'you' else public.support_customer_actor(m.author_id,m.support_actor_id,m.support_job_id,m.is_admin_reply,t.user_id) end as last_actor_kind
      from public.support_tickets t
      left join lateral (select x.id,x.created_at,x.author_id,x.support_actor_id,x.support_job_id,x.is_admin_reply
        from public.support_messages x where x.ticket_id=t.id order by x.created_at desc,x.id desc limit 1) m on true
      where t.user_id=p_profile_id order by t.updated_at desc,t.id desc limit 100
    ) q
  ),'[]'::jsonb));
end $$;

create or replace function public.support_read_customer_ticket(p_profile_id uuid,p_ticket_id uuid,p_before_id uuid default null)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare t public.support_tickets%rowtype; cursor_time timestamptz; messages jsonb; has_more boolean; oldest uuid;
begin
  -- Even an app admin using this customer endpoint can read only their own ticket.
  select * into t from public.support_tickets where id=p_ticket_id and user_id=p_profile_id;
  if not found then return null; end if;
  if p_before_id is not null then
    select created_at into cursor_time from public.support_messages where id=p_before_id and ticket_id=t.id;
    if not found then return null; end if;
  end if;
  with selected as (
    select m.* from public.support_messages m where m.ticket_id=t.id
      and (p_before_id is null or (m.created_at,m.id)<(cursor_time,p_before_id))
    order by m.created_at desc,m.id desc limit 101
  ), page as (select * from selected order by created_at desc,id desc limit 100)
  select coalesce((select jsonb_agg(jsonb_build_object(
      'id',m.id,'ticket_id',m.ticket_id,'body',left(m.body,10000),'created_at',m.created_at,
      'request_id',(select r.request_id from public.support_intake_requests r where r.profile_id=p_profile_id and r.message_id=m.id limit 1),
      'actor_kind',public.support_customer_actor(m.author_id,m.support_actor_id,m.support_job_id,m.is_admin_reply,t.user_id),
      'has_attachments',coalesce(to_jsonb(m)->>'attachment_path','')<>'' or case when jsonb_typeof(to_jsonb(m)->'attachment_paths')='array' then jsonb_array_length(to_jsonb(m)->'attachment_paths')>0 else false end
    ) order by m.created_at,m.id) from page m),'[]'::jsonb),
    (select count(*)>100 from selected),
    (select id from page order by created_at,id limit 1)
  into messages,has_more,oldest;
  return jsonb_build_object('ticket',jsonb_build_object(
    'id',t.id,'subject',left(t.subject,200),'body',left(t.body,10000),'status',t.status,
    'request_id',(select r.request_id from public.support_intake_requests r where r.profile_id=p_profile_id and r.ticket_id=t.id and r.message_id is null limit 1),
    'created_at',t.created_at,'updated_at',t.updated_at,'archived_at',t.archived_at,
    'has_attachments',coalesce(to_jsonb(t)->'context_payload'->>'attachment_path','')<>''
      or case when jsonb_typeof(to_jsonb(t)->'context_payload'->'attachment_paths')='array' then jsonb_array_length(to_jsonb(t)->'context_payload'->'attachment_paths')>0 else false end
  ),'messages',messages,'has_more',has_more,'before_message_id',case when has_more then oldest else null end);
end $$;

revoke all on function public.support_customer_actor(uuid,uuid,uuid,boolean,uuid) from public,anon,authenticated;
revoke all on function public.support_list_customer_tickets(uuid) from public,anon,authenticated;
revoke all on function public.support_read_customer_ticket(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.support_customer_actor(uuid,uuid,uuid,boolean,uuid) to service_role;
grant execute on function public.support_list_customer_tickets(uuid) to service_role;
grant execute on function public.support_read_customer_ticket(uuid,uuid,uuid) to service_role;
commit;
