// Pay first, and Cancel and get a refund (feat/pay-first-refund, owner request
// 2026-09-30: "whats the point of creating an account without paying for it
// ... create a button in their profile that allows them to cancel and get
// refunded based on the terms").
//
//   1. A new visitor signs up and lands in the current offer's review, the
//      one step before Stripe Checkout: no chooser, no usable unpaid account.
//      Coming back from an abandoned Checkout, the only thing to do is pay,
//      with the money-back guarantee stated.
//   2. A paid member's Profile offers Cancel and get a refund with the exact
//      amount. Confirming cancels the subscription now (no proration), ends
//      access on every device and on the server, and refunds the latest
//      charge once: the mock Stripe records exactly one refund. A second press
//      (another device that had the confirmation open, and the function
//      itself) answers the recorded outcome and refunds nothing more.
//   3. A free-beta member sees no refund button (the lifetime gift is checked
//      in admin-invite-gift.spec.mjs, where the gift is made).
//   4. A refund that fails at Stripe (the mock answers the refund call 500
//      once): the member is cancelled, the refund is not made, the server
//      opens exactly one support ticket in the member's name, which they read
//      in Get help, and the owner's notifier lists the row once it has been
//      stuck 15 minutes. The member's Finish refund then completes it: one
//      refund, a new attempt key, the ticket resolved.
//   5. A refund Stripe accepted that fails afterwards (refund.failed, with
//      charge.refund.updated): the row moves to needs_support with exactly
//      one ticket (a replayed event opens no second one), the member reads it
//      in Profile and Get help, and the owner's notifier query returns exactly
//      one refund line for it. The owner refunds it in the Stripe dashboard:
//      the row reads refunded, the ticket is resolved, and the line is gone.
//      The notifier's query is only run (its SQL against the lab database);
//      nothing is formatted or sent.
//   6. The refund sweep (pg_cron limited-refund-sweep), run as pg_cron runs
//      it: the job's own command, which hands pg_net one POST with the lab's
//      hook secret to the local gateway. A confirmed request that stalled
//      (cancelled, the refund failed, idle past the sweep's 10 minutes) is
//      finished exactly once, and a second run changes nothing. A member who
//      only opened the review (an unconfirmed quote) is never touched. Calls
//      without the secret, with a wrong one, or with a member's token are
//      refused and leave the stalled request as it was.
//   The ticket the server opens reads as CredentialDOMD Support's in Get
//   help, not the member's ("You"); a member's own ticket still reads "You",
//   even one that claims the refund ledger's source.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, PAY_FIRST_LINE, accessSnapshot, createPhysician, goTab, lab, landing, letters, limitedRefundAs, mockApi, newMember, openMore,
  armFunctionAnswer, prepareFunctionAnswers, profileOf, replayStripeEvent, restAs, row, rows, signIn, sleep, stamp, stripeFor, stripeMoneyFor, tokenFor, waitFor, waitForMemberApp, waitForProfile,
} from './support/lab.mjs';
import { sealBetaCohort } from './support/bill-admin-support-public-helpers.mjs';
import { callFunction, netResponses, runCronJob } from './support/ops-helpers.mjs';
import { localExec, localJson } from '../lib/local-db.mjs';
import { localGatewayOrigin } from '../lib/config.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

const TERMS = '100% no-hassle money-back guarantee on your most recent annual membership payment, including renewals.';
const GUARANTEE = /100% no-hassle money-back guarantee on your most recent annual membership payment, including renewals\./;
// The membership card says "Checking your membership…" until a fresh load's first answer
// (release/goal ef193e78); a read waits for the card to answer, up to 15 s.
const text = async (locator) => {
  let t = '';
  for (let i = 0; i < 30; i++) {
    t = (await locator.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!t.includes('Checking your membership…')) return t;
    await sleep(500);
  }
  return t;
};
const buttonNames = async (page) => (await page.getByRole('button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
const membership = (page) => page.getByRole('region', { name: 'Membership' });
const REFUND_BUTTON = 'Cancel and get a refund';
// What the gate may offer a new account that has not paid: paying, and leaving.
const PAY_ONLY = new Set(['Complete payment', 'Continue to secure payment', 'Refresh offer', 'Check access again', 'Sign out', 'Dismiss']);

// The owner's notifier (scripts/signup-notify.py): its probe, its present
// parts and its activity query, exactly as signup-notify.sh builds them, run
// read-only against the LOCAL lab database as postgres with the Management
// API's search path. Only the query: never format, remember or the iMessage.
const NOTIFY = path.join(REPO_ROOT, 'scripts', 'signup-notify.py');
const notifyPy = (args, input) => execFileSync('python3', ['-B', NOTIFY, ...args], { input, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim();
const notifyRows = (sql) => localJson(`set local search_path = "$user", public, extensions; select coalesce(json_agg(t), '[]'::json) from (${sql.trim().replace(/;\s*$/, '')}) t`, { user: 'postgres' });
const isoZ = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
function ownerAlertQuery({ now = Date.now(), since = now - 30 * 60000 } = {}) {
  const present = notifyPy(['present'], JSON.stringify(notifyRows(notifyPy(['probe']))));
  return { present: present.split(','), rows: notifyRows(notifyPy(['query', '--since', isoZ(since), '--now', isoZ(now), '--present', present])) };
}
/** The notifier's refund lines for one limited_refund_requests row (keyed refund:<id>:<standing>). */
const refundLines = (result, requestId) => result.rows.filter((r) => typeof r.key === 'string' && r.key.startsWith(`refund:${requestId}:`));
const ticketsOf = (profileId) => rows(`select id, subject, body, category, priority, status, resolved_at, context_payload->>'refund_request_id' as refund_request_id, context_payload->>'source' as source
  from public.support_tickets where user_id = '${profileId}' order by created_at`);
/**
 * The app's own limited-refund refund call, answered: { status, body }. The body can be
 * unreadable once the app has moved on (the browser drops it); then `bodyError` says so.
 */
const refundAnswer = (page) => page.waitForResponse((r) => r.url().endsWith('/functions/v1/limited-refund') && /"action":"refund"/.test(r.request().postData() || ''), { timeout: 90000 })
  .then(async (r) => { try { return { status: r.status(), body: await r.json() }; } catch (e) { return { status: r.status(), body: null, bodyError: String(e?.message || e).slice(0, 120) }; } }).catch(() => null);
// The injected Stripe failure is a single browser request with two exact
// server error lines. Read the real response immediately; an unreadable body
// cannot establish an intentional-failure claim.
async function refundFailureAnswer(page, qa, confirm) {
  let responseText;
  const answer = await qa.intentionalEdgeRequest('refund_provider_retry', 'BILL-005 deliberately arms one mock Stripe 500 api_error for this charge; the confirmed refund stops with refund_pending.', async () => {
    const pending = page.waitForResponse(r => r.url().endsWith('/functions/v1/limited-refund') && r.request().method() === 'POST'
      && /"action":"refund"/.test(r.request().postData() || ''), { timeout: 90000 });
    await confirm.click();
    const response = await pending;
    // Let the observer own body capture, including its failed-read diagnostic.
    return { url: () => response.url(), request: () => response.request(), status: () => response.status(),
      text: async () => { responseText = await response.text(); return responseText; } };
  });
  return { status: answer.status(), body: JSON.parse(responseText) };
}
/**
 * Get help > Your tickets: the ticket with `subject` is listed; open it and read its body, and
 * the label over its opening text (who the thread says wrote it: "CredentialDOMD Support" or
 * "You", then the time; shown in capitals, so compare without case).
 */
async function readTicketInGetHelp(page, subject, bodyText) {
  await openMore(page, 'Get help');
  await page.getByRole('button', { name: 'Your tickets' }).click();
  const listed = page.getByRole('button').filter({ hasText: subject }).first();
  const seen = await listed.waitFor({ timeout: 30000 }).then(() => true, () => false);
  const count = await page.getByRole('button').filter({ hasText: subject }).count();
  if (seen) await listed.click();
  const opening = page.getByText(bodyText).first();
  const body = seen && await opening.waitFor({ timeout: 30000 }).then(() => true, () => false);
  const label = body ? (await opening.locator('xpath=preceding-sibling::div[1]').innerText({ timeout: 5000 }).catch(() => '')).replace(/\s+/g, ' ').trim() : '';
  return { seen, count, body, label };
}
/** The opening text's label reads as CredentialDOMD Support's, not the member's. */
const fromSupport = (label) => /^CredentialDOMD Support · /i.test(label) && !/^You\b/i.test(label);
/** The opening text's label reads as the member's own. */
const fromYou = (label) => /^You · /i.test(label);

test('pay first: a new visitor signs up straight into the offer review; no usable unpaid account; back from an abandoned Checkout only payment is offered', {
  tag: ['@AUTH-001', '@AUTH-004', '@BILL-001', '@BILL-002', '@BILL-010', '@BILL-003'],
}, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const t = stamp('payfirst');
  const local = t.toLowerCase();
  const email = `${local}@${LAB_EMAIL_DOMAIN}`;
  let subject;

  await qa.feature('AUTH-001', 'Sign up: the account lands in the current offer review by itself, the one step before Checkout', async () => {
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
    await page.getByTestId('qa-create-first').fill('Payton');
    await page.getByTestId('qa-create-last').fill(`First ${letters()}`);
    await page.getByTestId('qa-create-email').fill(local);
    await page.getByTestId('qa-create-submit').click();
    const where = await landing(page);
    qa.check('lands on the membership gate', where === 'gate', where);
    // Nothing is pressed: the review opens by itself.
    const proceed = page.getByRole('button', { name: 'Continue to secure payment' });
    const opened = await proceed.waitFor({ timeout: 60000 }).then(() => true, () => false);
    const gate = await text(membership(page));
    await qa.shot('pay first: review opened by itself');
    qa.check('the offer review opens by itself (Continue to secure payment shown, nothing pressed)', opened, gate.slice(0, 200));
    qa.check(`the gate says "${PAY_FIRST_LINE}"`, gate.includes(PAY_FIRST_LINE), gate.slice(0, 200));
    qa.check('the gate states the 100% money-back guarantee', GUARANTEE.test(gate));
    qa.check('the review is the founding Credential offer, $99.00 per year', /Credential \$99\.00 per year/.test(gate), gate.match(/Credential \$[\d.]+ per year/)?.[0]);
    qa.check('the review carries the refund terms', gate.includes(TERMS));
    qa.check('no offer chooser and no "Creating an account does not charge you"', !/Review Credential offer|Choose whether to purchase|Creating an account does not charge you/.test(gate));
    const names = await buttonNames(page);
    qa.check('the only actions are paying (after the consent tick) and leaving', names.every((n) => PAY_ONLY.has(n)), names.join(', '));
    qa.check('Continue stays disabled until the terms are agreed', await proceed.isDisabled().catch(() => false));
    subject = (await mockApi('/qa/users')).users.find((u) => u.email === email)?.id;
    qa.check('the mock Clerk holds the new physician', !!subject, email);
    const profile = subject ? await waitForProfile(subject, () => true, 30000).catch(() => null) : null;
    qa.check('profiles row created, access pending', profile?.access_status === 'pending', profile?.access_status);
  });

  const user = { id: subject, email };

  await qa.feature('AUTH-004', 'No usable unpaid account: no app, no records, the server refuses writes', async () => {
    qa.check('no main navigation (Home, Credentials) before payment', !(await page.getByRole('button', { name: /^(Home|Credentials)$/ }).count()));
    for (const hash of ['#credentials', '#backups', '#support']) {
      await page.goto(`${lab().urls.app}${hash}`, { waitUntil: 'domcontentloaded' });
      const where = await landing(page);
      qa.check(`${hash} keeps the membership gate`, where === 'gate', where);
    }
    const reopened = await page.getByRole('button', { name: 'Continue to secure payment' }).waitFor({ timeout: 60000 }).then(() => true, () => false);
    qa.check('each visit opens the same offer review again', reopened);
    const profile = profileOf(subject);
    const insert = await restAs(user, 'licenses', { method: 'POST', body: { user_id: profile.id, type: 'State Medical License', name: 'QA unpaid insert' } });
    qa.check('the server refuses a license insert from the unpaid account', insert.status >= 400, `HTTP ${insert.status}`);
    const counts = row(`select (select count(*) from public.licenses where user_id = '${profile.id}')::int as licenses, (select count(*) from public.documents where user_id = '${profile.id}')::int as documents`);
    qa.check('zero records', counts.licenses === 0 && counts.documents === 0, counts);
    const snap = accessSnapshot(subject);
    qa.check('the database grants no writes before payment', snap?.capabilities?.credential?.write === false && snap?.capabilities?.practice?.write === false, snap?.capabilities);
  });

  let firstSession;
  await qa.feature('BILL-001', 'Straight to Checkout: agree to the terms and continue', async () => {
    await page.getByRole('checkbox', { name: /agree to the payment and renewal terms/ }).check();
    await page.getByRole('button', { name: 'Continue to secure payment' }).click();
    await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 });
    firstSession = new URL(page.url()).pathname.split('/').pop();
    qa.check('Checkout opens (the lab stand-in on the app origin)', firstSession.startsWith('cs_live_') && new URL(page.url()).origin === lab().urls.appOrigin, page.url().slice(0, 90));
    const quotes = rows(`select offer_id, price_phase, annual_cents, consented_at from public.limited_billing_quotes where clerk_subject = '${subject}'`);
    qa.check('one consented founding quote, 9900 cents', quotes.length === 1 && quotes[0].annual_cents === 9900 && quotes[0].price_phase === 'founding' && !!quotes[0].consented_at, quotes);
  });

  await qa.feature('BILL-002', 'Abandon Checkout: back in the app, the only thing to do is pay, with the guarantee', async () => {
    await page.getByTestId('qa-stripe-cancel').click();
    await page.waitForURL((u) => u.origin === lab().urls.appOrigin, { timeout: 60000 });
    const where = await landing(page);
    const notice = page.getByRole('status').filter({ hasText: /Checkout was canceled/ }).first();
    const noticed = await notice.waitFor({ timeout: 30000 }).then(() => true, () => false);
    // The page asks to pay: Complete payment, or the same offer's review reopened by itself.
    const payNow = page.getByRole('button', { name: 'Complete payment', exact: true }).or(page.getByRole('button', { name: 'Continue to secure payment' })).first();
    const offered = await payNow.waitFor({ timeout: 60000 }).then(() => true, () => false);
    await sleep(1500);
    const gate = await text(membership(page));
    const names = await buttonNames(page);
    await qa.shot('back from an abandoned Checkout');
    qa.check('back on the membership gate, not in the app', where === 'gate', where);
    qa.check('the notice says Checkout was canceled and nothing was charged', noticed && /Nothing was charged/.test(await text(notice)));
    qa.check('paying is offered (Complete payment, or the same offer\'s review reopened)', offered, names.join(', '));
    qa.check('nothing but paying and leaving is offered', names.every((n) => PAY_ONLY.has(n)), names.join(', '));
    qa.check('the guarantee is stated', gate.includes(PAY_FIRST_LINE) && GUARANTEE.test(gate), gate.slice(0, 240));
    qa.check('no offer chooser comes back', !/Review Credential offer|Choose whether to purchase/.test(gate));
    qa.check('the same founding offer ($99.00 per year)', !/Credential \$[\d.]+ per year/.test(gate) || /Credential \$99\.00 per year/.test(gate), gate.match(/Credential \$[\d.]+ per year/)?.[0]);
    if (names.includes('Continue to secure payment') && !names.includes('Complete payment')) {
      qa.byDesign('BILL-002', 'Back from an abandoned Checkout the offer review reopens by itself, so its Continue to secure payment is the one action, rather than a separate Complete payment button',
        'LimitedLaunchMembership.jsx opens the current offer review once per page load for a pay-first account (payFirstKey effect, "Coming back from an abandoned Checkout lands here again with the same offer"), and payFirstMode keeps an abandoned return in pay first (tests/limited-launch/checkout-funnel.test.mjs). Complete payment shows only while no review is open.');
    }
    const pid = profileOf(subject).id;
    qa.check('no subscription and the profile stays pending', rows(`select 1 from public.billing_subscriptions where profile_id = '${pid}'`).length === 0 && profileOf(subject).access_status === 'pending');
    const { sessions } = await stripeFor(subject);
    const money = sessions[0]?.customer ? await stripeMoneyFor(sessions[0].customer) : { charges: [] };
    qa.check('nothing was charged (no charge at the mock Stripe)', money.charges.length === 0, money.charges.map((c) => c.id).join(', '));
    // A reload is the same: only payment.
    await notice.getByRole('button', { name: 'Dismiss' }).click().catch(() => {});
    await page.reload();
    await landing(page);
    await page.getByRole('button', { name: 'Complete payment', exact: true }).or(page.getByRole('button', { name: 'Continue to secure payment' })).first().waitFor({ timeout: 60000 }).catch(() => {});
    const after = await buttonNames(page);
    qa.check('after a reload, still only paying and leaving', after.every((n) => PAY_ONLY.has(n)) && after.some((n) => /Complete payment|Continue to secure payment/.test(n)), after.join(', '));
  });

  await qa.feature('BILL-010', 'Pay from there: the same Checkout, then the account opens', async () => {
    const proceed = page.getByRole('button', { name: 'Continue to secure payment' });
    if (!(await proceed.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Complete payment', exact: true }).click();
    await proceed.waitFor({ timeout: 60000 });
    await page.getByRole('checkbox', { name: /agree to the payment and renewal terms/ }).check();
    await proceed.click();
    await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 });
    const session = new URL(page.url()).pathname.split('/').pop();
    const { sessions } = await stripeFor(subject);
    qa.check('the unfinished Checkout is reused (one session, still open)', session === firstSession && sessions.filter((s) => s.status === 'open').length === 1, `${session.slice(0, 16)} vs ${firstSession?.slice(0, 16)}; ${sessions.map((s) => s.status).join(', ')}`);
    await qa.feature('BILL-003', 'Completed resumed payment activates the membership and opens the account', async () => {
      await page.getByTestId('qa-stripe-pay').click();
      await page.waitForURL((u) => u.searchParams.get('billing') === 'complete', { timeout: 120000 });
      const active = await waitForProfile(subject, (p) => p.access_status === 'active', 90000).then(() => true, () => false);
      qa.check('the membership turns active', active);
      const opened = await waitForMemberApp(page, 90000).then(() => true, () => false);
      await qa.shot('pay first: paid, account open');
      qa.check('the account opens once paid', opened);
    });
  });
});

test('Cancel and get a refund: the exact amount, one refund of the latest charge, access ends everywhere, a second press answers the recorded outcome', {
  tag: ['@BILL-007', '@BILL-005', '@BILL-009'],
}, async ({ page, qa, secondBrowser }) => {
  test.setTimeout(10 * 60 * 1000);
  await prepareFunctionAnswers(page);
  const { user, profile } = await newMember(page, { firstName: 'Riley', lastName: `Refund ${letters()}` });
  const account = row(`select stripe_customer_id from public.billing_accounts where profile_id = '${profile.id}' and livemode`);
  const customer = account?.stripe_customer_id;
  const paid = (await stripeMoneyFor(customer)).subscriptions[0];
  const invoice = paid ? (await mockApi(`/qa/stripe/charges?invoice=${encodeURIComponent(paid.latest_invoice)}`)).charges[0] : null;
  const receipt = row(`select annual_cents, price_phase from public.access_purchase_receipts where profile_id = '${profile.id}'`);

  // Another device, signed in before the refund: it will press again afterwards.
  const other = await secondBrowser();
  await prepareFunctionAnswers(other.page);
  await signIn(other.page, user);
  await waitForMemberApp(other.page);

  let quote = null;
  await qa.feature('BILL-007', 'Profile: Cancel and get a refund with the terms, then the exact amount', async () => {
    await openMore(page, 'Profile & settings');
    const card = membership(page);
    const button = card.getByRole('button', { name: REFUND_BUTTON });
    const shown = await button.waitFor({ timeout: 30000 }).then(() => true, () => false);
    const before = await text(card);
    qa.check('the membership card offers "Cancel and get a refund"', shown, before.slice(0, 300));
    qa.check('beside it, the terms every offer states', before.includes(`Or cancel now and get your money back: ${TERMS}`), before.slice(0, 400));
    qa.check('beside "Manage paid subscription" (cancel at the period end, no refund)', /Manage paid subscription/.test(before));
    qa.check('the member paid one founding charge (9900 cents)', receipt?.annual_cents === 9900 && invoice?.amount === 9900 && invoice?.status === 'succeeded', { receipt, charge: invoice?.id, amount: invoice?.amount });
    const { answer: quoteAnswer } = await armFunctionAnswer(page, 'limited-refund', { user });
    const answered = quoteAnswer.then(a => a.body);
    await button.click();
    quote = await answered;
    const confirm = card.getByRole('button', { name: /^Cancel membership and refund / });
    await confirm.waitFor({ timeout: 30000 });
    const review = await text(card);
    await qa.shot('refund review');
    qa.check('the quote is the latest payment: its invoice and 9900 cents', quote?.state === 'available' && quote.paymentId === paid?.latest_invoice && quote.amountCents === 9900, quote);
    qa.check('the review states the exact amount, what it is and where it goes', /We will refund \$99\.00, your most recent annual membership payment, made on [A-Z][a-z]+ \d{1,2}, \d{4}/.test(review) && /in full to the card you paid with/.test(review), review.match(/We will refund[^.]*\./)?.[0]);
    qa.check('the confirm button names the exact amount: "Cancel membership and refund $99.00"', (await confirm.innerText()).trim() === 'Cancel membership and refund $99.00', await confirm.innerText());
    qa.check('it says the membership ends now and nothing is deleted', /Your membership ends now/.test(review) && /Nothing is deleted/.test(review));
    qa.check('it offers "Export saved records first" and "Keep my membership"', await card.getByRole('button', { name: 'Export saved records first' }).isVisible() && await card.getByRole('button', { name: 'Keep my membership' }).isVisible());
    qa.check('the confirm button stays disabled until the box is ticked', await confirm.isDisabled());
    qa.check('reviewing changed nothing: no refund request, no Stripe refund, subscription active',
      rows(`select 1 from public.limited_refund_requests where profile_id = '${profile.id}'`).length === 0
        && (await stripeMoneyFor(customer)).refunds.length === 0
        && row(`select status from public.billing_subscriptions where profile_id = '${profile.id}'`)?.status === 'active');
  });

  await qa.feature('BILL-005', 'The other device opens the same confirmation (for a second press later)', async () => {
    await openMore(other.page, 'Profile & settings');
    const card = membership(other.page);
    await card.getByRole('button', { name: REFUND_BUTTON }).click();
    await card.getByRole('button', { name: 'Cancel membership and refund $99.00' }).waitFor({ timeout: 30000 });
    await card.getByRole('checkbox', { name: /I understand my membership ends now/ }).check();
    qa.check('the other device shows the same $99.00 confirmation, ticked', await card.getByRole('button', { name: 'Cancel membership and refund $99.00' }).isEnabled());
  });

  await qa.feature('BILL-005', 'Confirm: cancelled now and refunded once, the latest charge, exactly one Stripe refund', async () => {
    const card = membership(page);
    await card.getByRole('checkbox', { name: /I understand my membership ends now/ }).check();
    const { answer: answered } = await armFunctionAnswer(page, 'limited-refund', { user, bodyTest: (b) => /"action":"refund"/.test(b) });
    await card.getByRole('button', { name: 'Cancel membership and refund $99.00' }).click();
    const answer = await answered;
    const outcome = page.locator('[data-refund-outcome]').first();
    await outcome.waitFor({ timeout: 60000 }).catch(() => {});
    const shown = await text(outcome);
    await qa.shot('refunded');
    qa.check('the function answers refunded (200)', answer?.status === 200 && answer.body?.state === 'refunded' && answer.body.amountCents === 9900 && answer.body.subscriptionCanceled === true, answer);
    qa.check('Profile shows the outcome: "Refunded: $99.00 on ... Your membership has ended and will not renew."', /Refunded: \$99\.00 on .+ Your membership has ended and will not renew\./.test(shown), shown.slice(0, 240));
    qa.check('and that the refund went to the card paid with', /The refund has been issued to the card you paid with|The refund is on its way to the card you paid with/.test(shown));
    qa.check('the refund button is gone', !(await page.getByRole('button', { name: REFUND_BUTTON }).count()));

    const money = await stripeMoneyFor(customer);
    const refunds = money.refunds;
    qa.check('the mock Stripe records exactly one refund for this customer', refunds.length === 1, refunds.map((r) => `${r.id} ${r.amount} ${r.charge}`).join('; '));
    const [refund] = refunds;
    qa.check('it refunds the latest charge (the subscription\'s latest invoice\'s charge), in full: 9900', !!invoice && refund?.charge === invoice.id && refund.invoice === paid.latest_invoice && refund.amount === 9900 && refund.status === 'succeeded', refund);
    qa.check('made with an Idempotency-Key bound to that charge and attempt', new RegExp(`:refund:${invoice?.id}:1$`).test(refund?.idempotencyKey || ''), refund?.idempotencyKey);
    const charge = money.charges.find((c) => c.id === invoice?.id);
    qa.check('the charge reads refunded in full', charge?.refunded === true && charge.amount_refunded === 9900, charge && { refunded: charge.refunded, amount_refunded: charge.amount_refunded });
    const sub = money.subscriptions.find((s) => s.id === paid?.id);
    qa.check('the subscription was cancelled now, with no proration credit and no final invoice', sub?.status === 'canceled' && sub.cancel_at_period_end === false && sub.cancellation?.prorate === false && sub.cancellation?.invoiceNow === false, sub && { status: sub.status, cancellation: sub.cancellation });
    const ledger = rows(`select state, invoice_id, charge_id, amount_cents, refund_id, refund_status, attempts, subscription_canceled_at is not null as cancelled from public.limited_refund_requests where profile_id = '${profile.id}'`);
    qa.check('limited_refund_requests: one row, refunded, the same charge and refund, cancelled first', ledger.length === 1 && ledger[0].state === 'refunded' && ledger[0].charge_id === invoice?.id && ledger[0].refund_id === refund?.id && ledger[0].amount_cents === 9900 && ledger[0].cancelled === true, ledger);
    // Stripe's own events for the cancellation and the refund reach the webhook and are accepted.
    const events = await waitFor('customer.subscription.deleted and charge.refunded accepted', async () => {
      const all = (await mockApi('/qa/stripe/deliveries')).deliveries.filter((d) => d.customer === customer);
      const ok = (type) => all.some((d) => d.type === type && d.status === 200);
      return ok('customer.subscription.deleted') && ok('charge.refunded') ? all : null;
    }, { timeoutMs: 90000, intervalMs: 1000 }).catch(() => null);
    qa.check('Stripe\'s customer.subscription.deleted and charge.refunded are accepted by the webhook (200)', !!events, (events || []).filter((d) => /deleted|refunded/.test(d.type)).map((d) => `${d.type} ${d.status}#${d.attempt}`).join(', '));
    qa.check('still exactly one refund after the events', (await stripeMoneyFor(customer)).refunds.length === 1);
  });

  await qa.feature('BILL-009', 'Access ends everywhere: this device, the other device, the database, the server', async () => {
    const subRow = row(`select status, membership_active, cancel_at_period_end from public.billing_subscriptions where profile_id = '${profile.id}'`);
    qa.check('billing_subscriptions: canceled, membership no longer active', subRow?.status === 'canceled' && subRow.membership_active === false, subRow);
    const snap = accessSnapshot(user.id);
    qa.check('the database grants no Credential or Practice writes', snap?.capabilities?.credential?.write === false && snap?.capabilities?.practice?.write === false, snap?.capabilities);
    const insert = await restAs(user, 'licenses', { method: 'POST', body: { user_id: profile.id, type: 'State Medical License', name: 'QA after refund' } });
    qa.check('the server refuses a new license', insert.status >= 400, `HTTP ${insert.status}`);
    qa.check('nothing is deleted: the account stays', profileOf(user.id)?.access_status === 'active' && !profileOf(user.id)?.data_deletion_date, profileOf(user.id)?.access_status);
    // This device.
    await page.reload();
    await waitForMemberApp(page).catch(() => {});
    await goTab(page, 'Credentials');
    const credential = await page.getByRole('heading', { name: 'Credential saved records' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('this device: Credentials is the read-only saved records view', credential && await page.getByText('These records are read-only.').first().isVisible().catch(() => false));
    await goTab(page, 'Practice');
    const practice = await page.getByRole('heading', { name: 'Practice saved records' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('this device: Practice is read-only too', practice);
    await qa.shot('after refund: read-only');
    await goTab(page, 'More');
    qa.check('More no longer offers "Cancel Subscription"', !(await page.getByRole('button', { name: 'Cancel Subscription' }).count()));
  });

  await qa.feature('BILL-005', 'A second press answers the recorded outcome and refunds nothing', async () => {
    // The other device still has the ticked $99.00 confirmation from before the refund.
    const card = membership(other.page);
    const { answer: answered } = await armFunctionAnswer(other.page, 'limited-refund', { user, bodyTest: (b) => /"action":"refund"/.test(b) });
    await card.getByRole('button', { name: 'Cancel membership and refund $99.00' }).click();
    const answer = await answered;
    const outcome = other.page.locator('[data-refund-outcome="refunded"]').first();
    const shown = await outcome.waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('second press', other.page);
    qa.check('the other device\'s press is answered with the recorded outcome (refunded, 200)', answer?.status === 200 && answer.body?.state === 'refunded', answer);
    qa.check('the other device shows "Refunded: $99.00"', shown && /Refunded: \$99\.00/.test(await text(outcome)));
    const direct = await limitedRefundAs(user, { action: 'refund', paymentId: quote?.paymentId, amountCents: 9900, confirm: true });
    qa.check('pressed again at the function itself: 200, the recorded outcome', direct.status === 200 && direct.body?.state === 'refunded' && direct.body.paymentId === quote?.paymentId, direct);
    const status = await limitedRefundAs(user, { action: 'status' });
    qa.check('status reads refunded', status.body?.state === 'refunded' && status.body.refundStatus === 'succeeded', status);
    await sleep(3000);
    qa.check('still exactly one refund at the mock Stripe', (await stripeMoneyFor(customer)).refunds.length === 1);
    const ledger = rows(`select state, attempts from public.limited_refund_requests where profile_id = '${profile.id}'`);
    qa.check('still one refund request, refunded, never worked on again', ledger.length === 1 && ledger[0].state === 'refunded' && ledger[0].attempts === 1, ledger);
    // The other device's access follows too.
    await other.page.reload();
    await waitForMemberApp(other.page).catch(() => {});
    await goTab(other.page, 'Credentials');
    qa.check('the other device: Credentials is read-only after a reload', await other.page.getByRole('heading', { name: 'Credential saved records' }).waitFor({ timeout: 30000 }).then(() => true, () => false));
  });

  await qa.feature('BILL-007', 'Every later visit shows the recorded outcome; joining again is at the standard price', async () => {
    const refundAnswers = [];
    const onRefund = (r) => { if (r.url().endsWith('/functions/v1/limited-refund')) refundAnswers.push(r.status()); };
    page.on('response', onRefund);
    await openMore(page, 'Profile & settings');
    const card = membership(page);
    const outcome = page.locator('[data-refund-outcome="refunded"]').first();
    let shown = await outcome.waitFor({ timeout: 30000 }).then(() => true, () => false);
    // The outcome is read once per visit (limited-refund). When that read met the lab gateway's
    // reset connection to PostgREST it answered 503 and the card showed none (2026-10-01, full
    // regression pass 2, with Kong's reset line for limited_refund_for_subscription); the member
    // opens Profile again after a reload, as the check's name says.
    if (!shown && refundAnswers.some((st) => st >= 500)) {
      await page.reload();
      await waitForMemberApp(page);
      await openMore(page, 'Profile & settings');
      shown = await outcome.waitFor({ timeout: 30000 }).then(() => true, () => false);
    }
    page.off('response', onRefund);
    qa.check('Profile shows "Your refund ... Refunded: $99.00" after a reload', shown && /Refunded: \$99\.00/.test(await text(outcome)), `limited-refund answered ${refundAnswers.join(', ') || 'nothing'}`);
    qa.check('no refund button on a membership that has ended', !(await card.getByRole('button', { name: REFUND_BUTTON }).count()));
    const slot = row(`select state from public.limited_founding_slots where profile_id = '${profile.id}' and livemode`);
    qa.check('the paid founding place is not given back', slot?.state === 'paid', slot);
    const offer = card.getByRole('button', { name: 'Review Credential offer' });
    if (await offer.isVisible().catch(() => false)) {
      await offer.click();
      await card.getByRole('button', { name: 'Continue to secure payment' }).waitFor({ timeout: 60000 }).catch(() => {});
      const review = await text(card);
      qa.check('a later purchase is quoted at the standard price ($199.00 per year)', /Credential \$199\.00 per year/.test(review), review.match(/Credential \$[\d.]+ per year/)?.[0]);
    } else qa.check('the card offers to join again', false, (await text(card)).slice(0, 300));
  });
});

test('no refund button: a free-beta member', {
  tag: ['@BILL-011', '@BILL-007'],
}, async ({ page, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const t = stamp('betarefund').toLowerCase();
  const email = `${t}@${LAB_EMAIL_DOMAIN}`;
  sealBetaCohort(email, t);
  const user = await createPhysician({ firstName: 'Beta', lastName: `Norefund ${letters()}`, email });

  await qa.feature('BILL-011', 'A free-beta member: no refund button, and the function has nothing to refund', async () => {
    await signIn(page, user);
    const where = await landing(page);
    qa.check('the beta member lands in the app, not in pay first', where === 'member', where);
    await waitForMemberApp(page);
    await openMore(page, 'Profile & settings');
    const card = membership(page);
    await qa.feature('BILL-007', 'The free-beta membership card shows active access and no paid refund action', async () => {
      await card.getByText(/Your free beta is active until/).first().waitFor({ timeout: 30000 }).catch(() => {});
      const shown = await text(card);
      await qa.shot('beta card');
      qa.check('the card says the free beta is active', /Your free beta is active until/.test(shown), shown.slice(0, 200));
      qa.check('no "Cancel and get a refund" on the card', !(await card.getByRole('button', { name: REFUND_BUTTON }).count()) && !shown.includes('Or cancel now and get your money back'));
    });
    await goTab(page, 'More');
    qa.check('More has no "Cancel Subscription"', !(await page.getByRole('button', { name: 'Cancel Subscription' }).count()));
    qa.check('no refund button anywhere in the app', !(await page.getByRole('button', { name: REFUND_BUTTON }).count()));
    const quote = await qa.intentionalEdgeRequest('unpaid_refund', 'BILL-011 verifies a free-beta account has no paid membership to refund.', () => limitedRefundAs(user, { action: 'quote' }));
    qa.check('limited-refund quote: nothing to refund (404 no_paid_membership)', quote.status === 404 && quote.body?.error === 'no_paid_membership', quote);
    const status = await limitedRefundAs(user, { action: 'status' });
    qa.check('limited-refund status: none', status.status === 200 && status.body?.state === 'none', status);
  });
});

test('a refund that fails at Stripe: the member is cancelled, one support ticket they read in Get help, the owner alerted once, and Finish refund completes it', {
  tag: ['@BILL-005', '@BILL-007', '@SUPPORT-002'],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Rowan', lastName: `Refail ${letters()}` });
  const customer = row(`select stripe_customer_id from public.billing_accounts where profile_id = '${profile.id}' and livemode`)?.stripe_customer_id;
  const paid = (await stripeMoneyFor(customer)).subscriptions[0];
  const charge = paid ? (await mockApi(`/qa/stripe/charges?invoice=${encodeURIComponent(paid.latest_invoice)}`)).charges[0] : null;
  let request = null;
  let subject = null;

  await qa.feature('BILL-005', 'Stripe fails the refund once: cancelled, not refunded, told a ticket was opened', async () => {
    qa.check('the member paid one founding charge (9900 cents)', charge?.amount === 9900 && charge.status === 'succeeded', charge && { id: charge.id, amount: charge.amount });
    const armed = await mockApi('/qa/stripe/refund-failures', { method: 'POST', body: { charge: charge.id } });
    qa.check('the mock Stripe will answer the next refund of this charge 500 api_error, once', armed.status === 500 && armed.type === 'api_error' && armed.remaining === 1, armed);
    await openMore(page, 'Profile & settings');
    const card = membership(page);
    await card.getByRole('button', { name: REFUND_BUTTON }).click();
    const confirm = card.getByRole('button', { name: 'Cancel membership and refund $99.00' });
    await confirm.waitFor({ timeout: 30000 });
    await card.getByRole('checkbox', { name: /I understand my membership ends now/ }).check();
    const answer = await refundFailureAnswer(page, qa, confirm);
    // The card settles once the membership answer that follows the cancellation is in:
    // the recorded standing (from limited-refund's status) and Finish refund.
    const standing = card.getByText('We opened a support ticket for you, which you can read in Get help, and we will finish your refund for you.').first();
    await standing.waitFor({ timeout: 60000 }).catch(() => {});
    const finish = card.getByRole('button', { name: 'Finish refund' });
    const offered = await finish.waitFor({ timeout: 30000 }).then(() => true, () => false);
    const shown = await text(card);
    await qa.shot('refund failed at Stripe');
    qa.check('the function answers 503 refund_pending (a stop another try may fix)', answer?.status === 503 && (answer.body?.error === 'refund_pending' || (answer.body === null && !!answer.bodyError)), answer);
    // The press's own alert ("Your refund did not finish. Nothing was refunded twice.") can be
    // replaced as the membership answer that follows the cancellation re-renders the card; the
    // recorded standing below is what stays.
    qa.check('Profile says the membership is cancelled and a support ticket was opened, readable in Get help, nothing needed', shown.includes('Your refund is not finished yet. Your membership is cancelled. We opened a support ticket for you, which you can read in Get help, and we will finish your refund for you. You do not need to do anything.'), shown.slice(0, 400));
    qa.check('Profile offers Finish refund', offered);

    const failures = (await mockApi(`/qa/stripe/refund-failures?charge=${encodeURIComponent(charge.id)}`)).failures[charge.id];
    qa.check('the refund call reached the mock Stripe once, keyed to attempt 1, and failed', failures?.remaining === 0 && failures.calls.length === 1 && new RegExp(`:refund:${charge.id}:1$`).test(failures.calls[0].idempotencyKey || ''), failures?.calls);
    const money = await stripeMoneyFor(customer);
    qa.check('nothing was refunded: no refund at the mock Stripe, the charge unrefunded', money.refunds.length === 0 && money.charges.find((c) => c.id === charge.id)?.amount_refunded === 0, money.refunds.map((r) => r.id));
    const sub = money.subscriptions.find((x) => x.id === paid.id);
    qa.check('the subscription was cancelled now, no proration credit', sub?.status === 'canceled' && sub.cancellation?.prorate === false && sub.cancellation?.invoiceNow === false, sub && { status: sub.status, cancellation: sub.cancellation });
    const ledger = rows(`select id, state, error_code, attempts, lease_token is null as released, subscription_canceled_at is not null as cancelled, refund_id, support_ticket_id from public.limited_refund_requests where profile_id = '${profile.id}'`);
    request = ledger[0] || null;
    qa.check('limited_refund_requests: one row, requested, cancelled, refund_failed, lease released, attempt 1, linked to a ticket',
      ledger.length === 1 && request.state === 'requested' && request.cancelled && request.error_code === 'refund_failed' && request.released && request.attempts === 1 && !request.refund_id && !!request.support_ticket_id, ledger);
    const subRow = row(`select status, membership_active from public.billing_subscriptions where profile_id = '${profile.id}'`);
    qa.check('the member is cancelled: billing_subscriptions canceled, not active', subRow?.status === 'canceled' && subRow.membership_active === false, subRow);
    const snap = accessSnapshot(user.id);
    qa.check('the database grants no Credential or Practice writes', snap?.capabilities?.credential?.write === false && snap?.capabilities?.practice?.write === false, snap?.capabilities);
  });

  await qa.feature('SUPPORT-002', 'Exactly one support ticket, in the member\'s name, which they read in Get help', async () => {
    const tickets = ticketsOf(profile.id);
    const [ticket] = tickets;
    subject = ticket?.subject;
    qa.check('exactly one support ticket for the member, the refund\'s', tickets.length === 1 && ticket.id === request?.support_ticket_id && ticket.refund_request_id === request?.id && ticket.source === 'limited_refund', tickets.map((x) => `${x.id} ${x.status} ${x.subject}`));
    qa.check('billing, priority high, open', ticket?.category === 'billing' && ticket.priority === 'high' && ticket.status === 'open', ticket && { category: ticket.category, priority: ticket.priority, status: ticket.status });
    qa.check('subject: "Your refund of $99.00 will be finished for you"', subject === 'Your refund of $99.00 will be finished for you', subject);
    qa.check('the body states the amount, the payment date, that the membership is cancelled and not refunded, and that the owner finishes it',
      /^CredentialDOMD opened this ticket for you automatically\./.test(ticket?.body || '') && /Refund: \$99\.00, your annual membership payment made on [A-Z][a-z]+ \d{1,2}, \d{4}\./.test(ticket.body)
        && ticket.body.includes('Status: Your membership is cancelled. The refund has not gone through yet, so the payment has not been returned.') && ticket.body.includes('The owner of CredentialDOMD will finish this refund for you and reply here. You do not need to do anything.'), ticket?.body);
    qa.check('no card data or provider ids in the ticket', !/\b(ch|re|sub|in|cus|pi|pm)_[A-Za-z0-9]{6,}/.test(`${ticket?.subject} ${ticket?.body}`));
    const own = await restAs(user, `support_tickets?select=id,subject,status&id=eq.${ticket?.id}`);
    qa.check('the member reads it with their own session (RLS)', own.status === 200 && Array.isArray(own.data) && own.data.length === 1 && own.data[0].subject === subject, own);
    const help = await readTicketInGetHelp(page, subject, 'CredentialDOMD opened this ticket for you automatically.');
    await qa.shot('the refund ticket in Get help');
    qa.check('Get help > Your tickets lists it once, and it opens with the facts', help.seen && help.count === 1 && help.body, help);
    qa.check('its opening text reads as from CredentialDOMD Support, not "You"', fromSupport(help.label), help.label);
  });

  await qa.feature('BILL-005', 'The owner\'s notifier: one line once the row has been stuck 15 minutes, none before', async () => {
    const soon = ownerAlertQuery();
    qa.check('the notifier reads limited_refund_requests (the part is present)', soon.present.includes('limited_refund_requests'), soon.present);
    qa.check('right now: no refund line yet (cancelled and not refunded for under 15 minutes)', refundLines(soon, request?.id).length === 0, refundLines(soon, request?.id));
    const later = ownerAlertQuery({ now: Date.now() + 16 * 60000 });
    const lines = refundLines(later, request?.id);
    qa.check('16 minutes on, still stuck: exactly one refund line, REFUND UNFINISHED, keyed to the row', lines.length === 1 && lines[0].kind === 'REFUND UNFINISHED' && lines[0].key === `refund:${request?.id}:unfinished`, lines);
    qa.check('the line: the member, $99, cancelled, not refunded, the error code and the row\'s short id', lines[0]?.email === user.email && lines[0].extra === `$99, cancelled, not refunded (refund_failed), row ${request?.id.slice(0, 8)}`, lines[0]);
  });

  await qa.feature('BILL-007', 'Finish refund completes it: one refund, a new attempt, the ticket resolved', async () => {
    await page.reload();
    await waitForMemberApp(page).catch(() => {});
    await openMore(page, 'Profile & settings');
    const card = membership(page);
    const finish = card.getByRole('button', { name: 'Finish refund' });
    const offered = await finish.waitFor({ timeout: 30000 }).then(() => true, () => false);
    const before = await text(card);
    qa.check('after a reload Profile still says the refund is unfinished, a ticket was opened, and offers Finish refund', offered && before.includes('We opened a support ticket for you, which you can read in Get help'), before.slice(0, 300));
    await finish.click();
    const again = card.getByRole('button', { name: 'Finish refund' });
    await card.getByRole('checkbox', { name: /I understand my membership ends now/ }).waitFor({ timeout: 30000 });
    const review = await text(card);
    qa.check('the review is the same payment: $99.00, in full to the card paid with', /We will refund \$99\.00, your most recent annual membership payment, made on [A-Z][a-z]+ \d{1,2}, \d{4}.*?, in full to the card you paid with\./.test(review), review.match(/We will refund .*?card you paid with\./)?.[0]);
    await card.getByRole('checkbox', { name: /I understand my membership ends now/ }).check();
    const answered = refundAnswer(page);
    await again.click();
    const answer = await answered;
    const outcome = page.locator('[data-refund-outcome="refunded"]').first();
    const shown = await outcome.waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('refund finished after the failure');
    // The answer's body, or (when the browser no longer holds it) the recorded outcome it reports.
    const said = answer?.body || (answer?.status === 200 ? (await limitedRefundAs(user, { action: 'status' })).body : null);
    qa.check('the function answers refunded (200)', answer?.status === 200 && said?.state === 'refunded' && said.amountCents === 9900 && said.subscriptionCanceled === true, answer?.body ? answer : { ...answer, status: said });
    qa.check('Profile shows "Refunded: $99.00"', shown && /Refunded: \$99\.00 on .+ Your membership has ended and will not renew\./.test(await text(outcome)));
    const money = await stripeMoneyFor(customer);
    qa.check('the mock Stripe holds exactly one refund, of the charge, 9900, keyed to attempt 2', money.refunds.length === 1 && money.refunds[0].charge === charge.id && money.refunds[0].amount === 9900 && money.refunds[0].status === 'succeeded' && new RegExp(`:refund:${charge.id}:2$`).test(money.refunds[0].idempotencyKey || ''), money.refunds.map((r) => `${r.id} ${r.amount} ${r.idempotencyKey}`));
    const ledger = rows(`select state, refund_id, refund_status, attempts, error_code, support_ticket_id from public.limited_refund_requests where profile_id = '${profile.id}'`);
    qa.check('limited_refund_requests: still one row, refunded with that refund, attempt 2, no error', ledger.length === 1 && ledger[0].state === 'refunded' && ledger[0].refund_id === money.refunds[0]?.id && ledger[0].attempts === 2 && !ledger[0].error_code && ledger[0].support_ticket_id === request?.support_ticket_id, ledger);
    const tickets = ticketsOf(profile.id);
    qa.check('still exactly one ticket, now resolved, saying it was refunded', tickets.length === 1 && tickets[0].status === 'resolved' && !!tickets[0].resolved_at && /Status: Refunded\. The refund was issued on [A-Z][a-z]+ \d{1,2}, \d{4} to the card you paid with\. Nothing more is needed\./.test(tickets[0].body)
      && !tickets[0].body.includes('will finish this refund'), tickets.map((x) => ({ status: x.status, body: x.body })));
    const events = await waitFor('charge.refunded accepted', async () => {
      const all = (await mockApi('/qa/stripe/deliveries')).deliveries.filter((d) => d.customer === customer && d.type === 'charge.refunded');
      return all.some((d) => d.status === 200) ? all : null;
    }, { timeoutMs: 90000, intervalMs: 1000 }).catch(() => null);
    qa.check('Stripe\'s charge.refunded is accepted by the webhook (200); still one refund', !!events && (await stripeMoneyFor(customer)).refunds.length === 1);
    const later = ownerAlertQuery({ now: Date.now() + 16 * 60000 });
    qa.check('the owner\'s notifier has no refund line for it any more', refundLines(later, request?.id).length === 0, refundLines(later, request?.id));
  });
});

test('refund.failed after Stripe accepted the refund: needs support with one ticket, one owner line, and the owner refunds it in the dashboard', {
  tag: ['@BILL-005', '@SUPPORT-002', '@BILL-007'],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Reese', lastName: `Refback ${letters()}` });
  const customer = row(`select stripe_customer_id from public.billing_accounts where profile_id = '${profile.id}' and livemode`)?.stripe_customer_id;
  let request = null;
  let refundId = null;
  let chargeId = null;
  let failedEvent = null;

  await qa.feature('BILL-005', 'Refunded, then Stripe reports the refund failed: needs support', async () => {
    const quote = await limitedRefundAs(user, { action: 'quote' });
    const done = await limitedRefundAs(user, { action: 'refund', paymentId: quote.body?.paymentId, amountCents: quote.body?.amountCents, confirm: true });
    qa.check('Cancel and get a refund: refunded (200)', done.status === 200 && done.body?.state === 'refunded' && done.body.amountCents === 9900, done);
    const settled = await waitFor('customer.subscription.deleted and charge.refunded accepted', async () => {
      const all = (await mockApi('/qa/stripe/deliveries')).deliveries.filter((d) => d.customer === customer);
      return ['customer.subscription.deleted', 'charge.refunded'].every((t) => all.some((d) => d.type === t && d.status === 200)) ? all : null;
    }, { timeoutMs: 90000, intervalMs: 1000 }).catch(() => null);
    qa.check('Stripe\'s own events for it were accepted first', !!settled);
    const [refund] = (await stripeMoneyFor(customer)).refunds;
    refundId = refund?.id; chargeId = refund?.charge;
    qa.check('a refund that never needed a person opened no ticket', ticketsOf(profile.id).length === 0, ticketsOf(profile.id).map((x) => x.subject));

    const failed = await qa.intentionalRefundFailure({ refundId, chargeId, customer });
    failedEvent = failed.deliveries.find((d) => d.type === 'refund.failed')?.event || null;
    qa.check('the mock Stripe: the refund failed (expired_or_canceled_card), the money back on the charge', failed.refund.status === 'failed' && failed.refund.failure_reason === 'expired_or_canceled_card' && failed.charge.amount_refunded === 0 && failed.charge.refunded === false, { refund: failed.refund.status, charge: failed.charge.amount_refunded });
    qa.check('charge.refund.updated and refund.failed are accepted by the webhook (200)', failed.deliveries.map((d) => `${d.type} ${d.status}`).join(', ') === 'charge.refund.updated 200, refund.failed 200', failed.deliveries.map((d) => `${d.type} ${d.status} ${d.response?.slice(0, 80)}`));
    const ledger = rows(`select id, state, refund_id, refund_status, error_code, refunded_at, subscription_canceled_at is not null as cancelled, support_ticket_id from public.limited_refund_requests where profile_id = '${profile.id}'`);
    request = ledger[0] || null;
    qa.check('limited_refund_requests: one row, needs_support, refund failed, expired_or_canceled_card, no refunded date, still cancelled, linked to a ticket',
      ledger.length === 1 && request.state === 'needs_support' && request.refund_id === refundId && request.refund_status === 'failed' && request.error_code === 'expired_or_canceled_card' && !request.refunded_at && request.cancelled && !!request.support_ticket_id, ledger);
    const status = await limitedRefundAs(user, { action: 'status' });
    qa.check('status reads needs_support, cancelled, with a support ticket', status.status === 200 && status.body?.state === 'needs_support' && status.body.subscriptionCanceled === true && status.body.supportTicket === true && status.body.refundStatus === 'failed', status.body);
  });

  await qa.feature('SUPPORT-002', 'Exactly one ticket, which a replayed event does not duplicate; the member reads it', async () => {
    const tickets = ticketsOf(profile.id);
    const [ticket] = tickets;
    qa.check('exactly one support ticket, the refund\'s, billing, high, open', tickets.length === 1 && ticket.id === request?.support_ticket_id && ticket.refund_request_id === request?.id && ticket.category === 'billing' && ticket.priority === 'high' && ticket.status === 'open', tickets.map((x) => `${x.status} ${x.subject}`));
    qa.check('the body says it was started but did not go through, and the owner finishes it', (ticket?.body || '').includes('Status: Your membership is cancelled. The refund was started but did not go through, so the payment has not been returned.') && ticket.body.includes('The owner of CredentialDOMD will finish this refund for you and reply here.'), ticket?.body);
    qa.check('no card data or provider ids in the ticket', !/\b(ch|re|sub|in|cus|pi|pm)_[A-Za-z0-9]{6,}/.test(`${ticket?.subject} ${ticket?.body}`));
    const replay = failedEvent ? await replayStripeEvent(failedEvent) : null;
    await sleep(1500);
    qa.check('refund.failed delivered again: accepted, still exactly one ticket, the row unchanged', replay?.status === 200 && ticketsOf(profile.id).length === 1 && row(`select state from public.limited_refund_requests where id = '${request?.id}'`)?.state === 'needs_support', replay && { status: replay.status, tickets: ticketsOf(profile.id).length });
    await qa.feature('BILL-007', 'The membership card preserves the failed-refund standing after reload', async () => {
      await page.reload();
      await waitForMemberApp(page).catch(() => {});
      await openMore(page, 'Profile & settings');
      const outcome = page.locator('[data-refund-outcome="needs_support"]').first();
      const shown = await outcome.waitFor({ timeout: 30000 }).then(() => true, () => false);
      const said = await text(outcome);
      await qa.shot('refund failed afterwards: needs support');
      qa.check('Profile: "Your refund needs support", a ticket was opened in Get help, nothing needed', shown && said.includes('Your membership was cancelled, but the refund could not be completed automatically. We opened a support ticket for you, which you can read in Get help, and we will finish your refund for you. You do not need to do anything.'), said.slice(0, 300));
    });
    const help = await readTicketInGetHelp(page, ticket?.subject, 'The refund was started but did not go through');
    qa.check('Get help > Your tickets lists it once, and it opens with the facts', help.seen && help.count === 1 && help.body, help);
    qa.check('its opening text reads as from CredentialDOMD Support, not "You"', fromSupport(help.label), help.label);
  });

  await qa.feature('BILL-005', 'The owner\'s notifier query: exactly one line for it', async () => {
    const result = ownerAlertQuery();
    const lines = refundLines(result, request?.id);
    // Since review round 3 the needs_support key also carries a digest of why and of the refund it
    // names (signup-notify.py), so a row that needs support again for a new reason is reported again.
    qa.check('exactly one refund line for the row: REFUND NEEDS SUPPORT, keyed refund:<id>:needs_support:<digest>', lines.length === 1 && lines[0].kind === 'REFUND NEEDS SUPPORT' && new RegExp(`^refund:${request?.id}:needs_support:[0-9a-f]{12}$`).test(lines[0].key), lines);
    qa.check('the line: the member, $99, needs support, refund failed, the reason and the row\'s short id', lines[0]?.email === user.email && lines[0].extra === `$99, needs support, refund failed (expired_or_canceled_card), row ${request?.id.slice(0, 8)}`, lines[0]);
    const ticketLines = result.rows.filter((r) => r.kind === 'TICKET' && r.email === user.email);
    qa.check('the ticket itself is the notifier\'s usual TICKET line (one), separate from the refund line', ticketLines.length === 1, ticketLines.map((r) => r.extra));
  });

  await qa.feature('BILL-005', 'The owner refunds it in the Stripe dashboard: refunded, the ticket resolved, the line gone', async () => {
    const { refund: again } = await mockApi(`/qa/stripe/charges/${encodeURIComponent(chargeId)}/refund`, { method: 'POST', body: {} });
    const recorded = await waitFor('the row refunded by charge.refunded', async () => {
      const r = row(`select state, refund_id, refund_status, refunded_at, error_code from public.limited_refund_requests where id = '${request?.id}'`);
      return r?.state === 'refunded' ? r : null;
    }, { timeoutMs: 90000, intervalMs: 1000 }).catch(() => null);
    qa.check('limited_refund_requests: refunded, with the dashboard refund, succeeded, no error', recorded?.refund_id === again?.id && recorded.refund_status === 'succeeded' && !!recorded.refunded_at && !recorded.error_code, recorded);
    const money = await stripeMoneyFor(customer);
    qa.check('the mock Stripe: the failed refund and the dashboard refund, the charge refunded in full', money.refunds.length === 2 && money.refunds.some((r) => r.id === refundId && r.status === 'failed') && money.refunds.some((r) => r.id === again?.id && r.status === 'succeeded' && r.via === 'dashboard')
      && money.charges.find((c) => c.id === chargeId)?.amount_refunded === 9900, money.refunds.map((r) => `${r.status} ${r.via}`));
    const tickets = ticketsOf(profile.id);
    qa.check('still exactly one ticket, resolved, saying it was refunded', tickets.length === 1 && tickets[0].status === 'resolved' && /Status: Refunded\./.test(tickets[0].body), tickets.map((x) => ({ status: x.status, body: x.body })));
    const status = await limitedRefundAs(user, { action: 'status' });
    qa.check('status reads refunded', status.body?.state === 'refunded' && status.body.refundStatus === 'succeeded', status.body);
    qa.check('the owner\'s notifier query has no refund line for it any more', refundLines(ownerAlertQuery(), request?.id).length === 0);
  });
});

test('the refund sweep, run as pg_cron runs it: a stalled confirmed request finished exactly once, an unconfirmed quote never touched, and no call without the hook secret', {
  tag: ['@BILL-005', '@BILL-007', '@SUPPORT-002'],
}, async ({ page, qa, secondBrowser }) => {
  test.setTimeout(12 * 60 * 1000);
  // Member A confirms Cancel and get a refund; Stripe fails the refund once, so the request
  // stalls cancelled and unrefunded. Member B only opens the review (the quote) and leaves.
  const { user, profile } = await newMember(page, { firstName: 'Sawyer', lastName: `Sweep ${letters()}` });
  const customer = row(`select stripe_customer_id from public.billing_accounts where profile_id = '${profile.id}' and livemode`)?.stripe_customer_id;
  const paid = (await stripeMoneyFor(customer)).subscriptions[0];
  const charge = paid ? (await mockApi(`/qa/stripe/charges?invoice=${encodeURIComponent(paid.latest_invoice)}`)).charges[0] : null;
  const other = await secondBrowser();
  await prepareFunctionAnswers(other.page);
  const quoter = await newMember(other.page, { firstName: 'Quinn', lastName: `Quote ${letters()}` });
  const quoterCustomer = row(`select stripe_customer_id from public.billing_accounts where profile_id = '${quoter.profile.id}' and livemode`)?.stripe_customer_id;
  const quoterSub = (await stripeMoneyFor(quoterCustomer)).subscriptions[0];
  const ledgerOf = (id) => row(`select id, livemode, state, charge_id, attempts, error_code, refund_id, refunded_at, updated_at, lease_token is null as released, subscription_canceled_at is not null as cancelled, support_ticket_id
    from public.limited_refund_requests where id = '${id}'`);
  const stalledNow = (live) => row(`select public.limited_refund_stalled(${live ? 'true' : 'false'}, 600, 25) as s`)?.s || [];
  let request = null;

  await qa.feature('BILL-005', 'A confirmed request stalls: cancelled, the refund failed, idle past the sweep\'s 10 minutes', async () => {
    qa.check('member A paid one founding charge (9900 cents)', charge?.amount === 9900 && charge.status === 'succeeded', charge && { id: charge.id, amount: charge.amount });
    const armed = await mockApi('/qa/stripe/refund-failures', { method: 'POST', body: { charge: charge.id } });
    qa.check('the mock Stripe will answer the next refund of A\'s charge 500 api_error, once', armed.status === 500 && armed.remaining === 1, armed);
    await openMore(page, 'Profile & settings');
    const card = membership(page);
    await card.getByRole('button', { name: REFUND_BUTTON }).click();
    const confirm = card.getByRole('button', { name: 'Cancel membership and refund $99.00' });
    await confirm.waitFor({ timeout: 30000 });
    await card.getByRole('checkbox', { name: /I understand my membership ends now/ }).check();
    const answer = await refundFailureAnswer(page, qa, confirm);
    qa.check('A confirmed; the function answers 503 refund_pending', answer?.status === 503 && (answer.body?.error === 'refund_pending' || (answer.body === null && !!answer.bodyError)), answer);
    const first = rows(`select id from public.limited_refund_requests where profile_id = '${profile.id}'`);
    request = first.length === 1 ? ledgerOf(first[0].id) : null;
    qa.check('one request: requested, cancelled, refund_failed, lease released, attempt 1, linked to a ticket',
      request?.state === 'requested' && request.cancelled && request.error_code === 'refund_failed' && request.released && request.attempts === 1 && !request.refund_id && !!request.support_ticket_id, first.length === 1 ? request : first);
    qa.check('not listed as stalled while it is fresh (idle under 10 minutes)', !stalledNow(request?.livemode).includes(charge.id), stalledNow(request?.livemode));
    // Ten minutes and more pass: the row's last change is moved back 11 minutes (setup only, as
    // the lab database's superuser; what the sweep reads is updated_at), instead of waiting on the clock.
    localExec(`update public.limited_refund_requests set updated_at = updated_at - interval '11 minutes' where id = '${request?.id}'`);
    request = ledgerOf(request?.id);
    qa.check('11 minutes idle: limited_refund_stalled lists A\'s charge', stalledNow(request?.livemode).includes(charge.id), stalledNow(request?.livemode));
  });

  await qa.feature('BILL-007', 'An unconfirmed quote: member B opens the review and leaves', async () => {
    await openMore(other.page, 'Profile & settings');
    const card = membership(other.page);
    const { answer: quoteAnswer } = await armFunctionAnswer(other.page, 'limited-refund', { user: quoter.user, bodyTest: (b) => /"action":"quote"/.test(b) });
    const quoted = quoteAnswer.then(a => a.body);
    await card.getByRole('button', { name: REFUND_BUTTON }).click();
    const quote = await quoted;
    const review = await card.getByRole('button', { name: 'Cancel membership and refund $99.00' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('B is quoted $99.00, the latest payment, and shown the confirmation', review && quote?.state === 'available' && quote.amountCents === 9900 && quote.paymentId === quoterSub?.latest_invoice, quote);
    await card.getByRole('button', { name: 'Keep my membership' }).click().catch(() => {});
    qa.check('B never confirmed: no refund request on record', rows(`select 1 from public.limited_refund_requests where profile_id = '${quoter.profile.id}'`).length === 0);
  });

  await qa.feature('BILL-005', 'The sweep is refused without the hook secret, with a wrong one, and with a member\'s token', async () => {
    const before = ledgerOf(request?.id);
    const memberToken = await tokenFor(user, null);
    const wrong = `qa-not-the-hook-secret-${stamp()}`;
    const calls = {
      noSecret: await qa.intentionalEdgeRequest('malformed_refund', 'BILL-005 refuses an empty member-route request without a hook secret or session.', () => callFunction('limited-refund', { body: {} })),
      noSecretStatus: await qa.intentionalEdgeRequest('unauthenticated_refund', 'BILL-005 refuses a member status request without a session.', () => callFunction('limited-refund', { body: { action: 'status' } })),
      wrongSecret: await callFunction('limited-refund', { headers: { 'x-hook-secret': wrong }, body: {} }),
      emptySecret: await callFunction('limited-refund', { headers: { 'x-hook-secret': '' }, body: {} }),
      memberToken: await qa.intentionalEdgeRequest('malformed_refund', 'BILL-005 refuses an empty member request even with a valid session.', () => callFunction('limited-refund', { headers: { Authorization: `Bearer ${memberToken}` }, body: {} })),
      memberSweepAction: await qa.intentionalEdgeRequest('malformed_refund', 'BILL-005 refuses a member attempting the server-only sweep action.', () => callFunction('limited-refund', { headers: { Authorization: `Bearer ${memberToken}` }, body: { action: 'sweep' } })),
      memberTokenAsSecret: await callFunction('limited-refund', { headers: { Authorization: `Bearer ${memberToken}`, 'x-hook-secret': memberToken }, body: {} }),
    };
    const brief = Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, `${v.status} ${v.text.slice(0, 80)}`]));
    const swept = (c) => c.data && typeof c.data === 'object' && ('requests' in c.data || 'outcomes' in c.data);
    // With no x-hook-secret header the call is a member's request: an empty body is refused as
    // malformed before anyone is looked up, and a well-formed one without a session is refused 401.
    qa.check('no secret and no token, an empty body: 400 invalid_request, not a sweep', calls.noSecret.status === 400 && calls.noSecret.data?.error === 'invalid_request' && !swept(calls.noSecret), brief.noSecret);
    qa.check('no secret and no token, a member\'s status request: 401, not a sweep', calls.noSecretStatus.status === 401 && !swept(calls.noSecretStatus), brief.noSecretStatus);
    qa.check('a wrong secret: 401 not_authorized', calls.wrongSecret.status === 401 && calls.wrongSecret.data?.error === 'not_authorized', brief.wrongSecret);
    qa.check('an empty secret: 401 not_authorized', calls.emptySecret.status === 401 && calls.emptySecret.data?.error === 'not_authorized', brief.emptySecret);
    qa.check('a member\'s token with no secret is the member\'s own route, which refuses it: 400 invalid_request, not a sweep', calls.memberToken.status === 400 && calls.memberToken.data?.error === 'invalid_request' && !swept(calls.memberToken), brief.memberToken);
    qa.check('a member asking for a "sweep" action: 400 invalid_request, not a sweep', calls.memberSweepAction.status === 400 && calls.memberSweepAction.data?.error === 'invalid_request' && !swept(calls.memberSweepAction), brief.memberSweepAction);
    qa.check('a member\'s token presented as the secret: 401 not_authorized', calls.memberTokenAsSecret.status === 401 && calls.memberTokenAsSecret.data?.error === 'not_authorized', brief.memberTokenAsSecret);
    const after = ledgerOf(request?.id);
    qa.check('the stalled request is exactly as it was: requested, attempt 1, same last change, lease free', after?.state === 'requested' && after.attempts === before?.attempts && after.updated_at === before.updated_at && after.released, { before: before && { attempts: before.attempts, updated_at: before.updated_at }, after: after && { attempts: after.attempts, updated_at: after.updated_at } });
    qa.check('nothing was refunded at the mock Stripe', (await stripeMoneyFor(customer)).refunds.length === 0);
  });

  let sweptAt = null;
  await qa.feature('BILL-005', 'The sweep as pg_cron runs it finishes the stalled request once', async () => {
    const job = row(`select jobname, schedule, active, username, command from cron.job where jobname = 'limited-refund-sweep'`);
    qa.check('the cron job limited-refund-sweep: every 10 minutes (5,15,...,55), select public.dispatch_limited_refund_sweep(), inactive in the lab', job?.schedule === '5,15,25,35,45,55 * * * *' && /^select public\.dispatch_limited_refund_sweep\(\)\s*;?$/.test(job.command.trim()) && job.active === false, job);
    const run = runCronJob('limited-refund-sweep');
    const [req] = run.requests;
    qa.check('its command queued one POST to limited-refund on the local gateway, with the hook secret and an empty body', run.ok && run.requests.length === 1 && req.method === 'POST' && req.url === `${localGatewayOrigin()}/functions/v1/limited-refund` && req.hookSecret === true && JSON.stringify(req.body) === '{}',
      run.ok ? run.requests.map((r) => ({ url: r.url, hookSecret: r.hookSecret, body: r.body })) : run.error);
    const [answer] = await netResponses(run.requests.map((r) => r.id));
    let summary = null; try { summary = JSON.parse(answer?.content || 'null'); } catch { summary = null; }
    qa.check('the function answered pg_net 200 ready, with at least one request worked', answer?.status_code === 200 && summary?.state === 'ready' && summary.requests >= 1, answer && { status: answer.status_code, content: answer.content, error: answer.error_msg });
    const done = await waitFor('A\'s request refunded', async () => { const r = ledgerOf(request?.id); return r?.state === 'refunded' ? r : null; }, { timeoutMs: 90000, intervalMs: 1000 }).catch(() => ledgerOf(request?.id));
    const money = await stripeMoneyFor(customer);
    qa.check('the mock Stripe holds exactly one refund, of A\'s charge, 9900, keyed to attempt 2', money.refunds.length === 1 && money.refunds[0].charge === charge.id && money.refunds[0].amount === 9900 && money.refunds[0].status === 'succeeded' && new RegExp(`:refund:${charge.id}:2$`).test(money.refunds[0].idempotencyKey || ''), money.refunds.map((r) => `${r.id} ${r.amount} ${r.idempotencyKey}`));
    qa.check('limited_refund_requests: refunded with that refund, attempt 2, no error, lease released, the same ticket', done?.state === 'refunded' && done.refund_id === money.refunds[0]?.id && done.attempts === 2 && !done.error_code && done.released && done.support_ticket_id === request?.support_ticket_id, done);
    const tickets = ticketsOf(profile.id);
    qa.check('still exactly one ticket, now resolved, saying it was refunded', tickets.length === 1 && tickets[0].status === 'resolved' && /Status: Refunded\. The refund was issued on [A-Z][a-z]+ \d{1,2}, \d{4} to the card you paid with\. Nothing more is needed\./.test(tickets[0].body), tickets.map((x) => ({ status: x.status, body: x.body })));
    const events = await waitFor('charge.refunded accepted', async () => {
      const all = (await mockApi('/qa/stripe/deliveries')).deliveries.filter((d) => d.customer === customer && d.type === 'charge.refunded');
      return all.some((d) => d.status === 200) ? all : null;
    }, { timeoutMs: 90000, intervalMs: 1000 }).catch(() => null);
    qa.check('Stripe\'s charge.refunded is accepted by the webhook (200)', !!events);
    await sleep(1500);
    sweptAt = ledgerOf(request?.id);
    await page.reload();
    await waitForMemberApp(page).catch(() => {});
    await openMore(page, 'Profile & settings');
    const outcome = page.locator('[data-refund-outcome="refunded"]').first();
    const shown = await outcome.waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('refund finished by the sweep');
    qa.check('A\'s Profile shows "Refunded: $99.00" with nothing pressed again', shown && /Refunded: \$99\.00 on .+ Your membership has ended and will not renew\./.test(await text(outcome)));
    qa.check('the owner\'s notifier has no refund line for it', refundLines(ownerAlertQuery({ now: Date.now() + 16 * 60000 }), request?.id).length === 0);
  });

  await qa.feature('BILL-005', 'A second sweep changes nothing: still one refund', async () => {
    qa.check('A\'s charge is no longer listed as stalled', !stalledNow(request?.livemode).includes(charge.id));
    const run = runCronJob('limited-refund-sweep');
    const [answer] = await netResponses(run.requests.map((r) => r.id));
    let summary = null; try { summary = JSON.parse(answer?.content || 'null'); } catch { summary = null; }
    qa.check('the second run answered 200 ready', run.ok && answer?.status_code === 200 && summary?.state === 'ready', answer && { status: answer.status_code, content: answer.content });
    await sleep(1500);
    const after = ledgerOf(request?.id);
    qa.check('the request is exactly as the first sweep left it (refunded, attempt 2, same refund, same last change)', after?.state === 'refunded' && after.attempts === 2 && after.refund_id === sweptAt?.refund_id && after.updated_at === sweptAt?.updated_at && after.refunded_at === sweptAt?.refunded_at, { first: sweptAt, second: after });
    const money = await stripeMoneyFor(customer);
    qa.check('the mock Stripe still holds exactly one refund for A', money.refunds.length === 1, money.refunds.map((r) => r.id));
    qa.check('still exactly one ticket for A', ticketsOf(profile.id).length === 1);
  });

  await qa.feature('BILL-007', 'Member B\'s unconfirmed quote was never touched', async () => {
    qa.check('no refund request for B', rows(`select 1 from public.limited_refund_requests where profile_id = '${quoter.profile.id}'`).length === 0);
    const money = await stripeMoneyFor(quoterCustomer);
    const sub = money.subscriptions.find((x) => x.id === quoterSub?.id);
    qa.check('the mock Stripe: B\'s subscription still active, not cancelled, nothing refunded', sub?.status === 'active' && !sub.cancellation && money.refunds.length === 0 && money.charges.every((c) => c.amount_refunded === 0), sub && { status: sub.status, cancellation: sub.cancellation, refunds: money.refunds.length });
    const subRow = row(`select status, membership_active from public.billing_subscriptions where profile_id = '${quoter.profile.id}'`);
    qa.check('billing_subscriptions: B active', subRow?.status === 'active' && subRow.membership_active === true, subRow);
    const snap = accessSnapshot(quoter.user.id);
    qa.check('the database still grants B Credential writes', snap?.capabilities?.credential?.write === true, snap?.capabilities);
    await other.page.reload();
    await waitForMemberApp(other.page).catch(() => {});
    await openMore(other.page, 'Profile & settings');
    const offered = await membership(other.page).getByRole('button', { name: REFUND_BUTTON }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('B\'s Profile still offers Cancel and get a refund', offered);
  });

  await qa.feature('SUPPORT-002', 'In Get help the refund ticket reads as Support\'s; a member\'s own ticket reads "You", even one claiming the ledger\'s source', async () => {
    const [auto] = ticketsOf(profile.id);
    const help = await readTicketInGetHelp(page, auto?.subject, 'CredentialDOMD opened this ticket for you automatically.');
    await qa.shot('the sweep member\'s refund ticket in Get help');
    qa.check('A: Get help lists the refund ticket once, and its opening text reads as from CredentialDOMD Support', help.seen && help.count === 1 && help.body && fromSupport(help.label), help);
    // B writes a ticket with their own session (the tickets_user_insert policy), claiming the
    // refund ledger's source and A's request: limited_refund_ticket_guard strips both.
    const subject = `QA own ticket ${letters()}`;
    const ownBody = 'QA lab: a question in my own words about my membership renewal date.';
    const made = await restAs(quoter.user, 'support_tickets', { method: 'POST', body: { user_id: quoter.profile.id, subject, body: ownBody, category: 'billing', context_payload: { source: 'limited_refund', refund_request_id: request?.id } } });
    const stored = rows(`select context_payload->>'source' as source, context_payload->>'refund_request_id' as refund_request_id from public.support_tickets where user_id = '${quoter.profile.id}' and subject = '${subject}'`);
    qa.check('B\'s own ticket is stored, without the ledger\'s source or A\'s request', made.status === 201 && stored.length === 1 && stored[0].source === null && stored[0].refund_request_id === null, { status: made.status, stored, error: made.status === 201 ? null : made.data });
    const own = await readTicketInGetHelp(other.page, subject, ownBody);
    qa.check('B: Get help opens it with "You" over the opening text', own.seen && own.body && fromYou(own.label), own);
  });
});
