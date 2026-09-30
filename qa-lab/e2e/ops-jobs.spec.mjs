// Operations journeys, part 1: the scheduled jobs, the daily account deletion,
// the hook secret that authenticates the database's calls to the functions,
// and the deployed functions nothing calls.
//
// The lab creates production's pg_cron jobs INACTIVE (production runs them on
// its schedule; the lab must not fire them under other journeys). Here each
// job's command is run as pg_cron runs it: the command verbatim, as the job's
// role, in its own transaction (support/ops-helpers.mjs runCronJob), and the
// requests it handed to pg_net are followed to the edge function's answer in
// net._http_response, which is the only place a dispatch job's real outcome is
// recorded (cron's own "succeeded" means only that the SQL ran).
//
// Shared-lab safety: a job whose effect reaches every account (the monthly
// backup emails every member, the deletion job wipes accounts) is run with its
// transaction rolled back, which shows exactly what it would dispatch without
// sending anything, and its request is then sent for this journey's own
// fixture only, byte for byte as the job builds it. Jobs that only prune aged
// rows, or send what production sends every ten minutes anyway, run for real.
import { test } from './support/fixtures.mjs';
import {
  createPhysician, emailBody, emails, field, labExec, letters, lit, makeAdmin, newMember, openCredentials, profileOf, row, rows, sleep, stamp,
  tokenFor, waitFor, waitForMemberApp, lab, LAB_EMAIL_DOMAIN, landing,
} from './support/lab.mjs';
import {
  callFunction, countWhere, cronJobs, labHookSecret, netResponses, objectBytesOnDisk, repoFile, runCronJob, uploadObject, REPO_ROOT,
} from './support/ops-helpers.mjs';
import { deployedFunctions, verifyJwtFunctions, browserCalledFunctions } from '../cors-check.mjs';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { hostRun } from './support/ops-helpers.mjs';

/** Lines of the repository matching a pattern (git grep, tracked files only). */
function hostGrep(pattern, dir) {
  const r = hostRun('git', ['grep', '-n', '-E', pattern, '--', dir], { timeoutMs: 30000 });
  return r.stdout.split('\n').filter(Boolean);
}
import path from 'node:path';

const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const ok2xx = (r) => r && r.status_code >= 200 && r.status_code < 300 && !r.timed_out;
const brief = (r) => (r ? `${r.status_code ?? '-'}${r.timed_out ? ' timed out' : ''}${r.error_msg ? ` ${r.error_msg}` : ''} ${String(r.content || '').slice(0, 160)}` : 'no answer');

/** Sends one request exactly as a dispatch job builds it (its url, the vault secret, its timeout), for one body. Returns the pg_net id. */
function sendAsJob(url, body, timeoutMs) {
  const out = labExec(`select net.http_post(url := ${lit(url)}, headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'welcome_hook_secret')), body := ${lit(JSON.stringify(body))}::jsonb${timeoutMs ? `, timeout_milliseconds := ${Number(timeoutMs)}` : ''})`);
  return Number(out.split('\n').filter(Boolean).at(-1));
}

const CHECKLIST_JOBS = ['send-reminders-daily', 'monthly-backup', 'prune-backups', 'delete-cancelled-accounts', 'send-guide-sweep', 'credential-portal-prune',
  'prune-ai-reservations', 'prune-ai-usage', 'prune-assistant-log', 'prune-client-errors', 'prune-page-visits'];

test('scheduled jobs: each command runs as pg_cron would, the functions it calls answer 2xx, and each prune keeps only what it should', {
  tag: ['@OPS-001'],
}, async ({ page, qa }) => {
  test.setTimeout(12 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Casey', lastName: `Cron ${letters()}` });
  const pid = profile.id;
  const tag = stamp('ops').replace(/-/g, '');

  await qa.feature('OPS-001', 'the jobs exist with one-function commands and valid schedules (inactive in the lab by design)', async () => {
    const jobs = cronJobs();
    const names = jobs.map((j) => j.jobname);
    qa.check('every job the checklist names exists', CHECKLIST_JOBS.every((n) => names.includes(n)), `missing: ${CHECKLIST_JOBS.filter((n) => !names.includes(n)).join(', ') || 'none'}`);
    qa.check('the jobs added since the checklist are there too (retry-ticket-reply-emails, welcome-email-sweep)', names.includes('retry-ticket-reply-emails') && names.includes('welcome-email-sweep'), names.join(', '));
    qa.check('every command is a single "select public.<function>()" (no inline SQL, no literal secret)', jobs.every((j) => /^\s*select\s+public\.[a-z_]+\(\)\s*;?\s*$/i.test(j.command)), jobs.map((j) => `${j.jobname}: ${j.command.trim()}`).join(' | '));
    qa.check('every schedule is a 5-field cron expression', jobs.every((j) => j.schedule.trim().split(/\s+/).length === 5), jobs.map((j) => `${j.jobname} ${j.schedule}`).join(' | '));
    qa.check('the lab keeps every job inactive (the lab design: run by hand, never under other journeys)', jobs.every((j) => j.active === false));
    qa.blocked('OPS-001', 'Run history (7 runs in 7 days per daily job, failed runs, the 5-of-7 prune-ai-reservations count) lives in production\'s cron.job_run_details and net._http_response; the lab\'s jobs are inactive by design and the lab may read only production\'s catalog.');
  }, { soft: true });

  await qa.feature('OPS-001', 'prune jobs: aged rows go, fresh rows stay', async () => {
    const old = (t) => `qaold${t}${tag}`;
    const fresh = (t) => `qanew${t}${tag}`;
    labExec(`
      insert into public.ai_reservations (user_id, scope, created_at) values ('${pid}', '${old('r')}', now() - interval '4 days'), ('${pid}', '${fresh('r')}', now() - interval '1 hour');
      insert into public.ai_usage (user_id, path, ok, status, provider, created_at) values ('${pid}', '${old('u')}', true, 200, 'gemini', now() - interval '91 days'), ('${pid}', '${fresh('u')}', true, 200, 'gemini', now() - interval '1 day');
      insert into public.assistant_log (user_id, kind, question, created_at) values ('${pid}', '${old('a')}', 'synthetic', now() - interval '13 months'), ('${pid}', '${fresh('a')}', 'synthetic', now() - interval '1 day');
      insert into public.client_errors (kind, message, build, created_at) values ('error', '${old('e')}', 'qa-lab', now() - interval '8 days'), ('error', '${fresh('e')}', 'qa-lab', now() - interval '1 hour');
      insert into public.page_visits (path, created_at) values ('/${old('p')}', now() - interval '14 months'), ('/${fresh('p')}', now() - interval '1 day');
      insert into public.credential_portal_limits (scope, key, window_start, used) values ('${old('l')}', 'k', now() - interval '3 days', 1), ('${fresh('l')}', 'k', now(), 1);
    `);
    const cases = [
      ['prune-ai-reservations', 'ai_reservations', 'scope'],
      ['prune-ai-usage', 'ai_usage', 'path'],
      ['prune-assistant-log', 'assistant_log', 'kind'],
      ['prune-client-errors', 'client_errors', 'message'],
      ['prune-page-visits', 'page_visits', 'path'],
      ['credential-portal-prune', 'credential_portal_limits', 'scope'],
    ];
    const key = { ai_reservations: 'r', ai_usage: 'u', assistant_log: 'a', client_errors: 'e', page_visits: 'p', credential_portal_limits: 'l' };
    for (const [job, table, col] of cases) {
      const r = runCronJob(job);
      qa.check(`${job}: the command ran (${r.result || 'void'})`, r.ok, r.error || '');
      const k = key[table];
      const pre = table === 'page_visits' ? '/' : '';
      const oldLeft = countWhere(table, `${col} = ${lit(pre + old(k))}`);
      const freshLeft = countWhere(table, `${col} = ${lit(pre + fresh(k))}`);
      qa.check(`${job}: the aged row is gone and the fresh one kept`, oldLeft === 0 && freshLeft === 1, `aged left ${oldLeft}, fresh left ${freshLeft}`);
      qa.check(`${job}: it sends nothing through pg_net`, r.requests.length === 0, JSON.stringify(r.requests).slice(0, 200));
    }
  }, { soft: true });

  await qa.feature('OPS-001', 'prune-backups keeps the 3 newest months and removes the older ZIP, file included', async () => {
    const sub = user.id;
    const periods = ['2026-04', '2026-05', '2026-06', '2026-07'];
    const bytes = Buffer.from(`QA lab synthetic backup ZIP placeholder ${tag}`);
    for (const p of periods) {
      const name = `${sub}/${p}/qa-${tag}.zip`;
      await uploadObject('backups', name, bytes, 'application/zip');
      labExec(`insert into public.backups (user_id, period, storage_path, part, parts, bytes, status, created_at) values ('${pid}', '${p}', ${lit(name)}, 1, 1, ${bytes.length}, 'emailed', now() - interval '1 hour')`);
    }
    const oldest = `${sub}/2026-04/qa-${tag}.zip`;
    qa.check('the oldest ZIP is on the storage disk before the prune', (objectBytesOnDisk('backups', oldest) || []).length > 0);
    const r = runCronJob('prune-backups');
    qa.check(`the command ran (${r.result} row(s) removed)`, r.ok, r.error || '');
    const left = rows(`select period from public.backups where user_id = '${pid}' order by period`).map((x) => x.period);
    qa.check('backups rows: only the 3 newest periods remain', JSON.stringify(left) === JSON.stringify(periods.slice(1)), left.join(', '));
    const meta = countWhere('backups', 'false') + Number(row(`select count(*)::int as n from storage.objects where bucket_id = 'backups' and name = ${lit(oldest)}`).n);
    qa.check('storage.objects no longer lists the oldest ZIP', meta === 0, `${meta} row(s)`);
    const onDisk = objectBytesOnDisk('backups', oldest) || [];
    const bytesGone = onDisk.length === 0;
    qa.check('the oldest ZIP\'s bytes are gone from storage (not only its metadata row)', bytesGone, onDisk.join(', ') || 'gone');
    if (!bytesGone) {
      qa.bug({
        title: 'prune-backups deletes only the storage.objects row; the ZIP file stays in the bucket, invisible and billed',
        step: 'A member with backups for 4 months; run the prune-backups job (select public.prune_old_backups())',
        expected: 'The oldest month\'s backups row and its ZIP file are removed',
        actual: `The backups row and the storage.objects row are deleted, but the file is still on the storage backend (${onDisk[0]}). prune_old_backups() opts in to storage.allow_delete_query and runs "delete from storage.objects" (supabase/migrations/20260902f_prune_backups_delete_guard.sql:21-34, the live body in the lab), which removes only metadata; Storage never deletes the object bytes, and no tool can see them afterwards (the app, delete-account and storage-orphans all read storage.objects). First real prune in production: 2026-11-01 13:30 UTC. Fixed on fix/qa-admin-ops d4343996 (prune-backups edge function removes files through the Storage API).`,
        severity: 'medium',
      });
    }
  }, { soft: true });

  await qa.feature('OPS-001', 'send-reminders-daily: its request reaches send-reminders and a due license is emailed', async () => {
    await openCredentials(page, 'Licenses');
    await page.getByRole('button', { name: 'Add' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'License #').fill(`QA-CRON-${tag.slice(-6)}`);
    await field(dlg, 'State').selectOption('WY');
    await field(dlg, /^Expires/).fill(day(12));
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached' });
    await waitFor('the license in the cloud', async () => countWhere('licenses', `user_id = '${pid}' and license_number = ${lit(`QA-CRON-${tag.slice(-6)}`)}`) === 1, { timeoutMs: 30000 });
    const r = runCronJob('send-reminders-daily');
    qa.check('the command ran and queued one request to send-reminders with the hook secret', r.ok && r.requests.length === 1 && /\/functions\/v1\/send-reminders$/.test(r.requests[0].url) && r.requests[0].hookSecret, JSON.stringify(r.requests.map((q) => ({ url: q.url, secret: q.hookSecret, timeout: q.timeout }))));
    const [answer] = await netResponses(r.requests.map((q) => q.id));
    qa.check(`send-reminders answered 2xx within the job's pg_net timeout (${r.requests[0]?.timeout} ms)`, ok2xx(answer), brief(answer));
    const mail = await waitFor('the reminder email', async () => (await emails({ to: user.email })).find((m) => /renew|expir|due|reminder/i.test(m.subject)) || null, { timeoutMs: 120000, intervalMs: 2000 }).catch(() => null);
    qa.check('the member got the reminder email', !!mail, mail?.subject || `none within 2 minutes (reminder_emailed_at ${profileOf(user.id)?.reminder_emailed_at})`);
    if (answer?.timed_out) {
      const members = row("select count(*)::int as n from public.profiles where access_status = 'active' and notify_email").n;
      const dry = await callFunction('send-reminders', { body: { dry_run: true }, headers: { 'x-hook-secret': labHookSecret() }, timeoutMs: 120000 });
      qa.bug({
        title: 'send-reminders-daily is dispatched with pg_net\'s 5 s default timeout; at a few hundred members its only record of a successful run is a timeout',
        step: `Run the send-reminders-daily job with ${members} active members who get email reminders`,
        expected: 'net._http_response records send-reminders\' 2xx, the only place the run\'s outcome is kept (cron\'s "succeeded" means only that the SQL ran)',
        actual: `net._http_response: ${brief(answer)}; ${mail ? 'the reminder email still went out' : 'and this member\'s reminder never went out in this run (a separate run where the caller hung up after 1.5 s did reach the last member, so completion after the hang-up is not guaranteed rather than never)'}. A dry run over the same members alone takes ${dry.ms} ms. dispatch_daily_reminders() (supabase/migrations/20260925140000_hook_secret_vault.sql:238-255) calls net.http_post without timeout_milliseconds, and send-reminders reads 8 tables per member one member at a time, so the run outgrows 5 s with the member count; send-guide-sweep and monthly-backup use the same default. delete-cancelled-accounts sets 120 s for exactly this reason.`,
        severity: 'low',
      });
    }
    if (mail) qa.check('it names the license', /QA-CRON|Wyoming|WY/.test(`${(await emailBody(mail.id)).text}`));
  }, { soft: true });

  await qa.feature('OPS-001', 'monthly-backup: what it dispatches, and its request for one member answers 2xx within the job\'s own timeout', async () => {
    const dry = runCronJob('monthly-backup', { commit: false });
    const mine = dry.requests.filter((q) => q.body?.profile_id === pid);
    qa.check(`the command ran (rolled back: it would dispatch ${dry.result} build-backup call(s), one per active opted-in member)`, dry.ok && Number(dry.result) === dry.requests.length, dry.error || '');
    qa.check('this member is in scope once (active, backup_monthly on by default)', mine.length === 1, JSON.stringify(mine).slice(0, 200));
    qa.check('each request carries the hook secret and names build-backup', dry.requests.every((q) => q.hookSecret && /\/functions\/v1\/build-backup$/.test(q.url)));
    const timeout = dry.requests[0]?.timeout;
    const sent = Date.now();
    const id = sendAsJob(dry.requests[0].url, { profile_id: pid }, timeout);
    const [answer] = await netResponses([id], { timeoutMs: 120000 });
    qa.check(`build-backup answered 2xx within the job's pg_net timeout (${timeout} ms)`, ok2xx(answer), brief(answer));
    const backup = await waitFor('the backup row', async () => row(`select status, period, bytes, emailed_at from public.backups where user_id = '${pid}' and created_at > to_timestamp(${sent / 1000}) order by created_at desc limit 1`), { timeoutMs: 120000, intervalMs: 2000 }).catch(() => null);
    qa.check('a backups row for this month, emailed', backup?.status === 'emailed' || !!backup?.emailed_at, JSON.stringify(backup));
    const mail = await waitFor('the backup email', async () => (await emails({ to: user.email })).find((m) => /backup/i.test(m.subject)) || null, { timeoutMs: 60000, intervalMs: 2000 }).catch(() => null);
    qa.check('the member got the backup email', !!mail, mail?.subject || 'none');
    if (!ok2xx(answer) && answer?.timed_out && backup) {
      qa.bug({
        title: 'monthly-backup dispatches build-backup with pg_net\'s 5 s default timeout, so the job\'s only record of a successful backup is a timeout',
        step: 'Run the monthly-backup job\'s request for one member (dispatch_monthly_backups builds it with no timeout_milliseconds)',
        expected: 'net._http_response records build-backup\'s 2xx, as delete-cancelled-accounts does with its 120 s timeout ("the response is what proves the run")',
        actual: `net._http_response: ${brief(answer)}, although build-backup finished and emailed the backup. With every member in one monthly run, the owner cannot tell a failed month from a slow one from the job record. Cause: dispatch_monthly_backups() (supabase/migrations/20260925140000_hook_secret_vault.sql:168-196) calls net.http_post without timeout_milliseconds.`,
        severity: 'low',
      });
    }
  }, { soft: true });

  await qa.feature('OPS-001', 'delete-cancelled-accounts: the request it would send (rolled back; OPS-002 runs the deletion)', async () => {
    const dry = runCronJob('delete-cancelled-accounts', { commit: false });
    qa.check('the command ran (rolled back)', dry.ok, dry.error || '');
    qa.check('each request names delete-account, carries the hook secret, dry_run false, requested_by scheduled, a 120 s timeout', dry.requests.every((q) => /\/functions\/v1\/delete-account$/.test(q.url) && q.hookSecret && q.body?.dry_run === false && q.body?.requested_by === 'scheduled' && q.timeout === 120000), `${dry.requests.length} request(s) ${JSON.stringify(dry.requests.map((q) => q.body)).slice(0, 200)}`);
  }, { soft: true });

  await qa.feature('OPS-001', 'send-guide-sweep: a requested state guide is emailed and stamped', async () => {
    const email = `ops-guide-${tag}@${LAB_EMAIL_DOMAIN}`;
    const res = await fetch(`${lab().urls.appOrigin}/api/waitlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_email: email, p_name: null, p_source: '/states/wyoming', p_note: 'guide-email WY inline', p_stage: 'guide', p_waitlist: false }) });
    qa.check('the guide request was accepted (relay as production\'s worker)', res.ok || res.status === 409, `${res.status}`);
    const r = runCronJob('send-guide-sweep');
    qa.check('the command queued one request to send-guide with the hook secret', r.ok && r.requests.length === 1 && /\/functions\/v1\/send-guide$/.test(r.requests[0].url) && r.requests[0].hookSecret, r.error || '');
    const [answer] = await netResponses(r.requests.map((q) => q.id));
    qa.check('send-guide answered 2xx', ok2xx(answer), brief(answer));
    const mail = await waitFor('the guide email', async () => (await emails({ to: email }))[0] || null, { timeoutMs: 60000, intervalMs: 1500 }).catch(() => null);
    qa.check('the guide email arrived', !!mail, mail?.subject || 'none');
    const lead = row(`select guide_sent_at from public.early_access_leads where lower(email) = ${lit(email)}`);
    qa.check('the lead is stamped guide_sent_at (never sent twice)', !!lead?.guide_sent_at, JSON.stringify(lead));
  }, { soft: true });

  await qa.feature('OPS-001', 'retry-ticket-reply-emails: an owner reply whose email never went out is sent by the retry', async () => {
    const owner = await createPhysician({ firstName: 'Owen', lastName: `Owner ${letters()}` });
    await makeAdmin(owner);
    const ownerProfile = await waitFor('the owner profile', async () => profileOf(owner.id), { timeoutMs: 30000 });
    const ticket = crypto.randomUUID();
    const message = crypto.randomUUID();
    // The reply was stored but its email never left (the trigger's pg_net call lost): stored
    // without firing the reply trigger, and queued for the retry 15 minutes ago.
    labExec(`begin; set local session_replication_role = replica;
      insert into public.support_tickets (id, user_id, subject, body, category, status, created_at) values ('${ticket}', '${pid}', 'QA lab ops retry ${tag}', 'Synthetic ticket for the retry job.', 'other', 'waiting_user', now() - interval '1 hour');
      insert into public.support_messages (id, ticket_id, author_id, body, is_admin_reply, created_at) values ('${message}', '${ticket}', '${ownerProfile.id}', 'Synthetic owner reply ${tag}.', true, now() - interval '20 minutes');
      insert into public.ticket_reply_emails (message_id, queued_at, attempts) values ('${message}', now() - interval '20 minutes', 0);
      commit;`);
    const r = runCronJob('retry-ticket-reply-emails');
    const mine = r.requests.filter((q) => q.body?.record?.id === message);
    qa.check(`the command ran and retried this reply (${r.result} retried in all)`, r.ok && mine.length === 1, r.error || JSON.stringify(r.requests.map((q) => q.body)).slice(0, 200));
    const [answer] = await netResponses(mine.map((q) => q.id));
    qa.check('send-ticket-reply answered 2xx', ok2xx(answer), brief(answer));
    const mail = await waitFor('the reply email', async () => (await emails({ to: user.email })).find((m) => /QA lab ops retry/.test(m.subject) || /reply/i.test(m.subject)) || null, { timeoutMs: 60000, intervalMs: 1500 }).catch(() => null);
    qa.check('the member got the reply email', !!mail, mail?.subject || 'none');
    const stamped = row(`select m.emailed_at, e.attempts from public.support_messages m join public.ticket_reply_emails e on e.message_id = m.id where m.id = '${message}'`);
    qa.check('the message is stamped emailed_at and the attempt counted', !!stamped?.emailed_at && stamped.attempts === 1, JSON.stringify(stamped));
    const again = runCronJob('retry-ticket-reply-emails');
    qa.check('the next run does not retry it again', !again.requests.some((q) => q.body?.record?.id === message));
  }, { soft: true });

  await qa.feature('OPS-001', 'welcome-email-sweep: its request reaches limited-stripe-webhook\'s sweep and answers 2xx', async () => {
    const r = runCronJob('welcome-email-sweep');
    qa.check('the command queued one request to limited-stripe-webhook with the hook secret and a 60 s timeout', r.ok && r.requests.length === 1 && /\/functions\/v1\/limited-stripe-webhook$/.test(r.requests[0].url) && r.requests[0].hookSecret && r.requests[0].timeout === 60000, r.error || '');
    const [answer] = await netResponses(r.requests.map((q) => q.id));
    qa.check('the sweep answered 2xx with counts only', ok2xx(answer) && /"state"/.test(answer?.content || '') && !/@|sub_/.test(answer?.content || ''), brief(answer));
  }, { soft: true });
});

test('cancelled-account deletion: only accounts past their deletion date are wiped; a paying member never is', {
  tag: ['@OPS-002'],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  // E: a paying member with a record.
  const { user: payer, profile: payerProfile } = await newMember(page, { firstName: 'Paige', lastName: `Paying ${letters()}` });
  await openCredentials(page, 'Licenses');
  await page.getByRole('button', { name: 'Add' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add' });
  await field(dlg, 'Type').selectOption('State Medical License');
  await field(dlg, 'License #').fill('QA-KEEP-1');
  await field(dlg, 'State').selectOption('MT');
  await field(dlg, /^Expires/).fill(day(300));
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.waitFor({ state: 'detached' });
  await waitFor('the license in the cloud', async () => countWhere('licenses', `user_id = '${payerProfile.id}'`) === 1, { timeoutMs: 30000 });
  // C: an account that cancelled 8 days ago, deletion date passed yesterday.
  const cancelled = await createPhysician({ firstName: 'Cora', lastName: `Cancelled ${letters()}` });
  const cProfile = await waitFor('C profile', async () => profileOf(cancelled.id), { timeoutMs: 30000 });
  labExec(`update public.profiles set cancelled_at = now() - interval '8 days', data_deletion_date = now() - interval '1 day' where id = '${cProfile.id}'`);
  // D: already wiped after its date.
  const wiped = await createPhysician({ firstName: 'Dana', lastName: `Wiped ${letters()}` });
  const dProfile = await waitFor('D profile', async () => profileOf(wiped.id), { timeoutMs: 30000 });
  labExec(`update public.profiles set data_deletion_date = now() - interval '2 days', deleted_at = now() - interval '1 day' where id = '${dProfile.id}'`);

  const scope = () => {
    const dry = runCronJob('delete-cancelled-accounts', { commit: false });
    if (!dry.ok) throw new Error(dry.error);
    return dry.requests.map((q) => q.body?.profile_id);
  };
  let url = null;

  await qa.feature('OPS-002', 'scope: a cancelled account past its date is in; null, future and already-wiped are out', async () => {
    const dry = runCronJob('delete-cancelled-accounts', { commit: false });
    url = dry.requests[0]?.url || `http://supabase_kong_credentialdomd-qa-lab:8000/functions/v1/delete-account`;
    const ids = dry.requests.map((q) => q.body?.profile_id);
    qa.check('the cancelled account past its deletion date would be dispatched', ids.includes(cProfile.id), `${ids.length} in scope`);
    qa.check('the paying member with no deletion date is not in scope', !ids.includes(payerProfile.id));
    qa.check('an account already wiped after its date is not in scope', !ids.includes(dProfile.id));
    labExec(`update public.profiles set data_deletion_date = now() + interval '5 days' where id = '${payerProfile.id}'`);
    qa.check('the paying member with a FUTURE deletion date is not in scope', !scope().includes(payerProfile.id));
  }, { soft: true });

  await qa.feature('OPS-002', 'a paying member with a stale past deletion date: in scope only if something writes that date (verified: nothing in the product does)', async () => {
    // The risk the checklist names: a wrong data_deletion_date write (a billing webhook,
    // an old client) on an account that is active and paying.
    labExec(`update public.profiles set data_deletion_date = now() - interval '1 hour' where id = '${payerProfile.id}'`);
    const snapshot = row(`select p.access_status, s.status as subscription from public.profiles p left join public.billing_subscriptions s on s.profile_id = p.id where p.id = '${payerProfile.id}' limit 1`);
    const ids = scope();
    const inScope = ids.includes(payerProfile.id);
    qa.check('(observation) the scope with a past date written by hand', true, `access ${snapshot?.access_status}, subscription ${snapshot?.subscription}, in scope: ${inScope}`);
    if (inScope) {
      // Filed as a bug, then verified not to be one (2026-09-30): the date here is written by hand.
      qa.byDesign('OPS-002', `An active, paying member whose data_deletion_date is set in the past by hand is dispatched for deletion: dispatch_account_deletions() (supabase/migrations/20260925140000_hook_secret_vault.sql:215-220) filters only on data_deletion_date and deleted_at`,
        'Verified out of reach in production (2026-09-30): nothing in the product writes a non-null data_deletion_date (its only writers, CancellationPage reactivate and delete-account\'s tombstone, write NULL, and no webhook or job computes it), so no member enters the scope through any product flow. A member who writes their own only schedules deletion of their own account, which Delete All My Data already allows. Defense in depth worth adding: check cancelled_at, access_status and the subscription in the dispatcher.');
    }
    const self = await fetch(`${lab().urls.api}/rest/v1/profiles?id=eq.${payerProfile.id}`, {
      method: 'PATCH', headers: { apikey: (await import('./support/ops-helpers.mjs')).stackKeys().anon, Authorization: `Bearer ${await tokenFor(payer)}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ data_deletion_date: new Date(Date.now() - 3600e3).toISOString() }),
    });
    const written = row(`select data_deletion_date from public.profiles where id = '${payerProfile.id}'`)?.data_deletion_date;
    qa.check('(observation) the member\'s own session may write data_deletion_date', true, `PATCH profiles.data_deletion_date as the member: HTTP ${self.status}, stored ${written}`);
    // Put the member back: nothing below should wipe them by accident.
    labExec(`update public.profiles set data_deletion_date = null where id = '${payerProfile.id}'`);
    qa.check('with the date cleared the member is out of scope again', !scope().includes(payerProfile.id));
  }, { soft: true });

  await qa.feature('OPS-002', 'the job\'s request wipes the cancelled account, writes the audit row, and a second run finds nothing', async () => {
    const id = sendAsJob(url, { profile_id: cProfile.id, dry_run: false, requested_by: 'scheduled' }, 120000);
    const [answer] = await netResponses([id], { timeoutMs: 150000 });
    qa.check('delete-account answered 2xx within the job\'s 120 s timeout', ok2xx(answer), brief(answer));
    const p = row(`select deleted_at, data_deletion_date, cancelled_at, email, name from public.profiles where id = '${cProfile.id}'`);
    qa.check('the profile is a tombstone: deleted_at set, the schedule consumed (date and cancelled_at null)', !!p?.deleted_at && !p.data_deletion_date && !p.cancelled_at, JSON.stringify({ deleted_at: p?.deleted_at, date: p?.data_deletion_date, cancelled: p?.cancelled_at }));
    const audit = rows(`select requested_by, mode, error from public.account_deletions where profile_id = '${cProfile.id}' order by created_at`);
    qa.check('one account_deletions row: requested_by scheduled, mode delete, no error', audit.some((a) => a.requested_by === 'scheduled' && a.mode === 'delete' && !a.error), JSON.stringify(audit));
    qa.check('the next run does not dispatch it again', !scope().includes(cProfile.id));
    qa.check('the paying member was never touched (record and profile intact)', countWhere('licenses', `user_id = '${payerProfile.id}'`) === 1 && !profileOf(payer.id).deleted_at);
    await page.reload();
    await waitForMemberApp(page);
    qa.check('the paying member still opens the app', (await landing(page)) === 'member');
  }, { soft: true });
});

test('hook secret: every database-called function refuses a missing or wrong secret and a member token, with no side effect', {
  tag: ['@OPS-004'],
}, async ({ qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const member = await createPhysician({ firstName: 'Harper', lastName: `Hook ${letters()}` });
  const target = await createPhysician({ firstName: 'Tess', lastName: `Target ${letters()}` });
  const mProfile = await waitFor('member profile', async () => profileOf(member.id), { timeoutMs: 30000 });
  const tProfile = await waitFor('target profile', async () => profileOf(target.id), { timeoutMs: 30000 });
  qa.check('(setup) both physicians have profiles', !!mProfile && !!tProfile);
  const wrong = { 'x-hook-secret': `qa-wrong-${crypto.randomUUID()}` };
  const memberToken = await tokenFor(member);
  const asMember = { Authorization: `Bearer ${memberToken}` };
  const before = {
    deletions: countWhere('account_deletions', `profile_id = '${tProfile.id}'`),
    backups: countWhere('backups', `user_id = '${tProfile.id}'`),
    mail: (await emails({ to: target.email })).length,
  };

  await qa.feature('OPS-004', 'the seven hook-authenticated functions refuse no secret, a wrong secret and a member\'s token', async () => {
    const probes = [
      ['send-reminders', {}, [401]],
      ['send-guide', {}, [401]],
      ['send-ticket-reply', { record: { id: crypto.randomUUID() } }, [401]],
      ['send-welcome', { record: { email: target.email, id: crypto.randomUUID() } }, [401]],
      ['delete-account', { profile_id: tProfile.id, dry_run: false }, [401]],
      ['build-backup', { profile_id: tProfile.id }, [401]],
    ];
    for (const [name, body, codes] of probes) {
      const none = await callFunction(name, { body });
      const bad = await callFunction(name, { body, headers: wrong });
      qa.check(`${name}: no secret is refused`, codes.includes(none.status), `${none.status} ${none.text.slice(0, 80)}`);
      qa.check(`${name}: a wrong secret is refused`, codes.includes(bad.status), `${bad.status} ${bad.text.slice(0, 80)}`);
      const tok = await callFunction(name, { body, headers: asMember });
      const refused = name === 'delete-account' || name === 'build-backup' ? tok.status === 403 : [401, 403].includes(tok.status);
      qa.check(`${name}: a member's token ${name === 'delete-account' || name === 'build-backup' ? 'naming another account' : ''} is refused`, refused, `${tok.status} ${tok.text.slice(0, 80)}`);
    }
    const sweepBad = await callFunction('limited-stripe-webhook', { body: {}, headers: wrong });
    qa.check('limited-stripe-webhook: a wrong x-hook-secret is refused by the welcome sweep', sweepBad.status === 401, `${sweepBad.status}`);
    const sweepNone = await callFunction('limited-stripe-webhook', { body: {} });
    qa.check('limited-stripe-webhook: without the header it is the Stripe endpoint and refuses an unsigned body', [400, 401].includes(sweepNone.status), `${sweepNone.status} ${sweepNone.text.slice(0, 80)}`);
    // Positive control: the probes reach the functions, and the lab's vault secret works.
    const good = await callFunction('send-reminders', { body: { profile_id: tProfile.id, dry_run: true }, headers: { 'x-hook-secret': labHookSecret() } });
    qa.check('control: the vault secret is accepted (send-reminders dry run, one profile)', good.status === 200, `${good.status}`);
  }, { soft: true });

  await qa.feature('OPS-004', 'no side effect from any refused probe', async () => {
    await sleep(3000);
    qa.check('no account_deletions row for the target', countWhere('account_deletions', `profile_id = '${tProfile.id}'`) === before.deletions);
    qa.check('the target is not deleted', !profileOf(target.id).deleted_at);
    qa.check('no backup built for the target', countWhere('backups', `user_id = '${tProfile.id}'`) === before.backups);
    qa.check('no email to the target', (await emails({ to: target.email })).length === before.mail);
  }, { soft: true });

  await qa.feature('OPS-004', 'the secret lives only in the vault and the functions\' environment', async () => {
    qa.check('vault.secrets holds welcome_hook_secret', !!row("select 1 as x from vault.secrets where name = 'welcome_hook_secret'"));
    const callers = rows(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%x-hook-secret%'`);
    const literal = callers.filter((f) => !/vault\.decrypted_secrets/.test(f.def));
    qa.check(`every database function that sends x-hook-secret reads it from the vault (${callers.length}: ${callers.map((f) => f.proname).join(', ')})`, callers.length >= 6 && literal.length === 0, literal.map((f) => f.proname).join(', '));
    qa.check('no cron command carries a secret or a header', cronJobs().every((j) => !/hook|secret|bearer|http/i.test(j.command)));
    const migrations = readdirSync(path.join(REPO_ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql'));
    // A placeholder the apply step substitutes (e.g. '__HOOK_SECRET__' in 20260816_reminders.sql) is not a secret.
    const literalInMigrations = migrations.filter((f) => [...repoFile(`supabase/migrations/${f}`).matchAll(/'x-hook-secret'\s*,\s*'([^']{8,})'/g)].some((m) => !/^__[A-Z0-9_]+__$/.test(m[1])));
    qa.check('no migration writes a literal secret value next to x-hook-secret (placeholders excepted)', literalInMigrations.length === 0, literalInMigrations.join(', '));
    const fnDirs = readdirSync(path.join(REPO_ROOT, 'supabase', 'functions')).filter((d) => existsSync(path.join(REPO_ROOT, 'supabase', 'functions', d, 'index.ts')));
    const hardcoded = fnDirs.filter((d) => /x-hook-secret['"]\)\s*[!=]==?\s*['"][^'"]{8,}['"]/.test(repoFile(`supabase/functions/${d}/index.ts`)));
    qa.check('no function compares the header with a literal (all read WELCOME_HOOK_SECRET)', hardcoded.length === 0, hardcoded.join(', '));
    const rotate = existsSync(path.join(REPO_ROOT, 'scripts', 'rotate-hook-secret.sh')) ? repoFile('scripts/rotate-hook-secret.sh') : '';
    qa.check('scripts/rotate-hook-secret.sh documents the rotation (vault and the functions\' WELCOME_HOOK_SECRET)', /vault/i.test(rotate) && /WELCOME_HOOK_SECRET/.test(rotate), rotate.split('\n').slice(0, 3).join(' '));
  }, { soft: true });

  await qa.feature('OPS-004', 'verify_jwt is not auth: the one verify_jwt function still checks the caller itself', async () => {
    const vj = verifyJwtFunctions();
    qa.check('track-event is the only function deployed with verify_jwt on', vj.length === 1 && vj[0] === 'track-event', vj.join(', '));
    const { stackKeys } = await import('./support/ops-helpers.mjs');
    const anon = stackKeys().anon;
    const before = countWhere('user_events');
    const r = await callFunction('track-event', { body: { event_type: 'user_qa_probe', payload: {} }, headers: { Authorization: `Bearer ${anon}`, apikey: anon } });
    qa.check('the public anon key passes the gateway but the function refuses it (401), writing nothing', r.status === 401 && countWhere('user_events') === before, `${r.status} ${r.text.slice(0, 80)}`);
  }, { soft: true });
});

test('deployed functions: each has a caller or is retired, and the uncalled ones refuse or are harmless', {
  tag: ['@OPS-013'],
}, async ({ qa }) => {
  test.setTimeout(5 * 60 * 1000);
  const fnRoot = path.join(REPO_ROOT, 'supabase', 'functions');
  const source = readdirSync(fnRoot).filter((d) => !d.startsWith('_') && !d.startsWith('.') && statSync(path.join(fnRoot, d)).isDirectory() && existsSync(path.join(fnRoot, d, 'index.ts')));
  const deployed = deployedFunctions();
  const browser = browserCalledFunctions();
  const dbDefs = rows(`select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%/functions/v1/%'`).map((r) => r.def).join('\n');
  // Called by a provider (Clerk, Stripe, Resend) on the endpoint production registered.
  const PROVIDER = { 'clerk-webhook': 'Clerk user webhooks', 'limited-stripe-webhook': 'Stripe (limited launch) + welcome sweep', 'email-inbound': 'Resend inbound mail' };
  const callers = {};
  for (const f of deployed) {
    const c = [];
    if (browser[f]) c.push(`app (${browser[f]})`);
    if (new RegExp(`/functions/v1/${f}\\b`).test(dbDefs)) c.push('database');
    if (PROVIDER[f]) c.push(PROVIDER[f]);
    callers[f] = c;
  }

  await qa.feature('OPS-013', 'deployed list vs source (the list production reported on 2026-09-29, kept in the lab template)', async () => {
    const notDeployed = source.filter((f) => !deployed.includes(f));
    const noSource = deployed.filter((f) => !source.includes(f));
    qa.check('every deployed function has source', noSource.length === 0, noSource.join(', '));
    qa.check('functions in source but not deployed are the documented retirements (npi-proxy, send-onboarding-email, support-operations)', notDeployed.sort().join(',') === ['npi-proxy', 'send-onboarding-email', 'support-operations'].join(','), notDeployed.join(', '));
    const uncalled = deployed.filter((f) => !callers[f].length);
    qa.check(`deployed functions nothing calls: ${uncalled.join(', ') || 'none'}`, true, JSON.stringify(callers));
    // Named in src/ but unreachable: trackEvent() has no call site, and the legacy checkout and portal
    // branches of useSubscription return before invoking them while the limited launch is on (as deployed).
    const src = repoFile('src/lib/admin.js');
    const trackCalls = hostGrep('trackEvent\\(', 'src').filter((l) => !/export function trackEvent/.test(l));
    qa.check('track-event: its only browser caller, trackEvent(), is never called', /functions\.invoke\("track-event"/.test(src) && trackCalls.length === 0, trackCalls.join(' | '));
    const sub = repoFile('src/hooks/useSubscription.js');
    qa.check('create-checkout-session and customer-portal: reached only when the limited launch is off (production builds it on)', /if \(LIMITED_LAUNCH_ACCESS_ENABLED\) return \{ ok: false, error: "review_offer_required" \}/.test(sub) && /VITE_LIMITED_LAUNCH_ACCESS_ENABLED: "true"/.test(repoFile('.github/workflows/deploy-gh-pages.yml')));
    qa.blocked('OPS-013', 'The live deployed list and each function\'s verify_jwt are read from the lab template (recorded from production on 2026-09-29); re-reading them needs the Management API, which the lab may use for the catalog only. Deploy-time drift (a function deployed before a fix to a file it bundles) is not visible from the lab.');
  }, { soft: true });

  await qa.feature('OPS-013', 'unauthenticated probes of the uncalled and legacy functions: refused or read-only', async () => {
    const counts = () => ({ events: countWhere('user_events'), feedback: countWhere('feedback'), subs: countWhere('subscriptions'), beta: countWhere('beta_access') });
    const before = counts();
    const probes = [
      ['submit-feedback', 'POST', { message: 'QA lab probe', rating: 5 }, [401]],
      ['track-event', 'POST', { event_type: 'user_qa_probe' }, [401]],
      ['create-checkout-session', 'POST', { offerId: 'core' }, [401, 403, 400, 409, 503]],
      ['customer-portal', 'POST', {}, [401, 403, 400, 409, 503]],
      // The legacy handlers answer billing_disabled / new_sales_not_ready before reading anything: a refusal.
      ['stripe-webhook', 'POST', { id: 'evt_qa', type: 'checkout.session.completed' }, [400, 401, 503]],
      ['send-invite', 'POST', { email: `ops-invite@${LAB_EMAIL_DOMAIN}` }, [401]],
    ];
    for (const [name, method, body, codes] of probes) {
      const r = await callFunction(name, { method, body });
      qa.check(`${name} (${callers[name]?.join(', ') || 'no caller'}): refuses an unauthenticated call`, codes.includes(r.status), `${r.status} ${r.text.slice(0, 100)}`);
    }
    const fc = await callFunction('founding-count', { method: 'GET' });
    qa.check('founding-count (no caller) is a public read: counts only, no personal data', fc.status === 200 && fc.data && Object.keys(fc.data).every((k) => ['claimed', 'total'].includes(k)), fc.text.slice(0, 120));
    await sleep(1500);
    const after = counts();
    qa.check('no rows written by any probe (user_events, feedback, subscriptions, beta_access)', JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    qa.check('user_events and feedback are empty in the lab too (the tables those dormant functions write)', after.events === 0 && after.feedback === 0, JSON.stringify(after));
  }, { soft: true });
});
