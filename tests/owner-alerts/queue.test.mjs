// The owner alert queue (2026-09-29). macOS refuses node's request to drive
// Messages, so the ticket runner's alerts were logged and never delivered.
// alert.mjs now queues every alert in its state directory before it tries the
// (bounded) direct send, and the signup notifier's launchd job, which may send
// iMessages, drains the queue: scripts/signup-notify.py drain. These tests run
// the real alert.mjs and the real drain against synthetic alerts: append,
// drain, idempotence, a failed send, partial lines, the lock and permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, rmSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { raise, enqueue, markSent, queueSafe, QUEUE_FILE, SENT_FILE, DIRECT_SEND_SECONDS } from '../../scripts/ticket-fix/alert.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const DRAIN = path.join(root, 'scripts/signup-notify.py');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
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
const drain = (dir, notify, extra = []) => spawnSync(python, [DRAIN, 'drain', '--state', dir, '--notify', notify, ...extra], { encoding: 'utf8', timeout: 60000 });

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

test('drain: one iMessage for everything pending, each marked sent, and a second drain sends nothing', { skip: python ? false : 'python3 not found' }, async () => {
  const state = stateDir();
  try {
    const fake = fakeNotifier(state.base);
    await quietly(async () => {
      await raise(state.dir, 'parked', `ticket=${T8} rejected_runs=3`, `CredentialDOMD ticket agent: ticket ${T8} is parked after 3 rejected runs.`, { now: Date.parse('2026-09-29T12:00:00Z') });
      await raise(state.dir, 'change_refused', `ticket=${T8}`, `CredentialDOMD ticket agent: the change for ticket ${T8} was not merged.`, { now: Date.parse('2026-09-29T12:05:00Z') });
      // Delivered directly: already marked, never sent again.
      await raise(state.dir, 'merge_held', `ticket=${T8}`, 'CredentialDOMD ticket agent: held for you.', { send: async () => true });
    });
    const first = drain(state.dir, fake.notify);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /owner alerts: sent 2 \(parked [0-9a-f]{8}, change_refused [0-9a-f]{8}\)/);
    const [msg] = fake.messages();
    assert.equal(fake.messages().length, 1);
    assert.match(msg, /^CredentialDOMD ticket agent: 2 alerts\n• .+: ticket a1b2c3d4 is parked after 3 rejected runs\.\n• .+: the change for ticket a1b2c3d4 was not merged\.$/);
    assert.doesNotMatch(msg, /held for you/);
    assert.doesNotMatch(msg, /\u2014/);
    assert.equal(sentIds(state.dir).length, 3);
    assert.deepEqual(new Set(sentIds(state.dir)), new Set(queue(state.dir).map(e => e.id)));
    assert.equal(mode(path.join(state.dir, SENT_FILE)), 0o600);

    const again = drain(state.dir, fake.notify);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, '');
    assert.equal(fake.messages().length, 1, 'idempotent: nothing is sent twice');

    // One new alert: sent alone, with the time it was raised.
    await quietly(() => raise(state.dir, 'stale_lock', 'age_hours=5', 'CredentialDOMD ticket agent: the run lock has been held 5 h.'));
    assert.equal(drain(state.dir, fake.notify).status, 0);
    assert.match(fake.messages()[1], /^CredentialDOMD ticket agent: the run lock has been held 5 h\. \(raised [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d\d\)$/);
  } finally { state.cleanup(); }
});

test('drain: a failed send keeps every alert queued for the next run', { skip: python ? false : 'python3 not found' }, async () => {
  const state = stateDir();
  try {
    const fake = fakeNotifier(state.base);
    await quietly(() => raise(state.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked.'));
    fake.fail(true);
    const refused = drain(state.dir, fake.notify);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /did not deliver 1 queued alert\(s\); they stay queued/);
    assert.deepEqual(sentIds(state.dir), []);
    fake.fail(false);
    assert.equal(drain(state.dir, fake.notify).status, 0);
    assert.equal(fake.messages().length, 1);
    assert.equal(sentIds(state.dir).length, 1);
  } finally { state.cleanup(); }
});

test('drain: a line still being appended waits, a malformed line is skipped, and at most --max go per message', { skip: python ? false : 'python3 not found' }, async () => {
  const state = stateDir();
  try {
    const fake = fakeNotifier(state.base);
    for (let i = 0; i < 12; i++) await enqueue(state.dir, { kind: 'parked', detail: `ticket=${T8}`, message: `CredentialDOMD ticket agent: alert ${i}.`, now: Date.parse('2026-09-29T12:00:00Z') + i * 60000 });
    const file = path.join(state.dir, QUEUE_FILE);
    const partial = JSON.stringify({ v: 1, id: '00000000-0000-4000-8000-000000000077', at: '2026-09-29T13:00:00.000Z', kind: 'parked', detail: '', message: 'CredentialDOMD ticket agent: late.' });
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n${partial.slice(0, 40)}`, { mode: 0o600 });
    const first = drain(state.dir, fake.notify);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /1 unreadable queue line\(s\) skipped/);
    assert.match(first.stdout, /sent 10 .*, 2 still queued/);
    assert.match(fake.messages()[0], /^CredentialDOMD ticket agent: 12 alerts\n/);
    assert.match(fake.messages()[0], /\n2 more on the next run\.$/);
    // The append completes.
    writeFileSync(file, `${readFileSync(file, 'utf8')}${partial.slice(40)}\n`, { mode: 0o600 });
    assert.equal(drain(state.dir, fake.notify).status, 0);
    assert.match(fake.messages()[1], /^CredentialDOMD ticket agent: 3 alerts\n/);
    assert.match(fake.messages()[1], /alert 10\.\n.*alert 11\.\n.*late\.$/);
    assert.equal(sentIds(state.dir).length, 13);
  } finally { state.cleanup(); }
});

test('drain: refuses a queue other users could reach, and does nothing without a state directory', { skip: python ? false : 'python3 not found' }, async () => {
  const state = stateDir();
  try {
    const fake = fakeNotifier(state.base);
    await quietly(() => raise(state.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked.'));
    chmodSync(path.join(state.dir, QUEUE_FILE), 0o644);
    const loose = drain(state.dir, fake.notify);
    assert.equal(loose.status, 3);
    assert.match(loose.stderr, /refused: owner-alerts\.jsonl must be a regular file only its owner can read/);
    chmodSync(path.join(state.dir, QUEUE_FILE), 0o600);
    chmodSync(state.dir, 0o755);
    const openDir = drain(state.dir, fake.notify);
    assert.equal(openDir.status, 3);
    assert.match(openDir.stderr, /must be an owner-only directory/);
    chmodSync(state.dir, 0o700);
    // A symlinked queue (or sent file) is refused, never followed.
    const real = path.join(state.base, 'real queue.jsonl');
    writeFileSync(real, readFileSync(path.join(state.dir, QUEUE_FILE)), { mode: 0o600 });
    rmSync(path.join(state.dir, QUEUE_FILE));
    symlinkSync(real, path.join(state.dir, QUEUE_FILE));
    const linked = drain(state.dir, fake.notify);
    assert.equal(linked.status, 3, linked.stderr);
    assert.match(linked.stderr, /symlink/);
    assert.equal(fake.messages().length, 0, 'nothing sent from a refused queue');
    const missing = drain(path.join(state.base, 'no such dir'), fake.notify);
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.stdout, '');
    assert.ok(lstatSync(path.join(state.dir, QUEUE_FILE)).isSymbolicLink());
  } finally { state.cleanup(); }
});

test('drain: a second drain while one holds the lock sends nothing', { skip: python ? false : 'python3 not found' }, async () => {
  const state = stateDir();
  try {
    const fake = fakeNotifier(state.base);
    await quietly(() => raise(state.dir, 'parked', `ticket=${T8}`, 'CredentialDOMD ticket agent: parked.'));
    const lock = path.join(state.dir, 'owner-alerts.lock');
    writeFileSync(lock, '', { mode: 0o600 });
    const holder = spawn(python, ['-c', 'import fcntl,os,sys,time\nfd=os.open(sys.argv[1],os.O_RDWR)\nfcntl.flock(fd,fcntl.LOCK_EX)\nprint("locked",flush=True)\ntime.sleep(30)', lock], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise((resolve, reject) => { holder.stdout.on('data', d => { if (String(d).includes('locked')) resolve(); }); holder.on('exit', () => reject(Error('lock holder exited'))); });
      const busy = drain(state.dir, fake.notify);
      assert.equal(busy.status, 0, busy.stderr);
      assert.match(busy.stdout, /another drain is running/);
      assert.equal(fake.messages().length, 0);
    } finally { holder.kill('SIGKILL'); }
    assert.equal(drain(state.dir, fake.notify).status, 0);
    assert.equal(fake.messages().length, 1);
  } finally { state.cleanup(); }
});
