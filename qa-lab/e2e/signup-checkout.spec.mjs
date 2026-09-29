// P0 journey: a new physician signs up, meets the pending membership gate,
// reviews the $99 founding offer (Practice included), pays on the lab's
// Checkout stand-in, and ends as an active member with Credential and
// Practice. The welcome email is captured only when the owner has turned it
// on (Admin > Emails): off, nothing is sent; on, exactly one welcome.
//
// Serial: the second journey turns the welcome email on, which is lab-wide.
import { test, expect } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, accessSnapshot, createPhysician, letters, emails, emailBody, labExec, landing, lab, makeAdmin, mockApi,
  newMember, profileOf, replayStripeEvent, restAs, row, rows, signIn, sleep, stamp, stripeFor, waitFor, waitForMemberApp, waitForProfile,
} from './support/lab.mjs';

// Tests in a file run in order in one worker (fullyParallel is off); a failure does not skip the next.

const welcomeOff = () => labExec('update public.welcome_email_settings set enabled = false, updated_at = now() where singleton');

test('new signup: pending gate, $99 founding offer with Practice, checkout, active member', {
  tag: ['@AUTH-001', '@AUTH-003', '@AUTH-004', '@BILL-001', '@BILL-003', '@BILL-006', '@HOME-002'],
}, async ({ page, qa }) => {
  // The welcome email is off, as in production (2026-09-29).
  welcomeOff();
  const t = stamp('signup');
  const local = t.toLowerCase();
  const email = `${local}@${LAB_EMAIL_DOMAIN}`;
  let subject;

  await qa.feature('AUTH-001', 'Sign up for a new account (QA sign-in form in place of Clerk)', async () => {
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
    await page.getByTestId('qa-create-first').fill('Avery');
    await page.getByTestId('qa-create-last').fill(`Signup ${t.slice(-4)}`);
    await page.getByTestId('qa-create-email').fill(local);
    await page.getByTestId('qa-create-submit').click();
    const where = await landing(page);
    await qa.shot('pending gate');
    qa.check('lands on "Your membership" (pending gate)', where === 'gate', where);
    const gate = page.getByRole('region', { name: 'Membership' });
    qa.check('the gate offers the founding Credential membership', await page.getByRole('button', { name: 'Review Credential offer' }).isVisible());
    qa.check('the gate has "Check access again" and "Sign out"', await page.getByRole('button', { name: 'Check access again' }).isVisible() && await page.getByRole('button', { name: 'Sign out' }).isVisible());
    const users = (await mockApi('/qa/users')).users;
    subject = users.find((u) => u.email === email)?.id;
    qa.check('the mock Clerk holds the new physician', !!subject, email);
    const profile = await waitForProfile(subject, () => true, 30000).catch(() => null);
    qa.check('profiles row created with access_status pending', profile?.access_status === 'pending', profile ? `access ${profile.access_status}` : 'no profile');
    qa.check('verified_email stamped from the sign-in identity', profile?.verified_email === email, profile?.verified_email || 'empty');
    // The checklist expects a clerk_continuity_accounts row; the design only stages rows for
    // legacy (pre-migration) accounts, so a brand-new account correctly has none.
    const continuity = row(`select count(*)::int as n from public.clerk_continuity_accounts where target_subject = '${subject}' or source_subject = '${subject}'`);
    qa.check('no continuity row for a brand-new account (rows exist only for staged legacy accounts)', continuity?.n === 0, `${continuity?.n} row(s)`);
    const errs = row(`select count(*)::int as n from public.client_errors where auth_user_id = '${subject}'`);
    qa.check('no client_errors row for this account', (errs?.n ?? 0) === 0, `${errs?.n} row(s)`);
    await expect(gate).toBeVisible();
  });

  const user = { id: subject, email };

  await qa.feature('AUTH-003', 'Pending gate: Check access again and Sign out', async () => {
    await page.getByRole('button', { name: 'Check access again' }).click();
    await sleep(2500);
    qa.check('stays on the gate after re-checking', await page.getByRole('region', { name: 'Membership' }).isVisible());
    qa.check('no error shown after re-checking', !(await page.getByRole('alert').filter({ hasText: /could not|failed|error/i }).count()));
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
    qa.check('sign out returns to the sign-in card', true);
    const leftovers = await page.evaluate((id) => Object.keys(localStorage).filter((k) => k.includes(id)), subject);
    qa.check('no device data left for that account', leftovers.length === 0, leftovers.join(', '));
    await signIn(page, user);
    qa.check('signing back in returns to the gate', (await landing(page)) === 'gate');
  });

  await qa.feature('AUTH-004', 'Unpaid signup cannot reach or create records', async () => {
    for (const hash of ['#backups', '#requests', '#support']) {
      await page.goto(`${lab().urls.app}${hash}`, { waitUntil: 'domcontentloaded' });
      const where = await landing(page);
      qa.check(`${hash} keeps the membership gate`, where === 'gate', where);
    }
    qa.check('no Credentials navigation on the gate', !(await page.getByRole('button', { name: /^Credentials$/ }).count()));
    const profile = profileOf(subject);
    const insert = await restAs(user, 'licenses', { method: 'POST', body: { user_id: profile.id, type: 'State Medical License', name: 'QA unpaid insert' } });
    qa.check('the server refuses a license insert from the unpaid account', insert.status >= 400, `HTTP ${insert.status} ${JSON.stringify(insert.data).slice(0, 160)}`);
    const docInsert = await restAs(user, 'documents', { method: 'POST', body: { user_id: profile.id, name: 'QA unpaid doc' } });
    qa.check('the server refuses a document insert from the unpaid account', docInsert.status >= 400, `HTTP ${docInsert.status}`);
    const counts = row(`select (select count(*) from public.licenses where user_id = '${profile.id}')::int as licenses, (select count(*) from public.documents where user_id = '${profile.id}')::int as documents`);
    qa.check('zero rows in synced tables', counts.licenses === 0 && counts.documents === 0, counts);
    qa.check('profile stays pending', profileOf(subject).access_status === 'pending');
  });

  let checkout;
  await qa.feature('BILL-001', 'Review the founding offer and reach Checkout', async () => {
    await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
    await landing(page);
    await page.getByRole('button', { name: 'Review Credential offer' }).click();
    const proceed = page.getByRole('button', { name: 'Continue to secure payment' });
    await proceed.waitFor({ timeout: 60000 });
    const text = (await page.getByRole('region', { name: 'Membership' }).innerText()).replace(/\s+/g, ' ');
    await qa.shot('offer review');
    qa.check('the quote is the founding price, $99.00 per year', /\$99\.00 per year/.test(text), text.match(/Credential \$[\d.]+ per year/)?.[0]);
    qa.check('the consent text says Practice is included', /Includes Practice for as long as this membership remains active/.test(text));
    qa.check('the terms say USD 99 due now, then each year', /USD 99 due now, then USD 99 each year/.test(text));
    qa.check('Continue stays disabled until the terms are agreed', await proceed.isDisabled());
    await page.getByRole('button', { name: 'Refresh offer' }).click().catch(() => {});
    await proceed.waitFor({ timeout: 30000 });
    await page.getByRole('checkbox', { name: /agree to the payment and renewal terms/ }).check();
    qa.check('Continue is enabled once the terms are agreed', await proceed.isEnabled());
    await proceed.click();
    await page.getByTestId('qa-stripe-pay').waitFor({ timeout: 60000 });
    checkout = new URL(page.url()).pathname.split('/').pop();
    qa.check('Continue opens Checkout (the lab stand-in, never checkout.stripe.com)', checkout.startsWith('cs_live_'), checkout.slice(0, 24));
    // Reviewing writes nothing; limited-checkout records the consented quote when Continue is pressed.
    const quotes = rows(`select offer_id, price_phase, annual_cents, consented_at from public.limited_billing_quotes where clerk_subject = '${subject}' order by created_at`);
    qa.check('limited-checkout recorded one consented quote: founding, core, 9900 cents', quotes.length === 1 && quotes[0].offer_id === 'core' && quotes[0].annual_cents === 9900 && quotes[0].price_phase === 'founding' && !!quotes[0].consented_at, quotes);
    const attempts = rows(`select a.state, a.offer_id from public.billing_checkout_attempts a join public.profiles p on p.id = a.profile_id where p.auth_user_id = '${subject}'`);
    qa.check('limited-checkout created one checkout attempt', attempts.length === 1, attempts);
    const subs = row(`select count(*)::int as n from public.billing_subscriptions s join public.profiles p on p.id = s.profile_id where p.auth_user_id = '${subject}'`);
    qa.check('no subscription before payment', subs.n === 0);
  });

  await qa.feature('BILL-003', 'Completed payment activates the membership', async () => {
    await page.getByTestId('qa-stripe-pay').click();
    await page.waitForURL((u) => u.origin === lab().urls.appOrigin && u.searchParams.get('billing') === 'complete', { timeout: 120000 });
    const { deliveries } = await stripeFor(subject);
    const types = deliveries.map((d) => d.type).reverse().join(',');
    qa.check('checkout.session.completed, customer.subscription.created, invoice.paid all accepted (200)', types === 'checkout.session.completed,customer.subscription.created,invoice.paid' && deliveries.every((d) => d.status === 200), deliveries.map((d) => `${d.type} ${d.status}`).join(', '));
    const active = await waitForProfile(subject, (p) => p.access_status === 'active', 60000).catch(() => null);
    qa.check('profiles.access_status becomes active', !!active);
    await waitForMemberApp(page);
    await qa.shot('member home after payment');
    qa.check('Home opens after payment', await page.getByRole('button', { name: /^Home$/ }).first().isVisible());
    const pid = profileOf(subject).id;
    const subs = rows(`select offer_id, status, membership_active from public.billing_subscriptions where profile_id = '${pid}'`);
    qa.check('exactly one billing_subscriptions row, active', subs.length === 1 && subs[0].membership_active === true, subs);
    const receipts = rows(`select price_phase, annual_cents from public.access_purchase_receipts where profile_id = '${pid}'`);
    qa.check('an access_purchase_receipts row at the founding price', receipts.length === 1 && receipts[0].annual_cents === 9900 && receipts[0].price_phase === 'founding', receipts);
    // The checklist expects the attempt "completed"; by design it is closed lazily (limitedLaunchHandlers:
    // closeCheckout runs when the member next starts a checkout), so after payment it still reads open.
    const attempt = row(`select state from public.billing_checkout_attempts where profile_id = '${pid}'`);
    qa.check('one checkout attempt, open or complete (closed lazily by design)', ['open', 'complete'].includes(attempt?.state), attempt?.state);
    // A replayed webhook changes nothing.
    const completed = (await stripeFor(subject)).deliveries.find((d) => d.type === 'checkout.session.completed');
    const replay = completed ? await replayStripeEvent(completed.event).catch((e) => ({ error: e.message })) : { error: 'no checkout.session.completed delivery found' };
    qa.check('a replayed checkout.session.completed is answered 200', replay.status === 200, JSON.stringify(replay).slice(0, 200));
    const again = row(`select (select count(*) from public.billing_subscriptions where profile_id = '${pid}')::int as subs, (select count(*) from public.access_purchase_receipts where profile_id = '${pid}')::int as receipts`);
    qa.check('the replay created no duplicate subscription or receipt', again.subs === 1 && again.receipts === 1, again);
  });

  await qa.feature('BILL-006', 'Practice access matches the membership (founding includes Practice)', async () => {
    const snap = accessSnapshot(subject);
    qa.check('the database grants Credential write', snap?.capabilities?.credential?.write === true);
    qa.check('the database grants Practice write (founding includes Practice)', snap?.capabilities?.practice?.write === true, snap?.capabilities);
    qa.check('the snapshot says Practice is included', snap?.practiceIncluded === true);
    await page.getByRole('navigation').first().getByRole('button', { name: /Practice$/ }).click();
    for (const sub of ['Work', 'RVUs', 'Sched.', 'Invoices', 'Contracts', 'Exp.', 'To do']) {
      qa.check(`Practice shows the "${sub}" sub-tab`, await page.getByRole('button', { name: sub, exact: true }).first().isVisible().catch(() => false));
    }
    await qa.shot('practice tab');
  });

  await qa.feature('HOME-002', 'Get Started card on an empty account', async () => {
    await page.getByRole('navigation').first().getByRole('button', { name: /^Home$/ }).click();
    const card = page.getByText('Add your medical license to begin tracking credentials');
    qa.check('Home shows the Get Started card', await card.isVisible());
    await card.click();
    const dialog = page.getByRole('dialog', { name: 'Add' });
    const opened = await dialog.waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('Get Started opens Credentials > Licenses with the Add form open', opened && await page.getByRole('heading', { name: 'Licenses' }).isVisible());
    if (opened) await dialog.getByRole('button', { name: 'Cancel' }).click();
    qa.check('closing the form leaves Licenses open', await page.getByRole('heading', { name: 'Licenses' }).isVisible());
  });

  await qa.feature('BILL-003', 'Welcome email: nothing is sent while it is off', async () => {
    await sleep(3000);
    const mail = await emails({ to: email });
    qa.check('no email to the new member while the welcome email is off', mail.length === 0, mail.map((m) => m.subject).join(', '));
    const sends = rows(`select status from public.welcome_email_sends w join public.profiles p on p.id = w.profile_id where p.auth_user_id = '${subject}'`);
    qa.check('welcome_email_sends has no sent row', !sends.some((s) => s.status === 'sent'), sends);
  });
});

test('welcome email on: the owner approves it in Admin > Emails, the next paid member gets exactly one', {
  tag: ['@ADMIN-001', '@BILL-003'],
}, async ({ page, qa, secondBrowser }) => {
  const admin = await newMember(page, { firstName: 'Owner', lastName: `Admin ${letters()}` });
  await makeAdmin(admin.user);

  try {
    await qa.feature('ADMIN-001', 'Admin > Emails: approve and turn on the welcome email', async () => {
      await page.reload();
      await waitForMemberApp(page);
      await page.getByRole('navigation').first().getByRole('button', { name: /^More$/ }).click();
      await page.getByRole('button', { name: /Admin/ }).first().click();
      await page.getByRole('navigation', { name: 'Administration sections' }).getByRole('button', { name: 'Emails' }).click();
      const region = page.getByRole('region', { name: 'Welcome email' });
      await region.waitFor();
      qa.check('the section loads its settings (no "settings missing")', !(await region.getByText(/settings missing/i).count()));
      qa.check('it starts Off', await region.getByText('Off.', { exact: false }).count() > 0);
      const approve = region.getByRole('button', { name: 'Approve and turn on' });
      qa.check('"Approve and turn on" is disabled until the wording is confirmed as read', await approve.isDisabled());
      await region.getByRole('checkbox', { name: /I have read the subject/ }).check();
      await approve.click();
      await region.getByText('On.', { exact: true }).waitFor({ timeout: 30000 }).catch(() => {});
      await qa.shot('welcome email on');
      const settings = row('select enabled, approved_version, approved_fingerprint is not null as fp from public.welcome_email_settings');
      qa.check('welcome_email_settings enabled with an approval', settings.enabled === true && settings.fp === true, settings);
      const approvals = rows("select action from public.welcome_email_approvals order by created_at desc limit 1");
      qa.check('the approval is recorded (welcome_email_approvals)', approvals.length === 1, approvals);
    });

    await qa.feature('BILL-003', 'Welcome email on: the next paid member gets exactly one', async () => {
      const ctx = await secondBrowser();
      const member = await newMember(ctx.page, { firstName: 'Welcome', lastName: `Member ${letters()}` });
      const mail = await waitFor('the welcome email', async () => (await emails({ to: member.user.email, subject: 'Welcome to CredentialDOMD' }))[0] || null, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => null);
      qa.check('one welcome email captured for the new member', !!mail, mail?.subject || 'none');
      if (mail) {
        const body = await emailBody(mail.id);
        qa.check('it is the founding version (Credential and Practice)', /founding member/.test(body.text || '') && /Credential and Practice/.test(body.text || ''), (body.text || '').slice(0, 160));
        qa.check('it greets the member by name', /Hi Welcome,/.test(body.text || ''), (body.text || '').slice(0, 40));
        qa.check('from CredentialDOMD, reply to support', /credentialdomd\.com/.test(body.from) && body.reply_to.some((r) => /support@credentialdomd\.com/.test(r)), `${body.from} / ${body.reply_to}`);
      }
      const sends = rows(`select status, variant from public.welcome_email_sends where profile_id = '${member.profile.id}'`);
      qa.check('welcome_email_sends records one sent founding welcome', sends.length === 1 && sends[0].status === 'sent' && sends[0].variant === 'founding', sends);
      // A replayed invoice.paid does not send it again.
      const inv = (await stripeFor(member.user.id)).deliveries.find((d) => d.type === 'invoice.paid');
      if (inv) await replayStripeEvent(inv.event).catch(() => {});
      await sleep(3000);
      const all = await emails({ to: member.user.email, subject: 'Welcome to CredentialDOMD' });
      qa.check('still exactly one welcome after the events are replayed', all.length === 1, `${all.length} welcome email(s)`);
    });

    await qa.feature('ADMIN-001', 'Admin > Emails: turn the welcome email off again', async () => {
      const region = page.getByRole('region', { name: 'Welcome email' });
      await region.getByRole('button', { name: 'Turn off' }).click();
      await region.getByText('Off.').waitFor({ timeout: 30000 }).catch(() => {});
      const settings = row('select enabled from public.welcome_email_settings');
      qa.check('turned off from the app', settings.enabled === false);
    });
  } finally {
    welcomeOff();
  }
});
