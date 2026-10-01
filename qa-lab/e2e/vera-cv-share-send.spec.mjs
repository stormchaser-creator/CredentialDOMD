// Sending records and documents: a license with two copies sent through the
// share sheet, Mail (text only), Messages and Copy, with the send history; the
// same license emailed with real attachments from CredentialDOMD (the lab's
// mock Resend), an over-the-cap selection and the hourly send cap; and three
// documents sent as one packet, on this device and on a clean browser whose
// copies have not downloaded yet.
//
// The phone's share sheet, clipboard, Mail and Messages are stand-ins that
// record what the app hands them (support/vera-cv-share-helpers.mjs).
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, base64Marker, chooseFiles, emailBody, emails, goTab, shot, labExec, landing, newMember, recordButtons, openCredentials, pendingOps, row, rows,
  scriptAi, signIn, sleep, syntheticPdf, waitFor, waitForEmail, waitForMemberApp, field,
} from './support/lab.mjs';
import {
  addRecord, attachToRecord, day, deviceLog, installDeviceStandIns, runTag, shareLog, waitForDocument,
} from './support/vera-cv-share-helpers.mjs';

test('send a license: share sheet, Mail, Text, Copy and history; email with attachments, the file cap and the hourly cap; documents as one packet', {
  tag: ['@SHARE-002', '@SHARE-003', '@SHARE-004'],
}, async ({ page, context, qa, secondBrowser }) => {
  test.setTimeout(10 * 60 * 1000);
  await installDeviceStandIns(context);
  const { profile, user } = await newMember(page, { firstName: 'Sasha', lastName: 'Sender' });
  const pid = profile.id;
  const tag = runTag();
  const number = `QA-TX-${tag.slice(-5)}`;
  const recipient = `medstaff-${tag.toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
  const files = [`qa-tx-license-front-${tag}.pdf`, `qa-tx-license-back-${tag}.pdf`];

  await addRecord(page, 'Licenses', { Type: 'State Medical License', 'Display Name': 'QA Texas Medical License', 'License #': number, State: 'TX', Expires: day(365) }, { dialogName: 'Add' });
  for (const name of files) await attachToRecord(page, 'Licenses', number, { name, mimeType: 'application/pdf', buffer: syntheticPdf(`QA synthetic ${name}`) });
  const lic = row(`select id from public.licenses where user_id = '${pid}' and license_number = '${number}'`);
  const docs = [];
  for (const name of files) docs.push(await waitForDocument(pid, name, { linked: lic?.id }));

  const openSend = async () => {
    await openCredentials(page, 'Licenses');
    await recordButtons(page, number).share.click();
    const d = page.getByRole('dialog', { name: 'Send Credential' });
    await d.waitFor({ timeout: 10000 });
    return d;
  };

  await qa.feature('SHARE-002', 'Send a record: share sheet with the files, Mail, Text, Copy; history newest first', async () => {
    qa.check('the license has its two copies on file', docs.every(Boolean), JSON.stringify(docs.map((d) => d?.name)));
    const d = await openSend();
    await qa.shot('send sheet');
    const text = await d.innerText();
    qa.check('the sheet lists the 2 linked documents', /Linked Documents \(2\)/i.test(text) && files.every((f) => text.includes(f)), text.slice(0, 300));
    await field(d, 'Email').fill(recipient);
    await field(d, 'Phone').fill('(555) 010-7788');
    await field(d, 'Note (optional)').fill(`QA note ${tag}: renewal paperwork for the office`);
    const share = d.getByRole('button', { name: 'Send with 2 documents attached' });
    qa.check('the share button promises the 2 documents', await share.isVisible().catch(() => false));
    // The linked files are fetched when the sheet opens; the tap needs them in hand.
    await sleep(2000);
    await share.click();
    await sleep(1500);
    let log = await deviceLog(page);
    const sheet = log.shared.at(-1);
    qa.check('the share sheet gets both files', (sheet?.files || []).length === 2 && sheet.files.every((f) => f.head === '%PDF-'), JSON.stringify(sheet?.files));
    qa.check('the share carries the note', (sheet?.text || '').includes(`QA note ${tag}`), (sheet?.text || '').slice(0, 200));
    qa.check('the formatted letter goes on the clipboard beside a file share', (log.clipboard.at(-1) || '').includes(number), (log.clipboard.at(-1) || '').slice(0, 160));

    await d.getByRole('button', { name: /Email \(opens Mail\)/ }).click();
    await sleep(500);
    log = await deviceLog(page);
    const mailto = log.opened.find((u) => u.startsWith('mailto:')) || '';
    qa.check('"Email (opens Mail)" opens Mail to the recipient with the text only', mailto.startsWith(`mailto:${encodeURIComponent(recipient)}`) && decodeURIComponent(mailto).includes(number) && !/attach/i.test(decodeURIComponent(mailto).split('body=')[1] || ''), decodeURIComponent(mailto).slice(0, 200));
    // The Email button reads "Opening..." for three seconds; the Text button is its neighbour.
    await d.getByRole('button', { name: 'Email (opens Mail)', exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    await d.getByRole('button', { name: 'Text', exact: true }).click();
    await sleep(500);
    log = await deviceLog(page);
    const sms = log.opened.find((u) => u.startsWith('sms:')) || '';
    qa.check('"Text" opens Messages to the phone with the letter', sms.startsWith('sms:5550107788') && decodeURIComponent(sms).includes(number), decodeURIComponent(sms).slice(0, 160));
    await d.getByRole('button', { name: /^Copy$/ }).click();
    const copied = await d.getByRole('button', { name: /Copied!/ }).waitFor({ timeout: 3000 }).then(() => true, () => false);
    qa.check('Copy shows "Copied!" and the clipboard holds the letter', copied && ((await deviceLog(page)).clipboard.at(-1) || '').includes(number));
    await sleep(2500);
    const logged = shareLog(pid).filter((r) => r.item_id === lic?.id);
    qa.check('share_log has the four sends for this license, newest first: clipboard, text, email, share', logged.map((r) => r.method).join(',') === 'clipboard,text,email,share', JSON.stringify(logged.map((r) => [r.method, r.recipient])));
    qa.check('the recipients are logged (email for share/email, phone for text)', logged.find((r) => r.method === 'share')?.recipient === recipient && logged.find((r) => r.method === 'text')?.recipient === '(555) 010-7788', JSON.stringify(logged.map((r) => [r.method, r.recipient])));
    qa.check('nothing queued', (await pendingOps(page)).length === 0);
    await page.keyboard.press('Escape');
    // Reopen after a reload: the history comes back from the cloud.
    await page.reload();
    await waitForMemberApp(page);
    const again = await openSend();
    const hist = (await again.innerText()).split(/Send history/i)[1] || '';
    const order = ['Copied', 'Texted to', 'Emailed to', 'Shared to'].map((w) => hist.indexOf(w));
    await qa.shot('send history');
    qa.check('after a reload the Send history lists the four sends, newest first', order.every((i) => i >= 0) && order.every((v, i, a) => i === 0 || a[i - 1] < v), hist.slice(0, 300));
    await page.keyboard.press('Escape');
  }, { soft: true });

  await qa.feature('SHARE-003', 'Email a record with real attachments; the file cap; the hourly cap', async () => {
    const d = await openSend();
    await field(d, 'Email').fill(recipient);
    await d.getByRole('button', { name: /Email with attachments \(2\)/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Email with attachments' });
    await sheet.waitFor({ timeout: 10000 });
    // The sheet ticks the record's files a moment after it opens (under load "0 of 2" first).
    await sheet.getByText(/2 of \d+ selected/).first().waitFor({ timeout: 10000 }).catch(() => {});
    const sheetText = await sheet.innerText();
    await qa.shot('email with attachments');
    qa.check('it goes out from CredentialDOMD and replies go to the physician', /via CredentialDOMD/.test(sheetText) && /docs@credentialdomd\.com/.test(sheetText) && sheetText.includes(user.email), sheetText.slice(0, 250));
    qa.check('the recipient and both files are filled in', (await sheet.locator('label', { hasText: /^To$/ }).first().locator('xpath=..').locator('input').inputValue()) === recipient && /2 of \d+ selected/.test(sheetText), sheetText.match(/\d+ of \d+ selected[^\n]*/)?.[0]);
    qa.check('files already uploaded are not labelled "still uploading"', !/still uploading to your account/.test(sheetText), sheetText.match(/[^\n]*still uploading[^\n]*/)?.[0]);
    const since = new Date().toISOString();
    await sheet.getByRole('button', { name: /^Send 2 documents$/ }).click();
    const ok = await sheet.getByText(/Sent to .* with 2 attachments/).waitFor({ timeout: 30000 }).then(() => true, () => false);
    const mail = await waitForEmail({ to: recipient, since }, 30000).catch(() => null);
    const full = mail ? await emailBody(mail.id) : null;
    qa.check('the sheet confirms the send', ok);
    qa.check('the email arrives with both files attached', (full?.attachments || []).length === 2 && files.every((f) => (full.attachments || []).some((a) => a.filename === f)), JSON.stringify((full?.attachments || []).map((a) => a.filename)));
    qa.check('from "<name> via CredentialDOMD <docs@...>", reply-to the physician, a copy to the physician', /via CredentialDOMD/.test(full?.from || '') && JSON.stringify(full?.reply_to || full?.replyTo || '').includes(user.email) && JSON.stringify(full?.cc || '').includes(user.email), `${full?.from} | reply ${JSON.stringify(full?.reply_to || full?.replyTo)} | cc ${JSON.stringify(full?.cc)}`);
    qa.check('a send_reservations row was taken', rows(`select id from public.send_reservations where user_id = '${pid}'`).length >= 1);
    // fd79825a: send-packet-email names the record it was sent from (item_id and the record's own
    // name), so the send shows in that record's history; no more "Email packet (N files)".
    const emailed = shareLog(pid).find((r) => r.method === 'email' && r.recipient === recipient && Date.parse(r.sent_at) >= Date.parse(since) - 1000);
    qa.check('share_log has the server-written send, under the license (its id and name)', !!emailed && emailed.item_id === lic?.id && !!emailed.item_name && !/^Email packet/.test(emailed.item_name), JSON.stringify(emailed));
    await sheet.getByRole('button', { name: 'Done' }).click();
    await page.keyboard.press('Escape');
    const reopened = await openSend();
    const hist = (await reopened.innerText()).split(/Send history/i)[1] || '';
    const listed = (hist.match(/Emailed to/g) || []).length;
    qa.check('the license\'s Send history shows the email with attachments too', listed >= 2, hist.slice(0, 300));
    if (listed < 2) {
      qa.bug({
        title: 'A record emailed "with attachments" never appears in that record\'s Send history',
        step: 'Credentials > Licenses > Send (a license with copies) > Email with attachments > Send; reopen the license\'s Send sheet',
        expected: 'Send history lists "Emailed to <recipient>" for the email that went out with the files',
        actual: `Only the earlier Mail-app entry is listed. send-packet-email writes its share_log row with item_id null and item_name "Email packet (2 files)" (supabase/functions/send-packet-email/index.ts:778-786), and ShareModal's history matches a row by item_id or by the record's own name (src/components/features/ShareModal.jsx:78-80). Fixed on fix/qa-docs-vera-intake and release/qa1 (fd79825a)`,
        severity: 'low',
      });
    }
    await page.keyboard.press('Escape');

    // Over the file cap: nine more documents, then every document ticked.
    const extra = [];
    for (let i = 1; i <= 9; i++) {
      const buffer = syntheticPdf(`QA synthetic extra letter ${i} ${tag}`);
      await scriptAi('gemini', { json: { documentType: 'unknown' } }, base64Marker(buffer));
      extra.push({ name: `qa-extra-${i}-${tag}.pdf`, mimeType: 'application/pdf', buffer });
    }
    await goTab(page, 'Documents');
    await chooseFiles(page, page.getByRole('button', { name: 'Upload' }).first(), extra);
    await waitFor('the nine documents', async () => (rows(`select id from public.documents where user_id = '${pid}' and name like 'qa-extra-%'`).length === 9 ? true : null), { timeoutMs: 90000 }).catch(() => {});
    const d2 = await openSend();
    await d2.getByRole('button', { name: /Email with attachments \(2\)/ }).click();
    await sheet.waitFor({ timeout: 10000 });
    // The document rows (not "CC me"): each is a label holding a checkbox and the file's name.
    const docBoxes = () => sheet.locator('label').filter({ hasText: /\.pdf/ }).locator('input[type=checkbox]');
    for (const box of await docBoxes().all()) if (!(await box.isChecked())) await box.check();
    const capText = await sheet.innerText();
    await qa.shot('over the file cap');
    qa.check('with 11 files ticked the sheet warns about the 10-file cap before sending', /11 of 11 selected/.test(capText) && /up to 10 files and 25 MB per send/.test(capText), capText.match(/\d+ of \d+ selected[^\n]*|Email carries[^\n]*/g)?.join(' / '));
    qa.check('from a record\'s Send sheet there is no whole-packet download (that link belongs to the setup packet)', !(await sheet.getByRole('button', { name: /Download the whole packet/ }).count()));

    // The hourly cap: 30 email sends an hour. The lab records the other 30 of this hour directly.
    labExec(`insert into public.send_reservations (user_id, method, created_at) select '${pid}', 'email', now() from generate_series(1, 30)`);
    for (const box of await docBoxes().all()) if (await box.isChecked()) await box.uncheck();
    await docBoxes().first().check();
    const before = (await emails({ to: recipient })).length;
    await sheet.getByRole('button', { name: /^Send 1 document$/ }).click();
    const refused = await sheet.getByText(/Send limit reached \(30 emails per hour\)/).waitFor({ timeout: 20000 }).then(() => true, () => false);
    await qa.shot('hourly cap');
    qa.check('past the hourly cap the send is refused with a clear message', refused, (await sheet.innerText()).slice(-200));
    qa.check('and nothing is sent', (await emails({ to: recipient })).length === before);
    await sheet.getByRole('button', { name: 'Cancel' }).click().catch(() => {});
    await page.keyboard.press('Escape');
  }, { soft: true });

  await qa.feature('SHARE-004', 'Send three documents as one packet; a clean browser first says they have not downloaded', async () => {
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Documents');
    // This device downloads its copies again after a load; give it a moment, as a physician would.
    await sleep(5000);
    await page.getByRole('button', { name: 'Select to send' }).click();
    const pickNames = [files[0], files[1], `qa-extra-1-${tag}.pdf`];
    // In select mode a tap on a document's card ticks it.
    for (const n of pickNames) await page.getByText(n, { exact: true }).last().click();
    const send = page.getByRole('button', { name: /^Send 3 documents as one packet$/ });
    qa.check('three ticked: "Send 3 documents as one packet"', await send.isVisible().catch(() => false), (await page.getByRole('button', { name: /as one packet/ }).first().innerText().catch(() => '')));
    const shares = (await deviceLog(page)).shared.length;
    await send.click();
    const msg = await page.getByText(/Sent 3 documents as one packet\./).waitFor({ timeout: 15000 }).then(() => true, () => false);
    const log = await deviceLog(page);
    const sheet = log.shared[shares];
    await qa.shot('packet sent');
    qa.check('the share sheet gets the 3 files', (sheet?.files || []).length === 3 && sheet.files.every((f) => f.head === '%PDF-'), JSON.stringify(sheet?.files));
    qa.check('the cover letter is copied and the screen says so', msg && /clipboard/.test(await page.getByText(/Sent 3 documents/).first().innerText()) && (log.clipboard.at(-1) || '').length > 20);
    await sleep(2500);
    const packetRow = shareLog(pid).find((r) => /^Packet \(3 documents\)/.test(r.item_name || ''));
    qa.check('share_log row "Packet (3 documents)", method share', packetRow?.method === 'share' && packetRow?.section === 'documents', JSON.stringify(packetRow));
    qa.check('nothing queued', (await pendingOps(page)).length === 0, JSON.stringify(await pendingOps(page)).slice(0, 200));

    // A clean browser, where the copies are still coming down from Storage.
    const { context: ctx2, page: p2 } = await secondBrowser();
    await installDeviceStandIns(ctx2);
    let release;
    const gate = new Promise((r) => { release = r; });
    await ctx2.route('**/storage/v1/object/**', async (route) => { await gate; await route.continue(); });
    await signIn(p2, user);
    const where = await landing(p2);
    qa.check('the second browser signs in to the member app', where === 'member', where);
    await waitForMemberApp(p2);
    await goTab(p2, 'Documents');
    await p2.getByRole('button', { name: 'Select to send' }).click();
    for (const n of pickNames) await p2.getByText(n, { exact: true }).last().click();
    await p2.getByRole('button', { name: /^Send 3 documents as one packet$/ }).click();
    const notYet = await p2.getByText(/are still downloading to this device\. Send again in a moment\./).waitFor({ timeout: 10000 }).then(() => true, () => false);
    await shot(p2, 'vera-cv-share send clean browser not downloaded');
    qa.check('on a clean browser it says the files have not downloaded yet', notYet, (await p2.locator('body').innerText()).match(/[^\n]*(downloaded|packet)[^\n]*/g)?.join(' / '));
    qa.check('and nothing was shared', ((await deviceLog(p2)).shared || []).length === 0);
    release();
    // After the files land on the device, the same tap works.
    await sleep(6000);
    await p2.getByRole('button', { name: /^Send 3 documents as one packet$/ }).click();
    const sent2 = await p2.getByText(/Sent 3 documents as one packet\./).waitFor({ timeout: 15000 }).then(() => true, () => false);
    const log2 = await deviceLog(p2);
    qa.check('once downloaded, the packet goes to the share sheet with the 3 files', sent2 && (log2.shared.at(-1)?.files || []).length === 3, JSON.stringify(log2.shared.at(-1)?.files));
  }, { soft: true });
});
