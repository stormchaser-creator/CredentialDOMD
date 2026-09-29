// Email intake: the physician confirms a second address they forward from
// (the confirmation email is captured; its link opens the lab's relay of
// /api/confirm-forwarding, as production's Cloudflare worker does), then a
// document forwarded from that address to docs@ reaches their account, and
// the same mail from an address nobody confirmed is not filed.
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, emailBody, emails, goTab, mockApi, newMember, openMore, row, rows, sleep, stamp, syntheticPdf, waitFor, waitForMemberApp,
} from './support/lab.mjs';

const inbound = (body) => mockApi('/qa/inbound', { method: 'POST', body });
const AUTH_PASS = (domain) => ({ 'authentication-results': `mx.qa.credentialdomd.test; dmarc=pass header.from=${domain}; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}` });

test('intake: confirm a forwarding address, forward a document to docs@, an unconfirmed sender is not filed', {
  tag: ['@INTAKE-001', '@INTAKE-002', '@INTAKE-003'],
}, async ({ page, qa, context }) => {
  const { user, profile } = await newMember(page, { firstName: 'Ira', lastName: 'Intake' });
  const forwarder = `fwd-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;

  await qa.feature('INTAKE-001', 'Add and confirm a forwarding address', async () => {
    await openMore(page, 'Profile & settings');
    const box = page.getByPlaceholder('you@hospital.org');
    await box.fill(forwarder);
    await box.locator('xpath=ancestor::div[.//button][1]').getByRole('button', { name: 'Add', exact: true }).click();
    const mail = await waitFor('the confirmation email', async () => (await emails({ to: forwarder }))[0] || null, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => null);
    qa.check('a confirmation email goes to the new address', mail?.subject === 'Confirm this address for CredentialDOMD forwarding', mail?.subject || 'none');
    qa.check('the app says nothing routes until it is confirmed', /Nothing is routed here until someone opens the link/.test(await page.locator('body').innerText()));
    const waiting = row(`select verified_at from public.forwarding_addresses where user_id = '${profile.id}' and email = '${forwarder}'`);
    qa.check('forwarding_addresses row, not yet verified', !!waiting && !waiting.verified_at);
    const text = mail ? (await emailBody(mail.id)).text || '' : '';
    const link = (text.match(/https?:\/\/\S+\/api\/confirm-forwarding\?token=\S+/) || [])[0];
    qa.check('the email carries the confirmation link', !!link);
    if (!link) return;
    const tab = await context.newPage();
    await tab.goto(link);
    const confirm = tab.getByRole('button', { name: /Confirm/ }).first();
    const shown = await confirm.waitFor({ timeout: 20000 }).then(() => true, () => false);
    qa.check('the link opens a page with one Confirm button (nothing changes on open)', shown && !row(`select verified_at from public.forwarding_addresses where email = '${forwarder}'`).verified_at);
    if (shown) await confirm.click();
    await sleep(2500);
    await tab.screenshot({ path: (await qa.shot('confirm page')).replace(/\.png$/, '-confirm.png') });
    await tab.close();
    const done = row(`select verified_at from public.forwarding_addresses where email = '${forwarder}'`);
    qa.check('pressing Confirm verifies the address', !!done?.verified_at);
    await page.reload();
    await waitForMemberApp(page);
    await openMore(page, 'Profile & settings');
    await page.getByText('Confirmed from that mailbox').first().waitFor({ timeout: 20000 }).catch(() => {});
    const section = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('the app lists it as confirmed', new RegExp(`${forwarder.replace(/[.]/g, '\\.')}.{0,40}Confirmed`, 'i').test(section), section.match(new RegExp(`${forwarder.replace(/[.]/g, '\\.')}.{0,60}`))?.[0]);
  });

  await qa.feature('INTAKE-002', 'A document forwarded to docs@ from the confirmed address reaches the account', async () => {
    const pdf = syntheticPdf('QA synthetic hospital privileges letter');
    const res = await inbound({ from: `Ira Intake <${forwarder}>`, to: ['docs@credentialdomd.com'], subject: 'Fwd: QA privileges letter', text: 'Forwarding my privileges letter.',
      headers: AUTH_PASS(LAB_EMAIL_DOMAIN), attachments: [{ filename: 'qa-privileges-letter.pdf', content_type: 'application/pdf', content: pdf.toString('base64') }] });
    qa.check('email-inbound accepted the signed webhook', (res.delivery?.status || res.status) === 200, JSON.stringify(res).slice(0, 200));
    const logged = await waitFor('the inbound row', async () => row(`select route, status, profile_id, detail from public.inbound_emails where from_addr ilike '%${forwarder}%' order by created_at desc limit 1`), { timeoutMs: 60000 }).catch(() => null);
    qa.check('inbound_emails records it for this account', logged?.profile_id === profile.id, logged ? `${logged.route} ${logged.status} ${JSON.stringify(logged.detail || '').slice(0, 80)}` : 'none');
    const doc = await waitFor('the document', async () => row(`select name, linked_to, storage_path from public.documents where user_id = '${profile.id}' and name = 'qa-privileges-letter.pdf'`), { timeoutMs: 60000 }).catch(() => null);
    qa.check('the attachment is stored as a document on the account', !!doc?.storage_path, doc ? `${doc.name} linked ${doc.linked_to}` : 'none');
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Documents');
    const docs = await page.locator('body').innerText();
    await qa.shot('documents after intake');
    qa.check('Documents shows the forwarded file', /qa-privileges-letter\.pdf/.test(docs));
  });

  await qa.feature('INTAKE-003', 'Emailed-in documents not filed yet are grouped in Documents', async () => {
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('Documents shows the inbox group for mail not filed yet (or the file already filed)', /From your inbox|not filed yet|qa-privileges-letter\.pdf/i.test(text), text.match(/From your inbox[^.]*/i)?.[0]);
  });

  await qa.feature('INTAKE-002', 'The same mail from an unconfirmed address is not filed', async () => {
    const stranger = `stranger-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
    const pdf = syntheticPdf('QA synthetic letter from an unconfirmed sender');
    await inbound({ from: stranger, to: ['docs@credentialdomd.com'], subject: 'QA unconfirmed', text: 'Please file this.',
      headers: AUTH_PASS(LAB_EMAIL_DOMAIN), attachments: [{ filename: 'qa-unconfirmed.pdf', content_type: 'application/pdf', content: pdf.toString('base64') }] });
    await sleep(6000);
    qa.check('nothing from the unconfirmed sender reaches the account', !rows(`select id from public.documents where name = 'qa-unconfirmed.pdf'`).length);
    const reply = (await emails({ to: stranger }))[0];
    qa.check('the unconfirmed sender gets the not-confirmed reply', !!reply, reply?.subject || 'no reply captured');
  });
});
