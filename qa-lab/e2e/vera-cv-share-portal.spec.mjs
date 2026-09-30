// Administrator access, both sides. The physician (owner) creates a standing,
// view-only link for a medical staff office from More > Administrator access
// (preview, send, list, resend, narrow, end date, revoke); the administrator
// opens the emailed link on the private page (email, code, verify), previews
// and downloads a file, refreshes, is refused a download once the physician
// turns downloads off, ends the visit, and is refused after the revoke.
//
// The private page (landing/credential-access.html and public/credential-access/)
// is not served by the lab app server; support/vera-cv-share-helpers.mjs
// serves the repository's own files on the lab app's origin with the portal
// switched on and its endpoint pointed at the lab's API proxy (see there).
// Email (the link, the codes) is the lab's mock Resend.
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, emailBody, emails, newMember, openMore, row, rows, shot, sleep, syntheticPdf, waitFor, waitForEmail,
} from './support/lab.mjs';
import {
  addRecord, attachToRecord, codeFrom, day, installDeviceStandIns, inviteTokenFrom, openAdministratorPage, runTag, serveAdministratorPage, waitForDocument,
} from './support/vera-cv-share-helpers.mjs';

test('administrator access: the physician shares a view-only link; the administrator verifies, previews, downloads; narrow, resend, end date, revoke', {
  tag: ['@SHARE-006', '@SHARE-001'],
}, async ({ page, context, qa, secondBrowser }) => {
  test.setTimeout(9 * 60 * 1000);
  await installDeviceStandIns(context);
  const { profile } = await newMember(page, { firstName: 'Avery', lastName: 'Access' });
  const pid = profile.id;
  const tag = runTag();
  const admin = `medstaff-${tag.toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
  const purpose = `QA Mercy medical staff office ${tag}`;
  const number = `QA-AZ-${tag.slice(-5)}`;
  const fileName = `qa-az-license-${tag}.pdf`;

  await addRecord(page, 'Licenses', { Type: 'State Medical License', 'Display Name': 'QA Arizona Medical License', 'License #': number, State: 'AZ', Expires: day(300) }, { dialogName: 'Add' });
  await attachToRecord(page, 'Licenses', number, { name: fileName, mimeType: 'application/pdf', buffer: syntheticPdf(`QA synthetic AZ license ${tag}`) });
  const lic = row(`select id from public.licenses where user_id = '${pid}' and license_number = '${number}'`);
  const doc = await waitForDocument(pid, fileName, { linked: lic?.id });

  // The administrator's browser: clean, with the private page served.
  const { context: adminCtx, page: adminPage } = await secondBrowser();
  await serveAdministratorPage(adminCtx);
  const adminShot = (name) => shot(adminPage, `vera-cv-share portal administrator ${name}`);
  const downloads = [];
  adminPage.on('download', (d) => downloads.push(d.suggestedFilename()));
  let invite = null;
  let token = null;

  const owner = async () => {
    await openMore(page, 'Administrator access');
    await page.getByRole('heading', { name: 'Administrator access' }).waitFor({ timeout: 15000 });
  };
  const grantCard = () => page.locator('section').filter({ hasText: admin }).last();

  await qa.feature('SHARE-006', 'Owner: purpose, sections, downloads, days; preview; send the access link', async () => {
    qa.check('the license and its copy are on file', !!doc);
    await owner();
    const form = page.locator('section').filter({ hasText: 'New access link' }).first();
    await form.getByLabel('Administrator email').fill(admin);
    await form.getByLabel('Facility or office').fill(purpose);
    await form.getByLabel('Access ends after').selectOption('30');
    // The counts come from the server's own allowlist, a moment after the page opens.
    const licensesRow = form.locator('label').filter({ has: page.locator('input[data-section="licenses"]') });
    await licensesRow.getByText(/\d+ records?/).waitFor({ timeout: 15000 }).catch(() => {});
    const count = await licensesRow.innerText().catch(() => '');
    qa.check('Licenses is offered with its live count (1 record, 1 file)', /1 record, 1 file/.test(count), count.replace(/\s+/g, ' ').slice(0, 160));
    qa.check('downloads are allowed by default', await form.locator('input[data-control="allow-download"]').isChecked());
    await form.getByRole('button', { name: 'Preview as administrator' }).click();
    const preview = page.getByText('What the administrator sees').locator('xpath=..');
    const previewed = await preview.waitFor({ timeout: 20000 }).then(() => true, () => false);
    const previewText = previewed ? (await preview.innerText()).replace(/\s+/g, ' ') : '';
    await qa.shot('owner preview');
    qa.check('"Preview as administrator" shows the license and its file, downloadable', previewText.includes(number) && previewText.includes(fileName) && /preview and download/.test(previewText), previewText.slice(0, 300));
    qa.check('the preview never includes Protected Identity or the SSN', !/Protected Identity|SSN|Social Security/.test(previewText));
    const since = new Date().toISOString();
    await form.getByRole('button', { name: 'Send access link' }).click();
    const notice = await page.getByRole('status').filter({ hasText: /Access created for/ }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    qa.check('the owner is told the access was created and the link is on its way', notice, (await page.getByRole('status').allInnerTexts()).join(' | ').slice(0, 200));
    invite = await waitFor('the invite row', async () => row(`select * from public.credential_portal_invites where owner_profile_id = '${pid}' and recipient_email = '${admin}'`), { timeoutMs: 15000 }).catch(() => null);
    qa.check('credential_portal_invites: a standing grant with the purpose, downloads on, 30 days', invite?.kind === 'standing' && invite?.purpose === purpose && invite?.allow_download === true
      && Math.abs(new Date(invite.expires_at) - Date.now() - 30 * 86400000) < 3600000, invite ? JSON.stringify({ kind: invite.kind, purpose: invite.purpose, dl: invite.allow_download, exp: invite.expires_at, scope: invite.scope }) : 'none');
    const mail = await waitForEmail({ to: admin, since }, 30000).catch(() => null);
    const body = mail ? await emailBody(mail.id) : null;
    token = inviteTokenFrom(body?.text);
    qa.check('the administrator receives the link by email', !!token, (body?.subject || '') + ' / ' + (body?.text || '').slice(0, 200));
    qa.check('the email names the physician and the purpose, and says downloads are allowed', /Avery Access/.test(body?.subject || '') && (body?.text || '').includes(purpose) && /download the files/.test(body?.text || ''), body?.subject);
    qa.check('replies go to the physician', JSON.stringify(body?.reply_to || body?.replyTo || '').includes(profile.email) || JSON.stringify(body?.reply_to || body?.replyTo || '').includes('qa.credentialdomd.test'), JSON.stringify(body?.reply_to || body?.replyTo));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await sleep(1500);
    const card = (await grantCard().innerText().catch(() => '')).replace(/\s+/g, ' ');
    await qa.shot('grant listed');
    qa.check('the grant is listed: active, no visits yet, downloads on, email accepted', /Active/.test(card) && /no visits yet/.test(card) && /downloads on/.test(card) && /Email accepted by provider|Email queued/.test(card), card.slice(0, 300));
    qa.check('audit: invitation_created', rows(`select event from public.credential_portal_audit where invite_id = '${invite?.id}'`).some((r) => r.event === 'invitation_created'), JSON.stringify(rows(`select event from public.credential_portal_audit where invite_id = '${invite?.id}'`)));
  }, { soft: true });

  const openLink = async (t, email = admin) => {
    await openAdministratorPage(adminPage, t);
    await adminPage.getByRole('heading', { name: 'Start with your email' }).waitFor({ timeout: 20000 });
    await adminPage.getByLabel('Invited email address').fill(email);
    const since = new Date().toISOString();
    await adminPage.getByRole('button', { name: 'Email me a code' }).click();
    await adminPage.getByRole('heading', { name: 'Check your inbox' }).waitFor({ timeout: 20000 });
    return since;
  };

  await qa.feature('SHARE-001', 'Administrator: verify by code, view the file, preview, download, refresh, end visit', async () => {
    if (!token) throw new Error('no invitation link from SHARE-006');
    const since = await openLink(token);
    await adminShot('code step');
    const codeMail = await waitForEmail({ to: admin, since, subject: 'access code' }, 30000).catch(() => null);
    const code = codeFrom(codeMail ? (await emailBody(codeMail.id)).text : '');
    qa.check('a six-digit code arrives at the invited address', !!code, codeMail?.subject);
    if (!code) return;
    await adminPage.getByLabel('Six-digit code').fill(code);
    await adminPage.getByRole('button', { name: 'Verify and open' }).click();
    const opened = await adminPage.locator('#standing-view').waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false);
    const view = opened ? (await adminPage.locator('#standing-view').innerText()).replace(/\s+/g, ' ') : (await adminPage.locator('body').innerText()).slice(0, 400);
    await adminShot('standing view');
    qa.check('the credential file opens: physician, purpose, the license and its file', opened && /Avery Access/.test(view) && view.includes(purpose) && view.includes(number) && view.includes(fileName), view.slice(0, 400));
    qa.check('it says view only and that downloads save a copy', /View only/.test(view) && /Downloads save a copy/.test(view));
    const session = row(`select s.* from public.credential_portal_sessions s where s.invite_id = '${invite?.id}' order by created_at desc limit 1`);
    qa.check('credential_portal_sessions: a visit session', !!session, session ? session.expires_at : 'none');
    // Preview the PDF, close it.
    await adminPage.getByRole('button', { name: `Preview ${fileName}` }).click();
    const preview = await adminPage.locator('#preview-panel').waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false);
    const rendered = preview && await adminPage.locator('#preview-frame canvas').waitFor({ state: 'visible', timeout: 20000 }).then(() => true, () => false);
    await adminShot('pdf preview');
    qa.check('Preview opens the PDF on the page', preview && rendered, (await adminPage.locator('#status').innerText().catch(() => '')) + ' ' + (await adminPage.locator('#error').innerText().catch(() => '')));
    await adminPage.getByRole('button', { name: 'Close preview' }).click();
    qa.check('Close preview hides it', await adminPage.locator('#preview-panel').isHidden());
    // Download (allowed).
    await adminPage.getByRole('button', { name: `Download ${fileName}` }).click();
    await waitFor('the download', async () => (downloads.includes(fileName) ? true : null), { timeoutMs: 15000 }).catch(() => {});
    qa.check('Download saves the file', downloads.includes(fileName), downloads.join(', '));
    await adminPage.getByRole('button', { name: 'Refresh', exact: true }).click();
    const refreshed = await adminPage.locator('#status').filter({ hasText: 'Refreshed.' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('Refresh reloads the file and says so', refreshed);
    const events = rows(`select event, intent from public.credential_portal_audit where invite_id = '${invite?.id}' order by created_at`).map((r) => `${r.event}${r.intent ? `:${r.intent}` : ''}`);
    qa.check('credential_portal_audit records the visit, the preview and the download', events.includes('session_verified') && events.some((e) => /view/.test(e)) && events.some((e) => /download/.test(e)), events.join(', '));
  }, { soft: true });

  await qa.feature('SHARE-006', 'Owner: visits and file activity; narrow (downloads off); the administrator is refused a download', async () => {
    await owner();
    const card = grantCard();
    const activity = card.locator('summary', { hasText: /Activity/ });
    const hasActivity = await activity.waitFor({ timeout: 15000 }).then(() => true, () => false);
    if (hasActivity) await activity.click();
    const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
    await qa.shot('grant activity');
    qa.check('the grant shows the visit and the file activity (previewed, downloaded)', /Activity: 1 visit/.test(text) && /previewed 1/.test(text) && /downloaded 1/.test(text) && /last visit/.test(text), text.slice(0, 400));
    await card.getByRole('button', { name: 'Narrow' }).click();
    await card.getByRole('checkbox', { name: 'Allow downloads' }).uncheck();
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    const narrowed = await page.getByRole('status').filter({ hasText: /Access narrowed/ }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('Narrow: downloads turned off', narrowed && row(`select allow_download from public.credential_portal_invites where id = '${invite?.id}'`)?.allow_download === false);
    qa.check('the grant now reads downloads off', /downloads off/.test((await grantCard().innerText()).replace(/\s+/g, ' ')));
    // The administrator's page still shows Download from before: the server refuses it.
    const before = downloads.length;
    await adminPage.getByRole('button', { name: `Download ${fileName}` }).click();
    const refusedMsg = await adminPage.locator('#error').filter({ hasText: /turned off downloads/ }).waitFor({ timeout: 15000 }).then(() => true, () => false);
    await sleep(1000);
    qa.check('the administrator is told downloads are off, and nothing downloads', refusedMsg && downloads.length === before, await adminPage.locator('#error').innerText().catch(() => ''));
    qa.check('the Download button is gone, Preview stays', !(await adminPage.getByRole('button', { name: `Download ${fileName}` }).count()) && await adminPage.getByRole('button', { name: `Preview ${fileName}` }).isVisible());
    qa.check('the refusal is audited', rows(`select intent, event from public.credential_portal_audit where invite_id = '${invite?.id}'`).some((r) => /refus/.test(`${r.event} ${r.intent}`)), JSON.stringify(rows(`select event, intent from public.credential_portal_audit where invite_id = '${invite?.id}'`)));
    // End visit.
    await adminPage.getByRole('button', { name: 'End visit' }).click();
    const ended = await adminPage.getByRole('heading', { name: 'You ended this visit' }).waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('"End visit" ends it and says the link works again with a new code', ended && /new code/.test(await adminPage.locator('#message-detail').innerText()));
  }, { soft: true });

  await qa.feature('SHARE-006', 'Owner: resend the link, change the end date, revoke; the administrator is refused', async () => {
    await owner();
    let card = grantCard();
    const since = new Date().toISOString();
    await card.getByRole('button', { name: 'Resend link' }).click();
    const resent = await page.getByRole('status').filter({ hasText: /A new link is on its way/ }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    const mail = await waitForEmail({ to: admin, since, subject: 'Credential file access' }, 30000).catch(() => null);
    const newToken = inviteTokenFrom(mail ? (await emailBody(mail.id)).text : '');
    qa.check('Resend link sends a new link (the old one stops working)', resent && !!newToken && newToken !== token);
    // The old link: a code request is quietly ignored, so no code arrives.
    const oldSince = await openLink(token);
    await sleep(5000);
    qa.check('the old link no longer sends a code', (await emails({ to: admin, since: oldSince, subject: 'access code' })).length === 0);
    // A new end date.
    card = grantCard();
    const before = row(`select expires_at from public.credential_portal_invites where id = '${invite?.id}'`)?.expires_at;
    await card.getByLabel('New end date').selectOption('90');
    await card.getByRole('button', { name: 'Save end date' }).click();
    const moved = await page.getByRole('status').filter({ hasText: /Access now ends/ }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    const after = row(`select expires_at from public.credential_portal_invites where id = '${invite?.id}'`)?.expires_at;
    qa.check('the end date moves to 90 days from today', moved && Math.abs(new Date(after) - Date.now() - 90 * 86400000) < 3600000, `${before} -> ${after}`);
    // Revoke (with its confirmation).
    const dialogs = qa.report.dialogs.length;
    await grantCard().getByRole('button', { name: 'Revoke' }).click();
    const revoked = await page.getByRole('status').filter({ hasText: /Access ended\. The link no longer works/ }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('Revoke asks first', qa.report.dialogs.slice(dialogs).some((d) => /End .* access now\?/.test(d)), qa.report.dialogs.slice(dialogs).join(' | '));
    qa.check('Revoke ends the access (revoked_at set) and the grant reads Revoked', revoked && !!row(`select revoked_at from public.credential_portal_invites where id = '${invite?.id}'`)?.revoked_at && /Revoked/.test(await grantCard().innerText()));
    await qa.shot('grant revoked');
    // The administrator tries the newest link after the revoke.
    const revokedSince = await openLink(newToken || token);
    await sleep(5000);
    qa.check('after the revoke no code is sent', (await emails({ to: admin, since: revokedSince, subject: 'access code' })).length === 0);
    await adminPage.getByLabel('Six-digit code').fill('123456');
    await adminPage.getByRole('button', { name: 'Verify and open' }).click();
    const refused = await adminPage.locator('#error').filter({ hasText: /could not be verified/ }).waitFor({ timeout: 15000 }).then(() => true, () => false);
    await adminShot('refused after revoke');
    qa.check('a code for the revoked link is refused', refused, await adminPage.locator('#error').innerText().catch(() => ''));
    qa.check('the private page never reached another host', qa.report.external.length === 0, qa.report.external.join(', '));
  }, { soft: true });
});
