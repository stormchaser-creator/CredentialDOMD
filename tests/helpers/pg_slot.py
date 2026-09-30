"""A machine-wide cap on the disposable PostgreSQL clusters tests start.

The same protocol as tests/helpers/pg-slot.mjs (read its header): every
running cluster, and initdb's bootstrap, takes one System V shared-memory
segment and macOS allows 32 for the whole machine, so every fixture, node or
python, in any worktree or sandbox, takes one of PG_TEST_SLOTS (default 12)
slots in PG_TEST_SLOT_DIR (default <realpath /tmp>/credentialdomd-pg-slots-<uid>)
before initdb and gives it back once its cluster is stopped.

    import pg_slot
    slot = pg_slot.acquire(root / 'data')   # before initdb
    ...
    finally:
        stop the cluster
        slot.release()

A slot still held at exit (normal, an exception, SIGTERM or SIGHUP) is
released then, after its cluster, if still running, is stopped. A record is
never trusted to name a live test process (see "stale" in pg-slot.mjs), and a
slot name is removed only under the directory's reclaim.lock, only while it
is still the file its remover judged. acquire() makes the empty data
directory and records its inode (dataIno); a reclaimer and release() remove
the System V segments that cluster's backends orphaned before the slot is
free (scripts/ticket-fix/pg-clusters.mjs has the node side and the why).
Import it with sys.dont_write_bytecode set, so no __pycache__ lands in tests/.
"""
import atexit
import ctypes
import json
import os
import random
import re
import secrets
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

DEFAULT_SLOTS = 12
DEFAULT_TIMEOUT_SECONDS = 600
START_TOLERANCE_MS = 3000
MAX_RECORD = 4096
GARBAGE_AGE_MS = 60 * 1000
MAX_OWNER_AGE_MS = 2 * 3600 * 1000
WAIT_NOTICE_SECONDS = 30
STOP_WAIT_SECONDS = 15
LOCK_NAME = 'reclaim.lock'
LOCK_STALE_MS = 10 * 1000
LOCK_WAIT_SECONDS = 1.0
LINUX_TICKS = 100
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
SLOT_NAME = re.compile(r'^slot-(\d+)$')
LEFTOVER = re.compile(r'^\.(?:tmp|stale)-(\d+)-[0-9a-f]+$')
OWNER_PROGRAM = re.compile(r'(?:^|/)(?:node|nodejs|python[0-9.]*|Python)(?:\s|$)')
PS_ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'TZ': 'UTC'}
KEY_SPAN = 10
INODE = re.compile(r'^\d{1,20}$')


def default_slot_dir():
    tmp = os.path.realpath('/tmp') if os.path.isdir('/tmp') else tempfile.gettempdir()
    return os.path.join(tmp, f'credentialdomd-pg-slots-{os.getuid()}')


def slot_dir():
    return os.environ.get('PG_TEST_SLOT_DIR') or default_slot_dir()


def slot_count():
    text = os.environ.get('PG_TEST_SLOTS', '')
    if text == '':
        return DEFAULT_SLOTS
    try:
        n = int(text)
    except ValueError:
        n = 0
    if str(n) != text.strip() or not 1 <= n <= 1000:
        raise ValueError(f'PG_TEST_SLOTS must be a whole number from 1 to 1000, not {text!r}')
    return n


def slot_timeout():
    text = os.environ.get('PG_TEST_SLOT_TIMEOUT', '')
    if text == '':
        return float(DEFAULT_TIMEOUT_SECONDS)
    try:
        n = float(text)
    except ValueError:
        n = 0
    if not n > 0 or n == float('inf'):
        raise ValueError(f'PG_TEST_SLOT_TIMEOUT must be a positive number of seconds, not {text!r}')
    return n


def running(pid):
    """Whether a process of this user runs. EPERM is another user's process
    (pid 1 is launchd's), never a slot owner nor one of our clusters."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, OverflowError, ValueError, TypeError):
        return False


_libc = None


def _sysctl(mib):
    """Bytes of a darwin sysctl, or None (works inside the runner's sandbox)."""
    global _libc
    try:
        if _libc is None:
            _libc = ctypes.CDLL(None, use_errno=True)
        name = (ctypes.c_int * len(mib))(*mib)
        size = ctypes.c_size_t(0)
        if _libc.sysctl(name, len(mib), None, ctypes.byref(size), None, 0) != 0 or not size.value:
            return None
        buffer = ctypes.create_string_buffer(size.value)
        if _libc.sysctl(name, len(mib), buffer, ctypes.byref(size), None, 0) != 0 or not size.value:
            return None
        return buffer.raw[:size.value]
    except (OSError, AttributeError, ValueError):
        return None


def _linux_start(pid):
    try:
        with open(f'/proc/{pid}/stat') as handle:
            stat = handle.read()
        ticks = int(stat[stat.rindex(')') + 2:].split(' ')[19])
        with open('/proc/stat') as handle:
            boot = int(re.search(r'^btime (\d+)$', handle.read(), re.M).group(1))
        return round((boot + ticks / LINUX_TICKS) * 1000)
    except (OSError, ValueError, AttributeError, IndexError):
        return None


def process_start(pid):
    """When a process started (epoch ms), or None when that cannot be told."""
    if sys.platform.startswith('linux'):
        return _linux_start(pid)
    if sys.platform == 'darwin':
        raw = _sysctl([1, 14, 1, pid])  # CTL_KERN, KERN_PROC, KERN_PROC_PID: kinfo_proc
        if raw and len(raw) >= 16:
            seconds, micro = struct.unpack_from('<qi', raw, 0)  # kp_proc.p_starttime
            return seconds * 1000 + micro // 1000
    try:
        out = subprocess.run(['/bin/ps', '-o', 'lstart=', '-p', str(pid)], capture_output=True, text=True, env=PS_ENV, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r'^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$', out.stdout)
    if out.returncode or not m or m.group(1) not in MONTHS:
        return None
    moment = datetime(int(m.group(6)), MONTHS.index(m.group(1)) + 1, int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)), tzinfo=timezone.utc)
    return int(moment.timestamp() * 1000)


def process_command(pid):
    """A process's arguments joined by spaces, or None."""
    if sys.platform.startswith('linux'):
        try:
            with open(f'/proc/{pid}/cmdline', 'rb') as handle:
                return handle.read().rstrip(b'\0').decode('utf-8', 'replace').replace('\0', ' ')
        except OSError:
            return None
    if sys.platform == 'darwin':
        raw = _sysctl([1, 49, pid])  # KERN_PROCARGS2: argc, exec path, padding, argv
        if raw and len(raw) > 4:
            argc = struct.unpack_from('<i', raw, 0)[0]
            rest = raw[4:]
            rest = rest[rest.find(b'\0'):].lstrip(b'\0') if b'\0' in rest else b''
            args = rest.split(b'\0')[:argc]
            if argc > 0 and len(args) == argc:
                return ' '.join(a.decode('utf-8', 'replace') for a in args)
    try:
        out = subprocess.run(['/bin/ps', '-o', 'command=', '-p', str(pid)], capture_output=True, text=True, env=PS_ENV, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else None


def process_info(pid):
    """(start epoch ms, command line), each None when it cannot be told."""
    return process_start(pid), process_command(pid)


def _own_start():
    # None when unknown: never a guess, which would make a live owner look
    # like a reused pid.
    return process_start(os.getpid())


def _read_small(path):
    """(text, inode) of a small regular file, never following a link or
    blocking on a pipe; None otherwise."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not (st.st_mode & 0o170000 == 0o100000) or st.st_size > MAX_RECORD:
            return None
        return os.read(fd, MAX_RECORD).decode('utf-8', 'replace'), st.st_ino
    except OSError:
        return None
    finally:
        os.close(fd)


def _inspect(path):
    """None when free, else the name's inode, kind, age, text and record."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    mode = st.st_mode & 0o170000
    kind = 'file' if mode == 0o100000 else 'dir' if mode == 0o040000 else 'other'
    seen = {'ino': st.st_ino, 'kind': kind, 'age': time.time() * 1000 - st.st_mtime * 1000, 'text': None, 'record': None}
    read = _read_small(path) if kind == 'file' else None
    if read and read[1] == st.st_ino:
        seen['text'] = read[0]
        try:
            record = json.loads(read[0])
            if isinstance(record, dict):
                seen['record'] = record
        except ValueError:
            pass
    return seen


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float('inf')


def owner_gone(record, info=None, now=None):
    """Whether a record's owner is gone: see "stale" in pg-slot.mjs. info:
    the owner's (start, command), and now (epoch ms), for tests."""
    pid = record.get('pid')
    if not isinstance(pid, int) or isinstance(pid, bool) or pid < 1 or not running(pid):
        return True
    if not _number(record.get('start')):
        return True
    start, command = info if info is not None else process_info(pid)
    if start is not None and abs(start - record['start']) > START_TOLERANCE_MS:
        return True
    start = start if start is not None else record['start']
    now = time.time() * 1000 if now is None else now
    if now - start > MAX_OWNER_AGE_MS or start - now > START_TOLERANCE_MS:
        return True
    if command is not None and not OWNER_PROGRAM.search(command):
        return True
    return False


_owner_gone = owner_gone


def _marker(data_dir):
    return f'{data_dir}.pg-slot'


def _cluster_of(record, own):
    """('none'|'running'|'unknown', pid): see clusterOf in pg-slot.mjs."""
    data_dir = record.get('dataDir')
    token = record.get('token')
    if not isinstance(data_dir, str) or not os.path.isabs(data_dir) or not isinstance(token, str):
        return 'none', None
    marker = _read_small(_marker(data_dir))
    if not marker or marker[0].strip() != token:
        return 'none', None
    pidfile = _read_small(os.path.join(data_dir, 'postmaster.pid'))
    try:
        pid = int(pidfile[0].split('\n')[0]) if pidfile else 0
    except ValueError:
        pid = 0
    if pid <= 1 or pid == os.getpid() or not running(pid):
        return 'none', None
    command = process_command(pid)
    if command is None:
        return ('running', pid) if own else ('unknown', None)
    program = command.split(' ')[0]
    names = re.search(r'(?:^|/)(?:postgres|postmaster)$', program) and (f' -D {data_dir} ' in command or command.endswith(f' -D {data_dir}'))
    return ('running', pid) if names else ('none', None)


def _directory_inode(path):
    """A directory's inode as a decimal string, or None (not a real directory)."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    return str(st.st_ino) if st.st_mode & 0o170000 == 0o040000 else None


def _cluster_inodes(record):
    """The inodes a record's cluster keyed its segments on: clusterInodes in
    pg-clusters.mjs."""
    out = []
    ino = record.get('dataIno')
    if isinstance(ino, str) and INODE.match(ino):
        out.append(ino)
    data_dir = record.get('dataDir')
    token = record.get('token')
    if isinstance(data_dir, str) and os.path.isabs(data_dir) and isinstance(token, str):
        marker = _read_small(_marker(data_dir))
        if marker and marker[0].strip() == token:
            now = _directory_inode(data_dir)
            if now and now not in out:
                out.append(now)
    return out


def _sysv_segments():
    """[{id, key, nattch, mine, cpid, lpid}], or None: sysvSegments in pg-clusters.mjs."""
    uid = os.getuid()
    if sys.platform.startswith('linux'):
        try:
            with open('/proc/sysvipc/shm') as handle:
                rows = handle.read().strip().split('\n')
        except OSError:
            return None
        cols = rows[0].split()
        need = ['key', 'shmid', 'nattch', 'uid', 'cpid', 'lpid']
        if any(c not in cols for c in need):
            return None
        at = {c: cols.index(c) for c in need}
        out = []
        for row in rows[1:]:
            f = row.split()
            try:
                out.append({'id': int(f[at['shmid']]), 'key': int(f[at['key']]) & 0xffffffff, 'nattch': int(f[at['nattch']]),
                            'mine': int(f[at['uid']]) == uid, 'cpid': int(f[at['cpid']]), 'lpid': int(f[at['lpid']])})
            except (ValueError, IndexError):
                pass
        return out
    try:
        out = subprocess.run(['/usr/bin/ipcs', '-m', '-a'], capture_output=True, text=True, env=PS_ENV, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode:
        return None
    lines = out.stdout.split('\n')
    head = next((l for l in lines if re.match(r'^T\s+ID\s+KEY\s', l)), None)
    if head is None:
        return None
    cols = head.split()
    need = ['ID', 'KEY', 'OWNER', 'NATTCH', 'CPID', 'LPID']
    if any(c not in cols for c in need):
        return None
    at = {c: cols.index(c) for c in need}
    try:
        import pwd
        user = pwd.getpwuid(uid).pw_name
    except (ImportError, KeyError):
        user = None
    segments = []
    for line in lines:
        if not re.match(r'^m\s', line):
            continue
        f = line.split()
        if len(f) < len(cols):
            continue
        try:
            segments.append({'id': int(f[at['ID']]), 'key': int(f[at['KEY']], 16) & 0xffffffff, 'nattch': int(f[at['NATTCH']]),
                             'mine': f[at['OWNER']] in (user, str(uid)), 'cpid': int(f[at['CPID']]), 'lpid': int(f[at['LPID']])})
        except ValueError:
            pass
    return segments


def _alive(pid):
    return isinstance(pid, int) and pid > 0 and running(pid)


def _remove_orphan_segments(inodes):
    """Removes the segments orphaned by clusters keyed on these inodes:
    removeOrphanSegments in pg-clusters.mjs. Returns the ids removed."""
    keys = set()
    for ino in inodes:
        if isinstance(ino, str) and INODE.match(ino):
            keys.update(((int(ino) + i) & 0xffffffff) for i in range(KEY_SPAN))
    if not keys:
        return []
    segments = _sysv_segments()
    if not segments:
        return []
    removed = []
    for s in segments:
        if s['key'] not in keys or s['nattch'] != 0 or not s['mine'] or _alive(s['cpid']) or _alive(s['lpid']):
            continue
        try:
            if subprocess.run(['ipcrm', '-m', str(s['id'])], capture_output=True, env=PS_ENV, timeout=10).returncode == 0:
                removed.append(s['id'])
        except (OSError, subprocess.SubprocessError):
            pass
    return removed


def _stop_cluster(pid):
    try:
        os.kill(pid, signal.SIGQUIT)
    except OSError:
        pass
    until = time.time() + STOP_WAIT_SECONDS
    while running(pid) and time.time() < until:
        time.sleep(0.05)
    return not running(pid)


def _future(age_ms):
    """Dated in the future: more than the clock's granularity ahead."""
    return age_ms < -START_TOLERANCE_MS


def _garbage(seen):
    return seen['age'] > GARBAGE_AGE_MS or _future(seen['age'])


def _reclaimable(seen):
    record = seen['record']
    if record is None:
        return _garbage(seen)
    if not _owner_gone(record):
        return False
    state, pid = _cluster_of(record, False)
    if state == 'unknown':
        return False
    if state == 'running' and not _stop_cluster(pid):
        return False
    # The segments its backends orphaned, before the slot is anyone else's.
    try:
        _remove_orphan_segments(_cluster_inodes(record))
    except Exception:  # best effort
        pass
    return True


def _remove(path):
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path, ignore_errors=True)
        else:
            os.unlink(path)
    except OSError:
        pass


def _remove_if_same(path, seen):
    """Removes a name only if it is still exactly what was seen there."""
    now = _inspect(path)
    if not now or now['ino'] != seen['ino'] or now['kind'] != seen['kind'] or now['text'] != seen['text']:
        return False
    _remove(path)
    return True


def _lock_stale(seen):
    record = seen['record']
    pid = record.get('pid') if record else None
    return (record is None or seen['age'] > LOCK_STALE_MS or _future(seen['age'])
            or not isinstance(pid, int) or isinstance(pid, bool) or not running(pid))


def _under_lock(directory, fn, wait=LOCK_WAIT_SECONDS):
    """(True, fn()) holding the directory's lock, or (False, None) when a live
    holder kept it for `wait` seconds: see underLock in pg-slot.mjs."""
    lock = os.path.join(directory, LOCK_NAME)
    token = secrets.token_hex(16)
    draft = os.path.join(directory, f'.tmp-{os.getpid()}-{token}')
    fd = os.open(draft, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(json.dumps({'pid': os.getpid(), 'start': _own_start(), 'token': token, 'label': 'lock',
                                 'since': datetime.now(timezone.utc).isoformat()}) + '\n')
    held = False
    try:
        until = time.time() + wait
        delay = 0.002
        while True:
            try:
                os.link(draft, lock)
                held = True
                break
            except FileExistsError:
                pass
            seen = _inspect(lock)
            stale = bool(seen) and _lock_stale(seen)
            if stale:
                _remove_if_same(lock, seen)
            if time.time() >= until:
                break
            if not stale:
                time.sleep(delay)
                delay = min(0.05, delay * 2)
    finally:
        _remove(draft)
    if not held:
        return False, None
    try:
        return True, fn()
    finally:
        seen = _inspect(lock)
        if seen and seen['record'] and seen['record'].get('token') == token:
            _remove(lock)


def _reclaim(directory, path, seen):
    """Removes a stale slot, judged as seen, if it is still that."""
    held, removed = _under_lock(directory, lambda: _remove_if_same(path, seen))
    return held and removed


def _sweep(directory):
    try:
        names = os.listdir(directory)
    except OSError:
        return
    for name in names:
        m = LEFTOVER.match(name)
        if not m:
            continue
        path = os.path.join(directory, name)
        try:
            age = time.time() - os.lstat(path).st_mtime
            if not running(int(m.group(1))) or age > 24 * 3600 or _future(age * 1000):
                _remove(path)
        except OSError:
            pass


def _ensure_dir(directory):
    if not os.path.isabs(directory):
        raise RuntimeError(f'The PostgreSQL test slot directory must be an absolute path, not {directory}')
    try:
        os.makedirs(directory, mode=0o700, exist_ok=True)
    except OSError as error:
        raise RuntimeError(f'Cannot create the PostgreSQL test slot directory {directory} ({error.strerror}); '
                           'set PG_TEST_SLOT_DIR to a directory every test process on this machine can write') from error
    st = os.lstat(directory)
    if not (st.st_mode & 0o170000 == 0o040000) or st.st_uid != os.getuid() or st.st_mode & 0o022:
        raise RuntimeError(f'The PostgreSQL test slot directory {directory} is not a directory of this user that only it can write; set PG_TEST_SLOT_DIR')


_HELD = []
_hooked = False


def _release_all(*_):
    for slot in list(_HELD):
        try:
            slot.release()
        except Exception:  # exiting: best effort
            pass


def _on_signal(signum, frame):
    _release_all()
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


def _hook():
    global _hooked
    if _hooked:
        return
    _hooked = True
    atexit.register(_release_all)
    # SIGINT already ends in atexit (KeyboardInterrupt); SIGTERM and SIGHUP do
    # not. A handler the script installed itself is left alone.
    for signum in (signal.SIGTERM, signal.SIGHUP):
        try:
            if signal.getsignal(signum) == signal.SIG_DFL:
                signal.signal(signum, _on_signal)
        except (ValueError, OSError):  # not the main thread
            pass


class Slot:
    def __init__(self, directory, path, record):
        self.dir = directory
        self.file = path
        self.name = os.path.basename(path)
        self.record = record
        self.token = record['token']
        self.data_dir = record['dataDir']
        self.released = False
        if self.data_dir:
            try:
                fd = os.open(_marker(self.data_dir), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0), 0o600)
                with os.fdopen(fd, 'w') as handle:
                    handle.write(self.token + '\n')
            except OSError:
                pass
        _HELD.append(self)
        _hook()

    def release(self):
        """Gives the slot back once the cluster is stopped; a cluster of this
        slot still running is stopped first (immediate shutdown)."""
        if self.released:
            return
        self.released = True
        if self in _HELD:
            _HELD.remove(self)
        if self.data_dir:
            state, pid = _cluster_of(self.record, True)
            if state == 'running':
                _stop_cluster(pid)
            try:
                _remove_orphan_segments(_cluster_inodes(self.record))
            except Exception:  # best effort
                pass
        def mine():
            seen = _inspect(self.file)
            if seen and seen['record'] and seen['record'].get('token') == self.token:
                _remove_if_same(self.file, seen)
        try:
            held, _ = _under_lock(self.dir, mine)
            if not held:
                mine()
        except OSError:
            try:
                mine()
            except OSError:  # the directory is gone
                pass
        if self.data_dir:
            try:
                os.unlink(_marker(self.data_dir))
            except OSError:
                pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.release()


def holders(directory=None):
    directory = directory or slot_dir()
    try:
        names = [n for n in os.listdir(directory) if SLOT_NAME.match(n)]
    except OSError:
        return []
    out = []
    for name in sorted(names, key=lambda n: int(SLOT_NAME.match(n).group(1))):
        seen = _inspect(os.path.join(directory, name))
        record = (seen or {}).get('record') or {}
        out.append({'name': name, 'pid': record.get('pid'), 'label': record.get('label'), 'dataDir': record.get('dataDir'),
                    'seconds': round(seen['age'] / 1000) if seen else None})
    return out


def acquire(data_dir=None, *, label=None, slots=None, directory=None, timeout=None):
    """Waits for a slot. data_dir: the cluster's data directory, exactly as
    given to initdb and pg_ctl. The keyword arguments override the
    environment (timeout in seconds)."""
    directory = directory or slot_dir()
    slots = slots or slot_count()
    timeout = timeout if timeout is not None else slot_timeout()
    if data_dir is not None:
        data_dir = os.fspath(data_dir)
        if not os.path.isabs(data_dir):
            raise ValueError(f'pg_slot.acquire needs the cluster\'s absolute data directory, not {data_dir}')
    _ensure_dir(directory)
    _sweep(directory)
    token = secrets.token_hex(16)
    # The data directory, made now (empty, owner-only) when its parent
    # exists: its inode keys the cluster's segments.
    data_ino = None
    if data_dir is not None:
        try:
            os.mkdir(data_dir, 0o700)
        except OSError:
            pass
        data_ino = _directory_inode(data_dir)
    record = {'pid': os.getpid(), 'start': _own_start(), 'token': token,
              'label': label or (os.path.relpath(sys.argv[0]) if sys.argv and sys.argv[0] else 'python'),
              'dataDir': data_dir, 'since': datetime.now(timezone.utc).isoformat()}
    if data_ino:
        record['dataIno'] = data_ino
    draft = os.path.join(directory, f'.tmp-{os.getpid()}-{token}')
    fd = os.open(draft, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(json.dumps(record) + '\n')
    began = time.time()
    deadline = began + timeout
    noticed = False
    delay = 0.025
    try:
        while True:
            for _ in range(2):
                for i in range(slots):
                    path = os.path.join(directory, f'slot-{i}')
                    try:
                        os.link(draft, path)
                    except FileExistsError:
                        continue
                    _remove(draft)
                    return Slot(directory, path, record)
                freed = False
                for i in range(slots):
                    path = os.path.join(directory, f'slot-{i}')
                    seen = _inspect(path)
                    if seen and _reclaimable(seen) and _reclaim(directory, path, seen):
                        freed = True
                if not freed:
                    break
            if time.time() >= deadline:
                held = '; '.join(f"{h['name']}: pid {h['pid']} {h['label'] or '?'} for {h['seconds']} s" for h in holders(directory))
                raise TimeoutError(
                    f'No PostgreSQL test slot came free in {round(timeout)} s: all {slots} slots in {directory} are held ({held}). '
                    'Each disposable cluster takes a System V shared-memory segment and this machine has only kern.sysv.shmmni of them, '
                    'so every test process shares PG_TEST_SLOTS (default 12) slots. Wait for the other test runs, remove the slot files '
                    'of processes that no longer run, or raise PG_TEST_SLOT_TIMEOUT (seconds).')
            if not noticed and time.time() - began >= WAIT_NOTICE_SECONDS:
                noticed = True
                print(f'pg-slot: waiting for a PostgreSQL test slot; all {slots} in {directory} are held', file=sys.stderr, flush=True)
            time.sleep(min(delay * (0.75 + random.random() / 2), max(0.001, deadline - time.time())))
            delay = min(1.0, delay * 1.5)
    finally:
        _remove(draft)
