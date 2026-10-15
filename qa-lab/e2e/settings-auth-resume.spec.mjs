// An installed iPhone app resumed mid-load (fix/load-retry, live 2026-10-01 on
// build 20261001T0244-82a85dc): "Membership check failed (response:200:
// membership_information_unavailable)" and, 224 ms later, "Account load stopped
// (ID-INIT-UNAVAILABLE)", with "Your account identity could not be verified ...
// Reload to try again." on screen. Clerk builds a new Session object for the same
// session each time it refreshes its client (the touch it sends as the page gets
// focus), and the app's requests compared the object itself, so the answer it was
// reading was thrown away as if another account had signed in.
//
// This journey does what Clerk does, in the member's own browser, while the
// account loads: window.Clerk.session becomes a new object of the same session
// (the QA Clerk's replaceSessionObject: same id, same user, listeners told)
// while initialize-clerk-profile's answer is on its way, and again while a
// billing-entitlements answer is; and the first billing-entitlements answer that
// comes back 200 is cut off halfway through its body (Playwright routing; every
// other request goes to the lab's functions unchanged). The account must load
// without a reload prompt, from the one identity read it sent (a load rescued by
// a retry would hide the session comparison), and a license added afterwards
// must reach the server under the replaced session.
//
// Then a real account switch: another physician signs in on the same page while
// the first account's identity answer is on its way. That load must still stop:
// the first account's identity read is not tried again, none of its records show,
// and the page ends on the second physician's own membership gate.
// Nothing leaves this machine.
import { test } from './support/fixtures.mjs';
import {
  createPhysician, field, newMember, openCredentials, pendingOps, profileOf, rows, sleep, tableRow, waitFor,
} from './support/lab.mjs';

const fn = (name) => `**/functions/v1/${name}`;
const nowSql = () => new Date().toISOString();
const bodyText = async (page) => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
// AppContext's identity stop ("... could not be verified ... Reload to try again", profileIssueDiagnostics.js),
// its support reference, and any other reload prompt: a load that fell back to this device's copy
// says "Showing this device's copy. Reload to reconnect your account" (what the build before
// fix/load-retry showed here, with "Account load used this device's copy (DATA-LOAD-LOCAL-PROFILE-UNKNOWN)").
const IDENTITY_STOP = /could not be verified|Reload to try again/;
const RELOAD_PROMPT = /could not be verified|Reload to (try again|reconnect)/;
const STOP_REFERENCE = /Support reference: (ID-[A-Z0-9-]+)/;

/** The Clerk subject a function request is sent as (its bearer token's `sub`), or null. */
function subjectOf(request) {
  const auth = request.headers().authorization || '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).sub || null; } catch { return null; }
}

/** Every report-error body this page sends from now on. */
function watchReports(page) {
  const sent = [];
  const onRequest = (r) => { if (r.url().includes('/functions/v1/report-error') && r.method() === 'POST') sent.push(r.postData() || ''); };
  page.on('request', onRequest);
  return { sent, stop: () => page.off('request', onRequest) };
}

/** Response headers to pass on with a changed body (its length and encoding are no longer the server's). */
const passOn = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(content-length|content-encoding|transfer-encoding)$/i.test(k)));

const replaceSession = (page) => page.evaluate(() => window.Clerk.replaceSessionObject()).catch((e) => ({ error: String(e?.message || e).slice(0, 160) }));

async function addLicenseByHand(page, number, state = 'CO') {
  await openCredentials(page, 'Licenses');
  await page.getByRole('button', { name: 'Add' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add' });
  await field(dlg, 'Type').selectOption('State Medical License');
  await field(dlg, 'License #').fill(number);
  await field(dlg, 'State').selectOption(state);
  await field(dlg, /^Expires/).fill('2028-10-31');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.waitFor({ state: 'detached', timeout: 15000 });
}
const licenseOnServer = (profileId, number) => rows(`select id from public.licenses where user_id = '${profileId}' and license_number = '${number}'`).length > 0;

/** Waits for the member app or the identity stop, whichever the load ends on. */
async function loadEnd(page, timeoutMs = 120000) {
  const app = page.getByRole('button', { name: /^Credentials$/ }).first();
  const stop = page.getByRole('status').filter({ hasText: IDENTITY_STOP }).first();
  const gate = page.getByRole('region', { name: 'Membership' });
  return Promise.race([
    app.waitFor({ timeout: timeoutMs }).then(() => 'member'),
    stop.waitFor({ timeout: timeoutMs }).then(() => 'stopped'),
    gate.waitFor({ timeout: timeoutMs }).then(() => 'gate'),
  ]).catch(() => 'timeout');
}

test('a resumed phone: Clerk replaces the session object mid-load and one membership answer is cut off; the account loads, and a real account switch still stops', {
  tag: ['@AUTH-002', '@AUTH-011'],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Rhea', lastName: 'Resume' });
  await addLicenseByHand(page, 'QA-RESUME-1');
  await waitFor('the first license on the server', async () => licenseOnServer(profile.id, 'QA-RESUME-1') || null, { timeoutMs: 60000, intervalMs: 500 });

  await qa.feature('AUTH-002', 'Clerk replaces the session object while the identity and membership answers are on their way, and one membership answer is cut off: the account loads with no reload prompt', async () => {
    const since = nowSql();
    const init = [];          // { subject, status, swap, at }
    const entitlements = [];  // { status, cut, sent, full, swap, at }
    let cutDone = false;
    let swapsAfterCut = 0;
    await page.route(fn('initialize-clerk-profile'), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const entry = { subject: subjectOf(route.request()), status: null, swap: null, at: Date.now() };
      init.push(entry);
      const response = await route.fetch().catch(() => null);
      if (!response) return route.abort('failed');
      entry.status = response.status();
      // The answer is back at the browser's door: Clerk refreshes its client now, as on a resume.
      if (init.length === 1) entry.swap = await replaceSession(page);
      return route.fulfill({ response });
    });
    await page.route(fn('billing-entitlements'), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const entry = { status: null, cut: false, sent: null, full: null, swap: null, at: Date.now() };
      entitlements.push(entry);
      const response = await route.fetch().catch(() => null);
      if (!response) return route.abort('failed');
      entry.status = response.status();
      const body = await response.body();
      entry.full = body.length;
      if (!cutDone && entry.status === 200) {
        // The first 200 answer arrives cut off: its headers say 200, its body stops halfway.
        cutDone = true;
        entry.cut = true;
        const half = body.subarray(0, Math.max(1, Math.floor(body.length / 2)));
        entry.sent = half.length;
        return route.fulfill({ status: 200, headers: passOn(response.headers()), body: half });
      }
      // The next answer: Clerk replaces the session object again while it is on its way.
      if (cutDone && swapsAfterCut === 0) { swapsAfterCut += 1; entry.swap = await replaceSession(page); }
      entry.sent = body.length;
      return route.fulfill({ status: entry.status, headers: passOn(response.headers()), body });
    });
    const reports = watchReports(page);
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const where = await loadEnd(page);
      await qa.shot('after the replaced session and the cut-off answer');
      const text = await bodyText(page);
      qa.check('the account loads to the member app (no identity stop, no gate)', where === 'member', `${where}; ${(text.match(STOP_REFERENCE) || [''])[0]} ${text.slice(0, 200)}`);
      // The membership answer after the cut-off one, accepted under the replaced session.
      const answered = await waitFor('a membership answer after the cut-off one', async () => (
        entitlements.some((e) => !e.cut && e.status === 200 && entitlements.indexOf(e) > entitlements.findIndex((x) => x.cut)) ? true : null),
      { timeoutMs: 30000, intervalMs: 250 }).catch(() => false);
      // Past both retry pauses of the identity read (1 s and 3 s) and the membership check's first (1 s).
      await sleep(6000);
      const after = await bodyText(page);
      const swaps = await page.evaluate(() => ({ replaced: window.Clerk.sessionObjectsReplaced || 0, id: window.Clerk.session?.id || null, user: window.Clerk.user?.id || null }));
      qa.check('Clerk replaced the session object mid-load, same session id and user', init[0]?.swap?.replaced === true && init[0]?.swap?.userId === user.id && swaps.user === user.id && swaps.replaced >= 1,
        JSON.stringify({ first: init[0]?.swap, now: swaps }));
      // The membership check runs only once ensureProfile has returned (useLimitedLaunchAccess:
      // profileReady), so the identity reads sent before the first check are the load's own: one
      // means the replaced object's answer was taken, two or three that it was thrown away and
      // tried again (1 s, 3 s). A read after an accepted answer is AppContext's designed second
      // load once write access arrives (reconciledAccess), not a retry.
      const firstCheckAt = entitlements[0]?.at ?? Infinity;
      const beforeCheck = init.filter((e) => e.at < firstCheckAt);
      qa.check('the identity read answered 200 and was taken from its one request (not rescued by a retry)',
        entitlements.length > 0 && beforeCheck.length === 1 && beforeCheck[0].status === 200 && init.every((e) => e.subject === user.id),
        JSON.stringify(init.map((e) => ({ same: e.subject === user.id, status: e.status, msAfterFirstCheck: Number.isFinite(firstCheckAt) ? e.at - firstCheckAt : null }))));
      qa.check('one membership answer came back 200 and was cut off halfway', entitlements.some((e) => e.cut && e.sent < e.full),
        JSON.stringify(entitlements.map(({ status, cut, sent, full }) => ({ status, cut, sent, full }))));
      qa.check('the next membership check answered 200 under a replaced session object', answered === true && entitlements.some((e) => e.swap?.replaced === true && e.status === 200),
        JSON.stringify(entitlements.map(({ status, cut, swap }) => ({ status, cut, swapped: !!swap?.replaced }))));
      qa.check('no reload prompt, at any point after the answers', !RELOAD_PROMPT.test(after) && !(await page.getByRole('button', { name: 'Reload', exact: true }).count()), after.slice(0, 200));
      const stopReports = reports.sent.filter((b) => /Account load stopped/.test(b));
      const stopRows = rows(`select message from public.client_errors where auth_user_id = '${user.id}' and created_at >= '${since}' and message like 'Account load stopped%'`);
      qa.check('no "Account load stopped" report, sent or stored', stopReports.length === 0 && stopRows.length === 0, JSON.stringify({ sent: stopReports.map((b) => b.slice(0, 160)), stored: stopRows }));
      // The cut-off answer is a failed check like any other: reported once by its phase, then retried.
      const cutReport = reports.sent.filter((b) => /Membership check failed \(response:200/.test(b));
      qa.check('the cut-off answer is reported as the check it was (response:200) and retried, not an account stop', cutReport.length >= 1,
        JSON.stringify(reports.sent.map((b) => (b.match(/"message":"([^"]{0,120})/) || [])[1]).filter(Boolean)));
      const cutMessage = 'Membership check failed (response:200:membership_information_unavailable)';
      const cutRows = await waitFor('the exact report for the deliberately cut-off membership answer', async () => {
        const found = rows(`select id, message, kind, auth_user_id from public.client_errors where auth_user_id = '${user.id}' and kind = 'error' and message = '${cutMessage}' and created_at >= '${since}'`);
        return found.length ? found : null;
      }, { timeoutMs: 10000, intervalMs: 100 });
      qa.check('the one deliberately cut-off answer has one persisted report', cutRows.length === 1);
      qa.intentionalClientErrors(cutRows, { message: cutMessage, kind: 'error', authUserId: user.id, count: 1,
        reason: 'AUTH-002 cut exactly one observed 200 membership body in half; the next full answer was accepted and this same account loaded without an identity stop.' });
      await openCredentials(page, 'Licenses');
      qa.check('the license added before the reload is shown', await tableRow(page, 'QA-RESUME-1').isVisible().catch(() => false));
    } finally {
      reports.stop();
      await page.unroute(fn('initialize-clerk-profile')).catch(() => {});
      await page.unroute(fn('billing-entitlements')).catch(() => {});
    }
    // A write under the replaced session object (writeContext compares the session by id and user).
    await addLicenseByHand(page, 'QA-RESUME-2');
    const saved = await waitFor('the second license on the server', async () => licenseOnServer(profile.id, 'QA-RESUME-2') || null, { timeoutMs: 60000, intervalMs: 500 }).catch(() => false);
    const queued = await pendingOps(page).catch(() => ['unreadable']);
    qa.check('a license added after the replaced session reaches the server, nothing left queued', saved === true && queued.length === 0, JSON.stringify({ saved, queued: queued.length }));
  }, { soft: true });

  await qa.feature('AUTH-011', 'another physician signs in while the first account\'s identity answer is on its way: that load stops, is not tried again, and shows none of its records', async () => {
    const other = await createPhysician({ firstName: 'Sam', lastName: 'Switch' });
    const before = profileOf(user.id);
    const licensesBefore = rows(`select id, updated_at from public.licenses where user_id = '${profile.id}' order by id`);
    const init = [];   // { subject, status, switched }
    let switchedAt = null;
    let switched = null;
    await page.route(fn('initialize-clerk-profile'), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const entry = { subject: subjectOf(route.request()), status: null, at: Date.now() };
      init.push(entry);
      const response = await route.fetch().catch(() => null);
      if (!response) return route.abort('failed');
      entry.status = response.status();
      if (entry.subject === user.id && !switchedAt) {
        // The first account's answer is at the door: another physician signs in on this page.
        switched = await page.evaluate((id) => window.Clerk.signInAs(id).then((s) => ({ id: s.id, user: window.Clerk.user?.id })), other.id)
          .catch((e) => ({ error: String(e?.message || e).slice(0, 160) }));
        switchedAt = Date.now();
      }
      return route.fulfill({ response });
    });
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const where = await loadEnd(page);
      // Past both retry pauses (1 s and 3 s) the first account's read would have taken.
      await sleep(8000);
      await qa.shot('after the account switch');
      const text = await bodyText(page);
      const signedInAs = await page.evaluate(() => window.Clerk.user?.id || null);
      qa.check('the other physician signed in mid-load', switched?.user === other.id && signedInAs === other.id, JSON.stringify({ switched, signedInAs: signedInAs === other.id ? 'other' : signedInAs === user.id ? 'first' : signedInAs }));
      const first = init.filter((e) => e.subject === user.id);
      const firstAfter = first.filter((e) => switchedAt && e.at > switchedAt);
      qa.check('the first account\'s identity read is not tried again after the switch', first.length === 1 && firstAfter.length === 0,
        JSON.stringify(init.map((e) => ({ who: e.subject === user.id ? 'first' : e.subject === other.id ? 'other' : 'unknown', status: e.status, afterSwitch: !!switchedAt && e.at > switchedAt }))));
      qa.check('the page ends on the other physician\'s own membership gate, no reload prompt', where === 'gate' && !RELOAD_PROMPT.test(text), `${where}; ${text.slice(0, 200)}`);
      qa.check('none of the first account\'s records show', !/QA-RESUME-/.test(text) && !/Rhea|Resume/.test(text), text.slice(0, 200));
      const otherProfile = profileOf(other.id);
      const after = profileOf(user.id);
      const licensesAfter = rows(`select id, updated_at from public.licenses where user_id = '${profile.id}' order by id`);
      qa.check('the first account is unchanged on the server (profile and licenses), the other has its own profile',
        after.id === before.id && after.access_status === before.access_status && JSON.stringify(licensesAfter) === JSON.stringify(licensesBefore)
          && !!otherProfile && otherProfile.id !== before.id && otherProfile.auth_user_id === other.id,
        JSON.stringify({ firstStatus: after.access_status, licenses: licensesAfter.length, other: otherProfile ? otherProfile.access_status : null }));
    } finally {
      await page.unroute(fn('initialize-clerk-profile')).catch(() => {});
    }
  }, { soft: true });
});
