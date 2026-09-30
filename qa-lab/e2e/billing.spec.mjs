// Billing journeys beyond the first purchase: returning from Checkout without
// paying (and resuming it), the membership card, and a paid member managing
// the subscription in the customer portal (the lab's stand-in for Stripe's)
// and scheduling cancellation, which the webhook records.
import { test } from './support/fixtures.mjs';
import {
  createPhysician, landing, lab, newMember, openMore, profileOf, row, rows, signIn, sleep, stripeFor, waitFor, waitForMemberApp,
} from './support/lab.mjs';

test('return from Checkout without paying: notice, nothing charged, dismiss sticks, checkout can be resumed', {
  tag: ['@BILL-002', '@BILL-010'],
}, async ({ page, qa }) => {
  const user = await createPhysician({ firstName: 'Blair', lastName: 'Backout' });
  await signIn(page, user);
  await landing(page);

  await qa.feature('BILL-002', 'Cancel on Checkout and come back', async () => {
    await page.getByRole('button', { name: 'Review Credential offer' }).click();
    await page.getByRole('checkbox', { name: /agree to the payment and renewal terms/ }).check();
    await page.getByRole('button', { name: 'Continue to secure payment' }).click();
    await page.getByTestId('qa-stripe-cancel').click();
    await page.waitForURL((u) => u.origin === lab().urls.appOrigin, { timeout: 60000 });
    const notice = page.getByRole('status').filter({ hasText: /Checkout was canceled/ });
    const shown = await notice.first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('checkout canceled notice');
    qa.check('the notice says Checkout was canceled and nothing was charged', shown && /Nothing was charged/.test(await notice.first().innerText()));
    const pid = profileOf(user.id).id;
    const subs = rows(`select 1 from public.billing_subscriptions where profile_id = '${pid}'`);
    qa.check('no subscription and the profile stays pending', subs.length === 0 && profileOf(user.id).access_status === 'pending');
    const attempt = row(`select state from public.billing_checkout_attempts where profile_id = '${pid}'`);
    qa.check('the checkout attempt is not completed', attempt?.state !== 'complete', attempt?.state);
    if (shown) {
      await notice.first().getByRole('button', { name: 'Dismiss' }).click();
      qa.check('Dismiss removes the notice', !(await page.getByText(/Checkout was canceled/).count()));
      await page.reload();
      await landing(page);
      await sleep(1500);
      qa.check('the notice does not return after a reload', !(await page.getByText(/Checkout was canceled/).count()));
    }
    qa.check('no stuck "confirming" state', !(await page.getByText(/Confirming your payment|being confirmed/i).count()));
  });

  await qa.feature('BILL-010', 'Resume the unfinished checkout and pay', async () => {
    const text = (await page.getByRole('region', { name: 'Membership' }).innerText()).replace(/\s+/g, ' ');
    const resume = page.getByRole('button', { name: /Resume checkout/i });
    const offered = await resume.count() > 0;
    qa.check('the gate offers to resume the open checkout (or review the offer again)', offered || /Review Credential offer/.test(text), text.slice(0, 200));
    if (offered) await resume.first().click();
    else {
      await page.getByRole('button', { name: 'Review Credential offer' }).click();
      await page.getByRole('checkbox', { name: /agree to the payment and renewal terms/ }).check();
      await page.getByRole('button', { name: 'Continue to secure payment' }).click();
    }
    await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 });
    const { sessions } = await stripeFor(user.id);
    qa.check('the same Checkout session is reused (no second open session)', sessions.filter((s) => s.status === 'open').length === 1, sessions.map((s) => `${s.id.slice(0, 16)} ${s.status}`).join(', '));
    await page.getByTestId('qa-stripe-pay').click();
    await page.waitForURL((u) => u.searchParams.get('billing') === 'complete', { timeout: 120000 });
    const active = await waitFor('active', async () => profileOf(user.id)?.access_status === 'active', { timeoutMs: 60000 }).catch(() => false);
    qa.check('paying the resumed checkout activates the membership', active);
    await waitForMemberApp(page);
  });
});

test('paid member: membership card, customer portal, cancel at period end, export', {
  tag: ['@BILL-005', '@BILL-007', '@SYNC-019'],
}, async ({ page, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Parker', lastName: 'Portal' });

  await qa.feature('BILL-007', 'Membership card in Profile & settings', async () => {
    await openMore(page, 'Profile & settings');
    const card = (await page.getByRole('region', { name: 'Membership' }).innerText()).replace(/\s+/g, ' ');
    await qa.shot('membership card');
    qa.check('the card says the Credential membership is active', /Credential membership is active/.test(card), card.slice(0, 160));
    qa.check('the card says Practice is included while active (founding)', /Practice is included/.test(card));
    qa.check('the card offers "Manage paid subscription"', /Manage paid subscription/.test(card));
    qa.check('no purchase offer on an active membership card', !/Review .* offer/.test(card));
  });

  await qa.feature('BILL-005', 'Cancel Subscription: portal opens for this customer, cancel at period end, export', async () => {
    await openMore(page, 'Cancel Subscription');
    const manage = page.getByRole('button', { name: /Manage (paid subscription|scheduled membership)/ });
    await manage.waitFor({ timeout: 30000 });
    await qa.shot('cancellation page');
    await manage.click();
    await page.waitForURL(/\/qa\/stripe\/hosted\/portal\//, { timeout: 60000 });
    const portal = await page.locator('body').innerText();
    const { sessions } = await stripeFor(user.id);
    const mine = sessions.map((s) => s.subscription).filter(Boolean);
    const shownSubs = portal.match(/sub_[A-Za-z0-9]+/g) || [];
    qa.check('the portal opens for this member\'s own customer (only their subscription)', shownSubs.length > 0 && shownSubs.every((id) => mine.includes(id)), `${shownSubs.join(', ')} vs ${mine.join(', ')}`);
    await page.getByTestId('qa-stripe-portal-cancel').click();
    const cancelled = await waitFor('cancel_at_period_end', async () => row(`select cancel_at_period_end, membership_active from public.billing_subscriptions where profile_id = '${profile.id}'`)?.cancel_at_period_end === true, { timeoutMs: 60000 }).catch(() => false);
    qa.check('customer.subscription.updated reaches the webhook: billing_subscriptions.cancel_at_period_end', cancelled);
    const { deliveries } = await stripeFor(user.id);
    const upd = deliveries.find((d) => d.type === 'customer.subscription.updated');
    qa.check('the webhook answered 200', upd?.status === 200, upd ? `${upd.type} ${upd.status}` : 'no delivery');
    qa.check('the membership stays active until the period ends', profileOf(user.id).access_status === 'active');
    await page.goto(lab().urls.app);
    await waitForMemberApp(page);
    await openMore(page, 'Profile & settings');
    const card = (await page.getByRole('region', { name: 'Membership' }).innerText()).replace(/\s+/g, ' ');
    if (!/(ends|end on|until|will not renew|cancel)/i.test(card)) {
      await qa.shot('card after scheduling cancellation');
      qa.bug({
        title: 'After cancelling in the customer portal, the membership card still reads as a renewing membership',
        step: 'More > Cancel Subscription > Manage paid subscription > Cancel at period end > back to the app > Profile & settings',
        expected: 'The card says the membership will end on <period end> and will not renew (billing_subscriptions.cancel_at_period_end is true)',
        actual: `Card: "${card.slice(0, 220)}". The access snapshot has no cancel-at-period-end field for a normal paid subscription (only scheduled memberships carry cancelAtPeriodEnd), so the app cannot show it.`,
        severity: 'low',
      });
    }
    // Export saved records leads to Data & Backup, where the server builds the account ZIP.
    await openMore(page, 'Cancel Subscription');
    await page.getByRole('button', { name: 'Export saved records' }).click();
    await page.getByRole('heading', { name: 'Data & Backup' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Build a backup now' }).click();
    const ready = await page.getByText(/Backup ready:/).first().waitFor({ timeout: 90000 }).then(() => true, () => false);
    qa.check('"Build a backup now" builds the account ZIP', ready, (await page.getByText(/Backup ready:[^.]*/).first().innerText().catch(() => '')).slice(0, 120));
    let downloaded = null;
    if (ready) {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }).catch(() => null), page.getByRole('button', { name: 'Download', exact: true }).first().click()]);
      downloaded = dl ? dl.suggestedFilename() : null;
    }
    await qa.shot('export page');
    qa.check('a ZIP downloads', !!downloaded && /\.zip$/i.test(downloaded), downloaded || 'no download');
  });
});
