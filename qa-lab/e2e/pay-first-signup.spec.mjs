// One step, pay first sign-up, end to end in Stripe TEST mode (build brief
// section 7). NOT RUN in the build PR: it needs a deployed test stack with
// pay_first_signup_enabled on, the client built with
// VITE_PAY_FIRST_SIGNUP_ENABLED=true, a Terms URL in the test account's
// Dashboard public details, and only the test keys the QA environment
// already has. It adds no secret and never touches live mode.
//
//   PAY_FIRST_E2E=1 PAY_FIRST_APP_URL=https://<test app origin>/app/ \
//   PAY_FIRST_SQL=<psql connection to the TEST database> \
//     node node_modules/@playwright/test/cli.js test --config qa-lab/e2e/playwright.config.mjs pay-first-signup
//
// Synthetic addresses only (QA_EMAIL_DOMAIN). Stripe test cards:
// 4242 4242 4242 4242 (paid), 4000 0000 0000 0002 (declined),
// 4000 0025 0000 3155 (3D Secure).
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';

const ON = process.env.PAY_FIRST_E2E === '1' && /^https:\/\//.test(process.env.PAY_FIRST_APP_URL || '') && !!process.env.PAY_FIRST_SQL;
const APP = process.env.PAY_FIRST_APP_URL;
const DOMAIN = process.env.QA_EMAIL_DOMAIN || 'qa.credentialdomd.test';
const sql = query => execFileSync('psql', [process.env.PAY_FIRST_SQL, '-XqAt', '-c', query], { encoding: 'utf8' }).trim();
const email = label => `payfirst-${label}-${Date.now()}@${DOMAIN}`;
const row = address => JSON.parse(sql(`select coalesce(to_jsonb(s),'null') from pay_first_signups s where email_norm='${address}' order by created_at desc limit 1`) || 'null');

test.describe('pay-first sign-up (Stripe test mode)', () => {
  test.skip(!ON, 'Set PAY_FIRST_E2E=1, PAY_FIRST_APP_URL and PAY_FIRST_SQL against a test stack.');

  async function checkout(page, { address, card = '4242424242424242', submit = true }) {
    await page.goto(APP);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await page.waitForURL(/checkout\.stripe\.com/);
    await page.getByLabel('Email').fill(address);
    await page.getByPlaceholder('1234 1234 1234 1234').fill(card);
    await page.getByPlaceholder('MM / YY').fill('12 / 34');
    await page.getByPlaceholder('CVC').fill('123');
    const name = page.getByPlaceholder('Full name on card');
    if (await name.count()) await name.fill('Synthetic Buyer');
    const zip = page.getByPlaceholder('ZIP');
    if (await zip.count()) await zip.fill('94107');
    // The Terms tick (consent_collection) and the reviewed renewal terms.
    await expect(page.getByText(/Credential: USD 99 due now, then USD 99 each year/)).toBeVisible();
    await page.getByRole('checkbox', { name: /Terms/ }).check();
    if (submit) await page.getByTestId('hosted-payment-submit-button').click();
  }

  test('1. a paid card signs in on /app/ within 15 seconds, membership active, place paid', async ({ page }) => {
    const address = email('paid');
    await checkout(page, { address });
    const started = Date.now();
    await page.waitForURL(/\/app\/\?(signup|billing)=/);
    await expect(page.getByText('Your membership is confirmed.')).toBeVisible({ timeout: 15000 });
    expect(Date.now() - started).toBeLessThan(15000);
    const r = row(address);
    expect(r.state).toBe('provisioned');
    expect(sql(`select state from limited_founding_slots where attempt_id='${r.attempt_id}'`)).toBe('paid');
    expect(sql(`select membership_active from billing_subscriptions where profile_id='${r.profile_id}' and not livemode`)).toBe('t');
  });

  test('2. a declined card stays on Checkout and nothing is made', async ({ page }) => {
    const address = email('declined');
    await checkout(page, { address, card: '4000000000000002' });
    await expect(page.getByText(/declined/i)).toBeVisible();
    expect(page.url()).toMatch(/checkout\.stripe\.com/);
    expect(row(address)).toBeNull();
  });

  test('3. a 3D Secure card completes and is provisioned', async ({ page }) => {
    const address = email('threeds');
    await checkout(page, { address, card: '4000002500003155' });
    const frame = page.frameLocator('iframe[name^="__privateStripeFrame"]').frameLocator('iframe#challengeFrame');
    await frame.getByRole('button', { name: /complete/i }).click();
    await page.waitForURL(/\/app\//);
    await expect.poll(() => row(address)?.state, { timeout: 60000 }).toBe('provisioned');
  });

  test('4. an abandoned Checkout gives its place back after expiry', async ({ page }) => {
    await page.goto(APP);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await page.waitForURL(/checkout\.stripe\.com/);
    const session = new URL(page.url()).pathname.split('/').find(p => p.startsWith('cs_test_'));
    // A short lifetime: expire it now with the Stripe CLI (test account, its
    // existing test key); checkout.session.expired then releases the hold.
    expect(session).toMatch(/^cs_test_/);
    execFileSync('stripe', ['checkout', 'sessions', 'expire', session], { encoding: 'utf8' });
    await expect.poll(() => sql(`select state from pay_first_signups where session_id='${session}'`), { timeout: 120000 }).toBe('expired');
  });

  test('5. paying with the email of an existing unpaid login attaches to that account', async ({ page }) => {
    const address = sql(`select verified_primary_email from limited_signup_enrollments e join profiles p on p.id=e.profile_id where p.access_status='pending' and not e.livemode and e.verified_primary_email like '%@${DOMAIN}' limit 1`);
    test.skip(!address, 'No unpaid test login to pay for.');
    const before = sql(`select id from profiles where id=(select profile_id from limited_signup_enrollments where verified_primary_email='${address}' and not livemode)`);
    await checkout(page, { address });
    await expect.poll(() => row(address)?.state, { timeout: 60000 }).toBe('provisioned');
    expect(row(address).profile_id).toBe(before);
  });

  test('6. paying with a paid member\'s email shows the already-a-member screen', async ({ page }) => {
    const address = sql(`select e.verified_primary_email from limited_signup_enrollments e join billing_subscriptions s on s.profile_id=e.profile_id and s.livemode=e.livemode where not e.livemode and s.status='active' and e.verified_primary_email like '%@${DOMAIN}' limit 1`);
    test.skip(!address, 'No paid test member.');
    await checkout(page, { address });
    await expect(page.getByText('You already have a membership. Log in.')).toBeVisible({ timeout: 60000 });
    expect(row(address).state).toBe('duplicate_member');
  });

  test('7. Cancel and get a refund ends access; the founding place stays paid', async ({ page }) => {
    const address = email('refund');
    await checkout(page, { address });
    await expect(page.getByText('Your membership is confirmed.')).toBeVisible({ timeout: 30000 });
    const r = row(address);
    await page.getByRole('button', { name: /Cancel and get a refund/ }).click();
    await page.getByRole('button', { name: /Confirm/ }).click();
    await expect.poll(() => sql(`select membership_active from billing_subscriptions where profile_id='${r.profile_id}' and not livemode`), { timeout: 60000 }).toBe('f');
    expect(sql(`select state from limited_founding_slots where attempt_id='${r.attempt_id}'`)).toBe('paid');
  });

  test('8. with the flag off the sign-in screen is login first, unchanged', async ({ page }) => {
    sql(`update access_policy_settings set pay_first_signup_enabled=false where singleton`);
    try {
      await page.goto(APP);
      const signUp = page.getByRole('button', { name: 'Sign up' });
      if (await signUp.count()) {
        await signUp.click();
        // The server refuses and the screen turns back to login first.
        await expect(signUp).toHaveCount(0);
      }
      await expect(page.getByText('Already have an account? Use the same email address.')).toBeVisible();
    } finally {
      sql(`update access_policy_settings set pay_first_signup_enabled=true where singleton`);
    }
  });
});
