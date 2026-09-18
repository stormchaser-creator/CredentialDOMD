#!/usr/bin/env node
// Staged replacement: never invoked by the legacy scheduler until explicitly installed.
// Only this trusted broker has database access. The model runs in a disposable container.
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = 'hkpnnsjcwprrwobmpqyy';
export const APPROVED = '(public.is_admin(t.user_id) OR t.agent_approved_at IS NOT NULL)';
export const AWAITING = `t.archived_at IS NULL AND t.status IN ('open', 'in_progress', 'resolved')
  AND (t.agent_last_reply_at IS NULL OR EXISTS (
    SELECT 1 FROM support_messages m WHERE m.ticket_id = t.id
      AND m.created_at > t.agent_last_reply_at AND m.body NOT ILIKE 'Status set to%'))`;
export const QUEUE_SQL = `SELECT t.id, t.subject, t.body, t.category, t.updated_at,
  public.is_admin(t.user_id) AS from_admin,
  coalesce((SELECT json_agg(recent ORDER BY recent.created_at) FROM (
    SELECT left(m.body, 8000) AS body, m.created_at, m.is_admin_reply
    FROM support_messages m WHERE m.ticket_id = t.id
    ORDER BY m.created_at DESC LIMIT 20) recent), '[]'::json) AS thread
  FROM support_tickets t WHERE ${AWAITING} AND ${APPROVED}
  ORDER BY t.created_at LIMIT 2`;
const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { reply: { type: 'string', minLength: 1, maxLength: 4000 },
    summary: { type: 'string', minLength: 1, maxLength: 4000 },
    needs_owner_review: { type: 'boolean' } },
  required: ['reply', 'summary', 'needs_owner_review'],
};
const SETTINGS = {
  permissions: {
    defaultMode: 'dontAsk', disableBypassPermissionsMode: 'disable',
    blockReadsOutsideWorkingDirectories: true,
    allow: ['Read(/src/**)', 'Read(/package.json)', 'Edit(/src/**)'],
    deny: ['Bash', 'Write', 'WebFetch', 'WebSearch', 'Agent', 'NotebookEdit', 'mcp__*',
      'Read(//proc/**)', 'Read(//sys/**)', 'Read(//dev/**)', 'Read(//**/.env*)',
      'Read(//**/.git/**)', 'Edit(/package.json)', 'Edit(/.claude/**)'],
  },
  disableAllHooks: true,
};

export function validateConfig(c) {
  if (!c || typeof c !== 'object') throw Error('Missing isolated runner configuration');
  for (const key of ['repository', 'stateDirectory', 'dockerBinary', 'claudeBinary']) {
    if (typeof c[key] !== 'string' || !path.isAbsolute(c[key]) || c[key].includes('\n')) {
      throw Error(`Configuration ${key} must be an absolute path`);
    }
  }
  if (!/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(c.image || '')) throw Error('A reviewed image digest is required');
  if (c.anthropicKeychainService !== 'CredentialDOMD Ticket Worker API') {
    throw Error('Use the dedicated ticket-worker Keychain service; no shared-key fallback');
  }
  if (c.providerProjectBudgetConfirmed !== true) throw Error('A dedicated provider project spending limit must be confirmed');
  for (const [key, limit] of [['maxCallBudgetUsd', 5], ['maxDailyReservationUsd', 50]]) {
    if (!Number.isFinite(c[key]) || c[key] <= 0 || c[key] > limit) throw Error(`Invalid ${key}`);
  }
  if (c.maxDailyReservationUsd < c.maxCallBudgetUsd) throw Error('Daily reservation must cover one call');
  if (!Number.isInteger(c.timeoutSeconds) || c.timeoutSeconds < 30 || c.timeoutSeconds > 1200) throw Error('Invalid timeout');
  if (typeof c.sendReplies !== 'boolean') throw Error('sendReplies must be explicit');
  return c;
}

export function safeSourcePath(p) {
  return typeof p === 'string' && !p.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.')) &&
    /^[\w@() ./-]+$/.test(p) && (p === 'package.json' ||
      (p.startsWith('src/') && /\.(?:js|jsx|ts|tsx|css|json|md|svg)$/.test(p)));
}
function command(binary, args, options = {}) {
  const r = spawnSync(binary, args, { encoding: 'utf8', timeout: 30000,
    maxBuffer: 4 * 1024 * 1024, ...options });
  // Never put process output in exceptions: credentials and ticket contents can occur there.
  if (r.error || r.status !== 0) throw Error(`Trusted subprocess failed (${path.basename(binary)}, status ${r.status ?? 'unknown'})`);
  return r.stdout;
}
function secret(service, label = false) {
  return command('/usr/bin/security', ['find-generic-password', label ? '-l' : '-s', service, '-w']).trim();
}
function sqlText(s) {
  return `convert_from(decode('${Buffer.from(s, 'utf8').toString('hex')}', 'hex'), 'UTF8')`;
}
export function replySQL(ticket, reply) {
  if (!/^[a-f0-9-]{36}$/.test(ticket.id)) throw Error('Invalid ticket id');
  if (typeof ticket.updated_at !== 'string' || !Number.isFinite(Date.parse(ticket.updated_at))) throw Error('Invalid ticket version');
  if (typeof reply !== 'string' || !reply.trim() || reply.length > 4000 || reply.includes('\0')) throw Error('Invalid reply');
  // The row lock + version comparison prevents stale answers from stamping over a newer
  // message or withdrawn approval. Statements are sequential inside one transaction:
  // support_messages has an AFTER INSERT trigger that also updates the ticket row.
  // A data-modifying CTE that updates that same row again is unsafe here.
  const messageId = randomUUID();
  return `DO $ticket_broker$
  DECLARE target record;
  BEGIN
    SELECT t.id, t.user_id INTO target FROM support_tickets t WHERE t.id = '${ticket.id}'::uuid
      AND t.updated_at = ${sqlText(ticket.updated_at)}::timestamptz
      AND ${AWAITING} AND ${APPROVED} FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    INSERT INTO support_messages (id, ticket_id, author_id, body, is_admin_reply, created_at)
      VALUES ('${messageId}'::uuid, target.id, target.user_id, ${sqlText(reply)}, true, now());
    UPDATE support_tickets SET status = 'open', updated_at = now(), agent_last_reply_at = now()
      WHERE id = target.id;
  END $ticket_broker$;
  SELECT id FROM support_messages WHERE id = '${messageId}'::uuid`;

}
export function validateResult(result) {
  const out = result?.structured_output;
  if (result?.is_error || !out || Object.keys(out).sort().join(',') !== 'needs_owner_review,reply,summary') throw Error('Unusable model result');
  for (const name of ['reply', 'summary']) {
    if (typeof out[name] !== 'string' || !out[name].trim() || out[name].length > 4000 || out[name].includes('\0')) throw Error('Invalid model response');
  }
  if (typeof out.needs_owner_review !== 'boolean') throw Error('Invalid review flag');
  return out;
}
export function reserveBudget(ledger, day, amount, limit) {
  if (!ledger || ledger.version !== 1 || !ledger.reservations || typeof ledger.reservations !== 'object' || Array.isArray(ledger.reservations)) throw Error('Invalid budget ledger');
  for (const value of Object.values(ledger.reservations)) if (!Number.isFinite(value) || value < 0) throw Error('Invalid budget ledger value');
  const used = ledger.reservations[day] || 0;
  if (used + amount > limit + 1e-9) throw Error('Daily ticket-worker budget reached');
  return { ...ledger, reservations: { ...ledger.reservations, [day]: used + amount } };
}
export function containerArgs(c, workspace, name, prompt) {
  return ['run', '--name', name, '--pull=never', '--init', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
    '--memory=1g', '--cpus=1', '--network=bridge',
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
    '--mount', `type=bind,src=${workspace},dst=/work`, '--workdir', '/work',
    '--env', 'ANTHROPIC_API_KEY', '--env', 'HOME=/tmp/worker-home',
    '--env', 'CLAUDE_CONFIG_DIR=/tmp/worker-config', '--env', 'DISABLE_TELEMETRY=1',
    '--env', 'DISABLE_ERROR_REPORTING=1', '--entrypoint', c.claudeBinary, c.image,
    '--bare', '--print', '--model', 'claude-sonnet-5', '--permission-mode', 'dontAsk',
    '--tools', 'Read,Glob,Grep,Edit', '--allowedTools', 'Read(/src/**)', 'Read(/package.json)', 'Edit(/src/**)',
    '--settings', JSON.stringify(SETTINGS), '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
    '--max-budget-usd', String(c.maxCallBudgetUsd), '--output-format', 'json',
    '--json-schema', JSON.stringify(SCHEMA), '--system-prompt', prompt];
}
async function dbQuery(token, query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`Ticket database request failed (${response.status})`);
  const raw = await response.text();
  if (raw.length > 1024 * 1024) throw Error('Ticket database response too large');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw Error('Ticket database returned no usable rows');
  return data;
}
async function writePrivate(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, filename);
}
async function snapshot(repository, workspace) {
  const sha = command('/usr/bin/git', ['-C', repository, 'rev-parse', '--verify', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Invalid source revision');
  const listing = command('/usr/bin/git', ['-C', repository, 'ls-tree', '-r', '-z', sha, '--', 'src', 'package.json']);
  let total = 0;
  for (const record of listing.split('\0').filter(Boolean)) {
    const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(record);
    if (!match || match[1] !== '100644' || !safeSourcePath(match[3])) continue;
    const content = command('/usr/bin/git', ['-C', repository, 'cat-file', 'blob', match[2]]);
    if (Buffer.byteLength(content) > 512 * 1024) continue;
    total += Buffer.byteLength(content);
    if (total > 20 * 1024 * 1024) throw Error('Source snapshot exceeds the allowed size');
    const target = path.join(workspace, match[3]);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, content, { mode: 0o600 });
  }
  return sha;
}
export async function main(argv = process.argv.slice(2)) {
  const [mode, configFile] = argv;
  if (!['--check', '--run'].includes(mode) || !configFile || argv.length !== 2) throw Error('Usage: ticket-agent-isolated.mjs --check|--run CONFIG.json');
  const c = validateConfig(JSON.parse(await fs.readFile(configFile, 'utf8')));
  if (process.getuid() === 0) throw Error('Run the broker as the owner, never root');
  if (c.stateDirectory === c.repository || c.stateDirectory.startsWith(`${c.repository}/`)) throw Error('Worker state must be outside the repository');
  await fs.mkdir(c.stateDirectory, { recursive: true, mode: 0o700 });
  const state = await fs.lstat(c.stateDirectory);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid() || (state.mode & 0o077)) throw Error('State directory must be owner-only');
  // This lookup never pulls or starts a container, and never reads a credential.
  command(c.dockerBinary, ['image', 'inspect', '--format', '{{.Id}}', c.image]);
  if (mode === '--check') { console.log('Configuration and pinned local image present. Credential, live canary and deployment checks still required.'); return; }
  // Same lock as the existing job: a canary/replacement must not double-reply with it.
  const lock = '/tmp/credentialdomd-ticket-agent.lock';
  try { await fs.mkdir(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') { console.log('SKIP: ticket worker already running'); return; } throw e; }
  let containerName;
  try {
    const databaseToken = secret('Supabase CLI', true);
    const tickets = await dbQuery(databaseToken, QUEUE_SQL);
    if (!tickets.length) { console.log('idle: no approved actionable tickets'); return; }
    const apiKey = secret(c.anthropicKeychainService);
    if (!apiKey) throw Error('Dedicated ticket-worker key missing');
    const ledgerFile = path.join(c.stateDirectory, 'budget.json');
    let ledger;
    try { ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; ledger = { version: 1, reservations: {} }; }
    const prompt = await fs.readFile(path.join(HERE, 'ticket-agent-isolated-prompt.md'), 'utf8');
    for (const ticket of tickets) {
      // A per-ticket process prevents one reporter's data entering another's context.
      if (!/^[a-f0-9-]{36}$/.test(ticket.id) || typeof ticket.from_admin !== 'boolean' || !Array.isArray(ticket.thread)) throw Error('Malformed ticket queue');
      const day = new Date().toISOString().slice(0, 10);
      ledger = reserveBudget(ledger, day, c.maxCallBudgetUsd, c.maxDailyReservationUsd);
      // Reserve before launch. No refund after crashes, unknown provider outcomes, or retries.
      await writePrivate(ledgerFile, JSON.stringify(ledger, null, 2));
      const runDirectory = await fs.mkdtemp(path.join(c.stateDirectory, 'run-'));
      const workspace = path.join(runDirectory, 'work');
      await fs.mkdir(workspace, { mode: 0o700 });
      const sha = await snapshot(c.repository, workspace);
      await fs.cp(workspace, path.join(runDirectory, 'baseline'), { recursive: true });
      containerName = `credentialdomd-ticket-${randomUUID()}`;
      const input = JSON.stringify({ ticket: { ...ticket, body: String(ticket.body ?? '').slice(0, 24000), subject: String(ticket.subject ?? '').slice(0, 500) } });
      const output = command(c.dockerBinary, containerArgs(c, workspace, containerName, prompt), {
        input, timeout: c.timeoutSeconds * 1000,
        env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: os.homedir(), ANTHROPIC_API_KEY: apiKey },
      });
      command(c.dockerBinary, ['rm', '-f', containerName]); containerName = undefined;
      const result = validateResult(JSON.parse(output));
      // Never execute model-produced code. These source files are review artifacts only.
      await writePrivate(path.join(runDirectory, 'review.json'), JSON.stringify({ ticketId: ticket.id, sourceRevision: sha, ...result }, null, 2));
      if (c.sendReplies) {
        const posted = await dbQuery(databaseToken, replySQL(ticket, result.reply));
        console.log(posted.length === 1 ? 'Reply posted; ticket left open' : 'Reply withheld: ticket changed or approval was withdrawn');
      } else console.log('Draft prepared; sending is disabled');
      console.log(`Review artifacts: ${runDirectory}`);
    }
  } finally {
    if (containerName) {
      try { command(c.dockerBinary, ['rm', '-f', containerName]); } catch { console.error('ERROR: container cleanup failed; inspect the isolated runtime'); }
    }
    await fs.rmdir(lock);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
