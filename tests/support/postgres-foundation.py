#!/usr/bin/env python3
"""Exact support migration on disposable PostgreSQL 17. Private socket; no TCP."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import uuid

BIN = Path('/opt/homebrew/opt/postgresql@17/bin')
MIGRATION = Path(__file__).resolve().parents[2] / 'supabase/migrations/20260918090000_autonomous_support_foundation.sql'
READ_MIGRATION = Path(__file__).resolve().parents[2] / 'supabase/migrations/20260918092000_support_customer_read.sql'
NOTIFIER = Path(__file__).resolve().parents[2] / 'scripts/signup-notify.sh'
# Parse only the exact reply-selection predicate; never execute the notifier,
# which has production credential and outbound messaging access.
NOTIFY_REPLY = re.search(r"union all select 'TICKET REPLY'.*?\n  (where .*?)(?=\nunion all)", NOTIFIER.read_text(), re.S)
if not NOTIFY_REPLY: raise AssertionError('Notifier reply predicate was not found')
NOTIFY_REPLY = NOTIFY_REPLY.group(1).replace('$SINCE', '2026-09-17T00:00:00Z')
ENV = {k:v for k,v in os.environ.items() if not k.startswith('PG')}
checks = []
A='10000000-0000-4000-8000-000000000001'
B='10000000-0000-4000-8000-000000000002'
OWNER='10000000-0000-4000-8000-000000000003'
FWD='20000000-0000-4000-8000-000000000001'
UNVERIFIED='20000000-0000-4000-8000-000000000002'
ACTOR='00000000-0000-4000-8000-000000000018'
def q(value):
    if value is None: return 'NULL'
    if isinstance(value,bool): return str(value).lower()
    if isinstance(value,(int,float)): return str(value)
    if isinstance(value,dict): return "'"+json.dumps(value).replace("'","''")+"'::jsonb"
    return "'"+str(value).replace("'","''")+"'"
def check(name,passed):
    if not passed: raise AssertionError(name)
    checks.append(name)

with tempfile.TemporaryDirectory(prefix='support-foundation-') as temporary:
    root=Path(temporary); socket=root/'socket';socket.mkdir()
    def run(*args,**kw): return subprocess.run([str(a) for a in args],text=True,capture_output=True,env=ENV,**kw)
    init=run(BIN/'initdb','-D',root/'data','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8')
    if init.returncode: raise RuntimeError(init.stderr)
    started=run(BIN/'pg_ctl','-D',root/'data','-l',root/'server.log','-o',f"-k {socket} -p 56429 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",'-w','start')
    if started.returncode: raise RuntimeError(started.stderr+started.stdout)
    def sql(text,okay=True,role=None,sub=None):
        if role: text=f"BEGIN; SET LOCAL ROLE {role}; SET LOCAL request.jwt.claims={q(json.dumps({'sub':sub,'role':role}))}; {text}; COMMIT;"
        result=run(BIN/'psql','-X','-v','ON_ERROR_STOP=1','-qAt','-h',socket,'-p','56429','-U','postgres','-d','postgres',input=text)
        if okay and result.returncode: raise RuntimeError(result.stderr)
        return result
    def call(name,*args,okay=True,role='service_role'):
        result=sql(f"select public.{name}({','.join(q(a) for a in args)})",okay=okay,role=role)
        if not okay: return result
        text=result.stdout.strip()
        return json.loads(text) if text.startswith(('{','[')) else text
    def ticket(profile=A,body='is billing enabled?'):
        tid=str(uuid.uuid4());sql(f"insert into support_tickets(id,user_id,subject,body) values({q(tid)},{q(profile)},'Synthetic support',{q(body)})")
        return tid
    def message(tid,profile=A,body='Follow-up question'):
        mid=str(uuid.uuid4());sql(f"insert into support_messages(id,ticket_id,author_id,body) values({q(mid)},{q(tid)},{q(profile)},{q(body)})")
        return mid
    def complete(job,knowledge=None,revision=None): return call('support_complete_job',job['id'],job['token'],knowledge,revision)
    def clear_pending(): sql("update support_jobs set state='superseded',lease_token=null,lease_until=null where state in ('queued','running','retry')")
    def response():
        clear_pending(); tid=ticket();call('support_ingest',tid,None);job=call('support_claim_job','receipt');result=complete(job)
        return tid,job,result
    def begin_mail():
        tid,job,result=response();claim=call('support_claim_outbox');check('outbox helper claims only queued mail',claim['state']=='claimed')
        envelope=call('support_begin_send',claim['id'],claim['token']);check('outbox helper starts one submission',envelope['state']=='sending')
        return envelope
    try:
        sql(f"""
          create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
          create schema auth;grant usage on schema auth to authenticated,service_role;
          create function auth.jwt() returns jsonb language sql stable as $$select coalesce(current_setting('request.jwt.claims',true),'{{}}')::jsonb$$;
          create table profiles(id uuid primary key,auth_user_id text unique,email text,access_status text);
          create table app_admins(profile_id uuid primary key references profiles(id));
          create table forwarding_addresses(id uuid primary key,user_id uuid references profiles(id),email text,verified_at timestamptz);
          create table support_tickets(id uuid primary key default gen_random_uuid(),user_id uuid references profiles(id) not null,subject text not null,body text not null,category text default 'other',priority text default 'normal',status text default 'open',created_at timestamptz default now(),updated_at timestamptz default now(),archived_at timestamptz,resolved_at timestamptz,context_payload jsonb);
          create table support_messages(id uuid primary key default gen_random_uuid(),ticket_id uuid not null references support_tickets(id) on delete cascade,author_id uuid not null references profiles(id),body text not null,is_admin_reply boolean not null default false,created_at timestamptz default now(),attachment_path text,attachment_paths text[]);
          create table feedback(id uuid primary key,user_id uuid references profiles(id),message text);
          create function current_profile_id() returns uuid language sql stable as $$select id from profiles where auth_user_id=auth.jwt()->>'sub'$$;
          create function is_admin(id uuid) returns boolean language sql stable as $$select exists(select 1 from app_admins where profile_id=id)$$;
          create table legacy_send_calls(id uuid);
          create function legacy_notify() returns trigger language plpgsql as $$declare owner_id uuid;begin if not public.is_admin(new.author_id) then return new; end if;select user_id into owner_id from support_tickets where id=new.ticket_id;if owner_id is null or owner_id=new.author_id then return new;end if;insert into legacy_send_calls values(new.id);return new;end$$;
          create trigger old_notify after insert on support_messages for each row execute function legacy_notify();
          create function legacy_bump() returns trigger language plpgsql as $$begin update support_tickets set updated_at=now() where id=new.ticket_id;return new;end$$;
          create trigger old_bump after insert on support_messages for each row execute function legacy_bump();
          insert into profiles values({q(A)},'user_a','editable@example.com','active'),({q(B)},'user_b','other@example.com','active'),({q(OWNER)},'user_owner','owner@example.com','active');
          insert into app_admins values({q(OWNER)});
          insert into forwarding_addresses values({q(FWD)},{q(A)},'verified@example.com','2026-09-18T00:00:00Z'),({q(UNVERIFIED)},{q(B)},'unverified@example.com',null);
          alter table support_tickets enable row level security;
          alter table support_messages enable row level security;
          create policy own_tickets on support_tickets for all to authenticated using(user_id=current_profile_id()) with check(user_id=current_profile_id());
          create policy own_messages on support_messages for all to authenticated using(exists(select 1 from support_tickets where id=ticket_id and user_id=current_profile_id())) with check(author_id=current_profile_id());
          grant select on profiles,app_admins to authenticated;
          grant select,insert,update on support_tickets,support_messages to authenticated;
          grant all on all tables in schema public to service_role;
        """)
        legacy=ticket();message(legacy)
        check('live-shaped legacy notify preflight requires is_admin null to be false',sql('select public.is_admin(null::uuid) is false').stdout.strip()=='t')
        notify_legacy=sql(f"""with m(label,author_id,created_at) as (values
          ('customer',{q(A)}::uuid,'2026-09-18T01:00:00Z'::timestamptz),
          ('old customer',{q(A)}::uuid,'2026-09-16T01:00:00Z'::timestamptz),
          ('admin',{q(OWNER)}::uuid,'2026-09-18T01:00:00Z'::timestamptz),
          ('null author',null::uuid,'2026-09-18T01:00:00Z'::timestamptz))
          select label from m {NOTIFY_REPLY} order by label""").stdout.strip()
        check('exact notifier predicate preserves customer replies before service columns exist',notify_legacy=='customer')
        notify_new=sql(f"""with m(label,author_id,created_at,support_actor_id) as (values
          ('customer',{q(A)}::uuid,'2026-09-18T01:00:00Z'::timestamptz,null::uuid),
          ('old customer',{q(A)}::uuid,'2026-09-16T01:00:00Z'::timestamptz,null::uuid),
          ('admin',{q(OWNER)}::uuid,'2026-09-18T01:00:00Z'::timestamptz,null::uuid),
          ('service',null::uuid,'2026-09-18T01:00:00Z'::timestamptz,{q(ACTOR)}::uuid),
          ('malformed service',{q(A)}::uuid,'2026-09-18T01:00:00Z'::timestamptz,{q(ACTOR)}::uuid),
          ('null author',null::uuid,'2026-09-18T01:00:00Z'::timestamptz,null::uuid))
          select label from m {NOTIFY_REPLY} order by label""").stdout.strip()
        check('exact notifier predicate excludes service and null authors after service columns exist',notify_new=='customer')
        sql(MIGRATION.read_text());sql(MIGRATION.read_text())
        failed_read=sql(READ_MIGRATION.read_text().replace('\ncommit;','\nselect 1/0;\ncommit;'),okay=False)
        check('read migration rolls back all exposed functions if final setup fails',failed_read.returncode!=0 and sql("select to_regprocedure('public.support_customer_actor(uuid,uuid,uuid,boolean,uuid)') is null").stdout.strip()=='t')
        sql(READ_MIGRATION.read_text());sql(READ_MIGRATION.read_text())
        check('migration applies twice with legacy conversation preserved',sql('select count(*) from support_messages').stdout.strip()=='1')
        check('disabled default blocks job claim',call('support_claim_job','answer')['state']=='disabled')
        check('disabled default blocks outbox claim',call('support_claim_outbox')['state']=='disabled')
        rid=str(uuid.uuid4());first=call('support_submit',A,rid,None,'A real question','is billing enabled?','other')
        check('atomic new-ticket intake creates source record plus jobs',first['state']=='queued' and first['message_id'] is None and sql(f"select count(*) from support_jobs where ticket_id={q(first['ticket_id'])}").stdout.strip()=='2')
        check('client request ID prevents duplicate ticket creation',call('support_submit',A,rid,None,'A real question','is billing enabled?','other')['duplicate'])
        check('changed payload cannot reuse client request ID',call('support_submit',A,rid,None,'A real question','A different issue','other',okay=False).returncode!=0)
        check('customer cannot reply to another owner ticket',call('support_submit',B,str(uuid.uuid4()),first['ticket_id'],None,'An unauthorized reply','other',okay=False).returncode!=0)
        replyid=str(uuid.uuid4());sql(f"update support_tickets set status='resolved',archived_at=clock_timestamp() where id={q(first['ticket_id'])}")
        follow=call('support_submit',A,replyid,first['ticket_id'],None,'A follow-up','other')
        check('atomic reply reopens archive and assigns exact sequence',follow['input_seq']==2 and sql(f"select status||'|'||(archived_at is null)::text from support_tickets where id={q(first['ticket_id'])}").stdout.strip()=='open|true')
        check('replayed reply request creates no duplicate message',call('support_submit',A,replyid,first['ticket_id'],None,'A follow-up','other')['duplicate'])
        raceid=str(uuid.uuid4());intake_barrier=threading.Barrier(12)
        def intake_race(_):
            intake_barrier.wait();return call('support_submit',A,raceid,None,'Concurrent question','How do I get help?','other')
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool: intake_results=list(pool.map(intake_race,range(12)))
        check('12 simultaneous submissions create one ticket and source event',len(set(r['ticket_id'] for r in intake_results))==1 and sum(not r['duplicate'] for r in intake_results)==1)
        for category in ['bug','billing','feature_request','data_issue','compliance','other','feedback','idea']:
            created=call('support_submit',A,str(uuid.uuid4()),None,'Category check','A valid support question',category)
            canonical={'feedback':'other','idea':'feature_request'}.get(category,category)
            check('transactional intake preserves category '+category,sql(f"select category from support_tickets where id={q(created['ticket_id'])}").stdout.strip()==canonical)
        check('unrecognized role-like categories remain rejected',call('support_submit',A,str(uuid.uuid4()),None,'Category check','A valid support question','admin',okay=False).returncode!=0)
        for priority in ['low','normal','high','urgent']:
            created=call('support_submit',A,str(uuid.uuid4()),None,'Priority check','A valid support question','other',priority)
            check('transactional intake preserves priority '+priority,sql(f"select priority from support_tickets where id={q(created['ticket_id'])}").stdout.strip()==priority)
        check('priority cannot confer approval privileges',call('support_submit',A,str(uuid.uuid4()),None,'Priority check','A valid support question','other','approved',okay=False).returncode!=0)
        before=sql('select count(*) from support_tickets').stdout.strip();rollback_id=str(uuid.uuid4())
        sql("create function reject_support_job() returns trigger language plpgsql as $$begin raise exception 'Synthetic enqueue failure';end$$; create trigger reject_support_job before insert on support_jobs for each row execute function reject_support_job()")
        failed=call('support_submit',A,rollback_id,None,'Rollback check','This must not partially persist','other',okay=False)
        check('queue failure rolls back customer ticket and idempotency record together',failed.returncode!=0 and sql('select count(*) from support_tickets').stdout.strip()==before and sql(f"select count(*) from support_intake_requests where request_id={q(rollback_id)}").stdout.strip()=='0')
        sql('drop trigger reject_support_job on support_jobs;drop function reject_support_job()')
        cap_id=str(uuid.uuid4());call('support_submit',B,cap_id,None,'Rate cap check','A valid support question','other')
        for _ in range(16): call('support_submit',B,str(uuid.uuid4()),None,'Rate cap check','A valid support question','other')
        cap_barrier=threading.Barrier(12)
        def cap_race(_):
            cap_barrier.wait();return call('support_submit',B,str(uuid.uuid4()),None,'Rate cap check','A valid support question','other',okay=False).returncode
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool: cap_results=list(pool.map(cap_race,range(12)))
        check('concurrent distinct requests cannot exceed twenty per hour',sum(code==0 for code in cap_results)==3 and sql(f"select count(*) from support_intake_requests where profile_id={q(B)}").stdout.strip()=='20')
        check('idempotent replay remains available at admission cap',call('support_submit',B,cap_id,None,'Rate cap check','A valid support question','other')['duplicate'])
        sql(f"update support_intake_requests set created_at=clock_timestamp()-interval '2 hours' where profile_id={q(B)};insert into support_intake_requests(profile_id,request_id,request_hash,created_at) select {q(B)},gen_random_uuid(),'synthetic',clock_timestamp()-interval '2 hours' from generate_series(1,40)")
        check('daily cap cannot be bypassed after hourly window expires',call('support_submit',B,str(uuid.uuid4()),None,'Rate cap check','A valid support question','other',okay=False).returncode!=0)
        # Subsequent worker tests isolate a separate input; retain source rows.
        clear_pending()
        tid=ticket();ingested=call('support_ingest',tid,None)
        check('transactional intake queues canonical existing ticket',ingested['state']=='queued' and ingested['mode']=='disabled')
        check('same canonical intake is idempotent',call('support_ingest',tid,None)['state']=='duplicate')
        check('one initial ticket creates receipt and answer jobs',sql(f"select count(*) from support_jobs where ticket_id={q(tid)}").stdout.strip()=='2')
        sql(f"update support_tickets set body='Changed input' where id={q(tid)}")
        check('changed content under same source ID conflicts',call('support_ingest',tid,None,okay=False).returncode!=0)
        sql(f"update support_tickets set body='is billing enabled?' where id={q(tid)}")
        other=ticket(B);foreign=message(other,B)
        check('foreign message cannot attach to another ticket',call('support_ingest',tid,foreign,okay=False).returncode!=0)
        for role in ['anon','authenticated']:
            check(role+' cannot ingest or claim jobs',call('support_ingest',tid,None,okay=False,role=role).returncode!=0 and call('support_claim_job','answer',okay=False,role=role).returncode!=0)
            check(role+' cannot view outbox/knowledge/approvals',all(sql(f'select * from {table}',okay=False,role=role,sub='user_a').returncode!=0 for table in ['support_outbox','support_knowledge','support_approvals']))
            check(role+' cannot change operation mode',sql("update support_operations_config set mode='active'",okay=False,role=role,sub='user_a').returncode!=0)
        sql("update support_operations_config set mode='shadow'")
        barrier=threading.Barrier(12)
        def contend(_): barrier.wait();return call('support_claim_job','receipt')
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:claims=list(pool.map(contend,range(12)))
        winner=next(j for j in claims if j['state']=='claimed')
        check('12 concurrent workers claim one receipt',sum(j['state']=='claimed' for j in claims)==1)
        check('wrong completion token is fenced',call('support_complete_job',winner['id'],str(uuid.uuid4()),None,None)['state']=='fenced')
        result=complete(winner);check('shadow completion is explicitly draft',result['state']=='draft' and result['message_id'] is None and result['email_state']=='draft')
        check('repeat completion does not duplicate draft/outbox',complete(winner)['state']=='duplicate' and sql('select count(*) from support_outbox').stdout.strip()=='1')
        check('shadow receipt creates no automated customer message or legacy email',sql('select count(*) from support_messages where support_actor_id is not null').stdout.strip()=='0' and sql('select count(*) from legacy_send_calls').stdout.strip()=='0')
        sql("insert into support_knowledge values('billing','v1',array['is billing enabled?'],'Billing is currently off.','https://credentialdomd.com/terms',true,'2030-01-01')")
        answer=call('support_claim_job','answer');check('approved exact answer can be drafted',complete(answer,'billing','v1')['kind']=='public_answer')
        tid2=ticket(body='Unknown issue');call('support_ingest',tid2,None);old=call('support_claim_job','answer')
        sql(f"update support_jobs set lease_until=clock_timestamp()-interval '1 second' where id={q(old['id'])}")
        newer=call('support_claim_job','answer');check('expired lease gets a different fencing token',old['id']==newer['id'] and old['token']!=newer['token'])
        check('late old answer cannot complete replacement lease',complete(old)['state']=='fenced')
        mid=message(tid2);event=call('support_ingest',tid2,mid)
        check('new customer message increments exact per-ticket sequence',event['input_seq']==2)
        check('newer input supersedes in-flight answer',complete(newer)['state']=='superseded')
        current=call('support_claim_job','answer');sql("update support_operations_config set policy_version='changed'")
        check('policy change fences in-flight publication',complete(current)['state']=='paused')
        sql("update support_operations_config set policy_version='support-2026-09-v1'")
        clear_pending();tid3=ticket();call('support_ingest',tid3,None);bad=call('support_claim_job','answer')
        check('unapproved answer revision cannot complete',call('support_complete_job',bad['id'],bad['token'],'billing','wrong',okay=False).returncode!=0)
        sql(f"update support_jobs set attempts=5,lease_until=clock_timestamp()-interval '1 second' where id={q(bad['id'])}")
        call('support_claim_job','answer');check('exhausted attempts become visible dead letter',sql(f"select state from support_jobs where id={q(bad['id'])}").stdout.strip()=='dead')
        check('publication cannot enable without canary',sql("update support_operations_config set mode='active',publication_enabled=true",okay=False).returncode!=0)
        sql("update support_operations_config set mode='active',publication_enabled=true,outbound_enabled=true,canary_verified_at=clock_timestamp()")
        automated_ticket,job,result=response();check('missing verified recipient suppresses mail',result['state']=='published' and result['email_state']=='suppressed')
        check('automation uses service actor with no physician author',sql(f"select (author_id is null and support_actor_id={q(ACTOR)} and is_admin_reply)::text from support_messages where support_job_id={q(job['id'])}").stdout.strip()=='true')
        check('new automated reply does not trigger old admin mail sender',sql('select count(*) from legacy_send_calls').stdout.strip()=='0')
        check('exact notifier predicate does not select an actual published automated message',sql(f"select count(*) from support_messages m {NOTIFY_REPLY} and m.support_job_id={q(job['id'])}").stdout.strip()=='0')
        forge=f"insert into support_messages(ticket_id,author_id,body,is_admin_reply,support_actor_id,support_job_id) values({q(tid)},null,'forged',true,{q(ACTOR)},{q(job['id'])})"
        check('ordinary authenticated client cannot forge automation actor',sql(forge,okay=False,role='authenticated',sub='user_a').returncode!=0)
        check('ordinary client cannot remove actor metadata',sql(f"update support_messages set support_actor_id=null,support_job_id=null,author_id={q(A)} where support_job_id={q(job['id'])}",okay=False,role='authenticated',sub='user_a').returncode!=0)
        check('ordinary client cannot insert null author',sql(f"insert into support_messages(ticket_id,author_id,body) values({q(tid)},null,'forged')",okay=False,role='authenticated',sub='user_a').returncode!=0)
        unused=sql("select id from support_jobs where id not in (select support_job_id from support_messages where support_job_id is not null) limit 1").stdout.strip()
        check('service role cannot persist a null-valued malformed actor shape',sql(f"insert into support_messages(ticket_id,author_id,body,is_admin_reply,support_actor_id,support_job_id) values({q(tid)},null,'Malformed service identity',true,null,{q(unused)})",okay=False,role='service_role').returncode!=0)
        customer_reply=message(automated_ticket,A,'Customer reply');message(automated_ticket,OWNER,'Support account reply')
        check('exact notifier predicate still selects an actual customer follow-up',sql(f"select count(*) from support_messages m {NOTIFY_REPLY} and m.id={q(customer_reply)}").stdout.strip()=='1')
        sql(f"insert into support_messages(ticket_id,author_id,body,is_admin_reply) values({q(automated_ticket)},{q(A)},'Historical or forged admin flag',true)")
        read=call('support_read_customer_ticket',A,automated_ticket,None)
        check('protected reader distinguishes automated, customer, support and ambiguous legacy authors',set(m['actor_kind'] for m in read['messages'])=={'automated','you','support','account'})
        check('reader exposes no editable author email or provider envelope',all('author_email' not in m and 'recipient' not in m and 'provider_message_id' not in m for m in read['messages']))
        check('another customer and an admin cannot read a foreign ticket through customer endpoint',not call('support_read_customer_ticket',B,automated_ticket,None) and not call('support_read_customer_ticket',OWNER,automated_ticket,None))
        mine=call('support_list_customer_tickets',A)['tickets']
        check('customer ticket listing is owner scoped',all(sql(f"select user_id={q(A)} from support_tickets where id={q(t['id'])}").stdout.strip()=='t' for t in mine))
        check('foreign message cannot serve as a pagination cursor',not call('support_read_customer_ticket',A,automated_ticket,foreign))
        first_read=call('support_read_customer_ticket',A,first['ticket_id'],None)
        check('read contract includes committed request IDs for lost-acknowledgement reconciliation',first_read['ticket']['request_id']==rid and any(m['request_id']==replyid for m in first_read['messages']))
        paged=ticket();sql(f"insert into support_messages(ticket_id,author_id,body,created_at) select {q(paged)},{q(A)},'Message '||n,'2026-01-01' from generate_series(1,105) n")
        page_one=call('support_read_customer_ticket',A,paged,None);page_two=call('support_read_customer_ticket',A,paged,page_one['before_message_id'])
        check('message pagination handles identical timestamps without gaps or repeats',len(page_one['messages'])==100 and len(page_two['messages'])==5 and not page_two['has_more'] and len({m['id'] for m in page_one['messages']+page_two['messages']})==105)
        for role in ['anon','authenticated']:
            check(role+' cannot select service read identity or bypass reader authorization',call('support_read_customer_ticket',A,automated_ticket,None,okay=False,role=role).returncode!=0 and call('support_list_customer_tickets',A,okay=False,role=role).returncode!=0)
        check('unverified mailbox cannot be bound',call('support_bind_mailbox',B,UNVERIFIED,okay=False).returncode!=0)
        check('another profile cannot bind verified mailbox',call('support_bind_mailbox',B,FWD,okay=False).returncode!=0)
        call('support_bind_mailbox',A,FWD)
        _,_,result=response();claim=call('support_claim_outbox');sql(f"update forwarding_addresses set verified_at=null where id={q(FWD)}")
        check('revoked mailbox suppresses send immediately before provider call',call('support_begin_send',claim['id'],claim['token'])['state']=='suppressed')
        sql(f"update forwarding_addresses set verified_at='2026-09-18T00:00:00Z' where id={q(FWD)}")
        paused_ticket,_,_=response();paused_claim=call('support_claim_outbox');sql(f"update support_ticket_state set paused=true where ticket_id={q(paused_ticket)}")
        check('pause suppresses an already queued response before provider submission',call('support_begin_send',paused_claim['id'],paused_claim['token'])['state']=='suppressed')
        stale_ticket,_,_=response();stale_claim=call('support_claim_outbox');new_input=message(stale_ticket);call('support_ingest',stale_ticket,new_input)
        check('new customer input suppresses a stale queued email',call('support_begin_send',stale_claim['id'],stale_claim['token'])['state']=='suppressed')
        closed_ticket,_,_=response();closed_claim=call('support_claim_outbox');sql(f"update support_tickets set status='resolved' where id={q(closed_ticket)}")
        check('customer resolution suppresses queued mail and new job claims',call('support_begin_send',closed_claim['id'],closed_claim['token'])['state']=='suppressed' and call('support_claim_job','answer')['state']=='idle')
        e=begin_mail();check('server recipient comes from verified binding, not editable profile',e['recipient']=='verified@example.com')
        check('stable idempotency key bound to outbox',e['idempotency_key']=='support/'+e['id'])
        check('one leased send cannot start twice',call('support_begin_send',e['id'],claim['token'])['state']=='fenced')
        check('timeout becomes unknown',call('support_finish_send',e['id'],e['attempt_id'],'unknown',None)=='unknown')
        check('unknown is never automatically retried',call('support_claim_outbox')['state']=='idle')
        check('late provider acceptance reconciles original unknown attempt',call('support_finish_send',e['id'],e['attempt_id'],'accepted','provider_a')=='accepted')
        check('accepted is not delivered',sql(f"select state from support_outbox where id={q(e['id'])}").stdout.strip()=='accepted')
        check('duplicate completion does not change provider identity',call('support_finish_send',e['id'],e['attempt_id'],'accepted','provider_a')=='duplicate')
        check('different acceptance ID is rejected',call('support_finish_send',e['id'],e['attempt_id'],'accepted','other',okay=False).returncode!=0)
        check('signed delivery can be recorded',call('support_record_receipt','evt_delivery',e['id'],'provider_a','delivered')=='recorded')
        check('provider receipt replay is idempotent',call('support_record_receipt','evt_delivery',e['id'],'provider_a','delivered')=='duplicate')
        call('support_record_receipt','evt_bounce',e['id'],'provider_a','bounced');call('support_record_receipt','evt_late_sent',e['id'],'provider_a','accepted')
        check('late accepted receipt cannot erase bounce',sql(f"select state from support_outbox where id={q(e['id'])}").stdout.strip()=='bounced')
        _,_,_=response();claim=call('support_claim_outbox');check('bounced address suppresses future email',call('support_begin_send',claim['id'],claim['token'])['state']=='suppressed')
        # Reset only this synthetic bounce to exercise another independent provider failure.
        sql(f"update support_outbox set state='delivered' where id={q(e['id'])}")
        e2=begin_mail();sql(f"update support_outbox set lease_until=clock_timestamp()-interval '1 second' where id={q(e2['id'])}")
        check('crashed sending lease is quarantined as unknown',call('support_claim_outbox')['state']=='idle' and sql(f"select state from support_outbox where id={q(e2['id'])}").stdout.strip()=='unknown')
        check('provider receipt recovers unknown send without response ID',call('support_record_receipt','evt_recover',e2['id'],'provider_b','delivered')=='recorded')
        check('same receipt ID cannot be rebound to another outbox',call('support_record_receipt','evt_delivery',e2['id'],'provider_b','delivered',okay=False).returncode!=0)
        check('old send attempt cannot settle other outbox',call('support_finish_send',e2['id'],e['attempt_id'],'accepted','forged')=='fenced')
        approval=call('support_request_approval',tid,'refund_payment',{'paymentId':'pi_test','amountMinor':14900})
        check('approval request retries reuse same action',call('support_request_approval',tid,'refund_payment',{'paymentId':'pi_test','amountMinor':14900})==approval)
        check('customer cannot approve by matching editable owner email',call('support_decide_approval',approval,'user_a',True,okay=False).returncode!=0)
        check('real server-bound owner can approve',call('support_decide_approval',approval,'user_owner',True)=='approved')
        fingerprint=sql(f"select action_hash from support_approvals where id={q(approval)}").stdout.strip()
        check('approval requires exact action and capability including nonnull values',all(call('support_claim_approval',approval,cap,h)['state']=='denied' for cap,h in [('release_code',fingerprint),('refund_payment','wrong'),('refund_payment',None),(None,fingerprint)]))
        execution=call('support_claim_approval',approval,'refund_payment',fingerprint)
        check('approval consumed once',execution['state']=='claimed' and call('support_claim_approval',approval,'refund_payment',fingerprint)['state']=='denied')
        check('financial unknown cannot trigger a second execution',call('support_settle_approval',execution['execution_id'],'unknown',None)=='unknown' and call('support_claim_approval',approval,'refund_payment',fingerprint)['state']=='denied')
        check('success requires provider evidence',call('support_settle_approval',execution['execution_id'],'succeeded',None,okay=False).returncode!=0)
        check('same uncertain execution may reconcile evidence later',call('support_settle_approval',execution['execution_id'],'succeeded','refund_provider_id')=='succeeded')
        approval2=call('support_request_approval',tid,'change_access',{'profileId':A,'change':'active'})
        call('support_decide_approval',approval2,'user_owner',True)
        fingerprint2=sql(f"select action_hash from support_approvals where id={q(approval2)}").stdout.strip();sql(f"delete from app_admins where profile_id={q(OWNER)}")
        check('revoked owner authority cannot execute prior approval',call('support_claim_approval',approval2,'change_access',fingerprint2)['state']=='denied')
        sql('delete from support_operations_config')
        check('missing configuration fails closed for jobs and email',call('support_claim_job','answer')['state']=='disabled' and call('support_claim_outbox')['state']=='disabled')
        print(json.dumps({'migrationSHA256':hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),'readMigrationSHA256':hashlib.sha256(READ_MIGRATION.read_bytes()).hexdigest(),'passed':len(checks),'checks':checks},indent=2))
    finally:
        stopped=run(BIN/'pg_ctl','-D',root/'data','-m','fast','-w','stop')
        if stopped.returncode: raise RuntimeError(stopped.stderr)
