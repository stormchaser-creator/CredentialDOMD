#!/usr/bin/env python3
"""Full legacy shell path with synthetic credentials/model and local PostgreSQL only.

The copied shell changes only its fixed repository/log/lock/CLI/state paths. Its
node entry points, queue, context, assessment and SQL writer are the real sources.
No installed model CLI, Keychain command, HTTP client or production worker runs.
"""
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PG = Path(os.environ.get('PG_BIN') or '/opt/homebrew/opt/postgresql@17/bin')
MIGRATION = (ROOT / 'supabase' / 'migrations' / '20260928150000_support_reply_verifications.sql').read_text()
# Supabase's Vault and pgcrypto, reduced to what the verification migration uses.
PLATFORM = '''
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema extensions; create extension pgcrypto with schema extensions;
create schema vault;
create table vault.secrets(id uuid primary key default gen_random_uuid(),name text unique,description text not null default '',secret text not null);
create view vault.decrypted_secrets as select id,name,description,secret,secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text,new_name text default null,new_description text default '',new_key_id uuid default null)
  returns uuid language sql as $$insert into vault.secrets(secret,name,description) values(new_secret,new_name,new_description) returning id$$;
'''
NODE = Path(shutil.which('node')).resolve()
FIXTURES = ROOT / 'scripts' / 'ticket-agent-hostpath-fixtures'
A = '10000000-0000-4000-8000-000000000001'
B = '10000000-0000-4000-8000-000000000002'
T = '20000000-0000-4000-8000-000000000001'
R = '20000000-0000-4000-8000-000000000002'
X = '20000000-0000-4000-8000-000000000004'
VERSION = '2026-09-19T12:00:00+00:00'
checks = []


def check(name, okay, detail=None):
    if not okay:
        raise AssertionError(name if detail is None else f'{name}: {detail}')
    checks.append(name)


def write(filename, content, mode=0o600):
    filename.write_text(content)
    filename.chmod(mode)


def quoted(value):
    return "'" + str(value).replace("'", "'\\''") + "'"


with tempfile.TemporaryDirectory(prefix='support-hostpath-', dir='/private/tmp') as tmp:
    folder = Path(tmp)
    folder.chmod(0o700)
    sock = folder / 'sock'
    sock.mkdir(mode=0o700)
    # An allowlist prevents inherited provider, database and Node preload settings.
    env = {'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'TMPDIR': str(folder), 'LC_ALL': 'C',
           'SUPPORT_FIXTURE_ROOT': str(ROOT), 'SUPPORT_FIXTURE_NODE': str(NODE),
           'SUPPORT_FIXTURE_PSQL': str(PG / 'psql'), 'SUPPORT_FIXTURE_SOCKET': str(sock)}

    def command(*args, **kwargs):
        return subprocess.run([str(a) for a in args], text=True, capture_output=True,
                              env=env, timeout=30, **kwargs)

    initialized = command(PG / 'initdb', '-D', folder / 'data', '-U', 'postgres',
                          '--auth=trust', '--no-locale', '--encoding=UTF8')
    if initialized.returncode:
        raise RuntimeError(initialized.stderr)
    started = command(PG / 'pg_ctl', '-D', folder / 'data', '-l', folder / 'postgres.log',
                      '-o', f"-k {sock} -p 56432 -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off",
                      '-w', 'start')
    if started.returncode:
        raise RuntimeError(started.stderr + (folder / 'postgres.log').read_text())

    def sql(statement):
        result = command(PG / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock,
                         '-p', '56432', '-U', 'postgres', '-d', 'postgres',
                         input="set time zone 'UTC';" + statement)
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout.strip()

    sql(PLATFORM)

    def reset(two_owners=False, approved=True, status='open'):
        sql(f"""
          drop schema public cascade; create schema public;
          create table profiles(id uuid primary key,is_admin boolean default false);
          create table support_tickets(id uuid primary key,user_id uuid references profiles(id),subject text,body text,status text,created_at timestamptz,updated_at timestamptz,archived_at timestamptz,agent_last_reply_at timestamptz,agent_approved_at timestamptz,context_payload jsonb);
          create table support_messages(id uuid primary key,ticket_id uuid references support_tickets(id),author_id uuid references profiles(id),body text,is_admin_reply boolean,created_at timestamptz,attachment_path text,attachment_paths text[]);
          create function is_admin(uuid) returns boolean language sql stable as $$select coalesce((select is_admin from profiles where id=$1),false)$$;
          create function bump_ticket() returns trigger language plpgsql as $$begin update support_tickets set updated_at=now() where id=new.ticket_id;return new;end$$;
          create trigger bump after insert on support_messages for each row execute function bump_ticket();
          insert into profiles(id) values('{A}'),('{B}');
          insert into support_tickets values
            ('{T}','{A}','Synthetic active report','Review existing answer','{status}','2026-09-01','{VERSION}',null,null,{'now()' if approved else 'null'},'{{}}'),
            ('{R}','{A}','Synthetic resolved report','Earlier report','resolved','2026-09-02','{VERSION}',now(),now(),null,'{{}}'),
            ('{X}','{B}','Synthetic other customer','Private fixture body','open','2026-09-03','{VERSION}',null,null,{'now()' if two_owners else 'null'},'{{}}');
          insert into support_messages values
            ('30000000-0000-4000-8000-000000000001','{R}','{A}','Yes the Add button works',false,'2026-09-18',null,null);
        """)
        sql(MIGRATION)

    def scenario(name, two_owners=False, approved=True, status='open', parked=None):
        reset(two_owners, approved, status)
        run = folder / name
        run.mkdir(mode=0o700)
        binary = run / 'bin'
        binary.mkdir(mode=0o700)
        state = run / 'cases'
        state.mkdir(mode=0o700)
        env['SUPPORT_FIXTURE_RUN'] = str(run)
        env['SUPPORT_FIXTURE_SCENARIO'] = name
        # These shims cannot delegate to Keychain or to an installed model CLI.
        write(binary / 'security', '#!/bin/sh\ncase "$*" in\n'
              ' "find-generic-password -l Supabase CLI -w") echo synthetic-database-token;;\n'
              ' "find-generic-password -s Claude Code OAuth -w") echo synthetic-model-token;;\n'
              ' *) exit 89;;\nesac\n', 0o700)
        write(binary / 'node', '#!/bin/sh\nexec ' + quoted(NODE) + ' --import ' +
              quoted(FIXTURES / 'database.mjs') + ' "$@"\n', 0o700)
        write(binary / 'claude', '#!/bin/sh\nexec ' + quoted(NODE) + ' ' +
              quoted(FIXTURES / 'model.mjs') + ' "$@"\n', 0o700)
        # The owner notifier records the message instead of sending an iMessage.
        write(binary / 'notify', '#!/bin/sh\nprintf "%s\\n" "$1" >> ' + quoted(run / 'notify.log') + '\n', 0o700)
        if parked is not None:
            failed = state / 'failed'
            failed.mkdir(mode=0o700)
            write(failed / f'{T}.count', f'{parked}\n')
        original = (ROOT / 'scripts' / 'ticket-agent.sh').read_text()
        replacements = {
            'REPO="$HOME/Projects/CredentialDOMD"': 'REPO=' + quoted(ROOT),
            'LOG="$HOME/Library/Logs/credentialdomd-ticket-agent.log"': 'LOG=' + quoted(run / 'runner.log'),
            'LOCK="/tmp/credentialdomd-ticket-agent.lock"': 'LOCK=' + quoted(run / 'runner.lock'),
            'CLAUDE="$HOME/.local/share/fnm/node-versions/v24.15.0/installation/bin/claude"': 'CLAUDE=' + quoted(binary / 'claude'),
            'CASE_STATE="$HOME/Library/Application Support/CredentialDOMD/ticket-context"': 'CASE_STATE=' + quoted(state),
            'NOTIFY="$REPO/scripts/notify-owner.sh"': 'NOTIFY=' + quoted(binary / 'notify'),
        }
        for before, after in replacements.items():
            if original.count(before) != 1:
                raise AssertionError('Runner boundary changed: ' + before)
            original = original.replace(before, after)
        script = run / 'runner.zsh'
        write(script, original)
        return run, state, script

    def execute(script):
        return command('/bin/zsh', script, cwd=script.parent)

    def invocations(run):
        filename = run / 'model-inputs.jsonl'
        return [json.loads(line) for line in filename.read_text().splitlines()] if filename.exists() else []

    def count(ticket=T):
        return int(sql(f"select count(*) from support_messages where ticket_id='{ticket}' and is_admin_reply"))

    def log(run):
        return (run / 'runner.log').read_text()

    def notified(run):
        filename = run / 'notify.log'
        return filename.read_text().splitlines() if filename.exists() else []

    def status(state):
        return json.loads((state / 'status.json').read_text())

    def due(state):
        filename = state / f'{T}.json'
        record = json.loads(filename.read_text())
        record['continuation']['due_at'] = '2000-01-01T00:00:00Z'
        write(filename, json.dumps(record))

    try:
        run, state, script = scenario('normal', two_owners=True)
        result = execute(script)
        check('full shell path replies successfully', result.returncode == 0 and count() == 1 and count(X) == 1)
        inputs = invocations(run)
        check('two targets use separate model sessions', len(inputs) == 2 and {v['owner_id'] for v in inputs} == {A, B})
        check('all model histories match that session owner', all(all(t['user_id'] == v['owner_id'] for t in v['tickets']) for v in inputs))
        first = next(v for v in inputs if v['target_id'] == T)
        check('resolved archived confirmation reaches the actual stdin context', any(t['id'] == R and t['messages'][0]['body'] == 'Yes the Add button works' for t in first['tickets']))
        check('unapproved related ticket receives no automated reply', count(R) == 0)
        check('real SQL applies automated label and support stamp', sql(f"select body like 'CredentialDOMD Support · Automated%' from support_messages where ticket_id='{T}' and is_admin_reply") == 't' and sql(f"select agent_last_reply_at is not null from support_tickets where id='{T}'") == 't')
        check('every stored reply carries a used verification the database checked', sql("select count(*) from support_messages m join support_reply_verifications v on v.id=m.verification_id and v.used_by_message_id=m.id where m.is_admin_reply") == '2')
        check('the verification report records the agent path, not ticket text', sql(f"select report->>'path' from support_reply_verifications where ticket_id='{T}'") == 'agent')
        check('a finished run writes a private status file', status(state)['last_run']['rc'] == 0 and (state / 'status.json').stat().st_mode & 0o777 == 0o600)
        check('an ordinary run alerts nobody', notified(run) == [])
        check('case record is durable and private', (state / f'{T}.json').stat().st_mode & 0o777 == 0o600)
        check('fixture lock and its owner record are released', not (run / 'runner.lock').exists())
        check('immediate rerun is idle without duplicate replies', execute(script).returncode == 0 and len(invocations(run)) == 2 and count() == 1)

        for name in ['reapprove', 'withdraw', 'new_input', 'change_owner']:
            run, state, script = scenario(name)
            check(name + ' permits generation but withholds stale publication', execute(script).returncode == 0 and len(invocations(run)) == 1 and count() == 0 and 'reply_withheld' in (run / 'runner.log').read_text())

        for name, repairs in [('invalid_json', 0), ('provider_error', 0), ('bad_assessment', 2), ('answered_question', 2)]:
            run, state, script = scenario(name)
            check(name + ' fails without a reply', execute(script).returncode != 0 and count() == 0)
            # An unusable result is not resumed; a rule the model broke is, twice.
            check(name + f' is resumed {repairs} times', log(run).count('REPAIR') == repairs and len(invocations(run)) == 1 + repairs)

        run, state, script = scenario('repair')
        check('a refused reply is repaired by resuming the session', execute(script).returncode == 0 and count() == 1)
        inputs = invocations(run)
        check('one resume carried only the host reason', len(inputs) == 2 and inputs[1].get('resumed') and 'commit_or_build_id' in inputs[1]['repair_prompt'] and 'device_not_tested' in inputs[1]['repair_prompt'])
        check('the repair is logged and nothing counts as rejected', 'REPAIR' in log(run) and 'REJECTED' not in log(run) and not (state / 'failed' / f'{T}.count').exists())
        check('the repaired reply is the one stored', sql(f"select body from support_messages where ticket_id='{T}' and is_admin_reply").endswith('Investigation remains in progress.'))

        run, state, script = scenario('repair_exhausted')
        check('two failed repairs then count as one rejection', execute(script).returncode != 0 and count() == 0 and len(invocations(run)) == 3 and log(run).count('REPAIR') == 2 and (state / 'failed' / f'{T}.count').read_text().strip() == '1')

        run, state, script = scenario('parked', two_owners=True, parked=3)
        check('a parked ticket is skipped by the queue, not blocking it', execute(script).returncode == 0 and count() == 0 and count(X) == 1)
        check('only the other ticket reached the model', [v['target_id'] for v in invocations(run)] == [X] and 'PARKED' not in log(run))
        check('the status file lists the parked ticket', [p['ticket'] for p in status(state)['parked']] == [T])

        run, state, script = scenario('park_alert', parked=2)
        check('the third rejection parks the ticket', execute(script).returncode != 0 and (state / 'failed' / f'{T}.count').read_text().strip() == '3')
        check('parking alerts the owner once, by id prefix only', len(notified(run)) == 1 and T[:8] in notified(run)[0] and 'Synthetic' not in notified(run)[0])
        check('the alert is also a private log line', f'parked ticket={T[:8]}' in (state / 'alerts.log').read_text() and (state / 'alerts.log').stat().st_mode & 0o777 == 0o600)
        check('the next run skips it without another alert', execute(script).returncode == 0 and len(notified(run)) == 1 and 'idle' in log(run).splitlines()[-1], log(run).splitlines()[-3:])

        run, state, script = scenario('resolved_kept', status='resolved')
        check('a reply to a resolved ticket keeps it resolved', execute(script).returncode == 0 and count() == 1 and sql(f"select status from support_tickets where id='{T}'") == 'resolved')

        run, state, script = scenario('stale_lock')
        (run / 'runner.lock').mkdir(mode=0o700)
        write(run / 'runner.lock' / 'owner', f'pid=999999\nstarted={int(time.time()) - 5 * 3600}\n')
        check('a held lock skips the run', execute(script).returncode == 0 and not invocations(run) and 'SKIP' in log(run))
        check('a lock older than 4 h alerts the owner', len(notified(run)) == 1 and 'held 5' in notified(run)[0] and 'not running' in notified(run)[0])
        check('the status file shows the stale lock', status(state)['lock']['stale'] is True and status(state)['lock']['pid'] == 999999)
        check('the same stale lock alerts only once', execute(script).returncode == 0 and len(notified(run)) == 1)
        (run / 'runner.lock' / 'owner').unlink()
        (run / 'runner.lock').rmdir()

        run, state, script = scenario('verification_missing')
        sql('drop table support_reply_verifications cascade')
        check('without the verification table the runner stops before any model run', execute(script).returncode != 0 and not invocations(run) and 'Reply verification is not installed' in log(run))

        run, state, script = scenario('queue_failure')
        check('database failure is not treated as empty queue or model work', execute(script).returncode != 0 and not invocations(run) and 'NOT an empty queue' in (run / 'runner.log').read_text())
        run, state, script = scenario('unapproved', approved=False)
        check('unapproved target never launches model', execute(script).returncode == 0 and not invocations(run) and count() == 0)
        run, state, script = scenario('owner_race')
        check('related ownership race aborts before model launch', execute(script).returncode != 0 and not invocations(run) and count() == 0)

        run, state, script = scenario('continuation')
        check('initial promise stores one normal reply', execute(script).returncode == 0 and count() == 1)
        due(state)
        check('due work continues without new customer input', execute(script).returncode == 0 and invocations(run)[-1]['run_mode'] == 'continuation')
        record = json.loads((state / f'{T}.json').read_text())
        check('quiet continuation saves progress without publication', count() == 1 and record['run_mode'] == 'continuation' and record['continuation']['attempts'] == 1)

        run, state, script = scenario('arrival_on_load')
        check('arrival fixture starts with one reply', execute(script).returncode == 0 and count() == 1)
        due(state)
        write(run / 'arrival-enabled', 'synthetic')
        check('new message after queue selection reaches normal reply host path', execute(script).returncode == 0 and count() == 2 and invocations(run)[-1]['run_mode'] == 'reply')
        check('promoted reply consumes no continuation attempt', json.loads((state / f'{T}.json').read_text())['continuation']['attempts'] == 0)

        run, state, script = scenario('owner_wait')
        check('owner decision is recorded after normal reply', execute(script).returncode == 0 and json.loads((state / f'{T}.json').read_text())['continuation']['state'] == 'waiting_owner')
        due(state)
        check('waiting owner does not loop model or repeat reply', execute(script).returncode == 0 and count() == 1 and len(invocations(run)) == 1)

        print(f'{len(checks)} synthetic full-host checks passed')
        for name in checks:
            print('  ok ' + name)
    finally:
        stopped = command(PG / 'pg_ctl', '-D', folder / 'data', '-m', 'immediate', '-w', 'stop')
        if stopped.returncode:
            raise RuntimeError('Temporary PostgreSQL failed to stop')
