// P0 journey: the owner's account tools. Invite to join (one email that says
// who invited the person and the public offer; it is never access), and a
// lifetime gift by email that the person claims by signing up with exactly
// that address: they land in the app with Credential and Practice for life,
// no checkout, no Cancel Subscription.
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, accessSnapshot, createPhysician, emailBody, emails, landing, letters, makeAdmin, newMember, openMore,
  profileOf, row, rows, signIn, sleep, stamp, waitFor, waitForMemberApp,
} from './support/lab.mjs';

async function openAccounts(page) {
  await openMore(page, 'Admin');
  await page.getByRole('navigation', { name: 'Administration sections' }).getByRole('button', { name: 'Accounts' }).click();
  await page.getByRole('textbox', { name: 'Email address to gift' }).waitFor({ timeout: 30000 });
}

test('owner: invite to join sends one email and grants nothing', { tag: ['@ADMIN-001'] }, async ({ page, qa, secondBrowser }) => {
  const admin = await newMember(page, { firstName: 'Morgan', lastName: `Owner ${letters()}` });
  await makeAdmin(admin.user);
  await page.reload();
  await waitForMemberApp(page);
  const invitee = `invitee-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;

  await qa.feature('ADMIN-001', 'Admin > Accounts > Invite to join: preview, send, ledger, email', async () => {
    await openAccounts(page);
    await page.getByRole('textbox', { name: 'Name (optional)' }).fill('Jordan Invitee');
    await page.getByRole('textbox', { name: 'Email address to invite' }).fill(invitee);
    await page.getByRole('button', { name: 'Preview email' }).click();
    const send = page.getByRole('button', { name: /^Send/ }).first();
    const previewed = await send.waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('invite preview');
    const alert = await page.getByRole('alert').allInnerTexts();
    qa.check('the preview shows the exact email with a Send button', previewed, alert.join(' | '));
    if (!previewed) return;
    const preview = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('the preview says who it is from (the admin)', preview.includes(`Morgan`), preview.match(/[^.]*invited you to join CredentialDOMD[^.]*/)?.[0]);
    qa.check('the preview quotes the current public offer ($99 founding)', /\$99/.test(preview));
    qa.check('nothing is sent by previewing', (await emails({ to: invitee })).length === 0);
    await send.click();
    const mail = await waitFor('the invitation email', async () => (await emails({ to: invitee }))[0] || null, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => null);
    await qa.shot('invite sent');
    qa.check('one invitation email captured', !!mail, mail?.subject || 'none');
    if (mail) {
      const full = await emailBody(mail.id);
      qa.check('subject "<admin> invited you to join CredentialDOMD"', /Morgan .* invited you to join CredentialDOMD/.test(full.subject), full.subject);
      qa.check('replies go to the admin\'s own mailbox', full.reply_to.some((r) => r.toLowerCase().includes(admin.user.email)), full.reply_to.join(','));
      qa.check('the email links to sign up', /credentialdomd\.com\/app\//.test(`${full.text} ${full.html}`));
    }
    const ledger = rows(`select status, offer_phase, offer_annual_cents, provider_id from public.invite_to_join_sends where email = '${invitee}'`);
    qa.check('invite_to_join_sends records one sent row with the founding offer', ledger.length === 1 && ledger[0].status === 'sent' && ledger[0].offer_annual_cents === 9900, ledger);
    // Sending the same address again inside 24 hours needs an explicit resend.
    await page.getByRole('textbox', { name: 'Email address to invite' }).fill(invitee);
    await page.getByRole('button', { name: 'Preview email' }).click();
    await sleep(2000);
    const again = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    // The limit is for the whole service (20 in any rolling 24 hours), so earlier runs count too.
    const counted = Number((/(\d+) of 20 invitations sent in the last 24 hours/.exec(again) || [])[1]);
    qa.check('the service-wide counter shows this send (n of 20 in the last 24 hours)', counted >= 1, again.match(/\d+ of 20 invitations[^.]*/)?.[0]);
    qa.check('a second invite to the same address inside 24 hours is flagged (already invited / send again)', /already (been )?invited|send again|invited .* ago|within 24 hours/i.test(again), again.match(/[^.]*(already|send again|within 24 hours)[^.]*/i)?.[0] || again.slice(0, 200));
  });

  await qa.feature('ADMIN-001', 'An invitation is not access: the invitee signs up and meets the gate', async () => {
    const other = await secondBrowser();
    const person = await createPhysician({ firstName: 'Jordan', lastName: 'Invitee', email: invitee });
    await signIn(other.page, person);
    const where = await landing(other.page);
    qa.check('the invited person lands on the pending gate like anyone else', where === 'gate', where);
    qa.check('their profile is pending', profileOf(person.id)?.access_status === 'pending');
  });
});

test('owner: lifetime gift by email, claimed by signing up with that address', { tag: ['@ADMIN-001', '@BILL-014'] }, async ({ page, qa, secondBrowser }) => {
  const admin = await newMember(page, { firstName: 'Casey', lastName: `Owner ${letters()}` });
  await makeAdmin(admin.user);
  await page.reload();
  await waitForMemberApp(page);
  const giftee = `gift-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;

  await qa.feature('ADMIN-001', 'Admin > Accounts > Gift lifetime access by email', async () => {
    await openAccounts(page);
    const gift = page.getByRole('button', { name: 'Gift free lifetime access' });
    await page.getByRole('textbox', { name: 'Email address to gift' }).fill(giftee);
    await page.getByRole('textbox', { name: 'Reason for the gift' }).fill('short');
    await gift.click();
    await sleep(1500);
    const refused = !row(`select id from public.lifetime_gift_reservations where email = '${giftee}'`);
    qa.check('a reason under 10 characters is refused', refused);
    await page.getByRole('textbox', { name: 'Reason for the gift' }).fill('QA lab: lifetime gift journey');
    await gift.click();
    const reservation = await waitFor('the gift reservation', async () => row(`select * from public.lifetime_gift_reservations where email = '${giftee}'`), { timeoutMs: 30000 }).catch(() => null);
    await qa.shot('gift reserved');
    qa.check('lifetime_gift_reservations row waiting for that address', !!reservation && !reservation.claimed_at && reservation.reason === 'QA lab: lifetime gift journey', reservation ? `livemode ${reservation.livemode}, expires ${reservation.expires_at}` : 'none');
    qa.check('the gift is listed as waiting', /waiting/i.test(await page.locator('body').innerText()));
    await sleep(1500);
    qa.check('no email is sent for a gift', (await emails({ to: giftee })).length === 0);
  });

  await qa.feature('BILL-014', 'The giftee signs up with that address: lifetime member, no checkout', async () => {
    const other = await secondBrowser();
    const person = await createPhysician({ firstName: 'Taylor', lastName: 'Giftee', email: giftee });
    await signIn(other.page, person);
    const where = await landing(other.page);
    await other.page.screenshot({ path: (await qa.shot('giftee landing')).replace(/\.png$/, '-giftee.png') });
    qa.check('the giftee lands in the member app, not on the gate', where === 'member', where);
    const claimed = row(`select claimed_subject, claimed_at from public.lifetime_gift_reservations where email = '${giftee}'`);
    qa.check('the reservation is claimed by the new account', claimed?.claimed_subject === person.id && !!claimed.claimed_at, claimed);
    const snap = accessSnapshot(person.id);
    qa.check('lifetime Credential and Practice', snap?.lifetime?.credential === true && snap?.lifetime?.practice === true, snap?.lifetime);
    qa.check('both Credential and Practice writable', snap?.capabilities?.credential?.write === true && snap?.capabilities?.practice?.write === true);
    const receipts = rows(`select 1 from public.billing_subscriptions s join public.profiles p on p.id = s.profile_id where p.auth_user_id = '${person.id}'`);
    qa.check('no subscription or checkout was involved', receipts.length === 0);
    if (where === 'member') {
      await openMore(other.page, 'Profile & settings');
      const card = (await other.page.getByRole('region', { name: 'Membership' }).innerText().catch(() => '')).replace(/\s+/g, ' ');
      qa.check('the membership card says the lifetime access is protected', /lifetime access is protected/i.test(card), card.slice(0, 200));
      qa.check('no offer or purchase buttons on the card', !/Review .* offer|Continue to secure payment/i.test(card));
      await other.page.getByRole('navigation').first().getByRole('button', { name: /^(\S+ )?More$/ }).click();
      qa.check('More has no "Cancel Subscription" for a lifetime member', !(await other.page.getByRole('button', { name: 'Cancel Subscription' }).count()));
    }
  });
});
