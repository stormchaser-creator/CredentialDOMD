#!/usr/bin/env node
// Post ONE verified support reply to ONE ticket. Every support reply written
// outside the app (interactive Claude, Codex, the owner at a terminal) goes
// through here; after migrations 20260928150000 and 20260928160000 the
// database refuses a support reply that did not (critique amendment A1).
//
//   node scripts/ticket-fix/post-reply.mjs --ticket <uuid> --reply <file.json|->
//        [--gates <gates.json>] [--fix <commit>] [--dry-run] [--json]
//
// The reply is rendered by the host from structured claims (A3). A claim that
// cites evidence that verifies is listed under "What we confirmed:"; any other
// claim, and everything in not_done, is listed under "Not done yet:".
// Evidence is one of:
//   {"test": "<test file>::<test name>"}   the host runs the cited test files on a
//                                           clean tree at HEAD when posting (a
//                                           --gates file from run-tests.mjs is only
//                                           the dry run's cache); HEAD must be live
//   {"query": "<id>", "expect": {...}}      a query recorded by record-query.mjs;
//                                           its SQL is run again when posting
//   {"file": "<path>", "line": n, "text": "..."}  quoted UI text at that line of
//                                           src/, supabase/functions/, public/ or
//                                           landing/ in the live build
// {{FIX_COMMIT}} and {{BUILD}} are filled by the host from --fix, git and the
// live version.json (context "release"); the writer never types an id.
// ticket_version is the ticket's updated_at as the writer read it; a ticket
// that changed since is withheld (exit 4).
//
// Exit: 0 stored (a dry run: every claim confirmed); 2 refused (a fixed rule or
// a malformed file, nothing posted); 3 dry run with claims that would render as
// not done; 4 withheld because the ticket changed after it was read; 1 error.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describeViolations } from './claims.mjs';
import { prepareStructuredReply, gitRunner, loadGates, readQueryRecord, stateDirectory, ensurePrivateDir, writePrivate, sha256Hex, readOnly,
  readVerificationKey, signPreparedReply, postReplySQL, ticketSQL, duplicateReplySQL, managementQuery, databaseToken, fetchLiveBuild, EMAIL_NOT_SENT } from './reply.mjs';
import { checkSelect, MAX_ROWS } from './record-query.mjs';
import { runTestsNow } from './run-tests.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv, { dryRunOnly = false } = {}) {
  const out = { dryRun: dryRunOnly, json: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--json') {
      if (seen.has(arg)) throw Error(`${arg} given twice`);
      seen.add(arg); out[arg === '--json' ? 'json' : 'dryRun'] = true; continue;
    }
    if (['--ticket', '--reply', '--gates', '--fix'].includes(arg)) {
      if (seen.has(arg)) throw Error(`${arg} given twice: one ticket and one reply per call`);
      seen.add(arg);
      const value = argv[++i];
      if (value === undefined || (value.startsWith('--') && value !== '-')) throw Error(`${arg} needs a value`);
      out[arg.slice(2)] = value; continue;
    }
    throw Error(`Unexpected argument ${JSON.stringify(arg)}; one ticket per call`);
  }
  if (!UUID.test(out.ticket || '')) throw Error('--ticket <uuid> is required, exactly one ticket per call');
  if (!out.reply) throw Error('--reply <file.json|-> is required');
  return out;
}

async function readReply(source, stdin = process.stdin) {
  let raw = '';
  if (source === '-') { for await (const chunk of stdin) raw += chunk; } else raw = await fs.readFile(source, 'utf8');
  if (raw.length > 256 * 1024) throw Error('Reply file exceeds 256 KB');
  try { return JSON.parse(raw); } catch { throw Error('Reply file is not valid JSON'); }
}
function repoRoot() {
  const r = spawnSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) throw Error('Run inside the CredentialDOMD repository');
  return r.stdout.trim();
}
function printHuman(prepared, log) {
  log(prepared.body);
  log('');
  for (const claim of prepared.report.claims_checked) log(`${claim.verified ? 'CONFIRMED' : 'NOT DONE '} ${claim.evidence ? `${claim.evidence.kind} ${claim.evidence.ref}` : 'no evidence'}: ${claim.reason}`);
  if (prepared.violations.length) log(`REFUSED: ${describeViolations(prepared.violations)}`);
}
// At post time a recorded query is evidence only as what its SQL returns now.
export function freshQueryReader({ state, ticketId, query, now = () => Date.now() }) {
  return async id => {
    const stored = await readQueryRecord(state, ticketId, id);
    if (!stored) return null;
    const rows = await query(readOnly(checkSelect(stored.sql)));
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) return null;
    return { ...stored, rows, row_count: rows.length, rows_sha256: sha256Hex(JSON.stringify(rows)), ran_at: new Date(now()).toISOString(),
      reexecuted: true, stored_rows_sha256: stored.rows_sha256 };
  };
}

// deps (tests): { repo, git, query, stateDir, fetchBuild, runTests, log, stdin }
export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? (line => console.log(line));
  let args;
  try { args = parseArgs(argv, { dryRunOnly: deps.dryRunOnly }); } catch (error) { log(`ERROR: ${error.message}`); return 2; }
  const git = deps.git ?? gitRunner(deps.repo ?? repoRoot());
  const state = deps.stateDir ?? stateDirectory();
  const fetchBuild = deps.fetchBuild ?? fetchLiveBuild;
  let raw;
  try { raw = await readReply(args.reply, deps.stdin); } catch (error) { log(`REFUSED: ${error.message}`); return 2; }

  if (args.dryRun) {
    // No database: the gates file and the stored query results are a cache.
    let prepared;
    try {
      const gates = args.gates ? await loadGates(args.gates) : null;
      prepared = await prepareStructuredReply({ reply: raw, ticketId: args.ticket, git, gates: gates?.gates ?? null, gatesSha256: gates?.sha256 ?? null,
        readQuery: id => readQueryRecord(state, args.ticket, id), fixRef: args.fix ?? null, fetchBuild });
    } catch (error) { log(`REFUSED: ${error.message}`); return 2; }
    report(prepared, args, log);
    if (prepared.violations.length) return 2;
    return prepared.pending ? 3 : 0;
  }

  const query = deps.query ?? managementQuery(databaseToken());
  const tickets = await query(ticketSQL(args.ticket));
  if (tickets.length !== 1 || tickets[0].id !== args.ticket) { log('ERROR: ticket not found'); return 1; }
  const ticket = tickets[0];
  let prepared;
  try {
    // Evidence is produced now, by the host: the cited tests run on a clean
    // tree at HEAD, and each cited query's SQL runs again. --gates is ignored.
    const runTests = deps.runTests ?? (files => runTestsNow({ repo: git.repo, files }));
    prepared = await prepareStructuredReply({ reply: raw, ticketId: ticket.id, ownerId: ticket.user_id, git, runTestsFor: runTests,
      readQuery: freshQueryReader({ state, ticketId: ticket.id, query }), fixRef: args.fix ?? null, fetchBuild });
  } catch (error) { log(`REFUSED: ${error.message}`); return 2; }
  report(prepared, args, log);
  if (prepared.violations.length) return 2;
  const [{ copies } = {}] = await query(duplicateReplySQL(ticket.id, prepared.body));
  if (copies !== 0) { log('REFUSED: this exact reply is already stored on the ticket; nothing was posted.'); return 2; }
  // Read at run time, held in memory only, never logged.
  const secret = await readVerificationKey(query);
  const verification = signPreparedReply(prepared, { ticketId: ticket.id, secret });
  // The version the writer read, not the one read above: a customer message
  // that arrived after the writer read the thread withholds the reply.
  const rows = await query(postReplySQL({ ticket: { id: ticket.id, user_id: ticket.user_id, updated_at: prepared.ticketVersion }, body: prepared.body, verification }));
  if (rows.length !== 1) { log('WITHHELD: the ticket changed after the version in ticket_version was read; nothing was stored. Read the new messages, update the reply and its ticket_version, and run again.'); return 4; }
  const posted = { kind: 'reply_stored', ticket_id: ticket.id, message_id: rows[0].id, verification_id: verification.id,
    body_sha256: verification.body_sha256, confirmed: prepared.confirmed, not_done: prepared.pending, status_kept: ticket.status,
    emailed: false, email: EMAIL_NOT_SENT };
  const ledger = path.join(state, 'replies', ticket.id);
  await ensurePrivateDir(ledger);
  await writePrivate(path.join(ledger, `${verification.id}.json`), JSON.stringify({ ...posted, path: 'post-reply', posted_at: new Date().toISOString(), report: prepared.report }, null, 2));
  log(JSON.stringify(posted));
  return 0;
}
function report(prepared, args, log) {
  if (args.json) log(JSON.stringify({ ok: !prepared.violations.length, violations: prepared.violations, confirmed: prepared.confirmed, not_done: prepared.pending, body: prepared.body, report: prepared.report }, null, 2));
  else printHuman(prepared, log);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
