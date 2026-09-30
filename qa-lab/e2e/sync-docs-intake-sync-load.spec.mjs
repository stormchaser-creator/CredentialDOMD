// Sync journeys about loading and replaying a member's records:
//   * SYNC-004  a collection read that fails shows "Your records haven't
//               finished loading" with Try again, never an empty account;
//   * SYNC-006  a save refused while the membership is re-checked keeps the
//               form, its values and its file; after reconnecting one record
//               and one linked file are saved;
//   * SYNC-009  an add that never reached the cloud, then edited once the
//               network is back, keeps the edit through the replay;
//   * SYNC-010  a record that exists only on this device (its queue lost) is
//               pushed up on the next load, and the deletion ledger is
//               respected even when it cannot be read.
// Network trouble is made in the browser only (a route that fails the app's
// own request, as a dropped connection would); the lab is never touched.
import { test } from './support/fixtures.mjs';
import {
  field, landing, newMember, openCredentials, pendingOps, recordButtons, row, rows, signIn, sleep, syntheticPdf, tombstones, waitFor, waitForMemberApp,
} from './support/lab.mjs';
import { blockRequests, isFunction, isRest, pageText } from './support/sync-docs-intake-helpers.mjs';

async function addPublication(page, label) {
  await openCredentials(page, 'Publications');
  await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
  const d = page.getByRole('dialog').last();
  await field(d, 'Short Label').fill(label);
  await field(d, 'Full Citation (as it should read on the CV)').fill(`Loader L. ${label}. QA Journal. 2025;3:4.`);
  await d.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
  await d.waitFor({ state: 'detached', timeout: 15000 });
}

test('records that fail to load: a clear screen with Try again, never an empty account', { tag: ['@SYNC-004'] }, async ({ page, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Lara', lastName: 'Loadfail' });
  await addPublication(page, 'QA load-gate paper');
  await sleep(2500);
  qa.check('the publication is saved before the test', !!row(`select id from public.publications where user_id = '${profile.id}'`));

  await qa.feature('SYNC-004', 'One collection read fails: the records-load screen, Try again, then the account', async () => {
    // Every read of one collection fails (the publications GET), as a flaky connection would.
    const unblock = await blockRequests(page, (u, m) => m === 'GET' && isRest(u, 'publications'));
    await page.reload();
    const screen = page.getByRole('alert').filter({ hasText: /haven't finished loading/ });
    const shown = await screen.waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('records failed to load');
    const text = await pageText(page);
    qa.check('"Your records haven\'t finished loading" is shown', shown, text.slice(0, 200));
    qa.check('it asks not to re-enter or re-upload anything', /Please don't re-enter or re-upload them/.test(text));
    qa.check('it offers Try again and a support reference', await page.getByRole('button', { name: 'Try again' }).isVisible().catch(() => false) && /DATA-LOAD-UNAVAILABLE/.test(text));
    qa.check('no empty account is shown behind it (no Credentials navigation, no "No publications")', !(await page.getByRole('button', { name: /^Credentials$/ }).count()) && !/No publications/.test(text));
    // Try again while the read still fails: the same screen, nothing lost.
    await page.getByRole('button', { name: 'Try again' }).click();
    const again = await screen.waitFor({ timeout: 60000 }).then(() => true, () => false);
    qa.check('Try again while it still fails shows the same screen', again);
    qa.check('nothing was deleted on the server meanwhile', !!row(`select id from public.publications where user_id = '${profile.id}'`));
    const report = row(`select count(*)::int as n from public.client_errors where (auth_user_id = '${user.id}' or profile_id = '${profile.id}') and message like '%DATA-LOAD-UNAVAILABLE%'`);
    qa.check('the app reports the stop with its fixed reference (client_errors)', (report?.n || 0) > 0, `${report?.n} report(s)`);
    await unblock();
    await page.getByRole('button', { name: 'Try again' }).click();
    await waitForMemberApp(page);
    await openCredentials(page, 'Publications');
    qa.check('once the read works, Try again loads every record', /QA load-gate paper/.test(await pageText(page)));
  });

  await qa.feature('SYNC-004', 'The whole REST host unreachable: still a clear error, never an empty account', async () => {
    const unblock = await blockRequests(page, (u) => isRest(u));
    await page.reload();
    await sleep(12000);
    const text = await pageText(page);
    await qa.shot('rest host blocked');
    const empty = /No publications|No licenses|No documents/.test(text) || ((await page.getByRole('button', { name: /^Credentials$/ }).count()) > 0 && !/read-only|Offline|could not|haven't finished/i.test(text));
    qa.check('a clear error (records or account screen) with a way to retry, not an empty account', !empty && /(haven't finished loading|could not be verified|could not load|Reload|Try again)/i.test(text), text.slice(0, 240));
    await unblock();
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'Publications');
    qa.check('after the host is back, a reload shows the records', /QA load-gate paper/.test(await pageText(page)));
  });
});

test('a save refused during a membership re-check keeps the form and its file; after reconnecting one record is saved', { tag: ['@SYNC-006'] }, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Remy', lastName: 'Refused' });
  const started = new Date(Date.now() - 2000).toISOString();

  await qa.feature('SYNC-006', 'Add form with a file; the membership check fails; Save is refused out loud; reconnect; Save again', async () => {
    await openCredentials(page, 'Licenses');
    await page.getByRole('button', { name: 'Add' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    await dlg.waitFor();
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'Display Name').fill('QA Refused Save License');
    await field(dlg, 'License #').fill('QA-REFUSE-606');
    await field(dlg, 'State').selectOption('UT');
    await field(dlg, /^Expires/).fill('2029-03-31');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dlg.getByRole('button', { name: 'Upload' }).click()]);
    await chooser.setFiles([{ name: 'qa-refused-license.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('QA synthetic Utah license for a refused save') }]);
    await dlg.getByText('qa-refused-license.pdf').first().waitFor({ timeout: 30000 });
    // The membership check fails from here on (billing-entitlements unreachable); the member
    // switches back to the tab, which asks the server again at once.
    const unblock = await blockRequests(page, (u) => isFunction(u, 'billing-entitlements'));
    const checked = page.waitForRequest((r) => r.url().includes('/functions/v1/billing-entitlements'), { timeout: 20000 }).catch(() => null);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await checked;
    await sleep(1500);
    const dialogs = qa.report.dialogs.length;
    await dlg.getByRole('button', { name: 'Add' }).click();
    await sleep(2500);
    const said = qa.report.dialogs.slice(dialogs).join(' | ');
    await qa.shot('refused save');
    qa.check('the refusal says "Reconnecting, try again in a moment." or "Changes can\'t be saved until you reconnect."', /Reconnecting, try again in a moment\.|Changes can't be saved until you reconnect\./.test(said), said || 'no alert');
    qa.check('the form stays open', await dlg.isVisible());
    qa.check('every typed value is still there', await field(dlg, 'License #').inputValue() === 'QA-REFUSE-606' && await field(dlg, 'Display Name').inputValue() === 'QA Refused Save License' && await field(dlg, /^Expires/).inputValue() === '2029-03-31');
    qa.check('the attached file is still listed', await dlg.getByText('qa-refused-license.pdf').first().isVisible().catch(() => false));
    qa.check('nothing reached the database', !rows(`select id from public.licenses where user_id = '${profile.id}'`).length && !rows(`select id from public.documents where user_id = '${profile.id}'`).length);
    // Back online: Save again until the app accepts it (a refusal asks for a fresh check itself).
    await unblock();
    let tries = 0;
    for (; tries < 6 && await dlg.isVisible().catch(() => false); tries++) {
      await sleep(tries ? 3000 : 1500);
      await dlg.getByRole('button', { name: 'Add' }).click().catch(() => {});
      await dlg.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
    qa.check('after reconnecting, Save closes the form', !(await dlg.isVisible().catch(() => false)), `${tries} tap(s)`);
    await sleep(4000);
    const lic = rows(`select id from public.licenses where user_id = '${profile.id}' and created_at > '${started}'`);
    qa.check('exactly one license was created', lic.length === 1, `${lic.length}`);
    const docs = rows(`select id, name, linked_to, storage_path from public.documents where user_id = '${profile.id}'`);
    qa.check('exactly one document, linked to that license, with its file stored', docs.length === 1 && docs[0].linked_to === `licenses:${lic[0]?.id}` && !!docs[0].storage_path, JSON.stringify(docs));
    qa.check('no document without a linked record', docs.every((d) => d.linked_to && lic.some((l) => d.linked_to === `licenses:${l.id}`)));
    const queue = await pendingOps(page);
    qa.check('nothing left queued', queue.length === 0, JSON.stringify(queue).slice(0, 160));
  });
});

test('an add that never reached the cloud, edited once the network is back, keeps the edit after the replay', { tag: ['@SYNC-009'] }, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Ravi', lastName: 'Replay' });

  await qa.feature('SYNC-009', 'Add a Travel & IDs record while its insert fails; edit the Number online; reload', async () => {
    const unblock = await blockRequests(page, (u, m) => m === 'POST' && isRest(u, 'travel_docs'));
    await openCredentials(page, 'Travel & IDs');
    await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    const d = page.getByRole('dialog', { name: 'Add' });
    await d.waitFor();
    await field(d, 'Type').selectOption('Passport');
    await field(d, 'Airline / Hotel / Company').fill('QA Passport Office');
    await field(d, 'Number').fill('QA-PASS-1111');
    await field(d, 'Label (optional)').fill('QA replay passport');
    await field(d, /Expires/).fill('2031-01-31');
    await d.getByRole('button', { name: 'Add' }).click();
    await d.waitFor({ state: 'detached', timeout: 15000 });
    await sleep(2500);
    const queue = await pendingOps(page);
    qa.check('the failed insert is queued on the device', queue.some((op) => op.collectionKey === 'travelDocs' && op.op === 'upsert'), JSON.stringify(queue).slice(0, 200));
    qa.check('no travel_docs row yet', !rows(`select id from public.travel_docs where user_id = '${profile.id}'`).length);
    await unblock();
    // Online again, no reload: edit the Number.
    await recordButtons(page, 'QA-PASS-1111').edit.click();
    const e = page.getByRole('dialog', { name: 'Edit' });
    await e.waitFor();
    await field(e, 'Number').fill('QA-PASS-2222');
    await e.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
    await e.waitFor({ state: 'detached', timeout: 15000 });
    await sleep(3000);
    const queueAfterEdit = await pendingOps(page);
    qa.check('the edit is on screen before the reload', /QA-PASS-2222/.test(await pageText(page)));
    const dbBefore = rows(`select number from public.travel_docs where user_id = '${profile.id}'`);
    await page.reload();
    await waitForMemberApp(page);
    await sleep(5000);
    await openCredentials(page, 'Travel & IDs');
    const text = await pageText(page);
    await qa.shot('after replay');
    const db = row(`select id, number, updated_at from public.travel_docs where user_id = '${profile.id}'`);
    const onScreen = /QA-PASS-2222/.test(text) ? 'QA-PASS-2222' : /QA-PASS-1111/.test(text) ? 'QA-PASS-1111' : 'neither';
    qa.check('after the reload the screen shows the edited Number', onScreen === 'QA-PASS-2222', onScreen);
    qa.check('the database holds the edited Number', db?.number === 'QA-PASS-2222', `${db?.number} (updated ${db?.updated_at})`);
    if (db?.number !== 'QA-PASS-2222') {
      qa.bug({
        title: 'An edit made after a failed first save is reverted by the replay of the queued insert',
        step: 'Credentials > Travel & IDs > Add while the insert fails (queued); network back; edit the Number (no reload); reload',
        expected: 'The edited Number (QA-PASS-2222) on screen and in travel_docs',
        actual: `Screen: ${onScreen}; database: ${db?.number}. Before the reload the edit's PATCH matched no row (${dbBefore.length} rows) and was not queued (queue ${queueAfterEdit.length} op: the original insert). updateItem (src/lib/supabase.js) is a plain UPDATE that reports no error when it matches 0 rows; the queued insert replays with updated_at = replay time (sbUpsertRow sets it when the queued item has none, and CrudSection adds carry no updatedAt), newer than the edit's local stamp, so the self-heal pass in AppContext loadDataForUser keeps the cloud row and the edit is lost.`,
        severity: 'high',
      });
    }
  });
});

test('a record kept only on this device is pushed up on load; a stale device does not resurrect a deleted one', { tag: ['@SYNC-010'] }, async ({ page, qa, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Sasha', lastName: 'Selfheal' });

  await qa.feature('SYNC-010', 'Add while the insert fails, lose the queue, reload: the record is pushed from the device copy', async () => {
    const unblock = await blockRequests(page, (u, m) => m === 'POST' && isRest(u, 'publications'));
    await addPublication(page, 'QA device-only paper');
    await sleep(2500);
    const queue = await pendingOps(page);
    qa.check('the insert failed and was queued', queue.some((op) => op.collectionKey === 'publications'), `${queue.length} op(s)`);
    qa.check('no row in the database yet', !row(`select id from public.publications where user_id = '${profile.id}'`));
    // The queue is lost (cleared, as a browser clean-up of that one key would); the device copy stays.
    await page.evaluate(() => localStorage.removeItem(`credentialdomd-pending-ops:${window.Clerk.user.id}`));
    await sleep(800);
    await unblock();
    const mark = qa.report.console.length;
    const logs = [];
    page.on('console', (m) => { if (/pushed \d+ local item/.test(m.text())) logs.push(m.text()); });
    await page.reload();
    await waitForMemberApp(page);
    const pushed = await waitFor('the pushed row', async () => row(`select id from public.publications where user_id = '${profile.id}' and name = 'QA device-only paper'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('the console says "pushed N local item(s) to cloud"', logs.length > 0, logs.join(' | ') || qa.report.console.slice(mark).slice(0, 3).join(' | '));
    qa.check('the device-only record is now in the database', !!pushed);
  });

  await qa.feature('SYNC-010', 'A stale device whose deletion-ledger read fails does not resurrect a record deleted elsewhere', async () => {
    await addPublication(page, 'QA deleted elsewhere paper');
    const target = await waitFor('the second row', async () => row(`select id from public.publications where user_id = '${profile.id}' and name = 'QA deleted elsewhere paper'`), { timeoutMs: 20000 });
    await page.reload();
    await waitForMemberApp(page);
    await sleep(2000);
    // Device B deletes it.
    const b = await secondBrowser();
    await signIn(b.page, user);
    await landing(b.page);
    await openCredentials(b.page, 'Publications');
    await recordButtons(b.page, 'QA deleted elsewhere paper').remove.click();
    await sleep(3000);
    qa.check('B deleted it: row gone, tombstoned', !row(`select id from public.publications where id = '${target.id}'`) && tombstones(profile.id).some((t) => t.item_id === target.id));
    // Device A still holds it in its copy; its read of the deletion ledger fails on this load.
    const unblock = await blockRequests(page, (u, m) => m === 'GET' && isRest(u, 'deleted_items'));
    await page.reload();
    await waitForMemberApp(page);
    await sleep(6000);
    await unblock();
    const back = row(`select id from public.publications where id = '${target.id}'`);
    await openCredentials(page, 'Publications');
    const shownOnA = /QA deleted elsewhere paper/.test(await pageText(page));
    await qa.shot('stale device after load');
    qa.check('the deleted record is not pushed back up (no zombie row)', !back, back ? 'row re-created' : 'still deleted');
    qa.check('device A does not show it', !shownOnA);
    if (back) {
      qa.bug({
        title: 'A stale device resurrects a record deleted on another device when its deletion-ledger read fails',
        step: 'Device B deletes a publication; device A (holding it in its copy) loads while its GET deleted_items fails',
        expected: 'Nothing deleted elsewhere is pushed back (the self-heal must not run without the ledger, or must treat an unreadable ledger as unknown)',
        actual: `publications row ${target.id} is back in the database while deleted_items still holds it (a zombie), and A shows it (${shownOnA}). listTombstones (src/lib/supabase.js) breaks out of its loop on an error and returns an empty Set, so AppContext loadDataForUser's self-heal treats every local row missing from the cloud as never uploaded and bulkSyncs it.`,
        severity: 'high',
      });
    }
  });
});
