// G1 (stage 3): the checklist of every ask, frozen before any work, with the
// host's decision per item and the footer it renders. Synthetic threads,
// paraphrased from the failure modes (a dropped second ask, the admin modal
// fixed instead of the physician form, an owner decision on a member ticket,
// clinical coding from memory); nothing here is real ticket text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { askSources, quoteFound, checkExtraction, extendChecklist, emptyChecklist, writeChecklist, readChecklist, newSources, applyAskVerdicts, coverageHints,
  checklistErrors, finalStates, renderFooter, renderAgentReply, checklistFile, OWNER_TOPIC, FOOTER_HEADING, AGENT_REPLY_MAX, REQUIREMENT_MAX, REMAINING_MAX,
  MAX_ITEMS, CHECKLIST_SCHEMA } from '../../scripts/ticket-fix/checklist.mjs';
import { checkFixedRules } from '../../scripts/ticket-fix/claims.mjs';
import { uuid, privateDir } from './helpers.mjs';

const T = uuid(7001), OWNER = uuid(9101), M1 = uuid(7101), SUPPORT = uuid(7201), NOTE = uuid(7202);
const BODY = 'Please fix the total on the weekend invoice. Also the Word export loses its bold headings.';
function ctx({ fromAdmin = false, messages = [] } = {}) {
  return { target_id: T, owner_id: OWNER, approval: { from_admin: fromAdmin, approved_at: fromAdmin ? null : '2026-09-28T00:00:00Z' }, attachments: [],
    tickets: [{ id: T, user_id: OWNER, subject: 'Invoice problems', body: BODY, created_at: '2026-09-28T10:00:00Z', messages }] };
}
const customer = (id, body, at = '2026-09-28T11:00:00Z') => ({ id, ticket_id: T, author_id: OWNER, is_admin_reply: false, body, created_at: at });
const support = { id: SUPPORT, ticket_id: T, author_id: OWNER, is_admin_reply: true, body: 'CredentialDOMD Support · Automated\n\nPlease tell us which screen you used.', created_at: '2026-09-28T10:30:00Z' };
const note = { id: NOTE, ticket_id: T, author_id: OWNER, is_admin_reply: false, body: 'Status set to in progress', created_at: '2026-09-28T10:40:00Z' };
const item = (changes = {}) => ({ requirement: 'Correct the total on the weekend invoice', kind: 'bug', source_id: T, quote: 'fix the total on the weekend invoice', surface: 'the invoice screen', money_legal_or_coding: false, ...changes });
const frozen = (items, context = ctx()) => extendChecklist(emptyChecklist(context), { items, non_asks: [] }, { runName: 'run-a', sources: askSources(context) });

test('asks come from the ticket and its customer messages only: never a support reply or a status note', () => {
  const sources = askSources(ctx({ messages: [support, note, customer(M1, 'The collapsed line should show the next due date.')] }));
  assert.deepEqual(sources.map(s => [s.id, s.kind]), [[T, 'ticket'], [M1, 'message']]);
  assert.match(sources[0].text, /^Invoice problems\nPlease fix/);
  // Quotes survive typography, never invention.
  assert.equal(quoteFound('the  Word export loses its “bold” headings'.replace(/[“”]/g, ''), BODY), true);
  assert.equal(quoteFound('the Word export drops every table', BODY), false);
  assert.equal(quoteFound('Word', BODY), false, 'too short to locate');
  assert.equal(quoteFound('Fix it', 'Fix it'), true, 'a message shorter than 12 characters is quoted whole');
});

test('the extraction is checked: quotes word for word from a customer source, one-sentence requirements that pass the reply rules', () => {
  const context = ctx({ messages: [support] });
  const record = emptyChecklist(context);
  const sources = askSources(context);
  const ok = checkExtraction({ items: [item(), item({ requirement: 'Keep bold headings in the Word export', kind: 'bug', quote: 'the Word export loses its bold headings', surface: 'Word export' })], non_asks: [] }, { context, record, sources });
  assert.deepEqual(ok.errors, []);
  const bad = checkExtraction({ items: [
    item({ quote: 'the invoice total is always wrong' }),
    item({ source_id: SUPPORT, quote: 'Please tell us which screen you used' }),
    item({ requirement: 'Fix the total — as Eric asked in abcdef1234' }),
    item({ requirement: 'Fix the total. Then the export.' }),
    item({ kind: 'feature' }),
  ], non_asks: [{ source_id: T, quote: 'thanks for everything', reason: 'thanks' }] }, { context, record, sources });
  assert.match(bad.errors.join('\n'), /items\[0\]: the quote is not in .* word for word/);
  assert.match(bad.errors.join('\n'), new RegExp(`items\\[1\\]: source_id must be one of ${T}`), 'a support reply is not an ask');
  assert.match(bad.errors.join('\n'), /items\[2\]: requirement breaks the reply rules \(commit_or_build_id, em_dash, owner_name\)/);
  assert.match(bad.errors.join('\n'), /items\[3\]: requirement is one sentence/);
  assert.match(bad.errors.join('\n'), /items\[4\]: kind must be one of/);
  assert.match(bad.errors.join('\n'), /non_asks\[0\]: quote a sentence/);
  assert.match(checkExtraction({ items: [], non_asks: [] }, { context, record, sources }).errors.join(), /A ticket has at least one ask/);
  // A device named in a requirement is fine: the footer qualifies it.
  assert.deepEqual(checkExtraction({ items: [item({ requirement: 'Keep line breaks when the invoice is sent from Mail' })], non_asks: [] }, { context, record, sources }).errors, []);
  assert.equal(CHECKLIST_SCHEMA.properties.items.items.properties.requirement.maxLength, REQUIREMENT_MAX);
});

test('owner decisions: on the owner\'s own ticket only price, money constants, legal copy and clinical coding; a keyword asks the extractor to confirm, it never reclassifies', () => {
  const owner = ctx({ fromAdmin: true });
  const member = ctx();
  const run = (context, items, confirmTriggers = true) => checkExtraction({ items, non_asks: [] }, { context, record: emptyChecklist(context), sources: askSources(context), confirmTriggers });
  // The owner filed "fix the total": the ask is his decision already.
  assert.match(run(owner, [item({ kind: 'owner_decision' })]).errors.join(), /on the owner's own ticket the ask is already the owner's decision/);
  assert.deepEqual(run(owner, [item({ kind: 'owner_decision', money_legal_or_coding: true, requirement: 'Set the weekend day rate on the invoice' })]).errors, []);
  // The flag alone is not enough: the item must name a price, money, legal or coding term.
  assert.match(run(owner, [item({ kind: 'owner_decision', money_legal_or_coding: true })]).errors.join(), /owner_decision is only for price or money constants, legal copy or clinical coding, named in the requirement or quote/);
  assert.deepEqual(run(member, [item({ kind: 'owner_decision' })]).errors, [], 'on a member ticket anything may wait for CredentialDOMD');
  // "total on the weekend invoice" is not a money constant, but a rate is: confirm once.
  const flagged = run(member, [item({ requirement: 'Use the weekend day rate on the invoice', quote: 'fix the total on the weekend invoice' })]);
  assert.deepEqual(flagged.confirm, [0]);
  assert.deepEqual(run(member, [item({ requirement: 'Use the weekend day rate on the invoice' })], false).confirm, [], 'asked once: the second answer stands');
  for (const text of ['Bill 61519 with CPT and the right wRVU', 'Apply modifier 59', 'Unbundle the LAA code', 'Change the price to $129', 'Update the privacy policy']) assert.ok(OWNER_TOPIC.test(text), text);
  for (const text of ['Show the next due date', 'Keep bold headings', 'Heart rate field']) assert.ok(!OWNER_TOPIC.test(text), text);
});

test('frozen: items are never deleted or reworded, a hand edit is detected, and only new customer messages are read again', async () => {
  const state = privateDir('ticket-checklist-');
  try {
    const first = ctx();
    let record = await writeChecklist(state.dir, frozen([item()], first));
    assert.deepEqual(record.items.map(i => i.id), ['AC-1']);
    assert.equal(statSync(checklistFile(state.dir, T)).mode & 0o777, 0o600);
    assert.deepEqual(readChecklist(state.dir, T).items, record.items);
    assert.deepEqual(newSources(record, first), [], 'nothing new to read');
    // A customer message arrives: only it is new; the extraction adds AC-2.
    const second = ctx({ messages: [customer(M1, 'Also the collapsed line should show the next due date.')] });
    assert.deepEqual(newSources(record, second).map(s => s.id), [M1]);
    const added = checkExtraction({ items: [item({ source_id: M1, quote: 'the collapsed line should show the next due date', requirement: 'Show the next due date on the collapsed line', kind: 'change' })], non_asks: [] },
      { context: second, record, sources: newSources(record, second) });
    assert.deepEqual(added.errors, []);
    record = await writeChecklist(state.dir, extendChecklist(record, added, { runName: 'run-b', sources: newSources(record, second) }));
    assert.deepEqual(record.items.map(i => [i.id, i.source_id]), [['AC-1', T], ['AC-2', M1]]);
    // Repeating a frozen item is refused.
    assert.match(checkExtraction({ items: [item()], non_asks: [] }, { context: second, record, sources: askSources(second) }).errors.join(), /repeats a frozen item/);
    // Rewording or deleting AC-1 is refused.
    await assert.rejects(writeChecklist(state.dir, { ...record, items: [{ ...record.items[0], requirement: 'Something easier' }, record.items[1]] }), /may not be deleted or reworded/);
    await assert.rejects(writeChecklist(state.dir, { ...record, items: [record.items[1]] }), /may not be deleted or reworded/);
    // A hand edit of the stored file is caught on the next read.
    const file = checklistFile(state.dir, T);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.items[0].requirement = 'Edited by hand';
    writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
    assert.throws(() => readChecklist(state.dir, T), /changed outside the runner/);
  } finally { state.cleanup(); }
});

test('a dropped ask is caught: the host hints the uncovered sentence to the reviewer, and a missed ask or a non-ask judged an ask becomes a new item', () => {
  const context = ctx({ messages: [customer(M1, 'Thanks for the quick look. Can you also keep the page numbers?')] });
  // The extractor dropped the Word half of the ticket and judged the thanks a non-ask.
  let record = extendChecklist(emptyChecklist(context), { items: [item()], non_asks: [{ source_id: M1, quote: 'Thanks for the quick look', reason: 'thanks' }] },
    { runName: 'run-a', sources: askSources(context) });
  const hints = coverageHints(context, record);
  assert.deepEqual(hints.map(h => h.sentence), ['Also the Word export loses its bold headings.', 'Can you also keep the page numbers?']);
  const { record: next, added } = applyAskVerdicts(record, {
    non_asks: [{ index: 0, verdict: 'not_ask', requirement: '', kind: 'none', why: 'a thank you' }],
    missed_asks: [
      { source_id: T, quote: 'the Word export loses its bold headings', requirement: 'Keep bold headings in the Word export', kind: 'bug', why: 'second half of the ticket' },
      { source_id: M1, quote: 'keep the page numbers', requirement: 'Keep the page numbers in the export', kind: 'change', why: 'asked in the follow-up' },
      { source_id: T, quote: 'rebuild the whole invoice module', requirement: 'Rebuild the invoices', kind: 'change', why: 'invented' },
    ] }, { context, runName: 'run-a' });
  assert.deepEqual(added, ['AC-2', 'AC-3'], 'an invented quote adds nothing');
  assert.equal(next.non_asks[0].verdict, 'not_ask');
  assert.equal(next.items[1].added_by, 'review_missed');
  record = next;
  assert.deepEqual(coverageHints(context, record), [], 'every ask is covered now');
  // A non-ask the reviewer calls an ask is added too.
  const other = extendChecklist(emptyChecklist(context), { items: [item()], non_asks: [{ source_id: M1, quote: 'Can you also keep the page numbers?', reason: 'looked optional' }] }, { runName: 'r', sources: askSources(context) });
  const judged = applyAskVerdicts(other, { non_asks: [{ index: 0, verdict: 'ask', requirement: 'Keep the page numbers in the export', kind: 'change', why: 'it is a request' }] }, { context, runName: 'r2' });
  assert.deepEqual(judged.added, ['AC-2']);
  assert.equal(judged.record.items[1].quote, 'Can you also keep the page numbers?');
});

const items = frozen([item(), item({ requirement: 'Answer whether weekends use the holiday rate', kind: 'question', quote: 'Also the Word export loses its bold headings' }),
  item({ requirement: 'Decide the weekend billing policy', kind: 'owner_decision', quote: 'Please fix the total on the weekend invoice' }),
  item({ requirement: 'Fix the stored invoice number', kind: 'data_fix', quote: 'the weekend invoice. Also the Word' }),
  item({ requirement: 'Keep line breaks in Mail', kind: 'device_probe', quote: 'Word export loses its bold' })]).items;
const TEST = 'tests/invoice-total.test.mjs::weekend total adds the stipend';
const entry = (id, state, changes = {}) => ({ ac_id: id, state, remaining: state === 'done' ? '' : 'check the weekend stipend rule', tests: [], ...changes });
const result = (entries, claims = [], extra = {}) => ({ reply: { opening: 'update', claims, closing: 'follow_up' }, checklist: entries, attachment_observations: [], ...extra });
const all = (overrides = {}) => items.map(i => overrides[i.id] ?? entry(i.id, i.kind === 'owner_decision' || i.kind === 'data_fix' ? 'needs_owner' : 'not_done'));

test('the worker\'s checklist: every frozen item exactly once; done needs a bound test and a claim on it; owner decisions stay with the owner', () => {
  const bindings = new Map([['AC-1', new Set([TEST])]]);
  const check = (r, options = {}) => checklistErrors(r, { items, bindings, ...options }).join('\n');
  assert.equal(check(result(all())), '');
  assert.match(check(result(all().slice(1))), /checklist: AC-1 must appear exactly once \(found 0\)/);
  assert.match(check(result([...all(), entry('AC-1', 'not_done')])), /AC-1 must appear exactly once \(found 2\)/);
  assert.match(check(result([...all(), entry('AC-9', 'not_done')])), /AC-9 is not a frozen item/);
  // Done without a passing test id, or with a test not bound to the item.
  assert.match(check(result(all({ 'AC-1': entry('AC-1', 'done') }))), /AC-1: done needs the test that pins it/);
  assert.match(check(result(all({ 'AC-1': entry('AC-1', 'done', { tests: ['tests/other.test.mjs::unrelated'] }) }))), /tests\/other\.test\.mjs::unrelated is not bound to AC-1/);
  assert.match(check(result(all({ 'AC-1': entry('AC-1', 'done', { tests: [TEST] }) }))), /done needs a claim for AC-1 whose evidence is one of its tests/);
  assert.equal(check(result(all({ 'AC-1': entry('AC-1', 'done', { tests: [TEST] }) }), [{ ac_id: 'AC-1', text: 'The weekend total now adds the stipend', evidence: { test: TEST } }])), '');
  assert.match(check(result(all({ 'AC-2': entry('AC-2', 'done') }))), /an answered question needs a claim for AC-2/);
  // An owner decision is never done, never anything but needs_owner.
  assert.match(check(result(all({ 'AC-3': entry('AC-3', 'done') }))), /AC-3: an owner_decision item is needs_owner/);
  assert.match(check(result(all({ 'AC-1': entry('AC-1', 'needs_owner') }))), /AC-1: needs_owner is for owner_decision and data_fix items/);
  assert.match(check(result(all({ 'AC-4': entry('AC-4', 'done') }))), /a data_fix item is never done by the agent/);
  assert.match(check(result(all({ 'AC-5': entry('AC-5', 'done') }))), /a device_probe item is never done by the agent/);
  // Remaining is shown to the customer: work to do, never a result.
  assert.match(check(result(all({ 'AC-1': entry('AC-1', 'partial', { remaining: 'The total is now fixed' }) }))), /remaining breaks the reply rules \(unverified_claim\)/);
  assert.match(check(result(all({ 'AC-1': entry('AC-1', 'partial', { remaining: '' }) }))), /say what remains/);
  assert.match(check(result(all({ 'AC-1': entry('AC-1', 'partial', { remaining: 'x'.repeat(REMAINING_MAX + 1) }) }))), /one line of at most/);
  // On the owner's ticket, a decision item carries the question he must answer.
  assert.match(check(result(all({ 'AC-3': entry('AC-3', 'needs_owner', { remaining: 'decide the weekend policy' }) })), { ownerTicket: true }), /the question the owner must answer, ending with "\?"/);
  assert.equal(check(result(all({ 'AC-3': entry('AC-3', 'needs_owner', { remaining: 'Should weekends bill at the holiday rate?' }),
    'AC-4': entry('AC-4', 'needs_owner', { remaining: 'May we correct the stored invoice number?' }) })), { ownerTicket: true }), '');
  // Claims: known items, fixed rules, no query evidence for the agent.
  assert.match(check(result(all(), [{ ac_id: 'AC-1', text: 'Fixed in build c237149', evidence: { test: TEST } }])), /reply.claims\[0\]: commit_or_build_id/);
  assert.match(check(result(all(), [{ ac_id: 'AC-7', text: 'Checked', evidence: { test: TEST } }])), /reply.claims\[0\]: ac_id must be a frozen item/);
  assert.match(check(result(all(), [{ ac_id: 'AC-1', text: 'No rows remain', evidence: { query: 'q1' } }])), /the agent has no database/);
});

test('attachments: a delivered screenshot on the ticket must be read (proven by the host) and observed once; its item is in the observation\'s supports', () => {
  const attachments = [{ attachment: 'att-1', source_id: T, target: true, access: 'delivered', local_path: '/run/attachments/att-1.png', media_type: 'image/png' },
    { attachment: 'att-2', source_id: uuid(8001), target: false, access: 'delivered', local_path: '/run/attachments/att-2.png', media_type: 'image/png' },
    { attachment: 'att-3', source_id: T, target: true, access: 'unavailable', reason: 'download failed: storage returned 404' }];
  const check = (r, access = 'delivered') => checklistErrors(r, { items, attachments: attachments.map((a, i) => (i === 0 ? { ...a, access } : a)) }).join('\n');
  assert.match(check(result(all())), /attachments: Read \/run\/attachments\/att-1\.png \(att-1, the customer's screenshot\) with the Read tool before answering; the host saw no Read of it/);
  assert.match(check(result(all()), 'reviewed'), /give exactly one observation for att-1/);
  const observed = (supports) => result(all(), [], { attachment_observations: [{ attachment: 'att-1', observed: 'The invoice screen shows a weekend total with no stipend line.', supports }] });
  assert.match(check(observed(['AC-2']), 'reviewed'), /AC-1 came with att-1; list AC-1 in the supports/);
  assert.equal(check(observed(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5']), 'reviewed'), '', 'a related ticket\'s screenshot and an unavailable one need no observation');
  assert.match(check(result(all(), [], { attachment_observations: [{ attachment: 'att-3', observed: 'x', supports: [] }] }), 'reviewed'), /att-3 is not a delivered attachment/);
  assert.match(check(result(all(), [], { attachment_observations: [{ attachment: 'att-1', observed: 'x', supports: ['AC-1'] }] })), /att-1 was not read/);
});

test('the host decides each state from its own artifacts: held is in progress, refused is not done, unproven is not confirmed, released and met is done', () => {
  const bindings = new Map([['AC-1', new Set([TEST])]]);
  const done = all({ 'AC-1': entry('AC-1', 'done', { tests: [TEST] }), 'AC-2': entry('AC-2', 'done'), 'AC-5': entry('AC-5', 'partial', { remaining: 'check it on your phone' }) });
  const claim = (ac, extra) => ({ index: 0, ac_id: ac, verified: true, kind: 'test', test: TEST, ...extra });
  const decide = (code, claims, extra = {}) => Object.fromEntries(finalStates({ items, entries: done, claims, code, bindings, ...extra }).map(f => [f.id, [f.state, f.detail]]));
  const green = new Set([TEST]);
  const held = decide({ outcome: 'held', gates_pass: true, review_pass: true, review_items: { 'AC-1': 'met' }, green }, []);
  assert.deepEqual(held['AC-1'], ['in_progress', 'held']);
  assert.deepEqual(held['AC-2'], ['partial', 'not_confirmed'], 'a question with no verified claim');
  assert.deepEqual(held['AC-3'], ['needs_owner', null]);
  assert.deepEqual(held['AC-5'], ['partial', null]);
  assert.deepEqual(decide({ outcome: 'refused', gates_pass: false, review_pass: false, review_items: {}, green }, [])['AC-1'], ['not_done', 'change_not_merged']);
  assert.deepEqual(decide({ outcome: 'held', gates_pass: true, review_pass: true, review_items: { 'AC-1': 'not_met' }, green }, [])['AC-1'], ['not_done', 'change_not_merged'], 'the reviewer did not find it met');
  const released = { outcome: 'released', gates_pass: true, review_pass: true, review_items: { 'AC-1': 'met' }, green, release_verified: true };
  assert.deepEqual(decide(released, [claim('AC-1', { source: 'this_change' })])['AC-1'], ['done', null]);
  assert.deepEqual(decide(released, [claim('AC-1', { source: 'this_change', verified: false })])['AC-1'], ['not_done', 'change_not_merged'], 'released, but the claim did not verify');
  assert.deepEqual(decide({ ...released, release_verified: false }, [claim('AC-1', { source: 'this_change' })])['AC-1'], ['not_done', 'change_not_merged'], 'release check failed');
  // Already live: a test a released, reviewed run bound passed at a base the live build contains.
  const prior = new Map([['AC-1', new Set([TEST])]]);
  assert.deepEqual(decide({ outcome: 'none' }, [claim('AC-1', { source: 'base' })], { bindings: new Map(), prior })['AC-1'], ['done', null]);
  assert.deepEqual(decide({ outcome: 'none' }, [claim('AC-1', { source: 'base', test: 'tests/other.test.mjs::x' })], { bindings: new Map(), prior })['AC-1'], ['partial', 'not_confirmed'], 'a test not bound to the item proves nothing about it');
  assert.deepEqual(decide({ outcome: 'none' }, [claim('AC-2', { kind: 'file', test: undefined })])['AC-2'], ['done', null], 'an answered question with a verified claim');
  // A disputed observation: what it supports is not confirmed.
  assert.deepEqual(decide({ outcome: 'none' }, [claim('AC-2', { kind: 'file' })], { disputed: new Set(['AC-2']) })['AC-2'], ['partial', 'not_confirmed']);
  // Items added after the worker ran are new and not done.
  assert.deepEqual(decide({ outcome: 'none' }, [], { workerItems: ['AC-1', 'AC-2', 'AC-3', 'AC-4'] })['AC-5'], ['not_done', 'new']);
});

test('the footer: one line per item in the host\'s state, colons only, no em dash, a device line says it was not tested, an owner is asked, a member is told who decides', () => {
  const finals = [{ id: 'AC-1', state: 'done', remaining: '' }, { id: 'AC-2', state: 'partial', remaining: 'confirm the holiday calendar', detail: null },
    { id: 'AC-3', state: 'needs_owner', remaining: 'Should weekends bill at the holiday rate?' }, { id: 'AC-4', state: 'not_done', remaining: '' },
    { id: 'AC-5', state: 'in_progress', remaining: '', detail: 'held' }];
  const member = renderFooter(items, finals, { ownerTicket: false }).split('\n');
  assert.equal(member[0], FOOTER_HEADING);
  assert.deepEqual(member.slice(1), [
    '1. Correct the total on the weekend invoice: done',
    '2. Answer whether weekends use the holiday rate: partly done, still to do: confirm the holiday calendar',
    '3. Decide the weekend billing policy: waiting on a decision from CredentialDOMD',
    '4. Fix the stored invoice number: not done yet',
    '5. Keep line breaks in Mail: in progress, a change is ready and waiting to be released (not tested on that device)']);
  const owner = renderFooter(items, finals, { ownerTicket: true }).split('\n');
  assert.equal(owner[3], '3. Decide the weekend billing policy: needs your decision: Should weekends bill at the holiday rate?');
  const text = renderAgentReply({ opening: 'update', confirmed: ['The weekend total adds the stipend'], questions: ['Which invoice number should the record carry?'], items, finals, closing: 'follow_up', ownerTicket: false });
  assert.ok(!text.includes('—'));
  assert.deepEqual(checkFixedRules(text, { max: AGENT_REPLY_MAX }), [], 'the rendered reply passes every fixed rule');
  assert.match(text, /^Here is where your request stands\.\n\nWhat we confirmed:\n- The weekend total adds the stipend\n\nQuestions for you:\n- Which invoice number should the record carry\?\n\nWhere each part stands:\n1\. /);
  assert.match(text, /\n\nWe will post on this thread when the remaining work is done\.$/);
  // The longest checklist still fits the stored reply.
  const most = Array.from({ length: MAX_ITEMS }, (_, i) => ({ id: `AC-${i + 1}`, requirement: 'x'.repeat(REQUIREMENT_MAX) }));
  const longest = renderAgentReply({ opening: 'checked', confirmed: Array(12).fill('y'.repeat(160)), questions: Array(3).fill(`${'z'.repeat(299)}?`), items: most,
    finals: most.map(i => ({ id: i.id, state: 'partial', remaining: 'w'.repeat(REMAINING_MAX) })), closing: 'follow_up', ownerTicket: false });
  assert.ok(longest.length <= AGENT_REPLY_MAX, `${longest.length}`);
  assert.equal(path.basename(checklistFile('/state', T)), `${T}.json`);
});
