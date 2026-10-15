import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createAttachmentRoot, sweepAttachmentRoots, attachmentScope, ATTACH_ROOT_PREFIX, LEGACY_ATTACH_ROOT_PREFIX } from '../../scripts/ticket-fix/attachment-temp.mjs';
import { attachmentRules } from '../../scripts/ticket-fix/worker.mjs';
import { EXIT } from '../../scripts/ticket-fix/run.mjs';
import { project, sh, runStub, standardScript, workerResult, context, TICKET } from './stage2-helpers.mjs';
import { liveBuild } from './helpers.mjs';

function fixture() {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ticket-root-review-')));
  const repo = path.join(tmp, 'repo'), work = path.join(tmp, 'work');
  for (const dir of [repo, work]) mkdirSync(dir);
  return { tmp, repo, work, clean: () => rmSync(tmp, { recursive: true, force: true }) };
}
// The actual pre-upgrade hourly cleanup. It runs only within each synthetic
// fixture's private TMPDIR, never against the user's real temporary directory.
const legacySweep = 'for STALE in "${TMPDIR:-/tmp}"/credentialdomd-attachments.*(N/); do /bin/rm -rf "$STALE"; done';
function oldCleanup(tmp) {
  const r = spawnSync('/bin/zsh', ['-c', legacySweep], { env: { PATH: '/usr/bin:/bin', TMPDIR: tmp }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('an old concurrently running shell erases the legacy control but preserves a new live root and its bytes', () => {
  const f = fixture();
  try {
    const mine = createAttachmentRoot(f), legacy = mkdtempSync(path.join(f.tmp, LEGACY_ATTACH_ROOT_PREFIX));
    writeFileSync(path.join(mine, 'history'), 'private synthetic history');
    writeFileSync(path.join(legacy, 'history'), 'legacy positive deletion control');
    oldCleanup(f.tmp);
    assert.equal(existsSync(legacy), false, 'the old cleanup actually executed');
    assert.equal(readFileSync(path.join(mine, 'history'), 'utf8'), 'private synthetic history');
    assert.equal(lstatSync(mine).mode & 0o777, 0o700);
  } finally { f.clean(); }
});

test('reclaims a proven exited own process; preserves live, other checkout/work state, legacy and malformed roots', () => {
  const f = fixture();
  try {
    const module = new URL('../../scripts/ticket-fix/attachment-temp.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {createAttachmentRoot} from ${JSON.stringify(module)}; console.log(createAttachmentRoot(${JSON.stringify({tmp:f.tmp,repo:f.repo,work:f.work})}));`], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const dead = child.stdout.trim(); writeFileSync(path.join(dead, 'private'), 'own abandoned bytes');
    // Do not create mine through the helper yet: that would itself reclaim dead.
    const prefix = `${ATTACH_ROOT_PREFIX}${attachmentScope(f)}.`;
    const mine = mkdtempSync(path.join(f.tmp, `${prefix}${process.pid}.`));
    const otherRepo = path.join(f.tmp, 'other-repo'), otherWork = path.join(f.tmp, 'other-work');
    mkdirSync(otherRepo); mkdirSync(otherWork);
    const preserved = [mine,
      mkdtempSync(path.join(f.tmp, `${ATTACH_ROOT_PREFIX}${attachmentScope({...f,repo:otherRepo})}.${child.pid}.`)),
      mkdtempSync(path.join(f.tmp, `${ATTACH_ROOT_PREFIX}${attachmentScope({...f,work:otherWork})}.${child.pid}.`)),
      mkdtempSync(path.join(f.tmp, LEGACY_ATTACH_ROOT_PREFIX)),
      mkdtempSync(path.join(f.tmp, `${prefix}unknown.`))];
    for (const dir of preserved) writeFileSync(path.join(dir, 'private'), 'preserved');
    assert.deepEqual(sweepAttachmentRoots(f), [dead]);
    assert.equal(existsSync(dead), false);
    for (const dir of preserved) assert.equal(readFileSync(path.join(dir, 'private'), 'utf8'), 'preserved');
  } finally { f.clean(); }
});

test('ambiguous process checks and PID reuse preserve roots; symlinks never become deletion targets', () => {
  const f = fixture();
  try {
    const prefix = `${ATTACH_ROOT_PREFIX}${attachmentScope(f)}.123456.`;
    const candidate = mkdtempSync(path.join(f.tmp, prefix));
    writeFileSync(path.join(candidate, 'private'), 'preserved');
    for (const code of ['EPERM', 'EACCES', undefined]) {
      assert.deepEqual(sweepAttachmentRoots({...f, signal: () => { throw Object.assign(Error('unknown'), {code}); }}), []);
      assert.equal(existsSync(candidate), true);
    }
    assert.deepEqual(sweepAttachmentRoots({...f, signal: () => {}}), [], 'a reused/live PID is not considered stale');
    const target = path.join(f.tmp, 'foreign-target'); mkdirSync(target);
    writeFileSync(path.join(target, 'private'), 'foreign preserved');
    const link = path.join(f.tmp, `${prefix}abcdef`); symlinkSync(target, link);
    const removed = sweepAttachmentRoots({...f, signal: () => { throw Object.assign(Error('gone'), {code:'ESRCH'}); }});
    assert.deepEqual(removed, [candidate]);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(path.join(target, 'private'), 'utf8'), 'foreign preserved');
    for (const ownerPid of [-1, 0, 1.5, 0x80000000, Number.MAX_SAFE_INTEGER+1]) assert.throws(() => createAttachmentRoot({...f,ownerPid}));
  } finally { f.clean(); }
});

test('session Read rules deny neighboring roots using both naming generations', () => {
  const f = fixture();
  try {
    const mine = createAttachmentRoot(f), own = path.join(mine, TICKET); mkdirSync(own);
    const otherNew = createAttachmentRoot(f), old = mkdtempSync(path.join(f.tmp, LEGACY_ATTACH_ROOT_PREFIX));
    const rules = attachmentRules(own);
    assert.deepEqual(rules.allow, [`Read(/${own}/**)`]);
    for (const dir of [otherNew, old]) assert.ok(rules.deny.includes(`Read(/${dir}/**)`));
  } finally { f.clean(); }
});

test('actual runner retains its case history when the old hourly cleanup interleaves immediately before the first write', async () => {
  const f = fixture(), previousTmp = process.env.TMPDIR, originalWrite = fs.writeFile;
  process.env.TMPDIR = f.tmp;
  const p = project(); let result, cleanupRuns = 0;
  try {
    const base = sh(p.repo, ['rev-parse', 'origin/main']);
    fs.writeFile = async (file, ...args) => {
      if (path.basename(String(file)) === 'case-history.jsonl') {
        cleanupRuns++; oldCleanup(f.tmp);
        assert.ok(String(file).startsWith(`${f.tmp}/`), 'the exact runner write stays in the private fixture');
      }
      return originalWrite.call(fs, file, ...args);
    };
    const question = {items:[{requirement:'Answer where the summary title comes from',kind:'question',source_id:TICKET,quote:'the summary joins lines with spaces',surface:'the summary text',money_legal_or_coding:false}],non_asks:[]};
    const fileClaim = {ac_id:'AC-1',text:'The summary title reads "Synthetic summary line"',evidence:{file:'src/format.js',line:2,text:"export const title = 'Synthetic summary line';"}};
    const ctx = {...context(),attachments:[{ticket_id:TICKET,source_id:TICKET,storage_path:`tickets/${TICKET}/screenshot.png`,access:'not_loaded',path_valid:true}]};
    result = await runStub(p, standardScript({extract:()=>question,repro:()=>({kind:'no_code',reason:'Synthetic: nothing to reproduce.',tests:[]}),
      worker:()=>workerResult({claims:[fileClaim],checklist:[{ac_id:'AC-1',state:'done',remaining:'',tests:[]}],opening:'answer',closing:'reply_here'})}), {context:ctx,fetchBuild:liveBuild(base)});
    assert.equal(cleanupRuns, 1, 'competing cleanup ran at the observed failing boundary');
    assert.equal(result.code, EXIT.ok, result.logs.join('\n'));
    assert.equal(result.stage3.final.claims[0].verified, true);
    assert.deepEqual([result.stage3.final.items[0].state,result.stage3.final.items[0].detail], ['partial','not_confirmed']);
    assert.ok(result.sent.some(m => /none of the 1 attachment\(s\).*could be downloaded/.test(m)));
    assert.ok(result.stage3.final.follow_up.some(f => f.work.startsWith('Retrieve and review attachment att-1')));
  } finally {
    fs.writeFile = originalWrite;
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    result?.cleanup(); p.cleanup(); f.clean();
  }
});

// Exercise the shell's actual allocator command, not a duplicate invocation.
test('the shell allocator creates an owned root and a later run reclaims it after that shell exits', () => {
  const f = fixture();
  try {
    const source = readFileSync(new URL('../../scripts/ticket-agent.sh', import.meta.url), 'utf8');
    const line = source.split('\n').find(line => line.startsWith('ATTACH_ROOT=$('));
    assert.ok(line);
    const quoted = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
    const host = realpathSync(new URL('../../scripts/', import.meta.url));
    const result = spawnSync('/bin/zsh', ['-c', `set -u\nREPO=${quoted(f.repo)}\nWORK_STATE=${quoted(f.work)}\nHOST=${quoted(host)}\nRUN_DIR=${quoted(path.join(f.tmp,'run'))}\nLOCK=${quoted(path.join(f.tmp,'lock'))}\n${line}\nprint -r -- "$ATTACH_ROOT"`],
      {encoding:'utf8',env:{PATH:process.env.PATH,TMPDIR:f.tmp}});
    assert.equal(result.status, 0, result.stderr);
    const root = result.stdout.trim();
    assert.equal(path.dirname(root),f.tmp);
    assert.ok(path.basename(root).startsWith(`${ATTACH_ROOT_PREFIX}${attachmentScope(f)}.${result.pid}.`));
    writeFileSync(path.join(root,'private'),'own abandoned history');
    assert.deepEqual(sweepAttachmentRoots(f),[root]);
  } finally { f.clean(); }
});
