#!/usr/bin/env python3
"""Synthetic PostgreSQL regression for the exact context and publication SQL. No network/credentials."""
import json, os, subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BIN = Path('/opt/homebrew/opt/postgresql@17/bin')
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
A = '10000000-0000-4000-8000-000000000001'
B = '10000000-0000-4000-8000-000000000002'
T = '20000000-0000-4000-8000-000000000001'
R = '20000000-0000-4000-8000-000000000002'
U = '20000000-0000-4000-8000-000000000003'
X = '20000000-0000-4000-8000-000000000004'
VERSION = '2026-09-19T12:00:00+00:00'
checks = []
def check(name, okay):
    if not okay: raise AssertionError(name)
    checks.append(name)
def js(expression):
    source = "import {targetSQL,historySQL,messagesSQL,continuationSQL,queueSQL} from './scripts/ticket-agent-context.mjs';import {replySQL} from './scripts/ticket-agent-isolated.mjs';console.log(JSON.stringify(" + expression + "));"
    return json.loads(subprocess.check_output(['node','--input-type=module','-e',source],cwd=ROOT,text=True,env=ENV))
with tempfile.TemporaryDirectory(prefix='ticket-context-pg-') as tmp:
    folder=Path(tmp);sock=folder/'sock';sock.mkdir()
    def run(*args,**kw):return subprocess.run([str(x) for x in args],text=True,capture_output=True,env=ENV,**kw)
    init=run(BIN/'initdb','-D',folder/'data','-U','postgres','--auth=trust','--no-locale','--encoding=UTF8')
    if init.returncode:raise RuntimeError(init.stderr)
    start=run(BIN/'pg_ctl','-D',folder/'data','-l',folder/'log','-o',f"-k {sock} -p 56431 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",'-w','start')
    if start.returncode:raise RuntimeError(start.stderr)
    def sql(text):
        p=run(BIN/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','56431','-U','postgres','-d','postgres',input="set time zone 'UTC';"+text)
        if p.returncode:raise RuntimeError(p.stderr)
        return p.stdout.strip()
    def rows(query):
        assert query.startswith('begin read only; ') and query.endswith('; rollback;')
        inner=query[len('begin read only; '):-len('; rollback;')]
        return json.loads(sql("begin read only; select coalesce(json_agg(x),'[]'::json) from ("+inner+") x; rollback;"))
    def reply(version=VERSION):return js(f"replySQL({{id:'{T}',owner_id:'{A}',updated_at:'{version}'}},'Your earlier answer is recorded.')")
    try:
        sql(f"""
        create table profiles(id uuid primary key);
        create table support_tickets(id uuid primary key,user_id uuid references profiles(id),subject text,body text,status text,created_at timestamptz,updated_at timestamptz,archived_at timestamptz,agent_last_reply_at timestamptz,agent_approved_at timestamptz,context_payload jsonb);
        create table support_messages(id uuid primary key,ticket_id uuid references support_tickets(id),author_id uuid references profiles(id),body text,is_admin_reply boolean,created_at timestamptz,attachment_path text,attachment_paths text[]);
        create function is_admin(uuid) returns boolean language sql stable as $$select false$$;
        create function bump_ticket() returns trigger language plpgsql as $$begin update support_tickets set updated_at=now() where id=new.ticket_id;return new;end$$;
        create trigger bump after insert on support_messages for each row execute function bump_ticket();
        insert into profiles values('{A}'),('{B}');
        insert into support_tickets values
          ('{T}','{A}','References','Question about contact import','open','2026-09-01','{VERSION}',null,null,now(),'{{}}'),
          ('{R}','{A}','Add button','Earlier related report','resolved','2026-09-01','{VERSION}',now(),now(),null,'{{}}'),
          ('{U}','{A}','Unapproved','Read only related context','closed','2026-09-01','{VERSION}',null,null,null,'{{}}'),
          ('{X}','{B}','Other customer','Must not enter history','open','2026-09-01','{VERSION}',null,null,now(),'{{}}');
        insert into support_messages values
          ('30000000-0000-4000-8000-000000000001','{R}','{A}','Yes the Add button works',false,'2026-09-18',null,null),
          ('30000000-0000-4000-8000-000000000002','{R}','{A}','Claimed fixed by legacy support',true,'2026-09-18','tickets/{R}/proof.pdf',null);
        """)
        target=rows(js(f"targetSQL('{T}')"));check('approved target selected',len(target)==1 and target[0]['id']==T)
        check('unapproved ticket cannot become action target',rows(js(f"targetSQL('{U}')"))==[])
        history=rows(js(f"historySQL('{A}')"))
        check('same-customer history includes resolved archive and closed/unapproved context',set(x['id'] for x in history)=={T,R,U})
        check('other customer excluded',all(x['id']!=X for x in history))
        page=rows(js(f"historySQL('{A}',{{id:'{R}',created_at:'2026-09-01T00:00:00Z'}})"))
        check('equal-timestamp cursor advances by ID without duplicates',[x['id'] for x in page]==[U])
        messages=rows(js(f"messagesSQL('{R}')"))
        check('customer confirmation and old support claim both retained',len(messages)==2 and messages[0]['is_admin_reply'] is False and messages[1]['is_admin_reply'] is True)
        check('legacy schema without service-actor columns reads safely',messages[0]['support_actor_id'] is None)
        check('attachment reference retained without signing or downloading',messages[1]['attachment_path']==f'tickets/{R}/proof.pdf')
        approved_at=target[0]['agent_approved_at']
        pending={'target_id':T,'owner_id':A,'approval':{'from_admin':False,'approved_at':approved_at}}
        continuation=js('continuationSQL('+json.dumps(pending)+')')
        sql(f"update support_tickets set agent_last_reply_at=now() where id='{T}'")
        check('stamped ticket with no new customer message leaves reply queue',all(x['id']!=T for x in rows(js('queueSQL()'))))
        check('same approved open case remains eligible for internal continuation',len(rows(continuation))==1)
        sql(f"update support_tickets set user_id='{B}' where id='{T}'")
        check('changed recipient suppresses saved continuation',rows(continuation)==[])
        check('changed recipient cannot receive a captured reply even without version bump',sql(reply())=='')
        sql(f"update support_tickets set user_id='{A}',status='resolved' where id='{T}'")
        check('resolved target suppresses continuation',rows(continuation)==[])
        sql(f"update support_tickets set status='open',archived_at=now() where id='{T}'")
        check('archived target suppresses continuation',rows(continuation)==[])
        sql(f"update support_tickets set archived_at=null,agent_approved_at=agent_approved_at+interval '1 second' where id='{T}'")
        check('a different approval does not revive an old internal continuation',rows(continuation)==[])
        sql(f"update support_tickets set agent_approved_at='{approved_at}',agent_last_reply_at=null where id='{T}'")
        sql(f"update support_tickets set agent_approved_at=null where id='{T}'")
        check('withdrawn approval suppresses continuation',rows(continuation)==[])
        check('withdrawn approval prevents reply',sql(reply())=='')
        sql(f"update support_tickets set agent_approved_at=now(),updated_at='2026-09-19T12:01:00Z' where id='{T}'")
        check('newer target input prevents stale reply',sql(reply())=='')
        sql(f"update support_tickets set updated_at='{VERSION}' where id='{T}'")
        result=sql(reply());check('current approved target can receive exactly one reply',len(result)==36)
        stored=json.loads(sql(f"select row_to_json(x) from (select body,author_id from support_messages where id='{result}')x"))
        check('legacy-compatible reply explicitly labels automation',stored['body'].startswith('CredentialDO Support · Automated\n\n'))
        check('no fabricated actor identity or new schema dependency',stored['author_id']==A)
        check('after-insert bump and host stamp coexist',sql(f"select status||'|'||(agent_last_reply_at is not null)::text from support_tickets where id='{T}'")=='open|true')
        check('same stale envelope cannot duplicate reply',sql(reply())=='')
        check('related context never gets a new reply',sql(f"select count(*) from support_messages where ticket_id='{R}'")=='2')
        check('no other customer changed',sql(f"select count(*) from support_messages where ticket_id='{X}'")=='0')
        print(f'{len(checks)} synthetic PostgreSQL checks passed')
        for name in checks:print('  ok '+name)
    finally:
        stop=run(BIN/'pg_ctl','-D',folder/'data','-m','immediate','-w','stop')
        if stop.returncode:raise RuntimeError('Temporary PostgreSQL failed to stop')
