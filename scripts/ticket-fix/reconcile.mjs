#!/usr/bin/env node
// Reports stored support replies that no checked path recorded.
//
// The reply HMAC is not a boundary against someone holding the management
// token: that token runs SQL as postgres, which can read the vault key, and
// the key recipe is in a public migration (review 2026-09-28). What the
// checked writers do that a hand-made reply does not is keep a private ledger
// entry per verification:
//   post-reply.mjs               <ticket-fix state>/replies/<ticket>/<verification>.json
//   the hourly runner            <ticket-context state>/replies/<ticket>/<verification>.json
// This compares the last 14 days of support_reply_verifications with those
// ledgers and alerts the owner, once per row, when:
//   * a verification has no ledger entry naming it and its body hash, or
//   * an agent-path verification names no run the runner logged (the runner
//     appends "<run id> <start>" to <ticket-context state>/runs.log when a run
//     starts work; a session that drove --load and --record-and-reply by hand
//     with a key of its own has no such run), or
//   * the same reply text was verified for SHARED_TICKETS or more tickets (the
//     09-02 and 09-25 batches were one text sent to 11 and 8 tickets; two
//     tickets can share a short acknowledgement).
// Ids are shown as 8-character prefixes; no reply text is read or sent.
//
//   TICKET_DATABASE_TOKEN=... node scripts/ticket-fix/reconcile.mjs --state DIR --ledger DIR [--ledger DIR] [--runs FILE] [--notify PATH]
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOnly, managementQuery, databaseToken, readPrivateJSON, ensurePrivateDir } from './reply.mjs';
import { raise, writeStatus } from './alert.mjs';
import { isMain } from './is-main.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const RECONCILE_DAYS = 14;
export const SHARED_TICKETS = 3;
export const reconcileSQL = (days = RECONCILE_DAYS) => readOnly(`SELECT v.id, v.ticket_id, v.body_sha256, v.report->>'path' AS path, v.report->>'run_id' AS run_id, v.created_at
  FROM support_reply_verifications v WHERE v.created_at > now() - interval '${Number(days)} days' ORDER BY v.created_at, v.id LIMIT 1000`);

async function ledgerNames(ledgers, row) {
  for (const directory of ledgers) {
    let found;
    try { found = await readPrivateJSON(path.join(directory, row.ticket_id, `${row.id}.json`), 4 * 1024 * 1024); } catch { found = null; }
    if (found?.value?.verification_id === row.id && found.value.body_sha256 === row.body_sha256) return true;
  }
  return false;
}
// One alert per finding: a marker file keyed by what was found.
async function firstTime(state, name) {
  const markers = path.join(state, 'alerts');
  await ensurePrivateDir(markers);
  try { await fs.writeFile(path.join(markers, name), '', { mode: 0o600, flag: 'wx' }); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

async function loggedRuns(file) {
  if (!file) return null;
  let raw = '';
  try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return new Set(raw.split('\n').map(line => line.split(' ')[0]).filter(id => /^[0-9a-f]{16}$/.test(id)));
}

export async function reconcile({ query, state, ledgers, runsLog = null, notify = null, send = null, now = Date.now() }) {
  if (!ledgers.length || ledgers.some(d => !path.isAbsolute(d)) || (runsLog && !path.isAbsolute(runsLog))) throw Error('--ledger and --runs must be absolute paths');
  const runs = await loggedRuns(runsLog);
  const rows = await query(reconcileSQL());
  if (!Array.isArray(rows) || rows.some(r => !UUID.test(r.id || '') || !UUID.test(r.ticket_id || '') || !/^[0-9a-f]{64}$/.test(r.body_sha256 || ''))) throw Error('Unusable verification rows');
  const unledgered = [], shared = [], unlogged = [];
  for (const row of rows) if (!(await ledgerNames(ledgers, row))) unledgered.push(row);
  if (runs) for (const row of rows) if (row.path === 'agent' && !unledgered.includes(row) && !runs.has(row.run_id)) unlogged.push(row);
  const byBody = new Map();
  for (const row of rows) byBody.set(row.body_sha256, [...(byBody.get(row.body_sha256) || []), row]);
  for (const [sha, group] of byBody) if (new Set(group.map(r => r.ticket_id)).size >= SHARED_TICKETS) shared.push({ sha, group });
  let alerts = 0;
  for (const row of unledgered) {
    if (!(await firstTime(state, `verification-${row.id}`))) continue;
    const detail = `verification=${row.id.slice(0, 8)} ticket=${row.ticket_id.slice(0, 8)} path=${String(row.path || 'none').replace(/[^a-z-]/g, '').slice(0, 20)}`;
    await raise(state, 'unledgered_reply', detail,
      `CredentialDOMD ticket agent: a stored support reply (verification ${row.id.slice(0, 8)}, ticket ${row.ticket_id.slice(0, 8)}) has no record from post-reply.mjs or the hourly runner. It may have been written around the reply checks; review it.`,
      { notify, now, send });
    alerts++;
  }
  for (const row of unlogged) {
    if (!(await firstTime(state, `verification-${row.id}`))) continue;
    await raise(state, 'unlogged_agent_reply', `verification=${row.id.slice(0, 8)} ticket=${row.ticket_id.slice(0, 8)}`,
      `CredentialDOMD ticket agent: a stored support reply (verification ${row.id.slice(0, 8)}, ticket ${row.ticket_id.slice(0, 8)}) says it came from the hourly runner, but no logged run made it. It may have been written by hand; review it.`,
      { notify, now, send });
    alerts++;
  }
  for (const { sha, group } of shared) {
    if (!(await firstTime(state, `shared-body-${sha.slice(0, 16)}`))) continue;
    const tickets = [...new Set(group.map(r => r.ticket_id))].map(id => id.slice(0, 8));
    await raise(state, 'shared_reply_text', `body=${sha.slice(0, 12)} tickets=${tickets.join(',')}`,
      `CredentialDOMD ticket agent: the same support reply text was stored on ${tickets.length} tickets (${tickets.join(', ')}). Batch replies are not allowed; review them.`,
      { notify, now, send });
    alerts++;
  }
  await writeStatus(state, { now });
  return { checked: rows.length, unledgered: unledgered.length, unlogged: unlogged.length, shared: shared.length, alerts };
}

function parse(argv) {
  const options = { ledger: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!/^--(state|ledger|runs|notify)$/.test(key) || value === undefined) throw Error('Usage: reconcile.mjs --state DIR --ledger DIR [--ledger DIR] [--runs FILE] [--notify PATH]');
    if (key === '--ledger') options.ledger.push(value);
    else if (key.slice(2) in options) throw Error(`${key} given twice`);
    else options[key.slice(2)] = value;
  }
  if (!options.state || !path.isAbsolute(options.state)) throw Error('--state must be an absolute path');
  return options;
}
if (isMain(import.meta.url)) {
  (async () => {
    const options = parse(process.argv.slice(2));
    const result = await reconcile({ query: managementQuery(databaseToken()), state: options.state, ledgers: options.ledger, runsLog: options.runs ?? null, notify: options.notify ?? null });
    console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} reconcile: ${result.checked} verifications, ${result.unledgered} without a ledger entry, ${result.unlogged} agent replies from no logged run, ${result.shared} shared texts, ${result.alerts} new alerts`);
  })().catch(error => { console.error(`ERROR: reconcile: ${error.message}`); process.exitCode = 1; });
}
