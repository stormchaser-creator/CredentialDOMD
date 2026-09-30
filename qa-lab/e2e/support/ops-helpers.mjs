// Helpers for the operations journeys (ops*.spec.mjs): the lab's scheduled
// jobs run as pg_cron would run them, the requests they hand to pg_net and the
// answers the edge functions gave, direct calls to the local functions as the
// database, a provider or an unauthenticated stranger would make them, the
// lab's storage files, and the host scripts' own offline harnesses.
//
// Everything here talks to this machine only (the local stack through
// qa-lab/lib/local-db.mjs, the local gateway, a local docker container,
// subprocesses). Nothing reads or writes production.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { localExec, supabaseStatus } from '../../lib/local-db.mjs';
import { GENERATED_DIR, REPO_ROOT } from '../../lib/paths.mjs';
import { dismissInterruptions, landing, lab, lit, newMember, profileOf, row, rows, signIn, sleep, waitFor, waitForMemberApp } from './lab.mjs';

export { REPO_ROOT };

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(String(s))) throw new Error(`refusing identifier ${s}`);
  return s;
};

/** Every pg_cron job the lab created (inactive), with the role it runs as. */
export function cronJobs() {
  return rows('select jobid, jobname, schedule, active, username, command from cron.job order by jobname');
}

/**
 * Runs one cron job's command in its own transaction, as pg_cron does: as the
 * job's role, the command verbatim (wrapped only to print its result). Returns
 * the result, and every request the command queued for pg_net in that
 * transaction (url, body, timeout). With commit: false the transaction is
 * rolled back, so nothing is sent: that shows exactly what the job WOULD
 * dispatch right now without disturbing anyone else's rows.
 */
export function runCronJob(jobname, { commit = true } = {}) {
  const job = row(`select jobname, username, command from cron.job where jobname = ${lit(jobname)}`);
  if (!job) throw new Error(`no cron job ${jobname}`);
  const command = job.command.trim().replace(/;\s*$/, '');
  if (!/^select\s/i.test(command) || command.includes(';')) throw new Error(`unexpected cron command shape: ${command}`);
  const sql = [
    'begin',
    `set local role ${ident(job.username)}`,
    `select 'RESULT:' || coalesce((${command})::text, '')`,
    'reset role',
    `select 'REQS:' || coalesce(json_agg(json_build_object('id', q.id, 'method', q.method, 'url', q.url, 'body', convert_from(q.body, 'utf8'), 'timeout', q.timeout_milliseconds, 'hookSecret', q.headers ? 'x-hook-secret') order by q.id)::text, '[]') from net.http_request_queue q where q.xmin = pg_current_xact_id()::xid`,
    commit ? 'commit' : 'rollback',
  ].join(';\n') + ';';
  let out;
  try { out = localExec(sql); } catch (e) { return { job, ok: false, error: String(e.message || e).slice(0, 600), result: null, requests: [] }; }
  const line = (p) => out.split('\n').find((l) => l.startsWith(p));
  const requests = JSON.parse((line('REQS:') || 'REQS:[]').slice(5)).map((r) => ({ ...r, body: safeJson(r.body) }));
  return { job, ok: true, result: (line('RESULT:') || 'RESULT:').slice(7), requests, committed: commit };
}

const safeJson = (t) => { try { return JSON.parse(t); } catch { return t; } };

/** pg_net's record of each request's answer (waits until every one has answered, or the timeout). */
export async function netResponses(ids, { timeoutMs = 150000 } = {}) {
  if (!ids.length) return [];
  const list = ids.map((i) => Number(i)).filter(Number.isFinite).join(',');
  const read = () => rows(`select id, status_code, timed_out, error_msg, left(coalesce(content, ''), 400) as content from net._http_response where id in (${list}) order by id`);
  try {
    return await waitFor('pg_net answers', () => { const r = read(); return r.length === ids.length ? r : null; }, { timeoutMs, intervalMs: 1000 });
  } catch { return read(); }
}

/** The lab vault's hook secret (lab-generated; what the lab's triggers and dispatchers send). Never printed. */
export function labHookSecret() {
  const r = row("select decrypted_secret as s from vault.decrypted_secrets where name = 'welcome_hook_secret'");
  if (!r?.s) throw new Error('the lab vault has no welcome_hook_secret');
  return r.s;
}

/** The local gateway's functions URL, as pg_net and the providers reach it (not the browser's proxy). */
export function functionsUrl(name) { return `${lab().urls.api}/functions/v1/${name}`; }

/** One call to a local edge function. body: object (JSON) | string | undefined. */
export async function callFunction(name, { method = 'POST', headers = {}, body, timeoutMs = 60000, pathSuffix = '' } = {}) {
  const h = { ...headers };
  let payload = body;
  if (body !== undefined && typeof body !== 'string') { payload = JSON.stringify(body); h['Content-Type'] ||= 'application/json'; }
  const started = Date.now();
  try {
    const r = await fetch(`${functionsUrl(name)}${pathSuffix}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    return { status: r.status, text: text.slice(0, 2000), data: safeJson(text), ms: Date.now() - started };
  } catch (e) {
    return { status: 0, text: String(e.message || e), data: null, ms: Date.now() - started };
  }
}

/** The local stack's anon and service-role keys (lab-generated). */
export function stackKeys() {
  const s = supabaseStatus();
  if (!s?.ANON_KEY || !s?.SERVICE_ROLE_KEY) throw new Error('the local stack is not running');
  return { anon: s.ANON_KEY, service: s.SERVICE_ROLE_KEY };
}

/** Uploads a file to a lab Storage bucket as the service role (a fixture object). */
export async function uploadObject(bucket, name, buffer, contentType = 'application/octet-stream') {
  const { service } = stackKeys();
  const r = await fetch(`${lab().urls.api}/storage/v1/object/${bucket}/${name.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: { Authorization: `Bearer ${service}`, apikey: service, 'Content-Type': contentType, 'x-upsert': 'true' }, body: buffer,
  });
  if (!r.ok) throw new Error(`upload ${bucket}/${name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/**
 * Whether an object's bytes are still on the lab Storage backend's disk (the
 * file backend keeps <bucket>/<name>/<version> under /mnt/stub/stub). This is
 * what a metadata-only delete from storage.objects leaves behind.
 */
export function objectBytesOnDisk(bucket, name) {
  if (!/^[a-z0-9_-]+$/.test(bucket) || !/^[A-Za-z0-9_./-]+$/.test(name) || name.includes('..')) throw new Error('refusing an odd object path');
  const r = spawnSync('docker', ['exec', 'supabase_storage_credentialdomd-qa-lab', 'sh', '-c', `find "/mnt/stub/stub/${bucket}/${name}" -type f 2>/dev/null | head -5`], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

/** A host command with a hard timeout; stdout and stderr kept short. */
export function hostRun(cmd, args, { cwd = REPO_ROOT, env = {}, timeoutMs = 10 * 60 * 1000, input } = {}) {
  const started = Date.now();
  // Playwright's worker sets FORCE_COLOR; a child's summary lines would start with colour codes.
  const base = { ...process.env };
  delete base.FORCE_COLOR;
  const r = spawnSync(cmd, args, { cwd, env: { ...base, NO_COLOR: '1', LC_ALL: 'C', PYTHONDONTWRITEBYTECODE: '1', ...env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, input });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', ms: Date.now() - started, error: r.error ? String(r.error.message) : null };
}

/** The summary lines of a `node --test` run (tests, pass, fail, skipped). */
export function nodeTestSummary(raw) {
  const output = String(raw).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');   // ANSI colours
  const n = (k) => Number((new RegExp(`^[ℹ#] ${k} (\\d+)`, 'm').exec(output) || [])[1] ?? NaN);
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped'), cancelled: n('cancelled') };
}

/** A repository file's text. */
export function repoFile(rel) { return readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }

/** Ages rows of a LOCAL lab table (fixture setup only): created_at = now() - interval. */
export function ageRows(table, where, interval, column = 'created_at') {
  return localExec(`update public.${ident(table)} set ${ident(column)} = now() - interval ${lit(interval)} where ${where}`);
}

/** Row counts of a LOCAL lab table matching a condition. */
export function countWhere(table, where = 'true') {
  return Number(row(`select count(*)::int as n from public.${ident(table)} where ${where}`).n);
}

export { sleep };

/**
 * A paid member these operations journeys share (kept in .generated/ops/member-<key>.json for
 * six hours), so journeys whose subject is not the membership itself do not each take one of
 * the lab's 96 founding places, which parallel runs exhaust. A journey whose checks depend on a
 * fresh account (a new signup in a time window, a clean AI budget) uses newMember instead.
 */
export async function sharedMember(page, key, opts = {}) {
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error('refusing an odd shared member key');
  const dir = path.join(GENERATED_DIR, 'ops');
  const file = path.join(dir, `member-${key}.json`);
  let saved = null;
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { saved = null; }
  const profile = saved?.user?.id ? profileOf(saved.user.id) : null;
  if (saved && profile && profile.access_status === 'active' && !profile.deleted_at && Date.now() - saved.at < 6 * 3600e3) {
    await signIn(page, saved.user);
    if ((await landing(page)) === 'member') {
      await waitForMemberApp(page);
      await dismissInterruptions(page);
      return { user: saved.user, profile, reused: true };
    }
  }
  const m = await newMember(page, opts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ user: { id: m.user.id, email: m.user.email, firstName: m.user.firstName, lastName: m.user.lastName }, at: Date.now() }), { mode: 0o600 });
  return { ...m, reused: false };
}
