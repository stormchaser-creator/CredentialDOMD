// The one verified reply path for every CredentialDOMD support reply: the
// hourly agent (scripts/ticket-agent-context.mjs --record-and-reply), and
// interactive Claude or Codex sessions (post-reply.mjs). Critique amendment A1.
//
// A reply is written as a support_reply_verifications row plus the
// support_messages row that points at it, in one statement. The row carries
// sha256(stored body) and an HMAC-SHA256 over "<id>:<ticket_id>:<body_sha256>"
// keyed with the vault secret support_reply_hmac_key, read through the
// management API at run time and held only in memory. The database trigger
// (20260928150000, tightened by 20260928160000) refuses a support reply that
// has no matching, unused verification, unless the admin wrote it in the app.
//
// What the signature is, and is not. The vault key is readable by the same
// database role the management API runs as (postgres), so a session holding
// that token can read the key and sign anything; so can anything running as
// the owner's macOS user. The HMAC is therefore NOT a boundary against an
// operator who sets out to forge a reply. It stops the accidental path (a
// session that inserts a reply with SQL is refused, and told to use
// post-reply.mjs), and scripts/ticket-fix/reconcile.mjs reports any
// verification that no checked path recorded. A real boundary needs a signer
// the owner's shell cannot read (design section 9; owner decision).
//
// The signer below is deliberately not exported: only a reply that came out
// of prepareAgentReply or prepareStructuredReply in this process, with no
// rule violations, can be signed (signPreparedReply).
//
// Imports only claims.mjs, checklist.mjs (pure: the stage 3 footer) and Node
// built-ins, so the agent modules can import it without a cycle.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTOMATED_LABEL, BODY_MAX, ReplyRuleError, customerReplyText, checkFixedRules, placeholdersIn,
  fillPlaceholders, parseStructuredReply, writerViolations, verifyClaim, renderStructured, safeRepoPath, isTimestamp } from './claims.mjs';
import { renderAgentReply, AGENT_REPLY_MAX } from './checklist.mjs';

export { ReplyRuleError };
export const VERIFICATION_KEY = 'support_reply_hmac_key';
export const VERSION_URL = 'https://credentialdomd.com/app/version.json';
export const MIGRATION = 'supabase/migrations/20260928150000_support_reply_verifications.sql';
// Both writers store the ticket owner as author_id with is_admin_reply, and
// notify_ticket_reply emails only an admin author on someone else's ticket.
// Until the owner decides how these reach members (design 9.3), say so.
export const EMAIL_NOT_SENT = 'not emailed: the reply is stored with the ticket owner as author, and notify_ticket_reply emails only an admin author on someone else\'s ticket. It shows in the app thread. How member replies are emailed is an owner decision (design 9.3).';
const PROJECT = 'hkpnnsjcwprrwobmpqyy';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// The committer identity ticket-agent.sh gives the model's git, per run.
export const RUN_COMMITTER = /^ticket-agent\+[0-9a-f]{16}@credentialdomd\.invalid$/;
const RUN_ID = /^[0-9a-f]{16}$/;

export const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const labeledBody = text => `${AUTOMATED_LABEL}\n\n${text}`;
// The exact body the agent's replySQL stores for a reply text.
export const agentReplyBody = reply => labeledBody(customerReplyText(reply));
export const hmacMessage = v => `${v.id}:${v.ticket_id}:${v.body_sha256}`;

// ---------------------------------------------------------------------------
// Signing: only for a reply this process prepared and checked.
// ---------------------------------------------------------------------------
const PREPARED = new WeakSet();
function sealPrepared(prepared) {
  Object.freeze(prepared.report);
  Object.freeze(prepared.violations ?? []);
  PREPARED.add(Object.freeze(prepared));
  return prepared;
}
function hmacOf(verification, secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw Error('Reply verification key is unusable');
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(hmacMessage(verification), 'utf8').digest('hex');
}
export function signPreparedReply(prepared, { ticketId, secret, id = randomUUID() } = {}) {
  if (!PREPARED.has(prepared)) throw Error('Only a reply prepared and checked by prepareAgentReply or prepareStructuredReply in this process can be signed');
  if (prepared.violations?.length) throw Error('A reply that breaks a fixed rule cannot be signed');
  if (!UUID.test(ticketId || '') || prepared.ticketId !== ticketId) throw Error('The reply was prepared for another ticket');
  if (!UUID.test(id)) throw Error('Invalid verification id');
  const verification = { id, ticket_id: ticketId, body_sha256: sha256Hex(prepared.body), report: prepared.report };
  return { ...verification, hmac: hmacOf(verification, secret) };
}
// Shape and binding only; the HMAC itself is checked by the database.
export function checkVerification(verification, ticketId, body) {
  const v = verification;
  if (!v || !UUID.test(v.id || '') || v.ticket_id !== ticketId || !HEX64.test(v.body_sha256 || '') || !HEX64.test(v.hmac || '') ||
      !v.report || typeof v.report !== 'object' || Array.isArray(v.report)) throw Error('A verified reply is required (scripts/ticket-fix/reply.mjs)');
  if (v.body_sha256 !== sha256Hex(body)) throw Error('Reply verification does not match the body being stored');
  return v;
}

const sqlText = s => `convert_from(decode('${Buffer.from(s, 'utf8').toString('hex')}', 'hex'), 'UTF8')`;
export const readOnly = sql => `begin read only; ${sql}; rollback;`;
export function verificationInsertSQL(v) {
  return `INSERT INTO support_reply_verifications (id, ticket_id, body_sha256, hmac, report)
      VALUES ('${v.id}'::uuid, '${v.ticket_id}'::uuid, '${v.body_sha256}', '${v.hmac}', ${sqlText(JSON.stringify(v.report))}::jsonb)`;
}
export async function readVerificationKey(query) {
  const rows = await query(readOnly(`SELECT decrypted_secret AS key FROM vault.decrypted_secrets WHERE name = '${VERIFICATION_KEY}'`));
  const key = rows.length === 1 ? rows[0].key : null;
  // Never put the value, or the response, in the message.
  if (typeof key !== 'string' || key.length < 32) throw Error(`Reply verification key ${VERIFICATION_KEY} is missing from the vault; apply ${MIGRATION} first`);
  return key;
}
// The same text already stored on this ticket (a rerun of the same file).
export function duplicateReplySQL(ticketId, body) {
  if (!UUID.test(ticketId || '')) throw Error('Invalid ticket id');
  return readOnly(`SELECT count(*)::int AS copies FROM support_messages m WHERE m.ticket_id = '${ticketId}'::uuid
    AND encode(sha256(convert_to(m.body, 'UTF8')), 'hex') = '${sha256Hex(body)}'`);
}
export function ticketSQL(ticketId) {
  if (!UUID.test(ticketId || '')) throw Error('Invalid ticket id');
  return readOnly(`SELECT t.id, t.user_id, t.status, t.updated_at, t.archived_at FROM support_tickets t WHERE t.id = '${ticketId}'::uuid`);
}

// Operator path: one ticket, at the version the AUTHOR read (the reply file's
// ticket_version, not a fresh read), the ticket's current status kept (a
// reply never reopens a resolved or archived ticket). Author is the ticket
// owner with is_admin_reply, the same storage the agent uses, so the body
// label, not author_id, says who wrote it.
export function postReplySQL({ ticket, body, verification }) {
  if (!UUID.test(ticket?.id || '') || !UUID.test(ticket?.user_id || '')) throw Error('Invalid ticket');
  if (ticket.updated_at !== null && !isTimestamp(ticket.updated_at)) throw Error('Invalid ticket version');
  if (typeof body !== 'string' || !body.startsWith(`${AUTOMATED_LABEL}\n\n`) || body.length > BODY_MAX + AUTOMATED_LABEL.length + 2 || body.includes('\0')) throw Error('Invalid reply body');
  checkVerification(verification, ticket.id, body);
  const version = ticket.updated_at === null ? 't.updated_at IS NULL' : `t.updated_at = ${sqlText(ticket.updated_at)}::timestamptz`;
  const messageId = randomUUID();
  return `DO $support_reply$
  DECLARE target record;
  BEGIN
    SELECT t.id, t.user_id INTO target FROM support_tickets t WHERE t.id = '${ticket.id}'::uuid
      AND t.user_id = '${ticket.user_id}'::uuid AND ${version} FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    ${verificationInsertSQL(verification)};
    INSERT INTO support_messages (id, ticket_id, author_id, body, is_admin_reply, created_at, verification_id)
      VALUES ('${messageId}'::uuid, target.id, target.user_id, ${sqlText(body)}, true, now(), '${verification.id}'::uuid);
    UPDATE support_tickets SET updated_at = now(), agent_last_reply_at = now() WHERE id = target.id;
  END $support_reply$;
  SELECT id FROM support_messages WHERE id = '${messageId}'::uuid`;
}

// ---------------------------------------------------------------------------
// Host facts: git at HEAD and at the live build. The writer never supplies them.
// ---------------------------------------------------------------------------
export function gitRunner(repo, { binary = 'git' } = {}) {
  const run = (args, allowFail = false) => {
    const r = spawnSync(binary, ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
    if (r.error || r.status !== 0) { if (allowFail) return null; throw Error(`git ${args[0]} failed in ${repo}`); }
    return r.stdout;
  };
  const ref = value => typeof value === 'string' && /^[0-9A-Za-z._/~^-]{1,100}$/.test(value) && !value.startsWith('-');
  return {
    repo,
    head: () => run(['rev-parse', '--verify', 'HEAD']).trim(),
    // Modified tracked files, or new files under src/ or tests/: a committed
    // test that imports an untracked source file is not a clean run.
    dirty: () => run(['status', '--porcelain', '--untracked-files=no']).trim() !== '' ||
      run(['status', '--porcelain', '--untracked-files=all', '--', 'src', 'tests']).split('\n').some(line => line.startsWith('??')),
    fileAtHead: file => (safeRepoPath(file) ? run(['show', `HEAD:${file}`], true) : null),
    fileAt: (commit, file) => (SHA.test(commit || '') && safeRepoPath(file) ? run(['show', `${commit}:${file}`], true) : null),
    resolveCommit: value => {
      if (!ref(value)) return null;
      const out = run(['rev-parse', '--verify', '--quiet', `${value}^{commit}`], true)?.trim();
      return out && SHA.test(out) ? out : null;
    },
    parents: sha => run(['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1),
    isAncestor: (a, b) => spawnSync(binary, ['-C', repo, 'merge-base', '--is-ancestor', a, b], { timeout: 30000 }).status === 0,
    changedFiles: sha => run(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]).split('\n').filter(Boolean),
    // Non-merge commits after base whose committer is this run's identity,
    // newest first. A pull brings in commits with other committers; a docs
    // note the run also made is filtered later by the files it touches.
    commitsBy: (base, committer) => (ref(base) && RUN_COMMITTER.test(committer || '')
      ? run(['log', '--no-merges', '--format=%H%x09%ce', `${base}..HEAD`]).split('\n').filter(Boolean)
        .map(line => line.split('\t')).filter(([, email]) => email === committer).map(([sha]) => sha) : []),
  };
}
export async function fetchLiveBuild(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${VERSION_URL}?cb=${Date.now()}`, { signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw Error(`version.json returned ${response.status}`);
  const data = await response.json();
  const match = /^\d{8}T\d{4}-([0-9a-f]{7,40})$/.exec(typeof data?.build === 'string' ? data.build : '');
  if (!match) throw Error('version.json carries no usable build id');
  return { build: data.build, short: match[1] };
}
// The live build as this repository knows it. contains_head: every commit at
// HEAD is live, so something tested or read at HEAD is what customers run.
export async function readLiveBuild(git, fetchBuild = fetchLiveBuild) {
  let fetched;
  try { fetched = await fetchBuild(); } catch (error) {
    return { build: null, short: null, commit: null, contains_head: false, error: `could not read the live build (${String(error.message).slice(0, 120)})` };
  }
  const commit = git.resolveCommit(fetched.short);
  if (!commit) return { build: fetched.build, short: fetched.short, commit: null, contains_head: false, error: 'the live build is not in this repository (fetch origin first)' };
  let head = null;
  try { head = git.head(); } catch { head = null; }
  return { build: fetched.build, short: fetched.short, commit, contains_head: Boolean(head && git.isAncestor(head, commit)) };
}
// Repository files named in free text such as the agent's verification.checks
// ("src/x.js:12", "tests/y.test.mjs").
export function filesCitedIn(text) {
  return new Set([...String(text ?? '').matchAll(/(?:^|[\s(`'"[,;])((?:src|supabase|public|landing|scripts|tests)\/[\w.@()/-]*?\.[A-Za-z]{1,5})(?=[:\s)`'",;\]]|$)/g)]
    .map(m => m[1]).filter(safeRepoPath));
}

// Values for {{BUILD}} and {{FIX_COMMIT}}. A fix commit must be a single-parent
// commit in HEAD that the live build contains and that touches a file the
// reply cites (the c237149 and aae81ff replies cited commits that changed none
// of the files involved). On the post-reply path it is the --fix commit. On
// the agent path it is the ONE commit this run made (the host commits the
// model's work with the run's committer identity, ticket-fix/worktree.mjs)
// that touches a file verification.checks cites, and that the host merged and
// release-checked (G7); a docs note, a co-worker's pulled commit or two
// candidate commits are never guessed from.
function hostValues(names, { git, live, fixRef = null, citedFiles = new Set(), agent = null }) {
  const values = {}, facts = {}, violations = [];
  if (!names.size) return { values, facts, violations };
  const refuse = (rule, why) => { violations.push({ rule, excerpt: why }); return { values, facts, violations }; };
  if (live?.build) facts.build = live.build; else if (live?.error) facts.build_error = live.error;
  if (names.has('BUILD')) { if (live?.build) values.BUILD = live.build; else refuse('build_unavailable', 'version.json unavailable'); }
  if (!names.has('FIX_COMMIT')) return { values, facts, violations };
  let fix;
  if (agent) {
    if (!SHA.test(agent.preHead || '')) return refuse('fix_commit_unavailable', 'no pre-run revision was recorded');
    if (!RUN_COMMITTER.test(agent.runCommitter || '')) return refuse('fix_commit_unavailable', 'no run committer was recorded');
    const made = git.commitsBy(agent.preHead, agent.runCommitter);
    facts.run_commits = made;
    if (!made.length) return refuse('fix_commit_unavailable', 'this run made no commit');
    if (!citedFiles.size) return refuse('fix_commit_unavailable', 'verification.checks cites no repository file');
    const candidates = made.filter(sha => git.changedFiles(sha).some(file => citedFiles.has(file)));
    facts.fix_candidates = candidates;
    if (candidates.length !== 1) return refuse('fix_commit_unavailable', candidates.length ? 'more than one commit from this run touches the cited files' : 'no commit from this run touches a file verification.checks cites');
    [fix] = candidates;
  } else {
    if (!fixRef) return refuse('fix_commit_unavailable', 'pass --fix <commit>');
    fix = git.resolveCommit(fixRef);
    if (!fix) return refuse('fix_commit_unavailable', 'the --fix commit does not exist here');
    const touched = git.changedFiles(fix).filter(file => citedFiles.has(file));
    facts.fix_touches = touched;
    if (!touched.length) return refuse('fix_commit_unavailable', 'the commit touches none of the files the confirmed claims cite');
  }
  facts.fix_commit = fix;
  if (git.parents(fix).length !== 1) return refuse('fix_commit_unavailable', 'a merge or root commit is not a fix');
  if (!git.isAncestor(fix, 'HEAD')) return refuse('fix_commit_unavailable', 'the commit is not in HEAD');
  facts.fix_live = Boolean(live?.commit && git.isAncestor(fix, live.commit));
  if (!facts.fix_live) return refuse('fix_commit_unavailable', 'the commit is not in the live build');
  // Agent path (stage 2): the host merged the fix and ran the G7 release
  // check (the live build descends from it and the bundle probes passed).
  // Without that record nothing may be called live.
  if (agent) {
    facts.release_verified = agent.release?.verified === true && agent.release.fix_commit === fix;
    if (!facts.release_verified) return refuse('fix_commit_unavailable', 'no passing release check (G7) for this commit');
  }
  values.FIX_COMMIT = fix.slice(0, 7);
  return { values, facts, violations };
}

// The agent's free-text reply. Nothing binds its prose to evidence yet (the
// structured agent schema is the next stage), so: the fixed rules, plus a
// refusal of any sentence that reports a result or a finished change
// (unverified_claim), then host-filled ids. The verification records
// claims: 'unbound' so it is never mistaken for a checked claim set. Throws
// ReplyRuleError, which the runner feeds back to the model in its repair loop.
export async function prepareAgentReply({ reply, ticketId = null, git = null, preHead = null, runCommitter = null, runStarted = null, runId = null,
  citedFiles = new Set(), fetchBuild = fetchLiveBuild, verificationKind = null, release = null }) {
  const text = customerReplyText(reply);
  if (!text.trim()) throw Error('Invalid reply');
  const isCommit = git ? token => git.resolveCommit(token) !== null : null;
  const violations = checkFixedRules(text, { claims: true, isCommit });
  if (violations.length) throw new ReplyRuleError(violations);
  const names = placeholdersIn(text);
  if (names.size && !git) throw new ReplyRuleError([{ rule: 'fix_commit_unavailable', excerpt: 'no repository available' }]);
  const live = names.size ? await readLiveBuild(git, fetchBuild) : null;
  const host = hostValues(names, { git, live, citedFiles, agent: { preHead, runCommitter, release } });
  if (host.violations.length) throw new ReplyRuleError(host.violations);
  const filled = names.size ? fillPlaceholders(text, host.values) : text;
  if (filled.length > BODY_MAX) throw new ReplyRuleError([{ rule: 'too_long', excerpt: String(filled.length) }]);
  const body = agentReplyBody(filled);
  const tail = checkFixedRules(filled, { hex: false });
  if (tail.length) throw new ReplyRuleError(tail);
  let head = null;
  try { head = git ? git.head() : null; } catch { head = null; }
  return sealPrepared({ ticketId, text: filled, body, report: { version: 2, path: 'agent', claims: 'unbound', rules: 'passed', verification_kind: verificationKind,
    pre_head: SHA.test(preHead || '') ? preHead : null, run_started: ISO.test(runStarted || '') ? runStarted : null,
    run_id: RUN_ID.test(runId || '') ? runId : null, head, host: host.facts } });
}

// The hourly agent's reply (stage 3, A3 and G1): rendered by the host from
// the structured result and the host's own decision (stage3.final, written by
// ticket-fix/run.mjs): a fixed opening, only the claims the host verified,
// the questions, "Where each part stands:" with one line per frozen checklist
// item in the state the host decided, and a fixed closing. No sentence of
// the model's reaches the customer except a verified claim, a checked
// question, a requirement the host quoted-checked at extraction and the
// "remaining" text of an item that is not done (which may report no result).
export function prepareRenderedReply({ result, ticketId, ownerTicket = false, stage3, runId = null, preHead = null, runStarted = null }) {
  if (!UUID.test(ticketId || '') || stage3?.ticket_id !== ticketId) throw Error('The host decision is for another ticket');
  const verdicts = new Map((stage3.final.claims ?? []).map(c => [c.index, c]));
  // A verified claim is shown only under an item the host decided done: a
  // true sentence about an item left partly done (the wrong screen, a refused
  // change) would contradict the footer below it (stage 3 review).
  const doneItems = new Set(stage3.final.items.filter(f => f.state === 'done').map(f => f.id));
  const confirmed = result.reply.claims.filter((c, i) => verdicts.get(i)?.verified === true && doneItems.has(c.ac_id)).map(c => c.text.trim());
  const questions = result.assessment.questions.map(q => q.question.trim());
  const pending = stage3.final.items.some(f => f.state !== 'done');
  // "We will post when the rest is done" only when something is left.
  const closing = result.reply.closing === 'follow_up' && !pending ? 'reply_here' : result.reply.closing;
  const text = renderAgentReply({ opening: result.reply.opening, confirmed, questions, items: stage3.checklist.items, finals: stage3.final.items, closing, ownerTicket });
  const violations = checkFixedRules(text, { max: AGENT_REPLY_MAX });
  if (violations.length) throw new ReplyRuleError(violations);
  const body = agentReplyBody(text);
  if (body !== labeledBody(text)) throw new ReplyRuleError([{ rule: 'em_dash', excerpt: '' }]);
  return sealPrepared({ ticketId, text, body, report: { version: 3, path: 'agent', claims: 'bound', rules: 'passed', rendered_sha256: sha256Hex(text),
    checklist_sha256: stage3.checklist.items_sha256 ?? null, items: stage3.final.items.map(f => ({ id: f.id, state: f.state, detail: f.detail ?? null })),
    claims_checked: (stage3.final.claims ?? []).map(c => ({ index: c.index, ac_id: c.ac_id, verified: c.verified === true, reason: String(c.reason ?? '').slice(0, 200) })),
    attachments: (stage3.attachments ?? []).map(a => ({ id: a.attachment, access: a.access })), code_outcome: stage3.final.code_outcome ?? null,
    pre_head: SHA.test(preHead || '') ? preHead : null, run_started: ISO.test(runStarted || '') ? runStarted : null, run_id: RUN_ID.test(runId || '') ? runId : null } });
}

// The post-reply path (A3): the reply is rendered by the host from claims.
// Never throws for an unverified claim: it is rendered under "Not done yet".
// Throws only when the file itself is malformed. Rule violations are
// returned; nothing may be posted while any remain.
//   runTestsFor(files) -> gates   at post time the host runs the cited tests
//                                 itself; `gates` (a file) is the dry run's cache
//   readQuery(id) -> record       at post time the stored SQL is run again
export async function prepareStructuredReply({ reply: raw, ticketId, ownerId = null, git, gates = null, gatesSha256 = null, runTestsFor = null,
  readQuery = async () => null, fixRef = null, fetchBuild = fetchLiveBuild }) {
  const reply = parseStructuredReply(raw, ticketId);
  const head = git.head();
  const live = await readLiveBuild(git, fetchBuild);
  const violations = writerViolations(reply, { isCommit: token => git.resolveCommit(token) !== null, liveShort: live.short });
  const testFiles = [...new Set(reply.claims.filter(c => c.evidence?.kind === 'test').map(c => c.evidence.ref.split('::')[0]))];
  let tests = gates, testsSha256 = gatesSha256, testsSource = gates ? 'gates_file' : null;
  if (runTestsFor && testFiles.length) { tests = await runTestsFor(testFiles); testsSha256 = null; testsSource = 'host_run_at_post'; }
  const queryIds = new Set(reply.claims.flatMap(c => (c.evidence?.kind === 'query' ? [c.evidence.ref, c.evidence.expect?.control].filter(Boolean) : [])));
  const records = new Map();
  for (const id of queryIds) records.set(id, await readQuery(id));
  // The dry run has no database: it scopes by the owner record-query stored.
  const owner = ownerId ?? [...records.values()].find(r => UUID.test(r?.owner_id || ''))?.owner_id ?? null;
  const sources = { head, live, gates: tests, fileAtHead: file => git.fileAtHead(file), fileAtLive: file => (live.commit ? git.fileAt(live.commit, file) : null),
    query: id => records.get(id) ?? null, scope: [ticketId, owner] };
  const results = reply.claims.map(claim => ({ ...claim, ...verifyClaim(claim, sources) }));
  const confirmed = results.filter(r => r.verified);
  const pending = [...results.filter(r => !r.verified).map(r => r.text), ...reply.not_done];
  if (reply.closing === 'follow_up' && !pending.length) violations.push({ rule: 'follow_up_without_pending', excerpt: '', field: 'closing' });
  const citedFiles = new Set(confirmed.flatMap(r => (r.evidence.kind === 'file' ? [r.evidence.file] : r.evidence.kind === 'test' ? [r.evidence.ref.split('::')[0]] : [])));
  const draft = renderStructured({ opening: reply.opening, context: reply.context, confirmed: confirmed.map(r => r.text), pending, closing: reply.closing });
  const host = hostValues(placeholdersIn(draft), { git, live, fixRef, citedFiles });
  violations.push(...host.violations.map(v => ({ ...v, field: 'placeholders' })));
  const rendered = host.violations.length ? draft : fillPlaceholders(draft, host.values);
  const body = labeledBody(rendered);
  if (!violations.length) violations.push(...checkFixedRules(rendered, { hex: false }).map(v => ({ ...v, field: 'rendered' })));
  const report = { version: 2, path: 'post-reply', claims: 'bound', head, ticket_version: reply.ticket_version, opening: reply.opening, context: reply.context, closing: reply.closing,
    rendered_sha256: sha256Hex(rendered), live: { build: live.build, commit: live.commit, contains_head: live.contains_head },
    claims_checked: results.map(r => ({ id: r.id, text: r.text, evidence: r.evidence && { kind: r.evidence.kind, ref: r.evidence.ref }, verified: r.verified, reason: r.reason })),
    not_done: reply.not_done, tests: tests ? { source: testsSource, head: tests.head, ran_at: tests.ran_at ?? null, sha256: testsSha256 } : null,
    queries: [...records.entries()].map(([id, r]) => ({ id, found: Boolean(r), reexecuted: Boolean(r?.reexecuted), matches_stored: r?.reexecuted ? r.rows_sha256 === r.stored_rows_sha256 : null })),
    host: host.facts };
  return sealPrepared({ ticketId, ticketVersion: reply.ticket_version, violations, body, rendered, confirmed: confirmed.length, pending: pending.length, report });
}

// ---------------------------------------------------------------------------
// Private host state and transport, shared by the CLIs.
// ---------------------------------------------------------------------------
export function stateDirectory(env = process.env) {
  return env.TICKET_FIX_STATE || path.join(os.homedir(), 'Library', 'Application Support', 'CredentialDOMD', 'ticket-fix');
}
export async function ensurePrivateDir(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error(`${directory} must be an owner-only directory`);
}
export async function writePrivate(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, filename);
}
export async function readPrivateJSON(filename, limit = 2 * 1024 * 1024) {
  let stat;
  try { stat = await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > limit) throw Error(`${filename} must be an owner-only file`);
  const raw = await fs.readFile(filename, 'utf8');
  return { value: JSON.parse(raw), sha256: sha256Hex(raw) };
}
export const queryRecordPath = (state, ticketId, id) => path.join(state, 'queries', ticketId, `${id}.json`);
export async function readQueryRecord(state, ticketId, id) {
  if (!UUID.test(ticketId) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return null;
  const found = await readPrivateJSON(queryRecordPath(state, ticketId, id));
  const r = found?.value;
  if (!r || r.version !== 1 || r.ticket_id !== ticketId || r.id !== id || !Array.isArray(r.rows) || r.row_count !== r.rows.length ||
      r.rows_sha256 !== sha256Hex(JSON.stringify(r.rows)) || !Number.isFinite(Date.parse(r.ran_at)) || typeof r.sql !== 'string' ||
      (r.owner_id !== undefined && r.owner_id !== null && !UUID.test(r.owner_id))) return null;
  // A stored record is the writer's file and could be written by hand
  // (review 2026-09-28). The dry run reads it as a cache; post-reply runs its
  // SQL again when posting and checks what comes back.
  return r;
}
// A gates file is likewise only the dry run's cache: post-reply runs the cited
// tests itself on a clean tree when it posts.
export async function loadGates(filename) {
  const found = await readPrivateJSON(filename, 16 * 1024 * 1024);
  const g = found?.value;
  if (!g || g.version !== 1 || g.producer !== 'scripts/ticket-fix/run-tests.mjs' || !SHA.test(g.head || '') || typeof g.dirty !== 'boolean' || !Array.isArray(g.tests)) {
    throw Error('Gates file refused: only a file written by scripts/ticket-fix/run-tests.mjs is evidence');
  }
  return { gates: g, sha256: found.sha256 };
}

export function managementQuery(token, { fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw Error('A database token is required');
  return async query => {
    const response = await fetchImpl(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000),
    });
    // The body of a failed request can quote the statement; keep it out of errors.
    if (!response.ok) throw Error(`Support database request failed (${response.status})`);
    const raw = await response.text();
    if (raw.length > 4 * 1024 * 1024) throw Error('Support database response exceeds bound');
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw Error('Unusable database response');
    return rows;
  };
}
export function databaseToken(env = process.env) {
  if (env.TICKET_DATABASE_TOKEN) return env.TICKET_DATABASE_TOKEN;
  for (const flag of ['-s', '-l']) {
    const r = spawnSync('/usr/bin/security', ['find-generic-password', flag, 'Supabase CLI', '-w'], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw Error('No database token: set TICKET_DATABASE_TOKEN or add the "Supabase CLI" keychain item');
}
