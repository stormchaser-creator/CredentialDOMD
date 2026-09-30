// The owner alert queue (2026-09-29). macOS refuses node's request to drive
// Messages, so the ticket runner's alerts were logged and never delivered.
// alert.mjs now queues every alert in its state directory before it tries the
// (bounded) direct send, and the signup notifier's launchd job, which may send
// iMessages, drains the queue. These tests run the real alert.mjs and the real
// drain against synthetic alerts: append, drain, idempotence, a failed send,
// partial lines, the lock and permissions.
//
// The drain's bookkeeping is signup-notify.py drain-lock, drain-prepare and
// drain-mark; the send between them is the job's own zsh (scripts/
// signup-notify.sh). The first version sent from python3, which macOS would
// have refused as it refused node: the job tests below check that the
// notifier's parent is the job's zsh, and hold the lock across the send.
// The stand-in notifier records its parent's pid ($PPID), which the test
// compares with the pid of the zsh it started itself: ps is denied inside the
// gates' sandbox, where `ps -o command=` printed nothing and failed every
// ticket run's suite (2026-09-29).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, rmSync, existsSync, realpathSync, lstatSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { raise, enqueue, markSent, queueSafe, QUEUE_FILE, SENT_FILE, DIRECT_SEND_SECONDS } from '../../scripts/ticket-fix/alert.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const DRAIN = path.join(root, 'scripts/signup-notify.py');
// The python3 binary itself, not a version manager's shim (a shell script that
// costs a fraction of a second on every call, and these tests make hundreds).
const python = (() => {
  const r = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || 'python3' : null;
})();
const zsh = existsSync('/bin/zsh') ? '/bin/zsh' : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const T8 = 'a1b2c3d4';

// Every temp path carries a space, like "Application Support".
function stateDir() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'owner alerts ')));
  const dir = path.join(base, 'ticket context');
  mkdirSync(dir, { mode: 0o700 });
  return { base, dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const lines = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const queue = dir => lines(path.join(dir, QUEUE_FILE)).map(line => JSON.parse(line));
const sentIds = dir => lines(path.join(dir, SENT_FILE));
const mode = file => statSync(file).mode & 0o777;
const quietly = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

// A stand-in for scripts/notify-owner.sh: records each message, or fails
// while a "fail" file exists next to it.
function fakeNotifier(base) {
  const notify = path.join(base, 'notify owner.sh');
  const record = path.join(base, 'sent messages.jsonl');
  writeFileSync(notify, `#!/bin/sh\n[ -e "${path.join(base, 'fail')}" ] && exit 1\nprintf '%s' "$1" | /usr/bin/python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' >> "${record}"\n`, { mode: 0o700 });
  return { notify, messages: () => lines(record).map(line => JSON.parse(line)), fail: on => (on ? writeFileSync(path.join(base, 'fail'), '') : rmSync(path.join(base, 'fail'), { force: true })) };
}

test('every alert is queued, owner-only, with ids and counts only', async () => {
  const state = stateDir();
  try {
    const now = Date.parse('2026-09-29T12:00:00Z');
    const delivered = await quietly(() => raise(state.dir, 'change_refused', `ticket=${T8} run=${T8}-0123456789abcdef`,
      `CredentialDOMD ticket agent: the change for ticket ${T8} was not merged.`, { send: async () => false, now }));
    assert.equal(delivered, false);
    const [entry] = queue(state.dir);
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'detail', 'id', 'kind', 'message', 'v']);
    assert.equal(entry.v, 1);
    assert.match(entry.id, UUID);
    assert.equal(entry.at, '2026-09-29T12:00:00.000Z');
    assert.equal(entry.kind, 'change_refused');
    assert.equal(entry.detail, `ticket=${T8} run=${T8}-0123456789abcdef`);
    assert.match(entry.message, /the change for ticket a1b2c3d4 was not merged/);
    assert.equal(mode(path.join(state.dir, QUEUE_FILE)), 0o600);
    assert.deepEqual(sentIds(state.dir), [], 'not delivered, so not marked sent');
    // The alerts log is still written, as before.
    assert.match(readFileSync(path.join(state.dir, 'alerts.log'), 'utf8'), /ALERT change_refused ticket=a1b2c3d4/);
  } finally { state.cleanup(); }
});

test('a direct send that goes out marks its queue entry sent at once', async () => {
  const state = stateDir();
  try {
    const got = [];
    assert.equal(await quietly(() => raise(state.dir, 'parked', `ticket=${T8} rejected_runs=3`, 'CredentialDOMD ticket agent: parked.', { send: async m => { got.push(m); return true; } })), true);
    assert.equal(got.length, 1);
    const [entry] = queue(state.dir);
    assert.deepEqual(sentIds(state.dir), [entry.id]);
    assert.equal(mode(path.join(state.dir, SENT_FILE)), 0o600);
    // Through a real notifier executable too.
    const fake = fakeNotifier(state.base);
    assert.equal(await quietly(() => raise(state.dir, 'merge_held', `ticket=${T8}`, 'CredentialDOMD ticket agent: held.', { notify: fake.notify })), true);
    assert.equal(fake.messages().length, 1);
    assert.equal(sentIds(state.dir).length, 2);
  } finally { state.cleanup(); }
});

test('the direct send cannot hang: a notifier that never returns is killed and the alert stays queued', async () => {
  const state = stateDir();
  try {
    assert.ok(DIRECT_SEND_SECONDS > 0 && DIRECT_SEND_SECONDS <= 30, 'bounded by default');
    const stuck = path.join(state.base, 'stuck notifier.sh');
    writeFileSync(stuck, '#!/bin/sh\nexec sleep 60\n', { mode: 0o700 });
    const started = Date.now();
    const printed = [];
    const log = console.log; console.log = m => printed.push(String(m));
    let delivered;
    try { delivered = await raise(state.dir, 'stale_lock', 'age_hours=5', 'CredentialDOMD ticket agent: lock held.', { notify: stuck, directTimeoutMs: 400 }); } finally { console.log = log; }
    assert.equal(delivered, false);
    assert.ok(Date.now() - started < 10000, `returned in ${Date.now() - started} ms`);
    assert.equal(queue(state.dir).length, 1);
    assert.deepEqual(sentIds(state.dir), []);
    assert.ok(printed.some(line => /stale_lock was not delivered directly; it is queued for the signup notifier's next run/.test(line)), printed.join('\n'));
  } finally { state.cleanup(); }
});

test('the queue never holds an email address, the home path or control characters', async () => {
  const state = stateDir();
  try {
    assert.equal(queueSafe(`merge failed for someone@example.test in ${os.homedir()}/Projects\nline two`), 'merge failed for [email removed] in ~/Projects line two');
    assert.equal(queueSafe('x'.repeat(2000)).length, 700);
    await enqueue(state.dir, { kind: 'release_failed', detail: `reason=someone@example.test`, message: `CredentialDOMD ticket agent: ${os.homedir()}/x failed for Someone@Example.Test` });
    const text = readFileSync(path.join(state.dir, QUEUE_FILE), 'utf8');
    assert.doesNotMatch(text, /example\.test/i);
    assert.ok(!text.includes(os.homedir()));
    await assert.rejects(enqueue(state.dir, { kind: 'Not A Kind', detail: '', message: 'x' }), /kind/);
  } finally { state.cleanup(); }
});

test('queue permissions: a loose file is tightened, a symlink is refused and the alert is still logged', async () => {
  const state = stateDir();
  try {
    writeFileSync(path.join(state.dir, QUEUE_FILE), '', { mode: 0o644 });
    chmodSync(path.join(state.dir, QUEUE_FILE), 0o644);
    await enqueue(state.dir, { kind: 'parked', detail: `ticket=${T8}`, message: 'CredentialDOMD ticket agent: parked.' });
    assert.equal(mode(path.join(state.dir, QUEUE_FILE)), 0o600);
    await markSent(state.dir, ['not-an-id']);
    assert.equal(existsSync(path.join(state.dir, SENT_FILE)), false, 'only ids are ever marked');

    const other = stateDir();
    try {
      const elsewhere = path.join(other.base, 'elsewhere.jsonl');
      writeFileSync(elsewhere, '', { mode: 0o600 });
      symlinkSync(elsewhere, path.join(other.dir, QUEUE_FILE));
      const printed = [];
      const log = console.log; console.log = m => printed.push(String(m));
      try { await raise(other.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked.', { send: async () => false }); } finally { console.log = log; }
      assert.equal(readFileSync(elsewhere, 'utf8'), '', 'nothing written through the symlink');
      assert.ok(printed.some(line => /parked could not be queued for the owner/.test(line)), printed.join('\n'));
      assert.match(readFileSync(path.join(other.dir, 'alerts.log'), 'utf8'), /ALERT parked/);
    } finally { other.cleanup(); }
  } finally { state.cleanup(); }
});

// The job finds python3 on PATH: the directory of the one these tests use.
function pythonBinDir() {
  return path.isAbsolute(python) && existsSync(path.join(path.dirname(python), 'python3')) ? path.dirname(python)
    : path.dirname(spawnSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim());
}

// The bookkeeping steps, as the job runs them.
const step = (command, dir, extra = []) => spawnSync(python, [DRAIN, command, '--state', dir, ...extra], { encoding: 'utf8', timeout: 60000 });

// A copy of the launchd job, in folders with spaces, next to a stand-in for
// notify-owner.sh that records each message and the pid of the process that
// started it. The keychain has no token here, so the job stops after the
// drain. Flag files make the stand-in fail, wait, or hang.
function jobCopy(base) {
  const scripts = path.join(base, 'job copy', 'scripts');
  const bin = path.join(base, 'shim bin');
  const home = path.join(base, 'home dir');
  for (const d of [scripts, bin, home]) mkdirSync(d, { recursive: true });
  for (const f of ['signup-notify.sh', 'signup-notify.py']) copyFileSync(path.join(root, 'scripts', f), path.join(scripts, f));
  const flag = name => path.join(base, `${name} flag`);
  const record = path.join(base, 'imessages.jsonl');
  writeFileSync(path.join(scripts, 'notify-owner.sh'), `#!/bin/sh
[ -e "${flag('fail')}" ] && exit 1
: > "${flag('started')}"
while [ -e "${flag('hold')}" ]; do sleep 0.1; done
[ -e "${flag('hang')}" ] && exec sleep 60
python3 -c 'import json,sys; print(json.dumps({"message": sys.argv[1], "parent": int(sys.argv[2])}))' "$1" "$PPID" >> "${record}"
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o755 });
  const pythonDir = pythonBinDir();
  const env = extra => ({ HOME: home, PATH: [bin, pythonDir, '/usr/bin', '/bin'].join(':'), LC_ALL: 'C', ...extra });
  const job = path.join(scripts, 'signup-notify.sh');
  const logFile = path.join(home, '.credentialdomd-signup-notify.log');
  return {
    job,
    run: (state, extra = {}) => spawnSync(zsh, [job], { env: env({ OWNER_ALERT_STATE: state, ...extra }), encoding: 'utf8', timeout: 60000 }),
    start: state => spawn(zsh, [job], { env: env({ OWNER_ALERT_STATE: state }), stdio: 'ignore' }),
    sent: () => lines(record).map(line => JSON.parse(line)),
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''),
    flag: (name, on) => (on ? writeFileSync(flag(name), '') : rmSync(flag(name), { force: true })),
    flagged: name => existsSync(flag(name)),
  };
}
async function until(check, ms = 20000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const pySkip = python ? false : 'python3 not found';
const jobSkip = !python ? 'python3 not found' : zsh ? false : 'the job runs under /bin/zsh, which is not installed here';

test('drain bookkeeping: prepare names the batch, mark records it, and a second prepare has nothing', { skip: pySkip }, async () => {
  const state = stateDir();
  try {
    await quietly(async () => {
      await raise(state.dir, 'parked', `ticket=${T8} rejected_runs=3`, `CredentialDOMD ticket agent: ticket ${T8} is parked after 3 rejected runs.`, { now: Date.parse('2026-09-29T12:00:00Z') });
      await raise(state.dir, 'change_refused', `ticket=${T8}`, `CredentialDOMD ticket agent: the change for ticket ${T8} was not merged.`, { now: Date.parse('2026-09-29T12:05:00Z') });
      // Delivered directly: already marked, never sent again.
      await raise(state.dir, 'merge_held', `ticket=${T8}`, 'CredentialDOMD ticket agent: held for you.', { send: async () => true });
    });
    const lock = step('drain-lock', state.dir);
    assert.equal(lock.status, 0, lock.stderr);
    assert.equal(lock.stdout.trim(), path.join(state.dir, 'owner-alerts.lock'));
    assert.equal(mode(path.join(state.dir, 'owner-alerts.lock')), 0o600);

    const prepared = step('drain-prepare', state.dir);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout.trim(), /^CredentialDOMD ticket agent: 2 alerts\n• .+: ticket a1b2c3d4 is parked after 3 rejected runs\.\n• .+: the change for ticket a1b2c3d4 was not merged\.$/);
    assert.doesNotMatch(prepared.stdout, /held for you/);
    assert.doesNotMatch(prepared.stdout, /\u2014/);
    const batch = path.join(state.dir, 'owner-alerts.batch');
    assert.equal(mode(batch), 0o600);
    assert.equal(sentIds(state.dir).length, 1, 'preparing marks nothing');

    const marked = step('drain-mark', state.dir);
    assert.equal(marked.status, 0, marked.stderr);
    assert.match(marked.stdout, /^owner alerts: sent 2 \(parked [0-9a-f]{8}, change_refused [0-9a-f]{8}\)$/m);
    assert.equal(existsSync(batch), false);
    assert.deepEqual(new Set(sentIds(state.dir)), new Set(queue(state.dir).map(e => e.id)));
    assert.equal(mode(path.join(state.dir, SENT_FILE)), 0o600);

    const again = step('drain-prepare', state.dir);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, '', 'idempotent: nothing is prepared twice');
    const unmarked = step('drain-mark', state.dir);
    assert.equal(unmarked.status, 1);
    assert.match(unmarked.stderr, /no prepared batch to mark sent/);

    // One new alert: alone, with the time it was raised.
    await quietly(() => raise(state.dir, 'stale_lock', 'age_hours=5', 'CredentialDOMD ticket agent: the run lock has been held 5 h.'));
    assert.match(step('drain-prepare', state.dir).stdout.trim(), /^CredentialDOMD ticket agent: the run lock has been held 5 h\. \(raised [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d\d\)$/);
  } finally { state.cleanup(); }
});

test('drain bookkeeping: an unsent batch is not marked by a later run, and a batch that is not ids is refused', { skip: pySkip }, async () => {
  const state = stateDir();
  try {
    await quietly(() => raise(state.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked.'));
    const batch = path.join(state.dir, 'owner-alerts.batch');
    assert.equal(step('drain-prepare', state.dir).status, 0);
    assert.ok(existsSync(batch));
    // The send failed, and the alert went out directly before the next run.
    await markSent(state.dir, queue(state.dir).map(e => e.id));
    assert.equal(step('drain-prepare', state.dir).stdout, '');
    assert.equal(existsSync(batch), false, 'the stale batch is gone');

    await quietly(() => raise(state.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked again.'));
    assert.equal(step('drain-prepare', state.dir).status, 0);
    writeFileSync(batch, JSON.stringify({ v: 1, ids: ['../../etc/passwd'], kinds: ['parked'], remaining: 0 }), { mode: 0o600 });
    const tampered = step('drain-mark', state.dir);
    assert.equal(tampered.status, 3);
    assert.match(tampered.stderr, /refused: owner-alerts\.batch is not a batch drain-prepare wrote/);
    assert.equal(sentIds(state.dir).length, 1, 'nothing appended');
  } finally { state.cleanup(); }
});

test('drain bookkeeping: a line still being appended waits, a malformed line is skipped, and at most 10 go per message', { skip: pySkip }, async () => {
  const state = stateDir();
  try {
    for (let i = 0; i < 12; i++) await enqueue(state.dir, { kind: 'parked', detail: `ticket=${T8}`, message: `CredentialDOMD ticket agent: alert ${i}.`, now: Date.parse('2026-09-29T12:00:00Z') + i * 60000 });
    const file = path.join(state.dir, QUEUE_FILE);
    const partial = JSON.stringify({ v: 1, id: '00000000-0000-4000-8000-000000000077', at: '2026-09-29T13:00:00.000Z', kind: 'parked', detail: '', message: 'CredentialDOMD ticket agent: late.' });
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n${partial.slice(0, 40)}`, { mode: 0o600 });
    const first = step('drain-prepare', state.dir);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /1 unreadable queue line\(s\) skipped/);
    assert.match(first.stdout, /^CredentialDOMD ticket agent: 12 alerts\n/);
    assert.match(first.stdout.trim(), /\n2 more on the next run\.$/);
    assert.match(step('drain-mark', state.dir).stdout, /sent 10 .*, 2 still queued/);
    // The append completes.
    writeFileSync(file, `${readFileSync(file, 'utf8')}${partial.slice(40)}\n`, { mode: 0o600 });
    const second = step('drain-prepare', state.dir);
    assert.match(second.stdout, /^CredentialDOMD ticket agent: 3 alerts\n/);
    assert.match(second.stdout.trim(), /alert 10\.\n.*alert 11\.\n.*late\.$/);
    assert.equal(step('drain-mark', state.dir).status, 0);
    assert.equal(sentIds(state.dir).length, 13);
  } finally { state.cleanup(); }
});

test('drain bookkeeping: refuses a queue other users could reach, and does nothing without a state directory or a queue', { skip: pySkip }, async () => {
  const state = stateDir();
  try {
    assert.equal(step('drain-lock', state.dir).stdout, '', 'no queue yet: nothing to lock');
    assert.equal(existsSync(path.join(state.dir, 'owner-alerts.lock')), false);
    await quietly(() => raise(state.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked.'));
    chmodSync(path.join(state.dir, QUEUE_FILE), 0o644);
    for (const command of ['drain-lock', 'drain-prepare']) {
      const loose = step(command, state.dir);
      assert.equal(loose.status, 3, command);
      assert.match(loose.stderr, /refused: owner-alerts\.jsonl must be a regular file only its owner can read/);
    }
    chmodSync(path.join(state.dir, QUEUE_FILE), 0o600);
    chmodSync(state.dir, 0o755);
    for (const command of ['drain-lock', 'drain-prepare', 'drain-mark']) {
      const openDir = step(command, state.dir);
      assert.equal(openDir.status, 3, command);
      assert.match(openDir.stderr, /must be an owner-only directory/);
    }
    chmodSync(state.dir, 0o700);
    // A symlinked queue (or sent file) is refused, never followed.
    const real = path.join(state.base, 'real queue.jsonl');
    writeFileSync(real, readFileSync(path.join(state.dir, QUEUE_FILE)), { mode: 0o600 });
    rmSync(path.join(state.dir, QUEUE_FILE));
    symlinkSync(real, path.join(state.dir, QUEUE_FILE));
    const linked = step('drain-prepare', state.dir);
    assert.equal(linked.status, 3, linked.stderr);
    assert.match(linked.stderr, /symlink/);
    assert.equal(linked.stdout, '', 'nothing to send from a refused queue');
    assert.ok(lstatSync(path.join(state.dir, QUEUE_FILE)).isSymbolicLink());
    const missing = step('drain-lock', path.join(state.base, 'no such dir'));
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.stdout, '');
    assert.equal(step('drain-lock', 'relative dir').status, 1, 'an absolute --state only');
  } finally { state.cleanup(); }
});

test('the job drains: its own zsh starts the notifier (python3 never does), one message, marked sent, never twice', { skip: jobSkip }, async () => {
  const state = stateDir();
  try {
    const copy = jobCopy(state.base);
    await quietly(async () => {
      await raise(state.dir, 'parked', `ticket=${T8} rejected_runs=3`, `CredentialDOMD ticket agent: ticket ${T8} is parked after 3 rejected runs.`);
      await raise(state.dir, 'change_refused', `ticket=${T8}`, `CredentialDOMD ticket agent: the change for ticket ${T8} was not merged.`);
    });
    const first = copy.run(state.dir);
    assert.equal(first.status, 0, first.stderr + copy.log());
    const [sent] = copy.sent();
    assert.equal(copy.sent().length, 1);
    assert.match(sent.message, /^CredentialDOMD ticket agent: 2 alerts\n/);
    // macOS allows the job's /bin/zsh to drive Messages and refused node; the
    // Command Line Tools' python3 is no more a system binary than node is.
    assert.ok(Number.isInteger(first.pid) && first.pid > 0);
    assert.equal(sent.parent, first.pid, 'the notifier is a direct child of the job\'s zsh, the one this test started');
    assert.match(copy.log(), /owner alerts: sent 2 \(parked [0-9a-f]{8}, change_refused [0-9a-f]{8}\)/);
    assert.deepEqual(new Set(sentIds(state.dir)), new Set(queue(state.dir).map(e => e.id)));
    assert.equal(copy.run(state.dir).status, 0);
    assert.equal(copy.sent().length, 1, 'nothing is sent twice');
  } finally { state.cleanup(); }
});

// The check above has teeth: the first version's mistake, put back in a copy
// of the job, is caught (the notifier's parent is python3, not the job's zsh).
test('the parent check catches a notifier python3 starts', { skip: jobSkip }, async () => {
  const state = stateDir();
  try {
    const copy = jobCopy(state.base);
    const script = readFileSync(copy.job, 'utf8');
    const direct = '"$NOTIFY" "$2" </dev/null';
    assert.ok(script.includes(direct), 'the job starts the notifier itself');
    writeFileSync(copy.job, script.replace(direct, `python3 -c 'import subprocess,sys; sys.exit(subprocess.call(sys.argv[1:]))' ${direct}`));
    await quietly(() => raise(state.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked.'));
    const r = copy.run(state.dir);
    assert.equal(r.status, 0, r.stderr + copy.log());
    const [sent] = copy.sent();
    assert.equal(copy.sent().length, 1);
    assert.ok(Number.isInteger(sent.parent) && sent.parent > 0);
    assert.notEqual(sent.parent, r.pid, 'python3 started it, not the job\'s zsh');
  } finally { state.cleanup(); }
});

test('the job drains: a refused or hung send keeps every alert queued for the next run', { skip: jobSkip }, async () => {
  const state = stateDir();
  try {
    const copy = jobCopy(state.base);
    await quietly(() => raise(state.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked.'));
    copy.flag('fail', true);
    assert.equal(copy.run(state.dir).status, 0);
    assert.match(copy.log(), /owner alerts: the notifier did not deliver them \(exit 1\); they stay queued\n.*owner alerts: not drained this run; they stay queued/);
    assert.deepEqual(sentIds(state.dir), []);
    copy.flag('fail', false);

    // A permission prompt nobody answers: killed after the limit.
    copy.flag('hang', true);
    const started = Date.now();
    assert.equal(copy.run(state.dir, { OWNER_ALERT_SEND_SECONDS: '1' }).status, 0);
    assert.ok(Date.now() - started < 15000, `returned in ${Date.now() - started} ms`);
    assert.match(copy.log(), /did not deliver them \(exit 137\)/);
    assert.deepEqual(sentIds(state.dir), []);
    copy.flag('hang', false);

    assert.equal(copy.run(state.dir).status, 0);
    assert.equal(copy.sent().length, 1);
    assert.equal(sentIds(state.dir).length, 1);
  } finally { state.cleanup(); }
});

test('the job drains: a second run while one is sending sends nothing, and the lock outlives the send', { skip: jobSkip }, async () => {
  const state = stateDir();
  try {
    const copy = jobCopy(state.base);
    await quietly(() => raise(state.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked.'));
    copy.flag('hold', true);
    const slow = copy.start(state.dir);
    const exited = new Promise(resolve => slow.on('exit', resolve));
    try {
      await until(() => copy.flagged('started'));
      const busy = copy.run(state.dir);
      assert.equal(busy.status, 0, busy.stderr);
      assert.match(copy.log(), /owner alerts: another drain is running/);
      assert.equal(copy.sent().length, 0);
    } finally { copy.flag('hold', false); }
    assert.equal(await exited, 0);
    assert.equal(copy.sent().length, 1);
    assert.equal(sentIds(state.dir).length, 1);
    assert.equal(copy.run(state.dir).status, 0);
    assert.equal(copy.sent().length, 1, 'the second run did not send the same batch');
  } finally { state.cleanup(); }
});

test('the job drains: a queue other users could reach is refused and nothing is sent', { skip: jobSkip }, async () => {
  const state = stateDir();
  try {
    const copy = jobCopy(state.base);
    await quietly(() => raise(state.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked.'));
    chmodSync(path.join(state.dir, QUEUE_FILE), 0o644);
    assert.equal(copy.run(state.dir).status, 0);
    assert.match(copy.log(), /refused: owner-alerts\.jsonl must be a regular file only its owner can read\n.*not drained this run/);
    assert.equal(copy.sent().length, 0);
    const before = copy.log();
    assert.equal(copy.run(path.join(state.base, 'no such dir')).status, 0);
    assert.equal(copy.log(), before, 'no state directory: nothing to do, nothing logged');
  } finally { state.cleanup(); }
});
