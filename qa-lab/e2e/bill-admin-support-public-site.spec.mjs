// The public site, as a visitor meets it: the landing page's live offer and its
// create-account path (and what it shows when the offer function is blocked),
// the state renewal guides and their "email me the guide" form, the legal and
// security pages beside their in-app copies, the help center and its videos,
// CME resources and locums, the visit beacon, the sitemap and a crawl of every
// internal link, the landing page's controls at phone width, and the private
// administrator page's headers and the legacy root service worker.
//
// The lab app server serves only /app/, so each run packages the site with the
// deploy's own scripts/package-site.mjs and serves it on 127.0.0.1 behind
// production's two Workers pointed at the lab (support/bill-admin-support-public-helpers.mjs).
import { test, expect } from './support/fixtures.mjs';
import { guardContext, watchPage } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, emails, lab, labExec, openMore, row, rows, sleep, stamp, waitFor,
} from './support/lab.mjs';
import { labUrlFor, lifetimeMember, pageViews, probe, publicOffer, routePublicSite, startPublicSite } from './support/bill-admin-support-public-helpers.mjs';

let site;
test.beforeAll(async () => { site = await startPublicSite(); });
test.afterAll(async () => { await site?.close(); });

const STALE = /join (?:the )?waitlist|join the list|billing is not open|checkout is not open|request (?:beta|early) access/i;

/** A guarded browser context at phone width (375 x 812, touch), with the public site's routes. */
async function phoneContext(browser, report, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await guardContext(context, report);
  const pub = await routePublicSite(context, site, opts);
  const page = await context.newPage();
  watchPage(page, report);
  return { context, page, pub };
}

/** Waits for a smooth scroll to finish, then returns the element's top in the viewport (px). */
async function settledTop(page, selector) {
  let last = null;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const y = await page.evaluate(() => window.scrollY);
    if (y === last) break;
    last = y;
  }
  return page.locator(selector).evaluate((el) => Math.round(el.getBoundingClientRect().top));
}

const visible = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('visitor: landing offer, create-account path, fallback, beacon', {
  tag: ['@PUBLIC-001', '@PUBLIC-006', '@BILL-004'],
}, async ({ page, context, qa, browser }) => {
  const pub = await routePublicSite(context, site);
  const beacons = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/pv') beacons.push({ url: r.url(), body: r.postData(), page: page.url() }); });

  await qa.feature('PUBLIC-001', 'Landing hero shows the live phase price and availability; create-account CTAs reach the app sign-up', async () => {
    const offer = await publicOffer();
    qa.check('public-membership-offer answers schemaVersion 1 with phase, annualCents, checkoutEnabled, availability', offer.status === 200 && offer.body?.schemaVersion === 1 && typeof offer.body.checkoutEnabled === 'boolean' && !!offer.body.availability, offer.body);
    const before = pageViews('/').reduce((n, r) => n + Number(r.hits), 0);
    await page.goto(`${site.origin}/`, { waitUntil: 'load' });
    await waitFor('the offer request', async () => pub.offerLog.length > 0, { timeoutMs: 15000 }).catch(() => {});
    await sleep(800);
    const hero = (await page.locator('[data-membership-hero-headline]').first().innerText()).trim();
    const price = (await page.locator('[data-membership-price]').first().innerText()).trim();
    const status = (await page.locator('[data-membership-status]').first().innerText()).trim();
    await qa.shot('landing desktop live offer');
    const cents = offer.body?.annualCents;
    // membership-offer.js asks on load and again on 'pageshow', which also fires on a first load: two requests per view.
    const asked = pub.offerLog.filter((o) => o.mode === 'live').length;
    qa.check('the landing page asked the live offer endpoint on load', asked >= 1, `${asked} request(s) for one page view`);
    qa.check(`the hero and plan price match the live offer ($${cents / 100})`, hero.includes(`$${cents / 100}/year`) && price === `$${cents / 100}`, `${hero} | ${price}`);
    const phaseWord = { founding: 'Founding', earlybird: 'Early bird', standard: 'Standard' }[offer.body?.phase];
    qa.check('the hero names the live phase', hero.startsWith(`${phaseWord} Credential`), hero);
    qa.check('the status line matches the live availability', offer.body?.availability === 'available' ? /confirmed before payment/.test(status) : offer.body?.availability === 'paused' ? /paused/.test(status) : /temporarily unavailable/.test(status), status);
    const text = await visible(page);
    qa.check('no waitlist form or stale waitlist copy on the landing page', !(await page.locator('form.wl-form').count()) && !STALE.test(text), (text.match(STALE) || [])[0] || '');
    // Every create-account link: the static HTML is already a real /app/ link (no JavaScript needed).
    const ctas = await page.locator('a:has([data-membership-action])').evaluateAll((els) => els.map((e) => ({ text: e.innerText.trim(), href: e.getAttribute('href') })));
    qa.check('every "Create your account" link goes to /app/', ctas.length >= 3 && ctas.every((c) => c.href === '/app/'), ctas);
    const reviews = await page.locator('a:has([data-membership-review-action])').evaluateAll((els) => els.map((e) => ({ text: e.innerText.trim(), href: e.getAttribute('href') })));
    qa.check('the plan CTAs ("See ... plan", nav CTA) lead to the pricing section, whose button creates the account', reviews.length >= 2 && reviews.every((c) => c.href === '#planned-pricing') && await page.locator('#planned-pricing a[href="/app/"]').count() > 0, reviews);
    qa.check('the plan CTA names the live price once painted', reviews.some((c) => c.text === (offer.body?.phase === 'founding' ? 'See the $99 founding plan' : `See the $${cents / 100}/year plan`)), reviews.map((c) => c.text));
    // The nav CTA: scrolls to the plans; the plan's button opens the app's sign-up.
    await page.locator('nav a.nav-cta').click();
    // A smooth scroll down the whole page: under load it takes longer than a fixed pause.
    const plansInView = () => page.locator('#planned-pricing').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; });
    const inView = await waitFor('the plans in view', async () => (await plansInView()) || null, { timeoutMs: 8000, intervalMs: 200 }).catch(() => false);
    qa.check('the nav CTA scrolls to the membership plans', inView);
    await page.locator('#planned-pricing a[href="/app/"]').first().click();
    await page.waitForURL((u) => u.origin === lab().urls.appOrigin && u.pathname.startsWith('/app/'), { timeout: 30000 });
    const signIn = await page.getByTestId('qa-signin').waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('create account lands on sign-up');
    qa.check('"Create your account" opens the app\'s sign-up (the QA sign-in stands in for Clerk)', signIn, page.url());
    await page.goBack({ waitUntil: 'load' }).catch(() => {});
    const after = await waitFor('the landing page view counted', async () => { const n = pageViews('/').reduce((s, r) => s + Number(r.hits), 0); return n > before ? n : null; }, { timeoutMs: 15000 }).catch(() => null);
    qa.check('page_views counted the landing page view (visit beacon row)', after !== null, `${before} -> ${after}`);
  }, { soft: true });

  const p = await phoneContext(browser, qa.report);
  await qa.feature('PUBLIC-001', 'At 375 px the offer renders without side scroll; with the offer function blocked the static fallback shows', async () => {
    await p.page.goto(`${site.origin}/`, { waitUntil: 'load' });
    await sleep(1000);
    const hero = (await p.page.locator('[data-membership-hero-headline]').first().innerText()).trim();
    await p.page.screenshot({ path: (await qa.shot('landing phone')).replace(/\.png$/, '-phone.png'), fullPage: false });
    qa.check('phone: the hero shows the live founding offer', /\$99\/year/.test(hero), hero);
    qa.check('phone: no horizontal page scroll', await noSideScroll(p.page));
    p.pub.setOffer('block');
    await p.page.reload({ waitUntil: 'load' });
    await sleep(1500);
    const blockedHero = (await p.page.locator('[data-membership-hero-headline]').first().innerText()).trim();
    const blockedStatus = (await p.page.locator('[data-membership-status]').first().innerText()).trim();
    const blockedPrice = (await p.page.locator('[data-membership-price]').first().innerText()).trim();
    await p.page.screenshot({ path: (await qa.shot('landing phone offer blocked')).replace(/\.png$/, '-phone.png'), fullPage: false });
    qa.check('offer blocked: the offer request was refused', p.pub.offerLog.some((o) => o.mode === 'block'), p.pub.offerLog.map((o) => o.mode));
    qa.check('offer blocked: the static founding copy renders (no invented price)', blockedHero === 'Founding Credential: $99/year for the first 100 paid members, Practice included while you are a member' && blockedPrice === '$99', `${blockedHero} | ${blockedPrice}`);
    qa.check('offer blocked: the status line says the offer is confirmed before payment', /confirmed before payment/.test(blockedStatus), blockedStatus);
    const text = await visible(p.page);
    qa.check('offer blocked: no waitlist form and no stale copy', !(await p.page.locator('form.wl-form').count()) && !STALE.test(text));
    qa.check('offer blocked: layout intact (no side scroll, CTA still a link to /app/)', await noSideScroll(p.page) && await p.page.locator('a[href="/app/"]:has([data-membership-action])').count() > 0);
  }, { soft: true });

  await qa.feature('BILL-004', 'At the cap (the offer answers early bird, $149) the landing page withdraws the founding offer everywhere', async () => {
    // The answer public_membership_offer() gives once the 100 founding places are paid
    // (the billing journey checks the SQL side in a rolled-back transaction).
    p.pub.setOffer({ schemaVersion: 1, phase: 'earlybird', annualCents: 14900, checkoutEnabled: true, availability: 'available', bundleAvailable: true });
    await p.page.reload({ waitUntil: 'load' });
    await sleep(1500);
    const later = (await p.page.locator('[data-membership-hero-headline]').first().innerText()).trim();
    const laterPrice = (await p.page.locator('[data-membership-price]').first().innerText()).trim();
    qa.check('an early-bird answer repaints the hero and the plan price to $149', later.startsWith('Early bird Credential: $149/year') && laterPrice === '$149', `${later} | ${laterPrice}`);
    // Sentences that still offer $99 to a new visitor once the live phase is early bird. These
    // may keep it: the promised free-beta holders' opt-in (they keep founding), the bundle card's
    // reason it is not sold to founding buyers, and the price schedule ($99, then $149, then $199).
    const allowed = /signed up under the earlier free-beta wording|opt in to \$99\/year Credential during the beta|not offered to founding buyers|After the 100 paid founding memberships|^\$99 a year for the first 100 paid founding members, Practice included/;
    const sentences = (await visible(p.page)).split(/(?<=[.!?])\s+/).filter((x) => /\$99/.test(x) && !allowed.test(x));
    await p.page.locator('#planned-pricing').scrollIntoViewIfNeeded();
    const shot = (await qa.shot('landing phone earlybird')).replace(/\.png$/, '-phone.png');
    await p.page.screenshot({ path: shot });
    qa.check('at early bird no sentence still offers $99 to a new visitor', sentences.length === 0, sentences.slice(0, 6));
    if (sentences.length) {
      qa.bug({
        title: 'Landing page past the founding cap: the live offer repaints the hero and price to $149, but static sentences still offer "Founding Credential is $99/year"',
        step: 'Open / while public-membership-offer answers phase earlybird (annualCents 14900; what public_membership_offer() returns once the 100 founding places are paid out)',
        expected: 'Every offer sentence follows the live phase; the founding $99 offer is withdrawn everywhere (BILL-004)',
        actual: `Hero "${later}" and plan price ${laterPrice}, but still on the page: ${sentences.slice(0, 4).map((x) => `"${x.slice(0, 160)}"`).join('; ')}. membership-offer.js repaints only [data-membership-*] nodes; the 'availability' slot (plans subtitle), the home FAQ answer "Can I sign up now?" and its JSON-LD are static text written at deploy by scripts/public-launch-render.mjs from publicLaunchPresentation().availability.`,
        severity: 'low', screenshot: shot,
      });
    }
  }, { soft: true });

  await p.context.close();

  await qa.feature('PUBLIC-006', 'One visit beacon per view, path and referrer only; the counter row increments', async () => {
    beacons.length = 0;
    const beforeHome = pageViews('/').reduce((n, r) => n + Number(r.hits), 0);
    const beforeState = pageViews('/states/texas').reduce((n, r) => n + Number(r.hits), 0);
    const relayBefore = site.relayLog.length;
    await page.goto(`${site.origin}/`, { waitUntil: 'load' });
    await sleep(1200);
    const homeBeacons = beacons.filter((b) => new URL(b.page).pathname === '/');
    await page.goto(`${site.origin}/states/texas`, { waitUntil: 'load' });
    await sleep(1200);
    const stateBeacons = beacons.filter((b) => new URL(b.page).pathname === '/states/texas');
    qa.check('exactly one beacon for the landing view and one for the guide view', homeBeacons.length === 1 && stateBeacons.length === 1, beacons.map((b) => `${new URL(b.page).pathname}: ${b.body}`));
    const bodies = beacons.map((b) => { try { return JSON.parse(b.body); } catch { return null; } });
    qa.check('each beacon carries only a path and a referrer (no personal data, no query string)', bodies.every((b) => b && Object.keys(b).sort().join() === 'p,r' && !/[?@]/.test(b.p)), bodies);
    const relays = site.relayLog.slice(relayBefore).filter((r) => r.path === '/api/pv');
    qa.check('the relay accepted each beacon (2xx)', relays.length >= 2 && relays.every((r) => r.status >= 200 && r.status < 300), relays);
    const home = await waitFor('home counter', async () => { const n = pageViews('/').reduce((s, r) => s + Number(r.hits), 0); return n >= beforeHome + 1 ? n : null; }, { timeoutMs: 10000 }).catch(() => null);
    const guide = await waitFor('guide counter', async () => { const n = pageViews('/states/texas').reduce((s, r) => s + Number(r.hits), 0); return n >= beforeState + 1 ? n : null; }, { timeoutMs: 10000 }).catch(() => null);
    qa.check('page_views counters for / and /states/texas each went up by one', home === beforeHome + 1 && guide === beforeState + 1, `/ ${beforeHome}->${home}, /states/texas ${beforeState}->${guide}`);
    // The state index (/states/), which the landing page links four times, beacons too.
    const hubBefore = site.relayLog.length;
    beacons.length = 0;
    await page.goto(`${site.origin}/states/`, { waitUntil: 'load' });
    await sleep(1200);
    const hub = site.relayLog.slice(hubBefore).filter((r) => r.path === '/api/pv');
    qa.check('the /states/ hub view is counted too (its beacon is accepted)', beacons.length === 1 && hub.length === 1 && hub[0].status >= 200 && hub[0].status < 300, `${beacons.map((b) => b.body).join(' ')} -> ${hub.map((r) => r.status).join(', ')}`);
    if (hub[0]?.status === 400) {
      qa.bug({
        title: 'Visits to the /states/ hub page are never counted: the beacon is refused 400',
        step: 'Open /states/ (the state index the landing page links four times)',
        expected: 'One page_views count for /states/',
        actual: 'The page sends {p: "/states/"}; track_pv strips the trailing slash to "/states", which its path whitelist (\'/\', \'/locums\', \'/states/%\', \'/app/%\') does not allow, so the RPC raises PT400 and the relay answers 400. Already fixed on fix/qa-cloud-writes and release/qa1 (6d0ef70e, migration 20260929200000_track_pv_states_hub.sql).',
        severity: 'low',
      });
    }
    const cols = rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'page_views' order by ordinal_position`).map((c) => c.column_name);
    qa.check('page_views stores counters only (day, path, referrer domain, hits): no IP, no agent, no identifier', !cols.some((c) => /ip|agent|user|email|session|cookie/.test(c)), cols.join(', '));
  }, { soft: true });
});

test('visitor: state guides, guide email, invalid and rate-limited requests', {
  tag: ['@PUBLIC-002'],
}, async ({ page, context, qa, browser }) => {
  await routePublicSite(context, site);
  const t = stamp('guide').toLowerCase();
  const email = `${t}@${LAB_EMAIL_DOMAIN}`;

  await qa.feature('PUBLIC-002', 'Three guides at desk and phone width render with the current offer', async () => {
    const p = await phoneContext(browser, qa.report);
    try {
      for (const slug of ['texas', 'california', 'new-york']) {
        for (const [label, pg] of [['desk', page], ['phone', p.page]]) {
          const r = await pg.goto(`${site.origin}/states/${slug}`, { waitUntil: 'load' });
          await sleep(600);
          const offer = (await pg.locator('.guide-offer [data-membership-hero-headline]').first().innerText().catch(() => '')).trim();
          const text = await visible(pg);
          qa.check(`${slug} (${label}) loads (200) with the founding $99 offer above the fold`, r?.status() === 200 && /\$99\/year/.test(offer), `${r?.status()} ${offer}`);
          qa.check(`${slug} (${label}) has no stale waitlist copy or waitlist consent`, !STALE.test(text) && !(await pg.locator('fieldset.guide-choice').count()), (text.match(STALE) || [])[0] || '');
          if (label === 'phone') qa.check(`${slug} (phone) has no horizontal page scroll`, await noSideScroll(pg));
        }
      }
      await p.page.goto(`${site.origin}/states/texas`, { waitUntil: 'load' });
      await p.page.screenshot({ path: (await qa.shot('texas guide phone')).replace(/\.png$/, '-phone.png') });
    } finally { await p.context.close(); }
  }, { soft: true });

  let lead;
  await qa.feature('PUBLIC-002', 'Hero guide form: a valid address records the request and the guide email arrives once', async () => {
    await page.goto(`${site.origin}/states/texas`, { waitUntil: 'load' });
    const form = page.locator('form.guide-form[data-placement="hero"]');
    // A real visitor reads first; a submit within 4 s is flagged "fast-submit".
    await sleep(4500);
    await form.locator('input[type="email"]').fill(email);
    const relayBefore = site.relayLog.length;
    await form.getByRole('button', { name: 'Email me the guide' }).click();
    const msg = page.locator('.guide-capture--hero .guide-msg');
    await expect(msg).toHaveText(/on its way/, { timeout: 20000 }).catch(() => {});
    await qa.shot('guide requested');
    qa.check('the page confirms the guide is on its way (no waitlist promise)', /The guide is on its way/.test(await msg.innerText()) && !/waitlist/.test(await msg.innerText()), await msg.innerText());
    const relays = site.relayLog.slice(relayBefore).map((r) => `${r.path} ${r.status}`);
    qa.check('the first-party relay took the attempt trace and the request', relays.includes('/api/waitlist-attempt 204') || relays.some((r) => r.startsWith('/api/waitlist-attempt 2')), relays);
    lead = await waitFor('the lead row', async () => row(`select id, email, source, note, waitlist, guide_sent_at from public.early_access_leads where email = '${email}'`), { timeoutMs: 15000 }).catch(() => null);
    qa.check('early_access_leads row: source /states/texas, note "guide-email TX hero", waitlist false (guide only)', lead?.source === '/states/texas' && lead?.note === 'guide-email TX hero' && lead?.waitlist === false, lead);
    const attempt = row(`select stage, source from public.waitlist_attempts where email = '${email}'`);
    qa.check('waitlist_attempts row with stage guide', attempt?.stage === 'guide', attempt);
    // The send-guide-sweep cron job (every 10 minutes in production) is inactive in the lab: run its dispatch as the job would.
    labExec('select public.dispatch_guide_emails()');
    const mail = await waitFor('the guide email', async () => (await emails({ to: email }))[0] || null, { timeoutMs: 120000, intervalMs: 2000 }).catch(() => null);
    qa.check('the guide email reaches the requester', !!mail, mail?.subject || 'none after 2 minutes');
    // A second sweep must not send it again.
    labExec('select public.dispatch_guide_emails()');
    await sleep(5000);
    const all = await emails({ to: email });
    qa.check('exactly one guide email', all.length === 1, all.map((e) => e.subject));
    const sent = row(`select guide_sent_at from public.early_access_leads where email = '${email}'`);
    qa.check('the lead is marked sent (guide_sent_at)', !!sent?.guide_sent_at, sent);
  }, { soft: true });

  await qa.feature('PUBLIC-002', 'An invalid address is refused inline; repeated submissions hit the rate limit with a 429 and an intact page', async () => {
    await page.goto(`${site.origin}/states/texas`, { waitUntil: 'load' });
    await sleep(4500);
    const form = page.locator('form.guide-form[data-placement="hero"]');
    const relayBefore = site.relayLog.length;
    await form.locator('input[type="email"]').fill('not-an-address');
    await form.getByRole('button', { name: 'Email me the guide' }).click();
    await sleep(800);
    const invalid = await form.locator('input[type="email"]').evaluate((el) => !el.validity.valid && el.validationMessage);
    qa.check('the browser refuses the invalid address inline (no request sent)', !!invalid && site.relayLog.length === relayBefore, `${invalid}; ${site.relayLog.length - relayBefore} relay call(s)`);
    // The relay allows 5 guide requests per address per 10 minutes (per isolate); the database caps signups too.
    let limited = null;
    const answers = [];
    for (let i = 0; i < 7 && !limited; i++) {
      await form.locator('input[type="email"]').fill(`${t}-rl${i}@${LAB_EMAIL_DOMAIN}`);
      const n = site.relayLog.length;
      await form.getByRole('button', { name: 'Email me the guide' }).click();
      await waitFor('the relay answer', async () => site.relayLog.slice(n).find((r) => r.path === '/api/waitlist'), { timeoutMs: 15000 }).catch(() => null);
      const answer = site.relayLog.slice(n).find((r) => r.path === '/api/waitlist');
      answers.push(answer?.status);
      if (answer?.status === 429) limited = answer;
      await sleep(400);
    }
    const msg = await page.locator('.guide-capture--hero .guide-msg').innerText();
    await qa.shot('guide rate limited');
    qa.check('repeated requests are answered 429 by the relay', !!limited, answers.join(', '));
    qa.check('the page says to try again later and keeps working (no broken page)', /Busy right now/.test(msg) && await form.getByRole('button', { name: 'Email me the guide' }).isEnabled(), msg);
    qa.check('a rate-limited request never falls back to calling Supabase directly', !qa.report.external.some((e) => /supabase/.test(e)), qa.report.external);
  }, { soft: true });

  await qa.feature('PUBLIC-002', 'The guide page\'s app CTA reaches /app/', async () => {
    await page.goto(`${site.origin}/states/texas`, { waitUntil: 'load' });
    const hrefs = await page.locator('a:has([data-membership-action])').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    qa.check('every create-account link on the guide goes to /app/', hrefs.length >= 3 && hrefs.every((h) => h === '/app/'), hrefs);
    await page.locator('.guide-offer a[href="/app/"]').click();
    await page.waitForURL((u) => u.origin === lab().urls.appOrigin, { timeout: 30000 });
    qa.check('the guide CTA opens the app sign-up', await page.getByTestId('qa-signin').waitFor({ timeout: 60000 }).then(() => true, () => false));
  }, { soft: true });
});

test('visitor: landing controls at phone width', {
  tag: ['@PUBLIC-008'],
}, async ({ qa, browser }) => {
  const p = await phoneContext(browser, qa.report);
  const pg = p.page;
  try {
    await qa.feature('PUBLIC-008', 'Mobile menu: aria-expanded, anchor links scroll and close it, Esc closes and returns focus', async () => {
      await pg.goto(`${site.origin}/`, { waitUntil: 'load' });
      const toggle = pg.locator('[data-nav-toggle]');
      qa.check('the menu button starts closed', (await toggle.getAttribute('aria-expanded')) === 'false');
      await toggle.click();
      qa.check('tapping it opens the menu (aria-expanded true, links visible)', (await toggle.getAttribute('aria-expanded')) === 'true' && await pg.locator('#primary-nav a[href="#features"]').isVisible());
      await pg.screenshot({ path: (await qa.shot('mobile menu open')).replace(/\.png$/, '-phone.png') });
      await pg.locator('#primary-nav a[href="#features"]').click();
      const at = await settledTop(pg, '#features');
      qa.check('an anchor link scrolls to its section', at >= -5 && at < 200, `#features top ${at}px`);
      qa.check('and closes the menu (aria-expanded false)', (await toggle.getAttribute('aria-expanded')) === 'false' && !(await pg.locator('#primary-nav').evaluate((el) => el.classList.contains('mobile-open'))));
      for (const anchor of ['#comparison']) {
        await toggle.click();
        await pg.locator(`#primary-nav a[href="${anchor}"]`).click();
        const top = await settledTop(pg, anchor);
        qa.check(`${anchor} scrolls into view and closes the menu`, top >= -5 && top < 200 && (await toggle.getAttribute('aria-expanded')) === 'false', `${top}px`);
      }
      const pages = await pg.locator('#primary-nav > a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
      const statuses = [];
      for (const href of pages) statuses.push(`${href} ${(await probe(`${site.origin}${href}`)).status}`);
      qa.check('every page link in the menu answers (200, or 302 into the app)', statuses.every((s) => / (200|302)$/.test(s)), statuses);
      await toggle.click();
      await pg.keyboard.press('Escape');
      const focused = await pg.evaluate(() => document.activeElement?.hasAttribute('data-nav-toggle'));
      qa.check('Esc closes the menu and returns focus to the menu button', (await toggle.getAttribute('aria-expanded')) === 'false' && focused);
    }, { soft: true });

    await qa.feature('PUBLIC-008', 'FAQ items open and close', async () => {
      const items = pg.locator('.faq-item');
      const q = (i) => items.nth(i).locator('.faq-question');
      await q(0).scrollIntoViewIfNeeded();
      const isOpen = (i) => items.nth(i).evaluate((el) => el.classList.contains('open'));
      await q(0).click();
      const first = await isOpen(0);
      await q(1).click();
      const second = await isOpen(1), firstAfter = await isOpen(0);
      await q(2).click();
      const third = await isOpen(2);
      await q(2).click();
      const thirdClosed = !(await isOpen(2));
      await pg.screenshot({ path: (await qa.shot('faq')).replace(/\.png$/, '-phone.png') });
      qa.check('tapping a question opens its answer', first && second && third, `${first} ${second} ${third}`);
      qa.check('opening another closes the previous one; tapping again closes it', !firstAfter && thirdClosed);
    }, { soft: true });

    await qa.feature('PUBLIC-008', 'Sticky CTA appears after the hero, and once closed stays closed while scrolling', async () => {
      await pg.evaluate(() => window.scrollTo(0, 0));
      await sleep(400);
      const bar = pg.locator('#sticky-cta');
      const shownAtTop = await bar.evaluate((el) => el.classList.contains('show'));
      await pg.evaluate(() => window.scrollTo(0, document.getElementById('hero').offsetHeight + 400));
      await sleep(900);
      const shown = await bar.evaluate((el) => el.classList.contains('show'));
      qa.check('hidden on the hero, shown once the hero scrolls away', !shownAtTop && shown, `${shownAtTop} -> ${shown}`);
      qa.check('its CTA goes to /app/', (await bar.locator('a').getAttribute('href')) === '/app/');
      await bar.getByRole('button', { name: 'Dismiss' }).click();
      await sleep(500);
      await pg.evaluate(() => window.scrollBy(0, 900));
      await sleep(700);
      await pg.evaluate(() => window.scrollBy(0, -600));
      await sleep(700);
      qa.check('closed, it stays closed on further scrolling', !(await bar.evaluate((el) => el.classList.contains('show'))));
    }, { soft: true });

    await qa.feature('PUBLIC-008', 'Support menu on /, /help/ and a state guide: opens, Esc closes and returns focus', async () => {
      for (const where of ['/', '/help/', '/states/texas']) {
        await pg.goto(`${site.origin}${where}`, { waitUntil: 'load' });
        const menu = pg.locator('details.support-menu').first();
        if (!(await menu.count())) {
          qa.check(`${where} has a Support menu`, false, 'no Support menu on the page');
          continue;
        }
        const toggle = pg.locator('[data-nav-toggle]');
        if (await toggle.count() && await toggle.isVisible()) await toggle.click();
        await menu.locator('summary').click();
        const open = await menu.evaluate((el) => el.open);
        await pg.keyboard.press('Escape');
        const closed = !(await menu.evaluate((el) => el.open));
        const focus = await pg.evaluate(() => document.activeElement?.tagName === 'SUMMARY');
        qa.check(`${where}: the Support menu opens, and Esc closes it with focus back on "Support"`, open && closed && focus, `${open} ${closed} ${focus}`);
      }
      const guide = await visible(pg);
      if (!(await pg.locator('details.support-menu').count())) {
        await pg.screenshot({ path: (await qa.shot('state guide header no support')).replace(/\.png$/, '-phone.png') });
        qa.bug({
          title: 'State renewal guides have no Support menu (and no help link) in their header, unlike / and /help/',
          step: 'Open /states/texas at 375 px and look for Support',
          expected: 'The same Support menu (Help & videos, FAQ, Security) as the landing page and help center (public/support-nav.js)',
          actual: `landing/state-template.html renders a header with Features, two identical "Create your account" links, All States and CME; no Support menu, no link to /help/. The only support path is a mailto in the footer. Guide text: "${guide.slice(0, 120)}"`,
          severity: 'low',
        });
      }
    }, { soft: true });
  } finally { await p.context.close(); }
});

test('visitor: legal pages vs the app, help videos, CME and locums, link crawl', {
  tag: ['@PUBLIC-003', '@PUBLIC-004', '@PUBLIC-005', '@PUBLIC-007'],
}, async ({ page, context, qa, secondBrowser }) => {
  await routePublicSite(context, site);

  await qa.feature('PUBLIC-003', 'Privacy, Terms and Security on the site; Back works; the app shows the same policy text', async () => {
    const site_ = {};
    for (const slug of ['privacy', 'terms', 'security']) {
      await page.goto(`${site.origin}/`, { waitUntil: 'load' });
      const link = page.locator(`footer a[href="/${slug}"]`).first();
      if (await link.count()) await link.click(); else await page.goto(`${site.origin}/${slug}`);
      await page.waitForURL(new RegExp(`/${slug}$`), { timeout: 15000 }).catch(() => {});
      const h1 = (await page.locator('h1').first().innerText()).trim();
      await page.mouse.wheel(0, 4000);
      await sleep(300);
      const headings = await page.locator('main h2, section h2').allInnerTexts();
      site_[slug] = { h1, headings: headings.map((h) => h.trim()), text: await visible(page) };
      qa.check(`/${slug} renders its document (${h1})`, h1.length > 0 && headings.length > 2, `${headings.length} sections`);
      await page.goBack({ waitUntil: 'load' });
      qa.check(`Back from /${slug} returns to the landing page`, new URL(page.url()).pathname === '/', page.url());
    }
    const appCopies = {};
    for (const slug of ['privacy', 'terms']) appCopies[slug] = await probe(`${site.origin}/app/${slug}.html`);
    qa.check('the app-relative copies /app/privacy.html and /app/terms.html are served', Object.values(appCopies).every((r) => r.status === 200), appCopies);
    // In the app: More > Privacy and More > Terms.
    const m = await secondBrowser();
    await lifetimeMember(m.page, { firstName: 'Lee', lastName: 'Legal' });
    for (const [item, slug] of [['Privacy', 'privacy'], ['Terms', 'terms']]) {
      await openMore(m.page, item);
      await sleep(1200);
      const appText = (await m.page.locator('main').first().innerText().catch(async () => m.page.locator('body').innerText())).replace(/\s+/g, ' ');
      const missing = site_[slug].headings.filter((h) => !appText.toLowerCase().includes(h.toLowerCase()));
      await m.page.screenshot({ path: (await qa.shot(`in-app ${slug}`)).replace(/\.png$/, '-app.png') });
      qa.check(`in-app ${item} has every section the site's /${slug} has`, missing.length === 0, missing.length ? `missing: ${missing.slice(0, 5).join(' | ')}` : `${site_[slug].headings.length} sections`);
      const updatedSite = (site_[slug].text.match(/(?:Last updated|Effective)[:\s]+([A-Z][a-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/) || [])[1];
      qa.check(`in-app ${item} shows the same "last updated" date as the site`, !updatedSite || appText.includes(updatedSite), updatedSite || 'no date on the site page');
      const back = m.page.getByRole('button', { name: /Back$/ }).first();
      const hasBack = await back.isVisible().catch(() => false);
      if (hasBack) await back.click();
      qa.check(`in-app ${item}: Back returns to More`, hasBack && await m.page.getByRole('button', { name: new RegExp(`^(\\S+ )?${item}`) }).first().isVisible().catch(() => false));
    }
  }, { soft: true });

  await qa.feature('PUBLIC-004', 'Help center: page and every video load; CTAs reach /app/; support link; no stale copy', async () => {
    await page.goto(`${site.origin}/help/`, { waitUntil: 'load' });
    const text = await visible(page);
    qa.check('/help/ has no stale "billing is not open" or waitlist copy', !STALE.test(text), (text.match(STALE) || [])[0] || '');
    const videos = await page.locator('video').evaluateAll((els) => els.map((v) => ({ src: v.querySelector('source')?.getAttribute('src') || v.getAttribute('src'), poster: v.getAttribute('poster'), tracks: [...v.querySelectorAll('track')].map((t) => t.getAttribute('src')) })));
    const bad = [];
    for (const v of videos) for (const u of [v.src, v.poster, ...v.tracks].filter(Boolean)) { const r = await probe(`${site.origin}${u}`); if (r.status !== 200) bad.push(`${u} ${r.status}`); }
    qa.check(`every help video's file, poster and transcript track loads (${videos.length} videos)`, videos.length > 0 && bad.length === 0, bad.slice(0, 6));
    const first = page.locator('video').first();
    await first.scrollIntoViewIfNeeded();
    const playable = await first.evaluate(async (v) => { v.muted = true; v.preload = 'auto'; v.load(); await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); v.addEventListener('error', r, { once: true }); setTimeout(r, 8000); }); return { duration: v.duration, error: v.error?.code || null }; });
    qa.check('the first video loads its metadata in the browser', playable.duration > 0 && !playable.error, playable);
    const watch = await page.locator('a[href^="/help/"][href$="/"]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')))].filter((h) => h !== '/help/'));
    const watchStatus = [];
    for (const href of watch) watchStatus.push(`${href} ${(await probe(`${site.origin}${href}`)).status}`);
    qa.check('every video page linked from /help/ opens', watchStatus.every((s) => s.endsWith(' 200')), watchStatus);
    for (const href of watch.slice(0, 3)) {
      await page.goto(`${site.origin}${href}`, { waitUntil: 'load' });
      const v = await page.locator('video').count();
      qa.check(`${href} shows its video`, v > 0 && !STALE.test(await visible(page)));
    }
    await page.goto(`${site.origin}/help/`, { waitUntil: 'load' });
    const appLinks = await page.locator('a[href="/app/"]').count();
    qa.check('the help center\'s app CTAs go to /app/', appLinks >= 2, `${appLinks} links`);
    const support = page.getByRole('link', { name: /Find your support ticket|Get product support/ }).first();
    qa.check('the support link is on the page', await support.count() > 0);
    if (await support.count()) {
      await support.click();
      await sleep(900);
      const target = (await support.getAttribute('href')) || '';
      const inView = target.startsWith('#') ? await page.locator(target).evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; }).catch(() => false) : true;
      qa.check('the support link reaches "Get help" (its section is on screen)', inView, target);
    }
    await page.locator('a.button[href="/app/"]').first().click();
    await page.waitForURL((u) => u.origin === lab().urls.appOrigin, { timeout: 30000 });
    qa.check('the help center CTA opens the app', await page.getByTestId('qa-signin').waitFor({ timeout: 60000 }).then(() => true, () => false));
  }, { soft: true });

  await qa.feature('PUBLIC-005', 'CME resources and locums: every internal link answers, no stale copy, forms absent or working', async () => {
    for (const [where, width] of [['/cme/', 1280], ['/cme/', 375], ['/locums', 1280], ['/locums', 375]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${site.origin}${where}`, { waitUntil: 'load' });
      await sleep(500);
      const text = await visible(page);
      const links = await page.locator('a[href]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
      const buttons = await page.locator('button').count();
      const internal = [...new Set(links.map((h) => labUrlFor(h, site)).filter(Boolean).map((u) => u.split('#')[0]))];
      const broken = [];
      for (const u of internal) { const r = await probe(u); if (![200, 301, 302].includes(r.status)) broken.push(`${u.replace(site.origin, '')} ${r.status}`); }
      qa.check(`${where} at ${width}px: ${internal.length} internal links, ${buttons} buttons; every internal link answers`, broken.length === 0, broken.slice(0, 8));
      // "waitlist" may appear only in the lifetime-access rule ("A waitlist entry ... does not qualify").
      const mentions = text.split(/(?<=[.!?])\s+/).filter((x) => /waitlist|join the list|billing is not open/i.test(x));
      const stale = mentions.filter((x) => !/^A waitlist entry, or an account that was created but never active before launch, does not qualify\./.test(x.trim()));
      qa.check(`${where} at ${width}px: no stale "waitlist", "Join the list" or "billing is not open" copy`, stale.length === 0, stale.length ? stale.slice(0, 3) : `${mentions.length} policy mention(s) of "waitlist" (lifetime-access rule)`);
      const forms = await page.locator('form').count();
      qa.check(`${where} at ${width}px: no waitlist form (forms: ${forms})`, !(await page.locator('form.wl-form').count()));
      if (width === 375) qa.check(`${where} at 375px: no horizontal page scroll`, await noSideScroll(page));
      if (width === 375) await qa.shot(`${where.replace(/\//g, '')} phone`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    // The locums grid used to be live but unlinked: it must be reachable from the landing page.
    await page.goto(`${site.origin}/`, { waitUntil: 'load' });
    qa.check('/locums is linked from the landing page', await page.locator('a[href="/locums"], a[href="https://credentialdomd.com/locums"]').count() > 0);
  }, { soft: true });

  await qa.feature('PUBLIC-007', 'Every sitemap URL answers 200; no broken internal link on any page', async () => {
    const xml = await (await fetch(`${site.origin}/sitemap.xml`)).text();
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const robots = await (await fetch(`${site.origin}/robots.txt`)).text();
    qa.check('robots.txt names the sitemap', /Sitemap:\s*https:\/\/credentialdomd\.com\/sitemap\.xml/i.test(robots), robots.slice(0, 200));
    const notOk = [];
    for (const u of urls) { const local = labUrlFor(u, site); const r = local ? await probe(local) : { status: 'external' }; if (r.status !== 200) notOk.push(`${u} ${r.status}${r.location ? ` -> ${r.location}` : ''}`); }
    qa.check(`every sitemap URL answers 200 (${urls.length} URLs)`, urls.length > 50 && notOk.length === 0, notOk.slice(0, 10));
    const broken = new Map();
    const missingAnchors = [];
    const seen = new Map();
    const htmlOf = async (u) => { if (!seen.has(u)) seen.set(u, await (await fetch(u)).text()); return seen.get(u); };
    for (const u of urls) {
      const local = labUrlFor(u, site);
      if (!local) continue;
      const html = await htmlOf(local);
      const hrefs = [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      for (const href of hrefs) {
        if (/^(mailto:|tel:|javascript:|data:)/.test(href)) continue;
        let abs;
        try { abs = new URL(href, local); } catch { continue; }
        const resolved = labUrlFor(abs.href, site);
        if (!resolved) continue;
        const [bare, frag] = resolved.split('#');
        if (!broken.has(bare)) { const r = await probe(bare); broken.set(bare, r.status); }
        const status = broken.get(bare);
        if (![200, 301, 302].includes(status)) continue;
        if (frag && status === 200 && !new URL(bare).pathname.startsWith('/app')) {
          const doc = await htmlOf(bare);
          if (!new RegExp(`\\bid="${frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(doc) && !new RegExp(`\\bname="${frag}"`).test(doc)) missingAnchors.push(`${local.replace(site.origin, '')} -> ${href}`);
        }
      }
    }
    const bad = [...broken].filter(([, s]) => ![200, 301, 302].includes(s)).map(([u, s]) => `${u.replace(site.origin, '')} ${s}`);
    qa.check(`no broken internal link (${broken.size} distinct internal targets from ${urls.length} pages)`, bad.length === 0, bad.slice(0, 10));
    qa.check('every in-site #fragment link has its target on the page', missingAnchors.length === 0, [...new Set(missingAnchors)].slice(0, 10));
  }, { soft: true });
});

test('private administrator page headers and the legacy root service worker', {
  tag: ['@PUBLIC-009'],
}, async ({ page, context, qa }) => {
  await routePublicSite(context, site);

  await qa.feature('PUBLIC-009', 'credential-access: no-store, no-referrer, noindex, nosniff, CSP with frame-ancestors; cannot be framed', async () => {
    const want = { 'cache-control': /no-store/, 'referrer-policy': /^no-referrer$/, 'x-robots-tag': /noindex/, 'x-content-type-options': /^nosniff$/, 'content-security-policy': /frame-ancestors 'none'/ };
    for (const p of ['/credential-access', '/credential-access/', '/credential-access.html', '/credential-access/portal.mjs']) {
      for (const method of ['GET', 'HEAD']) {
        const r = await fetch(`${site.origin}${p}`, { method, redirect: 'manual' });
        const h = Object.fromEntries(r.headers);
        const missing = Object.entries(want).filter(([k, re]) => (p.endsWith('.mjs') || method === 'HEAD') && k === 'content-security-policy' ? false : !re.test(h[k] || ''));
        qa.check(`${method} ${p}: private headers present`, r.status === 200 && missing.length === 0, missing.length ? `missing ${missing.map(([k]) => k).join(', ')}` : `${r.status}`);
      }
    }
    const html = await (await fetch(`${site.origin}/credential-access`)).text();
    const meta = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
    const header = (await fetch(`${site.origin}/credential-access`)).headers.get('content-security-policy') || '';
    qa.check('the header CSP is the page\'s own meta CSP plus frame-ancestors', header === `${meta.replace(/;\s*$/, '')}; frame-ancestors 'none'`, header.slice(0, 160));
    const pkgHeaders = await (await fetch(`${site.origin}/_headers`)).text();
    qa.check('the packaged _headers (Cloudflare Pages) carries the same rules for /credential-access*', /\/credential-access\/\*\n\s+Cache-Control: no-store/.test(pkgHeaders) && /frame-ancestors 'none'/.test(pkgHeaders));
    // Framing: another page on this machine tries to embed it.
    await page.goto(`${site.origin}/`, { waitUntil: 'load' });
    await page.evaluate((src) => { const f = document.createElement('iframe'); f.id = 'qa-frame'; f.src = src; document.body.appendChild(f); }, `${site.origin}/credential-access`);
    await sleep(2500);
    const framed = await page.frameLocator('#qa-frame').locator('body').innerText({ timeout: 3000 }).then((t) => t.trim().length > 0, () => false);
    qa.check('an iframe of /credential-access renders nothing (frame-ancestors none)', !framed);
    await page.goto(`${site.origin}/credential-access`, { waitUntil: 'load' });
    await sleep(1500);
    await qa.shot('credential access page');
    qa.check('opened directly, the page renders its access form and sent nothing off this machine', (await visible(page)).length > 40 && !qa.report.external.length, qa.report.external);
  }, { soft: true });

  await qa.feature('PUBLIC-009', '/sw.js is the retirement worker: an old root registration unregisters itself; /app/sw.js stays', async () => {
    const sw = await (await fetch(`${site.origin}/sw.js`)).text();
    qa.check('/sw.js is scripts/root-sw-retirement.js', /isLegacyRootRegistration/.test(sw) && /registration\.unregister\(\)/.test(sw) && !/addEventListener\(["']fetch/.test(sw));
    await page.goto(`${site.origin}/`, { waitUntil: 'load' });
    const result = await page.evaluate(async () => {
      const app = await navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).then(() => 'ok', (e) => `failed: ${e.message}`);
      const root = await navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => 'ok', (e) => `failed: ${e.message}`);
      const before = (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope);
      let after = before;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        after = (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope);
        if (!after.includes(`${location.origin}/`)) break;
      }
      return { app, root, before, after };
    });
    qa.check('an old root registration (/sw.js at scope /) is removed by the retirement worker', result.root === 'ok' && !result.after.includes(`${site.origin}/`), result);
    qa.check('the app\'s /app/sw.js registration stays', result.app === 'ok' && result.after.includes(`${site.origin}/app/`), result);
    await page.reload({ waitUntil: 'load' });
    qa.check('the landing page loads normally afterwards', (await page.locator('[data-membership-hero-headline]').count()) > 0);
  }, { soft: true });

  qa.blocked('PUBLIC-009', 'Production\'s Cloudflare route for /credential-access* and the live headers cannot be read from the lab (no production access); the lab runs the same Worker code in front of the packaged page.');
});
