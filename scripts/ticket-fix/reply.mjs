// The one verified reply path for every CredentialDOMD support reply: the
// hourly agent (scripts/ticket-agent-context.mjs --record-and-reply), and
// interactive Claude or Codex sessions (post-reply.mjs). Critique amendment A1.
//
// A reply is written as a support_reply_verifications row plus the
// support_messages row that points at it, in one statement. The row carries
// sha256(stored body) and an HMAC-SHA256 over "<id>:<ticket_id>:<body_sha256>"
// keyed with the vault secret support_reply_hmac_key, read through the
// management API at run time and held only in memory. The database trigger
// from 20260928150000_support_reply_verifications.sql refuses an operator-SQL
// support reply without a matching, unused verification.
//
// Imports only claims.mjs and Node built-ins, so the agent modules can import
// it without a cycle.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTOMATED_LABEL, BODY_MAX, customerReplyText, checkFixedRules, describeViolations, placeholdersIn,
  fillPlaceholders, parseStructuredReply, writerViolations, verifyEvidence, renderStructured, safeRepoPath } from './claims.mjs';

export const VERIFICATION_KEY = 'support_reply_hmac_key';
export const VERSION_URL = 'https://credentialdomd.com/app/version.json';
export const MIGRATION = 'supabase/migrations/20260928150000_support_reply_verifications.sql';
const PROJECT = 'hkpnnsjcwprrwobmpqyy';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export class ReplyRuleError extends Error {
  constructor(violations) {
    super(`Reply breaks fixed reply rules: ${describeViolations(violations)}`);
    this.violations = violations;
  }
}

export const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const labeledBody = text => `${AUTOMATED_LABEL}\n\n${text}`;
// The exact body the agent's replySQL stores for a reply text.
export const agentReplyBody = reply => labeledBody(customerReplyText(reply));
export const hmacMessage = v => `${v.id}:${v.ticket_id}:${v.body_sha256}`;
export function replyHmac(verification, secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw Error('Reply verification key is unusable');
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(hmacMessage(verification), 'utf8').digest('hex');
}
export function buildVerification({ ticketId, body, report, secret, id = randomUUID() }) {
  if (!UUID.test(ticketId || '') || !UUID.test(id)) throw Error('Invalid verification ids');
  if (typeof body !== 'string' || !body.trim()) throw Error('Invalid reply body');
  const verification = { id, ticket_id: ticketId, body_sha256: sha256Hex(body), report: report ?? {} };
  return { ...verification, hmac: replyHmac(verification, secret) };
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

// Operator path: one ticket, the version the author read, the ticket's
// current status kept (a reply never reopens a resolved or archived ticket).
// Author is the ticket owner with is_admin_reply, the same storage the agent
// uses, so the body label, not author_id, says who wrote it.
export function postReplySQL({ ticket, body, verification }) {
  if (!UUID.test(ticket?.id || '') || !UUID.test(ticket?.user_id || '')) throw Error('Invalid ticket');
  if (ticket.updated_at !== null && (typeof ticket.updated_at !== 'string' || !Number.isFinite(Date.parse(ticket.updated_at)))) throw Error('Invalid ticket version');
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
// Host facts: git at HEAD and the live build. The writer never supplies them.
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
    dirty: () => run(['status', '--porcelain', '--untracked-files=no']).trim() !== '',
    fileAtHead: file => (safeRepoPath(file) ? run(['show', `HEAD:${file}`], true) : null),
    resolveCommit: value => {
      if (!ref(value)) return null;
      const out = run(['rev-parse', '--verify', '--quiet', `${value}^{commit}`], true)?.trim();
      return out && SHA.test(out) ? out : null;
    },
    parents: sha => run(['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1),
    isAncestor: (a, b) => spawnSync(binary, ['-C', repo, 'merge-base', '--is-ancestor', a, b], { timeout: 30000 }).status === 0,
    changedFiles: sha => run(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]).split('\n').filter(Boolean),
    // Non-merge commits after base, newest first; with `since`, only those
    // committed at or after it (a pull during the run brings in other people's).
    commitsSince: (base, since = null) => (ref(base)
      ? run(['rev-list', '--no-merges', ...(ISO.test(since || '') ? [`--since=${since}`] : []), `${base}..HEAD`]).split('\n').filter(Boolean) : []),
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

// Values for {{BUILD}} and {{FIX_COMMIT}}. A fix commit must be a single-parent
// commit in HEAD that the live build contains. On the post-reply path it must
// also touch a file a confirmed claim cites (the c237149 and aae81ff replies
// cited commits that changed none of the files involved). On the agent path it
// must be a commit this run made: after preHead and committed after the run
// started, so commits a pull brought in are never taken for the fix.
async function hostValues(names, { git, fixRef = null, preHead = null, runStarted = null, citedFiles = null, fetchBuild }) {
  const values = {}, facts = {}, violations = [];
  if (!names.size) return { values, facts, violations };
  const refuse = (rule, why) => { violations.push({ rule, excerpt: why }); };
  let live = null;
  try { live = await fetchBuild(); facts.build = live.build; } catch (error) { facts.build_error = String(error.message).slice(0, 200); }
  if (names.has('BUILD')) { if (live) values.BUILD = live.build; else refuse('build_unavailable', 'version.json unavailable'); }
  if (!names.has('FIX_COMMIT')) return { values, facts, violations };
  let fix = null;
  if (citedFiles) {
    if (!fixRef) { refuse('fix_commit_unavailable', 'pass --fix <commit>'); return { values, facts, violations }; }
    fix = git.resolveCommit(fixRef);
    if (!fix) { refuse('fix_commit_unavailable', 'the --fix commit does not exist here'); return { values, facts, violations }; }
  } else {
    if (!SHA.test(preHead || '')) { refuse('fix_commit_unavailable', 'no pre-run revision was recorded'); return { values, facts, violations }; }
    if (!ISO.test(runStarted || '')) { refuse('fix_commit_unavailable', 'no run start time was recorded'); return { values, facts, violations }; }
    const made = git.commitsSince(preHead, runStarted);
    facts.run_commits = made;
    fix = made[0] ?? null;
    if (!fix) { refuse('fix_commit_unavailable', 'this run made no commit'); return { values, facts, violations }; }
  }
  facts.fix_commit = fix;
  if (git.parents(fix).length !== 1) { refuse('fix_commit_unavailable', 'a merge or root commit is not a fix'); return { values, facts, violations }; }
  if (!git.isAncestor(fix, 'HEAD')) { refuse('fix_commit_unavailable', 'the commit is not in HEAD'); return { values, facts, violations }; }
  const buildCommit = live ? git.resolveCommit(live.short) : null;
  facts.fix_live = Boolean(buildCommit && git.isAncestor(fix, buildCommit));
  if (!facts.fix_live) { refuse('fix_commit_unavailable', 'the commit is not in the live build'); return { values, facts, violations }; }
  if (citedFiles) {
    const touched = git.changedFiles(fix).filter(file => citedFiles.has(file));
    facts.fix_touches = touched;
    if (!touched.length) { refuse('fix_commit_unavailable', 'the commit touches none of the files the confirmed claims cite'); return { values, facts, violations }; }
  }
  values.FIX_COMMIT = fix.slice(0, 7);
  return { values, facts, violations };
}

// The agent's free-text reply (this stage keeps its schema): fixed rules,
// then host-filled ids. Throws ReplyRuleError, which the runner feeds back to
// the model in its repair loop.
export async function prepareAgentReply({ reply, git = null, preHead = null, runStarted = null, fetchBuild = fetchLiveBuild, verificationKind = null }) {
  const text = customerReplyText(reply);
  if (!text.trim()) throw Error('Invalid reply');
  const violations = checkFixedRules(text);
  if (violations.length) throw new ReplyRuleError(violations);
  const names = placeholdersIn(text);
  if (names.size && !git) throw new ReplyRuleError([{ rule: 'fix_commit_unavailable', excerpt: 'no repository available' }]);
  const host = await hostValues(names, { git, preHead, runStarted, fetchBuild });
  if (host.violations.length) throw new ReplyRuleError(host.violations);
  const filled = names.size ? fillPlaceholders(text, host.values) : text;
  if (filled.length > BODY_MAX) throw new ReplyRuleError([{ rule: 'too_long', excerpt: String(filled.length) }]);
  const body = agentReplyBody(filled);
  const tail = checkFixedRules(filled, { hex: false });
  if (tail.length) throw new ReplyRuleError(tail);
  let head = null;
  try { head = git ? git.head() : null; } catch { head = null; }
  return { text: filled, body, report: { version: 1, path: 'agent', rules: 'passed', verification_kind: verificationKind,
    pre_head: SHA.test(preHead || '') ? preHead : null, run_started: ISO.test(runStarted || '') ? runStarted : null, head, host: host.facts } };
}

// The post-reply path (A3): the reply is rendered by the host from claims.
// Never throws for an unverified claim: it is rendered under "Not done yet".
// Throws only when the file itself is malformed. Rule violations are
// returned; nothing may be posted while any remain.
export async function prepareStructuredReply({ reply: raw, ticketId, git, gates = null, gatesSha256 = null, readQuery = async () => null, fixRef = null, fetchBuild = fetchLiveBuild }) {
  const reply = parseStructuredReply(raw, ticketId);
  const head = git.head();
  const violations = writerViolations(reply);
  const queryIds = new Set(reply.claims.flatMap(c => (c.evidence?.kind === 'query' ? [c.evidence.ref, c.evidence.expect?.control].filter(Boolean) : [])));
  const records = new Map();
  for (const id of queryIds) records.set(id, await readQuery(id));
  const sources = { head, fileAtHead: file => git.fileAtHead(file), gates, query: id => records.get(id) ?? null };
  const results = reply.claims.map(claim => ({ ...claim, ...verifyEvidence(claim.evidence, sources) }));
  const confirmed = results.filter(r => r.verified);
  const pending = [...results.filter(r => !r.verified).map(r => r.text), ...reply.not_done];
  if (reply.closing === 'follow_up' && !pending.length) violations.push({ rule: 'follow_up_without_pending', excerpt: '', field: 'closing' });
  const citedFiles = new Set(confirmed.flatMap(r => (r.evidence.kind === 'file' ? [r.evidence.file] : r.evidence.kind === 'test' ? [r.evidence.ref.split('::')[0]] : [])));
  const draft = renderStructured({ opening: reply.opening, context: reply.context, confirmed: confirmed.map(r => r.text), pending, closing: reply.closing });
  const host = await hostValues(placeholdersIn(draft), { git, fixRef, citedFiles, fetchBuild });
  violations.push(...host.violations.map(v => ({ ...v, field: 'placeholders' })));
  const rendered = host.violations.length ? draft : fillPlaceholders(draft, host.values);
  const body = labeledBody(rendered);
  if (!violations.length) violations.push(...checkFixedRules(rendered, { hex: false }).map(v => ({ ...v, field: 'rendered' })));
  const report = { version: 1, path: 'post-reply', head, opening: reply.opening, closing: reply.closing,
    rendered_sha256: sha256Hex(rendered),
    claims: results.map(r => ({ id: r.id, text: r.text, evidence: r.evidence && { kind: r.evidence.kind, ref: r.evidence.ref }, verified: r.verified, reason: r.reason })),
    not_done: reply.not_done, gates: gates ? { head: gates.head, ran_at: gates.ran_at ?? null, sha256: gatesSha256 } : null, host: host.facts };
  return { violations, body, rendered, confirmed: confirmed.length, pending: pending.length, report };
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
      r.rows_sha256 !== sha256Hex(JSON.stringify(r.rows)) || !Number.isFinite(Date.parse(r.ran_at))) return null;
  return r;
}
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
