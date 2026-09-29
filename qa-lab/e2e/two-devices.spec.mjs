// Two-device journeys: a delete made on one browser stays deleted on another
// that held a stale copy while offline (no zombie re-upload), and Delete All
// My Data on one browser wipes the account, after which the other browser
// drops its stale cache instead of re-uploading it.
import { test } from './support/fixtures.mjs';
import {
  field, landing, newMember, openCredentials, openMore, profileOf, recordButtons, row, rows, signIn, sleep, tombstones, waitFor, waitForMemberApp,
} from './support/lab.mjs';

async function addPublication(page, label, citation) {
  await openCredentials(page, 'Publications');
  await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
  const dlg = page.getByRole('dialog').last();
  await field(dlg, 'Short Label').fill(label);
  await field(dlg, 'Full Citation (as it should read on the CV)').fill(citation);
  await field(dlg, 'Year').fill('2024');
  await dlg.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
  await dlg.waitFor({ state: 'detached', timeout: 15000 });
}

test('a delete on device A stays deleted on device B that was offline with a stale copy', { tag: ['@SYNC-011'] }, async ({ page, qa, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Avery', lastName: 'Devices' });
  await addPublication(page, 'QA zombie check paper', 'Devices A. A synthetic zombie study. QA Journal. 2024;1:1.');
  await sleep(2500);
  const pub = row(`select id from public.publications where user_id = '${profile.id}'`);

  await qa.feature('SYNC-011', 'Delete on A while B is offline; B reconnects and reloads', async () => {
    const b = await secondBrowser();
    await signIn(b.page, user);
    await landing(b.page);
    await openCredentials(b.page, 'Publications');
    qa.check('B shows the publication', /QA zombie check paper/.test(await b.page.locator('body').innerText()));
    await b.context.setOffline(true);
    await openCredentials(page, 'Publications');
    await recordButtons(page, 'QA zombie check paper').remove.click();
    await sleep(2500);
    qa.check('A deleted it: row gone and tombstoned', !row(`select id from public.publications where id = '${pub.id}'`) && tombstones(profile.id).some((t) => t.item_id === pub.id));
    await b.context.setOffline(false);
    await b.page.reload();
    await waitForMemberApp(b.page);
    await sleep(4000);
    await openCredentials(b.page, 'Publications');
    await b.page.screenshot({ path: (await qa.shot('device B after reconnect')).replace(/\.png$/, '-B.png') });
    qa.check('B no longer shows it', !/QA zombie check paper/.test(await b.page.locator('body').innerText()));
    await sleep(2000);
    qa.check('B did not re-upload it (no zombie row)', !row(`select id from public.publications where id = '${pub.id}'`));
    const zombies = rows(`select t.id from public.publications t join public.deleted_items d on d.item_id = t.id where t.user_id = '${profile.id}'`);
    qa.check('no row whose id is also tombstoned', zombies.length === 0, zombies);
  });
});

test('Delete All My Data wipes the account; the other device drops its stale cache', { tag: ['@SETTINGS-005', '@SYNC-012'] }, async ({ page, qa, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Wren', lastName: 'Wipe' });
  await addPublication(page, 'QA wipe paper', 'Wipe W. A synthetic study to delete. QA Journal. 2024;2:3.');
  await sleep(2500);
  const b = await secondBrowser();
  await signIn(b.page, user);
  await landing(b.page);
  await openCredentials(b.page, 'Publications');
  qa.check('B has the record in its cache', /QA wipe paper/.test(await b.page.locator('body').innerText()));

  await qa.feature('SETTINGS-005', 'Delete All My Data (typed DELETE)', async () => {
    await openMore(page, 'Data Rights');
    await page.getByRole('button', { name: 'Delete All My Data' }).click();
    const confirm = page.getByRole('button', { name: 'Confirm Delete' });
    await page.getByPlaceholder('Type DELETE').fill('delete');
    qa.check('"Confirm Delete" stays disabled until DELETE is typed exactly', await confirm.isDisabled());
    await page.getByPlaceholder('Type DELETE').fill('DELETE');
    await confirm.click();
    const out = await waitFor('the account deletion', async () => row(`select mode, counts from public.account_deletions where profile_id = '${profile.id}'`), { timeoutMs: 60000 }).catch(() => null);
    await sleep(3000);
    await qa.shot('after delete all');
    qa.check('account_deletions records it', !!out, out ? JSON.stringify(out).slice(0, 160) : 'none');
    qa.check('the publication row is gone', rows(`select id from public.publications where user_id = '${profile.id}'`).length === 0);
    const p = profileOf(user.id);
    // The checklist expects backup_monthly and ack_requests reset to true (what the client pass
    // writes); the server pass (delete-account PROFILE_TOMBSTONE_PATCH) then sets both to false
    // on purpose: an emptied account must get no monthly archive and acknowledge no request.
    qa.check('profile marked deleted; the NOT NULL opt-outs end off (server tombstone design)', !!p?.deleted_at && p.backup_monthly === false && p.ack_requests === false && !p.name && !p.email, JSON.stringify({ deleted_at: p?.deleted_at, backup_monthly: p?.backup_monthly, ack_requests: p?.ack_requests, name: p?.name, email: p?.email }));
    const objects = row(`select count(*)::int as n from storage.objects where bucket_id = 'documents' and name like '${user.id}/%'`);
    qa.check('no storage objects left for the account', objects.n === 0, `${objects.n}`);
    await sleep(5000);
    let text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const signedOut = (await page.getByTestId('qa-signin').count()) > 0;
    qa.check('the app signs out after the deletion (checklist: "signed out")', signedOut, signedOut ? 'sign-in page' : text.slice(0, 160));
    // Data Rights says the sign-in account stays (closing it needs an email to support): sign in again.
    if (signedOut) await signIn(page, user);
    else await page.reload();
    await sleep(8000);
    text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const shot = await qa.shot('after delete all, same account');
    const usable = /Credentials/.test(text) && !/could not be verified/.test(text);
    const sub = row(`select status, membership_active from public.billing_subscriptions where profile_id = '${profile.id}'`);
    qa.check('the same sign-in, on its next load, opens an empty account, as the Data Rights text implies', usable, text.slice(0, 200));
    if (!usable) {
      qa.bug({
        title: 'After "Delete All My Data" the account dead-ends on "identity could not be verified … your existing records have not changed", and the paid subscription keeps billing',
        step: 'More > Data Rights > Delete All My Data > type DELETE > Confirm Delete (then reload or sign in again, on this or another browser)',
        expected: 'Signed out, and afterwards the sign-in account still opens with an empty file (Data Rights: "To close the sign-in account itself, email support"), or a clear "this account was deleted" screen that also handles the membership',
        actual: `The app is not signed out; it and every later sign-in show "${(text.match(/Your account identity could not be verified.*?H409\./) || [text.slice(0, 160)])[0]}" (initialize-clerk-profile -> account_unavailable, because profiles.deleted_at makes account_is_closed true). "Try again" cannot help and "records have not changed" is false. billing_subscriptions stays ${sub?.status} (membership_active ${sub?.membership_active}); the Stripe subscription is not cancelled.`,
        severity: 'high', screenshot: shot,
      });
    }
  });

  await qa.feature('SYNC-012', 'The other device drops its stale copy and re-uploads nothing', async () => {
    await b.page.reload();
    const where = await landing(b.page);
    await sleep(4000);
    if (where === 'member') await openCredentials(b.page, 'Publications');
    await b.page.screenshot({ path: (await qa.shot('device B after wipe')).replace(/\.png$/, '-B.png') });
    qa.check('B no longer shows the deleted record', !/QA wipe paper/.test(await b.page.locator('body').innerText()), `B landed on: ${where}`);
    await sleep(2000);
    qa.check('B re-uploaded nothing', rows(`select id from public.publications where user_id = '${profile.id}'`).length === 0);
  });
});
