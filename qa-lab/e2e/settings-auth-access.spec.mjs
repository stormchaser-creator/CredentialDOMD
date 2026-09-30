// Signing in and membership checks, the way members meet them: the note that
// appears while the membership check keeps failing (and its buttons), the
// screen when account setup cannot finish, the admin-only tier preview that a
// non-admin's URL must not unlock, an invitation link captured before sign-in
// and kept out of error reports, a change of the sign-in email moving the
// mailbox docs@ routes on, and a pre-cutover member keeping their records when
// they sign in under the new Clerk. Failures are made in the member's own
// browser (Playwright routing, offline); the database and the mock inbox say
// what the server did. Nothing leaves this machine.
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, createPhysician, emails, field, lab, labExec, landing, mockApi, newMember, openCredentials, profileOf,
  row, rows, signIn, sleep, stamp, syntheticPdf, tableRow, waitFor, waitForMemberApp, waitForProfile,
} from './support/lab.mjs';
import { openSettings } from './support/settings-auth-helpers.mjs';

const nowSql = () => new Date().toISOString();
const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const RECONNECTING = 'Reconnecting to your account.';
const fn = (name) => `**/functions/v1/${name}`;

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

test('membership check notices: reconnecting while checks fail, Try again, Check again, Reload; writes refused not lost', {
  tag: ['@AUTH-009'],
}, async ({ page, context, qa, secondBrowser }) => {
  test.setTimeout(9 * 60 * 1000);
  const { user } = await newMember(page, { firstName: 'Nia', lastName: 'Notice' });
  await addLicenseByHand(page, 'QA-NOTICE-1');
  const phoneBefore = profileOf(user.id).phone;

  await qa.feature('AUTH-009', 'Offline while signed in: the note appears only once the check keeps failing; saves are refused out loud; back online it clears by itself', async () => {
    await openSettings(page);
    const t0 = Date.now();
    await context.setOffline(true);
    // Coming back to the app (focus) asks for a fresh answer, which now fails and is retried.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(4000);
    const early = await page.getByText(RECONNECTING).count();
    qa.check('no note for the first failed checks (a single slow resume says nothing)', early === 0, `${early} note(s) after 4 s`);
    const note = page.getByRole('status').filter({ hasText: RECONNECTING });
    const shown = await note.waitFor({ timeout: 70000 }).then(() => true, () => false);
    const after = Math.round((Date.now() - t0) / 1000);
    await qa.shot('reconnecting note');
    qa.check('after sustained failure a small "Reconnecting to your account." note appears', shown, `after ${after} s`);
    // The screens stay usable: Credentials still lists the license.
    await openCredentials(page, 'Licenses');
    qa.check('Credentials still opens with the saved license', await tableRow(page, 'QA-NOTICE-1').isVisible().catch(() => false));
    // A save is refused with a message, never silently dropped.
    await openSettings(page);
    const dialogsBefore = qa.report.dialogs.length;
    await page.getByPlaceholder('(555) 123-4567').fill('(555) 010-0142');
    await sleep(1500);
    const refused = qa.report.dialogs.slice(dialogsBefore);
    qa.check('the edit is refused with a message', refused.length > 0, refused.join(' | ') || 'no message');
    const answered = page.waitForResponse((r) => r.url().includes('/functions/v1/billing-entitlements') && r.request().method() === 'POST', { timeout: 30000 }).then((r) => r.status(), () => null);
    await context.setOffline(false);
    const cleared = await note.waitFor({ state: 'detached', timeout: 30000 }).then(() => true, () => false);
    qa.check('back online the note clears by itself', cleared);
    const entitlements = await answered;
    await sleep(1500);
    qa.check('the refused edit did not reach the profile', profileOf(user.id).phone === phoneBefore, JSON.stringify({ before: phoneBefore, now: profileOf(user.id).phone }));
    qa.check('billing-entitlements answers 200 after reconnect', entitlements === 200, `status ${entitlements}`);
  }, { soft: true });

  await qa.feature('AUTH-009', '"Try again" on the note: refused while the check still fails, clears once it succeeds', async () => {
    await page.route(fn('billing-entitlements'), (r) => r.abort('failed'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const note = page.getByRole('status').filter({ hasText: RECONNECTING });
    const shown = await note.waitFor({ timeout: 75000 }).then(() => true, () => false);
    qa.check('the note appears again while billing-entitlements cannot be reached', shown);
    if (!shown) { await page.unroute(fn('billing-entitlements')); return; }
    await note.getByRole('button', { name: 'Try again' }).click();
    await sleep(2500);
    qa.check('"Try again" while it still fails keeps the note', await note.isVisible().catch(() => false));
    await page.unroute(fn('billing-entitlements'));
    const ok = page.waitForResponse((r) => r.url().includes('/functions/v1/billing-entitlements') && r.request().method() === 'POST', { timeout: 20000 }).then((r) => r.status(), () => null);
    await note.getByRole('button', { name: 'Try again' }).click();
    const status = await ok;
    const gone = await note.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
    qa.check('"Try again" after the fault clears the note (billing-entitlements 200)', gone && status === 200, `status ${status}`);
  }, { soft: true });

  await qa.feature('AUTH-009', 'A build that cannot read the answer asks for a reload; "Reload" recovers', async () => {
    // An answer this build cannot read (an empty object) is what an old cached app meets after a server change.
    await page.route(fn('billing-entitlements'), (r) => (r.request().method() === 'OPTIONS' ? r.fallback() : r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': lab().urls.appOrigin }, body: '{}' })));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const reload = page.getByRole('status').getByRole('button', { name: 'Reload' });
    const shown = await reload.waitFor({ timeout: 20000 }).then(() => true, () => false);
    const noteText = shown ? await page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Reload' }) }).first().innerText() : '';
    await qa.shot('outdated note');
    qa.check('an unreadable answer shows a note with a Reload button (no retry loop)', shown, noteText.replace(/\s+/g, ' ').slice(0, 160));
    await page.unroute(fn('billing-entitlements'));
    if (shown) {
      await reload.click();
      await waitForMemberApp(page);
      await sleep(3000);
      qa.check('after Reload the note is gone', !(await page.getByRole('status').getByRole('button', { name: 'Reload' }).count()));
    }
  }, { soft: true });

  await qa.feature('AUTH-009', 'A second browser that has never had an answer: "Checking membership." with "Check again"', async () => {
    const other = await secondBrowser();
    await other.page.route(fn('billing-entitlements'), (r) => r.abort('failed'));
    await signIn(other.page, user);
    await landing(other.page);
    const checking = other.page.getByRole('status').filter({ hasText: /Checking membership\.|Reconnecting to your account\./ });
    const shown = await checking.waitFor({ timeout: 30000 }).then(() => true, () => false);
    const txt = shown ? (await checking.innerText()).replace(/\s+/g, ' ') : '';
    await other.page.screenshot({ path: (await qa.shot('checking membership')).replace(/\.png$/, '-second.png') });
    qa.check('the saved records show with a "Checking membership." note', shown && /Checking membership\./.test(txt), txt.slice(0, 160));
    await other.page.unroute(fn('billing-entitlements'));
    const again = checking.getByRole('button', { name: /Check again|Try again/ });
    if (await again.count()) await again.click();
    const gone = await checking.waitFor({ state: 'detached', timeout: 20000 }).then(() => true, () => false);
    qa.check('"Check again" once the check can succeed clears the note', gone);
    await other.context.close();
  }, { soft: true });
});

test('account setup failure screen: a readable message and a working Try again; enrollment failure on the gate', {
  tag: ['@AUTH-011', '@AUTH-013'],
}, async ({ page, qa, secondBrowser }) => {
  test.setTimeout(8 * 60 * 1000);
  const { user } = await newMember(page, { firstName: 'Ira', lastName: 'Initfail' });
  await addLicenseByHand(page, 'QA-INIT-1', 'UT');
  const before = profileOf(user.id);
  const since = nowSql();

  await qa.feature('AUTH-011', 'initialize-clerk-profile blocked: a message under the logo and Try again; unblocked, one tap reaches Home with every record', async () => {
    const sent = [];
    page.on('request', (r) => { if (r.url().includes('/functions/v1/report-error') && r.method() === 'POST') sent.push({ body: r.postData() || '', response: r.response() }); });
    await page.route(fn('initialize-clerk-profile'), (r) => r.abort('failed'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const status = page.getByRole('status').first();
    await status.waitFor({ timeout: 60000 });
    await sleep(3000);
    const msg = (await status.innerText()).replace(/\s+/g, ' ');
    const tryAgain = page.getByRole('button', { name: 'Try again' });
    await qa.shot('setup failed');
    qa.check('a readable failure message, not "Checking your membership…"', !/^Checking your membership/.test(msg) && /could not|Reload to try again/i.test(msg), msg.slice(0, 200));
    qa.check('a "Try again" button is offered', await tryAgain.isVisible().catch(() => false));
    await tryAgain.click();
    await page.getByRole('status').first().waitFor({ timeout: 60000 });
    await sleep(3000);
    const again = (await page.getByRole('status').first().innerText()).replace(/\s+/g, ' ');
    qa.check('Try again while still blocked shows the same readable failure (never an endless check)', /could not|Reload to try again/i.test(again) && await tryAgain.isVisible().catch(() => false), again.slice(0, 160));
    await page.unroute(fn('initialize-clerk-profile'));
    await tryAgain.click();
    await waitForMemberApp(page, 60000).catch(() => {});
    await openCredentials(page, 'Licenses');
    qa.check('after unblocking, one tap reaches the app with the license', await tableRow(page, 'QA-INIT-1').isVisible().catch(() => false));
    const stops = sent.filter((x) => /Account load stopped/.test(x.body));
    const statuses = await Promise.all(stops.map(async (x) => (await x.response.catch(() => null))?.status() ?? null));
    qa.check('the app reports the stop with a support reference only', stops.length > 0 && stops.every((x) => /"message":"Account load stopped \([A-Z0-9-]+\)\."/.test(x.body)), `${stops.length} report(s), statuses ${statuses.join(', ')}`);
    const reports = rows(`select message from public.client_errors where created_at > '${since}' and auth_user_id = '${user.id}' and message like 'Account load stopped%'`);
    if (statuses.length && statuses.every((st) => st === 429)) {
      qa.blocked('AUTH-011', 'report-error answered 429 (its cap is 30 rows per hashed IP per 10 minutes, and every journey on the shared lab reports from 127.0.0.1); the report payload was checked in the browser instead of the stored client_errors row.');
    } else qa.check('client_errors records the stop', reports.length > 0 && reports.every((r) => /^Account load stopped \([A-Z0-9-]+\)\.$/.test(r.message)), JSON.stringify(reports.slice(0, 3)));
    const after = profileOf(user.id);
    qa.check('the profiles row is unchanged (same id, still active)', after.id === before.id && after.access_status === 'active' && after.auth_user_id === before.auth_user_id);
  }, { soft: true });

  await qa.feature('AUTH-011', 'bootstrap-launch-access blocked: a member still opens the app', async () => {
    await page.route(fn('bootstrap-launch-access'), (r) => r.abort('failed'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const where = await landing(page);
    await sleep(2000);
    const msg = await bodyText(page);
    qa.check('the full member reaches the app (enrollment is not needed for a member)', where === 'member' && !/Checking your membership…/.test(msg), where);
    await page.unroute(fn('bootstrap-launch-access'));
  }, { soft: true });

  await qa.feature('AUTH-011', 'bootstrap-launch-access blocked for a new signup: the gate says so and "Check membership again" recovers', async () => {
    const other = await secondBrowser();
    const person = await createPhysician({ firstName: 'Una', lastName: 'Enroll' });
    await other.page.route(fn('bootstrap-launch-access'), (r) => r.abort('failed'));
    await signIn(other.page, person);
    const where = await landing(other.page);
    await sleep(3000);
    const gate = other.page.getByRole('region', { name: 'Membership' });
    const txt = (await gate.innerText().catch(() => bodyText(other.page))).replace(/\s+/g, ' ');
    await other.page.screenshot({ path: (await qa.shot('enrollment failed gate')).replace(/\.png$/, '-signup.png') });
    const recheck = other.page.getByRole('button', { name: /Check membership again|Check access again/ }).first();
    qa.check('the new signup sees the gate with a readable message and a retry button (not an endless check)', where === 'gate' && await recheck.isVisible().catch(() => false) && !/Checking your membership…$/.test(txt), `${where}: ${txt.slice(0, 200)}`);
    await other.page.unroute(fn('bootstrap-launch-access'));
    await recheck.click();
    const offer = await other.page.getByRole('button', { name: /Review .* offer/ }).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('after unblocking, the retry shows the membership offer', offer);
    qa.check('the new profile is pending, as any signup', profileOf(person.id)?.access_status === 'pending');
    await other.context.close();
  }, { soft: true });

  qa.blocked('AUTH-013', 'Clerk\'s own sign-in card is not reproduced: the QA-lab build replaces Clerk with the QA sign-in (no password step, no "Email me a sign-in code instead", no "Forgot password?"), and the checklist\'s path needs real email to a QA mailbox and a Clerk password reset, which the lab rules forbid (no real services, no passwords). SIGN_IN_LOCALIZATION wording is covered offline by scripts/sign-in-methods.test.mjs.');
});

test('admin tier preview in the URL is ignored for a non-admin (unpaid signup and paid member)', {
  tag: ['@AUTH-017'],
}, async ({ page, qa, secondBrowser }) => {
  test.setTimeout(6 * 60 * 1000);
  const person = await createPhysician({ firstName: 'Pat', lastName: 'Preview' });
  await signIn(page, person);
  const first = await landing(page);
  const prof = await waitForProfile(person.id);

  await qa.feature('AUTH-017', '?preview_tier=locum / practice / clear unlock nothing for an unpaid signup', async () => {
    qa.check('the unpaid signup starts on the membership gate', first === 'gate', first);
    const results = [];
    for (const tier of ['locum', 'practice', 'pro', 'clear']) {
      await page.goto(`${lab().urls.app}?preview_tier=${tier}`, { waitUntil: 'domcontentloaded' });
      const where = await landing(page);
      const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => /preview/i.test(k)));
      const practiceTab = await page.getByRole('navigation').getByRole('button', { name: /Practice/ }).count();
      results.push({ tier, where, keys, practiceTab });
    }
    await qa.shot('preview ignored');
    qa.check('every preview URL still lands on the membership gate ("Your membership")', results.every((r) => r.where === 'gate'), JSON.stringify(results));
    qa.check('no preview key is written to localStorage', results.every((r) => r.keys.length === 0), JSON.stringify(results.map((r) => r.keys)));
    qa.check('no Practice tab or record screen becomes reachable', results.every((r) => r.practiceTab === 0));
    const tables = ['licenses', 'cme', 'documents', 'education', 'work_history', 'case_logs'];
    const counts = Object.fromEntries(tables.map((t) => [t, rows(`select id from public.${t} where user_id = '${prof.id}'`).length]));
    qa.check('no rows in synced tables for the unpaid profile', Object.values(counts).every((n) => n === 0), JSON.stringify(counts));
    qa.check('the profile is still pending', profileOf(person.id).access_status === 'pending');
  }, { soft: true });

  await qa.feature('AUTH-017', 'A paid non-admin member: ?preview_tier=practice writes no preview key and changes no access', async () => {
    const other = await secondBrowser();
    const { user } = await newMember(other.page, { firstName: 'Mo', lastName: 'Member' });
    const snapBefore = await other.page.evaluate(() => Object.keys(localStorage).filter((k) => /preview/i.test(k)));
    await other.page.goto(`${lab().urls.app}?preview_tier=practice`, { waitUntil: 'domcontentloaded' });
    await waitForMemberApp(other.page);
    await sleep(1500);
    const keys = await other.page.evaluate(() => Object.keys(localStorage).filter((k) => /preview/i.test(k)));
    qa.check('no preview key for a non-admin member', keys.length === 0 && snapBefore.length === 0, JSON.stringify(keys));
    qa.check('the member is not an admin', !row(`select 1 as x from public.app_admins a join public.profiles p on p.id = a.profile_id where p.auth_user_id = '${user.id}'`));
    await other.context.close();
  }, { soft: true });
});

test('invitation link: captured before sign-in, removed from the address bar, kept out of error reports, grants nothing', {
  tag: ['@AUTH-015', '@AUTH-007'],
}, async ({ page, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const token = randomBytes(33).toString('base64url').slice(0, 44);
  const since = nowSql();
  const invitee = `invited-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
  const policy = row('select limited_invitation_enabled from public.access_policy_settings where singleton');
  let person;

  await qa.feature('AUTH-015', 'Opening the link signed out: the token leaves the address bar and is held for this tab only', async () => {
    // The invited address exists on the (QA) sign-in before the link is opened, as it would at Clerk.
    person = await createPhysician({ firstName: 'Ivy', lastName: 'Invited', email: invitee });
    await page.goto(`${lab().urls.app}#launch_invite=${token}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
    const url = page.url();
    const held = await page.evaluate(() => ({ session: sessionStorage.getItem('credentialdomd.launch_invitation'), local: Object.keys(localStorage).filter((k) => /invit/i.test(k)) }));
    qa.check('the token is gone from the address bar', !url.includes(token) && !url.includes('launch_invite'), url);
    qa.check('the token is kept in sessionStorage only', held.session === token && held.local.length === 0, JSON.stringify({ session: held.session ? 'held' : null, local: held.local }));
    await page.locator(`[data-testid="qa-signin-as"][data-user-id="${person.id}"]`).click();
    const where = await landing(page);
    qa.check('signing in in the same tab lands on the gate', where === 'gate', where);
    const still = await page.evaluate(() => sessionStorage.getItem('credentialdomd.launch_invitation'));
    qa.check('the token survived the sign-in in this tab', still === token);
  }, { soft: true });

  await qa.feature('AUTH-007', 'Activate my invitation: not offered while invitations are off (the launch setting); the token grants nothing', async () => {
    const gate = (await page.getByRole('region', { name: 'Membership' }).innerText()).replace(/\s+/g, ' ');
    await qa.shot('gate with invitation token');
    qa.check('access_policy_settings.limited_invitation_enabled is off, as at launch', policy?.limited_invitation_enabled === false, JSON.stringify(policy));
    qa.check('no "Activate my invitation" while activation is off; the public offer is shown instead', !(await page.getByRole('button', { name: 'Activate my invitation' }).count()) && /Review .* offer|Choose whether to purchase/.test(gate), gate.slice(0, 200));
    qa.check('the profile stays pending (a link grants nothing by itself)', profileOf(person.id)?.access_status === 'pending');
    // Public signup writes its own self_service enrollment row (origin self_service); a reviewed invitation is never consumed.
    const inv = rows(`select origin, claimed_at from public.limited_billing_invitations where clerk_subject = '${person.id}' or lower(email) = '${invitee}'`);
    qa.check('no reviewed invitation was consumed by this account (only the public self-service enrollment)', inv.every((r) => r.origin === 'self_service'), JSON.stringify(inv));
    qa.blocked('AUTH-007', 'Invitation activation is switched off in production (access_policy_settings.limited_invitation_enabled = false, invitations OFF at launch) and the lab mirrors it; turning the shared switch on would change every other journey\'s gate, and invitations are issued only by the operator SQL prepare_limited_billing_invitations (no admin screen). The gate correctly offers no activation.');
  }, { soft: true });

  await qa.feature('AUTH-015', 'A client error carrying the token is reported with it redacted', async () => {
    const sent = [];
    page.on('request', (r) => { if (r.url().includes('/functions/v1/report-error') && r.method() === 'POST') sent.push({ body: r.postData() || '', response: r.response() }); });
    await page.evaluate((t) => {
      setTimeout(() => { throw new Error(`QA forced error while opening /app/#launch_invite=${t}`); }, 0);
      setTimeout(() => { Promise.reject(new Error(`QA forced rejection {"launch_invite":"${t}"}`)); }, 50);
    }, token);
    await sleep(1500);
    const reported = await waitFor('the forced reports', async () => {
      const r = rows(`select message, stack, url from public.client_errors where created_at > '${since}' and message like 'QA forced%'`);
      return r.length >= 2 ? r : null;
    }, { timeoutMs: 15000, intervalMs: 1000 }).catch(() => rows(`select message, stack, url from public.client_errors where created_at > '${since}' and message like 'QA forced%'`));
    const forced = sent.filter((x) => /QA forced/.test(x.body));
    const statuses = await Promise.all(forced.map(async (x) => (await x.response.catch(() => null))?.status() ?? null));
    qa.check('the browser sent both reports with the token replaced by "[redacted]"', forced.length >= 2 && forced.every((x) => /\[redacted\]/.test(x.body) && !x.body.includes(token)), `${forced.length} sent; statuses ${statuses.join(', ')}`);
    if (statuses.length && statuses.every((st) => st === 429)) {
      qa.blocked('AUTH-015', `report-error answered 429 to both reports: its cap is 30 rows per hashed IP per 10 minutes (supabase/functions/report-error/index.ts:44-45,135), and every journey on the shared lab reports from 127.0.0.1, so parallel runs exhaust it. The payload check above covers the client redaction; the stored row could not be read back this run.`);
    } else {
      qa.check('both forced errors reached client_errors', reported.length >= 2, `${reported.length} row(s); statuses ${statuses.join(', ')}`);
      qa.check('each stored report shows "[redacted]" where the token was', reported.length > 0 && reported.every((r) => /\[redacted\]/.test(r.message)), reported.map((r) => r.message).join(' | ').slice(0, 300));
    }
    const leaks = rows(`select id from public.client_errors where message like '%${token}%' or coalesce(stack, '') like '%${token}%' or coalesce(url, '') like '%${token}%'`);
    qa.check('the token text is nowhere in client_errors', leaks.length === 0, `${leaks.length} row(s)`);
    const unredacted = rows(`select id from public.client_errors where message like '%launch_invite%' and message not like '%[redacted]%'`);
    qa.check('lab-wide: no client_errors message names launch_invite without [redacted]', unredacted.length === 0, `${unredacted.length} row(s)`);
  }, { soft: true });
});

test('a new primary sign-in email moves the verified mailbox; docs@ files from the new address and refuses the old', {
  tag: ['@AUTH-016'],
}, async ({ page, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Eli', lastName: 'Emailmove' });
  const oldAddress = user.email;
  const newAddress = `moved-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
  const AUTH_PASS = { 'authentication-results': `mx.qa.credentialdomd.test; dmarc=pass header.from=${LAB_EMAIL_DOMAIN}; spf=pass smtp.mailfrom=${LAB_EMAIL_DOMAIN}; dkim=pass header.d=${LAB_EMAIL_DOMAIN}` };
  const inbound = (from, name) => mockApi('/qa/inbound', { method: 'POST', body: {
    from, to: ['docs@credentialdomd.com'], subject: `Fwd: ${name}`, text: 'Forwarding a synthetic document.', headers: AUTH_PASS,
    attachments: [{ filename: name, content_type: 'application/pdf', content: syntheticPdf(`QA synthetic ${name} ${Date.now()}`).toString('base64') }],
  } });

  await qa.feature('AUTH-016', 'The provider makes a second address primary; profiles.verified_email follows', async () => {
    const start = await waitFor('the first verified mailbox', async () => { const p = profileOf(user.id); return p?.verified_email ? p : null; }, { timeoutMs: 30000 }).catch(() => profileOf(user.id));
    qa.check('the member starts with the sign-up address verified', start?.verified_email === oldAddress, start?.verified_email);
    const changed = await mockApi(`/qa/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: { email: newAddress, makePrimary: true } });
    const delivery = await waitFor('the user.updated webhook', async () => {
      const d = (await mockApi('/qa/clerk/webhooks')).deliveries.find((x) => x.id === changed.webhook);
      return d && d.state !== 'pending' && d.state !== 'retrying' ? d : null;
    }, { timeoutMs: 90000, intervalMs: 1000 }).catch(() => null);
    qa.check('clerk-webhook accepted user.updated', delivery?.state === 'delivered', JSON.stringify(delivery && { state: delivery.state, status: delivery.status }));
    const moved = await waitFor('verified_email to move', async () => { const p = profileOf(user.id); return p?.verified_email === newAddress ? p : null; }, { timeoutMs: 30000 }).catch(() => profileOf(user.id));
    qa.check('profiles.verified_email is the new primary', moved?.verified_email === newAddress, moved?.verified_email);
    const claims = rows(`select address, profile_id, terminal_at from public.mailbox_claims where profile_id = '${profile.id}' or address in ('${oldAddress}', '${newAddress}')`);
    qa.check('mailbox_claims: the new address belongs to this account, the old one no longer does', claims.some((c) => c.address === newAddress && c.profile_id === profile.id) && !claims.some((c) => c.address === oldAddress && c.profile_id === profile.id), JSON.stringify(claims));
  }, { soft: true });

  await qa.feature('AUTH-016', 'A document forwarded from the new address is filed; from the old address it gets the not-registered reply', async () => {
    await inbound(`Eli Emailmove <${newAddress}>`, 'qa-moved-new.pdf');
    const filed = await waitFor('the filed document', async () => row(`select name, storage_path from public.documents where user_id = '${profile.id}' and name = 'qa-moved-new.pdf'`), { timeoutMs: 60000 }).catch(() => null);
    const inNew = row(`select route, status, profile_id from public.inbound_emails where from_addr ilike '%${newAddress}%' order by created_at desc limit 1`);
    qa.check('from the new address: filed on this account', !!filed?.storage_path && inNew?.profile_id === profile.id, JSON.stringify(inNew));
    await inbound(`Eli Emailmove <${oldAddress}>`, 'qa-moved-old.pdf');
    const reply = await waitFor('the not-registered reply', async () => (await emails({ to: oldAddress })).find((m) => !/Welcome/i.test(m.subject)) || null, { timeoutMs: 60000, intervalMs: 1500 }).catch(() => null);
    const inOld = await waitFor('the old-address row', async () => row(`select route, status, profile_id from public.inbound_emails where from_addr ilike '%${oldAddress}%' order by created_at desc limit 1`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('from the old address: nothing filed', !rows(`select id from public.documents where name = 'qa-moved-old.pdf'`).length, JSON.stringify(inOld));
    qa.check('the old address gets the not-registered reply', !!reply, reply?.subject || 'no reply captured');
    qa.check('inbound_emails records the old-address mail as not routed to this account', inOld && inOld.profile_id !== profile.id, JSON.stringify(inOld));
  }, { soft: true });
});

test('pre-cutover member: the continuity binding attaches the new Clerk subject to the existing profile, never a new empty one', {
  tag: ['@AUTH-014'],
}, async ({ page, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const TARGET = 'https://clerk.qa.credentialdomd.test';
  const SOURCE = 'https://clerk-legacy.qa.credentialdomd.test';

  await qa.feature('AUTH-014', 'A staged legacy member with records binds to the same profile (local database, rolled back)', async () => {
    const r = randomBytes(15).toString('hex').replace(/[^a-z0-9]/gi, '').slice(0, 20);
    const pid = randomUUID();
    const email = `qa-legacy-fixture-${r.slice(0, 8)}@${LAB_EMAIL_DOMAIN}`;
    const proof = `jsonb_build_object('subject','user_qasrc${r}','email','${email}','issuer','${SOURCE}','createdMs','1788000000000','updatedMs','1789000000000','checkedAt', clock_timestamp())`;
    const ms = '(extract(epoch from clock_timestamp())*1000)::bigint';
    // One transaction, rolled back: the fixture (a legacy profile with a license, staged for
    // continuity) never outlives this statement, so the shared lab is unchanged.
    const out = labExec(`begin;
      insert into public.profiles (id, auth_user_id, name) values ('${pid}', 'user_qasrc${r}', 'QA Legacy Fixture');
      insert into public.licenses (user_id, type, license_number, state, expiration_date) values ('${pid}', 'State Medical License', 'QA-LEGACY-${r.slice(0, 4)}', 'CO', '2029-01-01');
      insert into public.clerk_continuity_accounts (run_id, profile_id, source_subject, verified_primary_email, source_user_updated_ms, source_user_created_ms, lifetime_eligible)
        select id, '${pid}', 'user_qasrc${r}', '${email}', 1789000000000, 1788000000000, false from public.clerk_continuity_runs where target_issuer = '${TARGET}';
      select 'BIND ' || public.initialize_clerk_profile('user_qatgt${r}', '${email}', '${TARGET}', ${ms}, clock_timestamp(), ${proof})::text;
      select 'AFTER ' || json_build_object('auth', auth_user_id, 'licenses', (select count(*) from public.licenses where user_id = '${pid}'), 'target_profiles', (select count(*) from public.profiles where auth_user_id = 'user_qatgt${r}'), 'state', (select state from public.clerk_continuity_accounts where source_subject = 'user_qasrc${r}'))::text from public.profiles where id = '${pid}';
      select 'AGAIN ' || public.initialize_clerk_profile('user_qatgt${r}', '${email}', '${TARGET}', ${ms}, clock_timestamp(), null)::text;
      select 'OLD ' || public.initialize_clerk_profile('user_qasrc${r}', '${email}', '${TARGET}', ${ms}, clock_timestamp(), null)::text;
      select 'OTHER ' || public.initialize_clerk_profile('user_qaother${r}', '${email}', '${TARGET}', ${ms}, clock_timestamp(), null)::text;
      select 'DUPES ' || count(*) from (select auth_user_id from public.profiles group by 1 having count(*) > 1) d;
      rollback;`);
    const line = (tag) => { const l = out.split('\n').find((x) => x.startsWith(`${tag} `)); try { return JSON.parse(l.slice(tag.length + 1)); } catch { return l ? l.slice(tag.length + 1) : null; } };
    const bind = line('BIND'); const after = line('AFTER'); const again = line('AGAIN'); const old = line('OLD'); const other = line('OTHER'); const dupes = line('DUPES');
    qa.check('the new subject binds to the existing profile (state bound, same profile id)', bind?.state === 'bound' && bind.profileId === pid, JSON.stringify(bind));
    qa.check('the profile keeps its license and now carries the new subject; no second profile', after?.auth === `user_qatgt${r}` && after.licenses === 1 && after.target_profiles === 1 && after.state === 'bound', JSON.stringify(after));
    qa.check('signing in again returns the same profile', again?.profileId === pid, JSON.stringify(again));
    qa.check('the retired legacy subject cannot open an empty account', ['identity_conflict', 'account_unavailable'].includes(old?.state), JSON.stringify(old));
    qa.check('another new subject with the same email cannot take the account or make an empty one', ['identity_conflict', 'account_unavailable'].includes(other?.state), JSON.stringify(other));
    qa.check('no auth subject has two profiles', String(dupes) === '0', String(dupes));
    qa.check('the fixture was rolled back', !row(`select 1 as x from public.profiles where id = '${pid}'`));
  }, { soft: true });

  await qa.feature('AUTH-014', 'The seeded legacy member signs in under the lab\'s Clerk: bound to one profile, through initialize-clerk-profile', async () => {
    const acct = row(`select a.id, a.state, a.target_subject, a.profile_id, a.verified_primary_email from public.clerk_continuity_accounts a join public.clerk_continuity_runs r on r.id = a.run_id where r.target_issuer = '${TARGET}' and a.source_subject = 'user_qalegacy1'`);
    qa.check('the lab has its staged legacy member', !!acct, JSON.stringify(acct));
    if (!acct) return;
    let person;
    if (acct.state === 'prepared') {
      // The member's first sign-in under the new Clerk, with the same verified address.
      try {
        person = await createPhysician({ firstName: 'Legacy', lastName: 'Member', email: acct.verified_primary_email });
      } catch (e) {
        if (/email_taken/.test(String(e.message))) {
          qa.blocked('AUTH-014', `The browser half cannot run in the lab: the mock Clerk keeps one address book for both of its instances (qa-lab/mocks/clerk.mjs normalizeEmail refuses an address any test physician holds, legacy instance included), so the seeded legacy member's address (${acct.verified_primary_email}) cannot also be created on the live instance, which is exactly what a pre-cutover member signing in under the production Clerk is. The binding itself is exercised above on the local database.`);
          return;
        }
        throw e;
      }
    } else {
      // Already bound by an earlier run: sign in again as the bound account.
      const users = (await mockApi('/qa/users')).users || [];
      const u = users.find((x) => x.id === acct.target_subject);
      person = u ? { id: u.id, email: acct.verified_primary_email } : null;
    }
    qa.check('a live-instance account for the legacy address', !!person, person?.id);
    if (!person) return;
    await signIn(page, person);
    const where = await landing(page);
    await qa.shot('legacy member landing');
    const bound = row(`select state, target_subject, profile_id from public.clerk_continuity_accounts where id = '${acct.id}'`);
    const profiles = rows(`select id from public.profiles where auth_user_id = '${person.id}'`);
    const events = rows(`select kind from public.clerk_continuity_events where account_id = '${acct.id}' order by created_at`);
    qa.check('the sign-in reaches the app or its gate, not an identity error', where === 'gate' || where === 'member', where);
    qa.check('clerk_continuity_accounts: bound to this subject', bound?.state === 'bound' && bound.target_subject === person.id, JSON.stringify(bound));
    qa.check('exactly one profile for the subject, the continuity profile', profiles.length === 1 && profiles[0].id === bound?.profile_id, JSON.stringify(profiles));
    qa.check('clerk_continuity_events records the binding', events.some((e) => e.kind === 'bound'), JSON.stringify(events));
    const dupes = rows('select auth_user_id from public.profiles group by 1 having count(*) > 1');
    qa.check('lab-wide: no subject has two profiles', dupes.length === 0, JSON.stringify(dupes));
    const unbound = rows(`select a.profile_id from public.clerk_continuity_accounts a where a.state <> 'bound'`);
    qa.check('lab-wide: every staged legacy member is bound now', unbound.length === 0, `${unbound.length} unbound`);
  }, { soft: true });
});
