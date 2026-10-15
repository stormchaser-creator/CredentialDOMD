// SYNC-019: the member's backup controls, the actual downloaded archive,
// the notification, and another account's inability to obtain the archive.
// Delivery stays in the lab's captured mailbox; no real email or global flag
// is changed. The monthly scheduler itself belongs to OPS-001.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { test, expect } from './support/fixtures.mjs';
import { captureDownload } from './support/browser-completion.mjs';
import {
  createPhysician, emailBody, field, lab, labExec, lit, newMember, openCredentials,
  openMore, restAs, row, tokenFor, waitFor, waitForEmail, waitForMemberApp, waitForProfile,
} from './support/lab.mjs';

async function backupAs(user, backupId) {
  const response = await fetch(`${lab().urls.api}/functions/v1/backup-link`, {
    method: backupId ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${await tokenFor(user, null)}`, 'Content-Type': 'application/json' },
    ...(backupId ? { body: JSON.stringify({ backup_id: backupId }) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, body: await response.json() };
}

async function downloadFromButton(page) {
  const response = page.waitForResponse(r => r.request().method() === 'POST'
    && new URL(r.url()).pathname === '/functions/v1/backup-link', { timeout: 60000 });
  response.catch(() => {});
  const download = await captureDownload(page, () => page.getByRole('button', { name: 'Download', exact: true }).first().click());
  const linked = await response;
  return { download, status: linked.status(), link: await linked.json() };
}

test('monthly backup: preference survives reload, build and download complete, email is safe, account ownership holds', {
  tag: ['@SYNC-019'],
}, async ({ page, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Marin', lastName: 'Monthly' });
  const label = 'QA monthly archive publication';
  const citation = 'Monthly M. A synthetic backup verification. QA Archive Journal. 2026;1:1-2.';

  await qa.feature('SYNC-019', 'Monthly backup preference, archive, signed download and captured email', async () => {
    await openCredentials(page, 'Publications');
    await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    const dialog = page.getByRole('dialog').last();
    await field(dialog, 'Short Label').fill(label);
    await field(dialog, 'Full Citation (as it should read on the CV)').fill(citation);
    await field(dialog, 'Year').fill('2026');
    await dialog.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
    await dialog.waitFor({ state: 'detached' });
    const publication = await waitFor('the saved backup fixture', async () => row(`select id, citation from public.publications where user_id = ${lit(profile.id)} and citation = ${lit(citation)}`), { timeoutMs: 30000 });
    qa.check('the synthetic publication was saved before the backup', !!publication?.id);

    await openMore(page, 'Data & Backup');
    const monthly = page.getByRole('button', { name: 'Monthly backup', exact: true });
    await expect(monthly).toHaveAttribute('aria-pressed', 'true');
    qa.check('a fresh member has monthly backups enabled', true);
    for (const enabled of [false, true]) {
      await monthly.click();
      await expect(monthly).toHaveAttribute('aria-pressed', String(enabled));
      const persisted = await waitFor('the monthly backup preference', async () => row(`select backup_monthly from public.profiles where id = ${lit(profile.id)}`)?.backup_monthly === enabled, { timeoutMs: 30000 }).catch(() => false);
      qa.check(`turning monthly backup ${enabled ? 'on' : 'off'} saves the server preference`, persisted);
      await page.reload();
      await waitForMemberApp(page);
      await openMore(page, 'Data & Backup');
      await expect(monthly).toHaveAttribute('aria-pressed', String(enabled));
      qa.check(`monthly backup stays ${enabled ? 'on' : 'off'} after a reload`, true);
    }

    // A real neighboring row must exist before the archive is generated:
    // otherwise a run of this spec alone cannot detect cross-account export.
    // Only this negative-control fixture uses local setup SQL; the owner's
    // tested record and backup are both created through the app.
    const other = await createPhysician({ firstName: 'Nico', lastName: 'Otherbackup' });
    const otherProfile = await waitForProfile(other.id);
    const otherRecordId = randomUUID();
    const otherCitation = `Synthetic foreign archive sentinel ${otherRecordId}`;
    labExec(`insert into public.publications (id, user_id, name, citation, year) values (${lit(otherRecordId)}, ${lit(otherProfile.id)}, 'Other account only', ${lit(otherCitation)}, '2026')`);
    qa.check('a different account has a persisted source row before this backup', row(`select user_id from public.publications where id = ${lit(otherRecordId)}`)?.user_id === otherProfile.id);

    const startedAt = new Date().toISOString();
    await page.getByRole('button', { name: 'Build a backup now', exact: true }).click();
    await page.getByText(/Backup ready:/).first().waitFor({ timeout: 120000 });
    const backup = await waitFor('the completed member backup', async () => row(`select id, period, status, bytes, record_count, document_count, skipped_documents, emailed_at from public.backups where user_id = ${lit(profile.id)} and created_at >= ${lit(startedAt)}::timestamptz order by created_at desc limit 1`), { timeoutMs: 60000 });
    qa.check('Build now creates a completed nonempty archive for this account', ['ready', 'emailed'].includes(backup.status) && backup.bytes > 0 && backup.record_count > 0);
    qa.check('the archive reports no skipped documents', backup.skipped_documents === 0);
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(1);
    qa.check('the new archive is listed with a Download action', true);
    await qa.shot('monthly backup ready and preference enabled');

    const linkStarted = Date.now();
    const downloaded = await downloadFromButton(page);
    qa.check('Download obtains a fresh signed link successfully', downloaded.status === 200);
    const url = new URL(downloaded.link.url);
    const lifetime = new Date(downloaded.link.expires_at).getTime() - linkStarted;
    const token = JSON.parse(Buffer.from(url.searchParams.get('token').split('.')[1], 'base64url').toString('utf8'));
    qa.check('the signed link addresses this member\'s private backup', decodeURIComponent(url.pathname).startsWith(`/storage/v1/object/sign/backups/${user.id}/`) && !url.pathname.includes('..'));
    qa.check('the signed token lasts 15 minutes and the response expiry agrees', token.exp - token.iat === 900 && lifetime >= 895000 && lifetime <= 930000 && Math.abs(token.exp * 1000 - new Date(downloaded.link.expires_at).getTime()) <= 2000);
    qa.check('the downloaded file is a ZIP', /\.zip$/i.test(downloaded.download.suggestedFilename()));
    qa.check('the browser download completed without an error', await downloaded.download.failure() === null);
    const zip = await JSZip.loadAsync(await readFile(await downloaded.download.path()));
    qa.check('the archive contains README, full JSON, and this section\'s CSV', !!zip.file('README.html') && !!zip.file('data/backup.json') && !!zip.file('data/publications.csv'));
    const snapshot = JSON.parse(await zip.file('data/backup.json').async('string'));
    const csv = await zip.file('data/publications.csv').async('string');
    const readme = await zip.file('README.html').async('string');
    qa.check('JSON preserves the entered publication and exact server record id', snapshot.data?.publications?.some(record => record.id === publication.id && record.citation === citation));
    qa.check('the spreadsheet copy contains the publication citation', csv.includes(citation));
    qa.check('the README identifies CredentialDOMD and explains the JSON copy', readme.includes('CredentialDOMD') && readme.includes('data/backup.json'));
    qa.check('archive metadata agrees with the listed record and document counts', snapshot.record_count === backup.record_count && (snapshot.data?.documents?.length || 0) === backup.document_count);
    qa.check('archive profile and every data row belong to the requesting member', snapshot.profile?.id === profile.id && snapshot.profile?.auth_user_id === user.id && Object.values(snapshot.data || {}).flat().every(record => record.user_id === profile.id));
    qa.check('the existing other-account record is absent from JSON and CSV', !JSON.stringify(snapshot).includes(otherRecordId) && !JSON.stringify(snapshot).includes(otherCitation) && !csv.includes(otherRecordId) && !csv.includes(otherCitation));

    const month = new Date(`${backup.period}-01T00:00:00.000Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const mail = await waitForEmail({ to: user.email, subject: `Your CredentialDOMD backup for ${month}`, since: startedAt });
    const body = await emailBody(mail.id);
    const text = body.text || '';
    const emailUrls = text.match(/https?:\/\/\S+/g) || [];
    const recipients = Array.isArray(body.to) ? body.to : [body.to];
    const sectionCount = Object.values(snapshot.counts || {}).filter(count => count > 0).length;
    qa.check('the captured email is addressed only to the member and names the right month', recipients.length === 1 && recipients[0] === user.email && !(body.cc || []).length && !(body.bcc || []).length && body.subject === `Your CredentialDOMD backup for ${month}`);
    qa.check('plain-text formatting has greeting, paragraphs and readable indented contents', /^Hi Marin,\n\n/.test(text) && text.includes('\n\nWhat is inside:\n  ') && text.includes('\n\nWhere to get it:\n  Open ') && !/<(?:html|body|p|br)\b|undefined|\[object Object\]/i.test(text));
    qa.check('email counts match the archive', text.includes(`${backup.record_count.toLocaleString('en-US')} record`) && text.includes(`across ${sectionCount.toLocaleString('en-US')} section`) && text.includes(`${backup.document_count.toLocaleString('en-US')} document`));
    qa.check('the email carries only the app page link and no file token or attachment', emailUrls.length === 1 && emailUrls[0] === 'https://credentialdomd.com/app/#backups' && !/token=|\/storage\/v1\/|\.zip\b/i.test(text) && !(body.attachments || []).length);
    qa.check('the email explains signed-in access, 15-minute links and how to stop monthly backups', text.includes('Downloads happen only from your signed-in account') && text.includes('15 minutes') && text.includes('turn Monthly backup off'));
    qa.check('the backup row records that its notification was sent', !!row(`select emailed_at from public.backups where id = ${lit(backup.id)}`)?.emailed_at);

    await page.goto(`${lab().urls.mock}/qa/inbox?${new URLSearchParams({ id: mail.id, to: user.email })}`);
    await expect(page.locator('.detail pre')).toBeVisible();
    qa.check('the lab mailbox displays the complete plain-text message', await page.locator('.detail pre').textContent() === text);
    await qa.shot('monthly backup captured plain-text email');

    // Follow the exact email path and hash on the lab app origin, never the
    // public deployment. This checks the app's deep link after a reload.
    const emailLink = new URL(emailUrls[0]);
    await page.goto(`${lab().urls.appOrigin}${emailLink.pathname}${emailLink.hash}`);
    await waitForMemberApp(page);
    await expect(page.getByRole('heading', { name: 'Data & Backup', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(1);
    qa.check('the notification link opens the signed-in backup history', true);

    const ownList = await backupAs(user);
    const otherList = await backupAs(other);
    const otherRow = await restAs(other, `backups?select=id&id=eq.${backup.id}`);
    const denied = await backupAs(other, backup.id);
    qa.check('the owner can list the backup through the authenticated endpoint', ownList.status === 200 && ownList.body.backups?.some(item => item.id === backup.id));
    qa.check('another account cannot list the archive through the endpoint or database', otherList.status === 200 && !otherList.body.backups?.some(item => item.id === backup.id) && otherRow.status === 200 && Array.isArray(otherRow.data) && otherRow.data.length === 0);
    qa.check('another account requesting the exact archive id gets 403 and no file link', denied.status === 403 && !denied.body.url && denied.body.error === 'That backup is not in your account');
  });
});
