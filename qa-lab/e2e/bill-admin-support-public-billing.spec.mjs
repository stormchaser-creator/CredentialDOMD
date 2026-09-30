// Billing beyond the first purchase: the founding price agreeing across the
// landing page, the in-app quote and Checkout (and all three moving to $149 at
// the founding cap, simulated in a rolled-back transaction), an expired offer
// review, the read-only archive a member keeps when a membership ends, the
// Pro-lock overlays, a returning buyer's standard price with its 30-day
// Practice trial and what happens when the trial ends, and a free-beta member
// who buys a membership that starts when the beta ends.
import { test } from './support/fixtures.mjs';
import { guardContext, watchPage } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, accessSnapshot, createPhysician, field, goTab, lab, labExec, landing, letters, mockApi, newMember, openCredentials, openMore,
  pendingOps, profileOf, restAs, row, rows, signIn, sleep, stamp, stripeFor, syncWarnings, syntheticPdf, chooseFiles, tableRow, waitFor,
  waitForCheckoutEvents, waitForMemberApp, waitForProfile,
} from './support/lab.mjs';
import { cancelSubscription, ensureFoundingPlaces, publicOffer, routePublicSite, sealBetaCohort, setTrialEnd, startPublicSite } from './support/bill-admin-support-public-helpers.mjs';

let site;
test.beforeAll(async () => { site = await startPublicSite(); });
test.afterAll(async () => { await site?.close(); });

// The product's support mailbox, built so no address sits in this public file.
const SUPPORT_MAILBOX = ['support', 'credentialdomd.com'].join('@');
const membership = (page) => page.getByRole('region', { name: 'Membership' });
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
/** The browser's own rendering of a server date, as membershipDate() formats it. */
const shownDate = (page, iso) => page.evaluate((v) => new Date(v).toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }), iso);
/** The quote the app received (billing-quote), captured from the network. */
const nextQuote = (page) => page.waitForResponse((r) => r.url().endsWith('/functions/v1/billing-quote') && r.request().method() === 'POST', { timeout: 60000 }).then((r) => r.json()).catch(() => null);
async function expireCheckout(sessionId) { return mockApi(`/qa/stripe/checkout/${encodeURIComponent(sessionId)}/expire`, { method: 'POST', body: {} }).catch((e) => ({ error: e.message })); }

/**
 * The founding cap, simulated in ONE rolled-back transaction on the local lab
 * database (every public place paid, under the product's own founding lock so
 * no checkout claims a place meanwhile): what the public offer, this account's
 * eligibility and its access snapshot say at the cap. Nothing is committed.
 */
function atFoundingCap(profileId, subject) {
  const claims = JSON.stringify({ sub: subject, role: 'authenticated' }).replace(/'/g, "''");
  const out = labExec(`begin;
    select pg_advisory_xact_lock(8222, 1);
    set local session_replication_role = replica;
    update public.limited_founding_slots set state = 'paid', profile_id = coalesce(profile_id, gen_random_uuid()), clerk_subject = coalesce(clerk_subject, 'user_qalabcapsim' || slot),
      attempt_id = coalesce(attempt_id, gen_random_uuid()), first_paid_at = coalesce(first_paid_at, now()), first_invoice_id = coalesce(first_invoice_id, 'in_qalabcapsim' || slot)
      where livemode and state <> 'paid';
    insert into public.limited_founding_slots (livemode, slot, state, profile_id, clerk_subject, attempt_id, first_paid_at, first_invoice_id)
      select true, s, 'paid', gen_random_uuid(), 'user_qalabcapsim' || s, gen_random_uuid(), now(), 'in_qalabcapsim' || s from generate_series(1, 100) s
      where not exists (select 1 from public.limited_founding_slots x where x.livemode and x.slot = s);
    select 'OFFER ' || public.public_membership_offer()::text;
    select 'ELIG ' || public.limited_billing_eligibility('${profileId}'::uuid, '${subject}', true)::text;
    select 'PREVIEW ' || public.create_limited_billing_preview('${profileId}'::uuid, '${subject}', true, 'core')::text;
    set local session_replication_role = origin;
    select set_config('request.jwt.claims', '${claims}', true);
    set local role authenticated;
    select 'SNAP ' || public.credentialdo_access_snapshot()::text;
    rollback;`);
  const pick = (tag) => { const l = out.split('\n').find((x) => x.startsWith(`${tag} `)); try { return l ? JSON.parse(l.slice(tag.length + 1)) : null; } catch { return l; } };
  return { offer: pick('OFFER'), eligibility: pick('ELIG'), preview: pick('PREVIEW'), snapshot: pick('SNAP') };
}

test('founding price: landing, in-app quote and Checkout agree; the cap moves all', {
  tag: ['@BILL-004'],
}, async ({ page, qa, browser }) => {
  test.setTimeout(15 * 60 * 1000);
  // Parallel journeys use the lab's founding places up; this one needs one free to reach Checkout.
  await ensureFoundingPlaces(2);
  const user = await createPhysician({ firstName: 'Casey', lastName: `Compare ${letters()}` });
  let offer, quote, sessionId;

  await qa.feature('BILL-004', 'The public offer, the landing hero, the in-app quote and the Checkout amount agree', async () => {
    offer = (await publicOffer()).body;
    qa.check('public-membership-offer: schemaVersion 1, a phase, its price, checkout on and available', offer?.schemaVersion === 1 && { founding: 9900, earlybird: 14900, standard: 19900 }[offer.phase] === offer.annualCents && typeof offer.checkoutEnabled === 'boolean', offer);
    // Landing (a visitor's browser).
    const visitor = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await guardContext(visitor, qa.report);
    await routePublicSite(visitor, site);
    const vp = await visitor.newPage(); watchPage(vp, qa.report);
    await vp.goto(`${site.origin}/`, { waitUntil: 'load' });
    await sleep(1500);
    const landingPrice = (await vp.locator('[data-membership-price]').first().innerText()).trim();
    const landingHero = (await vp.locator('[data-membership-hero-headline]').first().innerText()).trim();
    await visitor.close();
    qa.check('the landing page shows the same price as the offer', landingPrice === `$${offer.annualCents / 100}` && landingHero.includes(`$${offer.annualCents / 100}/year`), `${landingPrice} | ${landingHero}`);
    // In the app, as the unpaid signup.
    await signIn(page, user);
    qa.check('the new signup lands on the membership gate', (await landing(page)) === 'gate');
    const gate = await text(membership(page));
    qa.check('the gate names the founding price the offer reports', offer.phase !== 'founding' || /\$99/.test(gate), gate.slice(0, 240));
    const got = nextQuote(page);
    await page.getByRole('button', { name: 'Review Credential offer' }).click();
    quote = await got;
    await page.getByRole('button', { name: 'Continue to secure payment' }).waitFor({ timeout: 60000 });
    const review = await text(membership(page));
    await qa.shot('quote');
    qa.check('the in-app quote is the same phase and price', quote?.pricePhase === offer.phase && quote?.annualCents === offer.annualCents && review.includes(`$${(offer.annualCents / 100).toFixed(2)} per year`), { quote: quote && { phase: quote.pricePhase, cents: quote.annualCents }, shown: review.match(/\$[\d.]+ per year/)?.[0] });
    const preview = row(`select price_phase, annual_cents, expires_at from public.limited_billing_previews where id = '${quote?.quoteId}'`);
    qa.check('the stored preview matches (limited_billing_previews)', preview?.price_phase === offer.phase && preview?.annual_cents === offer.annualCents, preview);
    await membership(page).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Continue to secure payment' }).click();
    await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 });
    sessionId = new URL(page.url()).pathname.split('/').pop();
    const session = (await mockApi('/qa/stripe/sessions')).sessions.find((s) => s.id === sessionId);
    const standIn = await page.locator('body').innerText();
    await qa.shot('checkout amount');
    qa.check('Checkout charges the same amount now (Stripe session amount_total)', session?.amount_total === offer.annualCents, `session ${session?.amount_total}, offer ${offer.annualCents}; page: ${(standIn.match(/[\d,.]+ ?USD|\$[\d,.]+/) || [])[0]}`);
    const q = row(`select price_phase, annual_cents from public.limited_billing_quotes where clerk_subject = '${user.id}'`);
    qa.check('the consented quote limited-checkout recorded is the same price', q?.annual_cents === offer.annualCents && q?.price_phase === offer.phase, q);
  }, { soft: true });

  await qa.feature('BILL-004', 'At the cap (100 paid founding places, rolled back) the offer, this account\'s quote and its snapshot all move to $149 early bird', async () => {
    // Stop before paying: Checkout is left, and expired so its reserved place is released.
    if (sessionId) await expireCheckout(sessionId);
    const pid = profileOf(user.id).id;
    const cap = atFoundingCap(pid, user.id);
    qa.check('public_membership_offer at the cap: earlybird, 14900, available, bundle on sale', cap.offer?.phase === 'earlybird' && cap.offer?.annualCents === 14900 && cap.offer?.bundleAvailable === true, cap.offer);
    qa.check('this account\'s eligibility at the cap: price phase earlybird (founding withdrawn)', cap.eligibility?.price_phase === 'earlybird', cap.eligibility && { price_phase: cap.eligibility.price_phase, founding_state: cap.eligibility.founding_state, state: cap.eligibility.state });
    qa.check('a quote made at the cap is $149 early bird', cap.preview?.price_phase === 'earlybird' && cap.preview?.annual_cents === 14900, cap.preview && { phase: cap.preview.price_phase, cents: cap.preview.annual_cents });
    qa.check('the app\'s snapshot at the cap: pricePhase earlybird, the $245 bundle offered', cap.snapshot?.pricePhase === 'earlybird' && cap.snapshot?.bundleAvailable === true, cap.snapshot && { pricePhase: cap.snapshot.pricePhase, bundleAvailable: cap.snapshot.bundleAvailable });
    const after = (await publicOffer()).body;
    qa.check('nothing was committed: the live offer is unchanged afterwards', after?.phase === offer?.phase && after?.annualCents === offer?.annualCents, after);
  }, { soft: true });
});

test('expired offer review: Checkout refused; Refresh clears consent', {
  tag: ['@BILL-013'],
}, async ({ page, qa }) => {
  test.setTimeout(15 * 60 * 1000);
  await ensureFoundingPlaces(2);
  const user = await createPhysician({ firstName: 'Evan', lastName: `Expiry ${letters()}` });
  await signIn(page, user);
  await landing(page);
  const pid = profileOf(user.id).id;
  const attempts = () => rows(`select attempt_id, state from public.billing_checkout_attempts where profile_id = '${pid}'`);

  await qa.feature('BILL-013', 'The review states its expiry; past it (device clock) Continue refuses and says to review a fresh offer', async () => {
    const got = nextQuote(page);
    await page.getByRole('button', { name: 'Review Credential offer' }).click();
    const quote = await got;
    await page.getByRole('button', { name: 'Continue to secure payment' }).waitFor({ timeout: 60000 });
    const review = await text(membership(page));
    const preview = row(`select expires_at from public.limited_billing_previews where id = '${quote?.quoteId}'`);
    const expected = await page.evaluate((v) => new Date(v).toLocaleString(), quote?.expiresAt);
    qa.check('"This review expires at <time>" matches the stored preview (30 minutes)', review.includes(`This review expires at ${expected}`) && Math.abs(Date.parse(preview?.expires_at) - Date.parse(quote?.expiresAt)) < 1000, `${expected} vs ${preview?.expires_at}`);
    await membership(page).getByRole('checkbox').check();
    // The tab is left open past the expiry: the device clock moves 31 minutes on.
    await page.clock.setFixedTime(new Date(Date.parse(quote.expiresAt) + 60e3));
    await page.getByRole('button', { name: 'Continue to secure payment' }).click();
    const msg = page.getByText('This offer has expired. Review a fresh offer and confirm its terms before continuing.');
    const said = await msg.first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    await qa.shot('expired review refused');
    qa.check('Continue refuses and says the offer expired and to review a fresh one', said);
    qa.check('consent is cleared', !(await membership(page).getByRole('checkbox').isChecked().catch(() => false)));
    qa.check('no Checkout opened and no checkout attempt was created', !page.url().includes('/qa/stripe/hosted/') && attempts().length === 0, attempts());
    await page.clock.setFixedTime(new Date());
  }, { soft: true });

  await qa.feature('BILL-013', 'An offer that expired on the server (the clock agrees on the device) is refused by limited-checkout; nothing is created', async () => {
    const got = nextQuote(page);
    await page.getByRole('button', { name: 'Refresh offer' }).click();
    const quote = await got;
    await sleep(800);
    qa.check('Refresh offer shows a fresh quote with the current price and consent cleared', !!quote?.quoteId && !(await membership(page).getByRole('checkbox').isChecked()) && (await text(membership(page))).includes(`$${(quote.annualCents / 100).toFixed(2)} per year`), quote && { phase: quote.pricePhase, cents: quote.annualCents });
    // The review ages past its expiry on the server only (the device would still allow it).
    labExec(`update public.limited_billing_previews set expires_at = now() - interval '1 second' where id = '${quote.quoteId}'`);
    await membership(page).getByRole('checkbox').check();
    const checkout = page.waitForResponse((r) => r.url().endsWith('/functions/v1/limited-checkout'), { timeout: 60000 }).catch(() => null);
    await page.getByRole('button', { name: 'Continue to secure payment' }).click();
    const res = await checkout;
    const body = res ? await res.json().catch(() => null) : null;
    const said = await page.getByText(/This offer has expired\. Review a fresh offer/).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    await qa.shot('server expired refused');
    qa.check('limited-checkout answers 409 quote_expired', res?.status() === 409 && JSON.stringify(body).includes('quote_expired'), `${res?.status()} ${JSON.stringify(body)}`);
    qa.check('the member is told the offer expired, and the stale review is withdrawn', said && !(await page.getByRole('button', { name: 'Continue to secure payment' }).count()));
    qa.check('no billing_checkout_attempts row and no consented quote from the expired review', attempts().length === 0 && !row(`select 1 as x from public.limited_billing_quotes where clerk_subject = '${user.id}'`), attempts());
  }, { soft: true });

  await qa.feature('BILL-013', 'A fresh review can be confirmed and opens Checkout', async () => {
    await page.getByRole('button', { name: /Review Credential offer|Resume checkout/ }).first().click();
    await page.getByRole('button', { name: 'Continue to secure payment' }).waitFor({ timeout: 60000 });
    qa.check('the fresh review starts unticked', !(await membership(page).getByRole('checkbox').isChecked()));
    await membership(page).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Continue to secure payment' }).click();
    const opened = await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 }).then(() => true, () => false);
    qa.check('Checkout opens from the fresh review', opened && attempts().length === 1, attempts());
    if (opened) await expireCheckout(new URL(page.url()).pathname.split('/').pop());
  }, { soft: true });
});

test('membership ends: read-only archive, downloads, no edits; buying again', {
  tag: ['@BILL-009', '@BILL-008', '@BILL-012'],
}, async ({ page, qa }) => {
  test.setTimeout(20 * 60 * 1000);
  await ensureFoundingPlaces(2);
  const { user, profile } = await newMember(page, { firstName: 'Alex', lastName: `Archive ${letters()}` });
  const pid = profile.id;

  // ── Records before the membership ends ─────────────────────────────────────
  await qa.feature('BILL-008', 'An active member opens the five Pro-locked sections with no lock', async () => {
    for (const section of ['Privileges', 'Insurance', 'Case Logs', 'Peer References', 'Malpractice History']) {
      await openCredentials(page, section).catch(() => {});
      await sleep(600);
      const body = await page.locator('body').innerText();
      qa.check(`${section}: no "Upgrade to Pro" overlay for an active member`, !/Upgrade to Pro|Pro Feature/.test(body));
    }
  }, { soft: true });

  const licNumber = `QA-RO-${letters(5).toUpperCase()}`;
  await qa.feature('BILL-009', 'Setup: a license with an attached file, a Protected Identity record, an agreement, logged work and an invoice', async () => {
    await openCredentials(page, 'Licenses');
    await page.getByRole('button', { name: 'Add' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'Display Name').fill('QA Archive License');
    await field(dlg, 'License #').fill(licNumber);
    await field(dlg, 'State').selectOption('OH');
    await field(dlg, /^Expires/).fill('2027-06-30');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 });
    await sleep(2000);
    await openCredentials(page, 'Licenses');
    await tableRow(page, licNumber).getByRole('cell').last().getByRole('button').nth(2).click();
    const edit = page.getByRole('dialog', { name: 'Edit' });
    await chooseFiles(page, edit.getByRole('button', { name: 'Upload' }), [{ name: 'qa-archive-license.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('QA synthetic archive license') }]);
    await edit.getByText(/qa-archive-license\.pdf/).first().waitFor({ timeout: 30000 });
    await sleep(1500);
    await edit.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
    await edit.waitFor({ state: 'detached', timeout: 20000 });
    const doc = await waitFor('the document row', async () => row(`select id, storage_path from public.documents where user_id = '${pid}' and name like 'qa-archive-license%'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('the license and its file are saved', !!row(`select id from public.licenses where user_id = '${pid}' and license_number = '${licNumber}'`) && !!doc?.storage_path, doc);
    // Protected Identity (device only).
    await openCredentials(page, 'Protected Identity');
    await page.getByRole('button', { name: 'Add record' }).click();
    const pi = page.getByRole('dialog', { name: 'Add protected identity' });
    await pi.getByPlaceholder('e.g. Liability application 2026').fill('QA archive identity record');
    await field(pi, 'Legal first name').fill('Alex');
    await field(pi, 'Legal last name').fill('Archive');
    await pi.getByRole('button', { name: 'Save on this device' }).click();
    await pi.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    // Practice: agreement, one entry, an invoice.
    await goTab(page, 'Practice');
    await page.getByRole('button', { name: 'Contracts', exact: true }).first().click();
    await page.getByRole('button', { name: 'Add Agreement' }).first().click();
    const ag = page.getByRole('dialog', { name: 'Add Agreement' });
    await ag.getByPlaceholder('e.g. Riverside Community Hospital').fill('QA Archive Hospital');
    await ag.getByPlaceholder('e.g. ANMG').fill('QAAH');
    await ag.locator('select').first().selectOption({ label: 'OH, Ohio' });
    await ag.getByPlaceholder('billing@hospital.org').fill(`billing-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`);
    await ag.getByPlaceholder('250').fill('200');
    await ag.getByRole('button', { name: 'Add', exact: true }).click();
    await ag.waitFor({ state: 'detached', timeout: 15000 });
    await page.getByRole('button', { name: 'Work', exact: true }).first().click();
    await page.getByRole('button', { name: 'Log past time' }).click();
    const lp = page.getByRole('dialog', { name: 'Log past time' });
    await lp.getByRole('button', { name: 'Consult', exact: true }).click();
    await lp.getByRole('button', { name: 'Yesterday' }).click();
    await lp.getByPlaceholder('e.g. 60').fill('60');
    await lp.getByPlaceholder('e.g. ED consult — head CT review').fill('QA archive consult');
    await lp.getByRole('button', { name: 'Log it' }).click();
    const yes = page.getByRole('button', { name: 'Yes, log it here' });
    if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.click();
    await lp.waitFor({ state: 'detached', timeout: 15000 });
    await page.getByRole('button', { name: /Invoice 1 unbilled entr/ }).click();
    await page.getByRole('button', { name: /^Invoice \d+ day/ }).click();
    const preview = page.getByRole('dialog', { name: 'Invoice preview' });
    await preview.getByRole('button', { name: 'Send invoice…' }).click();
    await page.getByRole('button', { name: /PDF Polished invoice/ }).click();
    const inv = await waitFor('the invoice row', async () => row(`select id, number from public.invoices where user_id = '${pid}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('an agreement, a work entry and an invoice are saved', !!inv && rows(`select id from public.work_log where user_id = '${pid}'`).length === 1, inv);
    await page.keyboard.press('Escape').catch(() => {});
  }, { soft: true });

  // ── The membership ends (Stripe cancels the subscription now) ─────────────
  let snapshotBefore;
  await qa.feature('BILL-009', 'The membership ends: Credentials, Documents and Practice become a read-only archive', async () => {
    const [sub] = (await stripeFor(user.id)).sessions.map((s) => s.subscription).filter(Boolean);
    let r = await cancelSubscription(sub, { atPeriodEnd: false });
    for (let i = 0; i < 5 && !(r.delivery?.status >= 200 && r.delivery?.status < 300); i++) {
      await sleep(3000);
      const evt = (await stripeFor(user.id)).deliveries.find((d) => d.type === 'customer.subscription.deleted');
      if (evt) r = { delivery: await mockApi(`/qa/stripe/events/${evt.event}/resend`, { method: 'POST', body: {} }) };
    }
    qa.check('customer.subscription.deleted is accepted by the webhook', r.delivery?.status >= 200 && r.delivery?.status < 300, r.delivery && `${r.delivery.status} ${r.delivery.response}`);
    const ended = await waitFor('membership ended', async () => row(`select status, membership_active from public.billing_subscriptions where profile_id = '${pid}'`)?.membership_active === false, { timeoutMs: 30000 }).catch(() => false);
    snapshotBefore = accessSnapshot(user.id);
    qa.check('the subscription is canceled and write access ends (read and export stay)', ended && snapshotBefore?.capabilities?.credential?.write === false && snapshotBefore?.capabilities?.credential?.read === true && snapshotBefore?.capabilities?.credential?.export === true, snapshotBefore?.capabilities);
    await page.goto(lab().urls.app);
    await waitForMemberApp(page).catch(() => {});
    await goTab(page, 'Credentials');
    const archive = await page.getByRole('heading', { name: 'Credential saved records' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('credential archive');
    qa.check('Credentials shows "Credential saved records" (read-only)', archive);
    const body = await page.locator('main').first().innerText().catch(() => page.locator('body').innerText());
    qa.check('the archive lists the license', body.includes(licNumber) || body.includes('QA Archive License'));
    qa.check('Protected Identity is never listed in the archive', !/Protected Identity|QA archive identity record/.test(body));
    const editButtons = await page.locator('main').first().getByRole('button', { name: /^(Add|Edit|Delete|Save|Upload|\+)/ }).count();
    qa.check('no add, edit, delete or upload buttons in the archive', editButtons === 0, `${editButtons}`);
    qa.check('no payment button in the archive', !(await page.locator('main').first().getByRole('button', { name: /Review .* offer|Continue to secure|Upgrade/ }).count()));
  }, { soft: true });

  await qa.feature('BILL-009', 'Download saved records (no Protected Identity), an attachment, and All export options', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.getByRole('button', { name: 'Download saved records' }).click()]);
    let saved = '';
    if (dl) saved = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
    qa.check('"Download saved records" downloads the credential records JSON with the license', dl?.suggestedFilename() === 'credentialdomd-credential-records.json' && saved.includes(licNumber), dl?.suggestedFilename() || 'no download');
    qa.check('the download holds no Protected Identity record', !/QA archive identity record|identityVault|protectedIdentity/i.test(saved));
    await page.locator('details').filter({ hasText: licNumber }).first().locator('summary').click().catch(() => {});
    const attach = page.getByRole('button', { name: 'Download attachment' }).first();
    const [file] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), attach.click().catch(() => {})]);
    let bytes = null;
    if (file) bytes = (await import('node:fs')).readFileSync(await file.path());
    qa.check('the attached file downloads from the archive (a PDF)', !!bytes && bytes.slice(0, 5).toString() === '%PDF-', file?.suggestedFilename() || (await page.getByRole('status').first().innerText().catch(() => 'no download')));
    await goTab(page, 'Documents');
    qa.check('Documents is the same read-only archive', await page.getByRole('heading', { name: 'Credential saved records' }).isVisible().catch(() => false));
    await page.getByRole('button', { name: 'All export options' }).click();
    const exportPage = await page.getByRole('heading', { name: 'Data & Backup' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('"All export options" opens Data & Backup', exportPage);
  }, { soft: true });

  await qa.feature('BILL-009', 'Practice archive: the invoice PDF downloads; no logging or payment controls', async () => {
    await goTab(page, 'Practice');
    const archive = await page.getByRole('heading', { name: 'Practice saved records' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('practice archive');
    qa.check('Practice shows "Practice saved records" (read-only)', archive);
    qa.check('no "Log past time", "Add Agreement" or payment buttons', !(await page.getByRole('button', { name: /Log past time|Add Agreement|Record payment|Mark paid|Invoice \d/ }).count()));
    await page.locator('details').filter({ hasText: /Invoice INV-/ }).first().locator('summary').click();
    const [pdf] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.getByRole('button', { name: 'Download invoice PDF' }).first().click().catch(() => {})]);
    let bytes = null;
    if (pdf) bytes = (await import('node:fs')).readFileSync(await pdf.path());
    qa.check('"Download invoice PDF" downloads a PDF', !!bytes && bytes.slice(0, 5).toString() === '%PDF-', pdf?.suggestedFilename() || 'no download');
  }, { soft: true });

  await qa.feature('BILL-009', 'Only display preferences change while read-only; the server records no writes', async () => {
    const before = {
      licenses: rows(`select id, updated_at from public.licenses where user_id = '${pid}' order by id`),
      work: rows(`select id, updated_at from public.work_log where user_id = '${pid}' order by id`),
      profile: row(`select name, updated_at from public.profiles where id = '${pid}'`),
    };
    const mark = qa.report.console.length;
    await openMore(page, 'Profile & settings');
    const nameInput = field(page, /^(Full )?Name/);
    let nameRefused = true;
    if (await nameInput.count()) {
      const disabled = await nameInput.isDisabled().catch(() => false);
      if (!disabled) {
        await nameInput.fill('Alex Changed While Read Only');
        await nameInput.blur();
        await sleep(2500);
      }
      await page.reload(); await waitForMemberApp(page);
      await openMore(page, 'Profile & settings');
      nameRefused = !((await field(page, /^(Full )?Name/).inputValue().catch(() => '')).includes('Changed While Read Only'));
    }
    qa.check('a profile field (name) cannot be changed while read-only', nameRefused && !(row(`select name from public.profiles where id = '${pid}'`)?.name || '').includes('Changed While Read Only'));
    const theme = page.getByRole('button', { name: /^(Dark|Light) Mode$/ }).first();
    const was = (await theme.innerText().catch(() => '')).trim();
    await theme.click().catch(() => {});
    await sleep(2500);
    await page.reload(); await waitForMemberApp(page);
    const now = (await page.getByRole('button', { name: /^(Dark|Light) Mode$/ }).first().innerText().catch(() => '')).trim();
    qa.check('the theme (a read-only preference) can still be switched and stays switched', was && now && was !== now, `${was} -> ${now}`);
    await page.getByRole('button', { name: /^(Dark|Light) Mode$/ }).first().click().catch(() => {});
    const after = {
      licenses: rows(`select id, updated_at from public.licenses where user_id = '${pid}' order by id`),
      work: rows(`select id, updated_at from public.work_log where user_id = '${pid}' order by id`),
      profile: row(`select name, updated_at from public.profiles where id = '${pid}'`),
    };
    qa.check('no record rows changed on the server (licenses, work log)', JSON.stringify(before.licenses) === JSON.stringify(after.licenses) && JSON.stringify(before.work) === JSON.stringify(after.work));
    const pending = await pendingOps(page);
    const warnings = syncWarnings(qa.report, mark);
    qa.check('nothing queued to replay later and no failed-write warnings', pending.length === 0 && warnings.length === 0, `${pending.length} queued; ${warnings.slice(0, 2).join(' | ')}`);
    const insert = await restAs(user, 'licenses', { method: 'POST', body: { user_id: pid, type: 'State Medical License', name: 'QA read-only insert' } });
    qa.check('the server refuses a record insert from the read-only account', insert.status >= 400, `HTTP ${insert.status}`);
  }, { soft: true });

  await qa.feature('BILL-008', 'With the membership ended, the Pro-locked sections are not shown with an upgrade overlay either (the archive replaces them)', async () => {
    await goTab(page, 'Credentials');
    const body = await page.locator('body').innerText();
    qa.check('no "Upgrade to Pro" or "Pro feature" anywhere for a member without write access', !/Upgrade to Pro|Pro feature|Pro Feature/.test(body));
    const snap = accessSnapshot(user.id);
    qa.check('the app\'s isPro input (capabilities.credential.read) is true for every active account, so ProGate cannot render', snap?.capabilities?.credential?.read === true && snap?.accessStatus === 'active', snap?.capabilities);
  }, { soft: true });

  // ── Buys again: outside the founding phase (standard price) ──────────────
  await qa.feature('BILL-012', 'A member whose membership ended buys Credential again at the standard price', async () => {
    await openMore(page, 'Profile & settings');
    const card = membership(page);
    await card.getByRole('button', { name: 'Review Credential offer' }).waitFor({ timeout: 30000 });
    const got = page.waitForResponse((r) => r.url().endsWith('/functions/v1/billing-quote') && r.request().method() === 'POST', { timeout: 60000 }).catch(() => null);
    await card.getByRole('button', { name: 'Review Credential offer' }).click();
    const res = await got;
    const quote = res ? await res.json().catch(() => null) : null;
    const opened = await card.getByRole('button', { name: 'Continue to secure payment' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('returning buyer quote');
    qa.check('the returning buyer\'s quote is the standard price, $199.00 per year, with a 30-day Practice trial', opened && quote?.pricePhase === 'standard' && quote?.annualCents === 19900 && quote?.practiceTrialDays === 30, quote && { phase: quote.pricePhase, cents: quote.annualCents, trialDays: quote.practiceTrialDays });
    if (!opened) return;
    await card.getByRole('checkbox').check();
    const co = page.waitForResponse((r) => r.url().endsWith('/functions/v1/limited-checkout'), { timeout: 60000 }).catch(() => null);
    await card.getByRole('button', { name: 'Continue to secure payment' }).click();
    const coRes = await co;
    const toCheckout = await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 30000 }).then(() => true, () => false);
    const body = coRes && !toCheckout ? await coRes.json().catch(() => null) : null;
    const said = toCheckout ? '' : await text(card);
    const shot = await qa.shot('returning buyer checkout');
    qa.check('Continue opens Checkout for the returning buyer', toCheckout, toCheckout ? 'Checkout opened' : `limited-checkout ${coRes?.status()} ${JSON.stringify(body)}; card: ${said.slice(0, 200)}`);
    if (toCheckout) { await expireCheckout(new URL(page.url()).pathname.split('/').pop()); return; }
    if (['checkout_offer_already_selected', 'subscription_already_exists'].includes(body?.error)) {
      const attempt = row(`select state, session_id is not null as has_session from public.billing_checkout_attempts where profile_id = '${pid}' order by created_at desc limit 1`);
      qa.bug({
        title: 'A member whose paid membership ended cannot buy again: Checkout refuses with "Your saved checkout has different terms"',
        step: 'Founding member; the subscription is canceled (customer.subscription.deleted: membership ends, read-only archive); Profile & settings > Review Credential offer ($199 standard) > agree > Continue to secure payment',
        expected: 'Checkout opens for the new purchase (the card and the quote both offer it; checkoutEligible is true)',
        actual: `limited-checkout answers ${coRes?.status()} ${body?.error}; the card says "${(said.match(/Your saved checkout has different terms[^.]*\. [^.]*\.|You already have a subscription[^.]*\./) || [''])[0]}". The paid founding attempt is still 'open' (${JSON.stringify(attempt)}): settlement never closes it, so claim_limited_billing_checkout meets it, the other terms answer offer_conflict, and limited_checkout_supersede_candidate names no prior for a quote that has a subscription, so the handler refuses (supabase/functions/_shared/limitedLaunchHandlers.mjs:240; the same-terms path refuses subscription_already_exists at :232). Already fixed on fix/qa-auth-bill-settings and release/qa1 (37c67289, migration 20260930001000_checkout_closes_on_settlement.sql, "Checkout: a member who cancels can buy again on the first try").`,
        severity: 'high', screenshot: shot,
      });
    }
  }, { soft: true });
});

test('early-bird Credential: 30-day Practice trial, then Practice read-only', {
  tag: ['@BILL-012'],
}, async ({ page, qa }) => {
  test.setTimeout(15 * 60 * 1000);
  const t = stamp('eb').toLowerCase();
  const email = `${t}@${LAB_EMAIL_DOMAIN}`;
  // An owner-reviewed invitation at the early-bird price (lab fixture): this physician's first
  // purchase is outside the founding phase without filling the lab's founding places.
  labExec(`insert into public.limited_billing_invitations (batch_id, email, token_hash, livemode, price_phase, expires_at, review_reason, origin)
    values ('qa_lab_journey', '${email}', encode(sha256(convert_to('${t}' || gen_random_uuid()::text, 'UTF8')), 'hex'), true, 'earlybird', now() + interval '30 days', 'QA lab journey fixture: an early-bird invitation for a synthetic address', 'reviewed_invitation')`);
  const user = await createPhysician({ firstName: 'Emery', lastName: `Earlybird ${letters()}`, email });
  let pid;

  await qa.feature('BILL-012', 'Credential at the early-bird price: the quote and the membership card state a 30-day Practice trial, with no automatic charge', async () => {
    await signIn(page, user);
    qa.check('the invited physician lands on the membership gate', (await landing(page)) === 'gate');
    pid = profileOf(user.id).id;
    const got = nextQuote(page);
    await page.getByRole('button', { name: 'Review Credential offer' }).click();
    const quote = await got;
    await page.getByRole('button', { name: 'Continue to secure payment' }).waitFor({ timeout: 60000 });
    const review = await text(membership(page));
    await qa.shot('earlybird quote');
    qa.check('the quote is early bird $149.00 per year, Practice not included, a 30-day trial that does not auto-charge', quote?.pricePhase === 'earlybird' && quote?.annualCents === 14900 && quote?.practiceIncluded === false && quote?.practiceTrialDays === 30 && quote?.trialAutoCharges === false && review.includes('$149.00 per year'), quote && { phase: quote.pricePhase, cents: quote.annualCents, practiceIncluded: quote.practiceIncluded, trialDays: quote.practiceTrialDays });
    await membership(page).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Continue to secure payment' }).click();
    await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 });
    const sessionId = new URL(page.url()).pathname.split('/').pop();
    await page.getByTestId('qa-stripe-pay').click();
    await page.waitForURL((u) => u.searchParams.get('billing') === 'complete', { timeout: 120000 });
    await waitForCheckoutEvents(sessionId).catch(() => null);
    const trial = await waitFor('the trial grant', async () => row(`select starts_at, ends_at from public.access_grants where profile_id = '${pid}' and kind = 'trial' and scope = 'practice'`), { timeoutMs: 60000 }).catch(() => null);
    qa.check('a 30-day Practice trial is granted when the first payment is confirmed (access_grants trial, 720 hours)', !!trial && Math.round((Date.parse(trial.ends_at) - Date.parse(trial.starts_at)) / 3600e3) === 720, trial);
    const snap = accessSnapshot(user.id);
    qa.check('billing entitlements: Credential (core) purchased, Practice by trial only, trial active, Practice writable', snap?.purchasedOfferId === 'core' && snap?.practiceIncluded === false && snap?.practiceTrial?.state === 'active' && snap?.capabilities?.practice?.write === true, snap && { offer: snap.purchasedOfferId, trial: snap.practiceTrial, practice: snap.capabilities?.practice });
    await waitForMemberApp(page).catch(() => {});
    await page.goto(lab().urls.app);
    await waitForMemberApp(page);
    await openMore(page, 'Profile & settings');
    const cardText = await text(membership(page));
    const expected = trial ? await shownDate(page, trial.ends_at) : '';
    await qa.shot('trial card');
    qa.check('the card says "Your Practice trial runs until <date>. It does not charge automatically."', cardText.includes(`Your Practice trial runs until ${expected}. It does not charge automatically.`), cardText.slice(0, 300));
    const sub = row(`select offer_id, status, membership_active from public.billing_subscriptions where profile_id = '${pid}'`);
    qa.check('the subscription is Credential only (no charge for Practice)', sub?.offer_id === 'core' && sub?.membership_active === true, sub);
  }, { soft: true });

  await qa.feature('BILL-012', 'During the trial Practice takes a work entry', async () => {
    await goTab(page, 'Practice');
    await page.getByRole('button', { name: 'Contracts', exact: true }).first().click();
    await page.getByRole('button', { name: 'Add Agreement' }).first().click();
    const ag = page.getByRole('dialog', { name: 'Add Agreement' });
    await ag.getByPlaceholder('e.g. Riverside Community Hospital').fill('QA Trial Hospital');
    await ag.getByPlaceholder('e.g. ANMG').fill('QATH');
    await ag.locator('select').first().selectOption({ label: 'OH, Ohio' });
    await ag.getByPlaceholder('billing@hospital.org').fill(`billing-${t}@${LAB_EMAIL_DOMAIN}`);
    await ag.getByPlaceholder('250').fill('180');
    await ag.getByRole('button', { name: 'Add', exact: true }).click();
    await ag.waitFor({ state: 'detached', timeout: 15000 });
    const entriesBefore = rows(`select id from public.work_log where user_id = '${pid}'`).length;
    await page.getByRole('button', { name: 'Work', exact: true }).first().click();
    await page.getByRole('button', { name: 'Log past time' }).click();
    const lp = page.getByRole('dialog', { name: 'Log past time' });
    await lp.getByRole('button', { name: 'Consult', exact: true }).click();
    await lp.getByRole('button', { name: 'Yesterday' }).click();
    await lp.getByPlaceholder('e.g. 60').fill('30');
    await lp.getByPlaceholder('e.g. ED consult — head CT review').fill('QA trial consult');
    await lp.getByRole('button', { name: 'Log it' }).click();
    const yes = page.getByRole('button', { name: 'Yes, log it here' });
    if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.click();
    await lp.waitFor({ state: 'detached', timeout: 15000 });
    const saved = await waitFor('the trial entry', async () => rows(`select id, type, duration_min from public.work_log where user_id = '${pid}'`).length > entriesBefore, { timeoutMs: 20000 }).catch(() => false);
    qa.check('the work entry is saved during the trial (a new work_log row)', saved, rows(`select type, duration_min from public.work_log where user_id = '${pid}'`));
  }, { soft: true });

  await qa.feature('BILL-012', 'When the trial ends, Practice is read-only with exports, and the member is told how to add Practice', async () => {
    // The trial end, moved into the past (fixture), as 30 days later.
    setTrialEnd(pid, "now() - interval '1 minute'");
    const countBefore = rows(`select id from public.work_log where user_id = '${pid}'`).length;
    await page.goto(lab().urls.app);
    await waitForMemberApp(page);
    const snap = accessSnapshot(user.id);
    qa.check('billing entitlements: trial expired, Practice write off, Credential write on', snap?.practiceTrial?.state === 'expired' && snap?.capabilities?.practice?.write === false && snap?.capabilities?.credential?.write === true, snap && { trial: snap.practiceTrial, practice: snap.capabilities?.practice, credential: snap.capabilities?.credential });
    await goTab(page, 'Practice');
    const archive = await page.getByRole('heading', { name: 'Practice saved records' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const shot = await qa.shot('practice after trial');
    qa.check('Practice opens as the read-only archive (exports, no logging)', archive && !(await page.getByRole('button', { name: 'Log past time' }).count()) && await page.getByRole('button', { name: 'Download saved records' }).isVisible());
    qa.check('the Practice archive lists the entry logged during the trial', /QATH/.test(body) && /Consult/.test(body));
    const explained = /Credential membership continues/i.test(body) && /Contact support about adding Practice/.test(body);
    qa.check('the Practice tab itself says the Credential membership continues and how to add Practice', explained, (body.match(/These records are read-only[^.]*\. [^.]*\. [^.]*\./) || [''])[0]);
    if (!explained) {
      qa.bug({
        title: 'After the Practice trial ends, the Practice tab says "Membership expiry does not delete your data" and does not say how to add Practice',
        step: 'Early-bird Credential member; the 30-day Practice trial ends; open Practice',
        expected: 'Practice (read-only) says the Credential membership continues, Practice is not part of it, and how to add Practice (as the membership card in Profile & settings does)',
        actual: `The archive shows the generic "These records are read-only. You can view and download them. Membership expiry does not delete your data." (src/components/features/ReadOnlyRecords.jsx:66) although the membership has not expired; the way to add Practice is only on the Profile & settings card. Already fixed on fix/qa-auth-bill-settings (0573bea5, "Practice tab: a Credential-only member is told their membership continues and how to add Practice").`,
        severity: 'low', screenshot: shot,
      });
    }
    const insert = await restAs(user, 'work_log', { method: 'POST', body: { user_id: pid, type: 'Consult', duration_min: 30 } });
    qa.check('the server refuses a new work entry after the trial', insert.status >= 400, `HTTP ${insert.status}`);
    qa.check('no new work_log rows after the trial ended', rows(`select id from public.work_log where user_id = '${pid}'`).length === countBefore);
    await openMore(page, 'Profile & settings');
    const card = await text(membership(page));
    const contact = membership(page).getByRole('link', { name: 'Contact support about adding Practice' });
    qa.check('the card says the trial has ended and saved Practice records stay readable', /Your Practice trial has ended\. Saved Practice records remain available to read and export\./.test(card), card.slice(0, 260));
    qa.check('"Contact support about adding Practice" opens an email to support (the only path: no self-service upgrade)', (await contact.getAttribute('href').catch(() => '')) === `mailto:${SUPPORT_MAILBOX}` && !(await membership(page).getByRole('button', { name: /Credential \+ Practice/ }).count()));
    qa.check('the Credential membership itself continues', /Your Credential membership is active/.test(card));
  }, { soft: true });
});

test('a free-beta member buys a membership that starts when the beta ends', {
  tag: ['@BILL-011'],
}, async ({ page, qa }) => {
  test.setTimeout(15 * 60 * 1000);
  await ensureFoundingPlaces(2);
  const t = stamp('beta').toLowerCase();
  const email = `${t}@${LAB_EMAIL_DOMAIN}`;
  // The owner's sealed no-card cohort, as a lab fixture holding this one synthetic address.
  sealBetaCohort(email, t);
  const user = await createPhysician({ firstName: 'Bailey', lastName: `Beta ${letters()}`, email });
  let grant;

  await qa.feature('BILL-011', 'The free-beta member reads the beta paragraph and its end date', async () => {
    await signIn(page, user);
    const where = await landing(page);
    const profile = await waitForProfile(user.id, (p) => p.access_status === 'active', 60000).catch(() => profileOf(user.id));
    grant = row(`select starts_at, ends_at from public.limited_beta_grants where profile_id = '${profile.id}'`);
    qa.check('signing in starts a 30-day free beta (limited_beta_grants) and the account is active', !!grant && Math.round((Date.parse(grant.ends_at) - Date.parse(grant.starts_at)) / 3600e3) === 720 && profile.access_status === 'active', grant);
    qa.check('the beta member lands in the app, not on the payment gate', where === 'member', where);
    await openMore(page, 'Profile & settings');
    const card = await text(membership(page));
    const ends = await shownDate(page, grant.ends_at);
    await qa.shot('beta card');
    qa.check('the card says the free beta is active until its end date, with no card and no automatic charge', card.includes(`Your free beta is active until ${ends}. No card is required to keep this beta, and it will not charge automatically.`), card.slice(0, 300));
  }, { soft: true });

  let sessionId;
  await qa.feature('BILL-011', 'The offer quote says $0 now and names the first charge date = the beta end', async () => {
    const card = membership(page);
    const got = nextQuote(page);
    await card.getByRole('button', { name: 'Review Credential offer' }).click();
    const quote = await got;
    await card.getByRole('button', { name: 'Continue to secure checkout' }).waitFor({ timeout: 60000 });
    const review = await text(card);
    const firstCharge = await shownDate(page, quote?.firstChargeAt);
    await qa.shot('beta quote');
    qa.check('the quote is deferred (paymentTiming after_beta) with its first charge at the beta end', quote?.paymentTiming === 'after_beta' && Math.abs(Date.parse(quote.firstChargeAt) - Date.parse(grant.ends_at)) < 1000, quote && { timing: quote.paymentTiming, firstChargeAt: quote.firstChargeAt, betaEndsAt: quote.betaEndsAt });
    qa.check(`the review says "$0 due before ${firstCharge}"`, review.includes(`$0 due before ${firstCharge}.`), review.match(/\$0 due before[^.]*\./)?.[0]);
    qa.check('the review states the first annual charge amount and date', review.includes(`Your first annual charge is $${(quote.annualCents / 100).toFixed(2)} on that date`), review.slice(0, 300));
    await card.getByRole('checkbox').check();
    await card.getByRole('button', { name: 'Continue to secure checkout' }).click();
    await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 });
    sessionId = new URL(page.url()).pathname.split('/').pop();
    const session = (await mockApi('/qa/stripe/sessions')).sessions.find((s) => s.id === sessionId);
    qa.check('Checkout collects nothing now (amount due 0; billing starts at the beta end)', session?.amount_total === 0, session && { amount_total: session.amount_total });
  }, { soft: true });

  await qa.feature('BILL-011', 'After paying, the card says the membership is scheduled and offers the billing portal; the beta end is unchanged', async () => {
    await page.getByTestId('qa-stripe-pay').click();
    await page.waitForURL((u) => u.searchParams.get('billing') === 'complete', { timeout: 120000 });
    const events = await waitForCheckoutEvents(sessionId, 60000).catch((e) => ({ error: e.message }));
    const attempts = (await mockApi('/qa/stripe/deliveries')).deliveries;
    const session = (await mockApi('/qa/stripe/sessions')).sessions.find((x) => x.id === sessionId);
    const mine = attempts.filter((d) => [session?.id, session?.subscription, session?.invoice].includes(d.object));
    const answers = [...new Set(mine.map((d) => `${d.type} ${d.status} ${String(d.response).slice(0, 80)}`))];
    qa.check('the three Checkout events are accepted by the webhook', Array.isArray(events), Array.isArray(events) ? events.map((d) => `${d.type} ${d.status}`) : answers.slice(0, 6));
    if (!Array.isArray(events) && answers.some((a) => a.includes('billing_unavailable'))) {
      const invoice = (await mockApi('/qa/stripe/sessions')).sessions.find((x) => x.id === sessionId);
      await qa.shot('deferred purchase never settles');
      qa.bug({
        title: 'A free-beta member\'s deferred purchase never settles: limited-stripe-webhook answers 503 billing_unavailable to every Checkout event',
        step: 'Free-beta member > Review Credential offer ($0 due before the beta end) > agree > Continue to secure checkout > Pay; Stripe sends checkout.session.completed, customer.subscription.created and invoice.paid',
        expected: 'The webhook records the scheduled membership (billing_subscriptions, quote billing_start_at = beta end); the card says the membership is scheduled and offers "Manage scheduled membership"',
        actual: `Every event is refused 503 {"error":"billing_unavailable"} (phase verify_subscription) and retried until Stripe gives up: ${answers.slice(0, 3).join(' | ')}. A subscription created with billing_cycle_anchor in the future and proration_behavior none is active with a paid $0 first invoice (the lab's mock Stripe models this; Stripe issues a $0 invoice at creation). limitedLaunchHandlers.mjs:336-338 sends every active subscription with a paid latest invoice to verifiedLimitedPayment, which throws "Invoice is not an exact paid annual membership" because amount_paid 0 !== 9900 (limitedLaunchPurchase.mjs:16); the throw becomes billing_unavailable. The deferred path (proof null, settle as scheduled) is never reached. The unit test fixture assumes latest_invoice null (tests/billing/limited-launch.test.mjs:303). Checkout session amount_total ${invoice?.amount_total}.`,
          severity: 'high',
      });
    }
    const pid = profileOf(user.id).id;
    const quote = await waitFor('the scheduled quote', async () => row(`select billing_start_at, subscription_id, annual_cents from public.limited_billing_quotes where clerk_subject = '${user.id}' and subscription_id is not null`), { timeoutMs: 30000 }).catch(() => null);
    const sub = row(`select status, period_end, membership_active from public.billing_subscriptions where profile_id = '${pid}'`);
    qa.check('the subscription is recorded with a deferred start (quote billing_start_at = beta end)', !!sub && !!quote && Math.abs(Date.parse(quote.billing_start_at) - Date.parse(grant.ends_at)) < 1000, { sub, quote });
    await page.goto(lab().urls.app);
    await waitForMemberApp(page);
    await openMore(page, 'Profile & settings');
    const card = await text(membership(page));
    const starts = await shownDate(page, quote?.billing_start_at || grant.ends_at);
    const ends = await shownDate(page, grant.ends_at);
    await qa.shot('scheduled membership card');
    qa.check('the card says the membership is scheduled to start at the beta end', card.includes(`Your first annual charge and paid year are scheduled to start on ${starts}.`), card.slice(0, 320));
    qa.check('the card says the original beta still ends on the same date', card.includes(`Your original free beta still ends on ${ends}.`));
    const after = row(`select starts_at, ends_at from public.limited_beta_grants where profile_id = '${pid}'`);
    qa.check('limited_beta_grants start and end are unchanged', after?.starts_at === grant.starts_at && after?.ends_at === grant.ends_at, after);
    const manageBtn = membership(page).getByRole('button', { name: 'Manage scheduled membership' });
    const offered = await manageBtn.isVisible().catch(() => false);
    if (offered) await manageBtn.click();
    const portal = offered && await page.waitForURL(/\/qa\/stripe\/hosted\/portal\//, { timeout: 60000 }).then(() => true, () => false);
    await qa.shot('scheduled membership portal');
    qa.check('"Manage scheduled membership" opens the billing portal for this customer', portal && /sub_qalab/.test(await page.locator('body').innerText()));
  }, { soft: true });
});
