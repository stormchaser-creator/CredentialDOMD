// The signup fixes of 2026-10-07 (signup review), as a new physician meets
// them, on an iPhone 15 in WebKit:
//   SIGNUP-SPLIT    the sign-in screen comes up without the app's chunk, which
//                   follows once the screen is up; signing up then opens the app;
//   SIGNUP-STALL    a profile read that never answers no longer holds the
//                   first screen on "Loading...": Reload is offered at 10 s and
//                   the load tries again on its own and reaches the review;
//   SIGNUP-RESUME   a pending account back in front reads no records again,
//                   and the load sent one membership check, not two;
//   SIGNUP-CANCEL   back from Checkout's cancel link, the review itself says
//                   nothing was charged, on screen;
//   SIGNUP-FUNNEL   the funnel steps land in client_errors as events (info),
//                   ID-free, and none of them is an error;
//   SIGNUP-SKEW     a phone clock 31 minutes fast still reaches Checkout;
//   SIGNUP-PAY      paying opens the account: Checkout and its webhook run on
//                   npm:stripe in the billing functions.
// Synthetic physicians only, on the lab's reserved domain.
import { devices } from '@playwright/test';
import { test } from './support/fixtures.mjs';
import { LAB_EMAIL_DOMAIN, lab, mockApi, rows, sleep, stamp, waitForCheckoutEvents, waitForMemberApp } from './support/lab.mjs';

const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 15'];
test.use({ ...iphone, browserName: 'chromium' });

const CONTINUE = 'Continue to secure payment';
const CONSENT = /agree to the payment and renewal terms/;

async function signUp(page, tag, { goto = true } = {}) {
  if (goto) await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
  const t = stamp(tag);
  const local = `${tag}-${t.slice(-11)}`.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/[^a-z0-9]+$/, '');
  await page.getByTestId('qa-create-first').fill('Rowan');
  await page.getByTestId('qa-create-last').fill(`Fixes ${t.slice(-4)}`);
  await page.getByTestId('qa-create-email').fill(local);
  await page.getByTestId('qa-create-submit').click();
  return `${local}@${LAB_EMAIL_DOMAIN}`;
}
const subjectOf = async (email) => (await mockApi('/qa/users')).users.find((u) => u.email === email)?.id || null;
const reviewShown = (page, ms) => page.getByRole('button', { name: CONTINUE }).waitFor({ timeout: ms }).then(() => true, () => false);
const clientRows = (subject) => rows(`select kind, message, extra from public.client_errors where auth_user_id = '${subject}' order by created_at`);

// The page to the background and back, as iOS shows it to the page.
const setVisibility = (page, state) => page.evaluate((s) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  if (s === 'visible') { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })); }
  else window.dispatchEvent(new Event('blur'));
}, state);

/** Every request to the lab's API, with when it left. */
function apiLog(context) {
  const api = lab().urls.apiOrigin;
  const log = [];
  context.on('request', (r) => { if (r.url().startsWith(api)) { const u = new URL(r.url()); log.push({ at: Date.now(), method: r.method(), path: u.pathname, search: u.search }); } });
  return log;
}

test('signup fixes: the sign-in screen without the app; the funnel; back from a canceled Checkout; a pending account back in front; paying', {
  tag: ['@SIGNUP-SPLIT', '@SIGNUP-CANCEL', '@SIGNUP-FUNNEL', '@SIGNUP-RESUME', '@SIGNUP-PAY'],
}, async ({ page, context, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const scripts = [];
  page.on('request', (r) => { if (r.resourceType() === 'script') scripts.push({ at: Date.now(), path: new URL(r.url()).pathname }); });
  const log = apiLog(context);
  let email, subject;

  await qa.feature('SIGNUP-SPLIT', 'The sign-in screen comes up without the app chunk', async () => {
    const start = Date.now();
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
    const shownAt = Date.now();
    const appChunk = (s) => /\/assets\/App-[^/]+\.js$/.test(s.path);
    const before = scripts.filter((s) => appChunk(s) && s.at <= shownAt);
    qa.check('the sign-in screen is up before the app chunk is asked for', before.length === 0, JSON.stringify(scripts.map((s) => s.path)));
    await sleep(3000);
    qa.check('the app chunk follows once the screen is up', scripts.some(appChunk), JSON.stringify(scripts.map((s) => s.path)));
    qa.check('sign-in screen in under 10 s', shownAt - start < 10000, `${shownAt - start} ms`);
    await qa.shot('sign-in screen');
  });

  const submitted = Date.now();
  await qa.feature('SIGNUP-FUNNEL', 'Sign up, the review, Continue before the tick, Checkout', async () => {
    email = await signUp(page, 'fixes', { goto: false });
    qa.check('the review opens after sign-up', await reviewShown(page, 120000));
    subject = await subjectOf(email);
    const entitlements = log.filter((r) => r.path === '/functions/v1/billing-entitlements' && r.at >= submitted);
    qa.check('one membership check for the load, not two', entitlements.length === 1, `${entitlements.length} billing-entitlements request(s)`);
    // Continue before the tick: the hint, and the step.
    await page.locator('[data-consent-gate]').click();
    qa.check('the tick hint shows', await page.getByText('Tick the box above to continue.').isVisible());
    await page.getByRole('checkbox', { name: CONSENT }).check();
    await page.getByRole('button', { name: CONTINUE }).click();
    await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 });
    await qa.shot('checkout stand-in');
  });

  await qa.feature('SIGNUP-CANCEL', 'Back from Checkout\'s cancel link: the review says nothing was charged, on screen', async () => {
    await page.getByTestId('qa-stripe-cancel').click();
    await page.waitForURL((u) => u.origin === lab().urls.appOrigin && /\/app\//.test(u.pathname), { timeout: 60000 });
    qa.check('the review opens again', await reviewShown(page, 60000));
    await sleep(1200); // the review scrolls itself into view
    const line = page.locator('section[aria-label="Membership"] section [data-billing-canceled]');
    qa.check('the canceled line is inside the review', await line.count() === 1 && /Checkout was canceled\. Nothing was charged\./.test(await line.innerText()));
    const inView = await line.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }).catch(() => false);
    qa.check('and on screen, where the review was scrolled to', inView);
    await qa.shot('back from canceled checkout');
  });

  await qa.feature('SIGNUP-RESUME', 'A pending account back in front reads no records again', async () => {
    await sleep(31000); // past the resume read's 30 s gap
    const mark = Date.now();
    await setVisibility(page, 'hidden');
    await sleep(1500);
    await setVisibility(page, 'visible');
    await sleep(6000);
    const after = log.filter((r) => r.at >= mark);
    const tableReads = after.filter((r) => r.method === 'GET' && r.path.startsWith('/rest/v1/') && !r.path.startsWith('/rest/v1/profiles') && !r.path.startsWith('/rest/v1/rpc/'));
    qa.check('no table of records read on return', tableReads.length === 0, `${tableReads.length}: ${[...new Set(tableReads.map((r) => r.path))].slice(0, 8).join(', ')}`);
    qa.check('the membership is checked on return', after.some((r) => r.path === '/functions/v1/billing-entitlements'), JSON.stringify(after.map((r) => r.path)));
    qa.check('the review is still on screen', await page.getByRole('button', { name: CONTINUE }).isVisible());
  });

  await qa.feature('SIGNUP-FUNNEL', 'The funnel steps are recorded as events, ID-free', async () => {
    let steps = [];
    for (let i = 0; i < 20; i++) {
      steps = clientRows(subject).filter((r) => r.kind === 'info' && /^Funnel: /.test(r.message));
      if (steps.length >= 5) break;
      await sleep(1500);
    }
    const names = steps.map((r) => r.extra?.step);
    for (const step of ['membership_page_shown', 'price_panel_shown', 'continue_tapped_unticked', 'checkout_redirected', 'billing_return_canceled']) {
      qa.check(`step ${step}`, names.includes(step), JSON.stringify(names));
    }
    const text = JSON.stringify(steps.map((r) => r.extra));
    qa.check('no id, email or Checkout address in the steps', !/[0-9a-f]{8}-[0-9a-f]{4}-|cs_|checkout\.stripe|@|user_/.test(text), text.slice(0, 300));
    const errors = clientRows(subject).filter((r) => r.kind !== 'info');
    qa.check('no error reported for the account', errors.length === 0, JSON.stringify(errors.map((r) => r.message)));
  });

  await qa.feature('SIGNUP-PAY', 'Pay on the Checkout stand-in: the webhook (npm:stripe) settles it and the account opens', async () => {
    await page.getByRole('checkbox', { name: CONSENT }).check();
    await page.getByRole('button', { name: CONTINUE }).click();
    const pay = page.getByTestId('qa-stripe-pay');
    await pay.waitFor({ timeout: 60000 });
    const sessionId = new URL(page.url()).pathname.split('/').pop();
    await pay.click();
    await page.waitForURL((u) => u.origin === lab().urls.appOrigin && u.searchParams.get('billing') === 'complete', { timeout: 120000 });
    await waitForCheckoutEvents(sessionId).catch(() => null);
    const active = await page.waitForFunction(() => true).then(() => waitForMemberApp(page, 120000)).then(() => true, () => false);
    const status = rows(`select access_status from public.profiles where auth_user_id = '${subject}'`)[0]?.access_status;
    qa.check('the membership is active after the webhook', status === 'active', status);
    qa.check('the member app opens', active);
    await qa.shot('member app after paying');
  });
});

test('signup fixes: a profile read that never answers no longer holds "Loading..."', { tag: ['@SIGNUP-STALL'] }, async ({ page, context, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const esc = lab().urls.apiOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let held = 0, release;
  const gate = new Promise((r) => { release = r; });
  // The first profile row read after sign-up never answers (until the end of the journey).
  await context.route(new RegExp(`^${esc}/rest/v1/profiles\\?select=\\*&auth_user_id=`), async (route) => {
    if (route.request().method() !== 'GET' || held >= 1) return route.fallback();
    held += 1;
    await gate;
    return route.abort('timedout').catch(() => {});
  });
  await qa.feature('SIGNUP-STALL', 'The held read ends at its deadline; Reload is offered; the load reaches the review on its own', async () => {
    const email = await signUp(page, 'stall');
    const start = Date.now();
    const screens = [];
    let reloadSeenAt = null;
    for (;;) {
      const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      if (screens.at(-1)?.text !== text) screens.push({ ms: Date.now() - start, text });
      if (reloadSeenAt === null && await page.getByRole('button', { name: 'Reload' }).isVisible().catch(() => false)) reloadSeenAt = Date.now() - start;
      if (await page.getByRole('button', { name: CONTINUE }).isVisible().catch(() => false)) break;
      if (Date.now() - start > 120000) break;
      await sleep(250);
    }
    const reached = await page.getByRole('button', { name: CONTINUE }).isVisible().catch(() => false);
    qa.check('the read was held', held === 1);
    qa.check('the review opens without a reload', reached, JSON.stringify(screens.slice(-4)));
    qa.check('within 40 s', reached && screens.at(-1).ms < 40000, JSON.stringify(screens.map((s) => [s.ms, s.text.slice(0, 40)])));
    qa.check('while "Loading..." lasted past 10 s, Reload was offered', reloadSeenAt === null ? !screens.some((s) => s.ms > 11000 && /^Loading\.\.\./.test(s.text)) : reloadSeenAt >= 9000, `Reload seen at ${reloadSeenAt} ms`);
    await qa.shot('review after the held read');
    const subject = await subjectOf(email);
    const stopped = clientRows(subject).filter((r) => /Account load stopped/.test(r.message));
    qa.check('no "Account load stopped" report', stopped.length === 0, JSON.stringify(stopped));
  });
  release();
});

test('signup fixes: a phone clock 31 minutes fast still reaches Checkout', { tag: ['@SIGNUP-SKEW'] }, async ({ page, qa }) => {
  test.setTimeout(5 * 60 * 1000);
  await qa.feature('SIGNUP-SKEW', 'Tick and Continue on a device 31 minutes ahead', async () => {
    await page.clock.install({ time: Date.now() + 31 * 60 * 1000 });
    await signUp(page, 'skew');
    qa.check('the review opens', await reviewShown(page, 120000));
    await page.getByRole('checkbox', { name: CONSENT }).check();
    await page.getByRole('button', { name: CONTINUE }).click();
    const reached = await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 }).then(() => true, () => false);
    const alert = reached ? '' : await page.getByRole('region', { name: 'Membership' }).innerText().catch(() => '');
    qa.check('Checkout opens (the server decides the expiry)', reached, alert.replace(/\s+/g, ' ').slice(0, 300));
    await qa.shot('skewed clock checkout');
  });
});
