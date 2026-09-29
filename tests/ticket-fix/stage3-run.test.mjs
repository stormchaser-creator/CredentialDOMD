// Stage 3 through run.mjs with a stubbed model on a synthetic project: the
// checklist frozen before any work, the attachments delivered and proven
// read, the confirmer, and the host's decision per item and per claim that
// the reply step renders the reply from. Synthetic text and images only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync, chmodSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT } from '../../scripts/ticket-fix/run.mjs';
import { readRun, writeRun } from '../../scripts/ticket-fix/merge.mjs';
import { deliverAttachments } from '../../scripts/ticket-fix/attachments.mjs';
import { readChecklist } from '../../scripts/ticket-fix/checklist.mjs';
import { project, sh, runStub, standardScript, workerResult, approve, confirmResult, context, CHECKLIST_RESULT, TICKET, OWNER, RUN_ID } from './stage2-helpers.mjs';
import { liveBuild } from './helpers.mjs';

const NAME = `${TICKET.slice(0, 8)}-${RUN_ID}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SHOT = `tickets/${TICKET}/screenshot.png`;
const noCode = { kind: 'no_code', reason: 'A question.', tests: [] };
const question = { items: [{ requirement: 'Answer where the summary title comes from', kind: 'question', source_id: TICKET, quote: 'the summary joins lines with spaces', surface: 'the summary text', money_legal_or_coding: false }], non_asks: [] };

// The runner's attachment step, done here with a stub download: the root
// next to the run directory, the ticket's own folder, the private manifest.
async function withAttachments() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'credentialdomd-attachments.')));
  chmodSync(root, 0o700);
  const ctx = { ...context(), attachments: [{ ticket_id: TICKET, source_id: TICKET, storage_path: SHOT, access: 'not_loaded', path_valid: true }] };
  const manifest = await deliverAttachments({ context: ctx, outDir: path.join(root, TICKET), fetchObject: async () => PNG, convert: { toPng() {}, dimensions: () => ({ width: 1, height: 1 }), shrink() {} } });
  const manifestFile = path.join(root, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  return { root, ctx, manifest, local: manifest.attachments[0].local_path, extra: { attachmentsDir: path.join(root, TICKET), attachmentsManifest: manifestFile },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('screenshots: the extractor sees them inline, the worker is refused until its own Read events show each one, and says what it shows; the confirmer checks that', async () => {
  const p = project();
  const a = await withAttachments();
  let r;
  try {
    const observation = { attachment: 'att-1', observed: 'A synthetic summary screen with two lines run together.', supports: ['AC-1'] };
    r = await runStub(p, standardScript({
      extract: () => question,
      repro: () => noCode,
      // First answer: no Read of the screenshot. After the host's refusal: the Read, and an observation.
      worker: (opts, n) => (n === 1 ? workerResult({ remaining: 'answer where the title comes from' })
        : { ...workerResult({ remaining: 'answer where the title comes from', observations: [observation] }), $reads: [{ file_path: a.local, ok: true }] }),
      confirm: () => ({ ...confirmResult({ observations: [{ attachment: 'att-1', verdict: 'agree', why: 'The screenshot shows the two lines run together.' }] }), $reads: [{ file_path: a.local, ok: true }] }),
    }), { context: a.ctx, extra: a.extra });
    assert.equal(r.code, EXIT.ok, r.logs.join('\n'));
    assert.deepEqual(r.calls.map(c => c.role), ['extract', 'repro', 'worker', 'worker', 'confirm']);
    // The extractor got the image inline, as a stream-json message.
    const extract = JSON.parse(r.calls[0].input.trim());
    assert.deepEqual(extract.message.content.map(c => c.type), ['text', 'image']);
    assert.equal(extract.message.content[1].source.data, PNG.toString('base64'));
    assert.match(extract.message.content[0].text, /Images shown after this text, in order: att-1/);
    // The worker was told the path, and refused until it read it.
    assert.match(r.calls[2].input, new RegExp(a.local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(r.calls[3].input, /attachments: Read .*att-1\.png \(att-1, the customer's screenshot\) with the Read tool before answering/);
    assert.ok(r.logs.some(l => l === `REPAIR — ${TICKET} attempt 1: attachments`), r.logs.join('\n'));
    // Sessions may read this ticket's folder and nothing next to it.
    for (const call of r.calls.filter(c => c.role !== 'extract')) assert.ok(call.settings.permissions.allow.includes(`Read(/${path.join(a.root, TICKET)}/**)`), call.role);
    assert.deepEqual(r.calls[0].settings.permissions.allow, [], 'the extractor has no tool at all');
    // The host's record for the reply step.
    assert.deepEqual(r.stage3.attachments.map(x => [x.attachment, x.access]), [['att-1', 'reviewed']]);
    assert.deepEqual(r.stage3.observation_verdicts, { 'att-1': 'agree' });
    assert.deepEqual(r.stage3.final.items.map(f => [f.id, f.state]), [['AC-1', 'not_done']]);
    assert.ok(r.logs.some(l => l.startsWith(`CONFIRM — ${TICKET.slice(0, 8)}: observations confirmed`)));
    assert.deepEqual((await readRun(p.work, NAME)).stage3.attachments_reviewed, ['att-1']);
  } finally { r?.cleanup(); a.cleanup(); p.cleanup(); }
});

test('an answered question is done only on a claim the host verified: quoted text in the live build, a released run\'s test run at a live base; a disputed screenshot unconfirms it', async () => {
  const p = project();
  const a = await withAttachments();
  const runs = [];
  try {
    const base = sh(p.repo, ['rev-parse', 'origin/main']);
    const observation = { attachment: 'att-1', observed: 'A synthetic summary screen titled Synthetic summary line.', supports: ['AC-1'] };
    const fileClaim = { ac_id: 'AC-1', text: 'The summary title reads "Synthetic summary line"', evidence: { file: 'src/format.js', line: 2, text: "export const title = 'Synthetic summary line';" } };
    const testClaim = { ac_id: 'AC-1', text: 'The summary title is set', evidence: { test: 'tests/format.test.mjs::the title is set' } };
    const answered = claims => ({ ...workerResult({ claims, checklist: [{ ac_id: 'AC-1', state: 'done', remaining: '', tests: [] }], observations: [observation], opening: 'answer', closing: 'reply_here' }), $reads: [{ file_path: a.local, ok: true }] });
    const once = async (claims, { verdict = 'agree', fetchBuild = liveBuild(base), runId, code = EXIT.ok }) => {
      const r = await runStub(p, standardScript({ extract: () => question, repro: () => noCode, worker: () => answered(claims),
        confirm: () => ({ ...confirmResult({ observations: [{ attachment: 'att-1', verdict, why: 'Synthetic.' }] }), $reads: [{ file_path: a.local, ok: true }] }) }), { context: a.ctx, extra: a.extra, fetchBuild, runId });
      runs.push(r);
      assert.equal(r.code, code, r.logs.join('\n'));
      return r;
    };
    // Quoted text at the cited line in the live build.
    let r = await once([fileClaim], { runId: '0000000000000001' });
    assert.deepEqual(r.stage3.final.claims.map(c => [c.verified, c.kind]), [[true, 'file']]);
    assert.equal(r.stage3.final.items[0].state, 'done');
    // A passing test bound to nothing proves nothing: the worker is refused.
    r = await once([testClaim], { runId: '0000000000000006', code: EXIT.refused });
    assert.ok(r.logs.some(l => l.startsWith(`REFUSED — ${TICKET}`) && l.includes('reply.claims[0]')), r.logs.join('\n'));
    // A test a released, reviewed run bound to the item: the host runs it at
    // a base the live build contains.
    await writeRun(p.work, { version: 1, id: `${TICKET.slice(0, 8)}-00000000000000aa`, ticket: TICKET, status: 'released', release: { verified: true },
      bindings_met: { 'AC-1': ['tests/format.test.mjs::the title is set'] } });
    r = await once([testClaim], { runId: '0000000000000002' });
    assert.deepEqual(r.stage3.final.claims.map(c => [c.verified, c.source]), [[true, 'base']]);
    assert.equal(r.stage3.final.items[0].state, 'done');
    // No live build to check against: nothing is confirmed.
    r = await once([fileClaim, testClaim], { runId: '0000000000000003', fetchBuild: async () => { throw Error('offline'); } });
    assert.deepEqual(r.stage3.final.claims.map(c => c.verified), [false, false]);
    assert.deepEqual([r.stage3.final.items[0].state, r.stage3.final.items[0].detail], ['partial', 'not_confirmed']);
    // The confirmer disputes what the worker said the screenshot shows.
    r = await once([fileClaim], { runId: '0000000000000004', verdict: 'disagree' });
    assert.deepEqual(r.stage3.observation_verdicts, { 'att-1': 'disagree' });
    assert.deepEqual([r.stage3.final.items[0].state, r.stage3.final.items[0].detail], ['partial', 'not_confirmed']);
    // A claim naming a device is never verified; one naming a missing line neither.
    r = await once([{ ...fileClaim, text: 'The summary title reads "Synthetic summary line" on your iPhone (not tested on the device)' },
      { ...fileClaim, evidence: { ...fileClaim.evidence, line: 40 } }], { runId: '0000000000000005' });
    assert.deepEqual(r.stage3.final.claims.map(c => c.verified), [false, false]);
    assert.match(r.stage3.final.claims[0].reason, /never confirmed here/);
  } finally { for (const r of runs) r.cleanup(); a.cleanup(); p.cleanup(); }
});

test('the checklist extraction: a quote not in the message is sent back once; a second refusal is exit 7 with no reproduction or worker', async () => {
  const p = project();
  let r, s;
  try {
    const invented = { items: [{ ...CHECKLIST_RESULT.items[0], quote: 'the summary is completely broken' }], non_asks: [] };
    r = await runStub(p, standardScript({ extract: (opts, n) => (n === 1 ? invented : CHECKLIST_RESULT) }));
    assert.equal(r.code, EXIT.ok, r.logs.join('\n'));
    const extracts = r.calls.filter(c => c.role === 'extract');
    assert.equal(extracts.length, 2);
    assert.ok(extracts[1].resume, 'the same session is resumed');
    assert.match(JSON.parse(extracts[1].input).message.content[0].text, /items\[0\]: the quote is not in .* word for word/);
    assert.deepEqual(readChecklist(p.state, TICKET).items.map(i => [i.id, i.quote]), [['AC-1', 'the summary joins lines with spaces']]);
    s = await runStub(project(), standardScript({ extract: () => invented }), { runId: 'fedcba9876543210' });
    assert.equal(s.code, EXIT.checklist);
    assert.deepEqual(s.calls.map(c => c.role), ['extract', 'extract']);
    assert.ok(s.logs.some(l => /^CHECKLIST — [0-9a-f]{8}: refused after a repair/.test(l)));
  } finally { r?.cleanup(); s?.cleanup(); p.cleanup(); }
});

test('the reviewer\'s verdicts extend the checklist: a non-ask it calls an ask becomes a new item, shown not done, with host follow-up; items are never reworded', async () => {
  const p = project({ 'src/format.js': "// Synthetic module for the gate tests.\nexport const title = 'Synthetic summary line';\n\nexport function joinLines(lines) {\n  return lines.join(' ');\n}\n" });
  const ctx = { ...context(), tickets: [{ ...context().tickets[0], body: 'Synthetic body: the summary joins lines with spaces. The title could be bolder too.' }] };
  let r;
  try {
    const extraction = { items: CHECKLIST_RESULT.items, non_asks: [{ source_id: TICKET, quote: 'The title could be bolder too.', reason: 'a passing remark' }] };
    r = await runStub(p, standardScript({ extract: () => extraction,
      review: () => approve({ non_asks: [{ index: 0, verdict: 'ask', requirement: 'Make the summary title bold', kind: 'change', why: 'it asks for a change' }] }) }), { context: ctx });
    assert.equal(r.code, EXIT.ok, r.logs.join('\n'));
    const review = r.calls.find(c => c.role === 'review');
    assert.match(review.input, /Judged NOT to be asks by the extractor/);
    assert.match(review.input, /"quote": "The title could be bolder too\."/);
    const checklist = readChecklist(p.state, TICKET);
    assert.deepEqual(checklist.items.map(i => [i.id, i.added_by]), [['AC-1', 'extraction'], ['AC-2', 'review_non_ask']]);
    assert.equal(checklist.non_asks[0].verdict, 'ask');
    assert.deepEqual(r.stage3.final.items.map(f => [f.id, f.state, f.detail]), [['AC-1', 'in_progress', 'held'], ['AC-2', 'not_done', 'new']]);
    assert.deepEqual(r.stage3.final.follow_up.map(f => f.work), ['Confirm AC-1 once its held change is released', 'Work on AC-2, added to the checklist after this run\'s worker']);
    assert.ok(r.logs.some(l => l.endsWith('the reviewer added AC-2')));
  } finally { r?.cleanup(); p.cleanup(); }
});

test('a later run: only a new customer message is extracted, it adds items, and the frozen ones stay exactly as they were', async () => {
  const p = project();
  let r, s;
  try {
    r = await runStub(p, standardScript({ repro: () => noCode, worker: () => workerResult() }));
    const before = readChecklist(p.state, TICKET).items;
    const later = { ...context(), tickets: [{ ...context().tickets[0], messages: [{ id: '00000000-0000-4000-8000-000000000777', ticket_id: TICKET, author_id: OWNER, is_admin_reply: false,
      body: 'Could the export keep the title in bold?', created_at: '2026-09-28T12:00:00Z' }] }] };
    const extraction = { items: [{ requirement: 'Keep the title bold in the export', kind: 'change', source_id: '00000000-0000-4000-8000-000000000777', quote: 'Could the export keep the title in bold?', surface: 'the export', money_legal_or_coding: false }], non_asks: [] };
    s = await runStub(p, standardScript({ extract: () => extraction, repro: () => noCode,
      worker: () => workerResult({ checklist: [{ ac_id: 'AC-1', state: 'not_done', remaining: 'look at the join', tests: [] }, { ac_id: 'AC-2', state: 'not_done', remaining: 'look at the export', tests: [] }] }) }),
    { context: later, runId: 'fedcba9876543210' });
    assert.equal(s.code, EXIT.ok, s.logs.join('\n'));
    const text = JSON.parse(s.calls[0].input).message.content[0].text;
    assert.match(text, /Customer sources to extract from now \(quote only from these\): 00000000-0000-4000-8000-000000000777 \(message\)\./);
    assert.match(text, /Items already frozen for this ticket[^\n]*: AC-1 \[bug\]\. Their wording is below/);
    // The wording is the customer's, so it is not a host fact.
    assert.match(text, /## Customer-derived text \(untrusted[^\n]*\n\n- AC-1: Separate the summary lines with line breaks/);
    assert.ok(text.indexOf('Separate the summary lines') > text.indexOf('## Customer-derived text'));
    const after = readChecklist(p.state, TICKET).items;
    assert.deepEqual(after.slice(0, 1), before);
    assert.deepEqual(after.map(i => i.id), ['AC-1', 'AC-2']);
    // The worker must account for every item it saw: leaving AC-2 out is refused.
    const t = await runStub(p, standardScript({ repro: () => noCode, worker: () => workerResult() }), { context: later, runId: '1111111111111111' });
    assert.equal(t.code, EXIT.refused);
    assert.ok(t.logs.some(l => l.includes('REFUSED') && l.includes('checklist')), t.logs.join('\n'));
    t.cleanup();
  } finally { r?.cleanup(); s?.cleanup(); p.cleanup(); }
});

test('the attachment root: sessions may not read another ticket\'s folder next to theirs', async () => {
  const p = project();
  const a = await withAttachments();
  let r;
  try {
    mkdirSync(path.join(a.root, '00000000-0000-4000-8000-000000000999'), { mode: 0o700 });
    writeFileSync(path.join(a.root, '00000000-0000-4000-8000-000000000999', 'att-1.png'), PNG, { mode: 0o600 });
    r = await runStub(p, standardScript({ extract: () => question, repro: () => noCode, worker: () => ({ ...workerResult({ observations: [{ attachment: 'att-1', observed: 'Synthetic.', supports: ['AC-1'] }] }), $reads: [{ file_path: a.local, ok: true }] }) }),
      { context: a.ctx, extra: a.extra });
    const worker = r.calls.find(c => c.role === 'worker');
    assert.ok(worker.settings.permissions.deny.includes(`Read(/${path.join(a.root, '00000000-0000-4000-8000-000000000999')}/**)`));
    assert.ok(worker.settings.permissions.deny.includes(`Read(/${path.join(a.root, 'manifest.json')})`), 'the manifest next to it too');
    assert.ok(existsSync(a.local));
  } finally { r?.cleanup(); a.cleanup(); p.cleanup(); }
});
