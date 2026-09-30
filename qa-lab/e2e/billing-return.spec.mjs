// Back from Checkout, the way Stripe really orders things: the browser returns
// to /app/?billing=complete at once, and the webhook events land later, all at
// the same time and in no set order (qa-lab/mocks/stripe.mjs). These journeys
// pin the two paths that ordering opens:
//
//   1. the app is back before any event has landed: it says the checkout is
//      being confirmed, offers nothing to buy, and turns active on its own once
//      the events land (useBillingReturn polls; no reload);
//   2. the first invoice.paid is refused 503 billing_reconciliation_pending
//      because another event for the same account holds the reconcile lease
//      (limitedLaunchHandlers.mjs): nothing is recorded, the app keeps
//      confirming, and Stripe's retry activates the membership.
import { test } from './support/fixtures.mjs';
import {
  checkoutAttempts, createPhysician, dismissInterruptions, goTab, holdReconcileLease, landing, payForMembership, profileOf, releaseReconcileLease,
  row, rows, signIn, waitFor, waitForCheckoutEvents, waitForMemberApp,
} from './support/lab.mjs';

const CONFIRMING = /Confirming your membership/;
const notice = (page) => page.getByRole('status').filter({ hasText: /membership/i }).first();

test('back from Checkout before the events land: "confirming", nothing to buy, then active on its own', {
  tag: ['@BILL-003'],
}, async ({ page, qa }) => {
  const user = await createPhysician({ firstName: 'Casey', lastName: 'Confirming' });
  await signIn(page, user);
  await landing(page);

  let sessionId;
  await qa.feature('BILL-003', 'Return before the webhook: the app confirms, then activates without a reload', async () => {
    // The events land 10 seconds after the browser is sent back (Stripe: usually a second or two, sometimes more).
    ({ sessionId } = await payForMembership(page, { plan: { delayMs: 10000, order: 'shuffled', mode: 'concurrent' } }));
    // "Checking your membership…" (the app's loading line) is a membership status too: wait for the return notice itself.
    const shown = await page.getByRole('status').filter({ hasText: CONFIRMING }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    const early = shown ? await page.getByRole('status').filter({ hasText: CONFIRMING }).first().innerText() : await notice(page).innerText().catch(() => '');
    await qa.shot('back from checkout, confirming');
    const before = await checkoutAttempts(sessionId);
    qa.check('back in the app before any event reached the webhook', before.length === 0, before.map((d) => `${d.type} ${d.status}`).join(', ') || 'no attempts yet');
    qa.check('the notice says the membership is being confirmed', shown && CONFIRMING.test(early), early.slice(0, 120));
    qa.check('the profile is still pending (nothing recorded yet)', profileOf(user.id)?.access_status === 'pending', profileOf(user.id)?.access_status);
    const gate = page.getByRole('region', { name: 'Membership' });
    const gateText = (await gate.innerText().catch(() => '')).replace(/\s+/g, ' ');
    qa.check('the membership page offers nothing to choose or pay while confirming', /nothing more to choose or pay/.test(gateText) && !(await page.getByRole('button', { name: /Review .* offer|Continue to secure payment/ }).count()), gateText.slice(0, 200));

    const attempts = await waitForCheckoutEvents(sessionId).catch(() => null);
    qa.check('the three events land and are accepted (a busy 503 is retried)', !!attempts, (attempts || []).map((d) => `${d.type} ${d.status}${d.attempt > 1 ? ` #${d.attempt}` : ''}`).join(', '));
    const active = await waitFor('the profile to turn active', async () => profileOf(user.id)?.access_status === 'active', { timeoutMs: 60000 }).catch(() => false);
    qa.check('the membership turns active', active);
    // The app's own polling (1, 2, 3, 5, 8, 13, 21 s) sees it; no reload.
    const opened = await waitForMemberApp(page, 60000).then(() => true, () => false);
    const confirmedText = await page.getByRole('status').filter({ hasText: /Your membership is confirmed/ }).first().innerText().catch(() => '');
    await qa.shot('confirmed without a reload');
    qa.check('the member app opens without a reload', opened);
    qa.check('the notice turns to "Your membership is confirmed."', /Your membership is confirmed/.test(confirmedText), confirmedText.slice(0, 80));
    qa.check('the billing parameter is taken out of the address once confirmed', !new URL(page.url()).searchParams.has('billing'), page.url());
    const pid = profileOf(user.id).id;
    const counts = row(`select (select count(*) from public.billing_subscriptions where profile_id = '${pid}')::int as subs, (select count(*) from public.access_purchase_receipts where profile_id = '${pid}')::int as receipts`);
    qa.check('three concurrent events made one subscription and one receipt', counts.subs === 1 && counts.receipts === 1, counts);
  });

  await qa.feature('BILL-003', 'What the membership pays for is on once it is confirmed, without a reload (shared AI for Smart Scan)', async () => {
    // Same page load: the app was opened (and asked ai-proxy what shared AI this account may use)
    // while the membership was still pending.
    await dismissInterruptions(page);
    await goTab(page, 'Documents');
    await page.getByRole('button', { name: 'Upload' }).first().waitFor({ timeout: 30000 });
    const stale = await page.getByText('AI is not on yet').first().isVisible().catch(() => false);
    const line = await page.getByText(/Shared AI: available once your membership is active/).first().innerText().catch(() => '');
    await qa.shot('documents right after the membership was confirmed');
    qa.check('Smart Scan does not say "AI is not on yet" to the member whose membership was just confirmed', !stale, stale ? `shown: "AI is not on yet" / "${line.slice(0, 100)}"` : 'shared AI on');
    if (stale) {
      await page.reload();
      await waitForMemberApp(page);
      await dismissInterruptions(page);
      await goTab(page, 'Documents');
      await page.getByRole('button', { name: 'Upload' }).first().waitFor({ timeout: 30000 });
      const afterReload = await page.getByText('AI is not on yet').first().isVisible().catch(() => false);
      qa.bug({
        title: 'Back from Checkout, a new member is told "AI is not on yet ... available once your membership is active" after the membership is confirmed, until a reload',
        step: 'Pay on Checkout; back in the app before the Stripe events land ("Confirming your membership..."), wait for "Your membership is confirmed.", open Documents',
        expected: 'Smart Scan (shared AI) is on: the membership is active',
        actual: `"AI is not on yet" and "Shared AI: available once your membership is active" on the confirmed member's Documents page${afterReload ? '' : '; gone after a reload'}. fetchSharedAiStatus (src/utils/aiClient.js) asks ai-proxy once per page load, and this load asked while the membership was pending (403, reason "pending"); nothing asks again when useBillingReturn sees the purchase land. Live, Stripe sends the buyer back before its webhook events land, so this is the normal path; the lab hid it until its Checkout stand-in stopped settling the events before the redirect`,
        severity: 'medium',
      });
      qa.check('after a reload the shared AI is on (the status was stale, not wrong)', !afterReload);
    }
  });
});

test('the first invoice.paid is refused as busy: nothing recorded, the app keeps confirming, the retry activates', {
  tag: ['@BILL-003'],
}, async ({ page, qa }) => {
  const user = await createPhysician({ firstName: 'Bailey', lastName: 'Busy' });
  await signIn(page, user);
  await landing(page);

  let lease = null;
  let pid = null;
  try {
    await qa.feature('BILL-003', 'A busy webhook answer (503) is retried and the membership still activates', async () => {
      // invoice.paid first, then the others one at a time; the lease is held when Pay is pressed.
      const { sessionId } = await payForMembership(page, {
        plan: { delayMs: 0, order: 'invoice-first', mode: 'sequential' },
        beforePay: async () => { pid = profileOf(user.id).id; lease = holdReconcileLease(pid); },
      });
      const refused = await waitFor('invoice.paid to be refused as busy', async () => (await checkoutAttempts(sessionId)).find((d) => d.type === 'invoice.paid' && d.status === 503) || null, { timeoutMs: 30000, intervalMs: 250 }).catch(() => null);
      qa.check('the first invoice.paid is answered 503 billing_reconciliation_pending, and Stripe will retry it', !!refused && /billing_reconciliation_pending/.test(refused.response) && refused.willRetry === true, refused ? `${refused.status} ${refused.response.slice(0, 80)}` : 'no refused attempt');
      // The refusal can come before the returning page has loaded the member's access ("Checking your
      // membership…" is the app's loading line): wait for the return notice, as the first journey does.
      await page.getByRole('status').filter({ hasText: CONFIRMING }).first().waitFor({ timeout: 15000 }).catch(() => {});
      const noticeText = await notice(page).innerText().catch(() => '');
      await qa.shot('busy webhook, still confirming');
      qa.check('the app keeps saying it is confirming', CONFIRMING.test(noticeText), noticeText.slice(0, 120));
      qa.check('nothing was recorded for the refused event: profile pending, no subscription',
        profileOf(user.id)?.access_status === 'pending' && rows(`select 1 from public.billing_subscriptions where profile_id = '${pid}'`).length === 0);

      // The other event finishes: the lease is released, and Stripe's next attempt gets through.
      qa.check('the lease is released', releaseReconcileLease(pid, lease));
      lease = null;
      const attempts = await waitForCheckoutEvents(sessionId).catch(() => null);
      const paid = (attempts || []).filter((d) => d.type === 'invoice.paid');
      qa.check('a later attempt of invoice.paid is accepted (200)', paid.some((d) => d.status === 200 && d.attempt > 1), paid.map((d) => `#${d.attempt} ${d.status}`).join(', '));
      qa.check('checkout.session.completed and customer.subscription.created follow and are accepted', !!attempts);
      const active = await waitFor('active', async () => profileOf(user.id)?.access_status === 'active', { timeoutMs: 60000 }).catch(() => false);
      qa.check('the membership turns active after the retry', active);
      const opened = await waitForMemberApp(page, 90000).then(() => true, () => false);
      await qa.shot('active after the retry');
      qa.check('the member app opens without a reload', opened);
      const receipts = rows(`select price_phase, annual_cents from public.access_purchase_receipts where profile_id = '${pid}'`);
      qa.check('exactly one receipt at the founding price', receipts.length === 1 && receipts[0].annual_cents === 9900, receipts);
    });
  } finally {
    if (lease && pid) releaseReconcileLease(pid, lease);
  }
});
