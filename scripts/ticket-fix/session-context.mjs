// What the reproduction and worker sessions read of the ticket history
// (2026-09-29). Every turn of a session re-reads its whole prompt, and the
// runner used to put the full history in it: for the owner's account that is
// 99 tickets, 308 messages and 78 KB of saved reviews, 418 KB of JSON, and a
// first turn of about 196K tokens. The reproduction session of 16:35Z spent
// its $3 budget re-reading it (error_max_budget_usd at $3.0096) before it had
// written a test.
//
// sessionEvidence() gives those two sessions, in at most EVIDENCE_LIMIT bytes:
//   target       the target ticket and its whole thread; a thread too long for
//                its share keeps its first message and the newest that fit,
//                with the count and dates of the ones left out
//   saved_review this ticket's saved case review: pending follow-up (the exact
//                work text completed_follow_up must name), remembered answers,
//                the host's last state per checklist item
//   answered_on_other_tickets  questions answered in the saved reviews of the
//                customer's other tickets (never ask them again)
//   related      the other tickets, newest activity first: the newest in
//                detail (subject, status, dates, the opening, the newest
//                customer message), then an index (id, status, date, subject),
//                then a count of the rest
// The attachments are the host facts' (att-N with local_path), not repeated.
//
// caseHistory() is the whole history, which the runner writes to a file the
// same two sessions may Grep and Read on demand (HISTORY_FILE, in this
// ticket's own attachment folder), so a message the summary leaves out (a
// related ticket's middle messages, a long thread's middle) is still one
// search away and costs nothing on the turns that do not need it.
//
// What the host checks against the full history (runs/<run>/context.json):
// every cited evidence id, completed_follow_up against the saved pending
// work, and each question's wording against the answers saved in case
// reviews (an exact match of the normalized text). It does NOT read the
// customer's messages for answers: a question answered only in a message
// passes the host, so the session must search the history file before it
// asks (review of 2026-09-29). The extractor, the reviewer and the confirmer
// still get what they got before.
const CUSTOMER_LABELS = new Set(['recorded_customer_author', 'owner_author']);
export const EVIDENCE_LIMIT = 40 * 1024;
// A whole first prompt (the role's prompt file, the host facts and this
// evidence) of the reproduction or the worker stays under this; the runner
// logs a prompt that does not.
export const PROMPT_LIMIT = 96 * 1024;
const TARGET_SHARE = 20 * 1024;
const REVIEW_SHARE = 8 * 1024;
const ANSWERS_SHARE = 3 * 1024;
const DETAILED_MAX = 25;

// What stands for a saved review too large for the session view.
const REVIEW_LEFT_OUT = Object.freeze({ omitted: 'too large for this session; it is in the case history file' });

const size = value => Buffer.byteLength(JSON.stringify(value));
export const clip = (text, max) => {
  const s = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  return s.length <= max ? s : `${s.slice(0, max)} [${s.length - max} more characters cut by the host]`;
};
const norm = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const activity = t => [t.updated_at, t.created_at, ...(t.messages ?? []).map(m => m.created_at)].filter(v => typeof v === 'string').sort().at(-1) ?? '';

// The target ticket, whole when it fits its share. Otherwise bodies are cut
// step by step until the thread's first message and its newest fit, and the
// thread keeps those and as many of the newest as fit.
function targetView(ticket, share) {
  const tiers = [[Infinity, Infinity, Infinity], [6000, 2000, 300], [3000, 1000, 300], [1000, 400, 200], [300, 200, 120]];
  for (const [tier, [bodyMax, messageMax, subjectMax]] of tiers.entries()) {
    const shaped = { ...ticket, subject: clip(ticket.subject, subjectMax), body: clip(ticket.body, bodyMax) };
    delete shaped.context_only;
    const messages = (ticket.messages ?? []).map(m => ({ ...m, body: clip(m.body, messageMax) }));
    const whole = { ...shaped, messages };
    if (size(whole) <= share) return { view: whole, shown: messages.length, total: messages.length };
    const skeleton = { ...shaped, messages: [], omitted_messages: { count: messages.length, from: '0000-00-00T00:00:00.000000+00:00', to: '0000-00-00T00:00:00.000000+00:00',
      note: 'Left out here to keep each turn small; every one is in the case history file named in the host facts (Grep it). The checklist was extracted from all of them.' } };
    let used = size(skeleton);
    if (used > share) continue;
    const keep = new Set();
    const take = i => { const n = size(messages[i]) + 1; if (used + n > share) return false; keep.add(i); used += n; return true; };
    if (messages.length) take(0);
    for (let i = messages.length - 1; i > 0; i--) if (!take(i)) break;
    if (keep.size < Math.min(2, messages.length) && tier < tiers.length - 1) continue;
    const kept = [...keep].sort((a, b) => a - b);
    const left = messages.map((m, i) => (keep.has(i) ? null : m)).filter(Boolean);
    const view = { ...shaped, messages: kept.map(i => messages[i]) };
    if (left.length) view.omitted_messages = { ...skeleton.omitted_messages, count: left.length, from: left[0].created_at ?? null, to: left.at(-1).created_at ?? null };
    return { view, shown: kept.length, total: messages.length };
  }
  // Unreachable for a ticket of the database's shape; kept as a hard bound.
  return { view: { id: ticket.id, subject: clip(ticket.subject, 120), status: ticket.status, messages: [], omitted_messages: { count: (ticket.messages ?? []).length } }, shown: 0, total: (ticket.messages ?? []).length };
}

// Adds items from a list while the running size stays within share.
function within(list, share) {
  const out = [];
  let used = 2;
  for (const item of list) {
    const n = size(item) + 1;
    if (used + n > share) break;
    out.push(item); used += n;
  }
  return out;
}

function savedReviewView(record, share) {
  if (!record) return null;
  const answers = [...(record.remembered_answers ?? []), ...(record.assessment?.answered_questions ?? [])];
  const seen = new Set();
  const remembered = answers.filter(q => { const k = norm(q?.question); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .map(q => ({ question: clip(q.question, 300), answer: clip(q.answer, 300), evidence_ids: Array.isArray(q.evidence_ids) ? q.evidence_ids.slice(0, 5) : [] }));
  const base = { recorded_at: record.recorded_at ?? null, run_mode: record.run_mode ?? null, needs_owner_review: record.needs_owner_review ?? null,
    continuation: record.continuation ? { state: record.continuation.state ?? null, attempts: record.continuation.attempts ?? null } : null,
    summary: clip(record.summary, 1200),
    checklist_states: (record.checklist_states ?? []).map(s => ({ id: s.id, state: s.state })),
    ...(record.unreleased_claims ? { unreleased_code_outcome: record.unreleased_claims.code_outcome ?? null } : {}) };
  // The pending work keeps its exact text: completed_follow_up must repeat it.
  const pending = (record.pending_follow_up ?? []).map(f => ({ work: f.work, owner: f.owner, next_action: clip(f.next_action, 300) }));
  let view = { ...base, pending_follow_up: pending, remembered_answers: remembered };
  if (size(view) <= share) return view;
  view = { ...base, summary: clip(record.summary, 300), pending_follow_up: [], remembered_answers: [] };
  // Pending work first (a completion must name it), then the answers.
  const room = share - size(view);
  view.pending_follow_up = within(pending, Math.max(0, room));
  view.remembered_answers = within(remembered, Math.max(0, room - size(view.pending_follow_up)));
  const omitted = { pending_follow_up: pending.length - view.pending_follow_up.length, remembered_answers: remembered.length - view.remembered_answers.length };
  if (omitted.pending_follow_up || omitted.remembered_answers) view.omitted = omitted;
  return view;
}

function answersElsewhere(reviews, targetId, share) {
  const seen = new Set();
  const out = [];
  const newest = [...reviews].filter(r => r?.target_id !== targetId).sort((a, b) => String(b.recorded_at ?? '').localeCompare(String(a.recorded_at ?? '')));
  for (const record of newest) {
    for (const q of [...(record.remembered_answers ?? []), ...(record.assessment?.answered_questions ?? [])]) {
      const k = norm(q?.question);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ ticket_id: record.target_id, question: clip(q.question, 200), answer: clip(q.answer, 240) });
    }
  }
  const shown = within(out, share);
  return { list: shown, total: out.length };
}

function detailed(ticket) {
  const messages = ticket.messages ?? [];
  const customer = messages.filter(m => CUSTOMER_LABELS.has(m.actor_label)).at(-1);
  return { id: ticket.id, subject: clip(ticket.subject, 120), status: ticket.status ?? null, created_at: ticket.created_at ?? null, updated_at: ticket.updated_at ?? null,
    ...(ticket.archived_at ? { archived_at: ticket.archived_at } : {}), messages: messages.length,
    ...(messages.length ? { last_message_at: messages.at(-1).created_at ?? null } : {}),
    opening: clip(ticket.body, 240),
    ...(customer ? { newest_customer_message: { id: customer.id, created_at: customer.created_at ?? null, actor_label: customer.actor_label, excerpt: clip(customer.body, 240) } } : {}) };
}
const indexed = ticket => ({ id: ticket.id, status: ticket.status ?? null, last_activity: activity(ticket).slice(0, 10), subject: clip(ticket.subject, 60) });

// context: the runner's full context (ticket-agent-context.mjs loadContext +
// attachPriorReviews). Returns { text, view, stats }; text is at most limit
// bytes.
export function sessionEvidence(context, { limit = EVIDENCE_LIMIT } = {}) {
  const tickets = context.tickets ?? [];
  const target = tickets.find(t => t.id === context.target_id) ?? { id: context.target_id, messages: [], thread_not_loaded: true };
  const related = tickets.filter(t => t.id !== context.target_id).sort((a, b) => activity(b).localeCompare(activity(a)) || String(a.id).localeCompare(String(b.id)));
  const reviews = context.prior_reviews ?? [];
  const fullBytes = size(context);
  const thread = targetView(target, Math.min(TARGET_SHARE, limit));
  const header = {
    view: 'session',
    about: 'The host trimmed the case history for this session so each turn stays small: the target ticket and its thread, this ticket\'s saved review, answers saved on the customer\'s other tickets, and a summary of those tickets. The whole history (every ticket, message and saved review of this customer) is in the case history file named in the host facts: Grep it before you ask the customer anything or cite a confirmation, and Read only the lines you need. Any ticket or message id in it may be cited. The host checks every cited id against the whole history, and completed_follow_up must repeat a saved_review.pending_follow_up work text exactly. The host refuses a question only when its wording matches an answer saved in a case review; it does not read the messages for you, so an answer given only in a message is yours to find. Attachments are listed in the host facts (att-N with local_path).',
    target_id: context.target_id, run_mode: context.run_mode, owner_id: context.owner_id, approval: context.approval, action_scope: context.action_scope,
    history_complete: context.history_complete, limitations: context.limitations, interpretation: context.interpretation,
  };
  const view = { ...header, target: thread.view,
    saved_review: savedReviewView(reviews.find(r => r?.target_id === context.target_id), REVIEW_SHARE),
    answered_on_other_tickets: [], related_tickets: { total: related.length, detailed: [], index: [], omitted: related.length } };
  const answers = answersElsewhere(reviews, context.target_id, ANSWERS_SHARE);
  view.answered_on_other_tickets = answers.list;
  // The related tickets fill what is left: detailed first, then the index.
  const room = limit - size(view) - 64;
  const detail = within(related.slice(0, DETAILED_MAX).map(detailed), Math.max(0, Math.floor(room * 0.6)));
  const index = within(related.slice(detail.length).map(indexed), Math.max(0, room - size(detail)));
  view.related_tickets = { total: related.length, detailed: detail, index, omitted: related.length - detail.length - index.length };
  // A hard bound whatever the shapes above produced: drop from the end.
  let text = JSON.stringify(view);
  while (Buffer.byteLength(text) > limit) {
    if (view.related_tickets.index.length) view.related_tickets.index.pop();
    else if (view.related_tickets.detailed.length) view.related_tickets.detailed.pop();
    else if (view.answered_on_other_tickets.length) view.answered_on_other_tickets.pop();
    // Replaced once: the next steps are the limitations, then a failure (the
    // replacement is still truthy, and testing that alone looped forever).
    else if (view.saved_review && view.saved_review !== REVIEW_LEFT_OUT) view.saved_review = REVIEW_LEFT_OUT;
    else if (view.limitations?.length > 20) view.limitations = view.limitations.slice(0, 20);
    else throw Error('The session evidence cannot fit its limit');
    view.related_tickets.omitted = related.length - view.related_tickets.detailed.length - view.related_tickets.index.length;
    text = JSON.stringify(view);
  }
  return { text, view, stats: { bytes: Buffer.byteLength(text), full_bytes: fullBytes, limit,
    target_messages: { shown: thread.shown, total: thread.total },
    related: { total: related.length, detailed: view.related_tickets.detailed.length, indexed: view.related_tickets.index.length, omitted: view.related_tickets.omitted },
    saved_review: view.saved_review === REVIEW_LEFT_OUT ? 'omitted' : Boolean(view.saved_review), answered_elsewhere: { shown: view.answered_on_other_tickets.length, total: answers.total } } };
}

// The whole history as the case history file: one JSON record per line, its
// kind first, so a Grep hit carries the ids it may cite and a Read of a few
// lines never needs the rest:
//   case               the target, run mode, owner, completeness, approval
//   ticket             each ticket without its messages (their count instead)
//   message            each message, after its ticket, in the history's order
//   saved_answer       each answered or remembered question of a saved review
//   pending_follow_up  each pending work item of a saved review
//   saved_review       the rest of each saved review
//   attachment         the history's attachment inventory (storage paths; the
//                      files to Read are the host facts' local_path)
export const HISTORY_FILE = 'case-history.jsonl';
export function caseHistory(context) {
  const lines = [];
  // The kind is first and cannot be overwritten by a field of the record.
  const add = (kind, ...parts) => lines.push(JSON.stringify(Object.assign({ kind }, ...parts, { kind })));
  add('case', { target_id: context.target_id, run_mode: context.run_mode ?? null, owner_id: context.owner_id ?? null, history_complete: context.history_complete ?? null,
    limitations: context.limitations ?? [], approval: context.approval ?? null, action_scope: context.action_scope ?? null });
  for (const ticket of context.tickets ?? []) {
    const { messages = [], ...fields } = ticket;
    add('ticket', fields, { messages: messages.length });
    for (const message of messages) add('message', { ticket_id: ticket.id }, message);
  }
  for (const record of context.prior_reviews ?? []) {
    const { remembered_answers: remembered = [], pending_follow_up: pending = [], assessment = null, ...rest } = record ?? {};
    const { answered_questions: answered = [], ...assessed } = assessment ?? {};
    const about = { ticket_id: record?.target_id ?? null, recorded_at: record?.recorded_at ?? null };
    for (const q of remembered ?? []) add('saved_answer', about, { from: 'remembered_answers' }, q);
    for (const q of answered ?? []) add('saved_answer', about, { from: 'assessment.answered_questions' }, q);
    for (const f of pending ?? []) add('pending_follow_up', about, f);
    add('saved_review', about, rest, assessment ? { assessment: assessed } : {});
  }
  for (const attachment of context.attachments ?? []) add('attachment', attachment);
  return `${lines.join('\n')}\n`;
}

export const kb = n => `${Math.round(n / 1024)} KB`;
