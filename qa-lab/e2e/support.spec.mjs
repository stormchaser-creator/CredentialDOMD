// P0 journey: a member files a support ticket with a screenshot, the owner
// answers it in the app (More > Admin > Tickets), the member reads the answer
// in Your tickets, and the reply email reaches the member's mailbox (mock
// Resend) with the stored reply text and a link back to the ticket.
import { test } from './support/fixtures.mjs';
import {
  chooseFiles, emailBody, emails, letters, makeAdmin, newMember, openMore, row, rows, sleep, stamp, syntheticPng, waitFor, waitForMemberApp,
} from './support/lab.mjs';

test('support: ticket with a screenshot, owner replies in the app, member sees it, reply email captured', {
  tag: ['@SUPPORT-001', '@SUPPORT-002', '@SUPPORT-006', '@ADMIN-002'],
}, async ({ page, qa, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Sam', lastName: 'Support' });
  const subject = `QA ticket ${stamp().slice(-9)}`;
  const body = 'QA lab journey: the renewal reminder did not show for my Texas license. Steps: add license, open Home.';
  const replyText = `Thanks, QA lab reply ${stamp().slice(-6)}: reminders show 90 days before expiry.`;
  let ticket;

  await qa.feature('SUPPORT-001', 'File a support ticket with a screenshot', async () => {
    await openMore(page, 'Support');
    await page.getByRole('button', { name: 'New ticket' }).click();
    const form = page.locator('div').filter({ has: page.getByPlaceholder('Short summary (optional)') }).last();
    const selects = form.locator('select');
    await selects.nth(0).selectOption({ index: 1 }).catch(() => {});
    await selects.nth(1).selectOption({ index: 1 }).catch(() => {});
    await page.getByPlaceholder('Short summary (optional)').fill(subject);
    const details = page.getByPlaceholder(/As much detail as helps/);
    await details.fill('too short');
    const send = page.getByRole('button', { name: 'Send ticket' });
    qa.check('"Send ticket" stays disabled under 10 characters', await send.isDisabled());
    await details.fill(body);
    await chooseFiles(page, page.getByRole('button', { name: /Attach a screenshot or file/ }), [{ name: 'qa-screenshot.png', mimeType: 'image/png', buffer: syntheticPng() }]);
    await page.getByRole('button', { name: /Remove qa-screenshot\.png/ }).waitFor({ timeout: 15000 });
    qa.check('the screenshot is attached before sending', true);
    await send.click();
    const done = await page.getByText(/Ticket received|Open Your tickets/).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('ticket sent');
    qa.check('the app confirms the ticket was received', done);
    ticket = await waitFor('the ticket row', async () => row(`select * from public.support_tickets where user_id = '${profile.id}' and subject = '${subject.replace(/'/g, "''")}'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('a support_tickets row with the subject and details', !!ticket && ticket.body === body, ticket ? `${ticket.id} ${ticket.status}` : 'none');
    const withFile = ticket ? rows(`select attachment_path, attachment_paths from public.support_messages where ticket_id = '${ticket.id}'`) : [];
    const paths = [ticket?.context_payload && JSON.stringify(ticket.context_payload), ...withFile.map((m) => JSON.stringify([m.attachment_path, m.attachment_paths]))].join(' ');
    const stored = /\.png|image|attach/i.test(paths) || !!row(`select 1 as x from storage.objects where name like '%${profile.id}%' and (name ilike '%ticket%' or name ilike '%support%')`);
    qa.check('the screenshot is stored with the ticket', stored, paths.slice(0, 200));
  });

  let admin;
  await qa.feature('ADMIN-002', 'The owner answers the ticket in More > Admin > Tickets', async () => {
    const other = await secondBrowser();
    admin = await newMember(other.page, { firstName: 'Owner', lastName: `Support ${letters()}` });
    await makeAdmin(admin.user);
    await other.page.reload();
    await waitForMemberApp(other.page);
    await openMore(other.page, 'Admin');
    await other.page.getByRole('navigation', { name: 'Administration sections' }).getByRole('button', { name: 'Tickets' }).click();
    const item = other.page.getByRole('button').filter({ hasText: subject }).first();
    await item.waitFor({ timeout: 30000 });
    await item.click();
    await other.page.getByText(body).first().waitFor({ timeout: 15000 });
    await sleep(2000);
    const images = await other.page.locator('img').evaluateAll((els) => els.filter((e) => /sign|blob:/i.test(e.src) && e.complete && e.naturalWidth > 0).length);
    qa.check('the admin sees the ticket details', true);
    const cspBlocked = qa.report.console.filter((l) => /Loading the image .*storage\/v1\/object\/sign.*violates|img-src/i.test(l));
    qa.check('the admin sees the screenshot (the image loads)', images > 0, `${images} loaded image(s)${cspBlocked.length ? `; CSP: ${cspBlocked[0].slice(0, 160)}` : ''}`);
    if (!images) {
      await other.page.screenshot({ path: (await qa.shot('admin ticket attachment')).replace(/\.png$/, '-admin.png') });
      qa.bug({
        title: 'Admin > Tickets: the ticket\'s screenshot never displays; the app\'s Content-Security-Policy blocks the signed Storage URL',
        step: 'More > Admin > Tickets > open a ticket filed with a screenshot',
        expected: 'The screenshot thumbnail shows (TicketAttachments renders <img src=signed URL>)',
        actual: `Broken image. src/main.jsx sets img-src 'self' data: blob: https://img.clerk.com, but ticket-attachment-url returns a signed URL on the Supabase host (production: the project's supabase.co URL; lab: the gateway). Console: ${(cspBlocked[0] || 'blocked by CSP').slice(0, 200)}`,
        severity: 'medium',
      });
    }
    await other.page.getByRole('textbox', { name: 'Reply to the physician', exact: true }).fill(replyText);
    await other.page.getByRole('button', { name: 'Send reply' }).click();
    await other.page.getByText(replyText).first().waitFor({ timeout: 30000 });
    await other.page.screenshot({ path: (await qa.shot('admin view before reply')).replace(/\.png$/, '-admin.png') });
    const reply = await waitFor('the admin reply row', async () => row(`select * from public.support_messages where ticket_id = '${ticket.id}' and is_admin_reply and body = '${replyText.replace(/'/g, "''")}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('a support_messages row by the admin (is_admin_reply)', !!reply && reply.author_id === admin.profile.id, reply ? reply.id : 'none');
  });

  await qa.feature('SUPPORT-006', 'The member is emailed the stored reply', async () => {
    const mail = await waitFor('the reply email', async () => (await emails({ to: user.email, subject: subject }))[0] || null, { timeoutMs: 60000, intervalMs: 1500 }).catch(() => null);
    qa.check('one reply email to the member', !!mail, mail?.subject || 'none');
    if (mail) {
      const full = await emailBody(mail.id);
      const text = `${full.text || ''} ${full.html || ''}`;
      qa.check('the subject is "Re: <ticket subject> (CredentialDOMD)"', full.subject === `Re: ${subject} (CredentialDOMD)`, full.subject);
      qa.check('the email carries the stored reply text', text.includes(replyText));
      qa.check('the email links to the ticket in the app (#support)', /credentialdomd\.com\/app\/[^\s"]*#support/.test(text), (text.match(/https:\/\/credentialdomd\.com\/app\/[^\s"<]*/) || [])[0]);
      const all = await emails({ to: user.email, subject });
      qa.check('exactly one email for one reply', all.length === 1, `${all.length}`);
    }
    const sent = row(`select emailed_at from public.support_messages where ticket_id = '${ticket.id}' and is_admin_reply`);
    qa.check('the reply is marked emailed', !!sent?.emailed_at);
  });

  await qa.feature('SUPPORT-002', 'The member reads the reply in Your tickets and answers', async () => {
    await page.reload();
    await waitForMemberApp(page);
    await openMore(page, 'Support');
    await page.getByRole('button', { name: 'Your tickets' }).click();
    await page.getByRole('button').filter({ hasText: subject }).first().click();
    const seen = await page.getByText(replyText).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('member sees reply');
    qa.check('the member sees the owner\'s reply in the thread', seen);
    await page.getByPlaceholder('Add to this ticket').fill('Thank you, that answers it. (QA lab follow-up)');
    await page.getByRole('button', { name: /^Send reply$|^Send$/ }).first().click();
    const ack = await page.getByText(/Reply received/).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('the member\'s reply is accepted', ack);
    await sleep(1500);
    const mine = rows(`select id from public.support_messages where ticket_id = '${ticket.id}' and not is_admin_reply and body like 'Thank you, that answers it.%'`);
    qa.check('the member reply is stored once', mine.length === 1, `${mine.length}`);
    const extra = await emails({ to: user.email, subject });
    qa.check('the member\'s own reply is not emailed to them', extra.length === 1, `${extra.length} email(s)`);
  });
});
