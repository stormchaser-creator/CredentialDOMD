// Cancellation acceptance must inspect the disclosure, not the permanent
// "Cancel and get a refund" button. Dates come from this member's stored row.
export async function checkCancelledRenewal(page, qa, subscription) {
  const membership = page.getByRole('region', { name: 'Membership' });
  const disclosure = membership.getByText(/^Renewal is cancelled: your membership will not renew\./);
  const shown = await disclosure.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);
  const visible = shown && await disclosure.count() === 1 && await disclosure.isVisible();
  const card = (await membership.innerText()).replace(/\s+/g, ' ');
  const text = visible ? (await disclosure.innerText()).replace(/\s+/g, ' ') : '';
  const validEnd = typeof subscription?.period_end === 'string' && Number.isFinite(Date.parse(subscription.period_end));
  // Execute Intl in the browser: the user's locale/time zone may differ from
  // the machine running Playwright (and from PostgreSQL's timestamp spelling).
  const expectedEnd = validEnd ? await page.evaluate(value => new Date(value).toLocaleString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }), subscription.period_end) : null;
  qa.check('the membership card visibly says renewal is cancelled and membership will not renew',
    subscription?.cancel_at_period_end === true && visible, card.slice(0, 400));
  qa.check('the cancellation disclosure keeps access until the persisted period end in the browser local format',
    expectedEnd !== null && text.includes(`It stays active until ${expectedEnd.replace(/\s+/g, ' ')}.`), text || 'no visible cancellation disclosure');
  qa.check('the cancelled membership card has no contradictory renewing line',
    !/\brenews on\b|\bwill renew\b/i.test(card), card.slice(0, 400));
}
