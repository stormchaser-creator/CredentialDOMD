// G1: every ask tracked (design G1 with the critique's amendments, stage 3).
//
// Before any work, a separate extraction session (claude-opus-5-5, no tools)
// turns the ticket thread into items:
//   { id AC-n (the host's), requirement, kind, source_id, quote, surface }
// kind: bug | change | question | data_fix | device_probe | owner_decision.
// The host checks every quote against the text of the message it names (a
// customer-written source on the target ticket), freezes the list in the
// runner's private state (checklists/<ticket>.json, owner-only), and never
// lets a later run delete or reword an item: a new customer message can only
// add items. Sentences the extractor judged not to be asks (non_asks) go to
// the independent reviewer for a verdict; one it calls an ask becomes an item.
//
// Owner decisions (critique): on the owner's own tickets the ask already is
// the decision, so owner_decision there is only for price and money
// constants, legal copy and clinical coding (CPT, wRVU, modifiers,
// bundling). A keyword hit never reclassifies an item; it makes the
// extractor confirm, once, whether the item is about one of those.
//
// When the result is recorded every frozen item appears exactly once with a
// state, and "done" is the host's decision from its own artifacts (gates.json,
// the review, the release record, claims it verified), never the model's
// prose. The host renders the customer's footer, "Where each part stands:",
// one line per item.
//
// Pure: no network, no git, no model. run.mjs and ticket-agent-context.mjs
// supply the evidence.
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { checkFixedRules, namesDevice, OPENINGS, CLOSINGS, ruleNames, parseClaimEvidence, sentences } from './claims.mjs';

export const KINDS = Object.freeze(['bug', 'change', 'question', 'data_fix', 'device_probe', 'owner_decision']);
export const STATES = Object.freeze(['done', 'partial', 'not_done', 'needs_owner']);
// Host-only: the change passed every gate and the review and is held for release.
export const HOST_STATES = Object.freeze([...STATES, 'in_progress']);
export const MAX_ITEMS = 30;
export const REQUIREMENT_MAX = 120;
export const REMAINING_MAX = 120;
export const QUOTE_MAX = 300;
export const OBSERVED_MAX = 600;
// The agent's reply, footer included (replySQL stores up to this).
export const AGENT_REPLY_MAX = 12000;
export const FOOTER_HEADING = 'Where each part stands:';
export const CONFIRMED_HEADING = 'What we confirmed:';
export const QUESTIONS_HEADING = 'Questions for you:';
export const ID = /^AC-(\d{1,3})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256 = text => createHash('sha256').update(text).digest('hex');
const str = (max, min = 1) => ({ type: 'string', minLength: min, maxLength: max });

// Price and money constants, legal copy, clinical coding (critique G1: CPT,
// wRVU, modifier and "bundl" added after 63cf43b7 was overcoded 18 wRVU).
export const OWNER_TOPIC = /\$\s?\d|\b(?:prices?|pricing|priced|fees?|refunds?|discounts?|subscriptions?|plan (?:price|cost)|money|day ?rates?|hourly rates?|stipends?|contract (?:rate|terms)|legal|terms of (?:service|use)|privacy policy|disclaimers?|liability|cpt|wrvus?|rvus?|modifiers?|(?:un)?bundl\w*|icd-?10|clinical cod\w*|billing codes?)\b/i;

export const CHECKLIST_SCHEMA = { title: 'ticket-checklist', type: 'object', additionalProperties: false, properties: {
  items: { type: 'array', maxItems: MAX_ITEMS, items: { type: 'object', additionalProperties: false, properties: {
    requirement: str(REQUIREMENT_MAX), kind: { enum: KINDS }, source_id: str(40), quote: str(QUOTE_MAX), surface: str(200),
    money_legal_or_coding: { type: 'boolean' } }, required: ['requirement', 'kind', 'source_id', 'quote', 'surface', 'money_legal_or_coding'] } },
  non_asks: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, properties: {
    source_id: str(40), quote: str(QUOTE_MAX), reason: str(300) }, required: ['source_id', 'quote', 'reason'] } },
}, required: ['items', 'non_asks'] };

// ---------------------------------------------------------------------------
// Where an ask may come from: the target ticket (subject and body) and every
// message on it the ticket's customer wrote. Support replies, the owner's
// replies on a member's ticket and status notes are not asks.
// ---------------------------------------------------------------------------
export function askSources(context) {
  const target = (context?.tickets ?? []).find(t => t.id === context?.target_id);
  if (!target) return [];
  const out = [{ id: target.id, kind: 'ticket', created_at: target.created_at ?? null, text: `${target.subject ?? ''}\n${target.body ?? ''}` }];
  for (const m of target.messages ?? []) {
    if (m.is_admin_reply !== false || m.author_id !== context.owner_id || /^\s*Status set to/i.test(m.body ?? '')) continue;
    out.push({ id: m.id, kind: 'message', created_at: m.created_at ?? null, text: String(m.body ?? '') });
  }
  return out;
}
// Quotes are compared after folding whitespace, quote marks, dashes and case:
// the check is against invention, not typography.
export const normText = s => String(s ?? '').normalize('NFKC').replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"')
  .replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
export function quoteFound(quote, sourceText) {
  const q = normText(quote), src = normText(sourceText);
  return q.length >= Math.min(12, src.length) && q.length > 0 && src.includes(q);
}

// ---------------------------------------------------------------------------
// The frozen checklist: <state>/checklists/<ticket>.json, owner-only.
// ---------------------------------------------------------------------------
export const checklistFile = (state, ticket) => {
  if (!UUID.test(ticket || '')) throw Error('Invalid ticket id');
  return path.join(state, 'checklists', `${ticket}.json`);
};
const canonicalItems = items => JSON.stringify(items.map(i => ({ id: i.id, requirement: i.requirement, kind: i.kind, source_id: i.source_id, quote: i.quote, surface: i.surface })));
export const itemsDigest = items => sha256(canonicalItems(items));
export function emptyChecklist(context) {
  return { version: 1, ticket_id: context.target_id, owner_ticket: context?.approval?.from_admin === true, items: [], non_asks: [], seen: [], items_sha256: itemsDigest([]) };
}
export function readChecklist(state, ticket) {
  const file = checklistFile(state, ticket);
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 1024 * 1024) throw Error('The frozen checklist must be an owner-only file');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record?.version !== 1 || record.ticket_id !== ticket || !Array.isArray(record.items) || !Array.isArray(record.non_asks) || !Array.isArray(record.seen)) throw Error('The frozen checklist is unusable');
  if (record.items_sha256 !== itemsDigest(record.items)) throw Error('The frozen checklist was changed outside the runner');
  record.items.forEach((item, i) => { if (item.id !== `AC-${i + 1}` || !KINDS.includes(item.kind)) throw Error('The frozen checklist is unusable'); });
  return record;
}
export async function writeChecklist(state, record) {
  const file = checklistFile(state, record.ticket_id);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const dir = lstatSync(path.dirname(file));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw Error('The checklist directory must be owner-only');
  const previous = existsSync(file) ? readChecklist(state, record.ticket_id) : null;
  // Never deleted, never reworded: the stored items must be a prefix of the new ones.
  if (previous && canonicalItems(record.items.slice(0, previous.items.length)) !== canonicalItems(previous.items)) throw Error('A frozen checklist item may not be deleted or reworded');
  const value = { ...record, items_sha256: itemsDigest(record.items) };
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
  return value;
}
// Customer sources no extraction has read yet.
export const newSources = (record, context) => askSources(context).filter(s => !(record?.seen ?? []).includes(s.id));

// ---------------------------------------------------------------------------
// The extraction session's input and the host's check of its output.
// ---------------------------------------------------------------------------
// attachments: the host's manifest entries; shown: the ids sent inline.
export function extractionFacts({ record, sources, attachments = [], shown = [], ownerTicket }) {
  const lines = ['## Host facts for this extraction (trusted, from the runner)', '',
    `- Ticket filed by: ${ownerTicket ? 'the owner of CredentialDOMD (an owner ticket)' : 'a member (a physician using the app)'}.`,
    `- Customer sources to extract from now (quote only from these): ${sources.map(s => `${s.id} (${s.kind})`).join(', ')}.`];
  if (record.items.length) {
    lines.push('- Items already frozen for this ticket (do not repeat, reword or remove them; add only new asks):');
    for (const item of record.items) lines.push(`  - ${item.id} [${item.kind}] ${item.requirement}`);
  }
  const byId = new Map(attachments.map(a => [a.id, a]));
  const images = shown.map(id => byId.get(id)).filter(Boolean);
  if (images.length) lines.push(`- Images shown after this text, in order: ${images.map(a => `${a.id} (from ${a.source_id}${a.target ? '' : ', a related ticket'})`).join(', ')}.`);
  const notShown = attachments.filter(a => a.access === 'delivered' && !shown.includes(a.id));
  if (notShown.length) lines.push(`- Attachments not shown here (the worker reads them): ${notShown.map(a => `${a.id} (${a.media_type}, from ${a.source_id})`).join(', ')}.`);
  const missing = attachments.filter(a => a.access !== 'delivered');
  if (missing.length) lines.push(`- Attachments the host could not deliver: ${missing.map(a => `${a.id} (${a.reason})`).join(', ')}.`);
  return lines.join('\n');
}

// Returns { items, non_asks, errors, confirm }. errors: repairable problems
// (one resume of the session with them). confirm: items a keyword flags as
// money, legal or clinical coding that the extractor said are not; asked once.
export function checkExtraction(output, { context, record, sources, confirmTriggers = true }) {
  const errors = [], confirm = [];
  if (!output || typeof output !== 'object' || !Array.isArray(output.items) || !Array.isArray(output.non_asks)) return { items: [], non_asks: [], errors: ['The result needs items and non_asks lists'], confirm };
  const byId = new Map(sources.map(s => [s.id, s]));
  const ownerTicket = context?.approval?.from_admin === true;
  const known = new Set(record.items.map(i => `${normText(i.quote)}|${normText(i.requirement)}`));
  if (record.items.length + output.items.length > MAX_ITEMS) errors.push(`At most ${MAX_ITEMS} items per ticket; merge closely related asks`);
  if (!record.items.length && !output.items.length) errors.push('A ticket has at least one ask: quote the text that carries it (the subject or body when the ask is only in a screenshot)');
  output.items.forEach((item, i) => {
    const where = `items[${i}]`;
    const source = byId.get(item?.source_id);
    if (!source) { errors.push(`${where}: source_id must be one of ${[...byId.keys()].join(', ')}`); return; }
    if (typeof item.quote !== 'string' || !quoteFound(item.quote, source.text)) errors.push(`${where}: the quote is not in ${item.source_id} word for word (copy at least 12 characters exactly as written)`);
    if (!KINDS.includes(item.kind)) errors.push(`${where}: kind must be one of ${KINDS.join(', ')}`);
    if (typeof item.requirement !== 'string' || !item.requirement.trim() || item.requirement.length > REQUIREMENT_MAX) errors.push(`${where}: requirement is one line of at most ${REQUIREMENT_MAX} characters`);
    else {
      if (sentences(item.requirement).length > 1) errors.push(`${where}: requirement is one sentence`);
      const broken = checkFixedRules(item.requirement, { claims: false }).filter(v => v.rule !== 'device_not_tested');
      if (broken.length) errors.push(`${where}: requirement breaks the reply rules (${ruleNames(broken)}); it is shown to the customer`);
    }
    if (typeof item.surface !== 'string' || !item.surface.trim()) errors.push(`${where}: surface names the screen, form or send path the customer used`);
    if (known.has(`${normText(item.quote)}|${normText(item.requirement)}`)) errors.push(`${where}: repeats a frozen item`);
    if (ownerTicket && item.kind === 'owner_decision' && item.money_legal_or_coding !== true) errors.push(`${where}: on the owner's own ticket the ask is already the owner's decision; owner_decision is only for price or money constants, legal copy or clinical coding. Use bug, change or question`);
    if (confirmTriggers && item.money_legal_or_coding !== true && OWNER_TOPIC.test(`${item.requirement} ${item.quote}`)) confirm.push(i);
  });
  output.non_asks.forEach((n, i) => {
    const source = byId.get(n?.source_id);
    if (!source || typeof n.quote !== 'string' || !quoteFound(n.quote, source.text)) errors.push(`non_asks[${i}]: quote a sentence from one of ${[...byId.keys()].join(', ')} word for word`);
  });
  return { items: output.items, non_asks: output.non_asks, errors, confirm };
}
export function confirmPrompt(indexes) {
  return `The host flagged these items as possibly about price, money constants, legal copy or clinical coding (CPT, wRVU, modifiers, bundling): ${indexes.map(i => `items[${i}]`).join(', ')}. Confirm each: set money_legal_or_coding to true if the item is about one of those, false if not, and adjust kind if needed. Return the whole structured result again.`;
}
// Appends accepted items (host ids) and non_asks; marks the sources read.
export function extendChecklist(record, { items, non_asks }, { runName, sources, now = new Date().toISOString() }) {
  const next = { ...record, items: [...record.items], non_asks: [...record.non_asks], seen: [...new Set([...record.seen, ...sources.map(s => s.id)])] };
  for (const item of items) {
    next.items.push({ id: `AC-${next.items.length + 1}`, requirement: item.requirement.trim(), kind: item.kind, source_id: item.source_id, quote: item.quote.trim(),
      surface: item.surface.trim(), money_legal_or_coding: item.money_legal_or_coding === true, added_by: 'extraction', added_run: runName, added_at: now });
  }
  for (const n of non_asks) next.non_asks.push({ index: next.non_asks.length, source_id: n.source_id, quote: n.quote.trim(), reason: n.reason.trim(), run: runName, verdict: null });
  next.items_sha256 = itemsDigest(next.items);
  return next;
}
// A reviewer's verdicts on non_asks and the asks it found missing. Returns
// the extended record: a non-ask judged an ask, or a missed ask whose quote
// checks out, becomes a new item (it was dropped; it is never lost).
export function applyAskVerdicts(record, { non_asks = [], missed_asks = [] }, { context, runName, now = new Date().toISOString() }) {
  const next = { ...record, items: [...record.items], non_asks: record.non_asks.map(n => ({ ...n })) };
  const sources = new Map(askSources(context).map(s => [s.id, s]));
  const added = [];
  const add = (item, by) => {
    if (next.items.length >= MAX_ITEMS || !KINDS.includes(item.kind) || typeof item.requirement !== 'string' || !item.requirement.trim() || item.requirement.length > REQUIREMENT_MAX) return;
    if (checkFixedRules(item.requirement, { claims: false }).some(v => v.rule !== 'device_not_tested')) return;
    if (next.items.some(i => normText(i.quote) === normText(item.quote) && normText(i.requirement) === normText(item.requirement))) return;
    const id = `AC-${next.items.length + 1}`;
    next.items.push({ id, requirement: item.requirement.trim(), kind: item.kind, source_id: item.source_id, quote: item.quote.trim(), surface: (item.surface ?? '').trim() || 'not stated',
      money_legal_or_coding: false, added_by: by, added_run: runName, added_at: now });
    added.push(id);
  };
  for (const v of non_asks) {
    const n = next.non_asks.find(x => x.index === v.index && x.verdict === null);
    if (!n || !['ask', 'not_ask'].includes(v.verdict)) continue;
    n.verdict = v.verdict; n.verdict_run = runName;
    if (v.verdict === 'ask') add({ requirement: v.requirement, kind: v.kind, source_id: n.source_id, quote: n.quote, surface: '' }, 'review_non_ask');
  }
  for (const m of missed_asks) {
    const source = sources.get(m?.source_id);
    if (source && typeof m.quote === 'string' && quoteFound(m.quote, source.text)) add(m, 'review_missed');
  }
  next.items_sha256 = itemsDigest(next.items);
  return { record: next, added };
}

// Sentences that read like an ask but no item or non-ask quotes: shown to the
// reviewer as a hint (the critique's replacement for the 60% overlap rule).
const ASK_MARKER = /\?|\b(?:please|can you|could you|would you|should|need|needs|want|wants|make|add|remove|change|fix|still|also|doesn't|does not|isn't|is not|can't|cannot|won't|not working|wrong|instead|again|missing|broken|loses?|lost|drops?|dropped|fails?|failed|error|bug|problem|issue)\b/i;
export function coverageHints(context, record) {
  const quotes = [...record.items.map(i => normText(i.quote)), ...record.non_asks.map(n => normText(n.quote))];
  const hints = [];
  for (const source of askSources(context)) {
    for (const sentence of sentences(source.text)) {
      const s = normText(sentence);
      if (s.length < 8 || !ASK_MARKER.test(sentence)) continue;
      if (quotes.some(q => q.includes(s) || s.includes(q))) continue;
      hints.push({ source_id: source.id, sentence: sentence.slice(0, 300) });
    }
  }
  return hints.slice(0, 20);
}

// ---------------------------------------------------------------------------
// The worker's result against the frozen checklist (repairable problems).
//   items        the frozen items the worker saw
//   bindings     Map(ac id -> Set of test ids "file::name") bound to the item
//                by a reproduction or declared test (this run or a released one)
//   attachments  the model view (attachments.mjs modelView): reviewed or not
// ---------------------------------------------------------------------------
const oneLine = (text, max) => typeof text === 'string' && text.length <= max && !/[\n\r]/.test(text);
export function checklistErrors(result, { items, bindings = new Map(), attachments = [], ownerTicket = false }) {
  const errors = [];
  const entries = Array.isArray(result?.checklist) ? result.checklist : [];
  const ids = items.map(i => i.id);
  const kind = new Map(items.map(i => [i.id, i.kind]));
  const claims = Array.isArray(result?.reply?.claims) ? result.reply.claims : [];
  for (const id of ids) {
    const n = entries.filter(e => e?.ac_id === id).length;
    if (n !== 1) errors.push(`checklist: ${id} must appear exactly once (found ${n})`);
  }
  for (const e of entries) if (!ids.includes(e?.ac_id)) errors.push(`checklist: ${String(e?.ac_id).slice(0, 12)} is not a frozen item (${ids.join(', ')})`);
  for (const e of entries.filter(x => ids.includes(x?.ac_id))) {
    const where = `checklist ${e.ac_id}`;
    const k = kind.get(e.ac_id);
    if (!STATES.includes(e.state)) { errors.push(`${where}: state must be one of ${STATES.join(', ')}`); continue; }
    if (!oneLine(e.remaining, REMAINING_MAX)) errors.push(`${where}: remaining is one line of at most ${REMAINING_MAX} characters`);
    else if (e.state !== 'done' && !e.remaining.trim()) errors.push(`${where}: say what remains (remaining) unless the item is done`);
    else if (e.remaining.trim()) {
      if (sentences(e.remaining).length > 1) errors.push(`${where}: remaining is one sentence`);
      const question = ownerTicket && e.state === 'needs_owner';
      const broken = checkFixedRules(e.remaining, { claims: !question }).filter(v => v.rule !== 'device_not_tested');
      if (broken.length) errors.push(`${where}: remaining breaks the reply rules (${ruleNames(broken)}); it is shown to the customer and may not report a result`);
      if (question && !e.remaining.trim().endsWith('?')) errors.push(`${where}: on the owner's ticket, remaining for needs_owner is the question the owner must answer, ending with "?"`);
    }
    if (k === 'owner_decision' && e.state !== 'needs_owner') errors.push(`${where}: an owner_decision item is needs_owner; only the owner decides it`);
    if (k !== 'owner_decision' && e.state === 'needs_owner' && k !== 'data_fix') errors.push(`${where}: needs_owner is for owner_decision and data_fix items; routine work stays with the worker`);
    if ((k === 'data_fix' || k === 'device_probe') && e.state === 'done') errors.push(`${where}: a ${k} item is never done by the agent (${k === 'data_fix' ? 'the owner runs the data change' : 'only the customer can confirm it on the device'})`);
    const tests = Array.isArray(e.tests) ? e.tests : [];
    if (tests.some(t => typeof t !== 'string' || !/^[^:\s][^:]*\.test\.m?js::.{1,300}$/.test(t))) errors.push(`${where}: tests are "<test file>::<test name>"`);
    const mine = claims.filter(c => c?.ac_id === e.ac_id);
    if (e.state === 'done') {
      if (k === 'bug' || k === 'change') {
        const bound = bindings.get(e.ac_id) ?? new Set();
        if (!tests.length) errors.push(`${where}: done needs the passing test that pins it (tests), a reproduction or declared test bound to ${e.ac_id}`);
        for (const t of tests) if (!bound.has(t)) errors.push(`${where}: ${t.slice(0, 120)} is not a reproduction or declared test bound to ${e.ac_id}`);
        if (!mine.some(c => typeof c?.evidence?.test === 'string' && tests.includes(c.evidence.test))) errors.push(`${where}: done needs a claim for ${e.ac_id} whose evidence is one of its tests`);
      } else if (k === 'question' && !mine.length) errors.push(`${where}: an answered question needs a claim for ${e.ac_id} with test or file evidence`);
    }
  }
  claims.forEach((c, i) => {
    const where = `reply.claims[${i}]`;
    if (!ids.includes(c?.ac_id)) errors.push(`${where}: ac_id must be a frozen item`);
    if (!oneLine(c?.text, 160) || !c.text.trim()) { errors.push(`${where}: text is one line of at most 160 characters`); return; }
    const broken = checkFixedRules(c.text, { claims: false });
    if (broken.length) errors.push(`${where}: ${ruleNames(broken)}`);
    const parsed = parseClaimEvidence(c.evidence, where);
    errors.push(...parsed.problems);
  });
  // Attachments (G6): each one on the target ticket that was delivered must
  // have been read, and gets exactly one observation.
  const observations = Array.isArray(result?.attachment_observations) ? result.attachment_observations : [];
  const byAtt = new Map(attachments.map(a => [a.attachment, a]));
  for (const a of attachments.filter(x => x.target && x.access !== 'unavailable')) {
    if (a.access !== 'reviewed') errors.push(`attachments: Read ${a.local_path} (${a.attachment}, the customer's ${a.media_type === 'application/pdf' ? 'PDF' : 'screenshot'}) with the Read tool before answering; the host saw no Read of it`);
    else if (observations.filter(o => o?.attachment === a.attachment).length !== 1) errors.push(`attachment_observations: give exactly one observation for ${a.attachment}`);
  }
  for (const o of observations) {
    const a = byAtt.get(o?.attachment);
    if (!a || a.access === 'unavailable') errors.push(`attachment_observations: ${String(o?.attachment).slice(0, 12)} is not a delivered attachment`);
    else if (a.access !== 'reviewed') errors.push(`attachment_observations: ${a.attachment} was not read`);
    if (!oneLine(o?.observed, OBSERVED_MAX) || !o.observed.trim()) errors.push(`attachment_observations ${String(o?.attachment).slice(0, 12)}: observed is one paragraph of at most ${OBSERVED_MAX} characters`);
    for (const id of Array.isArray(o?.supports) ? o.supports : []) if (!ids.includes(id)) errors.push(`attachment_observations ${String(o?.attachment).slice(0, 12)}: ${String(id).slice(0, 12)} is not a frozen item`);
  }
  // An item whose source carried a screenshot stands on what the screenshot shows.
  for (const item of items) {
    const own = attachments.filter(a => a.target && a.access === 'reviewed' && a.source_id === item.source_id);
    if (own.length && !observations.some(o => own.some(a => a.attachment === o?.attachment) && Array.isArray(o.supports) && o.supports.includes(item.id))) {
      errors.push(`attachment_observations: ${item.id} came with ${own.map(a => a.attachment).join(', ')}; list ${item.id} in the supports of that attachment's observation`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The host's decision, per item. Nothing here reads the model's prose.
//   entries    the worker's checklist entries (its proposal)
//   claims     the host's verdict per reply claim: { ac_id, verified, kind:
//              'test'|'file', test, source: 'this_change'|'base' } ('base':
//              the test passed at a commit the live build contains)
//   code       { outcome, gates_pass, review_pass, review_items: {ac: verdict},
//              green: Set(test ids green at this change's head), release_verified }
//   bindings   Map(ac -> Set(test ids)): reproduction or declared tests bound to
//              the item by this run, or by a released run whose reviewer found
//              the item met
//   disputed   Set of ac ids an unconfirmed or disputed observation supports
//   workerItems  the ids the worker saw (items added after it ran are "new")
// Returns [{ id, state, remaining, detail }]. A "done" the host cannot prove
// is not shown as done: held for release it is "in_progress", a refused change
// is "not_done", anything else unproven is "partial" (not confirmed yet).
// ---------------------------------------------------------------------------
export function finalStates({ items, entries = [], claims = [], code = {}, bindings = new Map(), disputed = new Set(), workerItems = null }) {
  const byId = new Map(entries.map(e => [e.ac_id, e]));
  const seenByWorker = new Set(workerItems ?? items.map(i => i.id));
  return items.map(item => {
    const e = byId.get(item.id);
    if (!seenByWorker.has(item.id) || !e) return { id: item.id, state: 'not_done', remaining: '', detail: 'new' };
    const out = { id: item.id, state: e.state, remaining: String(e.remaining ?? '').trim(), detail: null };
    const set = (state, detail) => Object.assign(out, { state, remaining: '', detail });
    if (item.kind === 'owner_decision') return Object.assign(out, { state: 'needs_owner' });
    if (e.state !== 'done') return out;
    if (item.kind === 'data_fix' || item.kind === 'device_probe') return set('partial', 'not_confirmed');
    if (disputed.has(item.id)) return set('partial', 'not_confirmed');
    const verified = claims.filter(c => c.ac_id === item.id && c.verified);
    if (item.kind === 'question') return verified.length ? out : set('partial', 'not_confirmed');
    // bug or change: a test bound to this item.
    const bound = bindings.get(item.id) ?? new Set();
    const tests = (Array.isArray(e.tests) ? e.tests : []).filter(t => bound.has(t));
    // Already live: the bound test passed at a commit the live build contains.
    if (verified.some(c => c.kind === 'test' && c.source === 'base' && tests.includes(c.test))) return out;
    // This run's change.
    const verdict = code.review_items?.[item.id];
    if (tests.some(t => code.green?.has(t))) {
      if (code.outcome === 'released' && code.release_verified && code.review_pass && verdict === 'met' &&
          verified.some(c => c.kind === 'test' && c.source === 'this_change' && tests.includes(c.test))) return out;
      if (code.outcome === 'held' && code.gates_pass && code.review_pass && ['met', 'partial'].includes(verdict)) return set('in_progress', 'held');
      return set('not_done', 'change_not_merged');
    }
    return set('partial', 'not_confirmed');
  });
}

// ---------------------------------------------------------------------------
// The customer's reply, rendered by the host: a fixed opening, the claims the
// host verified, the questions, the footer, a fixed closing. No other prose.
// ---------------------------------------------------------------------------
const trimEnd = text => String(text).trim().replace(/[\s.;:,!]+$/, '');
export function footerLine(n, item, final, { ownerTicket }) {
  const req = trimEnd(item.requirement);
  const rest = trimEnd(final.remaining ?? '');
  let line;
  if (final.state === 'done') line = `${n}. ${req}: done`;
  else if (final.state === 'in_progress') line = `${n}. ${req}: in progress, a change is ready and waiting to be released`;
  else if (final.state === 'needs_owner') line = ownerTicket ? `${n}. ${req}: needs your decision: ${rest ? `${rest.replace(/\?*$/, '')}?` : 'please decide how it should work'}` : `${n}. ${req}: waiting on a decision from CredentialDOMD`;
  else if (final.state === 'partial') line = final.detail === 'not_confirmed' || !rest ? `${n}. ${req}: partly done, not confirmed yet` : `${n}. ${req}: partly done, still to do: ${rest}`;
  else line = rest ? `${n}. ${req}: not done yet, next: ${rest}` : `${n}. ${req}: not done yet`;
  // Nothing here runs on a phone, a tablet or in a mail client (c0aa1d32).
  if (namesDevice(line)) line = `${line} (not tested on that device)`;
  return line;
}
export function renderFooter(items, finals, { ownerTicket }) {
  const byId = new Map(finals.map(f => [f.id, f]));
  return [FOOTER_HEADING, ...items.map((item, i) => footerLine(i + 1, item, byId.get(item.id) ?? { state: 'not_done', remaining: '' }, { ownerTicket }))].join('\n');
}
export function renderAgentReply({ opening, confirmed = [], questions = [], items, finals, closing, ownerTicket }) {
  const parts = [OPENINGS[opening]];
  if (confirmed.length) parts.push([CONFIRMED_HEADING, ...confirmed.map(t => `- ${t}`)].join('\n'));
  if (questions.length) parts.push([QUESTIONS_HEADING, ...questions.map(q => `- ${q}`)].join('\n'));
  if (items.length) parts.push(renderFooter(items, finals, { ownerTicket }));
  if (CLOSINGS[closing]) parts.push(CLOSINGS[closing]);
  return parts.join('\n\n');
}
