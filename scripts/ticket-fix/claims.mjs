// Fixed reply rules (design G5 phase 0) and structured, evidence-bound claims
// (critique amendment A3) for every CredentialDOMD support reply.
//
// Pure: no network, no database, no git. The evidence sources (git at HEAD and
// at the live build, a host-run gates result, a host-run query) are passed in,
// so the same checks run in unit tests, in the hourly agent and in
// post-reply.mjs.
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
export const MAX_CLAIMS = 20;
export const MAX_NOT_DONE = 20;

// Opening, context and closing lines are fixed. The writer picks a key; it
// cannot add free prose there (A3: free prose only from fixed templates).
// Customer-facing: no em dashes, no names.
export const OPENINGS = Object.freeze({
  update: 'Here is where your request stands.',
  answer: 'Here is the answer to your question.',
  checked: 'Thanks for the report. Here is what we checked.',
});
export const CONTEXTS = Object.freeze({
  none: '',
  // Both ids are filled and checked by the host: the commit must be live and
  // touch a file a confirmed claim cites.
  release: 'The change is in {{FIX_COMMIT}}, live in build {{BUILD}}.',
});
export const CLOSINGS = Object.freeze({
  reply_here: 'If anything still looks wrong, reply on this thread and we will pick it up here.',
  follow_up: 'We will post on this thread when the remaining work is done.',
  none: '',
});
export const HEADINGS = Object.freeze({ confirmed: 'What we confirmed:', pending: 'Not done yet:' });

export class ReplyRuleError extends Error {
  constructor(violations) {
    super(`Reply breaks fixed reply rules: ${describeViolations(violations)}`);
    this.violations = violations;
  }
}

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
  device_not_tested: 'A sentence that names a phone, tablet, browser, or a mail or messaging app must say it was not tested there, unless it is a question or a plain instruction.',
  unverified_claim: 'The automated reply may not say that something changed, works, shows or is live: nothing checks that sentence. Say what was recorded, what happens next, or ask; a result goes out only as a claim with evidence (post-reply.mjs).',
  unknown_placeholder: 'Only {{FIX_COMMIT}} and {{BUILD}} are filled in by the host.',
  control_character: 'Remove control characters.',
  invisible_character: 'Remove invisible formatting characters (zero-width spaces and joiners, soft hyphens, direction marks).',
  too_long: `The reply is longer than ${BODY_MAX} characters.`,
  follow_up_without_pending: 'The "follow_up" closing promises more work; use it only when something is listed as not done yet.',
  fix_commit_unavailable: 'The host could not supply {{FIX_COMMIT}}: it needs exactly one single-parent commit, made by this run (or named with --fix), that is live and touches a file the reply cites.',
  build_unavailable: 'The host could not read the live build from version.json for {{BUILD}}.',
});

// Text is folded before the patterns run, so a zero-width character, a
// fullwidth digit or a Cyrillic look-alike cannot carry a commit id or a name
// past them. The unfolded text is still refused for carrying such characters.
const CONFUSABLES = Object.freeze({
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j',
  '\u0501': 'd', '\u0455': 's', '\u04bb': 'h', '\u051d': 'w', '\u04cf': 'l', '\u0261': 'g', '\u0432': 'b', '\u043a': 'k', '\u043c': 'm', '\u043d': 'h', '\u0442': 't',
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041a': 'K', '\u041c': 'M', '\u041d': 'H', '\u041e': 'O', '\u0420': 'P', '\u0421': 'C',
  '\u0422': 'T', '\u0425': 'X', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J', '\u051c': 'W',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039a': 'K', '\u039c': 'M', '\u039d': 'N',
  '\u039f': 'O', '\u03a1': 'P', '\u03a4': 'T', '\u03a5': 'Y', '\u03a7': 'X', '\u03bf': 'o', '\u03c1': 'p', '\u03f2': 'c', '\u03b9': 'i', '\u03bd': 'v',
});
const FORMAT = /\p{Cf}/u;
export function foldForRules(text) {
  return String(text).normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[^\x00-\x7f]/g, ch => CONFUSABLES[ch] ?? ch);
}

// A token of 7 to 40 hex characters standing alone. Digits-only tokens are
// usually numbers (amounts, dates, counts); they are refused only when the
// host says they name a commit (isCommit) or the live build.
const HEX = /(?<![0-9A-Za-z])[0-9a-fA-F]{7,40}(?![0-9A-Za-z])/g;
const DIGITS = /(?<![0-9A-Za-z])[0-9]{7,40}(?![0-9A-Za-z])/g;
// The build id format version.json carries: 20260928T1648-4081226.
const BUILD_ID = /(?<![0-9A-Za-z])\d{8}T\d{4}-[0-9a-f]{4,40}(?![0-9A-Za-z])/i;
const OWNER_NAME = /\b(?:eric|whit|whitney)\b/i;
const HIPAA = /\bhipaa\b/i;
const COMPLIANT = /\bcompliant\b/i;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
// Everything C0 except tab and newline, plus DEL.
const hasControl = value => [...value].some(ch => { const c = ch.charCodeAt(0); return (c < 32 && c !== 9 && c !== 10) || c === 127; });
// Any phone, tablet, browser, or mail or messaging client (the formatting loop
// was about Mail and Gmail; scrolling and the menu bar about Safari; contacts
// about the iPhone). A phone number is not a device.
export const DEVICE = /\b(?:iphones?|ipads?|ipados|ios|android|safari|chrome|tablets?|mobile(?!\s+(?:numbers?|phones?\s+numbers?))|devices?|mail|gmail|outlook|share sheet|messages app|imessage|sms|text messages?)\b|\bphones?\b(?!\s*(?:numbers?|#|fields?|extensions?))/i;
// A reported result. Only used to decide whether an instruction ("Open
// Settings on your phone") also reports one ("Try it now: it works on your iPhone").
const RESULT = /\b(?:works|worked|working|fixed|shows|showing|shown|displays|displayed|appears|opens|opened|loads|loaded|renders|rendered|looks|scrolls|scrolled|sends|sent|saves|saved|keeps|kept|stays|stayed|now|no longer|will|should|resolved|behaves|smooth|comes? in)\b/i;
const IMPERATIVE = /^(?:please\s+)?(?:open|tap|try|go to|select|click|choose|swipe|check|restart|reload|sign in|log in|update)\b/i;
const NOT_TESTED = /\b(?:not (?:been |yet )?(?:tested|checked|tried|verified)|untested|(?:could|can)(?:n't| ?not) (?:test|check|try)|(?:have|has)(?:n't| not) (?:been )?(?:tested|checked|tried)|(?:was|were)(?:n't| not) (?:tested|checked|tried))\b/i;
// Free text that reports a result or a finished change. The automated reply
// has no evidence behind its prose, so such a sentence is refused there
// (failure mode 1: replies that described intent, not code). Paraphrases the
// critique listed ("displays", "lists", "includes", "you'll see") are in.
const UNVERIFIED = /\b(?:now|no longer|fixed|fixes|shipped|deployed|released|live|resolved|works|worked|shows|shown|displays|displayed|lists|listed|includes|included|saved|saves|appears|appeared|you(?:'ll| will) see|added|removed|deleted|restored|corrected|updated|changed)\b/i;

export function hexTokens(text) {
  return [...String(text).matchAll(HEX)].map(m => m[0]).filter(token => !/^[0-9]+$/.test(token));
}
export function sentences(text) {
  return String(text).split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}
const excerpt = value => (value.length > 80 ? `${value.slice(0, 77)}...` : value);
export function namesDevice(text) { return DEVICE.test(foldForRules(text)); }

// Every rule a customer-facing text must pass. Returns [{rule, excerpt}], empty
// when the text passes.
//   hex: false       text the host already filled in
//   claims: true     free prose with no evidence behind it (the agent's reply)
//   isCommit(token)  host lookup: does a digits-only token name a commit here
//   liveShort        the live build's short id
//   max              the length limit (the agent's host-rendered reply, with
//                    one footer line per checklist item, may be longer)
export function checkFixedRules(text, { hex = true, claims = false, isCommit = null, liveShort = null, max = BODY_MAX } = {}) {
  const raw = String(text ?? '');
  const value = foldForRules(raw);
  const found = [];
  const add = (rule, detail = '') => found.push({ rule, excerpt: excerpt(detail) });
  if (raw.length > max) add('too_long', String(raw.length));
  if (hasControl(raw)) add('control_character');
  if (FORMAT.test(raw)) add('invisible_character');
  if (hex) {
    const ids = new Set(hexTokens(value));
    const build = BUILD_ID.exec(value);
    if (build && !ids.has(build[0].split('-')[1])) ids.add(build[0]);
    for (const token of new Set([...value.matchAll(DIGITS)].map(m => m[0]))) {
      if (build?.[0].endsWith(`-${token}`)) continue;
      if ((liveShort && (token.startsWith(liveShort) || liveShort.startsWith(token))) || (isCommit && isCommit(token))) ids.add(token);
    }
    for (const token of ids) add('commit_or_build_id', token);
  }
  if (raw.includes('\u2014')) add('em_dash');
  if (HIPAA.test(value)) add('hipaa', HIPAA.exec(value)[0]);
  if (COMPLIANT.test(value)) add('compliant', COMPLIANT.exec(value)[0]);
  if (OWNER_NAME.test(value)) add('owner_name', OWNER_NAME.exec(value)[0]);
  for (const [, name] of value.matchAll(PLACEHOLDER)) if (!PLACEHOLDERS.includes(name)) add('unknown_placeholder', `{{${name}}}`);
  for (const sentence of sentences(value)) {
    if (sentence.endsWith('?')) continue; // a question asks for a result; it does not report one
    const instruction = IMPERATIVE.test(sentence) && !RESULT.test(sentence);
    if (DEVICE.test(sentence) && !NOT_TESTED.test(sentence) && !instruction) add('device_not_tested', sentence);
    if (claims && UNVERIFIED.test(sentence)) add('unverified_claim', sentence);
  }
  return found;
}
// A question the host renders to the customer may not state a result either:
// "With the lines now separated on every invoice, does it look right?" skips
// the claim rule above only because it ends in "?" (stage 3 review).
export function questionReportsResult(text) {
  return sentences(foldForRules(text)).some(sentence => UNVERIFIED.test(sentence));
}
// What a unit test can never confirm on the agent path: a statement about the
// customer's own stored records (one reply told a customer their records were
// saved, in a table that did not exist) or that something is absent. Only a
// query the host runs could, and the worker has no database. Returns why, or
// null.
const CUSTOMER_DATA = /\byour (?:\w+ ){0,2}(?:account|records?|entries|entry|data|history|profile|uploads?|documents?|files?|credentials?|licen[cs]es?|invoices?|contracts?|shifts?|hours|cases?|logs?|notes?|settings)\b|\b(?:still|all|already|safely) (?:saved|stored|kept|there)\b|\b(?:saved|stored|kept) (?:in|on) (?:your|the) (?:account|database|server|cloud)\b/i;
export function testCannotConfirm(text) {
  const value = unquoted(foldForRules(text));
  if (CUSTOMER_DATA.test(value)) return 'a test cannot confirm what is stored in the customer\'s account';
  if (ABSENCE.test(value)) return 'a test cannot confirm that something is absent; state what the code does';
  return null;
}
export function describeViolations(violations) {
  return violations.map(v => `${v.rule}${v.excerpt ? ` (${JSON.stringify(v.excerpt)})` : ''}: ${RULE_TEXT[v.rule] || v.rule}`).join(' ');
}
// For logs: the rule names only, never the excerpt (which quotes reply text).
export const ruleNames = violations => [...new Set(violations.map(v => v.rule))].join(', ');
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
//   "ticket_version": "<updated_at as read>",   the reply is withheld if the ticket changed since
//   "opening": "update" | "answer" | "checked",
//   "context": "none" | "release",              optional fixed line (default none)
//   "claims": [{ "id": "AC-1" (optional), "text": "<= 160 chars",
//                "evidence": { "test": "<file>::<test name>" }
//                          | { "query": "<recorded id>", "expect": { "rows" | "rows_min", "values"?, "control"? } }
//                          | { "file": "src/x.js", "line": 12, "text": "cited text" } }],
//   "not_done": ["<= 160 chars", ...],          optional, always rendered as not done
//   "closing": "reply_here" | "follow_up" | "none"
// }
// ---------------------------------------------------------------------------
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const QUERY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COLUMN = /^[a-z_][a-z0-9_]{0,62}$/;
const TEST_ID = /^([^:\s][^:]*?\.test\.m?js)::(.{1,300})$/;
const REPLY_KEYS = new Set(['ticket_id', 'ticket_version', 'opening', 'context', 'claims', 'not_done', 'closing']);
const CLAIM_KEYS = new Set(['id', 'text', 'evidence']);
// Only product source can confirm a UI-text claim.
const FILE_ROOTS = ['src/', 'supabase/functions/', 'public/', 'landing/'];

export function safeRepoPath(p) {
  return typeof p === 'string' && p.length <= 300 && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') &&
    !p.split('/').some(s => !s || s === '.' || s === '..') && !/^\.(?:git|spec|env)(?:\/|$)/.test(p);
}
// A timestamptz as the database or JSON prints it ("2026-09-28 12:00:00.123456+00"
// or "2026-09-28T12:00:00.123456+00:00"). The database compares the value itself.
export function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value) &&
    Number.isFinite(Date.parse(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00').replace(/(\.\d{3})\d+/, '$1')));
}
const scalar = v => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200);
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
    if (extra.length || typeof evidence.query !== 'string' || !QUERY_ID.test(evidence.query)) { problems.push(`${where}: query evidence is {"query": "<recorded id>", "expect": {...}}`); return null; }
    // What the rows must show is stated up front, never inferred from "some
    // rows came back" (a36aeef3 and 5bef10ac replays: a count(*) always
    // returns one row, and a row that disproves the claim still "confirmed" it).
    const expect = evidence.expect;
    const ok = expect && typeof expect === 'object' && !Array.isArray(expect) &&
      Object.keys(expect).every(k => ['rows', 'rows_min', 'values', 'control'].includes(k)) &&
      ((expect.rows !== undefined) !== (expect.rows_min !== undefined)) &&
      (expect.rows === undefined || (Number.isInteger(expect.rows) && expect.rows >= 0 && expect.rows <= 200)) &&
      (expect.rows_min === undefined || (Number.isInteger(expect.rows_min) && expect.rows_min >= 1)) &&
      (expect.values === undefined || (expect.values && typeof expect.values === 'object' && !Array.isArray(expect.values) &&
        Object.keys(expect.values).length >= 1 && Object.keys(expect.values).length <= 10 &&
        Object.entries(expect.values).every(([k, v]) => COLUMN.test(k) && scalar(v)))) &&
      (expect.control === undefined || (typeof expect.control === 'string' && QUERY_ID.test(expect.control) && expect.control !== evidence.query));
    if (!ok) { problems.push(`${where}: query evidence needs "expect" with exactly one of rows or rows_min, and optionally values {column: value} and a control query id`); return null; }
    return { kind, ref: evidence.query, expect };
  }
  const extra = Object.keys(evidence).filter(k => !['file', 'line', 'text'].includes(k));
  if (extra.length || !safeRepoPath(evidence.file) || !Number.isInteger(evidence.line) || evidence.line < 1 ||
      typeof evidence.text !== 'string' || evidence.text.trim().length < 8 || evidence.text.length > 300) {
    problems.push(`${where}: file evidence is {"file": "<repo path>", "line": <n>, "text": "<at least 8 characters on that line>"}`); return null;
  }
  return { kind, ref: `${evidence.file}:${evidence.line}`, file: evidence.file, line: evidence.line, text: evidence.text.trim() };
}

// The agent's claims (stage 3): the same test and file evidence, never a
// query (the worker has no database). Returns { evidence, problems }.
export function parseClaimEvidence(evidence, where = 'evidence') {
  const problems = [];
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence) && 'query' in evidence) return { evidence: null, problems: [`${where}: the agent has no database; use test or file evidence`] };
  // The worker's schema has no nulls; drop empty optional fields it filled.
  const given = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? Object.fromEntries(Object.entries(evidence).filter(([, v]) => v !== '' && v !== null && v !== undefined)) : evidence;
  const parsed = parseEvidence(given, problems, where);
  return { evidence: parsed, problems };
}

// Throws with every problem at once, so a writer fixes the file in one pass.
export function parseStructuredReply(raw, ticketId) {
  const problems = [];
  if (!UUID.test(ticketId || '')) throw Error('A single ticket UUID is required');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('One reply object for one ticket is required; batches are refused');
  for (const key of Object.keys(raw)) if (!REPLY_KEYS.has(key)) problems.push(`unknown field "${key}"`);
  if (raw.ticket_id !== undefined && raw.ticket_id !== ticketId) problems.push('ticket_id does not match --ticket; one ticket per call');
  // 5ed50a64: a reply asked something the customer had answered 20 minutes
  // earlier. The writer states the version it read; a newer one withholds it.
  if (!isTimestamp(raw.ticket_version)) problems.push('ticket_version is required: the ticket\'s updated_at exactly as you read it');
  if (!Object.hasOwn(OPENINGS, raw.opening)) problems.push(`opening must be one of ${Object.keys(OPENINGS).join(', ')}`);
  if (!Object.hasOwn(CLOSINGS, raw.closing)) problems.push(`closing must be one of ${Object.keys(CLOSINGS).join(', ')}`);
  if (raw.context !== undefined && !Object.hasOwn(CONTEXTS, raw.context)) problems.push(`context must be one of ${Object.keys(CONTEXTS).join(', ')}; free prose goes in claims with evidence, or in not_done`);
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
  return { ticket_id: ticketId, ticket_version: raw.ticket_version, opening: raw.opening, closing: raw.closing, context: raw.context ?? 'none',
    claims: parsed, not_done: notDone.map(s => s.trim()) };
}

// Writer text only: the fixed rules including the hex ban. Every field the
// writer controls is checked on its own so a violation names where it is.
export function writerViolations(reply, options = {}) {
  const fields = [...reply.claims.map((c, i) => [`claims[${i}]`, c.text]), ...reply.not_done.map((t, i) => [`not_done[${i}]`, t])];
  return fields.flatMap(([field, text]) => checkFixedRules(text, options).map(v => ({ ...v, field })));
}

// ---------------------------------------------------------------------------
// Checking one claim against its evidence.
// ---------------------------------------------------------------------------
const QUOTED = /\u201c([^\u201d]{2,160})\u201d|"([^"]{2,160})"|\u2018([^\u2019]{2,160})\u2019|(?:^|[\s(])'([^']{2,160})'(?=$|[\s.,;:!?)])/g;
export const quotedStrings = text => [...String(text).matchAll(QUOTED)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]);
const unquoted = text => String(text).replace(QUOTED, ' ');
// Something is gone, or true everywhere: a line of source cannot show either
// (821d2f76: "no longer repeats" while a test asserted it still did).
const GONE_OR_EVERY = /\b(?:no longer|removed|deleted|gone|instead of|every|all|always|never|nothing|none|no|any ?more|everywhere)\b/i;
// A claim that something is absent: it needs expected emptiness (or values)
// and a positive control on the same table (5bef10ac: zero rows through RLS).
const ABSENCE = /\b(?:no|none|never|not|nothing|zero|no longer|any ?more|isn't|wasn't|aren't|weren't|doesn't|didn't|hasn't|haven't|removed|deleted|gone)\b|(?<![\w.])0(?![\w.])/i;
const AGGREGATE = /\b(?:count|sum|avg|min|max|bool_and|bool_or|every|exists|array_agg|json_agg|jsonb_agg|string_agg)\s*\(/i;
export function relationsIn(sql) {
  const text = String(sql).toLowerCase().replace(/'(?:[^']|'')*'/g, "''");
  return new Set([...text.matchAll(/\b(?:from|join)\s+((?:"?[a-z_][a-z0-9_$]*"?\s*\.\s*)?"?[a-z_][a-z0-9_$]*"?)(?![a-z0-9_$"(.])(?!\s*\()/g)]
    .map(m => m[1].replace(/["\s]/g, '').replace(/^public\./, '')));
}
const scalars = rows => rows.flatMap(row => (row && typeof row === 'object' ? Object.values(row) : [row]))
  .flatMap(v => (v !== null && typeof v === 'object' ? Object.values(v) : [v])).map(v => String(v));
const sameValue = (actual, expected) => {
  if (expected === null) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;
  if (typeof expected === 'number' || (typeof expected === 'string' && /^-?\d+(?:\.\d+)?$/.test(expected))) {
    return String(actual).trim() !== '' && Number(actual) === Number(expected);
  }
  if (typeof expected === 'boolean') return actual === expected || String(actual) === String(expected) || (expected ? actual === 't' : actual === 'f');
  return String(actual) === expected;
};

function verifyQuery(claim, evidence, sources) {
  const record = sources.query(evidence.ref);
  if (!record) return { verified: false, reason: 'no recorded result for this query id' };
  const expect = evidence.expect;
  const relations = relationsIn(record.sql);
  if (!relations.size) return { verified: false, reason: 'the query reads no table' };
  const scope = (sources.scope || []).filter(Boolean).map(s => s.toLowerCase());
  if (!scope.some(id => String(record.sql).toLowerCase().includes(id))) return { verified: false, reason: 'the query is not scoped to this ticket or its owner (name the ticket or owner id in it)' };
  const rows = Array.isArray(record.rows) ? record.rows : [];
  const absence = ABSENCE.test(unquoted(claim.text)) || expect.rows === 0;
  if (absence && expect.rows !== 0 && !expect.values) return { verified: false, reason: 'a claim that something is absent needs expect.rows 0 or expect.values' };
  if (expect.rows !== undefined && rows.length !== expect.rows) return { verified: false, reason: `returned ${rows.length} rows, expected ${expect.rows}` };
  if (expect.rows_min !== undefined && rows.length < expect.rows_min) return { verified: false, reason: `returned ${rows.length} rows, expected at least ${expect.rows_min}` };
  if (rows.length === 1 && AGGREGATE.test(record.sql) && !expect.values) return { verified: false, reason: 'one aggregate row says nothing by itself; state expect.values' };
  if (expect.values) {
    if (!rows.length) return { verified: false, reason: 'expect.values needs rows to compare' };
    for (const [column, value] of Object.entries(expect.values)) {
      if (!rows.every(row => row && sameValue(row[column], value))) return { verified: false, reason: `the rows do not all have ${column} = ${JSON.stringify(value)}` };
    }
  }
  const values = [...scalars(rows), String(rows.length)];
  for (const number of unquoted(claim.text).match(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g) || []) {
    if (!values.some(v => new RegExp(`(?<![\\d.])${number.replace('.', '\\.')}(?![\\d.])`).test(v))) return { verified: false, reason: `the claim says ${number}, which is neither the row count nor in the returned rows` };
  }
  if (absence) {
    const control = expect.control && sources.query(expect.control);
    if (!control) return { verified: false, reason: 'an absence claim needs a recorded positive control query' };
    if (!(control.row_count >= 1)) return { verified: false, reason: 'the positive control returned no rows' };
    if (![...relationsIn(control.sql)].some(r => relations.has(r))) return { verified: false, reason: 'the positive control does not read the same table' };
    if (Math.abs(Date.parse(control.ran_at) - Date.parse(record.ran_at)) > 15 * 60 * 1000) return { verified: false, reason: 'the positive control ran more than 15 minutes apart' };
  }
  return { verified: true, reason: `${rows.length} rows ${record.reexecuted ? 'returned when posting' : 'recorded'} at ${record.ran_at}` };
}

// sources: { head, live: {commit, contains_head, error}, fileAtHead(path),
//            fileAtLive(path), gates, query(id) -> record|null, scope: [ids] }
export function verifyClaim(claim, sources) {
  const evidence = claim.evidence;
  if (!evidence) return { verified: false, reason: 'no usable evidence' };
  // Nothing here runs on a phone, a tablet or in a mail client (c0aa1d32).
  if (namesDevice(claim.text)) return { verified: false, reason: 'a result on a device is never confirmed here: not tested on that device' };
  if (evidence.kind === 'query') return verifyQuery(claim, evidence, sources);
  const live = sources.live || {};
  if (evidence.kind === 'test') {
    const [, file] = TEST_ID.exec(evidence.ref);
    const gates = sources.gates;
    if (!gates) return { verified: false, reason: 'no host test run was supplied' };
    if (gates.head !== sources.head) return { verified: false, reason: 'the test run was at a different HEAD' };
    if (gates.dirty !== false) return { verified: false, reason: 'the test run had uncommitted or untracked changes' };
    if (sources.fileAtHead(file) === null) return { verified: false, reason: `${file} is not committed at HEAD` };
    const entry = (gates.tests || []).find(t => t.id === evidence.ref);
    if (!entry) return { verified: false, reason: 'the test did not run' };
    if (entry.status !== 'pass') return { verified: false, reason: `the test ${entry.status === 'fail' ? 'failed' : `was ${entry.status}`}` };
    if (!live.commit) return { verified: false, reason: `not live yet: ${live.error || 'the live build is not in this repository'}` };
    if (!live.contains_head) return { verified: false, reason: 'not live yet: the live build does not contain the tested commit' };
    return { verified: true, reason: `passed at ${gates.head.slice(0, 12)}, which the live build contains` };
  }
  if (!FILE_ROOTS.some(root => evidence.file.startsWith(root))) return { verified: false, reason: `file evidence must be product source under ${FILE_ROOTS.join(', ')}` };
  const quotes = quotedStrings(claim.text);
  if (GONE_OR_EVERY.test(unquoted(claim.text))) return { verified: false, reason: 'a claim that something is gone, or true everywhere, needs a test as evidence' };
  // Until the G5 claim verifier exists, a line of source confirms one thing
  // only: that quoted text is there, in the live build (5f9b744d).
  if (!quotes.length) return { verified: false, reason: 'file evidence confirms quoted text only; this claim needs a test or a query' };
  if (!live.commit) return { verified: false, reason: `not live yet: ${live.error || 'the live build is not in this repository'}` };
  const content = sources.fileAtLive(evidence.file);
  if (content === null) return { verified: false, reason: `not live yet: ${evidence.file} is not in the live build` };
  const lines = content.split('\n');
  if (evidence.line > lines.length) return { verified: false, reason: `${evidence.file} has only ${lines.length} lines in the live build` };
  const window = lines.slice(Math.max(0, evidence.line - 3), Math.min(lines.length, evidence.line + 2)).join('\n');
  if (!window.includes(evidence.text)) return { verified: false, reason: `the cited text is not within 2 lines of ${evidence.ref} in the live build` };
  const missing = quotes.find(q => !window.includes(q));
  if (missing !== undefined) return { verified: false, reason: 'quoted text in the claim is not at the cited lines' };
  return { verified: true, reason: `quoted text found at ${evidence.ref} in the live build` };
}

export function renderStructured({ opening, context, confirmed, pending, closing }) {
  const parts = [OPENINGS[opening]];
  if (context && CONTEXTS[context]) parts.push(CONTEXTS[context]);
  if (confirmed.length) parts.push([HEADINGS.confirmed, ...confirmed.map(t => `- ${t}`)].join('\n'));
  if (pending.length) parts.push([HEADINGS.pending, ...pending.map(t => `- ${t}`)].join('\n'));
  if (CLOSINGS[closing]) parts.push(CLOSINGS[closing]);
  return parts.join('\n\n');
}
