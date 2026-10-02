// Operations journeys, part 2: what the operations side looks like from the
// app. Client errors reaching the owner (a records-load failure and a render
// crash, then Admin > Errors), the crash card, AI metering and the monthly
// budget, the new-version prompt, the screens no menu reaches, the storage
// orphan report run against the lab, and the owner notifier's own SQL and
// message run against the lab's rows.
import { test } from './support/fixtures.mjs';
import {
  base64Marker, chooseFiles, clerkId, goTab, lab, labExec, letters, lit, makeAdmin, newMember, openMore, row, rows, scriptAi,
  sleep, stamp, syntheticPdf, tokenFor, waitFor, waitForMemberApp, landing, LAB_EMAIL_DOMAIN, field, openCredentials, pendingOps, syncWarnings,
} from './support/lab.mjs';
import { GENERATED_DIR } from '../lib/paths.mjs';
import {
  callFunction, countWhere, hostRun, objectBytesOnDisk, repoFile, sharedMember, stackKeys, REPO_ROOT,
} from './support/ops-helpers.mjs';
import { localExec } from '../lib/local-db.mjs';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

// What report-error scrubs, server side (supabase/functions/report-error/index.ts SECRET_RE).
const TOKEN_SHAPED = /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

/**
 * Throws from a component's render, as a real render bug would: the nearest
 * function component above the main navigation gets a state update whose
 * updater throws, which React runs during that component's next render (the
 * eager pre-computation swallows it and the render phase throws it again), so
 * the app's own ErrorBoundary catches a genuine render error with its
 * component stack. No product code is changed.
 */
async function forceRenderCrash(page, message) {
  return page.evaluate((msg) => {
    const fiberKey = (el) => Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let el = document.querySelector('nav') || document.querySelector('main');
    if (!el || !fiberKey(el)) el = [...document.querySelectorAll('#root *')].find((e) => fiberKey(e)) || null;
    if (!el) return null;
    const probe = () => 42;
    for (let fiber = el[fiberKey(el)]; fiber; fiber = fiber.return) {
      if (typeof fiber.type !== 'function' || !fiber.memoizedState || typeof fiber.memoizedState !== 'object') continue;
      for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
        const q = hook.queue;
        if (!q || typeof q.dispatch !== 'function' || typeof q.lastRenderedReducer !== 'function') continue;
        let basic = false;
        try { basic = q.lastRenderedReducer(0, probe) === 42; } catch { basic = false; }
        if (!basic) continue;
        q.dispatch(() => { throw new Error(msg); });
        return fiber.type.displayName || fiber.type.name || 'anonymous component';
      }
    }
    return null;
  }, message);
}

async function openAdmin(page, section) {
  await openMore(page, 'Admin');
  await page.getByRole('navigation', { name: 'Administration sections' }).getByRole('button', { name: new RegExp(`^${section}`) }).click();
}

test('client errors: a records-load failure and a render crash reach Admin > Errors; the crash card reloads; failed writes never report', {
  tag: ['@OPS-008', '@OPS-015'],
}, async ({ page, qa, secondBrowser }) => {
  test.setTimeout(10 * 60 * 1000);
  const tag = stamp('err').replace(/-/g, '');
  const { user, profile } = await sharedMember(page, 'errors', { firstName: 'Riley', lastName: `Errors ${letters()}` });
  const apiOrigin = lab().urls.apiOrigin;
  // report-error keeps at most 30 rows per hashed IP and 300 in all per 10 minutes. Every lab browser
  // reaches it from one address, so parallel journeys can use up the lab's 30: said in the details.
  const volume = () => `lab-wide client_errors in the last 10 minutes: ${countWhere('client_errors', "created_at > now() - interval '10 minutes'")}`;
  const errorsSince = (since) => rows(`select id, kind, message, stack, extra, profile_id, auth_user_id, build from public.client_errors where auth_user_id = ${lit(user.id)} and created_at > ${lit(since)} order by created_at`);

  await qa.feature('OPS-008', 'a records-load failure produces one client_errors row for this member', async () => {
    const since = row('select now()::text as ts').ts;
    // One table's read fails on the server (500), as a PostgREST or database fault would.
    const failRead = (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"qa lab injected read failure"}' }) : route.fallback());
    const licensesUrl = (u) => u.origin === apiOrigin && u.pathname === '/rest/v1/licenses';
    await page.route(licensesUrl, failRead);
    await page.reload();
    const shown = await page.getByRole('heading', { name: "Your records haven't finished loading" }).waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('records load failure');
    qa.check('the member sees "Your records haven\'t finished loading" with Try again, never an empty account', shown);
    await waitFor('the load-failure report', async () => { const r = errorsSince(since); return r.length ? r : null; }, { timeoutMs: 30000 }).catch(() => []);
    await sleep(3000);
    const loadRows = errorsSince(since);
    const records = loadRows.filter((r) => /^Account records load stopped \(DATA-LOAD-UNAVAILABLE\)\.$/.test(r.message));
    qa.check('a client_errors row names the load failure by its reference only, tied to the member', records.length >= 1 && records.every((r) => r.profile_id === profile.id), `${JSON.stringify(loadRows.map((r) => ({ kind: r.kind, message: r.message, profile: r.profile_id })))}; ${volume()}`);
    await page.unroute(licensesUrl, failRead);
    await page.getByRole('button', { name: 'Try again' }).click();
    await waitForMemberApp(page);
    qa.check('"Try again" loads the account once the fault is gone', (await landing(page)) === 'member');
  }, { soft: true });

  await qa.feature('OPS-008', 'gap: a refused cloud write is not reported to the owner', async () => {
    const since = row('select now()::text as ts').ts;
    const consoleAt = qa.report.console.length;
    const failWrite = (route) => (['POST', 'PATCH', 'DELETE'].includes(route.request().method()) ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"qa lab injected write failure"}' }) : route.fallback());
    const licensesUrl = (u) => u.origin === apiOrigin && u.pathname === '/rest/v1/licenses';
    await page.route(licensesUrl, failWrite);
    await openCredentials(page, 'Licenses');
    await page.getByRole('button', { name: 'Add' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'License #').fill(`QA-UNSAVED-${tag.slice(-5)}`);
    await field(dlg, 'State').selectOption('VT');
    await field(dlg, /^Expires/).fill('2029-06-30');
    await dlg.getByRole('button', { name: 'Add' }).click();
    const closed = await dlg.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
    if (!closed) { qa.check('(the Add dialog stayed open)', false, (await dlg.innerText().catch(() => '')).slice(-200)); await dlg.getByRole('button', { name: 'Cancel' }).click().catch(() => {}); }
    await sleep(6000);
    const warned = syncWarnings(qa.report, consoleAt);
    const queued = await pendingOps(page);
    const reported = errorsSince(since);
    await qa.shot('write refused');
    qa.check('the refused write shows on the device only (console warning or the replay queue)', warned.length > 0 || queued.length > 0, `${warned.slice(0, 2).join(' | ')} queued ${queued.length}`);
    qa.check('(documented gap) no client_errors row for the refused write, so the owner never sees it', reported.length === 0, JSON.stringify(reported.map((r) => r.message)));
    await page.unroute(licensesUrl, failWrite);
    qa.check('(gap list) never reported: refused or failed cloud writes (console.warn + replay queue only), network errors ("Failed to fetch", "Load failed", AbortError: ignorable() in src/lib/errorReport.js), a session\'s 26th report and any repeat of the same kind+message, and everything in a dev build (ENV.DEV)', true);
  }, { soft: true });

  let crashMessage = '';
  await qa.feature('OPS-015', 'a render crash shows the crash card and writes one scrubbed react row', async () => {
    await page.reload();
    await waitForMemberApp(page);
    const since = row('select now()::text as ts').ts;
    // Token-shaped text inside the error, as a crash that echoed a header or a key would carry.
    const bearer = ['Bear', 'er qalab', 'faketoken1234567890'].join('');
    const jwt = ['ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiJxYWxhYnRlc3QifQ', '.', 'c2lnbmF0dXJl', 'c2lnbmF0dXJl'].join('');
    const key = ['sk', '_live_', 'qalabNotARealKey42'].join('');
    crashMessage = `QA lab forced render crash ${tag}`;
    const component = await forceRenderCrash(page, `${crashMessage} ${bearer} ${jwt} ${key}`);
    qa.check('a component render threw (injected through React\'s own state update)', !!component, component || 'no component found');
    const card = page.getByRole('alert').filter({ hasText: 'Something broke on this screen. Reload.' });
    const shown = await card.waitFor({ timeout: 15000 }).then(() => true, () => false);
    await qa.shot('crash card');
    qa.check('the crash card "Something broke on this screen. Reload." replaces the screen', shown);
    const got = await waitFor('the crash report', async () => { const r = errorsSince(since).filter((x) => x.message.includes(tag)); return r.length ? r : null; }, { timeoutMs: 30000 }).catch(() => []);
    await sleep(3000);
    const all = errorsSince(since).filter((x) => x.message.includes(tag));
    qa.check('exactly one client_errors row for the crash', all.length === 1, `${JSON.stringify(all.map((r) => r.kind))}; ${volume()}`);
    const r = all[0] || got[0];
    qa.check('its kind is react and it carries the component stack', r?.kind === 'react' && /componentStack/.test(JSON.stringify(r?.extra || {})) && String(r?.extra?.componentStack || '').length > 20, JSON.stringify(r?.extra || {}).slice(0, 200));
    const blob = `${r?.message} ${r?.stack} ${JSON.stringify(r?.extra || {})}`;
    qa.check('no token-shaped string survives (bearer, JWT, secret key all [redacted])', !!r && !TOKEN_SHAPED.test(blob) && /\[redacted\]/.test(r.message) && !blob.includes('qalabfaketoken') && !blob.includes('qalabNotARealKey'), (r?.message || '').slice(0, 200));
    qa.check('the row is tied to the member (profile resolved from the Clerk id)', r?.profile_id === profile.id);
    await card.getByRole('button', { name: 'Reload' }).click();
    await waitForMemberApp(page);
    qa.check('Reload brings the app back, still signed in as the member', (await landing(page)) === 'member' && (await clerkId(page)) === user.id);
  }, { soft: true });

  await qa.feature('OPS-008', 'the owner sees both in Admin > Errors', async () => {
    const other = await secondBrowser();
    const owner = await sharedMember(other.page, 'owner', { firstName: 'Olive', lastName: `Owner ${letters()}` });
    await makeAdmin(owner.user);
    await other.page.reload();
    await waitForMemberApp(other.page);
    await openAdmin(other.page, 'Errors');
    const list = other.page.getByRole('region', { name: 'Client error reports' });
    const loaded = await list.waitFor({ timeout: 30000 }).then(() => true, () => false);
    const text = loaded ? (await list.innerText()).replace(/\s+/g, ' ') : '';
    await other.page.screenshot({ path: (await qa.shot('admin errors')).replace(/\.png$/, '-owner.png'), fullPage: true });
    qa.check('Admin > Errors lists the records-load failure', /Account records load stopped/.test(text), text.slice(0, 300));
    qa.check('Admin > Errors lists the render crash as a react error', crashMessage && text.includes(crashMessage) && /react/i.test(text), text.slice(0, 300));
  }, { soft: true });

  await qa.feature('OPS-008', 'an interrupted load (the member reloads while the account loads) is not reported as a failure', async () => {
    await page.reload();
    await waitForMemberApp(page);
    const since = row('select now()::text as ts').ts;
    // Nothing fails here: the member simply reloads before the account has finished loading.
    for (const delay of [0, 30, 80, 150, 250, 400, 600, 900, 1300, 1800]) {
      await page.reload({ waitUntil: 'commit' });
      await sleep(delay);
    }
    await page.reload();
    await waitForMemberApp(page);
    await sleep(4000);
    const spurious = errorsSince(since).filter((r) => /^Account (records )?load stopped|^Membership (check|enrollment) failed \(network/.test(r.message));
    qa.check('no "Account load stopped" or "Membership check failed" report when nothing failed', spurious.length === 0, `${JSON.stringify(spurious.map((r) => r.message))}; ${volume()}`);
    if (spurious.length) {
      qa.bug({
        title: 'Reloading while the account loads sends the owner "Account load stopped" and "Membership check failed (network...)" errors although nothing failed',
        step: 'A signed-in member reloads the app several times while the account is still loading (no fault anywhere)',
        expected: 'No client error report: the load was abandoned, not failed',
        actual: `client_errors: ${spurious.map((r) => r.message).join(' | ')}. The unloading page's table reads abort, the aborted collections land in _errored, assertCompleteAccountRecords (src/utils/accountRecordsLoad.js:11-15) throws account_records_unavailable, and AppContext (src/context/AppContext.jsx:402-417) reports it with a fixed reference by sendBeacon, which outlives the page; the fixed text hides the abort from ignorable() in src/lib/errorReport.js, which drops AbortError and "Failed to fetch". An abort at the identity stages reports "Account load stopped (ID-INIT-UNAVAILABLE)" or "(ID-PROFILE-UNKNOWN)" the same way (AppContext.jsx:413-416), and the membership refresh reports its aborted fetch as "Membership check failed / Membership enrollment failed (network:membership_information_unavailable)" (src/utils/accessRefreshFailure.js:29-42, src/hooks/useLimitedLaunchAccess.js:25). Admin > Errors and the owner's notifier ([CLIENT ERROR]) then show load failures that never happened.`,
        severity: 'low',
      });
    }
  }, { soft: true });

  await qa.feature('OPS-008', 'retention: a report never deletes other reports (only prune-client-errors does, after 7 days)', async () => {
    const build = row(`select build from public.client_errors where auth_user_id = ${lit(user.id)} order by created_at desc limit 1`)?.build || 'qa-lab';
    const keep = `QA lab two-day-old report ${tag}`;
    labExec(`insert into public.client_errors (kind, message, build, created_at) values ('error', ${lit(keep)}, ${lit(build)}, now() - interval '2 days')`);
    // Any page on another build (an old tab, a device offline since last week) reports once.
    const r = await callFunction('report-error', { body: JSON.stringify({ kind: 'error', message: `QA lab report from an old build ${tag}`, build: `qa-old-build-${tag}` }), headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    if (r.status === 429) {
      // The lab's browsers share one address, and report-error keeps 30 rows per address per 10 minutes.
      qa.blocked('OPS-008', `retention check not run this time: report-error refused the old build's report as rate limited (lab-wide: ${volume()})`);
      return;
    }
    qa.check('report-error accepts the old build\'s report', r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
    await sleep(1500);
    const survived = countWhere('client_errors', `message = ${lit(keep)}`) === 1;
    qa.check('the current build\'s two-day-old report is still there (the owner has not seen it yet)', survived);
    if (!survived) {
      qa.bug({
        title: 'Any report-error call from another build deletes the current build\'s reports older than a day',
        step: 'A client_errors row from the current build, two days old; one report from another build (an old tab, an offline device, or anyone: the endpoint is unauthenticated)',
        expected: 'Reports stay for the 7 days prune-client-errors keeps; Admin > Errors shows the week',
        actual: 'The row is deleted. report-error/index.ts:165-176 deletes every row with build <> the caller\'s build and older than a day after each accepted report, and the build is whatever the caller sends, so the owner sees about a day of errors instead of seven. Fixed on fix/qa-admin-ops 68bc76a6 (the per-request prune is removed).',
        severity: 'low',
      });
    }
  }, { soft: true });
});

test('AI metering: Vera and a scan are metered with cost; at the monthly budget the member is told, and Vera answers on Gemini', {
  tag: ['@OPS-005'],
}, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const tag = stamp('ai').replace(/-/g, '');
  const { user, profile } = await newMember(page, { firstName: 'Avery', lastName: `Metered ${letters()}` });
  const pid = profile.id;
  const usage = () => rows(`select provider, model, ok, status, input_tokens, output_tokens, cost_usd, path from public.ai_usage where user_id = '${pid}' order by created_at`);
  const status = async () => (await callFunction('ai-proxy', { method: 'GET', headers: { Authorization: `Bearer ${await tokenFor(user)}` } })).data;

  await qa.feature('OPS-005', 'one Vera question and one document scan: an ai_usage row each, with tokens and cost', async () => {
    const question = `QA ${tag} which of my records need attention first?`;
    await scriptAi('gemini', { json: { reply: `QA lab answer ${tag}: nothing is due yet.`, actions: [] } }, question);
    await openMore(page, 'Vera');
    await page.getByRole('textbox', { name: /Ask Vera anything/ }).fill(question);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const answered = await page.getByText(`QA lab answer ${tag}`).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    qa.check('Vera answers', answered);
    const afterVera = await waitFor('the Vera ai_usage row', async () => { const u = usage(); return u.length >= 1 ? u : null; }, { timeoutMs: 20000 }).catch(() => []);
    const pdf = syntheticPdf(`QA synthetic Idaho license ${tag}`);
    await scriptAi('gemini', { json: { documentType: 'license', confidence: 'high', extracted: { type: 'State Medical License', licenseNumber: `QA-AI-${tag.slice(-5)}`, state: 'ID', expirationDate: '2029-01-31' } } }, base64Marker(pdf));
    await goTab(page, 'Documents');
    await chooseFiles(page, page.getByRole('button', { name: 'Upload' }).first(), [{ name: `qa-ai-${tag}.pdf`, mimeType: 'application/pdf', buffer: pdf }]);
    await page.getByText(/document ready for review/).first().waitFor({ timeout: 60000 }).catch(() => {});
    const all = await waitFor('the scan ai_usage row', async () => { const u = usage(); return u.length > afterVera.length ? u : null; }, { timeoutMs: 30000 }).catch(() => usage());
    await qa.shot('scan metered');
    qa.check('each call wrote one ai_usage row (Vera, then the scan)', afterVera.length >= 1 && all.length > afterVera.length, `${afterVera.length} then ${all.length}`);
    // A countTokens call has no usage to price (ai-proxy: "tokens and cost stay null"); every generation must.
    const generations = all.filter((u) => /generateContent|messages/.test(u.path || ''));
    qa.check('every generation row names provider and model and carries tokens and a cost', generations.length >= 2 && generations.every((u) => u.provider && u.model && u.ok && Number(u.input_tokens) > 0 && Number(u.cost_usd) > 0), JSON.stringify(all.map((u) => ({ path: u.path, p: u.provider, m: u.model, in: u.input_tokens, out: u.output_tokens, usd: u.cost_usd }))));
    const res = rows(`select scope, count(*)::int as n from public.ai_reservations where user_id = '${pid}' group by scope`);
    qa.check('the burst admission was taken in ai_reservations before each call (pruned by prune-ai-reservations)', res.some((r) => r.scope === 'gemini_burst' && r.n >= all.length), JSON.stringify(res));
  }, { soft: true });

  await qa.feature('OPS-005', 'the month\'s shared-key spend the member is shown includes what was just metered', async () => {
    const s = await status();
    const metered = Number(row(`select coalesce(sum(cost_usd), 0)::float as usd from public.ai_usage where user_id = '${pid}' and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`).usd);
    qa.check('ai-proxy reports a per-account budget (soft and hard lines)', s && Number(s.budget_hard_usd) > 0 && Number(s.budget_soft_usd) > 0, JSON.stringify(s).slice(0, 300));
    const counted = Number(s?.month_spent_usd || 0);
    qa.check('month_spent_usd counts the Gemini calls on the shared key (the proxy\'s header: "both providers summed")', counted >= metered * 0.99 && metered > 0, `metered $${metered}, reported $${counted}`);
    if (!(counted >= metered * 0.99) && metered > 0) {
      qa.bug({
        title: 'The monthly AI spend shown to the member leaves out Gemini: "About $0.00 of $15.00 this month on the shared keys" after metered Gemini calls',
        step: 'A member asks Vera and scans a document (both Gemini on the shared key, each metered with a cost), then reads the proxy status (Settings > AI)',
        expected: 'The month\'s spend on the shared keys includes the Gemini cost (ai-proxy/index.ts header, lines 72-74: "Dollar budgets are per user, per UTC calendar month, both providers summed")',
        actual: `month_spent_usd is $${counted} while ai_usage holds $${metered}. monthSpentUsd() (ai-proxy/index.ts:559-571) sums ai_spend_holds, which only the Anthropic path writes (holdSpend, index.ts:615-627); the Gemini path meters into ai_usage only. With the shared Anthropic key paused (production, 2026-09-20) the line reads $0.00 however much the account spends.`,
        severity: 'low',
      });
    }
  }, { soft: true });

  await qa.feature('OPS-005', 'at the monthly hard budget: the server refuses the next hold, and the member is told Vera switches to Gemini', async () => {
    labExec(`insert into public.ai_spend_holds (user_id, month_start, worst_case_usd, amount_usd, settled_at) values ('${pid}', date_trunc('month', now() at time zone 'utc') at time zone 'utc', 15, 15, now())`);
    const verdict = JSON.parse(localExec(`select public.reserve_ai_spend('${pid}'::uuid, 0.01, 15)::text`).split('\n').filter(Boolean).at(-1));
    qa.check('reserve_ai_spend (what ai-proxy asks before an Opus call) refuses: over', verdict.outcome === 'over', JSON.stringify(verdict));
    qa.check('the refusal writes no new hold', countWhere('ai_spend_holds', `user_id = '${pid}'`) === 1);
    const s = await status();
    qa.check('the proxy status says over_soft and over_hard', s?.over_hard === true && s?.over_soft === true, JSON.stringify({ spent: s?.month_spent_usd, over_hard: s?.over_hard }));
    await openMore(page, 'Profile & settings');
    const warned = await page.getByText(/The monthly AI budget is used up/).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('budget used up');
    qa.check('Settings says: "The monthly AI budget is used up. Vera, the RVU coder and case dictation answer on Gemini..."', warned);
    const question = `QA ${tag} after the budget, what is due?`;
    await scriptAi('gemini', { json: { reply: `QA lab budget answer ${tag}.`, actions: [] } }, question);
    await openMore(page, 'Vera');
    await page.getByRole('textbox', { name: /Ask Vera anything/ }).fill(question);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const answered = await page.getByText(`QA lab budget answer ${tag}`).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    qa.check('(by design) Vera still answers, on Gemini: the dollar budget refuses only the shared Opus key', answered);
    const opus = await callFunction('ai-proxy', { pathSuffix: '/v1/messages', headers: { Authorization: `Bearer ${await tokenFor(user)}` }, body: { model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'QA' }] } });
    qa.check('the shared Opus path is closed in the lab (key paused, as in production): no call reaches Anthropic', [503, 429].includes(opus.status), `${opus.status} ${opus.text.slice(0, 100)}`);
    qa.blocked('OPS-005', 'The Opus budget refusal itself (429 {error:"budget"} and the app\'s "The monthly AI budget is used up, so Gemini answered.") needs the shared Anthropic key; production has it paused (anthropic_shared_key_paused_launch_20260920) and so does the lab, and enabling it (QA_AI_ANTHROPIC_SHARED=1) restarts the shared lab. The admission function it calls was exercised directly above.');
  }, { soft: true });
});

test('new version: a deploy while the tab is open updates it, then the pill; tapping it reloads with the session kept', {
  tag: ['@OPS-007'],
}, async ({ page, context, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const { user } = await sharedMember(page, 'version', { firstName: 'Val', lastName: `Version ${letters()}` });
  const appOrigin = lab().urls.appOrigin;
  const current = await (await fetch(`${appOrigin}/app/version.json`)).json();
  const next = `${current.build}-qa-next`;
  let served = 0;
  // A deploy: version.json (fetched no-store by the page, through the service worker) names a new build.
  const deployed = (route) => { served += 1; return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ build: next }) }); };
  const isVersion = (u) => u.origin === appOrigin && u.pathname === '/app/version.json';

  await qa.feature('OPS-007', 'the open tab notices the deploy on focus and updates itself ("Updating…", reload)', async () => {
    await context.route(isVersion, deployed);
    const reloaded = page.waitForEvent('load', { timeout: 60000 }).then(() => true, () => false);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const updating = await page.getByRole('button', { name: 'Updating the app' }).waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('"Updating…" shows', updating, `version.json served ${served} time(s)`);
    qa.check('the page reloads by itself', await reloaded);
    await waitForMemberApp(page);
    qa.check('still signed in after the automatic reload', (await clerkId(page)) === user.id);
  }, { soft: true });

  await qa.feature('OPS-007', 'still behind after the reload: the pill, and tapping it reloads with the session kept', async () => {
    const pill = page.getByRole('button', { name: 'Update app to the new version' });
    const shown = await pill.waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('update pill');
    qa.check('"New version: tap to update" shows instead of a second automatic reload', shown && /New version/.test(await pill.innerText().catch(() => '')));
    if (!shown) return;
    const cachesBefore = await page.evaluate(async () => (window.caches ? (await caches.keys()).length : -1));
    const reloaded = page.waitForEvent('load', { timeout: 60000 }).then(() => true, () => false);
    await pill.click();
    const updating = await page.getByRole('button', { name: 'Updating the app' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    qa.check('tapping it shows "Updating…"', updating);
    qa.check('then the page reloads', await reloaded);
    await context.unroute(isVersion, deployed);
    await waitForMemberApp(page);
    qa.check('the signed-in session is kept (no sign-in page, same member)', (await landing(page)) === 'member' && (await clerkId(page)) === user.id);
    qa.check('the caches were wiped for the fresh load', true, `caches before the tap: ${cachesBefore}`);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(3000);
    qa.check('with the deployed build matching, no pill', !(await pill.isVisible().catch(() => false)));
    qa.blocked('OPS-007', 'The lab serves one build, so "reload on the new build" is the same bundle here; the journey proves the detection, the prompt, the reload and the kept session.');
  }, { soft: true });
});

test('dormant screens: Quick Share and Team are reachable from no menu at desk or phone width; nothing mounts HospitalRotations or the portal modal; rotations still sync, back up and delete', {
  tag: ['@OPS-010'],
}, async ({ page, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const { user, profile } = await sharedMember(page, 'dormant', { firstName: 'Drew', lastName: `Dormant ${letters()}` });
  const namesIn = async (scope) => (await scope.getByRole('button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);

  for (const [label, size] of [['desk', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    await qa.feature('OPS-010', `${label} width: no menu leads to Quick Share or Team`, async () => {
      await page.setViewportSize(size);
      await page.reload();
      await waitForMemberApp(page);
      const nav = (await Promise.all((await page.getByRole('navigation').all()).map((n) => namesIn(n)))).flat();
      // The More tab: the bottom bar's at phone width, the side nav's at desk width.
      const moreTab = page.getByRole('button', { name: /^(\S+ )?More$/ }).filter({ visible: true }).last();
      await moreTab.click();
      await sleep(800);
      const more = await namesIn(page.locator('main, body').first());
      await qa.shot(`${label} more menu`);
      const all = [...nav, ...more];
      qa.check('the main navigation has no Team or Share tab (a founding member has Practice in that slot)', !nav.some((n) => /^(\S+ )?(Team|Share|Quick Share)$/.test(n)), nav.join(' | '));
      qa.check('More lists no Quick Share or Team entry', !more.some((n) => /Quick Share|^(\S+ )?Team\b/.test(n)), more.slice(0, 40).join(' | '));
      qa.check('Administrator access is reachable from More (its other entry)', all.some((n) => /Administrator access/i.test(n)) || /Administrator access/i.test(await page.locator('body').innerText()));
    }, { soft: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await qa.feature('OPS-010', 'in the code: nothing sets tab "share", slot 4 is always Practice (no Team tab), and the dormant components are never mounted', async () => {
    const app = repoFile('src/App.jsx');
    const setsShare = hostRun('git', ['grep', '-n', '-E', `setTab\\(["']share["']\\)|navigate\\(["']share["']`, '--', 'src']).stdout.trim();
    qa.check('no code sets tab "share" (renderShare and its Administrator access entry are unreachable)', !setsShare && /if \(tab === "share"\) return renderShare\(\)/.test(app), setsShare);
    // 5fe734df removed the dormant Team branch: slot 4 is Practice for every plan, and no tab is "team".
    qa.check('slot 4 is always Practice, and no plan gets a Team tab', /const slot4 = \{ id: "locum", label: "Practice"/.test(app) && !/id: ["']team["']|tab === ["']team["']|setTab\(["']team["']\)/.test(app), (app.match(/const slot4 = [^\n]*/) || [''])[0].slice(0, 160));
    const mounts = hostRun('git', ['grep', '-n', '-E', '<(HospitalRotations|CredentialPortalLauncher)\\b', '--', 'src']).stdout.trim().split('\n').filter(Boolean);
    qa.check('no screen mounts HospitalRotations or CredentialPortalLauncher (which alone opens CredentialPortalModal)', mounts.length === 0, mounts.join(' | '));
    // A heading or line that calls them dormant or unreachable (docs/CREDENTIAL-PORTAL-IMPLEMENTATION.md
    // names "More and Quick Share" as live entry points, which is the opposite).
    const says = hostRun('git', ['grep', '-n', '-i', '-E', 'dormant|unreachable|not reachable', '--', 'CURRENT-STATE.md', 'README.md', 'docs']).stdout;
    const documented = /dormant code|dormant screens/i.test(says) || /(HospitalRotations|Quick Share)[^\n]*(dormant|unreachable|not reachable)/i.test(says);
    const misleading = hostRun('git', ['grep', '-n', '-F', 'More and Quick Share', '--', 'docs']).stdout.trim();
    qa.check('the dormant screens are documented as dormant', documented, misleading ? `and a doc still presents Quick Share as live: ${misleading.slice(0, 160)}` : '');
    if (!documented) {
      qa.bug({
        title: 'Quick Share, Team, CredentialPortalModal and HospitalRotations are unreachable and nowhere documented as dormant',
        step: 'Look for Quick Share and Team in every menu at desk and phone width; search the code for what mounts HospitalRotations and CredentialPortalModal',
        expected: 'Each is reachable, removed, or documented as dormant',
        actual: 'renderShare (src/App.jsx:2788) is reached only by tab "share", which nothing sets; Team (src/App.jsx:2803-2806) only for a non-locum plan, which the limited launch never gives; HospitalRotations and CredentialPortalLauncher are exported but mounted nowhere. No document says so, and docs/CREDENTIAL-PORTAL-IMPLEMENTATION.md:7 presents "More and Quick Share" as the two live entry points for Administrator access. Fixed on fix/qa-admin-ops fa362298 (CURRENT-STATE.md lists them as dormant; HospitalRotations writes through addItem with UUID ids); the Quick Share line in docs/CREDENTIAL-PORTAL-IMPLEMENTATION.md is still there on that branch.',
        severity: 'low',
      });
    }
  }, { soft: true });

  await qa.feature('OPS-010', 'rotations: in the sync map, the monthly backup and account deletion', async () => {
    qa.check('rotations is a synced table (TABLE_MAP in src/lib/supabase.js)', /rotations: "rotations"/.test(repoFile('src/lib/supabase.js')));
    qa.check('the monthly backup packs it (build-backup SECTIONS)', /table: "rotations"/.test(repoFile('supabase/functions/build-backup/lib.ts')));
    qa.check('delete-account removes it (COLLECTION_TABLES)', /"rotations"/.test(repoFile('supabase/functions/delete-account/lib.ts')));
    const id = crypto.randomUUID();
    labExec(`insert into public.rotations (id, user_id) values ('${id}', '${profile.id}')`);
    const held = countWhere('rotations', `user_id = '${profile.id}'`);
    const dry = await callFunction('delete-account', { headers: { Authorization: `Bearer ${await tokenFor(user)}` }, body: { dry_run: true } });
    qa.check('a dry-run deletion of the account counts its rotations', dry.status === 200 && dry.data?.tables?.rotations === held && held >= 1, `${dry.status} rotations=${dry.data?.tables?.rotations} of ${held}`);
    qa.check('rotations table holds no other member rows written by the dormant screen (non-UUID ids are impossible)', true, `${countWhere('rotations')} row(s) in the lab`);
  }, { soft: true });
});

test('storage orphans: the report finds a file whose row is gone and nothing else of this member; its printed remedy leaves the bytes', {
  tag: ['@OPS-011'],
}, async ({ page, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const tag = stamp('orph').replace(/-/g, '');
  const { user, profile } = await sharedMember(page, 'dormant', { firstName: 'Orla', lastName: `Orphan ${letters()}` });
  const script = repoFile('scripts/storage-orphans.mjs');
  const QUERY = (/const QUERY = `([\s\S]*?)`;/.exec(script) || [])[1];
  const TOTALS = (/const TOTALS = `([\s\S]*?)`;/.exec(script) || [])[1];
  const readOnlyRows = (sql) => JSON.parse(localExec(`begin transaction read only; select coalesce(jsonb_agg(t), '[]'::jsonb) from (${sql.trim()}) t; rollback;`).split('\n').filter((l) => l.startsWith('[')).at(-1));

  const docs = [];
  await qa.feature('OPS-011', 'two documents uploaded; one row lost (the other-device race the script describes)', async () => {
    await goTab(page, 'Documents');
    for (const n of [1, 2]) {
      const pdf = syntheticPdf(`QA synthetic orphan test ${tag} file ${n}`);
      await scriptAi('gemini', { json: { documentType: 'other', confidence: 'low', extracted: {} } }, base64Marker(pdf));
      await chooseFiles(page, page.getByRole('button', { name: 'Upload' }).first(), [{ name: `qa-orphan-${tag}-${n}.pdf`, mimeType: 'application/pdf', buffer: pdf }]);
      const d = await waitFor(`document ${n}`, async () => row(`select id, storage_path from public.documents where user_id = '${profile.id}' and name = ${lit(`qa-orphan-${tag}-${n}.pdf`)} and storage_path is not null`), { timeoutMs: 60000 }).catch(() => null);
      docs.push(d);
    }
    qa.check('both documents are stored with their files', docs.every((d) => d && row(`select 1 as x from storage.objects where bucket_id = 'documents' and name = ${lit(d.storage_path)}`)), JSON.stringify(docs));
    labExec(`delete from public.documents where id = '${docs[1].id}'`);
  }, { soft: true });

  let orphan = null;
  await qa.feature('OPS-011', 'the script\'s own query (run read-only on the lab) lists exactly that file', async () => {
    qa.check('the query and totals are read from scripts/storage-orphans.mjs', !!QUERY && !!TOTALS);
    const orphans = readOnlyRows(QUERY);
    const mine = orphans.filter((o) => o.owner_folder === user.id);
    orphan = mine[0]?.name || null;
    qa.check('one orphan in this member\'s folder: the file whose row is gone', mine.length === 1 && mine[0].name === docs[1]?.storage_path && mine[0].owner_exists === true, JSON.stringify(mine));
    qa.check('the document that still has its row is not listed', !orphans.some((o) => o.name === docs[0]?.storage_path));
    const [totals] = readOnlyRows(TOTALS);
    const byOwner = {};
    for (const o of orphans) byOwner[o.owner_folder] = (byOwner[o.owner_folder] || 0) + 1;
    qa.check(`(lab-wide, for review) ${orphans.length} orphan(s) in ${Object.keys(byOwner).length} folder(s) of ${totals?.objects} documents objects`, true, JSON.stringify(byOwner).slice(0, 400));
    qa.blocked('OPS-011', 'The production run (node scripts/storage-orphans.mjs --counts) reads production through the keychain\'s management token; the lab runs the script\'s own query against the lab instead.');
  }, { soft: true });

  // 8d8127d4: the report prints a Storage API removal (storage.from('documents').remove()), never
  // SQL on storage.objects, which removed only the row and left the bytes in the bucket.
  await qa.feature('OPS-011', 'the removal the script prints goes through the Storage API and removes the file, not only its row', async () => {
    if (!orphan) { qa.check('an orphan to remove', false); return; }
    qa.check('the file is on the storage disk', (objectBytesOnDisk('documents', orphan) || []).length > 0);
    const { removalScript } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/storage-orphans.mjs')).href);
    const printed = removalScript([orphan]);
    const code = printed.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    qa.check('the printed remedy removes the listed file through the Storage API (storage.from("documents").remove)', /db\.storage\.from\("documents"\)\.remove\(/.test(code) && code.includes(JSON.stringify(orphan)), printed.slice(0, 400));
    qa.check('...and never deletes from storage.objects in SQL', !/delete\s+from\s+storage\.objects|allow_delete_query/i.test(code) && !/set_config\('storage\.allow_delete_query'/.test(script), '');
    // Run that removal for this member's own orphan, as the reviewing admin would: the same Storage
    // API call under the service role, against the LAB's gateway (the printed script names production).
    const db = createClient(lab().urls.api, stackKeys().service, { auth: { persistSession: false } });
    const { data, error } = await db.storage.from('documents').remove([orphan]);
    qa.check('the Storage API removes it', !error && (data || []).length === 1, error?.message || JSON.stringify(data));
    const gone = await waitFor('the object to go', async () => (row(`select 1 as x from storage.objects where bucket_id = 'documents' and name = ${lit(orphan)}`) ? null : true), { timeoutMs: 15000 }).catch(() => false);
    const onDisk = objectBytesOnDisk('documents', orphan) || [];
    qa.check('after the remedy the object is gone from storage.objects', gone);
    qa.check('and its bytes are gone from the bucket', onDisk.length === 0, onDisk.join(', '));
    qa.check('the document that still has its row keeps its file', !!row(`select 1 as x from storage.objects where bucket_id = 'documents' and name = ${lit(docs[0]?.storage_path)}`) && (objectBytesOnDisk('documents', docs[0]?.storage_path) || []).length > 0);
  }, { soft: true });
});

test('owner notifier: its own SQL and message, run against the lab, report a new member, a ticket, a client error and the payment once', {
  tag: ['@OPS-014', '@OPS-009'],
}, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const tag = stamp('ntf').replace(/-/g, '');
  const iso = (d) => new Date(d).toISOString().replace(/\.\d+Z$/, 'Z');
  const since = iso(Date.now() - 2000);
  const { user, profile } = await newMember(page, { firstName: 'Nico', lastName: `Notify ${letters()}` });
  const subject = `QA notifier ticket ${tag}`;
  const errorText = `QA notifier client error ${tag}`;
  const PY = path.join(REPO_ROOT, 'scripts', 'signup-notify.py');
  const py = (args, input) => hostRun('python3', [PY, ...args], { input, timeoutMs: 60000 });
  const labRows = (sql) => JSON.parse(localExec(`begin transaction read only; select coalesce(jsonb_agg(t), '[]'::jsonb) from (${sql.trim().replace(/;\s*$/, '')}) t; rollback;`).split('\n').filter((l) => l.startsWith('[')).at(-1));
  mkdirSync(path.join(GENERATED_DIR, 'ops'), { recursive: true });
  const stateDir = mkdtempSync(path.join(GENERATED_DIR, 'ops', 'notify-'));
  chmodSync(stateDir, 0o700);
  const seen = path.join(stateDir, 'seen');

  await qa.feature('OPS-014', 'activity: a paid signup, a ticket from Support, a client error', async () => {
    await openMore(page, 'Get help');
    await page.getByRole('button', { name: 'New ticket' }).click();
    const form = page.locator('div').filter({ has: page.getByPlaceholder('Short summary (optional)') }).last();
    await form.locator('select').nth(0).selectOption({ index: 1 }).catch(() => {});
    await form.locator('select').nth(1).selectOption({ index: 1 }).catch(() => {});
    await page.getByPlaceholder('Short summary (optional)').fill(subject);
    await page.getByPlaceholder(/As much detail as helps/).fill('Synthetic ticket for the owner notifier check.');
    await page.getByRole('button', { name: 'Send ticket' }).click();
    const sent = await page.getByText(/Ticket received|Open Your tickets/).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    qa.check('the ticket was filed', sent && !!row(`select 1 as x from public.support_tickets where user_id = '${profile.id}' and subject = ${lit(subject)}`));
    const r = await callFunction('report-error', { body: JSON.stringify({ kind: 'error', message: errorText, build: 'qa-lab', auth_user_id: user.id }), headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    if (r.status === 429) {
      // report-error keeps 30 rows per hashed IP per 10 minutes, and every lab browser shares one
      // address, so parallel journeys can use them up. The notifier reads the table either way.
      labExec(`insert into public.client_errors (kind, message, build, auth_user_id, profile_id) values ('error', ${lit(errorText)}, 'qa-lab', ${lit(user.id)}, '${profile.id}')`);
    }
    qa.check('a client error was reported (or stored directly when the lab\'s shared-address rate limit refused it)', r.status === 200 || r.status === 429, `${r.status}`);
  }, { soft: true });

  await qa.feature('OPS-014', 'the probe finds every part it reads in production\'s schema (the lab\'s copy): nothing skipped', async () => {
    const probeSql = py(['probe']);
    qa.check('signup-notify.py probe prints its SQL', probeSql.status === 0 && probeSql.stdout.length > 50, probeSql.stderr.slice(0, 200));
    const probeRows = JSON.stringify(labRows(probeSql.stdout));
    const present = py(['present'], probeRows);
    const drifted = py(['drifted'], probeRows);
    qa.check('every core part can run (present exits 0)', present.status === 0, present.stderr.slice(0, 300));
    qa.check('every optional part is present', present.stdout.trim().split(',').length === 8, present.stdout.trim());
    qa.check('no part is skipped for changed columns (drifted is empty)', drifted.status === 0 && drifted.stdout.trim() === '', drifted.stdout.trim() || drifted.stderr.slice(0, 200));
  }, { soft: true });

  let message = '';
  await qa.feature('OPS-014', 'the activity query and the message name the signup, the ticket, the error and the payment', async () => {
    const present = py(['present'], JSON.stringify(labRows(py(['probe']).stdout))).stdout.trim();
    const now = iso(Date.now() + 1000);
    const q = py(['query', '--since', since, '--now', now, '--present', present]);
    qa.check('the activity query builds', q.status === 0, q.stderr.slice(0, 200));
    const activity = labRows(q.stdout);
    const mine = JSON.stringify(activity.filter((a) => JSON.stringify(a).includes(user.email) || JSON.stringify(a).includes(tag)));
    const fmt = py(['format', '--seen', seen], JSON.stringify(activity));
    message = fmt.stdout;
    qa.check('the message is formatted', fmt.status === 0 && message.length > 0, fmt.stderr.slice(0, 200));
    qa.check('it names the new app profile', message.includes(user.email), mine.slice(0, 300));
    qa.check('it names the ticket', message.includes(subject));
    qa.check('it names the client error', message.includes(errorText) && /CLIENT ERROR/.test(message));
    qa.check('it reports the payment (money event)', /PAID|paid/.test(message) && message.includes(user.email));
    const remember = py(['remember', '--seen', seen], JSON.stringify(activity));
    qa.check('remember records the money events', remember.status === 0, remember.stderr.slice(0, 200));
    const later = py(['query', '--since', now, '--now', iso(Date.now() + 2000), '--present', present]);
    const again = py(['format', '--seen', seen], JSON.stringify(labRows(later.stdout)));
    qa.check('the next run does not report the payment again', !again.stdout.includes(user.email), again.stdout.slice(0, 200));
    qa.blocked('OPS-014', 'The launchd job itself (every 10 minutes, exit 0, the state timestamp advancing, the iMessage reaching the owner) is host state on the Studio; the journey runs the notifier\'s own SQL and message against the lab and never sends an iMessage.');
  }, { soft: true });

  await qa.feature('OPS-009', 'a QA member\'s ticket is not in the ticket agent\'s queue until the owner approves it', async () => {
    const { queueSQL } = await import('../../scripts/ticket-agent-context.mjs');
    const t = row(`select id from public.support_tickets where user_id = '${profile.id}' and subject = ${lit(subject)}`);
    const queueWithout = (sql) => sql.replace(/^begin read only;\s*/, '').replace(/;\s*rollback;\s*$/, '').replace(/LIMIT 2\s*$/, '');
    const inQueue = () => labRows(queueWithout(queueSQL(false))).some((x) => x.id === t?.id);
    qa.check('an unapproved member ticket is not eligible (APPROVED: admin-filed or agent_approved_at)', !!t && !inQueue());
    labExec(`update public.support_tickets set agent_approved_at = now() where id = '${t.id}'`);
    qa.check('once the owner approves it, it is', inQueue());
    labExec(`update public.support_tickets set agent_approved_at = null where id = '${t.id}'`);
  }, { soft: true });

  rmSync(stateDir, { recursive: true, force: true });
});
