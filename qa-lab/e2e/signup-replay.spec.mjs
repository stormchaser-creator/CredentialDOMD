import { selectReplayVariants } from './support/replay-variants.mjs';
import { createReplayProblemRecorder, createReplayFeatureRecorder } from './support/replay-outcomes.mjs';
// Replay of a brand-new visitor's paid signup, timed step by step, with every
// screen's text kept: public site -> membership plans -> Create your account ->
// sign up (the QA sign-in in place of Clerk, a provider-verified mailbox) ->
// the pay-first offer review -> Checkout (the lab's stand-in) -> (1) back from
// Checkout (its Cancel link, then the browser's Back), (2) the Checkout session
// expires, (3) the visitor comes back later and tries again (also: the review
// left open past its 30 minutes), (4) pays and the account opens.
//
// Lab only; synthetic people on qa.credentialdomd.test. Nothing here reads
// production.
//
//   REPLAY_PROFILE  chromium-desktop (default) | webkit-desktop | webkit-iphone-safari
//                   (with QA_ENGINE=webkit for the two WebKit ones)
//   REPLAY_OUT      folder for replay.json and the screenshots (outside the repository)
//
//   QA_E2E_RESULTS=<dir>/results.json QA_E2E_NO_RESTART=1 QA_ENGINE=webkit REPLAY_PROFILE=webkit-desktop \
//     REPLAY_OUT=<dir> node node_modules/@playwright/test/cli.js test --config qa-lab/e2e/playwright.config.mjs signup-replay
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { devices } from '@playwright/test';
import { test } from './support/fixtures.mjs';
import { LAB_EMAIL_DOMAIN, lab, mockApi, profileOf, row, rows, labExec, sleep, stamp, waitFor, waitForCheckoutEvents } from './support/lab.mjs';
import { startPublicSite, routePublicSite } from './support/bill-admin-support-public-helpers.mjs';

const PROFILE = String(process.env.REPLAY_PROFILE || 'chromium-desktop').trim();
const OUT = path.resolve(process.env.REPLAY_OUT || (process.env.QA_E2E_RESULTS
  ? path.join(path.dirname(path.resolve(process.env.QA_E2E_RESULTS)), 'replay', PROFILE)
  : path.join(process.cwd(), 'qa-lab', '.generated', 'replay', PROFILE)));
mkdirSync(OUT, { recursive: true });

// Desktop Safari on a Mac, and Safari in a tab on an iPhone (iOS 26 reports "iPhone OS 18_7", Version/26.x).
const A_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const B_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1';
const USE = {
  'chromium-desktop': { viewport: { width: 1280, height: 900 } },
  'webkit-desktop': { ...devices['Desktop Safari'], userAgent: A_UA, viewport: { width: 1280, height: 800 } },
  // Safari in a browser tab (not the installed app): the iPhone 15's 393 x 659 viewport under Safari's bars.
  'webkit-iphone-safari': { ...devices['iPhone 15'], userAgent: B_UA },
}[PROFILE];
if (!USE) throw new Error(`REPLAY_PROFILE must be chromium-desktop, webkit-desktop or webkit-iphone-safari, not ${PROFILE}`);
const { defaultBrowserType: _ignored, ...use } = USE;
test.use(use);

const PHONE = PROFILE === 'webkit-iphone-safari';
// Which journeys run: main (the whole path) and the variants below, comma separated.
const VARIANTS = selectReplayVariants(process.env.REPLAY_VARIANTS);
const CONSENT = /agree to the payment and renewal terms/;
const CONTINUE = 'Continue to secure payment';

/** Safari in a tab, not the installed app: undo the lab's WebKit iPhone default (support/ios.mjs) after it runs. */
function safariTab() {
  try { Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => false }); } catch { /* read-only */ }
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => (/display-mode:\s*standalone/.test(String(q))
    ? { matches: false, media: String(q), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } }
    : mm(q));
}

function recorder(context) {
  const t0 = Date.now();
  const marks = [];
  const net = [];
  const started = new WeakMap();
  const interesting = (u) => u.pathname.startsWith('/functions/v1/') || u.pathname.startsWith('/rest/v1/') || u.pathname.startsWith('/__qa/mock/')
    || u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname) || u.pathname === '/membership-offer.js';
  context.on('request', (r) => { try { const u = new URL(r.url()); if (interesting(u)) started.set(r, Date.now()); } catch { /* data: */ } });
  const done = async (r, failed) => {
    const at = started.get(r);
    if (at === undefined) return;
    const u = new URL(r.url());
    let status = null;
    if (!failed) { try { status = (await r.response())?.status() ?? null; } catch { /* gone */ } }
    net.push({ t: at - t0, ms: Date.now() - at, method: r.method(), path: `${u.hostname.endsWith('supabase.co') ? 'placeholder:' : ''}${u.pathname}`, status, failed: failed || undefined });
  };
  context.on('requestfinished', (r) => { void done(r, null); });
  context.on('requestfailed', (r) => { void done(r, r.failure()?.errorText || 'failed'); });
  const mark = (name, extra = {}) => { const m = { name, t: Date.now() - t0, at: new Date().toISOString(), ...extra }; marks.push(m); console.log(`[replay ${PROFILE}] +${(m.t / 1000).toFixed(1)}s ${name}${Object.keys(extra).length ? ` ${JSON.stringify(extra).slice(0, 200)}` : ''}`); return m; };
  const since = (name) => { const m = [...marks].reverse().find((x) => x.name === name); return m ? Date.now() - t0 - m.t : null; };
  return { t0, marks, net, mark, since };
}

/** What the visitor sees, sampled: each change of the screen's first lines, with its time. */
function screenSampler(page, rec, label) {
  let stop = false, last = null;
  const seen = [];
  const loop = (async () => {
    while (!stop) {
      const text = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 220)).catch(() => null);
      if (text !== null && text !== last) { last = text; seen.push({ t: Date.now() - rec.t0, text }); }
      await sleep(150);
    }
  })();
  return { seen, async end() { stop = true; await loop; rec.marks.push({ name: `${label}:screens`, t: Date.now() - rec.t0, screens: seen }); return seen; } };
}

const regionText = async (page) => (await page.getByRole('region', { name: 'Membership' }).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
const visibleButtons = async (page) => page.evaluate(() => [...document.querySelectorAll('button, a[href]')]
  .filter((b) => { const r = b.getBoundingClientRect(); const s = getComputedStyle(b); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; })
  .map((b) => `${b.tagName === 'A' ? 'link' : 'button'}:${(b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()}${b.disabled ? ' (disabled)' : ''}`)
  .filter((x) => !/^(button|link):$/.test(x)));

async function snap(page, rec, name, { full = true } = {}) {
  const file = path.join(OUT, `${String(rec.marks.length).padStart(2, '0')}-${name.replace(/[^A-Za-z0-9._-]+/g, '_')}.png`);
  await page.screenshot({ path: file, fullPage: full }).catch(() => {});
  if (PHONE && full) await page.screenshot({ path: file.replace(/\.png$/, '-viewport.png'), fullPage: false }).catch(() => {});
  return file;
}

/** Where the consent box and Continue sit on the screen as it first shows the review (a phone: above the fold or not). */
async function reviewGeometry(page) {
  return page.evaluate(({ cont }) => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), inViewNow: r.top >= 0 && r.bottom <= window.innerHeight }; };
    const consent = document.querySelector('section[aria-label="Membership"] input[type="checkbox"]');
    const label = consent?.closest('label');
    const button = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === cont);
    const heading = document.querySelector('section[aria-label="Membership"] h3');
    return { viewport: { width: window.innerWidth, height: window.innerHeight }, scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight,
      heading: box(heading), consentBox: box(consent), consentLabel: box(label), continueButton: box(button), focused: document.activeElement?.tagName + ':' + (document.activeElement?.innerText || '').slice(0, 40) };
  }, { cont: CONTINUE });
}

const dbProfile = (subject) => profileOf(subject);
const dbBilling = (pid) => ({
  previews: rows(`select id, offer_id, price_phase, annual_cents, expires_at, now() as db_now from public.limited_billing_previews where profile_id = '${pid}' order by expires_at`),
  quotes: rows(`select attempt_id, offer_id, price_phase, annual_cents, created_at, consented_at, consent_preview_id, subscription_id, public_founding_slot from public.limited_billing_quotes where profile_id = '${pid}' order by created_at`),
  attempts: rows(`select attempt_id, offer_id, state, session_id, created_at from public.billing_checkout_attempts where profile_id = '${pid}' order by created_at`),
  slots: rows(`select slot, state, attempt_id, first_paid_at from public.limited_founding_slots where profile_id = '${pid}' order by slot`),
  events: rows(`select count(*)::int as n from public.billing_events where profile_id = '${pid}'`)[0]?.n ?? null,
});

async function standInSession(page) {
  await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 });
  return new URL(page.url()).pathname.split('/').pop();
}

async function sessionOnMock(subject, id) {
  const sessions = (await mockApi(`/qa/stripe/sessions?subject=${encodeURIComponent(subject)}`)).sessions;
  const s = sessions.find((x) => x.id === id);
  return s ? { id: s.id, status: s.status, created: new Date(s.created * 1000).toISOString(), expires_at: new Date(s.expires_at * 1000).toISOString(), lifetimeMinutes: Math.round((s.expires_at - s.created) / 60), cancel_url: s.cancel_url, success_url: s.success_url } : null;
}

/** Ticks the consent box and presses Continue; returns what happened within the timeout: { standIn, message }. */
async function consentAndContinue(page, rec, label) {
  const consent = page.getByRole('checkbox', { name: CONSENT });
  await consent.waitFor({ timeout: 60000 });
  if (!(await consent.isChecked())) await consent.check();
  rec.mark(`${label}:ticked`);
  await page.getByRole('button', { name: CONTINUE }).click();
  rec.mark(`${label}:continue-pressed`);
  const pay = page.getByTestId('qa-stripe-pay');
  const alert = page.getByRole('region', { name: 'Membership' }).getByRole('alert');
  const status = page.getByRole('region', { name: 'Membership' }).getByRole('status');
  const outcome = await Promise.race([
    pay.waitFor({ timeout: 60000 }).then(() => 'stand-in'),
    alert.first().waitFor({ timeout: 60000 }).then(() => 'alert'),
    status.filter({ hasText: /expired|not available|could not|checked|try again|unavailable/i }).first().waitFor({ timeout: 60000 }).then(() => 'status'),
  ]).catch(() => 'timeout');
  if (outcome === 'stand-in') {
    const id = new URL(page.url()).pathname.split('/').pop();
    rec.mark(`${label}:stand-in`, { session: id });
    return { standIn: id };
  }
  const message = outcome === 'alert' ? await alert.first().innerText().catch(() => '') : outcome === 'status' ? await status.first().innerText().catch(() => '') : '';
  rec.mark(`${label}:refused`, { outcome, message });
  return { message, outcome };
}

if (VARIANTS.has('main')) test('signup replay: public site to Checkout, back, expired, again, paid', {
  tag: ['@REPLAY'],
}, async ({ page, context, qa }) => {
  test.setTimeout(20 * 60 * 1000);
  const rec = recorder(context);
  const evidence = { profile: PROFILE, userAgent: use.userAgent || null, viewport: use.viewport, build: null, steps: {}, problems: [] };
  const problem = createReplayProblemRecorder({ qa, problems: evidence.problems, log: (title, detail) => console.log(`[replay ${PROFILE}] PROBLEM ${title}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`) });
  const replayFeature = createReplayFeatureRecorder(qa, evidence.problems);
  if (PHONE) await context.addInitScript(safariTab);

  const site = await startPublicSite();
  const offerLog = [];
  await routePublicSite(context, site, { offerLog });
  const t = stamp('replay');
  const local = `${PROFILE.replace(/[^a-z]/g, '').slice(0, 14)}-${t.slice(-18)}`.toLowerCase().replace(/[^a-z0-9]+$/, '');
  const email = `${local}@${LAB_EMAIL_DOMAIN}`;
  let subject = null, pid = null, firstSession = null;

  try {
    // ── The public site ────────────────────────────────────────────────────
    await replayFeature('REPLAY-001', 'Public home and membership plans', async () => {
      rec.mark('public:goto');
      await page.goto(`${site.origin}/`, { waitUntil: 'load' });
      rec.mark('public:loaded');
      await sleep(4000);
      const hero = await page.locator('[data-membership-hero-headline]').first().innerText().catch(() => '');
      const calls = offerLog.filter((x) => x.path === '/functions/v1/public-membership-offer');
      evidence.steps.public = { hero, offerCallsOnFirstLoad: calls.length, offerLog: [...offerLog] };
      rec.mark('public:offer-calls', { count: calls.length });
      qa.check('the public page requests its offer exactly once on initial load', calls.length === 1, calls);
      qa.check('the public headline states the reviewed founding price before sign-in', hero.includes('$99/year') && /first 100/.test(hero), hero);
      if (calls.length > 1) problem('the public page asks public-membership-offer more than once per load', `${calls.length} calls in the first 4 s of one page load`);
      await snap(page, rec, 'public-home', { full: false });
      // The first one the visitor can see (on a phone the header's is inside the closed menu).
      const plans = page.locator('a[href="#planned-pricing"]:visible').first();
      evidence.steps.plansLink = await plans.innerText().catch(() => null);
      await plans.click();
      await sleep(1200);
      rec.mark('pricing:shown', { url: page.url() });
      const pricing = await page.locator('#planned-pricing').innerText().catch(() => '');
      evidence.steps.pricing = { text: pricing.replace(/\s+/g, ' ').slice(0, 2500) };
      await snap(page, rec, 'pricing', { full: false });
    });

    // ── Create your account -> the sign-up screen ──────────────────────────
    await replayFeature('REPLAY-002', 'Create your account, sign up, the offer review', async () => {
      const inPricing = page.locator('#planned-pricing [data-membership-action]:visible').first();
      const cta = (await inPricing.count()) ? inPricing : page.locator('[data-membership-action]:visible').first();
      evidence.steps.cta = { text: await cta.innerText().catch(() => ''), href: await cta.getAttribute('href').catch(() => null) };
      rec.mark('cta:click', evidence.steps.cta);
      await cta.click();
      await page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
      rec.mark('auth:shown', { url: page.url() });
      evidence.build = await page.evaluate(() => window.__BUILD_ID__ || document.querySelector('meta[name="build"]')?.content || null).catch(() => null);
      await sleep(2500);
      // The live sign-up screen shows the public offer above Clerk (loadAuthOffer); the lab's API is
      // plain http on loopback, which fetchPublicOffer refuses, so here it is absent (a lab limit).
      const offerBox = page.locator('[data-auth-offer]');
      evidence.steps.auth = { url: page.url(), offerBox: (await offerBox.count()) ? await offerBox.innerText() : null, text: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600) };
      await snap(page, rec, 'sign-up-screen');

      await page.getByTestId('qa-create-first').fill('Avery');
      await page.getByTestId('qa-create-last').fill(`Replay ${t.slice(-4)}`);
      await page.getByTestId('qa-create-email').fill(local);
      if (!(await page.getByTestId('qa-create-verified').isChecked())) await page.getByTestId('qa-create-verified').check();
      const sampler = screenSampler(page, rec, 'signup');
      await page.getByTestId('qa-create-submit').click();
      rec.mark('signup:submitted');
      const gate = page.getByRole('region', { name: 'Membership' });
      await gate.waitFor({ timeout: 180000 });
      rec.mark('gate:shown');
      await page.getByRole('button', { name: CONTINUE }).waitFor({ timeout: 180000 });
      rec.mark('price:shown');
      await sleep(700);   // the review scrolls itself into view
      const screens = await sampler.end();
      subject = (await mockApi('/qa/users')).users.find((u) => u.email === email)?.id || null;
      pid = subject ? dbProfile(subject)?.id : null;
      const geometry = await reviewGeometry(page);
      evidence.steps.review = {
        msSubmitToGate: rec.marks.find((m) => m.name === 'gate:shown').t - rec.marks.find((m) => m.name === 'signup:submitted').t,
        msSubmitToPrice: rec.marks.find((m) => m.name === 'price:shown').t - rec.marks.find((m) => m.name === 'signup:submitted').t,
        screens, text: await regionText(page), buttons: await visibleButtons(page), geometry,
      };
      await snap(page, rec, 'price-screen');
      if (PHONE && geometry.consentBox && (geometry.consentBox.width < 24 || geometry.consentBox.height < 24)) {
        problem('the consent checkbox is a small tap target on a phone', geometry.consentBox);
      }
      if (geometry.continueButton && !geometry.continueButton.inViewNow) problem('Continue is not on screen when the review opens', geometry);
    });

    // ── Continue -> Checkout ───────────────────────────────────────────────
    await replayFeature('REPLAY-003', 'Agree and continue to Checkout', async () => {
      const r = await consentAndContinue(page, rec, 'first');
      firstSession = r.standIn || null;
      evidence.steps.firstCheckout = { ...r, mock: firstSession ? await sessionOnMock(subject, firstSession) : null, db: pid ? dbBilling(pid) : null,
        standInText: (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600) };
      await snap(page, rec, 'checkout-stand-in', { full: false });
      qa.check('the first checkout is open for this actor and has the consented founding amount', !!firstSession && evidence.steps.firstCheckout.mock?.id === firstSession && evidence.steps.firstCheckout.mock?.status === 'open' && evidence.steps.firstCheckout.db?.quotes.at(-1)?.annual_cents === 9900, evidence.steps.firstCheckout.mock);
      if (!firstSession) problem('Continue did not open Checkout', r);
    });

    // ── (1a) Back from Checkout with its own Cancel link ───────────────────
    await replayFeature('REPLAY-004', 'Back from Checkout (its cancel link)', async () => {
      if (!firstSession) throw new Error('no Checkout to leave');
      const sampler = screenSampler(page, rec, 'cancel');
      await page.getByTestId('qa-stripe-cancel').click();
      await page.waitForURL((u) => u.origin === lab().urls.appOrigin && /\/app\//.test(u.pathname), { timeout: 60000 });
      rec.mark('cancel:back-in-app', { url: page.url() });
      const reopened = await page.getByRole('button', { name: CONTINUE }).waitFor({ timeout: 30000 }).then(() => true, () => false);
      rec.mark(reopened ? 'cancel:review-shown' : 'cancel:no-review');
      await sleep(1500);
      const screens = await sampler.end();
      const consent = page.getByRole('checkbox', { name: CONSENT });
      evidence.steps.afterCancel = { url: page.url(), screens, text: await regionText(page), notice: await page.getByRole('status').allInnerTexts().catch(() => []),
        buttons: await visibleButtons(page), consentTicked: await consent.isChecked().catch(() => null), continueEnabled: await page.getByRole('button', { name: CONTINUE }).isEnabled().catch(() => null),
        db: dbBilling(pid) };
      await snap(page, rec, 'after-cancel');
      if (!reopened) problem('after Checkout\'s cancel link the review does not come back by itself', evidence.steps.afterCancel.text.slice(0, 300));
    });

    // ── (1b) Continue again: the same Checkout? Then the browser's Back ────
    await replayFeature('REPLAY-005', 'Continue again, then the browser\'s Back button from Checkout', async () => {
      const again = await consentAndContinue(page, rec, 'again');
      evidence.steps.continueAgain = { ...again, sameSession: again.standIn ? again.standIn === firstSession : null, mock: again.standIn ? await sessionOnMock(subject, again.standIn) : null };
      if (again.standIn && again.standIn !== firstSession) problem('continuing again after cancel made a second Checkout session', { first: firstSession, second: again.standIn });
      if (!again.standIn) problem('continuing again after cancel did not open Checkout', again);
      if (!again.standIn) return;
      const sampler = screenSampler(page, rec, 'browser-back');
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch((e) => rec.mark('back:error', { e: String(e.message).slice(0, 120) }));
      rec.mark('back:returned', { url: page.url() });
      await sleep(6000);
      const screens = await sampler.end();
      const nav = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type || null).catch(() => null);
      const state = {
        url: page.url(), navigationType: nav, screens, text: await regionText(page), buttons: await visibleButtons(page),
        consentTicked: await page.getByRole('checkbox', { name: CONSENT }).isChecked().catch(() => null),
        continueEnabled: await page.getByRole('button', { name: CONTINUE }).isEnabled().catch(() => null),
      };
      evidence.steps.afterBrowserBack = state;
      await snap(page, rec, 'after-browser-back');
      if (/Opening payment/.test(state.text)) problem('after the browser\'s Back the review is stuck on "Opening payment…"', state.text.slice(0, 300));
      // From there, Continue once more (what a visitor who changed their mind back again does).
      const once = state.continueEnabled ? await (async () => {
        await page.getByRole('button', { name: CONTINUE }).click();
        rec.mark('back:continue-pressed');
        return page.getByTestId('qa-stripe-pay').waitFor({ timeout: 45000 }).then(() => new URL(page.url()).pathname.split('/').pop(), () => null);
      })() : await consentAndContinue(page, rec, 'after-back').then((r) => r.standIn || null);
      evidence.steps.afterBrowserBack.continuedTo = once;
      rec.mark('back:continued', { session: once });
      if (!once) problem('after the browser\'s Back, Continue did not reach Checkout', await regionText(page));
    });

    // ── (2) The Checkout session expires ───────────────────────────────────
    let expiredSession = null;
    await replayFeature('REPLAY-006', 'The Checkout session expires (checkout.session.expired)', async () => {
      const open = (await mockApi(`/qa/stripe/sessions?subject=${encodeURIComponent(subject)}`)).sessions.filter((s) => s.status === 'open');
      evidence.steps.expire = { openSessions: open.map((s) => s.id) };
      for (const s of open) {
        const out = await mockApi(`/qa/stripe/checkout/${encodeURIComponent(s.id)}/expire`, { method: 'POST', body: {} });
        expiredSession = s.id;
        evidence.steps.expire[s.id] = { status: out?.session?.status ?? out?.status ?? null, delivery: out?.delivery ? { status: out.delivery.status, response: String(out.delivery.response || '').slice(0, 200) } : null };
      }
      rec.mark('expire:done', { sessions: open.length });
      await sleep(2000);
      evidence.steps.expire.db = dbBilling(pid);
      // The visitor's Checkout tab, reloaded after it expired.
      if (/\/qa\/stripe\/hosted\/checkout\//.test(page.url())) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        evidence.steps.expire.standInAfter = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
        await snap(page, rec, 'checkout-after-expiry', { full: false });
      }
      const attempt = evidence.steps.expire.db.attempts.at(-1);
      qa.check('the real local expiry event expires an existing checkout and its attempt', open.length > 0 && attempt?.state === 'expired' && open.every(session => evidence.steps.expire[session.id]?.status === 'expired'), { open: open.length, state: attempt?.state });
      if (attempt && attempt.state !== 'expired') problem('the checkout attempt is not marked expired after checkout.session.expired', attempt);
    });

    // ── (3) Comes back later and tries again ───────────────────────────────
    await replayFeature('REPLAY-007', 'Comes back later (public site, Sign in) and tries again', async () => {
      const back = await context.newPage();
      const sampler = screenSampler(back, rec, 'return');
      rec.mark('return:goto-public');
      await back.goto(`${site.origin}/`, { waitUntil: 'load' });
      // On a phone the header's Sign in is inside the menu.
      const signInLink = back.locator('a[href="/app/"]:visible').filter({ hasText: /^Sign in$/ }).first();
      if (!(await signInLink.count())) {
        await back.getByRole('button', { name: 'Open menu' }).click();
        rec.mark('return:menu-opened');
      }
      await back.locator('a[href="/app/"]:visible').filter({ hasText: /^Sign in$/ }).first().click();
      rec.mark('return:sign-in-clicked');
      const gate = back.getByRole('region', { name: 'Membership' });
      await gate.waitFor({ timeout: 120000 });
      rec.mark('return:gate');
      const reviewed = await back.getByRole('button', { name: CONTINUE }).waitFor({ timeout: 60000 }).then(() => true, () => false);
      rec.mark(reviewed ? 'return:review' : 'return:no-review');
      await sleep(800);
      const screens = await sampler.end();
      evidence.steps.returnVisit = { screens, text: await regionText(back), buttons: await visibleButtons(back), db: dbBilling(pid) };
      await snap(back, rec, 'return-visit');
      const tries = [];
      for (let i = 0; i < 4; i++) {
        const r = await consentAndContinue(back, rec, `return-${i + 1}`);
        tries.push(r);
        if (r.standIn) break;
        await sleep(5000);
      }
      evidence.steps.returnVisit.tries = tries;
      const ok = tries.find((x) => x.standIn);
      evidence.steps.returnVisit.newSession = ok?.standIn || null;
      evidence.steps.returnVisit.mock = ok?.standIn ? await sessionOnMock(subject, ok.standIn) : null;
      evidence.steps.returnVisit.dbAfter = dbBilling(pid);
      if (!ok) problem('coming back after the Checkout expired, Continue does not reach Checkout', tries);
      else if (tries.length > 1) problem('coming back after the Checkout expired, the first Continue was refused', tries.slice(0, -1));
      await snap(back, rec, 'return-checkout', { full: false });
      // (3b) Back to the review, and the review's 30 minutes run out on the server while it is open.
      if (ok) {
        await back.getByTestId('qa-stripe-cancel').click();
        await back.getByRole('button', { name: CONTINUE }).waitFor({ timeout: 60000 });
        const faultSince = new Date().toISOString();
        const attemptsBefore = rows(`select attempt_id from public.billing_checkout_attempts where profile_id = '${pid}' order by attempt_id`);
        labExec(`update public.limited_billing_previews set expires_at = now() - interval '1 second' where profile_id = '${pid}' and expires_at > now()`);
        rec.mark('stale-review:server-expired');
        const checkout = back.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/functions/v1/limited-checkout');
        let r;
        const response = await qa.intentionalEdgeRequest('expired_checkout', 'REPLAY-007 deliberately expires the open review on the local server, then verifies its refusal and recovery.', async () => {
          r = await consentAndContinue(back, rec, 'stale-review');
          return checkout;
        });
        const body = await response.json();
        qa.check('the expired review is refused without a new checkout attempt', response.status() === 409 && body.error === 'quote_expired' && JSON.stringify(rows(`select attempt_id from public.billing_checkout_attempts where profile_id = '${pid}' order by attempt_id`)) === JSON.stringify(attemptsBefore), body);
        const reports = await waitFor('the replay expired-review report', async () => {
          const found = rows(`select id, kind, message, auth_user_id from public.client_errors where created_at > '${faultSince}' and auth_user_id = '${subject}' and message = 'Membership checkout failed (quote_expired)'`);
          return found.length ? found : null;
        }, { timeoutMs: 10000, intervalMs: 500 });
        qa.intentionalClientErrors(reports, { message: 'Membership checkout failed (quote_expired)', kind: 'error', authUserId: subject, count: 1, reason: 'REPLAY-007 intentionally expired this actor’s open review on the local server and verified HTTP 409 with no new checkout attempt.' });
        evidence.steps.staleReview = { ...r, text: await regionText(back), buttons: await visibleButtons(back) };
        await snap(back, rec, 'stale-review');
        if (!r.standIn) {
          // What the screen offers next, followed as a visitor would.
          const offer = back.getByRole('button', { name: /^(Complete payment|Refresh offer)$/ }).first();
          const hasOffer = await offer.isVisible().catch(() => false);
          evidence.steps.staleReview.next = hasOffer ? await offer.innerText() : null;
          if (hasOffer) {
            await offer.click();
            const again = await consentAndContinue(back, rec, 'stale-review-again');
            evidence.steps.staleReview.after = again;
            if (!again.standIn) problem('after the review expired, following the screen does not reach Checkout', again);
          } else problem('after the review expired, the screen offers no way on', evidence.steps.staleReview.text.slice(0, 300));
        }
      }
      // The return visit continues on this page.
      evidence.returnPage = true;
      context.__replayPage = back;
    });

    // ── (4) Pays ───────────────────────────────────────────────────────────
    await replayFeature('REPLAY-008', 'Pays; the account opens', async () => {
      const p = context.__replayPage || page;
      if (!/\/qa\/stripe\/hosted\/checkout\//.test(p.url())) {
        const r = await consentAndContinue(p, rec, 'pay-from-review');
        if (!r.standIn) throw new Error(`no Checkout to pay: ${JSON.stringify(r)}`);
      }
      const sessionId = new URL(p.url()).pathname.split('/').pop();
      const sampler = screenSampler(p, rec, 'pay');
      await p.getByTestId('qa-stripe-pay').click();
      rec.mark('pay:pressed', { session: sessionId });
      await p.waitForURL((u) => u.origin === lab().urls.appOrigin && u.searchParams.get('billing') === 'complete', { timeout: 120000 });
      rec.mark('pay:back-in-app');
      const events = await waitForCheckoutEvents(sessionId).catch(() => null);
      rec.mark('pay:events-accepted', { attempts: (events || []).map((d) => `${d.type} ${d.status}#${d.attempt}`) });
      const active = await waitFor('the profile to turn active', async () => dbProfile(subject)?.access_status === 'active', { timeoutMs: 90000 }).catch(() => false);
      rec.mark(active ? 'pay:profile-active' : 'pay:profile-not-active');
      const opened = await p.getByRole('button', { name: /^Credentials$/ }).first().waitFor({ timeout: 120000 }).then(() => true, () => false);
      rec.mark(opened ? 'pay:member-app' : 'pay:no-member-app');
      await sleep(1000);
      const screens = await sampler.end();
      evidence.steps.pay = { screens, opened, active, text: (await p.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500), db: dbBilling(pid) };
      await snap(p, rec, 'after-pay', { full: false });
      qa.check('verified local payment activates the profile and opens the member app', active && opened, { active, opened });
      if (!opened) problem('after paying, the member app did not open', evidence.steps.pay.text.slice(0, 300));
    });
  } finally {
    evidence.subject = subject;
    evidence.profileId = pid;
    evidence.marks = rec.marks;
    evidence.net = rec.net.sort((a, b) => a.t - b.t);
    evidence.offerLog = offerLog;
    evidence.browser = qa.report;
    evidence.clientErrors = subject ? rows(`select created_at, kind, message, extra from public.client_errors where auth_user_id = '${subject}' order by created_at`) : [];
    writeFileSync(path.join(OUT, 'replay.json'), JSON.stringify(evidence, null, 2));
    await site.close().catch(() => {});
  }
});

// ── Variants: what can sit between sign-in and the offer review ────────────

/** Straight to the app's sign-up screen (the QA sign-in), a new physician created and signed in. */
async function signUpDirect(page, rec, tag, { beforeSubmit, afterSubmit } = {}) {
  await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
  const t = stamp(tag);
  // The mock Clerk takes [a-z0-9] at both ends of the local part.
  const local = `${tag}-${PROFILE.replace(/[^a-z]/g, '').slice(0, 12)}-${t.slice(-11)}`.toLowerCase().replace(/[^a-z0-9]+$/, '');
  await page.getByTestId('qa-create-first').fill('Blair');
  await page.getByTestId('qa-create-last').fill(`Variant ${t.slice(-4)}`);
  await page.getByTestId('qa-create-email').fill(local);
  if (beforeSubmit) await beforeSubmit();
  await page.getByTestId('qa-create-submit').click();
  rec.mark(`${tag}:submitted`);
  if (afterSubmit) await afterSubmit();
  return `${local}@${LAB_EMAIL_DOMAIN}`;
}

/** Waits for the offer review (Continue) or gives up after `ms`; returns ms from the mark `from`, or null. */
async function untilReview(page, rec, tag, from, ms = 240000) {
  const ok = await page.getByRole('button', { name: CONTINUE }).waitFor({ timeout: ms }).then(() => true, () => false);
  const m = rec.mark(ok ? `${tag}:review` : `${tag}:no-review`);
  const start = rec.marks.find((x) => x.name === from);
  return ok && start ? m.t - start.t : null;
}

async function writeVariant(tag, rec, evidence, qa, subject) {
  evidence.marks = rec.marks;
  evidence.net = rec.net.sort((a, b) => a.t - b.t);
  evidence.browser = qa.report;
  evidence.clientErrors = subject ? rows(`select created_at, kind, message, extra from public.client_errors where auth_user_id = '${subject}' order by created_at`) : [];
  writeFileSync(path.join(OUT, `variant-${tag}.json`), JSON.stringify(evidence, null, 2));
}

const subjectFor = async (email) => (await mockApi('/qa/users')).users.find((u) => u.email === email)?.id || null;

// Clerk, after a sign-up or sign-in completes, sends the browser to signUpFallbackRedirectUrl
// ("/app/", src/main.jsx; no routerPush), a full page load from /app/#/... . The QA sign-in signs in
// in place. Here the page is sent to /app/ the moment the app's first initialize-clerk-profile
// request leaves (early) or once its answer is back (late), as Clerk's redirect would cut it.
for (const when of ['early', 'late']) {
  if (VARIANTS.has(`redirect-${when}`)) test(`variant: Clerk's redirect after sign-up (${when})`, { tag: ['@REPLAY'] }, async ({ page, context, qa }) => {
    test.setTimeout(8 * 60 * 1000);
    if (PHONE) await context.addInitScript(safariTab);
    const rec = recorder(context);
    const tag = `redirect-${when}`;
    const evidence = { profile: PROFILE, variant: tag };
    let email;
    await qa.feature('REPLAY-009', `A full load of /app/ right after sign-in (${when})`, async () => {
      const sampler = screenSampler(page, rec, tag);
      let armed = null;
      email = await signUpDirect(page, rec, tag, {
        beforeSubmit: async () => {
          armed = when === 'early'
            ? page.waitForRequest((r) => r.url().includes('/functions/v1/initialize-clerk-profile') && r.method() === 'POST', { timeout: 60000 })
            : page.waitForResponse((r) => r.url().includes('/functions/v1/initialize-clerk-profile') && r.request().method() === 'POST', { timeout: 60000 });
        },
        afterSubmit: async () => {
          await armed;
          rec.mark(`${tag}:initialize-${when === 'early' ? 'sent' : 'answered'}`);
          await page.goto(lab().urls.app, { waitUntil: 'commit' });
          rec.mark(`${tag}:reloaded`);
        },
      });
      evidence.msToReview = await untilReview(page, rec, tag, `${tag}:submitted`);
      evidence.screens = await sampler.end();
      evidence.text = await regionText(page);
      await snap(page, rec, `${tag}-end`);
      qa.check('the offer review opens after the redirect', evidence.msToReview !== null, `${evidence.msToReview} ms`);
    }, { soft: true });
    await writeVariant(tag, rec, evidence, qa, email && await subjectFor(email));
  });
}

// A weak mobile network at launch (support/ios.mjs flakyLaunch): the first API requests after the
// sign-in hang and then fail as a timeout does. How long the new physician waits, and on what.
if (VARIANTS.has('weaknet')) test('variant: weak network right after sign-up', { tag: ['@REPLAY'] }, async ({ page, context, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  if (PHONE) await context.addInitScript(safariTab);
  const { flakyLaunch } = await import('./support/ios.mjs');
  const rec = recorder(context);
  const tag = 'weaknet';
  const evidence = { profile: PROFILE, variant: tag };
  let email;
  await qa.feature('REPLAY-010', 'The first API calls after sign-up time out', async () => {
    const faultSince = new Date().toISOString();
    const sampler = screenSampler(page, rec, tag);
    email = await signUpDirect(page, rec, tag, {
      beforeSubmit: async () => { evidence.cut = await flakyLaunch(context, lab().urls.apiOrigin, { first: 4, hangMs: 8000 }); },
    });
    evidence.msToReview = await untilReview(page, rec, tag, `${tag}:submitted`, 300000);
    evidence.screens = await sampler.end();
    evidence.text = await regionText(page);
    evidence.body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600);
    await snap(page, rec, `${tag}-end`);
    qa.check('the offer review opens by itself once the network recovers', evidence.msToReview !== null, `${evidence.msToReview} ms; cut: ${evidence.cut.join(', ')}`);
    const subject = await subjectFor(email);
    const message = 'Account load still waiting after 15 s (account).';
    const reports = rows(`select id, kind, message, auth_user_id from public.client_errors where auth_user_id = '${subject}' and created_at >= '${faultSince}' and message = '${message}'`);
    qa.check('the deliberately delayed signup reports at most one exact slow-load diagnostic', reports.length <= 1, reports);
    if (reports.length) {
      qa.check('the slow-load diagnostic follows the actual injected delays and a review taking at least 15 seconds', evidence.cut.length > 0 && evidence.msToReview >= 15000, { cut: evidence.cut, msToReview: evidence.msToReview });
      qa.intentionalClientErrors(reports, { message, kind: 'error', authUserId: subject, count: 1,
        reason: 'REPLAY-010 held and timed out the first four API requests after this synthetic signup, verified the review recovered, and observed its exact 15-second slow-load diagnostic.' });
    }
  }, { soft: true });
  await writeVariant(tag, rec, evidence, qa, email && await subjectFor(email));
});

// The review is open; the physician leaves Safari (another app, the lock screen) and comes back
// 25 s later, with Clerk replacing its session object on the return as it does on an iPhone. Then:
// the page kept (resume), or discarded by iOS meanwhile and loaded again (discard).
for (const how of ['resume', 'discard']) {
  if (VARIANTS.has(how)) test(`variant: leaves the review and comes back (${how})`, { tag: ['@REPLAY'] }, async ({ page, context, qa }) => {
    test.setTimeout(8 * 60 * 1000);
    const { iosModelInitScript, toBackground, returnToApp, clerkReplacesSessionOnFocus } = await import('./support/ios.mjs');
    await context.addInitScript(iosModelInitScript);
    if (PHONE) await context.addInitScript(safariTab);
    const rec = recorder(context);
    const tag = how;
    const evidence = { profile: PROFILE, variant: tag };
    let email;
    await qa.feature('REPLAY-011', `Leaves the open review and comes back (${how})`, async () => {
      email = await signUpDirect(page, rec, tag);
      await untilReview(page, rec, tag, `${tag}:submitted`);
      await clerkReplacesSessionOnFocus(page);
      evidence.before = { text: await regionText(page), geometry: await reviewGeometry(page) };
      const sampler = screenSampler(page, rec, `${tag}-return`);
      await toBackground(page);
      rec.mark(`${tag}:away`);
      evidence.returned = await returnToApp(page, { awayMs: 25000, discard: how === 'discard' });
      rec.mark(`${tag}:back`);
      evidence.msToReviewAfterReturn = await untilReview(page, rec, `${tag}-after`, `${tag}:back`, 120000);
      await sleep(3000);
      evidence.screens = await sampler.end();
      evidence.after = { text: await regionText(page), buttons: await visibleButtons(page), geometry: await reviewGeometry(page),
        consentTicked: await page.getByRole('checkbox', { name: CONSENT }).isChecked().catch(() => null) };
      await snap(page, rec, `${tag}-after-return`);
      const r = await consentAndContinue(page, rec, `${tag}-continue`);
      evidence.continue = r;
      qa.check('after coming back, Continue reaches Checkout', !!r.standIn, JSON.stringify(r));
    }, { soft: true });
    await writeVariant(tag, rec, evidence, qa, email && await subjectFor(email));
  });
}

// The review left open past its 30 minutes (a tab left on the screen), in real time: what the
// physician sees on Continue, and what it takes to pay (idle31-real, about 33 minutes). And a
// device clock 31 minutes fast (skew31): every review the server makes reads as expired here.
for (const how of ['idle31-real', 'skew31']) {
  if (VARIANTS.has(how)) test(`variant: ${how === 'skew31' ? 'a device clock 31 minutes fast' : 'the review left open 31 minutes'}`, { tag: ['@REPLAY'] }, async ({ page, context, qa }) => {
    test.setTimeout(45 * 60 * 1000);
    if (PHONE) await context.addInitScript(safariTab);
    const rec = recorder(context);
    const tag = how;
    const evidence = { profile: PROFILE, variant: tag };
    let email;
    await qa.feature('REPLAY-012', how === 'skew31' ? 'A device clock 31 minutes fast' : 'The open review passes its 30 minutes', async () => {
      if (how === 'skew31') await page.clock.install({ time: Date.now() + 31 * 60 * 1000 });
      email = await signUpDirect(page, rec, tag);
      evidence.msToReview = await untilReview(page, rec, tag, `${tag}:submitted`, 120000);
      evidence.before = { text: await regionText(page), body: (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 800) };
      await snap(page, rec, `${tag}-review`);
      if (how === 'idle31-real') {
        rec.mark(`${tag}:waiting-31-minutes`);
        await sleep(31 * 60 * 1000);
        rec.mark(`${tag}:31-minutes-later`);
        evidence.afterIdle = { text: await regionText(page), buttons: await visibleButtons(page) };
        await snap(page, rec, `${tag}-after-idle`);
      }
      const steps = [];
      let r = evidence.msToReview === null ? { message: 'no review opened', outcome: 'none' } : await consentAndContinue(page, rec, `${tag}-continue`);
      steps.push({ step: 'tick + Continue', ...r, text: await regionText(page) });
      for (let i = 0; i < 3 && !r.standIn; i++) {
        const next = page.getByRole('button', { name: /^(Refresh offer|Complete payment)$/ }).first();
        if (!(await next.isVisible().catch(() => false))) break;
        const name = await next.innerText();
        await next.click();
        rec.mark(`${tag}:pressed ${name}`);
        r = await consentAndContinue(page, rec, `${tag}-again-${i + 1}`);
        steps.push({ step: `${name}, tick + Continue`, ...r, text: await regionText(page) });
      }
      evidence.steps = steps;
      await snap(page, rec, `${tag}-end`);
      qa.check('the screen leads to Checkout', !!r.standIn, JSON.stringify(steps.map((x) => x.message || x.standIn)));
    }, { soft: true });
    await writeVariant(tag, rec, evidence, qa, email && await subjectFor(email));
  });
}

// One read of the account load that gets no answer: the profile row read (ensureProfile's lookup,
// src/lib/supabase.js) goes through supabase-js with the plain fetch and no deadline of its own.
// stall70: held 70 s and then failed as a timed-out request (iOS gives up on a silent request
// after about 60 s); stall-forever: held until the end. Meanwhile the physician leaves the tab and
// comes back twice, and at the end (stall-forever) reloads, as a person stuck on a screen does.
for (const how of ['stall70', 'stall-forever']) {
  if (VARIANTS.has(how)) test(`variant: the profile read stalls after sign-up (${how})`, { tag: ['@REPLAY'] }, async ({ page, context, qa }) => {
    test.setTimeout(12 * 60 * 1000);
    const { iosModelInitScript, toBackground, returnToApp } = await import('./support/ios.mjs');
    await context.addInitScript(iosModelInitScript);
    if (PHONE) await context.addInitScript(safariTab);
    const rec = recorder(context);
    const tag = how;
    const evidence = { profile: PROFILE, variant: tag, held: [] };
    let email, held = 0;
    const holdMs = how === 'stall70' ? 70000 : 11 * 60 * 1000;
    const esc = lab().urls.apiOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await context.route(new RegExp(`^${esc}/rest/v1/profiles\\?select=\\*&auth_user_id=`), async (route) => {
      if (route.request().method() !== 'GET' || held >= 1) return route.fallback();
      held += 1;
      evidence.held.push({ at: Date.now() - rec.t0, url: new URL(route.request().url()).pathname });
      rec.mark(`${tag}:profile-read-held`);
      await new Promise((r) => setTimeout(r, holdMs));
      return route.abort('timedout').catch(() => {});
    });
    await qa.feature('REPLAY-013', `The profile read after sign-up gets no answer (${how})`, async () => {
      const sampler = screenSampler(page, rec, tag);
      email = await signUpDirect(page, rec, tag);
      for (const wait of [20000, 30000]) {
        await sleep(wait);
        await toBackground(page); rec.mark(`${tag}:away`);
        await returnToApp(page, { awayMs: 5000 }); rec.mark(`${tag}:back`);
      }
      if (how === 'stall-forever') {
        await sleep(90000);
        evidence.at3min = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
        rec.mark(`${tag}:after-3-minutes`, { screen: evidence.at3min.slice(0, 80) });
        await snap(page, rec, `${tag}-at-3-minutes`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        rec.mark(`${tag}:reloaded`);
        evidence.msReloadToReview = await untilReview(page, rec, `${tag}-after-reload`, `${tag}:reloaded`, 120000);
      } else {
        evidence.msToReview = await untilReview(page, rec, tag, `${tag}:submitted`, 180000);
      }
      evidence.screens = await sampler.end();
      evidence.text = await regionText(page);
      await snap(page, rec, `${tag}-end`);
      const subject = await subjectFor(email);
      evidence.clientErrorsDuring = subject ? rows(`select created_at, message from public.client_errors where auth_user_id = '${subject}' order by created_at`) : [];
      qa.check('the review opens in the end', (evidence.msToReview ?? evidence.msReloadToReview) !== null, JSON.stringify({ msToReview: evidence.msToReview, msReloadToReview: evidence.msReloadToReview }));
    }, { soft: true });
    await writeVariant(tag, rec, evidence, qa, email && await subjectFor(email));
  });
}
