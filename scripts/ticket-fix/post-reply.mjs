#!/usr/bin/env node
// Post ONE verified support reply to ONE ticket. Every support reply written
// outside the app (interactive Claude, Codex, the owner at a terminal) goes
// through here; after migration 20260928150000 the database refuses an
// operator-SQL support reply that did not (critique amendment A1).
//
//   node scripts/ticket-fix/post-reply.mjs --ticket <uuid> --reply <file.json|->
//        [--gates <gates.json>] [--fix <commit>] [--dry-run] [--json]
//
// The reply is rendered by the host from structured claims (A3). A claim that
// cites evidence that verifies is listed under "What we confirmed:"; any other
// claim, and everything in not_done, is listed under "Not done yet:".
// Evidence is one of:
//   {"test": "<test file>::<test name>"}   passed in --gates, a file written by
//                                           scripts/ticket-fix/run-tests.mjs at HEAD
//   {"query": "<id>", "expect"?: {...}}     a result stored by record-query.mjs
//   {"file": "<path>", "line": n, "text": "..."}  that text within 2 lines of n at HEAD
// {{FIX_COMMIT}} and {{BUILD}} are filled by the host from --fix, git and the
// live version.json; the writer never types a commit or build id.
//
// Exit: 0 stored (a dry run: every claim confirmed); 2 refused (a fixed rule or
// a malformed file, nothing posted); 3 dry run with claims that would render as
// not done; 4 withheld because the ticket changed after it was read; 1 error.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describeViolations } from './claims.mjs';
import { prepareStructuredReply, gitRunner, loadGates, readQueryRecord, stateDirectory, ensurePrivateDir, writePrivate,
  readVerificationKey, buildVerification, postReplySQL, ticketSQL, duplicateReplySQL, managementQuery, databaseToken, fetchLiveBuild } from './reply.mjs';

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
  for (const claim of prepared.report.claims) log(`${claim.verified ? 'CONFIRMED' : 'NOT DONE '} ${claim.evidence ? `${claim.evidence.kind} ${claim.evidence.ref}` : 'no evidence'}: ${claim.reason}`);
  if (prepared.violations.length) log(`REFUSED: ${describeViolations(prepared.violations)}`);
}

// deps (tests): { repo, git, query, stateDir, fetchBuild, log, stdin }
export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? (line => console.log(line));
  let args;
  try { args = parseArgs(argv, { dryRunOnly: deps.dryRunOnly }); } catch (error) { log(`ERROR: ${error.message}`); return 2; }
  const git = deps.git ?? gitRunner(deps.repo ?? repoRoot());
  const state = deps.stateDir ?? stateDirectory();
  let prepared;
  try {
    const raw = await readReply(args.reply, deps.stdin);
    const gates = args.gates ? await loadGates(args.gates) : null;
    prepared = await prepareStructuredReply({ reply: raw, ticketId: args.ticket, git, gates: gates?.gates ?? null, gatesSha256: gates?.sha256 ?? null,
      readQuery: id => readQueryRecord(state, args.ticket, id), fixRef: args.fix ?? null, fetchBuild: deps.fetchBuild ?? fetchLiveBuild });
  } catch (error) {
    log(`REFUSED: ${error.message}`);
    return 2;
  }
  if (args.json) log(JSON.stringify({ ok: !prepared.violations.length, violations: prepared.violations, confirmed: prepared.confirmed, not_done: prepared.pending, body: prepared.body, report: prepared.report }, null, 2));
  else printHuman(prepared, log);
  if (prepared.violations.length) return 2;
  if (args.dryRun) return prepared.pending ? 3 : 0;

  const query = deps.query ?? managementQuery(databaseToken());
  const tickets = await query(ticketSQL(args.ticket));
  if (tickets.length !== 1 || tickets[0].id !== args.ticket) { log('ERROR: ticket not found'); return 1; }
  const ticket = tickets[0];
  const [{ copies } = {}] = await query(duplicateReplySQL(ticket.id, prepared.body));
  if (copies !== 0) { log('REFUSED: this exact reply is already stored on the ticket; nothing was posted.'); return 2; }
  // Read at run time, held in memory only, never logged.
  const secret = await readVerificationKey(query);
  const verification = buildVerification({ ticketId: ticket.id, body: prepared.body, report: prepared.report, secret });
  const rows = await query(postReplySQL({ ticket, body: prepared.body, verification }));
  if (rows.length !== 1) { log('WITHHELD: the ticket changed after it was read; nothing was stored. Read the new message and run again.'); return 4; }
  const posted = { kind: 'reply_stored', ticket_id: ticket.id, message_id: rows[0].id, verification_id: verification.id,
    body_sha256: verification.body_sha256, confirmed: prepared.confirmed, not_done: prepared.pending, status_kept: ticket.status };
  const ledger = path.join(state, 'replies', ticket.id);
  await ensurePrivateDir(ledger);
  await writePrivate(path.join(ledger, `${verification.id}.json`), JSON.stringify({ ...posted, posted_at: new Date().toISOString(), report: prepared.report }, null, 2));
  log(JSON.stringify(posted));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
