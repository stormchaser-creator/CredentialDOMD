// Fixed reply rules (design G5 phase 0) and structured, evidence-bound claims
// (critique amendment A3) for every CredentialDOMD support reply.
//
// Pure: no network, no database, no git. The evidence sources (git at HEAD, a
// host-written gates file, a host-recorded query) are passed in, so the same
// checks run in unit tests, in the hourly agent and in post-reply.mjs.
//
// Why the rules are fixed and not left to the writer (ticket audit 2026-09-25):
// 12 tickets were told "fixed in build c237149", a 7-line copy commit; other
// replies cited deploy heads and unrelated commits; one promised a result "on
// your iPhone" nobody had tried. Only the host may write a commit or build id,
// and only from git and the live version.json.

export const AUTOMATED_LABEL = 'CredentialDOMD Support · Automated';
export const PLACEHOLDERS = Object.freeze(['FIX_COMMIT', 'BUILD']);
export const BODY_MAX = 4000;
export const CLAIM_TEXT_MAX = 160;
export const CONTEXT_MAX = 600;
export const MAX_CLAIMS = 20;
export const MAX_NOT_DONE = 20;

// Opening and closing lines are fixed. The writer picks a key; it cannot add
// free prose there. Customer-facing: no em dashes, no names.
export const OPENINGS = Object.freeze({
  update: 'Here is where your request stands.',
  answer: 'Here is the answer to your question.',
  checked: 'Thanks for the report. Here is what we checked.',
});
export const CLOSINGS = Object.freeze({
  reply_here: 'If anything still looks wrong, reply on this thread and we will pick it up here.',
  follow_up: 'We will post on this thread when the remaining work is done.',
  none: '',
});
export const HEADINGS = Object.freeze({ confirmed: 'What we confirmed:', pending: 'Not done yet:' });

// Customer-facing hygiene applied on the host, where the model cannot skip it
// (ticket 821d2f76). The model sometimes echoes the label it was told the host
// adds; strip any leading copies so a customer never sees the header twice
// (seen on two replies 2026-09-21). Em dashes read as machine-written to this
// product's customers: a dash at the start of a line is dropped, one right
// before punctuation or at a line's end is dropped, and one between words
// becomes a comma. Only the em dash is touched: an en dash is a range
// ("Aug 1 \u{2013} Aug 15", "9\u{2013}5") and turning it into a comma would
// make a range read as a list. Nothing else in the reply is rewritten.
export function customerReplyText(reply) {
  return String(reply)
    .replace(/^(?:\s*CredentialDOMD Support · Automated\s*)+/u, '')
    .replace(/^[ \t]*\u{2014}[ \t]*/gmu, '')
    .replace(/[ \t]*\u{2014}[ \t]*(?=[,.;:!?)]|$)/gmu, '')
    .replace(/[ \t]*\u{2014}[ \t]*/gu, ', ');
}

export const RULE_TEXT = Object.freeze({
  commit_or_build_id: 'Do not write commit, build or ticket ids; write {{FIX_COMMIT}} or {{BUILD}} and the host fills them in from git and the live version.json.',
  em_dash: 'Do not use the em dash (U+2014).',
  hipaa: 'Do not mention HIPAA.',
  compliant: 'Do not describe anything as "compliant".',
  owner_name: 'Do not use the owner\'s name; every reply comes from CredentialDOMD Support.',
  device_not_tested: 'A sentence about a result on a phone or other device must say it was not tested on that device.',
  unknown_placeholder: 'Only {{FIX_COMMIT}} and {{BUILD}} are filled in by the host.',
  control_character: 'Remove control characters.',
  too_long: `The reply is longer than ${BODY_MAX} characters.`,
  follow_up_without_pending: 'The "follow_up" closing promises more work; use it only when something is listed as not done yet.',
  fix_commit_unavailable: 'The host could not supply {{FIX_COMMIT}}: it needs a single-parent commit that is live and touches a file the reply cites.',
  build_unavailable: 'The host could not read the live build from version.json for {{BUILD}}.',
});

// A token of 7 to 40 hex characters standing alone. Digits-only tokens are
// numbers (amounts, dates, counts), not revisions, and are left alone.
const HEX = /(?<![0-9A-Za-z])[0-9a-fA-F]{7,40}(?![0-9A-Za-z])/g;
const OWNER_NAME = /\b(?:eric|whit|whitney)\b/i;
const HIPAA = /\bhipaa\b/i;
const COMPLIANT = /\bcompliant\b/i;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
// Everything C0 except tab and newline, plus DEL.
const hasControl = value => [...value].some(ch => { const c = ch.charCodeAt(0); return (c < 32 && c !== 9 && c !== 10) || c === 127; });
const DEVICE = /\b(?:iphone|ipad|ipados|ios|android|safari|tablet|mobile(?!\s+numbers?)|devices?|mail app|apple mail)\b|\bphones?\b(?!\s*(?:numbers?|#|fields?|extensions?))/i;
// Third-person and past forms only, so an instruction ("Open Settings on your
// phone") is not read as a reported result.
const RESULT = /\b(?:works|worked|working|fixed|shows|showing|shown|displays|displayed|appears|opens|opened|loads|loaded|renders|rendered|looks|scrolls|scrolled|sends|sent|saves|saved|now|no longer|will|should|resolved|behaves)\b/i;
const NOT_TESTED = /\b(?:not (?:been |yet )?(?:tested|checked|tried|verified)|untested|(?:could|can)(?:n't| ?not) (?:test|check|try)|(?:have|has)(?:n't| not) (?:been )?(?:tested|checked|tried)|(?:was|were)(?:n't| not) (?:tested|checked|tried))\b/i;

export function hexTokens(text) {
  return [...String(text).matchAll(HEX)].map(m => m[0]).filter(token => !/^[0-9]+$/.test(token));
}
export function sentences(text) {
  return String(text).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}
const excerpt = value => (value.length > 80 ? `${value.slice(0, 77)}...` : value);

// Every rule a customer-facing text must pass. Returns [{rule, excerpt}], empty
// when the text passes. `hex: false` is for text the host already filled in.
export function checkFixedRules(text, { hex = true } = {}) {
  const value = String(text ?? '');
  const found = [];
  const add = (rule, detail = '') => found.push({ rule, excerpt: excerpt(detail) });
  if (value.length > BODY_MAX) add('too_long', String(value.length));
  if (hasControl(value)) add('control_character');
  if (hex) for (const token of new Set(hexTokens(value))) add('commit_or_build_id', token);
  if (value.includes('\u2014')) add('em_dash');
  if (HIPAA.test(value)) add('hipaa', HIPAA.exec(value)[0]);
  if (COMPLIANT.test(value)) add('compliant', COMPLIANT.exec(value)[0]);
  if (OWNER_NAME.test(value)) add('owner_name', OWNER_NAME.exec(value)[0]);
  for (const [, name] of value.matchAll(PLACEHOLDER)) if (!PLACEHOLDERS.includes(name)) add('unknown_placeholder', `{{${name}}}`);
  for (const sentence of sentences(value)) {
    if (sentence.endsWith('?')) continue; // a question asks for a result; it does not report one
    if (DEVICE.test(sentence) && RESULT.test(sentence) && !NOT_TESTED.test(sentence)) add('device_not_tested', sentence);
  }
  return found;
}
export function describeViolations(violations) {
  return violations.map(v => `${v.rule}${v.excerpt ? ` (${JSON.stringify(v.excerpt)})` : ''}: ${RULE_TEXT[v.rule] || v.rule}`).join(' ');
}
export function placeholdersIn(text) {
  return new Set([...String(text).matchAll(PLACEHOLDER)].map(m => m[1]).filter(name => PLACEHOLDERS.includes(name)));
}
export function fillPlaceholders(text, values) {
  return String(text).replace(PLACEHOLDER, (whole, name) => {
    if (!PLACEHOLDERS.includes(name)) return whole;
    if (typeof values[name] !== 'string' || !values[name]) throw Error(`No host value for {{${name}}}`);
    return values[name];
  });
}

// ---------------------------------------------------------------------------
// Structured replies (A3). The writer supplies claims; the host renders them.
//
// {
//   "ticket_id": "<uuid>",                      exactly the --ticket given
//   "opening": "update" | "answer" | "checked",
//   "context": "optional short paragraph",      <= 600 chars, fixed rules apply
//   "claims": [{ "id": "AC-1" (optional), "text": "<= 160 chars",
//                "evidence": { "test": "<file>::<test name>" }
//                          | { "query": "<recorded query id>", "expect": {...} }
//                          | { "file": "src/x.js", "line": 12, "text": "cited text" } }],
//   "not_done": ["<= 160 chars", ...],          optional, always rendered as not done
//   "closing": "reply_here" | "follow_up" | "none"
// }
// ---------------------------------------------------------------------------
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const QUERY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TEST_ID = /^([^:\s][^:]*?\.test\.m?js)::(.{1,300})$/;
const REPLY_KEYS = new Set(['ticket_id', 'opening', 'context', 'claims', 'not_done', 'closing']);
const CLAIM_KEYS = new Set(['id', 'text', 'evidence']);

export function safeRepoPath(p) {
  return typeof p === 'string' && p.length <= 300 && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') &&
    !p.split('/').some(s => !s || s === '.' || s === '..') && !/^\.(?:git|spec|env)(?:\/|$)/.test(p);
}
function parseEvidence(evidence, problems, where) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) { problems.push(`${where}: evidence must be an object`); return null; }
  const kinds = ['test', 'query', 'file'].filter(k => k in evidence);
  if (kinds.length !== 1) { problems.push(`${where}: evidence needs exactly one of test, query or file`); return null; }
  const [kind] = kinds;
  if (kind === 'test') {
    if (Object.keys(evidence).length !== 1 || typeof evidence.test !== 'string' || !TEST_ID.test(evidence.test) || !safeRepoPath(TEST_ID.exec(evidence.test)[1])) {
      problems.push(`${where}: test evidence is "<test file>::<test name>"`); return null;
    }
    return { kind, ref: evidence.test };
  }
  if (kind === 'query') {
    const extra = Object.keys(evidence).filter(k => k !== 'query' && k !== 'expect');
    if (extra.length || typeof evidence.query !== 'string' || !QUERY_ID.test(evidence.query)) { problems.push(`${where}: query evidence is {"query": "<recorded id>", "expect"?: {...}}`); return null; }
    const expect = evidence.expect;
    if (expect !== undefined) {
      const ok = expect && typeof expect === 'object' && !Array.isArray(expect) &&
        Object.keys(expect).every(k => ['rows', 'rows_min', 'control'].includes(k)) &&
        (expect.rows === undefined || (Number.isInteger(expect.rows) && expect.rows >= 0)) &&
        (expect.rows_min === undefined || (Number.isInteger(expect.rows_min) && expect.rows_min >= 1)) &&
        (expect.control === undefined || (typeof expect.control === 'string' && QUERY_ID.test(expect.control)));
      if (!ok) { problems.push(`${where}: query evidence "expect" allows rows, rows_min and control only`); return null; }
    }
    return { kind, ref: evidence.query, expect: expect ?? null };
  }
  const extra = Object.keys(evidence).filter(k => !['file', 'line', 'text'].includes(k));
  if (extra.length || !safeRepoPath(evidence.file) || !Number.isInteger(evidence.line) || evidence.line < 1 ||
      typeof evidence.text !== 'string' || evidence.text.trim().length < 8 || evidence.text.length > 300) {
    problems.push(`${where}: file evidence is {"file": "<repo path>", "line": <n>, "text": "<at least 8 characters on that line>"}`); return null;
  }
  return { kind, ref: `${evidence.file}:${evidence.line}`, file: evidence.file, line: evidence.line, text: evidence.text.trim() };
}

// Throws with every problem at once, so a writer fixes the file in one pass.
export function parseStructuredReply(raw, ticketId) {
  const problems = [];
  if (!UUID.test(ticketId || '')) throw Error('A single ticket UUID is required');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('One reply object for one ticket is required; batches are refused');
  for (const key of Object.keys(raw)) if (!REPLY_KEYS.has(key)) problems.push(`unknown field "${key}"`);
  if (raw.ticket_id !== undefined && raw.ticket_id !== ticketId) problems.push('ticket_id does not match --ticket; one ticket per call');
  if (!Object.hasOwn(OPENINGS, raw.opening)) problems.push(`opening must be one of ${Object.keys(OPENINGS).join(', ')}`);
  if (!Object.hasOwn(CLOSINGS, raw.closing)) problems.push(`closing must be one of ${Object.keys(CLOSINGS).join(', ')}`);
  if (raw.context !== undefined && (typeof raw.context !== 'string' || raw.context.length > CONTEXT_MAX)) problems.push(`context must be text of at most ${CONTEXT_MAX} characters`);
  const claims = raw.claims ?? [];
  if (!Array.isArray(claims) || claims.length > MAX_CLAIMS) problems.push(`claims must be a list of at most ${MAX_CLAIMS}`);
  const notDone = raw.not_done ?? [];
  if (!Array.isArray(notDone) || notDone.length > MAX_NOT_DONE) problems.push(`not_done must be a list of at most ${MAX_NOT_DONE}`);
  const parsed = [];
  (Array.isArray(claims) ? claims : []).forEach((claim, i) => {
    const where = `claims[${i}]`;
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) { problems.push(`${where} must be an object`); return; }
    for (const key of Object.keys(claim)) if (!CLAIM_KEYS.has(key)) problems.push(`${where}: unknown field "${key}"`);
    if (claim.id !== undefined && (typeof claim.id !== 'string' || !/^[A-Za-z0-9-]{1,20}$/.test(claim.id))) problems.push(`${where}: id is a short label such as AC-1`);
    if (typeof claim.text !== 'string' || !claim.text.trim() || claim.text.length > CLAIM_TEXT_MAX || /\n/.test(claim.text)) problems.push(`${where}: text is one line of at most ${CLAIM_TEXT_MAX} characters`);
    const evidence = parseEvidence(claim.evidence, problems, where);
    parsed.push({ id: claim.id ?? null, text: String(claim.text ?? '').trim(), evidence });
  });
  (Array.isArray(notDone) ? notDone : []).forEach((item, i) => {
    if (typeof item !== 'string' || !item.trim() || item.length > CLAIM_TEXT_MAX || /\n/.test(item)) problems.push(`not_done[${i}] is one line of at most ${CLAIM_TEXT_MAX} characters`);
  });
  if (problems.length) throw Object.assign(Error(`Reply file refused: ${problems.join('; ')}`), { problems });
  return { ticket_id: ticketId, opening: raw.opening, closing: raw.closing, context: (raw.context ?? '').trim(),
    claims: parsed, not_done: notDone.map(s => s.trim()) };
}

// Writer text only: the fixed rules including the hex ban. Every field the
// writer controls is checked on its own so a violation names where it is.
export function writerViolations(reply) {
  const fields = [['context', reply.context], ...reply.claims.map((c, i) => [`claims[${i}]`, c.text]), ...reply.not_done.map((t, i) => [`not_done[${i}]`, t])];
  return fields.flatMap(([field, text]) => checkFixedRules(text).map(v => ({ ...v, field })));
}

// sources: { head, fileAtHead(path) -> string|null, gates -> object|null,
//            query(id) -> record|null, now -> ms }
export function verifyEvidence(evidence, sources) {
  if (!evidence) return { verified: false, reason: 'no usable evidence' };
  if (evidence.kind === 'test') {
    const [, file] = TEST_ID.exec(evidence.ref);
    const gates = sources.gates;
    if (!gates) return { verified: false, reason: 'no gates file was supplied' };
    if (gates.head !== sources.head) return { verified: false, reason: 'the gates file was produced at a different HEAD' };
    if (gates.dirty !== false) return { verified: false, reason: 'the gates file ran on uncommitted changes' };
    if (sources.fileAtHead(file) === null) return { verified: false, reason: `${file} is not committed at HEAD` };
    const entry = (gates.tests || []).find(t => t.id === evidence.ref);
    if (!entry) return { verified: false, reason: 'the test did not run in the gates file' };
    if (entry.status !== 'pass') return { verified: false, reason: `the test ${entry.status === 'fail' ? 'failed' : `was ${entry.status}`}` };
    return { verified: true, reason: `passed at ${gates.head.slice(0, 12)}` };
  }
  if (evidence.kind === 'query') {
    const record = sources.query(evidence.ref);
    if (!record) return { verified: false, reason: 'no recorded result for this query id' };
    const expect = evidence.expect || {};
    if (expect.rows !== undefined) {
      if (record.row_count !== expect.rows) return { verified: false, reason: `recorded ${record.row_count} rows, expected ${expect.rows}` };
    } else if (record.row_count < (expect.rows_min ?? 1)) {
      return { verified: false, reason: `recorded ${record.row_count} rows; a claim needs rows unless it expects none` };
    }
    // A claim that something is absent needs a positive control from the
    // same access path (5bef10ac: an RLS-blind read returned zero rows).
    if (expect.rows === 0) {
      const control = expect.control && sources.query(expect.control);
      if (!control) return { verified: false, reason: 'an absence claim needs a recorded positive control query' };
      if (control.row_count < 1) return { verified: false, reason: 'the positive control returned no rows' };
      if (Math.abs(Date.parse(control.ran_at) - Date.parse(record.ran_at)) > 15 * 60 * 1000) return { verified: false, reason: 'the positive control ran more than 15 minutes apart' };
    }
    return { verified: true, reason: `${record.row_count} rows recorded at ${record.ran_at}` };
  }
  const content = sources.fileAtHead(evidence.file);
  if (content === null) return { verified: false, reason: `${evidence.file} is not committed at HEAD` };
  const lines = content.split('\n');
  const from = Math.max(0, evidence.line - 3), to = Math.min(lines.length, evidence.line + 2);
  if (evidence.line > lines.length) return { verified: false, reason: `${evidence.file} has only ${lines.length} lines` };
  if (!lines.slice(from, to).some(line => line.includes(evidence.text))) return { verified: false, reason: `the cited text is not within 2 lines of ${evidence.ref} at HEAD` };
  return { verified: true, reason: `found at ${evidence.ref}` };
}

export function renderStructured({ opening, context, confirmed, pending, closing }) {
  const parts = [OPENINGS[opening]];
  if (context) parts.push(context);
  if (confirmed.length) parts.push([HEADINGS.confirmed, ...confirmed.map(t => `- ${t}`)].join('\n'));
  if (pending.length) parts.push([HEADINGS.pending, ...pending.map(t => `- ${t}`)].join('\n'));
  if (CLOSINGS[closing]) parts.push(CLOSINGS[closing]);
  return parts.join('\n\n');
}
