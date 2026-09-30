// Credentials journeys: hospital privileges with a portal password encrypted
// under a device lock code (read on a second browser with the same code),
// education records (sorting, the CV, star, delete) and a professional photo
// (image attached, offered with the record when it is sent).
import { test } from './support/fixtures.mjs';
import {
  chooseFiles, goTab, landing, newMember, openCredentials, openMore, pendingOps, recordButtons, row, rows, signIn, sleep,
  syncWarnings, syntheticPdf, syntheticPng, tombstones, waitForMemberApp,
} from './support/lab.mjs';
import { allowClipboard, clipboardText, day, dbWait, fillField, fillForm, openAdd, saveDialog } from './support/cred-helpers.mjs';

const PASSWORD = 'QaPortal-Pass-7731';
const LOCK = 'qa-lock-4417';

test('privileges keep an encrypted portal password; education and a professional photo', {
  tag: ['@CRED-004', '@CRED-018', '@CRED-038'],
}, async ({ page, context, qa, secondBrowser }) => {
  test.setTimeout(12 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Priya', lastName: 'Privileges' });
  const pid = profile.id;
  await allowClipboard(context);

  // Native prompts (the lock code on a new device) are answered from this queue, in order.
  const promptAnswers = [];
  const prompts = [];
  qa.onDialog(async (d) => {
    if (d.type() === 'prompt') {
      prompts.push(d.message());
      const a = promptAnswers.shift();
      if (a == null) return 'dismiss';
      await d.accept(a);
    }
    return 'accept';
  });

  await qa.feature('CRED-004', 'Privilege with a portal password: encrypted with a lock code, shown on demand, read on a second browser', async () => {
    const sent = [];
    const onRequest = (r) => { if ((r.postData() || '').includes(PASSWORD)) sent.push(`${r.method()} ${new URL(r.url()).pathname}`); };
    page.on('request', onRequest);
    const consoleMark = qa.report.console.length;

    // A privilege with no date and neither "not yet known" nor pending is refused.
    let dlg = await openAdd(page, 'Privileges');
    await fillForm(dlg, [['Type', { index: 1 }], ['Display Name', 'QA Undated Privileges'], ['Facility', 'QA Undated Hospital']]);
    let res = await saveDialog(dlg, { timeout: 3000 });
    qa.check('a privilege with no Reappointment Due, not "not yet known" and not pending is refused', !res.closed && /Required:.*Reappointment Due/.test(res.refusal), res.refusal);
    qa.check('the refused privilege is not saved', !row(`select id from public.privileges where user_id = '${pid}' and facility = 'QA Undated Hospital'`));
    // "Not yet known" makes the same record acceptable.
    await dlg.getByRole('checkbox', { name: /date not yet known/ }).check();
    res = await saveDialog(dlg);
    qa.check('ticking "Reappointment date not yet known" lets it save', res.closed, res.refusal);
    const undated = await dbWait('the undated privilege', () => row(`select date_unknown, expiration_date from public.privileges where user_id = '${pid}' and facility = 'QA Undated Hospital'`));
    qa.check('saved with date_unknown and no date', undated?.date_unknown === true && !undated.expiration_date, undated);

    // The real one, with a portal login.
    dlg = await openAdd(page, 'Privileges');
    await fillForm(dlg, [
      ['Type', { index: 1 }], ['Display Name', 'QA Summit Privileges'], ['Facility', 'QA Summit Medical Center'], ['City', 'Denver'], ['State', { label: 'CO' }],
      ['Appointed', day(-200)], [/^Reappointment Due/, day(500)], ['Credentialing / portal URL', 'medstaff.qa.credentialdomd.test'],
      ['Portal username', 'qa.summit.user'], ['Portal password', PASSWORD],
    ]);
    const lockBox = dlg.getByPlaceholder('Lock code (4+ characters)');
    qa.check('typing a password asks for a lock code on this device', await lockBox.isVisible(), (await dlg.innerText()).match(/Set a lock code[^\n]*/)?.[0]);
    await lockBox.fill('abc');
    res = await saveDialog(dlg, { timeout: 3000 });
    const short = (await dlg.innerText().catch(() => '')).match(/Set a lock code of at least 4[^\n]*/)?.[0];
    qa.check('a 3-character lock code is refused with a reason', !res.closed && !!short, short || res.refusal);
    await lockBox.fill(LOCK);
    await qa.shot('privilege form with lock code');
    res = await saveDialog(dlg);
    qa.check('the privilege saves with a 4+ character lock code', res.closed, res.refusal);
    await sleep(2500);
    const priv = await dbWait('the privilege row', () => row(`select id, facility, appointment_date, expiration_date, portal_url, login_username, left(login_secret, 5) as prefix, login_secret from public.privileges where user_id = '${pid}' and facility = 'QA Summit Medical Center'`));
    qa.check('privileges row with facility, dates, portal URL and username', priv?.appointment_date === day(-200) && priv.expiration_date === day(500) && /medstaff\.qa/.test(priv.portal_url || '') && priv.login_username === 'qa.summit.user', priv && { ...priv, login_secret: undefined });
    qa.check('login_secret is ciphertext ("enc1:"), never the password', priv?.prefix === 'enc1:' && !String(priv.login_secret).includes(PASSWORD), priv?.prefix);
    qa.check('no request carried the password in the clear', sent.length === 0, sent.join(', '));
    qa.check('no sync warning, nothing queued', syncWarnings(qa.report, consoleMark).length === 0 && (await pendingOps(page)).length === 0, syncWarnings(qa.report, consoleMark).join(' | '));
    const lockOnDevice = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('credentialdomd-keys:')).map(([, v]) => { try { return !!JSON.parse(v).lockCode; } catch { return false; } }).some(Boolean));
    qa.check('the lock code is kept in this device\'s key slot', lockOnDevice);

    // Open it: masked, Show, Copy, Hide.
    await page.getByText('QA Summit Medical Center').first().click();
    const view = page.getByRole('dialog').filter({ hasText: 'Portal password' }).last();
    await view.waitFor({ timeout: 15000 });
    const masked = await view.innerText();
    qa.check('the detail view shows the password masked', masked.includes('••••') && !masked.includes(PASSWORD));
    await view.getByRole('button', { name: 'Show', exact: true }).click();
    const shown = await view.getByText(PASSWORD).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('Show reveals the password on this device without asking (lock code remembered)', shown && prompts.length === 0, `prompts: ${prompts.length}`);
    await view.getByRole('button', { name: 'Copy', exact: true }).click();
    await sleep(500);
    qa.check('Copy puts the password on the clipboard', (await clipboardText(page)) === PASSWORD);
    await view.getByRole('button', { name: 'Hide', exact: true }).click();
    qa.check('Hide masks it again', !(await view.innerText()).includes(PASSWORD));
    await page.keyboard.press('Escape');
    page.off('request', onRequest);

    // A second browser: the ciphertext synced, the lock code did not.
    const other = await secondBrowser();
    await allowClipboard(other.context);
    await signIn(other.page, user);
    qa.check('the second browser opens the member app', (await landing(other.page)) === 'member');
    await openCredentials(other.page, 'Privileges');
    await other.page.getByText('QA Summit Medical Center').first().click();
    const view2 = other.page.getByRole('dialog').filter({ hasText: 'Portal password' }).last();
    await view2.waitFor({ timeout: 15000 });
    const alertsBefore = qa.report.dialogs.length;
    promptAnswers.push('wrong-code-9');
    await view2.getByRole('button', { name: 'Show', exact: true }).click();
    await sleep(3000);
    const asked = prompts.at(-1) || '';
    const wrong = qa.report.dialogs.slice(alertsBefore).find((x) => /^alert:/.test(x)) || '';
    qa.check('a new device asks for the lock code', /lock code/i.test(asked), asked);
    qa.check('a wrong lock code says so', /did not open this password/.test(wrong), wrong);
    qa.check('the wrong code reveals nothing', !(await view2.innerText()).includes(PASSWORD));
    promptAnswers.push(LOCK);
    await view2.getByRole('button', { name: 'Show', exact: true }).click();
    const opened = await view2.getByText(PASSWORD).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    await other.page.screenshot({ path: (await qa.shot('second browser password shown')).replace(/\.png$/, '-b.png') });
    qa.check('the same lock code opens it on the second browser', opened);
    await other.page.keyboard.press('Escape');
  }, { soft: true });

  await qa.feature('CRED-018', 'Education: add with a diploma, sorted newest first, on the CV, edit honors, star, delete', async () => {
    const consoleMark = qa.report.console.length;
    // Older degree first, so the sort has something to do.
    let dlg = await openAdd(page, 'Education');
    await fillForm(dlg, [['Type', 'Bachelor of Science (BS)'], ['Display Name', 'QA BS Biology'], ['Institution', 'QA State College'],
      ['Start Date', '2006-08-20'], ['Graduation / End Date', '2010-05-15'], ['Field of Study / Specialty', 'Biology']]);
    let res = await saveDialog(dlg);
    qa.check('the first degree saves', res.closed, res.refusal);

    dlg = await openAdd(page, 'Education');
    await fillForm(dlg, [['Type', 'Doctor of Medicine (MD)'], ['Display Name', 'QA MD Diploma'], ['Institution', 'QA University School of Medicine'],
      ['Start Date', '2010-08-01'], ['Graduation / End Date', '2014-05-20'], ['Field of Study / Specialty', 'Medicine'], ['Honors', 'Alpha Omega Alpha']]);
    await chooseFiles(page, dlg.getByRole('button', { name: 'Upload' }), [{ name: 'qa-md-diploma.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('QA synthetic MD diploma') }]);
    await dlg.getByText('qa-md-diploma.pdf').first().waitFor({ timeout: 30000 });
    await dlg.getByText(/Scanning document/).waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    res = await saveDialog(dlg);
    qa.check('the MD diploma record saves', res.closed, res.refusal);
    await sleep(2500);
    const md = await dbWait('the education row', () => row(`select id, type, institution, start_date, graduation_date, field_of_study, honors from public.education where user_id = '${pid}' and institution = 'QA University School of Medicine'`));
    qa.check('education row with type, institution, start, graduation, field and honors', md?.type === 'Doctor of Medicine (MD)' && md.start_date === '2010-08-01' && md.graduation_date === '2014-05-20' && md.field_of_study === 'Medicine' && md.honors === 'Alpha Omega Alpha', md);
    const diploma = md ? await dbWait('the diploma document', () => row(`select name, linked_to, storage_path from public.documents where user_id = '${pid}' and linked_to = 'education:${md.id}'`), 30000) : null;
    qa.check('the diploma is stored and linked to the record (education:<id>)', !!diploma?.storage_path, diploma);
    qa.check('no sync warning, nothing queued', syncWarnings(qa.report, consoleMark).length === 0 && (await pendingOps(page)).length === 0, syncWarnings(qa.report, consoleMark).join(' | '));

    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'Education');
    const body = await page.locator('main, body').first().innerText();
    const iMd = body.indexOf('QA University School of Medicine');
    const iBs = body.indexOf('QA State College');
    qa.check('both survive a reload, the newest graduation listed first', iMd >= 0 && iBs >= 0 && iMd < iBs, `MD at ${iMd}, BS at ${iBs}`);
    await qa.shot('education list');

    await openMore(page, 'Generate CV');
    await page.getByText(/CV Generator/).first().waitFor({ timeout: 15000 });
    const cv = await page.locator('main, body').first().innerText();
    qa.check('the CV lists the degree, its institution and honors', /QA University School of Medicine/.test(cv) && /Alpha Omega Alpha/.test(cv), cv.match(/Education[\s\S]{0,300}/)?.[0]);
    await qa.shot('cv education');

    // Edit honors.
    await openCredentials(page, 'Education');
    await recordButtons(page, 'QA University School of Medicine').edit.click();
    const edit = page.getByRole('dialog', { name: 'Edit' });
    await edit.waitFor();
    await fillField(edit, 'Honors', 'Alpha Omega Alpha; Gold Humanism');
    await saveDialog(edit);
    await sleep(2000);
    await page.reload();
    await waitForMemberApp(page);
    qa.check('the honors edit is in the database after a reload', row(`select honors from public.education where id = '${md?.id}'`)?.honors === 'Alpha Omega Alpha; Gold Humanism');
    await openCredentials(page, 'Education');
    qa.check('and on the card list', /Gold Humanism|QA University School of Medicine/.test(await page.locator('main, body').first().innerText()));

    // Star.
    await recordButtons(page, 'QA University School of Medicine').star.click();
    await sleep(2000);
    qa.check('the star is saved (education.favorite)', row(`select favorite from public.education where id = '${md?.id}'`)?.favorite === true);

    // Delete.
    await recordButtons(page, 'QA University School of Medicine').remove.click();
    await sleep(2500);
    qa.check('the row is deleted and tombstoned', !row(`select id from public.education where id = '${md?.id}'`) && tombstones(pid).some((t) => t.item_id === md?.id));
    qa.check('its diploma goes with it', !row(`select id from public.documents where linked_to = 'education:${md?.id}'`));
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'Education');
    qa.check('it stays deleted after a reload', !/QA University School of Medicine/.test(await page.locator('main, body').first().innerText()));

  }, { soft: true });

  await qa.feature('CRED-038', 'Professional photo: dated headshot with its image, offered with the record when it is sent, edit, delete', async () => {
    const consoleMark = qa.report.console.length;
    const dlg = await openAdd(page, 'Professional Photo');
    await fillForm(dlg, [['Label', 'QA professional headshot'], ['Date Taken', day(-60)]]);
    await chooseFiles(page, dlg.getByRole('button', { name: 'Upload' }), [{ name: 'qa-headshot.png', mimeType: 'image/png', buffer: syntheticPng() }]);
    await dlg.getByText('qa-headshot.png').first().waitFor({ timeout: 30000 });
    await dlg.getByText(/Scanning document/).waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    let res = await saveDialog(dlg);
    qa.check('the headshot record saves', res.closed, res.refusal);
    await sleep(2500);
    const ph = await dbWait('the photo row', () => row(`select id, name, date_taken from public.professional_photos where user_id = '${pid}'`));
    qa.check('professional_photos row with the label and Date Taken', ph?.name === 'QA professional headshot' && ph.date_taken === day(-60), ph);
    const img = ph ? await dbWait('the image document', () => row(`select id, name, type, linked_to, storage_path from public.documents where user_id = '${pid}' and linked_to = 'professionalPhotos:${ph.id}'`), 30000) : null;
    qa.check('the image is a documents row linked to the photo record, its bytes in Storage', !!img?.storage_path && !!row(`select 1 as x from storage.objects where bucket_id = 'documents' and name = '${img?.storage_path}'`), img);
    qa.check('no sync warning, nothing queued', syncWarnings(qa.report, consoleMark).length === 0 && (await pendingOps(page)).length === 0, syncWarnings(qa.report, consoleMark).join(' | '));

    await openCredentials(page, 'Professional Photo');
    await page.getByText('QA professional headshot').first().click();
    const view = page.getByRole('dialog').filter({ hasText: 'Date Taken' }).last();
    await view.waitFor({ timeout: 15000 });
    const hasImage = await view.locator('img').first().isVisible().catch(() => false);
    await qa.shot('headshot detail');
    qa.check('the record opens with its image', hasImage);
    await page.keyboard.press('Escape');

    // Sent with the record: the Send sheet lists the image as a linked document.
    await recordButtons(page, 'QA professional headshot').share.click();
    const send = page.getByRole('dialog', { name: 'Send Credential' });
    await send.waitFor({ timeout: 15000 });
    const sendText = await send.innerText();
    qa.check('Send lists the headshot image as a linked document (it rides along in packets)', /Linked Documents \(1\)/i.test(sendText) && /qa-headshot\.png/.test(sendText), sendText.slice(0, 300));
    await page.keyboard.press('Escape');

    // Edit, reload, delete.
    await recordButtons(page, 'QA professional headshot').edit.click();
    const edit = page.getByRole('dialog', { name: 'Edit' });
    await edit.waitFor();
    await fillField(edit, 'Label', 'QA professional headshot 2026');
    res = await saveDialog(edit);
    await sleep(2000);
    await page.reload();
    await waitForMemberApp(page);
    qa.check('the edit is saved', row(`select name from public.professional_photos where id = '${ph?.id}'`)?.name === 'QA professional headshot 2026');
    await openCredentials(page, 'Professional Photo');
    await recordButtons(page, 'QA professional headshot 2026').remove.click();
    await sleep(2500);
    qa.check('deleting removes the row and tombstones it', !row(`select id from public.professional_photos where id = '${ph?.id}'`) && tombstones(pid).some((t) => t.item_id === ph?.id));
    qa.check('its image goes with it', !row(`select id from public.documents where id = '${img?.id}'`));
    const leftover = rows(`select id from public.professional_photos where user_id = '${pid}'`);
    qa.check('no photo records remain', leftover.length === 0, leftover);
    await goTab(page, 'Documents');
    qa.check('Documents no longer lists the headshot', !/qa-headshot\.png/.test(await page.locator('main, body').first().innerText()));
  }, { soft: true });

  // Last, because the refused record stays queued on this device and would show up in later checks.
  await qa.feature('CRED-018', 'A degree saved without choosing a Type', async () => {
    let dlg; let res;
    const mark2 = qa.report.console.length;
    dlg = await openAdd(page, 'Education');
    await fillForm(dlg, [['Display Name', 'QA Untyped Certificate'], ['Institution', 'QA Untyped Institute'], ['Graduation / End Date', '2016-06-30']]);
    res = await saveDialog(dlg);
    await sleep(3000);
    const untyped = row(`select id from public.education where user_id = '${pid}' and institution = 'QA Untyped Institute'`);
    const warn = syncWarnings(qa.report, mark2);
    qa.check('an education record saved without a Type reaches the cloud (or the form asks for the Type)', !res.closed || !!untyped, `form closed: ${res.closed}; row: ${!!untyped}; ${warn.join(' | ').slice(0, 200)}`);
    if (res.closed && !untyped) {
      qa.bug({
        title: 'Education: a record saved without a Type is accepted by the form but refused by the database, so it lives on one device',
        step: 'Credentials > Education > Add; fill Display Name, Institution, Graduation; leave Type blank; Add',
        expected: 'The form requires Type (education.type is NOT NULL), or the record reaches the cloud',
        actual: `The form closes and the card shows, but no education row exists; the console says ${warn[0] || 'nothing'}; it is queued for a replay that cannot succeed. The Type field has no required flag (src/App.jsx:2325). Fixed on fix/qa-cloud-writes (074d3ff6)`,
        severity: 'medium',
      });
    }
  }, { soft: true });
});
