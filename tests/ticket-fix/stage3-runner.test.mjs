// Stage 3 in the hourly runner shell and the session sandbox: the host
// downloads the attachments in its own step (the only one holding a storage
// credential), each ticket's sessions may read that ticket's folder and
// nothing next to it, a checklist that cannot be extracted parks the ticket,
// and the reply step gets the host's stage 3 record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, realpathSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxProfile, sandboxAvailable, SANDBOX_EXEC } from '../../scripts/ticket-fix/sandbox.mjs';
import { sandboxPolicy, EXIT, readField } from '../../scripts/ticket-fix/run.mjs';
import { main as alert } from '../../scripts/ticket-fix/alert.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sh = readFileSync(path.join(root, 'scripts/ticket-agent.sh'), 'utf8');

test('the shell: attachments are fetched by their own step with the database token, after --load and before any session', () => {
  const load = sh.indexOf('--load "$TICKET_ID" "$CONTEXT"');
  const fetch = sh.indexOf('node "$HOST/ticket-fix/attachments.mjs" fetch --context "$CONTEXT" --out "$ATTACHMENTS" --manifest "$MANIFEST"');
  const work = sh.indexOf('ticket-fix/run.mjs" work');
  assert.ok(load > 0 && fetch > load && work > fetch, 'load, then the download, then run.mjs');
  assert.match(sh, /TICKET_DATABASE_TOKEN="\$TOKEN" node "\$HOST\/ticket-fix\/attachments.mjs" fetch/);
  assert.match(sh, /ATTACHMENTS="\$ATTACH_ROOT\/\$TICKET_ID"\n\s+MANIFEST="\$RUN_DIR\/\$TICKET_ID-attachments.json"/, 'the manifest is private to the run');
  // A failed download never stops the run.
  assert.match(sh, /--manifest "\$MANIFEST" >> "\$LOG" 2>&1 \|\|\n\s+echo "\$\(date '\+%F %T'\) WARN — attachments for \$TICKET_ID were not downloaded" >> "\$LOG"/);
  // run.mjs gets the folder and the manifest, never the token.
  const call = sh.slice(work, sh.indexOf('WORK_RC=$?'));
  assert.match(call, /--attachments-dir "\$ATTACHMENTS" --attachments-manifest "\$MANIFEST" --auto-merge "\$AUTO_MERGE"/);
  assert.doesNotMatch(call, /TOKEN/);
  assert.equal((sh.match(/TICKET_RUN_KEY="\$RUN_KEY"/g) || []).length, 2, 'the download step gets no run key');
});

test('the shell: the attachment root lives next to the run directory, stale folders go under the lock, and each ticket\'s folder is removed after its run', () => {
  const lock = sh.indexOf('if ! mkdir "$LOCK"');
  const stale = sh.indexOf('for STALE in "${TMPDIR:-/tmp}"/credentialdomd-attachments.*(N/); do /bin/rm -rf "$STALE"; done');
  const make = sh.indexOf('ATTACH_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/credentialdomd-attachments.XXXXXX")');
  assert.ok(lock > 0 && stale > lock && make > stale, 'removed only while this run holds the lock, before its own root exists');
  assert.match(sh, /trap 'EXIT_RC=\$\?; [^']*\/bin\/rm -rf "\$RUN_DIR" "\$ATTACH_ROOT" "\$HOST_DIR";[^']*' EXIT/);
  assert.match(sh, /run.mjs" finish --run-file "\$RUN_FILE" --work "\$WORK_STATE" --repo "\$REPO" >> "\$LOG" 2>&1\n(?:\s*#[^\n]*\n)*\s+\/bin\/rm -rf "\$ATTACHMENTS"/);
  // The sessions' denial of credentialdomd-ticket-* must not cover the root.
  assert.ok(!'credentialdomd-attachments.'.startsWith('credentialdomd-ticket-'));
});

test('the shell: a checklist that cannot be extracted parks the ticket at once and alerts; the record step gets the stage 3 record', () => {
  assert.equal(EXIT.checklist, 7);
  assert.match(sh, /7\) echo 3 > "\$FAIL_COUNT"\n[^\n]*REJECTED — \$TICKET_ID checklist not extracted; parked[^\n]*\n\s+node "\$ALERT" park --state "\$CASE_STATE" --ticket "\$TICKET_ID" --count 3 --why checklist --notify "\$NOTIFY"[^\n]*\n\s+RC=1; break ;;/);
  assert.match(sh, /STAGE3=\$\(run_field stage3_file\) \|\| \{ reject "unreadable run record"; RC=1; break; \}/);
  assert.match(sh, /TICKET_CODE_OUTCOME="\$CODE" TICKET_STAGE3_FILE="\$STAGE3" TICKET_DATABASE_TOKEN="\$TOKEN" node "\$HOST\/ticket-agent-context.mjs" \\\n\s+--record-and-reply/);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticket-field-'));
  try {
    const file = path.join(dir, 'run.json');
    writeFileSync(file, JSON.stringify({ stage3_file: '/private/tmp/x/00000000-0000-4000-8000-000000000001-stage3.json' }));
    assert.equal(readField(file, 'stage3_file'), '/private/tmp/x/00000000-0000-4000-8000-000000000001-stage3.json');
    writeFileSync(file, JSON.stringify({ stage3_file: '/etc/passwd' }));
    assert.throws(() => readField(file, 'stage3_file'), /Invalid stage3_file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the park alert says why when the checklist could not be extracted, by id prefix only', async () => {
  const state = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ticket-park-')));
  const sent = [];
  try {
    await alert(['park', '--state', state, '--ticket', '00000000-0000-4000-8000-000000000042', '--count', '3', '--why', 'checklist'], { send: async m => { sent.push(m); return true; } });
    assert.match(sent[0], /ticket 00000000 is parked: its checklist of asks could not be extracted \(refused twice in one run\), so nothing was worked on\./);
    assert.ok(!sent[0].includes('\u2014'));
    assert.match(readFileSync(path.join(state, 'alerts.log'), 'utf8'), /ALERT parked ticket=00000000 checklist=refused\n$/);
    await assert.rejects(alert(['park', '--state', state, '--ticket', '00000000-0000-4000-8000-000000000042', '--count', '3', '--why', 'other']), /park --why is checklist/);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('the sandbox policy: the attachment root is denied like the run directory, and only this ticket\'s folder re-opened, for sessions', { skip: sandboxAvailable() ? false : 'needs sandbox-exec' }, () => {
  const policy = sandboxPolicy({ work: '/w', state: ['/s'], runDir: '/r', profileDir: '/p', attachments: '/t/credentialdomd-attachments.x/T' });
  assert.ok(policy.denyRead.includes('/t/credentialdomd-attachments.x'));
  assert.deepEqual(policy.readable, ['/t/credentialdomd-attachments.x/T']);
  assert.deepEqual(sandboxPolicy({ work: '/w', profileDir: '/p' }).readable, []);
});

test('the session sandbox: this ticket\'s attachments are readable and never writable; the folder next to it, and credentials, are not', { skip: sandboxAvailable() ? false : 'needs sandbox-exec' }, () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ticket-readable-')));
  try {
    const attachRoot = path.join(base, 'credentialdomd-attachments.test');
    const mine = path.join(attachRoot, 'T'), other = path.join(attachRoot, 'OTHER'), wt = path.join(base, 'wt');
    for (const d of [mine, other, wt]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(mine, 'att-1.png'), 'mine'); writeFileSync(path.join(other, 'att-1.png'), 'other');
    const profile = path.join(base, 'p.sb');
    writeFileSync(profile, sandboxProfile({ kind: 'session', writable: [wt], denyRead: [attachRoot], readable: [mine] }));
    const run = (...args) => spawnSync(SANDBOX_EXEC, ['-f', profile, ...args], { encoding: 'utf8' });
    assert.equal(run('/bin/cat', path.join(mine, 'att-1.png')).stdout, 'mine');
    assert.notEqual(run('/bin/cat', path.join(other, 'att-1.png')).status, 0);
    assert.notEqual(run('/usr/bin/touch', path.join(mine, 'new')).status, 0);
    assert.equal(existsSync(path.join(mine, 'new')), false);
    assert.equal(run('/usr/bin/touch', path.join(wt, 'ok')).status, 0);
    // A readable folder can never re-open a credential store.
    assert.throws(() => sandboxProfile({ kind: 'session', writable: [wt], readable: [path.join(os.homedir(), '.ssh')] }), /credential directory/);
    assert.throws(() => sandboxProfile({ kind: 'session', writable: [wt], denyRead: [path.join(mine, 'x')], readable: [mine] }), /credential directory/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
