// The owner's daily flows on his installed iPhone app, judged by OUTCOME.
//
// Every journey here runs in Playwright's WebKit (Safari's engine) as an
// iPhone 15 home-screen app (iOS 18.7 user agent, 393 x 852, touch), whatever
// the run's configuration, with the iOS behaviour model of support/iphone-model.mjs:
// the page sent to the background and brought back (or discarded and reloaded
// while hidden, or restored from the back-forward cache), window.Clerk.session
// replaced by a new object of the same session on every return to the front
// (what Clerk's client refresh does as the app gets focus), the first API
// requests after a launch timing out, localStorage nearly full, no network at
// launch, and an iPad turned across the app's 1024 px desk breakpoint.
//
// Each check asks what the owner would ask: is the ticket he sent received
// once, is the edit he made on the server, is anything he typed lost, does the
// screen tell him the truth. Not whether the app's own screens behaved as
// designed. Nothing leaves this machine.
//
//   QA_E2E_RESULTS=qa-lab/.generated/runs/<name>.json QA_E2E_NO_RESTART=1 \
//     npm run qa:e2e -- iphone-owner-conditions.spec.mjs
import { devices } from '@playwright/test';
import { test } from './support/fixtures.mjs';
import {
  iphoneInitScript, clerkReplacesSessionOnFocus, toBackground, returnToApp, flakyLaunch, tightStorage, releaseStorage, sessionReplacements,
} from './support/iphone-model.mjs';
import {
  field, lab, letters, recordButtons, restAs, offlineCopy, openCredentials as deskOpenCredentials, pendingOps, row, rows, signIn, sleep, stamp, waitFor, waitForMemberApp,
} from './support/lab.mjs';
import { newPhoneMember, phoneCredentials, phoneMore } from './support/phone-helpers.mjs';
import { addLicense as deskAddLicense } from './support/sync-docs-intake-helpers.mjs';

// The installed app on a phone has the bottom tab bar (no landmark): its own navigation.
const openCredentials = phoneCredentials;
// A new member with taps, checking the founding offer again while the lab's shared places settle.
const newMember = (page, opts) => newPhoneMember(page, opts);
const openMore = phoneMore;
/** Credentials > Licenses > Add on the phone, saved; the license row once it is on the server. */
async function addLicense(page, profileId, { name, number }) {
  if ((page.viewportSize()?.width || 0) >= 1024) return deskAddLicense(page, profileId, { name, number });
  const dlg = await typeLicense(page, { name, number });
  await dlg.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
  await dlg.waitFor({ state: 'detached', timeout: 20000 });
  return waitFor('the license row', async () => row(`select * from public.licenses where user_id = '${profileId}' and license_number = '${number}'`), { timeoutMs: 30000 });
}

const IPHONE_APP = {
  ...devices['iPhone 15'],
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1',
  viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 },
};
delete IPHONE_APP.defaultBrowserType;
// Service workers blocked: in Playwright's WebKit a page its worker controls sends its
// requests past every route (measured: page.route and context.route never see the app's
// POSTs then), so neither the journey's holds nor the fixtures' nothing-leaves-this-machine
// guard would apply. The worker only serves the app shell offline, which Playwright's
// WebKit offline switch cannot show anyway (SYNC-005).
test.use({ ...IPHONE_APP, browserName: 'webkit', serviceWorkers: 'block' });
test.describe.configure({ mode: 'parallel' });

// The iOS model on every page of the journey's own context.
test.beforeEach(async ({ context }) => { await context.addInitScript(iphoneInitScript); });

const sq = (s) => String(s).replace(/'/g, "''");
const bodyText = async (page) => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
const fn = (name) => `**/functions/v1/${name}`;

/**
 * Holds the answer of the next request matching `pattern` until `during()` ran: the server has
 * already done the work (the request reached it), and the app reads the answer only afterwards.
 */
async function holdAnswer(page, pattern, during, { method = 'POST' } = {}) {
  let done;
  const finished = new Promise((r) => { done = r; });
  let used = false;
  await page.route(pattern, async (route) => {
    if (used || route.request().method() !== method) return route.fallback();
    used = true;
    let response = null;
    try { response = await route.fetch(); } catch { /* the request failed */ }
    try { await during(); } catch (e) { console.log('qa-ios: hold step failed', String(e?.message || e).slice(0, 160)); }
    if (response) await route.fulfill({ response }).catch(() => {}); else await route.abort('failed').catch(() => {});
    done(response ? response.status() : 0);
  });
  // -1: the request never passed the route (it would hang the journey otherwise).
  return Promise.race([finished, sleep(90000).then(() => -1)]);
}

/** Away to another app (Mail, Photos) and back: hidden, then visible with focus; Clerk replaces its session object. */
async function awayAndBack(page, awayMs = 400) {
  await toBackground(page);
  await returnToApp(page, { awayMs });
  await sleep(300);
}

/** The license the journey adds through the Add form (no blur, no save): the fields he typed. */
async function typeLicense(page, { name, number }) {
  await openCredentials(page, 'Licenses');
  await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
  const dlg = page.getByRole('dialog').last();
  await dlg.waitFor();
  await field(dlg, 'Type').selectOption('State Medical License');
  await field(dlg, 'Display Name').fill(name);
  await field(dlg, 'License #').fill(number);
  const st = field(dlg, 'State');
  if (await st.count() && await st.isVisible().catch(() => false)) await st.selectOption('CO').catch(() => {});
  await field(dlg, /^Expires/).fill('2029-05-31');
  return dlg;
}

// ── 1. Get help ──────────────────────────────────────────────────────────────

test('iPhone: Get help, a ticket and a reply sent while the app comes back from another app are received once and the screen says so', {
  tag: [],
}, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Ivy', lastName: `Help ${letters()}` });
  await clerkReplacesSessionOnFocus(page);
  const subject = `QA iPhone ticket ${stamp().slice(-8)}`;
  const body = 'QA lab iPhone journey: my renewal reminder did not arrive for the Colorado license.';

  await qa.feature('SUPPORT-001', 'A ticket sent, then the app goes to Mail and back before the answer is read', async () => {
    await openMore(page, 'Get help');
    await page.getByRole('button', { name: 'New ticket' }).click();
    await page.getByPlaceholder('Short summary (optional)').fill(subject);
    await page.getByPlaceholder(/As much detail as helps/).fill(body);
    const before = await sessionReplacements(page);
    const held = holdAnswer(page, fn('create-ticket'), () => awayAndBack(page));
    await page.getByRole('button', { name: 'Send ticket' }).click();
    const status = await held;
    const confirmed = await page.getByText(/Ticket received|Open Your tickets/).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    await qa.shot('ticket after return');
    const stored = rows(`select id from public.support_tickets where user_id = '${profile.id}' and subject = '${sq(subject)}'`);
    const text = await bodyText(page);
    const stillTyped = await page.getByPlaceholder(/As much detail as helps/).inputValue().catch(() => '');
    const sending = /Sending/i.test(text);
    qa.check('the session object was replaced while the ticket was on its way (the iPhone condition)', (await sessionReplacements(page)) > before, `${before} -> ${await sessionReplacements(page)}`);
    qa.check('create-ticket stored the ticket (HTTP 2xx)', status >= 200 && status < 300 && stored.length === 1, `HTTP ${status}, ${stored.length} row(s)`);
    qa.check('OUTCOME: the screen tells him the ticket was received', confirmed, text.slice(0, 300));
    qa.check('OUTCOME: the sent text is not left in the form to be sent again', stillTyped === '', stillTyped.slice(0, 80));
    qa.check('OUTCOME: the sheet is not stuck "Sending"', !sending, text.match(/.{0,60}Sending.{0,60}/i)?.[0] || '');
    if (!confirmed || stillTyped || sending) {
      qa.bug({
        title: 'Get help: a ticket sent just before the iPhone app comes back to the front is stored, but the sheet never says so and keeps the text (a second Send files a duplicate)',
        step: 'Get help > New ticket > Send ticket; while create-ticket answers, the app is in the background (Mail) and comes back: Clerk replaces window.Clerk.session with a new object of the same session',
        expected: '"Ticket received", the form cleared, one ticket',
        actual: `create-ticket answered ${status} and the ticket is stored, but SupportModal.jsx submit() compares window.Clerk.session to the object it started with (src/components/pages/SupportModal.jsx:511) and drops the answer: confirmed=${confirmed}, form text left=${!!stillTyped}, stuck sending=${sending}`,
        severity: 'high',
      });
    }
    // What the owner does next when the screen did not confirm: he presses Send again.
    const send = page.getByRole('button', { name: 'Send ticket' });
    if (stillTyped && await send.isEnabled().catch(() => false)) {
      await send.click();
      await sleep(4000);
      const after = rows(`select id from public.support_tickets where user_id = '${profile.id}' and subject = '${sq(subject)}'`);
      qa.check('OUTCOME: pressing Send again (as he would) does not file a second ticket', after.length === 1, `${after.length} ticket(s)`);
    }
  }, { soft: true });

  await qa.feature('SUPPORT-002', 'A reply to the ticket, sent as the app returns from another app', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await openMore(page, 'Get help');
    await page.getByRole('button', { name: 'Your tickets' }).click();
    await page.getByRole('button').filter({ hasText: subject }).first().click();
    await page.getByText(body).first().waitFor({ timeout: 30000 });
    const replyText = `QA iPhone follow up ${stamp().slice(-6)}: it came today.`;
    await page.getByPlaceholder('Add to this ticket').fill(replyText);
    const held = holdAnswer(page, fn('reply-ticket'), () => awayAndBack(page));
    await page.getByRole('button', { name: /^Send reply$|^Send$/ }).first().click();
    const status = await held;
    const ack = await page.getByText(/Reply received/).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    await qa.shot('reply after return');
    const ticket = row(`select id from public.support_tickets where user_id = '${profile.id}' and subject = '${sq(subject)}' order by created_at limit 1`);
    const mine = rows(`select id from public.support_messages where ticket_id = '${ticket?.id}' and not is_admin_reply and body = '${sq(replyText)}'`);
    const left = await page.getByPlaceholder('Add to this ticket').inputValue().catch(() => '');
    const sendButton = page.getByRole('button', { name: /^Send reply$|^Send$|Sending/ }).first();
    // Send is disabled whenever the box is empty (SupportModal canSend), so only its "Sending..." label is busy.
    const busy = /Sending/i.test(await sendButton.innerText().catch(() => '')) || (!!left && await sendButton.isDisabled().catch(() => false));
    qa.check('reply-ticket stored the reply once', status >= 200 && status < 300 && mine.length === 1, `HTTP ${status}, ${mine.length}`);
    qa.check('OUTCOME: the screen says "Reply received"', ack);
    qa.check('OUTCOME: the reply box is cleared (the sent text is not offered again)', left === '', left.slice(0, 60));
    qa.check('OUTCOME: the Send button is not stuck busy', !busy);
    if (!ack || left || busy) {
      qa.bug({
        title: 'Get help: a reply sent just before the iPhone app comes back to the front is stored, but the thread never confirms it and the Send button stays busy',
        step: 'Get help > Your tickets > a ticket > type a reply > Send; the app goes to Mail and back while reply-ticket answers',
        expected: '"Reply received", the box cleared, the thread showing the reply',
        actual: `reply-ticket answered ${status} and stored ${mine.length} reply, but sendReply() compares window.Clerk.session to the object it started with (src/components/pages/SupportModal.jsx:353): ack=${ack}, text left=${!!left}, Send busy=${busy}`,
        severity: 'high',
      });
    }
  }, { soft: true });
});

// ── 2. Settings and anything typed before leaving the app ─────────────────

test('iPhone: Settings and a license form, what he typed before switching apps is not lost (back to the same page, and after iOS discarded it)', {
  tag: [],
}, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Ira', lastName: `Settings ${letters()}` });
  await clerkReplacesSessionOnFocus(page);

  await qa.feature('SETTINGS-014', 'Reminder lead time typed, app to Mail and back, then the field left: on the server', async () => {
    await openMore(page, 'Profile & settings');
    const lead = page.locator('input[name="reminderLeadDays"]');
    await lead.waitFor({ timeout: 30000 });
    await lead.fill('45');
    await awayAndBack(page);
    await page.getByRole('heading', { name: 'Reminders' }).click();
    const saved = await waitFor('reminder_lead_days 45', async () => (row(`select reminder_lead_days from public.profiles where id = '${profile.id}'`)?.reminder_lead_days === 45 ? true : null), { timeoutMs: 20000 }).catch(() => false);
    qa.check('OUTCOME: the lead time he typed (45) is on the server', saved, String(row(`select reminder_lead_days from public.profiles where id = '${profile.id}'`)?.reminder_lead_days));
  }, { soft: true });

  await qa.feature('SETTINGS-014', 'Email reminders switched off right after coming back from another app: off on the server, off after reopening', async () => {
    await awayAndBack(page);
    const sw = page.getByRole('switch', { name: 'Email reminders' });
    await sw.scrollIntoViewIfNeeded();
    const was = await sw.getAttribute('aria-checked');
    await sw.tap();
    const want = was !== 'true';
    const saved = await waitFor('notify_email', async () => (row(`select notify_email from public.profiles where id = '${profile.id}'`)?.notify_email === want ? true : null), { timeoutMs: 20000 }).catch(() => false);
    qa.check(`OUTCOME: Email reminders ${want ? 'on' : 'off'} is on the server`, saved, String(row(`select notify_email from public.profiles where id = '${profile.id}'`)?.notify_email));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await openMore(page, 'Profile & settings');
    const after = await page.getByRole('switch', { name: 'Email reminders' }).getAttribute('aria-checked').catch(() => null);
    qa.check('OUTCOME: after reopening the switch reads what he set', after === String(want), `${after}`);
  }, { soft: true });

  await qa.feature('SETTINGS-014', 'Reminder lead time typed, then the app is discarded while in Mail and reopened', async () => {
    const lead = page.locator('input[name="reminderLeadDays"]');
    await lead.fill('60');
    await toBackground(page);
    await returnToApp(page, { discard: true, awayMs: 800 });
    await waitForMemberApp(page);
    await sleep(2000);
    const server = row(`select reminder_lead_days from public.profiles where id = '${profile.id}'`)?.reminder_lead_days;
    qa.check('OUTCOME: the lead time he typed (60) survived iOS discarding the app', server === 60, `server ${server}`);
    if (server !== 60) {
      qa.bug({
        title: 'Settings: a lead time typed into Reminders is lost when the iPhone app is discarded in the background before the field is left',
        step: 'Profile & settings > Reminders > Lead time: type 60; switch to another app (no tap elsewhere first); iOS discards the app; reopen',
        expected: 'Lead time 60 (iOS fires visibilitychange/pagehide before it suspends the page; that is the last moment to save)',
        actual: `server holds ${server}: the field saves only on blur or Enter (src/components/pages/SettingsSection.jsx:813-814); iOS sends no blur to the focused input when the app goes to the background`,
        severity: 'low',
      });
    }
  }, { soft: true });

  await qa.feature('CRED-001', 'A license being typed, app to Mail (to copy the number) and back: the form is intact and Add saves it', async () => {
    const name = `QA iPhone license ${letters()}`;
    const number = `IOS${Date.now().toString().slice(-7)}`;
    const dlg = await typeLicense(page, { name, number });
    await awayAndBack(page, 1200);
    const kept = await field(dlg, 'License #').inputValue().catch(() => '');
    qa.check('OUTCOME: the form is still open with what he typed', kept === number, kept);
    await dlg.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
    const lic = await waitFor('the license row', async () => row(`select id from public.licenses where user_id = '${profile.id}' and license_number = '${number}'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('OUTCOME: the license he added after coming back is on the server', !!lic);
    qa.check('nothing left waiting on this device', (await pendingOps(page)).length === 0, JSON.stringify(await pendingOps(page)).slice(0, 200));
  }, { soft: true });

  await qa.feature('CRED-001', 'A license being typed, the app discarded while in Mail, reopened', async () => {
    const name = `QA iPhone discarded ${letters()}`;
    const number = `IOD${Date.now().toString().slice(-7)}`;
    await typeLicense(page, { name, number });
    await toBackground(page);
    await returnToApp(page, { discard: true, awayMs: 800 });
    await waitForMemberApp(page);
    await sleep(1500);
    const text = await bodyText(page);
    const formBack = await page.getByRole('dialog').last().isVisible().catch(() => false);
    const anywhere = text.includes(number) || text.includes(name);
    qa.check('OUTCOME: what he typed into the license form is still there when he reopens the app', formBack || anywhere, formBack ? 'form reopened' : 'nothing kept');
    if (!formBack && !anywhere) {
      qa.bug({
        title: 'Credentials: a record being typed is lost entirely when iOS discards the installed app in the background (no draft is kept)',
        step: 'Credentials > Licenses > Add: Display Name and License # typed; switch to Mail to copy something; iOS discards the app; reopen',
        expected: 'The Add form back with what he typed, or at least a kept draft',
        actual: 'The app opens on its first screen; the form and every field typed are gone (CrudSection.jsx keeps the form only in React state; nothing is written on visibilitychange/pagehide)',
        severity: 'medium',
      });
    }
  }, { soft: true });
});

// ── 3. Launch on a weak mobile network ────────────────────────────────────

test('iPhone: a launch whose first network requests time out, the account opens with his records, an active membership and nothing to reload', {
  tag: ['@AUTH-002'],
}, async ({ page, context, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Ike', lastName: `Launch ${letters()}` });
  const number = `IOL${Date.now().toString().slice(-7)}`;
  await addLicense(page, profile.id, { name: 'QA weak network license', number });
  await sleep(1500);

  await qa.feature('AUTH-002', 'Reopened from the home screen with the first 4 API requests hanging 15 s then timing out', async () => {
    const faultSince = new Date().toISOString();
    const cut = await flakyLaunch(context, lab().urls.apiOrigin, { first: 4, hangMs: 15000 });
    const reports = [];
    page.on('request', (r) => { if (r.url().includes('/functions/v1/report-error')) reports.push(r.postData() || ''); });
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    const app = page.getByRole('button', { name: /^Credentials$/ }).first();
    const opened = await app.waitFor({ timeout: 120000 }).then(() => true, () => false);
    await sleep(20000); // past the hung requests
    const text = await bodyText(page);
    await qa.shot('weak network launch');
    qa.check('the first API requests were cut (the condition)', cut.length >= 1, cut.join(', '));
    qa.check('OUTCOME: the account opens (no sign-in screen, no stop)', opened && !/could not be verified|could not load|could not finish/i.test(text), text.slice(0, 300));
    qa.check('OUTCOME: no prompt to reload', !/Reload to (try again|reconnect)/i.test(text), text.match(/.{0,80}Reload.{0,80}/)?.[0] || '');
    await openCredentials(page, 'Licenses');
    const shown = await page.getByText(number).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('OUTCOME: his license is on screen', shown);
    await openMore(page, 'Profile & settings');
    const card = page.getByRole('region', { name: 'Membership' });
    await card.waitFor({ timeout: 30000 }).catch(() => {});
    let cardText = '';
    for (let i = 0; i < 40; i++) { cardText = (await card.innerText().catch(() => '')).replace(/\s+/g, ' '); if (!/Checking your membership/i.test(cardText) && cardText) break; await sleep(500); }
    await qa.shot('membership card after weak launch');
    qa.check('OUTCOME: the membership card says he is a member (not checking, not offering a purchase)', !/Checking your membership/i.test(cardText) && !/Complete payment|Continue to secure payment|Review .* offer/i.test(cardText) && cardText.length > 0, cardText.slice(0, 300));
    const name = `QA after weak launch ${letters()}`;
    const n2 = `IOW${Date.now().toString().slice(-7)}`;
    await addLicense(page, profile.id, { name, number: n2 }).catch(() => null);
    const lic = row(`select id from public.licenses where user_id = '${profile.id}' and license_number = '${n2}'`);
    qa.check('OUTCOME: a license added after the weak launch is on the server', !!lic);
    const slowMessage = 'Account load still waiting after 15 s (account).';
    const reportBodies = reports.map(raw => { try { return JSON.parse(raw); } catch { return null; } });
    qa.check('the app reports no load failure after the deliberately slow launch', reportBodies.every(body => body && (body.message === slowMessage || !/load|identity|membership/i.test(body.message || ''))), reports.map(b => b.slice(0, 160)).join(' | '));
    const slowRows = rows(`select id, kind, message, auth_user_id from public.client_errors where auth_user_id = '${user.id}' and created_at >= '${faultSince}' and kind = 'error' and message = '${slowMessage}'`);
    qa.check('the four delayed API calls cause at most one exact slow-load diagnostic', slowRows.length <= 1);
    if (slowRows.length) qa.intentionalClientErrors(slowRows, { message: slowMessage, kind: 'error', authUserId: user.id, count: 1,
      reason: 'IOS-LAUNCH-1 deliberately held the first four API calls for 15 seconds; the account, membership, existing license and a new owned save subsequently completed without Reload.' });
  }, { soft: true });
});

// ── 4. Offline launch and an edit made offline ────────────────────────────

test('iPhone: opened with no network at all, his records show, and an edit made offline reaches the server when the network is back', {
  tag: ['@SYNC-023'],
}, async ({ page, context, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Opal', lastName: `Offline ${letters()}` });
  const number = `IOO${Date.now().toString().slice(-7)}`;
  await addLicense(page, profile.id, { name: 'QA offline license', number });
  // The installed app has run once with the network: its service worker and the offline copy are in place.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMemberApp(page);
  await sleep(4000);
  const copy = await offlineCopy(page, user.id, { find: [number] });

  qa.check('the offline copy holds his license', copy.found[number] === true, JSON.stringify({ where: copy.where, chars: copy.chars }));

  // SYNC-005, a cold start from the home screen in airplane mode. Can this engine's
  // offline switch reach the app shell at all? Safari and Chromium answer a precached file
  // offline from the worker's cache; Playwright's WebKit refuses it before the worker.
  await context.setOffline(true);
  const probe = await page.evaluate(async () => { try { return (await fetch('./manifest.json')).status; } catch (e) { return `ERR ${e.message}`; } });
  if (probe !== 200) {
    qa.blocked('SYNC-005', `Playwright's WebKit offline switch stops requests before the service worker: with the worker allowed and controlling the page, a precached file fetched offline answers "Load failed" and an offline reload "WebKit encountered an internal error", while WebKit's own cache holds index.html and 9 assets (Chromium answers 200 from the same cache). Here the worker is blocked (routes), probe ${probe}. The cold start offline is covered on Chromium only (offline-storage.spec.mjs).`);
  } else {
    await qa.feature('SYNC-005', 'Cold start from the home screen in airplane mode', async () => {
      const p2 = await context.newPage();
      let loaded = true;
      await p2.goto(lab().urls.app, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { loaded = false; });
      const credentials = await p2.getByRole('button', { name: /^Credentials$/ }).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
      qa.check('OUTCOME: the app opens with no network on his account', loaded && credentials, (await bodyText(p2)).slice(0, 200));
      await p2.close();
    }, { soft: true });
  }

  await qa.feature('SYNC-023', 'In the app, the network drops (a dead zone), he adds a license, the network comes back', async () => {
    await context.setOffline(true);
    const n2 = `IOF${Date.now().toString().slice(-7)}`;
    const dlg = await typeLicense(page, { name: 'QA made offline', number: n2 });
    await dlg.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
    await sleep(2500);
    const offlineText = await bodyText(page);
    qa.check('the license added offline shows on screen', offlineText.includes(n2) || offlineText.includes('QA made offline'));
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const lic = await waitFor('the offline license on the server', async () => row(`select id from public.licenses where user_id = '${profile.id}' and license_number = '${n2}'`), { timeoutMs: 60000 }).catch(() => null);
    qa.check('OUTCOME: the license he added offline is on the server once the network is back (no reload)', !!lic);
    const waiting = await pendingOps(page);
    qa.check('nothing left waiting on this device', waiting.length === 0, JSON.stringify(waiting).slice(0, 200));
    if (!lic) {
      qa.bug({
        title: 'A record saved while the iPhone has no signal stays on the phone until the app is relaunched; coming back online, or back to the app, does not send it',
        step: 'iPhone app open and signed in; the network drops (Playwright offline); Credentials > Licenses > Add > Add; the network returns (online event); wait 60 s',
        expected: 'The license on the server within seconds of the network returning',
        actual: `Not on the server after 60 s; this device holds it as a queued ${waiting[0]?.op || 'write'} (credentialdomd-pending-ops). A write that failed on the network is queued with failureMeta (src/lib/supabase.js:2588 on an add, :2648 on an edit) and replayed only by a page load (AppContext.jsx:565); the in-session replay (AppContext.jsx:312-353) runs only for writes held for a membership answer (awaitingAccess). An installed iPhone app is resumed, not reloaded, so the desk and backups miss it until he force-closes the app`,
        severity: 'medium',
      });
    }
  }, { soft: true });
});

// ── 5. Storage nearly full ────────────────────────────────────────────────

test('iPhone: with this device\'s storage nearly full, an edit still reaches the server and his records still open after the app is closed', {
  tag: ['@SYNC-022'],
}, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Ida', lastName: `Storage ${letters()}` });
  await qa.feature('SYNC-022', 'localStorage filled to its WebKit quota but 2,000 characters', async () => {
    const t = await tightStorage(page, { leave: 2000 });
    qa.check('the condition: localStorage is nearly full', t.filler > 1000, JSON.stringify(t));
    const number = `IOS${Date.now().toString().slice(-7)}`;
    const added = await addLicense(page, profile.id, { name: 'QA tight storage license', number }).then(() => true, (e) => String(e.message).slice(0, 200));
    qa.check('OUTCOME: the license he added is on the server', added === true, added);
    await sleep(2000);
    const errors = qa.report.pageErrors.filter((e) => /quota|QuotaExceeded/i.test(e));
    qa.check('no uncaught storage error', errors.length === 0, errors.join(' | '));
    // Closed and reopened (a new page of the installed app), storage still nearly full.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMemberApp(page);
    await openCredentials(page, 'Licenses');
    qa.check('OUTCOME: after reopening, his license shows', await page.getByText(number).first().waitFor({ timeout: 30000 }).then(() => true, () => false));
    const copy = await offlineCopy(page, user.id, { find: [number] });
    qa.check('OUTCOME: this device keeps a copy with the license (IndexedDB, for an offline launch)', copy.found[number] === true, JSON.stringify({ where: copy.where, inIdb: copy.inIdb, chars: copy.chars }));
    const text = await bodyText(page);
    qa.check('the screen does not tell him something is wrong with his records', !/could not be saved|not saved|storage is full/i.test(text) || /this device/i.test(text), text.match(/.{0,80}(saved|storage).{0,80}/i)?.[0] || '');
    await releaseStorage(page);
  }, { soft: true });
});

// ── 6. Membership card and the refund, resumed ────────────────────────────

test('iPhone: the membership card after the app returns from the back-forward cache, and Cancel and get a refund pressed just before switching to Mail', {
  tag: [],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Ray', lastName: `Refund ${letters()}` });
  await clerkReplacesSessionOnFocus(page);
  const card = page.getByRole('region', { name: 'Membership' });
  const cardText = async () => {
    let t = '';
    for (let i = 0; i < 40; i++) { t = (await card.innerText().catch(() => '')).replace(/\s+/g, ' '); if (t && !/Checking your membership/i.test(t)) break; await sleep(500); }
    return t;
  };

  await qa.feature('BILL-007', 'Profile open, the app to the home screen and back from the back-forward cache: the card still says member', async () => {
    await openMore(page, 'Profile & settings');
    await card.getByRole('button', { name: 'Cancel and get a refund' }).waitFor({ timeout: 30000 });
    await toBackground(page);
    await returnToApp(page, { bfcache: true, awayMs: 1000 });
    await sleep(2500);
    const t = await cardText();
    await qa.shot('membership after bfcache');
    qa.check('OUTCOME: the card still shows his membership and its refund button', /Cancel and get a refund/.test(t) && !/Complete payment|Review .* offer/.test(t), t.slice(0, 300));
  }, { soft: true });

  await qa.feature('BILL-015', 'Confirm the refund; the app goes to Mail as the answer comes back, and returns', async () => {
    await card.getByRole('button', { name: 'Cancel and get a refund' }).click();
    const confirm = card.getByRole('button', { name: /^Cancel membership and refund / });
    await confirm.waitFor({ timeout: 30000 });
    await card.getByRole('checkbox', { name: /I understand my membership ends now/ }).check();
    let refundStatus = 0;
    await page.route(fn('limited-refund'), async (route) => {
      // WebKit hands Playwright no body for these cross-origin POSTs: the first POST after the confirm is the refund.
      const posted = route.request().postData();
      if (route.request().method() !== 'POST' || refundStatus || (posted && !/"action":"refund"/.test(posted))) return route.fallback();
      const response = await route.fetch().catch(() => null);
      refundStatus = response ? response.status() : 0;
      await awayAndBack(page, 800).catch(() => {});
      if (response) await route.fulfill({ response }).catch(() => {}); else await route.abort('failed').catch(() => {});
    });
    await confirm.click();
    const outcome = page.locator('[data-refund-outcome]').first();
    const shownOutcome = await outcome.waitFor({ timeout: 60000 }).then(() => true, () => false);
    const t = (await outcome.innerText().catch(() => '')).replace(/\s+/g, ' ');
    await qa.shot('refund after return');
    const ledger = rows(`select state, refund_id from public.limited_refund_requests where profile_id = '${profile.id}'`);
    qa.check('the refund call reached the server (the condition)', refundStatus > 0, `HTTP ${refundStatus}`);
    qa.check('OUTCOME: one refund made, the ledger reads refunded', ledger.length === 1 && ledger[0].state === 'refunded', JSON.stringify(ledger));
    qa.check('OUTCOME: the card tells him he was refunded', shownOutcome && /Refunded: \$99\.00/.test(t), t.slice(0, 240));
    if (!(shownOutcome && /Refunded/.test(t))) {
      qa.bug({
        title: 'Profile: a refund confirmed just before the iPhone app goes to Mail and back is made, but the card does not say so',
        step: 'Profile & settings > Cancel and get a refund > tick > Cancel membership and refund $99.00; the app goes to the background while limited-refund answers, and returns (Clerk replaces its session object)',
        expected: '"Refunded: $99.00 on ..." on the card',
        actual: `ledger ${JSON.stringify(ledger)}; card: ${t.slice(0, 160) || '(no outcome)'}`,
        severity: 'high',
      });
    }
  }, { soft: true });
});

// ── 7. Email deep links in Safari after sign-in ───────────────────────────

test('iPhone: a support reply email link opened in Safari (signed out), the sign-in interrupted by a trip to Mail for the code, lands on the ticket', {
  tag: [],
}, async ({ page, browser, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Lea', lastName: `Link ${letters()}` });
  const subject = `QA iPhone link ${stamp().slice(-8)}`;
  const body = 'QA lab: the deep link from the reply email must open this ticket.';
  await openMore(page, 'Get help');
  await page.getByRole('button', { name: 'New ticket' }).click();
  await page.getByPlaceholder('Short summary (optional)').fill(subject);
  await page.getByPlaceholder(/As much detail as helps/).fill(body);
  await page.getByRole('button', { name: 'Send ticket' }).click();
  const ticket = await waitFor('the ticket', async () => row(`select id from public.support_tickets where user_id = '${profile.id}' and subject = '${sq(subject)}'`), { timeoutMs: 30000 });

  // Safari, not the installed app: its own storage, so he is signed out there.
  const safari = await browser.newContext({ ...IPHONE_APP });
  await safari.addInitScript(iphoneInitScript);
  await safari.route('**/*', (route) => { const u = new URL(route.request().url()); return ['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'data:' || u.protocol === 'blob:' ? route.continue() : route.abort('blockedbyclient'); });
  const s = await safari.newPage();

  await qa.feature('AUTH-002', '#support/<ticket> from the email; sign-in page; away to Mail for the code; Safari reloaded the tab; signed in', async () => {
    await s.goto(`${lab().urls.app}#support/${ticket.id}`, { waitUntil: 'domcontentloaded' });
    await s.locator(`[data-testid="qa-signin-as"]`).first().waitFor({ timeout: 60000 }).catch(() => {});
    // Away to Mail to read the code; Safari reloads the tab when he comes back.
    await s.evaluate(() => window.__iphone.toBackground());
    await s.reload({ waitUntil: 'domcontentloaded' });
    await signIn(s, user).catch(async () => {
      const row2 = s.locator(`[data-testid="qa-signin-as"][data-user-id="${user.id}"]`);
      await row2.waitFor({ timeout: 60000 }); await row2.click();
    });
    await waitForMemberApp(s);
    const opened = await s.getByText(body).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    await s.screenshot({ path: (await qa.shot('deep link after sign-in')).replace(/\.png$/, '-safari.png') }).catch(() => {});
    qa.check('OUTCOME: after signing in, the ticket from the email is open', opened, (await bodyText(s)).slice(0, 300));
  }, { soft: true });

  await qa.feature('AUTH-002', '#backups from the backup email, signed out in Safari, signed in', async () => {
    const c2 = await browser.newContext({ ...IPHONE_APP });
    await c2.addInitScript(iphoneInitScript);
    const p = await c2.newPage();
    await p.goto(`${lab().urls.app}#backups`, { waitUntil: 'domcontentloaded' });
    const r = p.locator(`[data-testid="qa-signin-as"][data-user-id="${user.id}"]`);
    await r.waitFor({ timeout: 60000 });
    await r.click();
    await waitForMemberApp(p);
    const opened = await p.getByText(/Data & Backup|Download a backup|backup/i).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('OUTCOME: after signing in, Data & Backup is open', opened, (await bodyText(p)).slice(0, 200));
    await c2.close();
  }, { soft: true });
  await safari.close();
});

// ── 8. Two devices: the iPhone back to the front shows the desk's edit ────

test('iPhone and desk: an edit made at the desk shows on the iPhone when he returns to the app, and the iPhone\'s edit after returning reaches the desk', {
  tag: [],
}, async ({ page, qa, secondBrowser }) => {
  test.setTimeout(8 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Tess', lastName: `Two ${letters()}` });
  await clerkReplacesSessionOnFocus(page);
  const desk = await secondBrowser();
  await desk.context.addInitScript(iphoneInitScript);
  await signIn(desk.page, user);
  await waitForMemberApp(desk.page);

  await qa.feature('SYNC-003', 'The iPhone goes to the background; a license is added at the desk; the iPhone comes back', async () => {
    await openCredentials(page, 'Licenses');
    await toBackground(page);
    const number = `IOD${Date.now().toString().slice(-7)}`;
    await addLicense(desk.page, profile.id, { name: 'QA added at the desk', number });
    await returnToApp(page, { awayMs: 2000 });
    const seen = await page.getByText(number).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('iphone after desk edit');
    qa.check('OUTCOME: the desk\'s license shows on the iPhone after returning to the app (no manual reload)', seen);
    if (!seen) {
      qa.bug({
        title: 'Two devices: the installed iPhone app returning to the front does not show what was added at the desk until it is relaunched',
        step: 'iPhone app open on Credentials > Licenses, sent to the background; a license added at the desk; the iPhone app brought back (visibilitychange, focus)',
        expected: 'The desk\'s license on the iPhone within a few seconds of returning',
        actual: 'Not shown after 30 s; shown only after a reload. AppContext.jsx loads records at sign-in only; its visibilitychange/focus handlers (AppContext.jsx:432-460) only compare the account\'s deletion stamp, and there is no realtime subscription',
        severity: 'medium',
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForMemberApp(page);
      await openCredentials(page, 'Licenses');
      qa.check('after a reload it shows', await page.getByText(number).first().waitFor({ timeout: 30000 }).then(() => true, () => false));
    }
  }, { soft: true });

  await qa.feature('SYNC-003', 'An edit on the iPhone right after returning (session object replaced) shows at the desk', async () => {
    const number = `IOP${Date.now().toString().slice(-7)}`;
    await addLicense(page, profile.id, { name: 'QA added on the iPhone', number });
    await desk.page.reload({ waitUntil: 'domcontentloaded' });
    await waitForMemberApp(desk.page);
    await deskOpenCredentials(desk.page, 'Licenses');
    qa.check('OUTCOME: the iPhone\'s license is at the desk', await desk.page.getByText(number).first().waitFor({ timeout: 30000 }).then(() => true, () => false));
    qa.check('nothing left waiting on the iPhone', (await pendingOps(page)).length === 0);
  }, { soft: true });

  await qa.feature('SYNC-003', 'The iPhone stays open in the background; the desk renames a license; back on the iPhone he edits that license\'s notes and saves', async () => {
    const number = `IOC${Date.now().toString().slice(-7)}`;
    const lic = await addLicense(page, profile.id, { name: 'QA original name', number });
    await toBackground(page);
    const renamed = `QA renamed at the desk ${letters()}`;
    const patch = await restAs(user, `licenses?id=eq.${lic.id}`, { method: 'PATCH', body: { name: renamed, updated_at: new Date().toISOString() }, headers: { Prefer: 'return=minimal' } });
    qa.check('the desk\'s rename is on the server', patch.status < 300 && row(`select name from public.licenses where id = '${lic.id}'`)?.name === renamed, `HTTP ${patch.status}`);
    await returnToApp(page, { awayMs: 1500 });
    await sleep(1500);
    const b = recordButtons(page, number);
    await b.edit.click();
    const dlg = page.getByRole('dialog').last();
    await dlg.waitFor();
    const nameShown = await field(dlg, 'Display Name').inputValue().catch(() => '');
    await field(dlg, 'Notes').fill('QA note typed on the iPhone');
    await dlg.getByRole('button', { name: /^(Save|Update|Add)$/ }).last().click();
    await dlg.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
    const after = await waitFor('the iPhone note on the server', async () => { const r = row(`select name, notes from public.licenses where id = '${lic.id}'`); return r?.notes === 'QA note typed on the iPhone' ? r : null; }, { timeoutMs: 30000 }).catch(() => row(`select name, notes from public.licenses where id = '${lic.id}'`));
    await qa.shot('stale edit on the iPhone');
    qa.check('the iPhone\'s note is on the server', after?.notes === 'QA note typed on the iPhone', JSON.stringify(after));
    qa.check('OUTCOME: the desk\'s rename survives the iPhone\'s edit', after?.name === renamed, `server name "${after?.name}", the iPhone form showed "${nameShown}"`);
    if (after?.name !== renamed) {
      qa.bug({
        title: 'Two devices: the installed iPhone app, resumed from the background, shows records as they were when it was opened, and saving an edit there puts back what another device changed',
        step: 'iPhone app left open in the background; at the desk a license is renamed; back on the iPhone (no relaunch) open that license, change only its Notes, Save',
        expected: 'The desk\'s new name kept, the iPhone\'s note added (or the iPhone first shows the new name)',
        actual: `The iPhone form still showed "${nameShown}"; the server now holds name "${after?.name}": the save sends the whole record from the copy loaded at launch. Nothing reloads records on visibilitychange/pageshow (AppContext.jsx:432-460 only checks the deletion stamp) and there is no realtime subscription`,
        severity: 'high',
      });
    }
  }, { soft: true });
});

// ── 9. iPad turned across the desk breakpoint with a form open ───────────

test('iPad: turned from portrait to landscape (crossing 1024 px) with a license half typed, nothing typed is lost and Add saves it', {
  tag: [],
}, async ({ browser, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const ipad = await browser.newContext({ viewport: { width: 820, height: 1180 }, screen: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1' });
  await ipad.addInitScript(iphoneInitScript);
  await ipad.route('**/*', (route) => { const u = new URL(route.request().url()); return ['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'data:' || u.protocol === 'blob:' ? route.continue() : route.abort('blockedbyclient'); });
  const page = await ipad.newPage();
  const { profile } = await newMember(page, { firstName: 'Pat', lastName: `Pad ${letters()}` });
  await qa.feature('CRED-001', 'Portrait 820 to landscape 1180 and back with the Add form open', async () => {
    const number = `IOI${Date.now().toString().slice(-7)}`;
    await typeLicense(page, { name: 'QA iPad turned', number });
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await sleep(1200);
    const after = await page.getByRole('dialog').last().isVisible().catch(() => false);
    const kept = after ? await field(page.getByRole('dialog').last(), 'License #').inputValue().catch(() => '') : '';
    qa.check('OUTCOME: landscape: the form is still open with the number he typed', kept === number, `open=${after} value=${kept}`);
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await sleep(1200);
    const back = page.getByRole('dialog').last();
    const kept2 = await field(back, 'License #').inputValue().catch(() => '');
    qa.check('OUTCOME: back to portrait: still there', kept2 === number, kept2);
    if (kept2 === number) {
      await back.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
      const lic = await waitFor('the license row', async () => row(`select id from public.licenses where user_id = '${profile.id}' and license_number = '${number}'`), { timeoutMs: 30000 }).catch(() => null);
      qa.check('OUTCOME: Add saves it to the server', !!lic);
    }
  }, { soft: true });
  await ipad.close();
});

// ── 10. Offline with storage nearly full: an edit made offline ────────────

test('iPhone: storage nearly full and no network, a license added offline is not lost: it reaches the server once the network is back, or the app says plainly it was not kept', {
  tag: ['@SYNC-022'],
}, async ({ page, context, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Ola', lastName: `Full ${letters()}` });
  await qa.feature('SYNC-022', 'localStorage full but 200 characters; offline; Add a license; online again', async () => {
    await openCredentials(page, 'Licenses');
    const t = await tightStorage(page, { leave: 200 });
    qa.check('the condition: localStorage is nearly full', t.filler > 1000, JSON.stringify(t));
    await context.setOffline(true);
    const number = `IOX${Date.now().toString().slice(-7)}`;
    const dlg = await typeLicense(page, { name: 'QA offline and full', number });
    await dlg.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
    await sleep(2500);
    const offlineText = await bodyText(page);
    await qa.shot('offline full storage after add');
    const warned = /not kept|could not be kept|not saved|storage is full|no room|not be sent/i.test(offlineText);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await toBackground(page);
    await returnToApp(page, { awayMs: 1000 });
    const lic = await waitFor('the license on the server', async () => row(`select id from public.licenses where user_id = '${profile.id}' and license_number = '${number}'`), { timeoutMs: 60000 }).catch(() => null);
    if (!lic) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForMemberApp(page);
      await openCredentials(page, 'Licenses');
      const still = await page.getByText(number).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
      // Not sent, but he was told plainly (a "Not saved to your account ... this device's storage
      // is full" card with Open) and the record is still on this device to save again.
      qa.check('OUTCOME: on the server, or the app told him plainly it was not kept and kept it on this device', warned && still, `warned ${warned}, still on this device ${still}: ${offlineText.slice(0, 200)}`);
      if (!(warned && still)) qa.bug({
        title: 'Offline with this device\'s storage full: a license added offline never reaches the server',
        step: 'iPhone, localStorage full but 200 characters; airplane mode; Credentials > Licenses > Add; network back; app to the background and back',
        expected: 'The license on the server, or a plain "not kept" warning before he leaves',
        actual: `server: none after 60 s; warned on screen: ${warned}; after reopening on this device: ${still}. queuePendingOp (src/lib/supabase.js:935-985) keeps the write in localStorage only; on QuotaExceededError it records a storage_full sync issue and drops it`,
        severity: still ? 'medium' : 'high',
      });
    }
    await releaseStorage(page);
  }, { soft: true });
});
