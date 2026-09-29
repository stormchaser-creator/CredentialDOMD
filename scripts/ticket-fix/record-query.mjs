#!/usr/bin/env node
// Run one read-only query for one ticket and store its result privately, so a
// reply can cite {"query": "<id>"} and the host checks the stored result, not
// the writer's summary of it (5bef10ac: a verifier read zero rows through RLS
// and reported that something never happened).
//
//   node scripts/ticket-fix/record-query.mjs --ticket <uuid> --id <name> --sql <file|->
//
// The statement must be one SELECT (or WITH ... SELECT) that reads a table and
// names the ticket id or the ticket owner's id (a claim is about this
// customer's data). It runs inside "begin read only; ...; rollback;" through
// the management API. At most 200 rows are kept, under
// <state>/queries/<ticket>/<id>.json (owner-only, never in the repository),
// with the ticket owner's id. The stored rows are only the dry run's cache:
// post-reply.mjs runs the stored SQL again when it posts. A claim that
// something is absent must name a positive control on the same table,
// recorded the same way within 15 minutes.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readOnly, managementQuery, databaseToken, stateDirectory, ensurePrivateDir, writePrivate, queryRecordPath, sha256Hex, ticketSQL } from './reply.mjs';
import { isMain } from './is-main.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_ROWS = 200;

export function checkSelect(sql) {
  const text = String(sql).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '').trim();
  if (!/^(?:select|with)\b/i.test(text)) throw Error('Only a single SELECT (or WITH ... SELECT) can be recorded');
  if (text.includes(';')) throw Error('One statement only');
  if (/\b(?:insert|update|delete|merge|alter|drop|create|grant|revoke|truncate|copy|call|do|execute|vacuum|refresh|lock|notify|listen|set|reset|begin|commit|rollback|savepoint|prepare|set_config|pg_terminate_backend|pg_cancel_backend|dblink\w*|lo_\w+)\b/i.test(text.replace(/'(?:[^']|'')*'/g, "''"))) {
    throw Error('The statement contains a write or session keyword; record reads only');
  }
  return text;
}

export async function recordQuery({ ticketId, id, sql, query, state, now = Date.now() }) {
  if (!UUID.test(ticketId || '')) throw Error('--ticket <uuid> is required');
  if (!ID.test(id || '')) throw Error('--id is lowercase letters, digits, - and _');
  const statement = checkSelect(sql);
  const tickets = await query(ticketSQL(ticketId));
  if (tickets.length !== 1 || tickets[0].id !== ticketId || !UUID.test(tickets[0].user_id || '')) throw Error('Ticket not found');
  const rows = await query(readOnly(statement));
  if (rows.length > MAX_ROWS) throw Error(`The query returned more than ${MAX_ROWS} rows; narrow it`);
  const record = { version: 1, producer: 'scripts/ticket-fix/record-query.mjs', id, ticket_id: ticketId, owner_id: tickets[0].user_id, sql: statement,
    sql_sha256: createHash('sha256').update(statement).digest('hex'), ran_at: new Date(now).toISOString(),
    row_count: rows.length, rows_sha256: sha256Hex(JSON.stringify(rows)), rows };
  const file = queryRecordPath(state, ticketId, id);
  await ensurePrivateDir(path.dirname(file));
  await writePrivate(file, JSON.stringify(record, null, 2));
  return { file, record };
}

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--ticket', '--id', '--sql'].includes(argv[i]) || argv[i + 1] === undefined || argv[i] in options) throw Error('Usage: record-query.mjs --ticket <uuid> --id <name> --sql <file|->');
    options[argv[i]] = argv[i + 1];
  }
  let sql = '';
  if (options['--sql'] === '-') { for await (const chunk of process.stdin) sql += chunk; } else sql = await fs.readFile(options['--sql'] ?? '', 'utf8');
  const { file, record } = await recordQuery({ ticketId: options['--ticket'], id: options['--id'], sql,
    query: managementQuery(databaseToken()), state: stateDirectory() });
  console.log(`recorded ${record.row_count} rows for ${record.id} at ${record.ran_at}: ${file}`);
}
if (isMain(import.meta.url)) {
  main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
