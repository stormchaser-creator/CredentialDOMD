#!/usr/bin/env python3
"""The owner notifier's SQL, message text and alert queue, for signup-notify.sh.

signup-notify.sh runs from gui-domain launchd every 10 minutes (the only
place that may read the keychain and drive Messages) and calls this file for
everything that is not a network call or the iMessage itself:

  signup-notify.py drain-lock --state DIR
      Before the drain: checks that DIR is owner-only and that a queue exists,
      creates DIR/owner-alerts.lock (private, never through a symlink) and
      prints its path, or prints nothing when there is no queue.
  signup-notify.py drain-prepare --state DIR [--max N]
      Run while the job holds that lock: prints one iMessage for the ticket
      runner's queued owner alerts (or nothing) and writes their ids to
      DIR/owner-alerts.batch. scripts/ticket-fix/alert.mjs appends them to
      DIR/owner-alerts.jsonl (macOS refuses node's request to drive Messages,
      so the runner cannot send them itself).
  signup-notify.py drain-mark --state DIR
      After the job's shell delivered that message: appends the batch ids to
      DIR/owner-alerts.sent (never sent again) and removes the batch.
      The iMessage itself is sent by signup-notify.sh, never from here. The
      Studio's TCC record (kTCCServiceAppleEvents, Messages) allows /bin/zsh
      and denies node; the send known to work is launchd, then the job's zsh,
      then osascript, all system binaries. python3 under launchd is the
      Command Line Tools' python3.9, which is not a system binary (no platform
      identifier), so it is kept out of the chain above the send.
  signup-notify.py probe
      Prints the SQL that says, for every part of the activity query, which of
      the columns and functions it reads are missing, and whether its table
      exists.
  signup-notify.py present           (the probe's rows as JSON on stdin)
      Prints the optional parts that can run, comma separated. Fails, naming
      the columns, when a core part cannot run. An optional part whose columns
      changed is named on stderr (for the log).
  signup-notify.py drifted           (the same rows on stdin)
      Prints the optional parts whose table exists but whose columns changed,
      comma separated: the job tells the owner when that lasts 3 runs.
  signup-notify.py query --since ISO --now ISO --present LIST
      Prints the activity SQL: one row per event, oldest first. Timed rows
      are those in (since, now]: consecutive runs tile time with no gap and
      no overlap.
  signup-notify.py format --seen FILE   (the query's rows as JSON on stdin)
      Prints the iMessage, or nothing when there is nothing new.
  signup-notify.py remember --seen FILE (the same rows on stdin)
      After a send: records the money events just reported.

Signups, tickets, replies, feedback and errors are reported by time: rows
created after the last run's start and up to this run's start. (Before
2026-09-29 there was no upper bound, so a row written in the second a run
started was reported twice, and a failed signup attempt made in the 3 minutes
before a run was never reported: that run skipped it as too recent and the
next one as too old. Attempts now use the same window shifted 3 minutes.)

Money events (checkouts, payments, gifts, invitations) are keyed instead and
looked for over the last LOOKBACK_DAYS: a payment is written when its webhook
settles, stamped with the time it was paid, which can be before the last run.
The key file remembers what was reported, so each one is reported once.

A refund that needs the owner (limited_refund_requests, 20260930070000) is
keyed too, one line per row and standing: a row in needs_support (changed in
the last LOOKBACK_DAYS), and a row whose membership was cancelled more than
REFUND_STUCK_MINUTES ago and is still not refunded (a press that failed or
stopped), and a request made more than REFUND_STALLED_MINUTES ago whose
membership is still not cancelled (the refund sweep, 20260930072000, has
had several tries by then). The line carries the amount, where it stands and
the row's short id. The server has also opened the member's support ticket by then
(20260930071000); this line is the owner's own alert, and still arrives when
that ticket could not be written. A stuck row still stuck after
REMEMBER_DAYS is reported again, and a row that needs support again for a
new reason (a refund that failed after the owner made it) is reported at
once. A needs_support row whose membership is not cancelled yet says so.
"""
import datetime as dt
import errno
import json
import os
import re
import stat
import sys

QUEUE, SENT, LOCK, BATCH = 'owner-alerts.jsonl', 'owner-alerts.sent', 'owner-alerts.lock', 'owner-alerts.batch'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
KIND = re.compile(r'^[a-z_]{1,40}$')
AT = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$')
SINCE = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
PREFIX = 'CredentialDOMD ticket agent: '
DRAIN_MAX = 10
LOOKBACK_DAYS = 7
REMEMBER_DAYS = 30
REFUND_STUCK_MINUTES = 15
REFUND_STALLED_MINUTES = 60

# Every part of the activity query and what it reads: {table: columns} and
# the functions it calls. The probe checks each one, so a part runs only when
# everything it reads is there. Before 2026-09-29 the probe checked only that
# the optional tables existed, and one renamed or dropped column in any of
# them failed the whole query: no signup, ticket, reply or payment alert, and
# no sign of it outside a curl error in /tmp.
#   A core part that cannot run fails the run, naming the columns. The window
#   does not move, so nothing is lost, and signup-notify.sh tells the owner
#   when that lasts 3 runs.
#   An optional part whose table does not exist yet (a migration not applied)
#   is skipped quietly. One whose table exists but whose columns changed is
#   skipped, named in the log, and reported to the owner after 3 runs.
# Names are checked, not types: an expression a type change breaks still fails
# the query, which is reported the same way.
PROFILE = ('id', 'name', 'email')
IS_ADMIN = 'public.is_admin(uuid)'
CORE = {
    'early_access_leads': ({'early_access_leads': ('waitlist', 'name', 'email', 'source', 'created_at')}, ()),
    'founding_signups': ({'founding_signups': ('name', 'email', 'created_at')}, ()),
    'profiles': ({'profiles': ('name', 'email', 'created_at')}, ()),
    'waitlist_attempts': ({'waitlist_attempts': ('name', 'email', 'stage', 'created_at'), 'early_access_leads': ('email', 'created_at')}, ()),
    'support_tickets': ({'support_tickets': ('user_id', 'subject', 'created_at'), 'profiles': PROFILE}, (IS_ADMIN,)),
    'support_messages': ({'support_messages': ('ticket_id', 'author_id', 'body', 'created_at'), 'support_tickets': ('id', 'subject'),
                          'profiles': PROFILE}, (IS_ADMIN,)),
    'client_errors': ({'client_errors': ('auth_user_id', 'kind', 'message', 'created_at'), 'profiles': ('auth_user_id', 'name', 'email')}, ()),
    'beta_access': ({'beta_access': ('id', 'name', 'email', 'activated_at', 'invite_sent_at')}, ()),
}
# Read only when they can be. Each is named for its table.
OPTIONAL_PARTS = {
    'feedback': ({'feedback': ('user_id', 'rating', 'message', 'context_page', 'created_at'), 'profiles': PROFILE}, (IS_ADMIN,)),
    'limited_billing_quotes': ({'limited_billing_quotes': ('attempt_id', 'profile_id', 'livemode', 'offer_id', 'price_phase', 'annual_cents', 'created_at'),
                                'profiles': PROFILE}, ()),
    'billing_checkout_attempts': ({'billing_checkout_attempts': ('attempt_id', 'profile_id', 'livemode', 'offer_id', 'created_at'), 'profiles': PROFILE}, ()),
    'limited_paid_purchase_history': ({'limited_paid_purchase_history': ('subscription_id', 'livemode', 'profile_id', 'first_verified_paid_at', 'offer_id',
                                                                         'price_phase', 'annual_cents'), 'profiles': PROFILE}, ()),
    'access_purchase_receipts': ({'access_purchase_receipts': ('subscription_id', 'livemode', 'profile_id', 'price_phase', 'annual_cents', 'paid_at'),
                                  'profiles': PROFILE}, ()),
    'billing_subscriptions': ({'billing_subscriptions': ('subscription_id', 'livemode', 'profile_id', 'offer_id', 'status', 'updated_at'),
                               'profiles': PROFILE}, ()),
    'lifetime_gift_reservations': ({'lifetime_gift_reservations': ('id', 'email', 'livemode', 'claimed_profile_id', 'claimed_at'), 'profiles': PROFILE}, ()),
    'invite_to_join_sends': ({'invite_to_join_sends': ('id', 'email', 'name', 'status', 'explicit_resend', 'offer_phase', 'offer_annual_cents',
                                                       'created_at', 'sent_at', 'updated_at')}, ()),
    'limited_refund_requests': ({'limited_refund_requests': ('id', 'profile_id', 'livemode', 'amount_cents', 'state', 'subscription_canceled_at',
                                                             'refund_id', 'refund_status', 'error_code', 'requested_at', 'updated_at'), 'profiles': PROFILE}, ()),
}
OPTIONAL = tuple(OPTIONAL_PARTS)
PARTS = {**CORE, **OPTIONAL_PARTS}

SIGNUP_KINDS = ('waitlist', 'founding', 'app profile', 'FAILED ATTEMPT')
ACTIVITY_PREFIXES = ('TICKET', 'CLIENT', 'BETA', 'guide only', 'FEEDBACK')
MONEY = {
    'PAID': ('paid', 'paid'),
    'CHECKOUT STARTED': ('checkout started', 'checkouts started'),
    'SUBSCRIPTION ACTIVE': ('subscription active without a recorded payment', 'subscriptions active without a recorded payment'),
    'LIFETIME GIFT CLAIMED': ('lifetime gift claimed', 'lifetime gifts claimed'),
    'INVITE SENT': ('invitation sent', 'invitations sent'),
    'INVITE UNCONFIRMED': ('invitation unconfirmed', 'invitations unconfirmed'),
    'INVITE FAILED': ('invitation failed', 'invitations failed'),
    'REFUND NEEDS SUPPORT': ('refund needing you', 'refunds needing you'),
    'REFUND UNFINISHED': ('refund unfinished', 'refunds unfinished'),
}


class Refused(Exception):
    pass


# ─── Files: owner-only, never through a symlink ────────────────────────────

def owner_only_dir(path):
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Refused(f'{path} must be an owner-only directory')


def open_private(path, flags, create=False):
    fd = os.open(path, flags | os.O_NOFOLLOW | (os.O_CREAT if create else 0), 0o600)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        os.close(fd)
        raise Refused(f'{os.path.basename(path)} must be a regular file only its owner can read')
    return fd


def read_private(path):
    try:
        fd = open_private(path, os.O_RDONLY)
    except FileNotFoundError:
        return None
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise Refused(f'{os.path.basename(path)} is a symlink') from error
        raise
    with os.fdopen(fd, 'rb') as handle:
        return handle.read().decode('utf-8', 'replace')


def append_private(path, text):
    fd = open_private(path, os.O_WRONLY | os.O_APPEND, create=True)
    try:
        os.write(fd, text.encode())
        os.fsync(fd)
    finally:
        os.close(fd)


def write_private(path, text):
    temporary = f'{path}.{os.getpid()}.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, text.encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)


# ─── The ticket runner's alert queue ───────────────────────────────────────

def queued_alerts(text):
    """Complete, well-formed lines only. A last line with no newline is an
    append still in progress: it is read on the next run."""
    entries, skipped, seen = [], 0, set()
    for line in text.split('\n')[:-1]:
        try:
            entry = json.loads(line)
            ok = (isinstance(entry, dict) and entry.get('v') == 1 and UUID.match(str(entry.get('id', '')))
                  and AT.match(str(entry.get('at', ''))) and KIND.match(str(entry.get('kind', '')))
                  and isinstance(entry.get('message'), str) and 0 < len(entry['message']) <= 1000)
        except ValueError:
            ok = False
        if not ok:
            skipped += bool(line.strip())
            continue
        if entry['id'] in seen:
            continue
        seen.add(entry['id'])
        entries.append(entry)
    return entries, skipped


def local_time(at):
    moment = dt.datetime.strptime(at[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=dt.timezone.utc).astimezone()
    return moment.strftime('%b %d %H:%M').replace(' 0', ' ')


def clean(text):
    return re.sub(r'[\x00-\x1f\x7f]+', ' ', text).strip()


def alert_message(batch, remaining):
    if len(batch) == 1 and not remaining:
        entry = batch[0]
        return f"{clean(entry['message'])} (raised {local_time(entry['at'])})"
    lines = [f'CredentialDOMD ticket agent: {len(batch) + remaining} alerts']
    for entry in batch:
        text = clean(entry['message'])
        lines.append(f"• {local_time(entry['at'])}: {text[len(PREFIX):] if text.startswith(PREFIX) else text}")
    if remaining:
        lines.append(f'{remaining} more on the next run.')
    return '\n'.join(lines)


# The drain is three steps because the send between them is the job's own
# (see drain-mark in the module notes): signup-notify.sh takes the lock this
# returns, runs drain-prepare, sends the message itself, then runs drain-mark,
# and holds the lock across all three so two drains never send one batch.

def drain_lock(state):
    """The lock file's path, or None when there is nothing to drain."""
    try:
        owner_only_dir(state)
    except FileNotFoundError:
        return None
    if read_private(os.path.join(state, QUEUE)) is None:
        return None
    os.close(open_private(os.path.join(state, LOCK), os.O_RDWR, create=True))
    return os.path.join(state, LOCK)


def prepare_drain(state, limit=DRAIN_MAX):
    """Under the job's lock: the message for the pending alerts ('' for none),
    with their ids and kinds written to BATCH for drain-mark."""
    owner_only_dir(state)
    batch_file = os.path.join(state, BATCH)
    text = read_private(os.path.join(state, QUEUE)) or ''
    sent_ids = set((read_private(os.path.join(state, SENT)) or '').split())
    entries, skipped = queued_alerts(text)
    pending = [e for e in entries if e['id'] not in sent_ids]
    if skipped:
        print(f'owner alerts: {skipped} unreadable queue line(s) skipped', file=sys.stderr)
    if not pending:
        # A batch left by a run whose send failed is not this run's.
        try:
            os.unlink(batch_file)
        except FileNotFoundError:
            pass
        return ''
    batch, remaining = pending[:limit], len(pending) - min(len(pending), limit)
    write_private(batch_file, json.dumps({'v': 1, 'ids': [e['id'] for e in batch], 'kinds': [e['kind'] for e in batch],
                                          'remaining': remaining}) + '\n')
    return alert_message(batch, remaining)


def mark_drained(state):
    """After the job delivered drain-prepare's message: its ids are sent."""
    owner_only_dir(state)
    batch_file = os.path.join(state, BATCH)
    text = read_private(batch_file)
    if text is None:
        raise RuntimeError('no prepared batch to mark sent')
    batch = json.loads(text)
    ids, kinds, remaining = batch.get('ids'), batch.get('kinds'), batch.get('remaining')
    if (batch.get('v') != 1 or not isinstance(ids, list) or not ids or not isinstance(kinds, list) or len(kinds) != len(ids)
            or not all(isinstance(i, str) and UUID.match(i) for i in ids)
            or not all(isinstance(k, str) and KIND.match(k) for k in kinds)
            or not isinstance(remaining, int) or remaining < 0):
        raise Refused(f'{BATCH} is not a batch drain-prepare wrote')
    append_private(os.path.join(state, SENT), ''.join(f'{i}\n' for i in ids))
    os.unlink(batch_file)
    print(f"owner alerts: sent {len(ids)} ({', '.join(k + ' ' + i[:8] for k, i in zip(kinds, ids))})"
          + (f', {remaining} still queued' if remaining else ''))
    return ids


# ─── The activity query ────────────────────────────────────────────────────

def probe_sql():
    """One row per part: the columns and functions it reads that are missing,
    and whether its own table exists."""
    needs = []
    for part, (tables, functions) in PARTS.items():
        needs += [(part, t, c) for t, columns in tables.items() for c in columns] + [(part, f, None) for f in functions]
    values = ',\n    '.join(f"({n}, '{part}', '{obj}', " + (f"'{col}')" if col else 'null)') for n, (part, obj, col) in enumerate(needs))
    return f"""select part, coalesce(array_agg(need order by n) filter (where not ok), '{{}}') as missing,
  to_regclass('public.' || part) is not null as table_exists
from (select n, part, case when col is null then obj else obj || '.' || col end as need,
    case when col is null then to_regprocedure(obj) is not null
      else exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || obj) and a.attname = col
                   and a.attnum > 0 and not a.attisdropped) end as ok
  from (values
    {values}) as v(n, part, obj, col)) r
group by part order by min(n)"""


def probe_result(rows):
    """{part: (missing, table_exists)} for every part, from the probe's rows."""
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise ValueError('unusable probe result')
    result = {}
    for row in rows:
        part, missing, exists = row.get('part'), row.get('missing'), row.get('table_exists')
        if (part not in PARTS or part in result or not isinstance(missing, list)
                or not all(isinstance(m, str) for m in missing) or not isinstance(exists, bool)):
            raise ValueError('unusable probe result')
        result[part] = (missing, exists)
    if set(result) != set(PARTS):
        raise ValueError('unusable probe result: parts missing')
    return result


def present_tables(rows):
    """The optional parts that can run. A core part that cannot fails the run;
    an optional part whose columns changed is named on stderr."""
    result = probe_result(rows)
    broken = [f"{part} ({', '.join(result[part][0])})" for part in CORE if result[part][0]]
    if broken:
        raise ValueError(f"the activity query cannot run, columns or functions missing: {'; '.join(broken)}")
    for part in drifted_tables(rows):
        print(f"signup-notify: {part} is not reported until the notifier matches its columns"
              f" (missing {', '.join(result[part][0])})", file=sys.stderr)
    return [part for part in OPTIONAL if not result[part][0]]


def drifted_tables(rows):
    """Optional parts whose table exists but which cannot run."""
    result = probe_result(rows)
    return [part for part in OPTIONAL if result[part][1] and result[part][0]]


def offer(column):
    return f"(case {column} when 'core_locum' then 'Core + Locum' when 'core' then 'Core' else coalesce({column}, '') end)"


def price(phase, cents):
    return f"{phase} || ', $' || ({cents} / 100)::text || '/yr'"


def mode(live):
    return f"(case when {live} then '' else ' (test mode)' end)"


def person(alias):
    return f"coalesce({alias}.name, '') as name, coalesce({alias}.email, '') as email"


def query_sql(since, present, now=None):
    if not SINCE.match(since or ''):
        raise ValueError('--since must be a UTC time like 2026-09-29T12:00:00Z')
    if now is not None and not SINCE.match(now):
        raise ValueError('--now must be a UTC time like 2026-09-29T12:10:00Z')
    has = set(present)
    unknown = has - set(OPTIONAL)
    if unknown:
        raise ValueError(f'unknown optional table {sorted(unknown)[0]}')
    upto = (lambda column: f" and {column} <= '{now}'") if now else (lambda column: '')
    s = f"'{since}'"
    back = f"now() - interval '{LOOKBACK_DAYS} days'"
    parts = [
        f"""select case when waitlist then 'waitlist' else 'guide only' end as kind, coalesce(name,'') as name, coalesce(email,'') as email,
  coalesce(source,'') as extra, created_at, null::text as key from early_access_leads where created_at > {s}{upto('created_at')}""",
        f"select 'founding', coalesce(name,''), coalesce(email,''), '', created_at, null from founding_signups where created_at > {s}{upto('created_at')}",
        f"select 'app profile', coalesce(name,''), coalesce(email,''), '', created_at, null from profiles where created_at > {s}{upto('created_at')}",
        # An attempt is judged 3 minutes after it was made (its lead may still
        # be on the way): the window is shifted, not cut.
        f"""select 'FAILED ATTEMPT', coalesce(a.name,''), coalesce(a.email,''), coalesce(a.stage,''), a.created_at, null
  from waitlist_attempts a
  where a.created_at > {s}::timestamptz - interval '3 minutes'
    and a.created_at <= {f"'{now}'::timestamptz" if now else 'now()'} - interval '3 minutes'
    and not exists (select 1 from early_access_leads l where lower(l.email)=lower(a.email)
                    and l.created_at between a.created_at - interval '15 minutes' and a.created_at + interval '15 minutes')""",
        f"""select 'TICKET', {person('p')}, left(coalesce(t.subject,''),80), t.created_at, null
  from support_tickets t left join profiles p on p.id = t.user_id
  where t.created_at > {s}{upto('t.created_at')} and not public.is_admin(t.user_id)""",
        # A member's reply only. Never a support reply: one the checked path
        # verified, one signed "CredentialDOMD Support" (the agent's replies are
        # stored with the ticket owner as author), or one marked as an admin
        # reply. Each of these raised a false [TICKET REPLY] before 2026-09-29.
        f"""select 'TICKET REPLY', {person('p')}, left(coalesce(t.subject,''),40) || ': ' || left(regexp_replace(m.body, '\\s+', ' ', 'g'),80), m.created_at, null
  from support_messages m join support_tickets t on t.id = m.ticket_id left join profiles p on p.id = m.author_id
  where m.created_at > {s}{upto('m.created_at')} and m.author_id is not null
    and (to_jsonb(m)->>'support_actor_id') is null and not public.is_admin(m.author_id)
    and (to_jsonb(m)->>'verification_id') is null
    and coalesce(m.body, '') not ilike 'CredentialDOMD Support%'
    and coalesce((to_jsonb(m)->>'is_admin_reply')::boolean, false) = false""",
        # kind 'info' is an event, not a fault (a page the browser discarded):
        # said as such (migration 20261002080000).
        f"""select case when e.kind = 'info' then 'CLIENT EVENT' else 'CLIENT ERROR' end, coalesce(p.name, e.auth_user_id, 'signed-out'), coalesce(p.email,''), e.kind || ': ' || left(regexp_replace(e.message, '\\s+', ' ', 'g'),90), e.created_at, null
  from client_errors e left join profiles p on p.auth_user_id = e.auth_user_id
  where e.created_at > {s}{upto('e.created_at')}""",
        f"select 'BETA JOINED', coalesce(name,''), coalesce(email,''), '', activated_at, null from beta_access where activated_at > {s}{upto('activated_at')}",
        # An invitation sent through Admin > Users (send-invite).
        f"""select 'INVITE SENT', {person('b')}, 'beta invitation', b.invite_sent_at, 'beta-invite:' || b.id::text || ':' || b.invite_sent_at::text
  from beta_access b where b.invite_sent_at > {back}""",
    ]
    if 'feedback' in has:
        parts.append(f"""select 'FEEDBACK', {person('p')},
  coalesce(f.rating::text || '/5 ', '') || coalesce('(' || nullif(left(f.context_page, 40), '') || ') ', '') || left(regexp_replace(f.message, '\\s+', ' ', 'g'), 80),
  f.created_at, null
  from feedback f left join profiles p on p.id = f.user_id
  where f.created_at > {s}{upto('f.created_at')} and not public.is_admin(f.user_id)""")
    if 'limited_billing_quotes' in has:
        parts.append(f"""select 'CHECKOUT STARTED', {person('p')}, {offer('q.offer_id')} || ', ' || {price('q.price_phase', 'q.annual_cents')} || {mode('q.livemode')},
  q.created_at, 'checkout:' || q.attempt_id::text
  from limited_billing_quotes q left join profiles p on p.id = q.profile_id where q.created_at > {back}""")
    if 'billing_checkout_attempts' in has:
        # The same attempt as a quote above shares its key, so it is reported once.
        no_quote = (" and not exists (select 1 from limited_billing_quotes q where q.attempt_id = a.attempt_id)"
                    if 'limited_billing_quotes' in has else '')
        parts.append(f"""select 'CHECKOUT STARTED', {person('p')}, {offer('a.offer_id')} || {mode('a.livemode')},
  a.created_at, 'checkout:' || a.attempt_id::text
  from billing_checkout_attempts a left join profiles p on p.id = a.profile_id where a.created_at > {back}{no_quote}""")
    if 'limited_paid_purchase_history' in has:
        parts.append(f"""select 'PAID', {person('p')}, {offer('h.offer_id')} || ', ' || {price('h.price_phase', 'h.annual_cents')} || {mode('h.livemode')},
  h.first_verified_paid_at, 'paid:' || h.subscription_id || ':' || h.livemode::text
  from limited_paid_purchase_history h left join profiles p on p.id = h.profile_id where h.first_verified_paid_at > {back}""")
    if 'access_purchase_receipts' in has:
        # One subscription in both purchase tables shares its key: reported once.
        parts.append(f"""select 'PAID', {person('p')}, 'Core, ' || {price('r.price_phase', 'r.annual_cents')} || {mode('r.livemode')},
  r.paid_at, 'paid:' || r.subscription_id || ':' || r.livemode::text
  from access_purchase_receipts r left join profiles p on p.id = r.profile_id where r.paid_at > {back}""")
    if 'billing_subscriptions' in has:
        # Active with no verified payment in either purchase table: a state the
        # owner should see. A paid one is reported above as PAID.
        unpaid = ''.join(
            f" and not exists (select 1 from {t} x where x.subscription_id = s.subscription_id and x.livemode = s.livemode)"
            for t in ('limited_paid_purchase_history', 'access_purchase_receipts') if t in has)
        parts.append(f"""select 'SUBSCRIPTION ACTIVE', {person('p')}, {offer('s.offer_id')} || ', no verified payment recorded' || {mode('s.livemode')},
  s.updated_at, 'subscription:' || s.subscription_id || ':' || s.livemode::text
  from billing_subscriptions s left join profiles p on p.id = s.profile_id
  where s.updated_at > {back} and s.status = 'active'{unpaid}""")
    if 'lifetime_gift_reservations' in has:
        parts.append(f"""select 'LIFETIME GIFT CLAIMED', coalesce(p.name, ''), coalesce(p.email, g.email, ''), case when g.livemode then '' else 'test mode' end,
  g.claimed_at, 'gift:' || g.id::text
  from lifetime_gift_reservations g left join profiles p on p.id = g.claimed_profile_id where g.claimed_at > {back}""")
    if 'invite_to_join_sends' in has:
        # Invite to join: sent, refused by the provider, or never confirmed. A
        # send still 'sending' after 10 minutes belongs to a run that is gone
        # (the invite function marks it 'unknown' only on its next use); it
        # shares the 'unknown' key, so it is reported once either way.
        parts.append(f"""select case s.status when 'sent' then 'INVITE SENT' when 'failed' then 'INVITE FAILED' else 'INVITE UNCONFIRMED' end,
  coalesce(s.name, ''), coalesce(s.email, ''),
  {price('s.offer_phase', 's.offer_annual_cents')} || ' offer' || case when s.explicit_resend then ', sent again' else '' end
    || case s.status when 'sent' then '' when 'failed' then ', the email provider refused it' else ', no confirmation it went out' end,
  coalesce(s.sent_at, s.updated_at), 'invite:' || s.id::text || ':' || case s.status when 'sending' then 'unknown' else s.status end
  from invite_to_join_sends s
  where (s.status in ('sent', 'failed', 'unknown') or (s.status = 'sending' and s.created_at < now() - interval '10 minutes'))
    and coalesce(s.sent_at, s.updated_at) > {back}""")
    if 'limited_refund_requests' in has:
        # A refund the owner has to finish: needs_support (every path that
        # records it), cancelled and still not refunded REFUND_STUCK_MINUTES
        # later, or requested REFUND_STALLED_MINUTES ago and still not
        # cancelled. One key per row and standing, so a stuck row that later
        # needs support is reported again, once. A needs_support key also
        # carries a digest of why and of the refund it names (no provider id
        # in the key file), so a row that needs support again after it was
        # refunded (the owner's dashboard refund failed later) is reported
        # again, once, while the same stop is not. A row not cancelled yet
        # says so: refunding it is not enough, the membership still renews.
        at = f"'{now}'::timestamptz" if now else 'now()'
        parts.append(f"""select case r.state when 'needs_support' then 'REFUND NEEDS SUPPORT' else 'REFUND UNFINISHED' end, {person('p')},
  '$' || (r.amount_cents / 100)::text || ', '
    || case when r.state <> 'needs_support' and r.subscription_canceled_at is null then 'not cancelled yet, not refunded'
            when r.state <> 'needs_support' then 'cancelled, not refunded'
            when r.subscription_canceled_at is null then 'needs support, not cancelled yet'
            when r.refund_status in ('failed', 'canceled') then 'needs support, refund ' || r.refund_status
            else 'needs support' end
    || coalesce(' (' || r.error_code || ')', '') || ', row ' || left(r.id::text, 8) || {mode('r.livemode')},
  r.updated_at, 'refund:' || r.id::text || ':' || case when r.state = 'needs_support'
      then 'needs_support:' || left(md5(coalesce(r.error_code, '') || '|' || coalesce(r.refund_id, '') || '|' || coalesce(r.refund_status, '')), 12)
    when r.subscription_canceled_at is null then 'not_cancelled' else 'unfinished' end
  from limited_refund_requests r left join profiles p on p.id = r.profile_id
  where (r.state = 'needs_support' and r.updated_at > {back})
     or (r.state = 'requested' and r.subscription_canceled_at <= {at} - interval '{REFUND_STUCK_MINUTES} minutes')
     or (r.state = 'requested' and r.subscription_canceled_at is null and r.requested_at <= {at} - interval '{REFUND_STALLED_MINUTES} minutes')""")
    return '\nunion all '.join(parts) + '\norder by created_at'


# ─── The message ───────────────────────────────────────────────────────────

def load_seen(path):
    text = read_private(path)
    if not text:
        return {}
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError('the key file is not an object')
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def fresh_rows(rows, seen):
    """Rows not reported yet: every unkeyed row, and each key once."""
    out, keys = [], set()
    for row in rows:
        key = row.get('key')
        if key:
            if key in seen or key in keys:
                continue
            keys.add(key)
        out.append(row)
    return out


def who(row):
    name, email = (row.get('name') or '').strip(), (row.get('email') or '').strip()
    if name and email and name != email:
        return f'{name} ({email})'
    return name or email or '(no name)'


def message(rows):
    if not rows:
        return ''
    money = {}
    for row in rows:
        kind = row.get('kind') or ''
        if kind in MONEY:
            money[kind] = money.get(kind, 0) + 1
    if money:
        counts = [f'{n} {MONEY[k][0] if n == 1 else MONEY[k][1]}' for k, n in sorted(money.items(), key=lambda kv: list(MONEY).index(kv[0]))]
        others = len(rows) - sum(money.values())
        paid_side = any(not k.startswith('INVITE') for k in money)
        header = ('CredentialDOMD money: ' if paid_side else 'CredentialDOMD: ') + ', '.join(counts) + (f', plus {others} other' if others else '')
    elif any((row.get('kind') or '').startswith(ACTIVITY_PREFIXES) for row in rows):
        header = 'CredentialDOMD activity'
    else:
        header = 'CredentialDOMD signup' + ('s' if len(rows) > 1 else '')
    lines = [header]
    for row in rows:
        kind = row.get('kind') or ''
        extra = clean(row.get('extra') or '')
        sep = ' via ' if kind in SIGNUP_KINDS or kind == 'guide only' else ': '
        lines.append(f"• [{kind}] {clean(who(row))}{sep + extra if extra else ''}")
    return '\n'.join(lines)


def remember(rows, path, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    seen = load_seen(path)
    stamp = now.strftime('%Y-%m-%dT%H:%M:%SZ')
    for row in rows:
        if row.get('key'):
            seen.setdefault(row['key'], stamp)
    horizon = (now - dt.timedelta(days=REMEMBER_DAYS)).strftime('%Y-%m-%dT%H:%M:%SZ')
    kept = {k: v for k, v in seen.items() if v >= horizon}
    write_private(path, json.dumps(kept, sort_keys=True) + '\n')
    return kept


def read_rows():
    rows = json.loads(sys.stdin.read())
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise ValueError('unusable rows')
    return rows


def main(argv):
    command, args = (argv[0] if argv else ''), argv[1:]
    options = {}
    for i in range(0, len(args), 2):
        key = args[i]
        if not key.startswith('--') or i + 1 >= len(args):
            raise ValueError(f'unexpected argument {key}')
        options[key[2:]] = args[i + 1]
    if command.startswith('drain-'):
        state = options.get('state', '')
        if not os.path.isabs(state):
            raise ValueError(f'{command} needs an absolute --state')
        if command == 'drain-lock':
            lock = drain_lock(state)
            if lock:
                print(lock)
        elif command == 'drain-prepare':
            text = prepare_drain(state, int(options.get('max', DRAIN_MAX)))
            if text:
                print(text)
        elif command == 'drain-mark':
            mark_drained(state)
        else:
            raise ValueError(f'unknown command {command}')
    elif command == 'probe':
        print(probe_sql())
    elif command == 'present':
        print(','.join(present_tables(json.loads(sys.stdin.read()))))
    elif command == 'drifted':
        print(','.join(drifted_tables(json.loads(sys.stdin.read()))))
    elif command == 'query':
        present = [t for t in options.get('present', '').split(',') if t]
        print(query_sql(options.get('since', ''), present, options.get('now')))
    elif command == 'format':
        text = message(fresh_rows(read_rows(), load_seen(options['seen'])))
        if text:
            print(text)
    elif command == 'remember':
        remember(read_rows(), options['seen'])
    else:
        raise ValueError('usage: signup-notify.py drain-lock|drain-prepare|drain-mark|probe|present|drifted|query|format|remember ...')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Refused as error:
        print(f'signup-notify: refused: {error}', file=sys.stderr)
        sys.exit(3)
    except Exception as error:  # noqa: BLE001 - the shell logs one line and stops
        print(f'signup-notify: {error}', file=sys.stderr)
        sys.exit(1)
