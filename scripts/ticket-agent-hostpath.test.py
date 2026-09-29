#!/usr/bin/env python3
"""Full shell path with synthetic credentials/model and local PostgreSQL only.

The copied shell changes only its fixed repository/log/lock/CLI/state paths. Its
node entry points, queue, context, assessment, SQL writer and stage 2 runner
(scripts/ticket-fix/run.mjs: worktree, reproduction, contained worker, gates,
review, held merge) are the real sources: the runner copies them out of the last
commit of its repository, so each scenario gets a throwaway git repository
holding the current working-tree versions, with a local bare origin.
No installed model CLI, Keychain command, HTTP client or production worker runs.
"""
import base64
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
PG = Path(os.environ.get('PG_BIN') or '/opt/homebrew/opt/postgresql@17/bin')
MIGRATION = (ROOT / 'supabase' / 'migrations' / '20260928150000_support_reply_verifications.sql').read_text()
HARDENING = (ROOT / 'supabase' / 'migrations' / '20260928161000_support_reply_hardening.sql').read_text()
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
# What the runner copies out of its repository before any model runs.
HOST_FILES = ['scripts/ticket-agent-context.mjs', 'scripts/ticket-agent-isolated.mjs', 'scripts/ticket-agent-prompt.md', 'scripts/notify-owner.sh', 'scripts/ticket-fix']
GIT = ['/usr/bin/git', '-c', 'user.name=Synthetic Tester', '-c', 'user.email=tester@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']
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

    # The model stand-in runs inside the session sandbox, which lets it write
    # only its worktree and session directory. It hands its records to this
    # loopback recorder, which writes them under the test folder only.
    class Recorder(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _target(self, key):
            value = parse_qs(urlparse(self.path).query).get(key, [''])[0]
            target = Path(value).resolve()
            if not value.startswith('/') or not str(target).startswith(str(folder.resolve()) + '/'):
                raise ValueError('outside the fixture folder')
            return target

        def _reply(self, code, body=b''):
            self.send_response(code)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            try:
                self._reply(200, self._target('file').read_bytes())
            except Exception:
                self._reply(404)

        def do_POST(self):
            try:
                body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
                action = urlparse(self.path).path
                if action == '/append':
                    with open(self._target('file'), 'ab') as handle:
                        handle.write(body)
                elif action == '/write':
                    self._target('file').write_bytes(body)
                elif action == '/sql':
                    sql(body.decode())
                elif action == '/tamper':
                    repo = self._target('repo')
                    with open(repo / 'scripts' / 'ticket-fix' / 'claims.mjs', 'a') as handle:
                        handle.write('\nexport const weakened = true;\n')
                    done = subprocess.run(GIT + ['-C', str(repo), 'commit', '-qam', 'Synthetic weakening'], text=True, capture_output=True, env=env, timeout=30)
                    if done.returncode:
                        raise RuntimeError(done.stderr)
                else:
                    raise ValueError('unknown action')
                self._reply(200)
            except Exception:
                self._reply(500)

    recorder = ThreadingHTTPServer(('127.0.0.1', 0), Recorder)
    threading.Thread(target=recorder.serve_forever, daemon=True).start()
    sock = folder / 'sock'
    sock.mkdir(mode=0o700)
    # An allowlist prevents inherited provider, database and Node preload settings.
    env = {'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'TMPDIR': str(folder), 'LC_ALL': 'C',
           'SUPPORT_FIXTURE_ROOT': str(ROOT), 'SUPPORT_FIXTURE_NODE': str(NODE),
           'SUPPORT_FIXTURE_PSQL': str(PG / 'psql'), 'SUPPORT_FIXTURE_SOCKET': str(sock),
           'SUPPORT_FIXTURE_RECORDER': f'http://127.0.0.1:{recorder.server_address[1]}'}

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

    def reset(two_owners=False, approved=True, status='open', payload='{}'):
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
            ('{T}','{A}','Synthetic active report','Review existing answer','{status}','2026-09-01','{VERSION}',null,null,{'now()' if approved else 'null'},'{payload}'),
            ('{R}','{A}','Synthetic resolved report','Earlier report','resolved','2026-09-02','{VERSION}',now(),now(),null,'{{}}'),
            ('{X}','{B}','Synthetic other customer','Private fixture body','open','2026-09-03','{VERSION}',null,null,{'now()' if two_owners else 'null'},'{{}}');
          insert into support_messages values
            ('30000000-0000-4000-8000-000000000001','{R}','{A}','Yes the Add button works',false,'2026-09-18',null,null);
        """)
        sql(MIGRATION)
        sql(HARDENING)

    def scenario(name, two_owners=False, approved=True, status='open', parked=None, extra=None, payload='{}'):
        reset(two_owners, approved, status, payload)
        run = folder / name
        run.mkdir(mode=0o700)
        repo = run / 'repo'
        for rel in HOST_FILES:
            source = ROOT / rel
            if source.is_dir():
                shutil.copytree(source, repo / rel)
            else:
                (repo / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, repo / rel)
        origin = run / 'origin.git'
        made = subprocess.run(['/usr/bin/git', 'init', '-q', '--bare', '-b', 'main', str(origin)], text=True, capture_output=True, env=env, timeout=30)
        if made.returncode:
            raise RuntimeError(made.stderr)
        for args in (['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'Synthetic host code'],
                     ['remote', 'add', 'origin', str(origin)], ['push', '-q', 'origin', 'main']):
            made = subprocess.run(GIT + ['-C', str(repo)] + args, text=True, capture_output=True, env=env, timeout=30)
            if made.returncode:
                raise RuntimeError(made.stderr)
        env['SUPPORT_FIXTURE_REPO'] = str(repo)
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
        # run.mjs gives each session an allowlisted environment, so the
        # fixture's own settings are written into the shim.
        fixture_env = ' '.join(f'{k}={quoted(v)}' for k, v in env.items() if k.startswith('SUPPORT_FIXTURE_'))
        write(binary / 'claude', '#!/bin/sh\nexport ' + fixture_env + '\nexec ' + quoted(NODE) + ' ' +
              quoted(FIXTURES / 'model.mjs') + ' "$@"\n', 0o700)
        # The owner notifier records the message instead of sending an iMessage.
        write(binary / 'notify', '#!/bin/sh\nprintf "%s\\n" "$1" >> ' + quoted(run / 'notify.log') + '\n', 0o700)
        if parked is not None:
            failed = state / 'failed'
            failed.mkdir(mode=0o700)
            write(failed / f'{T}.count', f'{parked}\n')
        original = (ROOT / 'scripts' / 'ticket-agent.sh').read_text()
        replacements = {
            'REPO="$HOME/Projects/CredentialDOMD"': 'REPO=' + quoted(repo),
            'LOG="$HOME/Library/Logs/credentialdomd-ticket-agent.log"': 'LOG=' + quoted(run / 'runner.log'),
            'LOCK="/tmp/credentialdomd-ticket-agent.lock"': 'LOCK=' + quoted(run / 'runner.lock'),
            'CLAUDE="$HOME/.local/share/fnm/node-versions/v24.15.0/installation/bin/claude"': 'CLAUDE=' + quoted(binary / 'claude'),
            'CASE_STATE="$HOME/Library/Application Support/CredentialDOMD/ticket-context"': 'CASE_STATE=' + quoted(state),
            'FIX_STATE="$HOME/Library/Application Support/CredentialDOMD/ticket-fix"': 'FIX_STATE=' + quoted(run / 'ticket-fix'),
            'WORK_STATE="$HOME/Library/Application Support/CredentialDOMD/ticket-work"': 'WORK_STATE=' + quoted(run / 'work'),
            'NOTIFY="$HOST/notify-owner.sh"': 'NOTIFY=' + quoted(binary / 'notify'),
            **(extra or {}),
        }
        for before, after in replacements.items():
            if original.count(before) != 1:
                raise AssertionError('Runner boundary changed: ' + before)
            original = original.replace(before, after)
        script = run / 'runner.zsh'
        write(script, original)
        return run, state, script, repo

    def execute(script):
        return command('/bin/zsh', script, cwd=script.parent)

    def invocations(run):
        filename = run / 'model-inputs.jsonl'
        return [json.loads(line) for line in filename.read_text().splitlines()] if filename.exists() else []

    def sessions(run):
        filename = run / 'sessions.jsonl'
        return [json.loads(line) for line in filename.read_text().splitlines()] if filename.exists() else []

    def git_out(repo, *args):
        return subprocess.run(['/usr/bin/git', '-C', str(repo)] + list(args), text=True, capture_output=True, env=env, timeout=30).stdout.strip()

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
        run, state, script, repo = scenario('normal', two_owners=True)
        owner_head, origin_head = git_out(repo, 'rev-parse', 'HEAD'), git_out(run / 'origin.git', 'rev-parse', 'main')
        result = execute(script)
        check('full shell path replies successfully', result.returncode == 0 and count() == 1 and count(X) == 1, log(run)[-3000:])
        inputs = invocations(run)
        check('two targets use separate model sessions', len(inputs) == 2 and {v['owner_id'] for v in inputs} == {A, B})
        # (Both synthetic tickets start 20000000, so they share one run name.)
        records = [json.loads(f.read_text()) for f in (run / 'work' / 'runs').glob('*/run.json')]
        check('every session goes on its run record with its cost, and on the log', len(records) >= 1 and
              all([(e['role'], e['ok'], e['subtype'], e['cost_usd']) for e in r['sessions']] == [('extract', True, 'success', 0.01), ('repro', True, 'success', 0.01), ('worker', True, 'success', 0.01)] and r['cost_usd'] == 0.03 for r in records) and
              log(run).count(' 1 turn(s), $0.0100') == 6, ([r.get('sessions') for r in records], log(run)[-2000:]))
        # The worker reads a trimmed history (session-context.mjs): the target
        # thread whole, the owner's other tickets as a summary.
        owned = lambda owner: set(sql(f"select string_agg(id::text, ',') from support_tickets where user_id='{owner}'").split(','))
        seen = lambda v: [v['target']['id']] + [t['id'] for t in v['related_tickets']['detailed'] + v['related_tickets']['index']]
        check('all model histories match that session owner', all(v['view'] == 'session' and v['target']['user_id'] == v['owner_id'] and set(seen(v)) <= owned(v['owner_id']) for v in inputs))
        first = next(v for v in inputs if v['target_id'] == T)
        check('resolved archived confirmation reaches the actual stdin context', any(t['id'] == R and t['newest_customer_message']['excerpt'] == 'Yes the Add button works' for t in first['related_tickets']['detailed']))
        check('unapproved related ticket receives no automated reply', count(R) == 0)
        check('real SQL applies automated label and support stamp', sql(f"select body like 'CredentialDOMD Support · Automated%' from support_messages where ticket_id='{T}' and is_admin_reply") == 't' and sql(f"select agent_last_reply_at is not null from support_tickets where id='{T}'") == 't')
        check('every stored reply carries a used verification the database checked', sql("select count(*) from support_messages m join support_reply_verifications v on v.id=m.verification_id and v.used_by_message_id=m.id where m.is_admin_reply") == '2')
        check('the verification report records the agent path, not ticket text', sql(f"select report->>'path' from support_reply_verifications where ticket_id='{T}'") == 'agent')
        check('a finished run writes a private status file', status(state)['last_run']['rc'] == 0 and (state / 'status.json').stat().st_mode & 0o777 == 0o600)
        check('an ordinary run alerts nobody', notified(run) == [])
        check('case record is durable and private', (state / f'{T}.json').stat().st_mode & 0o777 == 0o600)
        check('fixture lock and its owner record are released', not (run / 'runner.lock').exists())
        check('immediate rerun is idle without duplicate replies', execute(script).returncode == 0 and len(invocations(run)) == 2 and count() == 1)
        vid = sql(f"select verification_id from support_messages where ticket_id='{T}' and is_admin_reply")
        check('the runner keeps a private ledger entry per stored reply', (state / 'replies' / T / f'{vid}.json').stat().st_mode & 0o777 == 0o600)
        check('reconcile finds every stored reply in a ledger and alerts nobody', notified(run) == [] and 'reconcile: 2 verifications, 0 without a ledger entry, 0 agent replies from no logged run' in log(run), (notified(run), log(run)[-3000:]))
        check('the stored result says it was not emailed', '"emailed":false' in log(run))
        check('the stored result says the email is attempted, not confirmed', '"email":"attempted, not confirmed: notify_ticket_reply' in log(run) and 'Only support_messages.emailed_at shows it was sent' in log(run))
        check('the verification records the run and that its claims are bound', sql(f"select (report->>'claims') || '|' || length(report->>'run_id') from support_reply_verifications where ticket_id='{T}'") == 'bound|16')
        # Stage 3: the reply is the host's: a fixed opening, the footer with one
        # line per frozen checklist item in the host's state, a fixed closing.
        body = sql(f"select body from support_messages where ticket_id='{T}' and is_admin_reply")
        check('the stored reply is rendered by the host with one footer line per checklist item', body.startswith('CredentialDOMD Support · Automated\n\nHere is where your request stands.') and
              'Where each part stands:\n1. Review the existing answer: not done yet, next: look into the synthetic report\n' in body and body.endswith('We will post on this thread when the remaining work is done.'), body)
        check('the frozen checklist is private host state', (state / 'checklists' / f'{T}.json').stat().st_mode & 0o777 == 0o600 and json.loads((state / 'checklists' / f'{T}.json').read_text())['items'][0]['id'] == 'AC-1')
        check('the case record keeps the host decision per item', json.loads((state / f'{T}.json').read_text())['checklist_states'] == [{'id': 'AC-1', 'state': 'not_done', 'remaining': 'look into the synthetic report', 'detail': None}])
        # Stage 2: every session is contained and runs in a worktree; the
        # reproduction comes first; the owner's checkout and main are untouched.
        roles = [v['role'] for v in sessions(run)]
        check('each ticket gets a checklist, then a reproduction session, before its worker', roles[:3] == ['extract', 'repro', 'worker'] and roles.count('extract') == 2 and roles.count('repro') == 2 and roles.count('worker') == 2, roles)
        check('every session ran in a worktree under the work directory, never the owner checkout', all(v['cwd'].startswith(str(run / 'work' / 'worktrees')) for v in sessions(run)))
        check('the worker has Read, Grep and Glob but no git or rg', all(v['tools'] == 'Read,Grep,Glob,Edit,Write,Bash' for v in sessions(run) if v['role'] in ('repro', 'worker')))
        check('the checklist extractor has no tools', all(v['tools'] == '' for v in sessions(run) if v['role'] == 'extract'))
        check('every session ran inside the sandbox, with its credential on a pipe', len(sessions(run)) == 6 and all(v['sandboxed'] for v in sessions(run)), sessions(run))
        check('the owner checkout and origin main are untouched', git_out(repo, 'rev-parse', 'HEAD') == owner_head and git_out(repo, 'status', '--porcelain') == '' and git_out(run / 'origin.git', 'rev-parse', 'main') == origin_head)
        check('a run with no change leaves no worktree and no branch', not any((run / 'work' / 'worktrees').iterdir()) and git_out(repo, 'branch', '--list', 'agent/*') == '')

        for name in ['reapprove', 'withdraw', 'new_input', 'change_owner']:
            run, state, script, repo = scenario(name)
            check(name + ' permits generation but withholds stale publication', execute(script).returncode == 0 and len(invocations(run)) == 1 and count() == 0 and 'reply_withheld' in (run / 'runner.log').read_text())

        for name, repairs in [('invalid_json', 0), ('provider_error', 0), ('bad_assessment', 2), ('answered_question', 2)]:
            run, state, script, repo = scenario(name)
            check(name + ' fails without a reply', execute(script).returncode != 0 and count() == 0)
            # An unusable result is not resumed; a rule the model broke is, twice.
            check(name + f' is resumed {repairs} times', log(run).count('REPAIR') == repairs and len(invocations(run)) == 1 + repairs)

        run, state, script, repo = scenario('repair')
        check('a refused reply is repaired by resuming the session', execute(script).returncode == 0 and count() == 1)
        inputs = invocations(run)
        check('one resume carried only the host reason', len(inputs) == 2 and inputs[1].get('resumed') and 'commit_or_build_id' in inputs[1]['repair_prompt'] and 'device_not_tested' in inputs[1]['repair_prompt'])
        check('the repair is logged and nothing counts as rejected', 'REPAIR' in log(run) and 'REJECTED' not in log(run) and not (state / 'failed' / f'{T}.count').exists())
        check('the repaired reply is the one stored', sql(f"select body from support_messages where ticket_id='{T}' and is_admin_reply").endswith('We will post on this thread when the remaining work is done.') and
              'c237149' not in sql(f"select body from support_messages where ticket_id='{T}' and is_admin_reply"))
        check('the log names the broken rules, never the refused reply text', 'REPAIR — ' + T + ' attempt 1: reply.claims[0] commit_or_build_id, device_not_tested\n' in log(run) and 'c237149' not in log(run) and 'iPhone' not in log(run), log(run))

        run, state, script, repo = scenario('repair_exhausted')
        check('two failed repairs then count as one rejection', execute(script).returncode != 0 and count() == 0 and len(invocations(run)) == 3 and log(run).count('REPAIR') == 2 and (state / 'failed' / f'{T}.count').read_text().strip() == '1')

        run, state, script, repo = scenario('parked', two_owners=True, parked=3)
        check('a parked ticket is skipped by the queue, not blocking it', execute(script).returncode == 0 and count() == 0 and count(X) == 1)
        check('only the other ticket reached the model', [v['target_id'] for v in invocations(run)] == [X] and 'PARKED' not in log(run))
        check('the status file lists the parked ticket', [p['ticket'] for p in status(state)['parked']] == [T])

        run, state, script, repo = scenario('park_alert', parked=2)
        check('the third rejection parks the ticket', execute(script).returncode != 0 and (state / 'failed' / f'{T}.count').read_text().strip() == '3')
        check('parking alerts the owner once, by id prefix only', len(notified(run)) == 1 and T[:8] in notified(run)[0] and 'Synthetic' not in notified(run)[0])
        check('the alert is also a private log line', f'parked ticket={T[:8]}' in (state / 'alerts.log').read_text() and (state / 'alerts.log').stat().st_mode & 0o777 == 0o600)
        check('the next run skips it without another alert', execute(script).returncode == 0 and len(notified(run)) == 1 and 'idle' in log(run).splitlines()[-1], log(run).splitlines()[-3:])

        run, state, script, repo = scenario('resolved_kept', status='resolved')
        check('a reply to a resolved ticket keeps it resolved', execute(script).returncode == 0 and count() == 1 and sql(f"select status from support_tickets where id='{T}'") == 'resolved')

        for name in ['tamper', 'tamper_uncommitted']:
            run, state, script, repo = scenario(name)
            result = execute(script)
            if name == 'tamper':
                escape = [json.loads(line) for line in (run / 'escape.jsonl').read_text().splitlines()]
                check('tamper: the sandbox refused the write to the owner checkout and its git', escape == [{'write_refused': True, 'commit_status': escape[0]['commit_status']}] and escape[0]['commit_status'] != 0, escape)
            check(name + ': a run that changes the reply checks records nothing', result.returncode != 0 and count() == 0 and 'PROTECTED' in log(run))
            check(name + ': the owner is alerted and every later run is held', len(notified(run)) == 1 and "changed the runner's own code" in notified(run)[0] and (state / 'HOLD-host-code-changed').exists())
            check(name + ': the held run counts toward the breaker', (state / 'failed' / f'{T}.count').read_text().strip() == '1')
            check(name + ': the next run does nothing while held', execute(script).returncode == 0 and len(invocations(run)) == 1 and log(run).splitlines()[-1].split(' ', 2)[2].startswith('HOLD'))
            (state / 'HOLD-host-code-changed').unlink()

        run, state, script, repo = scenario('dirty_before')
        with open(repo / 'scripts' / 'ticket-fix' / 'claims.mjs', 'a') as handle:
            handle.write('\n// Synthetic work in progress, uncommitted before the run.\n')
        check('edits already present before the run do not hold it', execute(script).returncode == 0 and count() == 1 and 'PROTECTED' not in log(run))

        run, state, script, repo = scenario('timeout', extra={'WORKER_SECONDS=1500': 'WORKER_SECONDS=2'})
        check('a model killed by the alarm counts toward the breaker', execute(script).returncode != 0 and count() == 0 and (state / 'failed' / f'{T}.count').read_text().strip() == '1' and 'REJECTED — ' + T + ' model run failed or timed out' in log(run) and 'worker session timed out after 2 s' in log(run) and ': worker FAILED timed out after 2 s' in log(run), log(run)[-1500:])
        run, state, script, repo = scenario('timeout_park', parked=2, extra={'WORKER_SECONDS=1500': 'WORKER_SECONDS=2'})
        check('the third timeout parks the ticket and alerts the owner', execute(script).returncode != 0 and (state / 'failed' / f'{T}.count').read_text().strip() == '3' and len(notified(run)) == 1 and 'parked' in notified(run)[0])

        run, state, script, repo = scenario('code_refused')
        origin_head = git_out(run / 'origin.git', 'rev-parse', 'main')
        result = execute(script)
        check('a change with no reproduction is refused by the gates, but the reply is still recorded', result.returncode == 0 and count() == 1 and 'CODE REFUSED — ' + T in log(run), log(run)[-2500:])
        check('the refused change counts toward the breaker and alerts the owner', (state / 'failed' / f'{T}.count').read_text().strip() == '1' and any('was not merged' in m for m in notified(run)), notified(run))
        check('the gate failure went back to the worker once, as rule names', [v.get('resumed') for v in invocations(run)] == [None, True] and 'reproduction_recorded' in invocations(run)[1]['repair_prompt'])
        check('nothing reached origin main; the branch is kept for inspection', git_out(run / 'origin.git', 'rev-parse', 'main') == origin_head and git_out(repo, 'branch', '--list', 'agent/*') != '')
        check('a refused change leaves no worktree once the reply is recorded', not any((run / 'work' / 'worktrees').iterdir()))

        run, state, script, repo = scenario('forged')
        sql(f"""
          with k as (select decrypted_secret s from vault.decrypted_secrets where name='support_reply_hmac_key'),
               v as (select '40000000-0000-4000-8000-000000000001'::text id, '{X}'::text t, encode(sha256(convert_to('Forged reply','UTF8')),'hex') b)
          insert into support_reply_verifications(id,ticket_id,body_sha256,hmac,report)
            select v.id::uuid, v.t::uuid, v.b, encode(extensions.hmac(convert_to(v.id||':'||v.t||':'||v.b,'UTF8'),convert_to(k.s,'UTF8'),'sha256'),'hex'), '{{"path":"post-reply"}}' from v, k;
          insert into support_messages(id,ticket_id,author_id,body,is_admin_reply,created_at,verification_id)
            values ('40000000-0000-4000-8000-000000000002','{X}','{B}','Forged reply',true,now(),'40000000-0000-4000-8000-000000000001');
        """)
        check('a reply signed around the checks is stored by the database (the HMAC is not a boundary)', count(X) == 1)
        check('reconcile reports it to the owner by id prefix', execute(script).returncode == 0 and any('40000000' in m and 'has no record from post-reply.mjs or the hourly runner' in m for m in notified(run)))
        check('and only once', execute(script).returncode == 0 and sum('has no record' in m for m in notified(run)) == 1)

        run, state, script, repo = scenario('stale_lock')
        (run / 'runner.lock').mkdir(mode=0o700)
        write(run / 'runner.lock' / 'owner', f'pid=999999\nstarted={int(time.time()) - 5 * 3600}\n')
        check('a held lock skips the run', execute(script).returncode == 0 and not invocations(run) and 'SKIP' in log(run))
        check('a lock older than 4 h alerts the owner', len(notified(run)) == 1 and 'held 5' in notified(run)[0] and 'not running' in notified(run)[0])
        check('the status file shows the stale lock', status(state)['lock']['stale'] is True and status(state)['lock']['pid'] == 999999)
        check('the same stale lock alerts only once', execute(script).returncode == 0 and len(notified(run)) == 1)
        (run / 'runner.lock' / 'owner').unlink()
        (run / 'runner.lock').rmdir()

        run, state, script, repo = scenario('verification_missing')
        sql('drop table support_reply_verifications cascade')
        check('without the verification table the runner stops before any model run', execute(script).returncode != 0 and not invocations(run) and 'Reply verification is not installed' in log(run))

        run, state, script, repo = scenario('queue_failure')
        check('database failure is not treated as empty queue or model work', execute(script).returncode != 0 and not invocations(run) and 'NOT an empty queue' in (run / 'runner.log').read_text())
        run, state, script, repo = scenario('unapproved', approved=False)
        check('unapproved target never launches model', execute(script).returncode == 0 and not invocations(run) and count() == 0)
        run, state, script, repo = scenario('owner_race')
        check('related ownership race aborts before model launch', execute(script).returncode != 0 and not invocations(run) and count() == 0)

        # Stage 3 (G6): a ticket with a screenshot. The host downloads it before
        # any session, the extractor sees it inline, the worker's answer is
        # refused until its own tool events show a Read of it, the confirmer
        # agrees with what the worker says it shows, and the file is gone after.
        run, state, script, repo = scenario('attachment', payload=json.dumps({'attachment_path': f'tickets/{T}/screenshot.png'}))
        result = execute(script)
        check('attachment: the reply is recorded', result.returncode == 0 and count() == 1, log(run)[-3000:])
        check('attachment: downloaded by the host before any session, logged by ticket id and storage path only', f'ATTACHMENT — {T} tickets/{T}/screenshot.png: delivered as att-1' in log(run) and
              [json.loads(line)['request'] for line in (run / 'storage.jsonl').read_text().splitlines()] == ['api-keys', 'object'])
        service_key = '.'.join(base64.urlsafe_b64encode(part.encode()).decode().rstrip('=') for part in ('{"alg":"HS256"}', '{"role":"service_role"}', 'synthetic-signature'))
        check('attachment: the storage key never reaches the log', service_key not in log(run) and service_key.split('.')[1] not in log(run))
        check('attachment: the extractor saw the screenshot inline', [json.loads(line)['images'] for line in (run / 'extract-inputs.jsonl').read_text().splitlines()] == [1])
        seen = [json.loads(line) for line in (run / 'worker-attachments.jsonl').read_text().splitlines()]
        check('attachment: an answer with no Read of it was refused and the worker resumed', 'REPAIR — ' + T + ' attempt 1: attachments\n' in log(run) and [v['resumed'] for v in seen] == [False, True], log(run)[-2000:])
        check('attachment: the session sandbox let this ticket\'s sessions read it', all(v['readable'] for v in seen) and
              all(json.loads(line)['readable'] for line in (run / 'confirm-inputs.jsonl').read_text().splitlines()))
        check('attachment: the confirmer judged the observation', [json.loads(line)['attachments'] for line in (run / 'confirm-inputs.jsonl').read_text().splitlines()] == [['att-1']])
        check('attachment: the verification records it as reviewed', sql(f"select report->'attachments'->0->>'access' from support_reply_verifications where ticket_id='{T}'") == 'reviewed')
        check('attachment: the downloaded files are gone after the run', not list(folder.glob('credentialdomd-attachments.*')))

        run, state, script, repo = scenario('continuation')
        check('initial promise stores one normal reply', execute(script).returncode == 0 and count() == 1)
        due(state)
        check('due work continues without new customer input', execute(script).returncode == 0 and invocations(run)[-1]['run_mode'] == 'continuation')
        record = json.loads((state / f'{T}.json').read_text())
        check('quiet continuation saves progress without publication', count() == 1 and record['run_mode'] == 'continuation' and record['continuation']['attempts'] == 1)

        run, state, script, repo = scenario('arrival_on_load')
        check('arrival fixture starts with one reply', execute(script).returncode == 0 and count() == 1)
        due(state)
        write(run / 'arrival-enabled', 'synthetic')
        check('new message after queue selection reaches normal reply host path', execute(script).returncode == 0 and count() == 2 and invocations(run)[-1]['run_mode'] == 'reply')
        check('promoted reply consumes no continuation attempt', json.loads((state / f'{T}.json').read_text())['continuation']['attempts'] == 0)

        run, state, script, repo = scenario('owner_wait')
        check('owner decision is recorded after normal reply', execute(script).returncode == 0 and json.loads((state / f'{T}.json').read_text())['continuation']['state'] == 'waiting_owner')
        due(state)
        check('waiting owner does not loop model or repeat reply', execute(script).returncode == 0 and count() == 1 and len(invocations(run)) == 1)

        print(f'{len(checks)} synthetic full-host checks passed')
        for name in checks:
            print('  ok ' + name)
    finally:
        recorder.shutdown()
        stopped = command(PG / 'pg_ctl', '-D', folder / 'data', '-m', 'immediate', '-w', 'stop')
        if stopped.returncode:
            raise RuntimeError('Temporary PostgreSQL failed to stop')
