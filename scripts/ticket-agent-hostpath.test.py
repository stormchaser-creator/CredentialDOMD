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
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PG = Path('/opt/homebrew/opt/postgresql@17/bin')
NODE = Path(shutil.which('node')).resolve()
FIXTURES = ROOT / 'scripts' / 'ticket-agent-hostpath-fixtures'
A = '10000000-0000-4000-8000-000000000001'
B = '10000000-0000-4000-8000-000000000002'
T = '20000000-0000-4000-8000-000000000001'
R = '20000000-0000-4000-8000-000000000002'
X = '20000000-0000-4000-8000-000000000004'
VERSION = '2026-09-19T12:00:00+00:00'
checks = []


def check(name, okay):
    if not okay:
        raise AssertionError(name)
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

    def reset(two_owners=False, approved=True):
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
            ('{T}','{A}','Synthetic active report','Review existing answer','open','2026-09-01','{VERSION}',null,null,{'now()' if approved else 'null'},'{{}}'),
            ('{R}','{A}','Synthetic resolved report','Earlier report','resolved','2026-09-02','{VERSION}',now(),now(),null,'{{}}'),
            ('{X}','{B}','Synthetic other customer','Private fixture body','open','2026-09-03','{VERSION}',null,null,{'now()' if two_owners else 'null'},'{{}}');
          insert into support_messages values
            ('30000000-0000-4000-8000-000000000001','{R}','{A}','Yes the Add button works',false,'2026-09-18',null,null);
        """)

    def scenario(name, two_owners=False, approved=True):
        reset(two_owners, approved)
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
        original = (ROOT / 'scripts' / 'ticket-agent.sh').read_text()
        replacements = {
            'REPO="$HOME/Projects/CredentialDOMD"': 'REPO=' + quoted(ROOT),
            'LOG="$HOME/Library/Logs/credentialdomd-ticket-agent.log"': 'LOG=' + quoted(run / 'runner.log'),
            'LOCK="/tmp/credentialdomd-ticket-agent.lock"': 'LOCK=' + quoted(run / 'runner.lock'),
            'CLAUDE="$HOME/.local/share/fnm/node-versions/v24.15.0/installation/bin/claude"': 'CLAUDE=' + quoted(binary / 'claude'),
            'CASE_STATE="$HOME/Library/Application Support/CredentialDOMD/ticket-context"': 'CASE_STATE=' + quoted(state),
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
        check('case record is durable and private', (state / f'{T}.json').stat().st_mode & 0o777 == 0o600)
        check('fixture lock is released', not (run / 'runner.lock').exists())
        check('immediate rerun is idle without duplicate replies', execute(script).returncode == 0 and len(invocations(run)) == 2 and count() == 1)

        for name in ['reapprove', 'withdraw', 'new_input', 'change_owner']:
            run, state, script = scenario(name)
            check(name + ' permits generation but withholds stale publication', execute(script).returncode == 0 and len(invocations(run)) == 1 and count() == 0 and 'reply_withheld' in (run / 'runner.log').read_text())

        for name in ['invalid_json', 'provider_error', 'bad_assessment', 'answered_question']:
            run, state, script = scenario(name)
            check(name + ' fails without a reply', execute(script).returncode != 0 and count() == 0)

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
