import { test, expect } from './support/fixtures.mjs';
import { clerkId, field, lab, newMember, openCredentials, pendingOps, row, rows, waitFor } from './support/lab.mjs';
import { allowingMembershipResponse } from './support/membership-responses.mjs';

const MESSAGE = 'Membership check failed (http:503:membership_information_unavailable)';

test('one transient membership 503 recovers automatically and resumes an account-owned save', { tag: ['@AUTH-009'] }, async ({ page, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Tessa', lastName: 'Transient' });
  await qa.feature('AUTH-009', 'After a valid answer, one intentional 503 is retried automatically; a subsequent save persists for the same account', async () => {
    // Account bootstrap may still have a membership check in flight.
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    const baselineSince = Date.now();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitFor('a fresh completed valid membership answer for this account', () => qa.report.membershipResponses?.find(r => allowingMembershipResponse(r, user.id, baselineSince)), { timeoutMs: 15000, intervalMs: 25 });
    // HTTP observation can finish before the app consumes the answer and clears its shared flight.
    // Passively settle that baseline before arming a single fault; never signal again after it.
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    const originalUrl = page.url(), seen = new Set(qa.report.membershipResponses.map(r => r.id));
    const faultSince = new Date().toISOString();
    let injected = 0, navigations = 0;
    const navigated = frame => { if (frame === page.mainFrame()) navigations++; };
    page.on('framenavigated', navigated);
    const route = async request => {
      if (request.request().method() !== 'POST' || injected) return request.fallback();
      injected++;
      return request.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': lab().urls.appOrigin }, body: JSON.stringify({ error: 'access_policy_unavailable' }) });
    };
    await page.route('**/functions/v1/billing-entitlements', route);
    let failed, recovered;
    try {
      // One resume signal starts the check. No later click, reload or second signal repairs it.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      failed = await waitFor('the exact observed injected503', () => qa.report.membershipResponses.find(r => !seen.has(r.id) && r.accountId === user.id && r.status === 503 && r.completion === 'finished'), { timeoutMs: 15000, intervalMs: 25 });
      qa.check('exactly one completed account-bound503 has the intentional response', injected === 1 && failed.accountBinding === 'verified_local_signature' && failed.errorCode === 'access_policy_unavailable');
      recovered = await waitFor('the automatic allowing answer without user intervention', () => qa.report.membershipResponses.find(r => !seen.has(r.id) && Date.parse(r.startedAt) > Date.parse(failed.completedAt) && allowingMembershipResponse(r, user.id)), { timeoutMs: 15000, intervalMs: 25 });
      const between = qa.report.membershipResponses.filter(r => !seen.has(r.id) && r.accountId === user.id && r.method === 'POST' && Date.parse(r.startedAt) <= Date.parse(recovered.startedAt));
      qa.check('one failed check is followed by a completed allowing automatic retry', between.length === 2 && between[0].id === failed.id && between[1].id === recovered.id, between.map(r => ({ status: r.status, completion: r.completion })));
      qa.check('recovery needed no navigation or identity change', navigations === 0 && page.url() === originalUrl && await clerkId(page) === user.id);
      qa.check('a one-off failure does not show the persistent reconnection notice', await page.getByText('Reconnecting to your account.', { exact: true }).count() === 0);
    } finally {
      await page.unroute('**/functions/v1/billing-entitlements', route);
      page.off('framenavigated', navigated);
    }
    // Confirm normal product writes, not merely an HTTP200 or a cached visual.
    await openCredentials(page, 'Licenses');
    await page.getByRole('button', { name: 'Add' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add' });
    const number = `QA-TRANSIENT-${profile.id.slice(0,8)}`;
    await field(dialog, 'Type').selectOption('State Medical License');
    await field(dialog, 'License #').fill(number);
    await field(dialog, 'State').selectOption('CO');
    await field(dialog, /^Expires/).fill('2029-10-31');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toBeHidden();
    const saved = await waitFor('the license persisted after automatic recovery', () => row(`select id,user_id,license_number from public.licenses where license_number='${number}'`), { timeoutMs: 20000, intervalMs: 100 });
    const all = rows(`select id,user_id from public.licenses where license_number='${number}'`);
    qa.check('exactly one saved license belongs to the original account', saved.user_id === profile.id && all.length === 1 && all[0].user_id === profile.id);
    qa.check('the recovered save is no longer queued', !(await pendingOps(page)).some(op => JSON.stringify(op).includes(number)));
    qa.check('the account remains selected after the persisted write', await clerkId(page) === user.id);
    const reports = await waitFor('the deliberate503 client report', () => {
      const faultUntil = new Date().toISOString();
      const found = rows(`select id,kind,message,auth_user_id from public.client_errors where auth_user_id='${user.id}' and created_at >= '${faultSince}' and created_at <= '${faultUntil}' and message='${MESSAGE}'`);
      return found.length ? found : null;
    }, { timeoutMs: 10000, intervalMs: 100 });
    qa.intentionalClientErrors(reports, { message: MESSAGE, kind: 'error', authUserId: user.id, count: 1,
      reason: 'AUTH-009 injected exactly one503 into this account’s billing-entitlements request after a valid answer, observed the automatic completed200 without user action, and verified one account-owned persisted license. Only this exact persisted row is intentional.' });
  });
});
