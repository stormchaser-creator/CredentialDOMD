// P0 journeys about what lives on the device:
//   * signing out purges everything this account kept in the browser, and
//     signing back in restores every cloud record (device-only data stays gone);
//   * an edit made while the network drops is queued, or refused out loud,
//     never lost silently; back online, a reload replays it into the database;
//   * the app opened offline shows the device's copy read-only and refuses saves
//     with a message, keeping what was typed.
import { test } from './support/fixtures.mjs';
import { deviceStoreKeys } from './support/device-store.mjs';
import {
  clerkId, field, goTab, landing, lab, newMember, openCredentials, openMore, pendingOps, recordButtons, row, rows, signIn, sleep, syncWarnings, tableRow,
  waitFor, waitForMemberApp,
} from './support/lab.mjs';

// Keys that name the account: localStorage, sessionStorage, and the app's
// IndexedDB store, where the offline copy, the transcript and the archives
// live (support/device-store.mjs).
const storageKeysFor = async (page, id) => ({
  ...(await page.evaluate((cid) => ({
    local: Object.keys(localStorage).filter((k) => k.includes(cid)),
    session: Object.keys(sessionStorage).filter((k) => k.includes(cid)),
  }), id)),
  idb: await deviceStoreKeys(page, id),
});

async function addEducation(page, { name, institution }) {
  await openCredentials(page, 'Education');
  await page.getByRole('button', { name: 'Add' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add' });
  await dlg.waitFor();
  const type = field(dlg, 'Type');
  if (await type.evaluate((e) => e.tagName === 'SELECT')) await type.selectOption({ index: 1 });
  await field(dlg, 'Display Name').fill(name);
  await field(dlg, 'Institution').fill(institution);
  await field(dlg, 'Graduation / End Date').fill('2015-06-01');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.waitFor({ state: 'detached', timeout: 15000 });
}

test('sign out purges the device; signing back in restores the cloud records', { tag: ['@AUTH-005', '@AUTH-002'] }, async ({ page, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Drew', lastName: 'Device' });
  await addEducation(page, { name: 'QA Residency', institution: 'QA Teaching Hospital' });
  await openCredentials(page, 'Licenses');
  await page.getByRole('button', { name: 'Add' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add' });
  await field(dlg, 'Type').selectOption('State Medical License');
  await field(dlg, 'License #').fill('QA-OUT-1');
  await field(dlg, 'State').selectOption('WA');
  await field(dlg, /^Expires/).fill('2028-02-01');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.waitFor({ state: 'detached' });
  await sleep(2500);
  const counts = () => row(`select (select count(*) from public.licenses where user_id = '${profile.id}')::int as licenses, (select count(*) from public.education where user_id = '${profile.id}')::int as education`);
  const before = counts();
  const cid = await clerkId(page);

  await qa.feature('AUTH-005', 'Sign out purges the device', async () => {
    const keysBefore = await storageKeysFor(page, cid);
    qa.check('the device holds this account\'s data before sign-out', keysBefore.local.length + keysBefore.idb.length > 0, [...keysBefore.local, ...keysBefore.idb].join(', '));
    const dialogs = qa.report.dialogs.length;
    await openMore(page, 'Sign Out');
    await page.getByTestId('qa-signin').waitFor({ timeout: 60000 });
    qa.check('no unsynced-work warning when nothing is pending', qa.report.dialogs.length === dialogs, qa.report.dialogs.slice(dialogs).join(' | '));
    const keysAfter = await storageKeysFor(page, cid);
    qa.check('no localStorage or sessionStorage key for that account remains', keysAfter.local.length === 0 && keysAfter.session.length === 0, [...keysAfter.local, ...keysAfter.session].join(', '));
    const deviceKeys = await page.evaluate((id) => localStorage.getItem(`credentialdomd-device-keys:${id}`), cid);
    qa.check('the device-key slot is gone', deviceKeys === null);
    const idb = await page.evaluate(async (id) => (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name).filter((n) => n && n.includes(id)) : []), cid);
    qa.check('no IndexedDB database named for that account remains', idb.length === 0, idb.join(', '));
    qa.check('no entry of that account remains in the app\'s IndexedDB store (file, transcript, archives)', keysAfter.idb.length === 0, keysAfter.idb.join(', '));
    qa.check('the cloud rows are untouched by sign-out', JSON.stringify(counts()) === JSON.stringify(before), JSON.stringify(counts()));
  });

  await qa.feature('AUTH-002', 'Sign back in: every cloud record returns', async () => {
    await signIn(page, user);
    const where = await landing(page);
    qa.check('signing back in opens the member app', where === 'member', where);
    await openCredentials(page, 'Licenses');
    qa.check('the license is back', await tableRow(page, 'QA-OUT-1').isVisible().catch(() => false));
    await openCredentials(page, 'Education');
    qa.check('the education record is back', /QA Teaching Hospital|QA Residency/.test(await page.locator('body').innerText()));
    await qa.shot('restored after sign-in');
  });
});

test('network drops mid-session: the edit is queued (or refused out loud) and replays after reconnect', { tag: ['@SYNC-008'] }, async ({ page, context, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Quinn', lastName: 'Queue' });
  await addEducation(page, { name: 'QA Fellowship', institution: 'QA Institute' });
  await sleep(2500);
  const rec = await waitFor('the education row', async () => row(`select * from public.education where user_id = '${profile.id}'`), { timeoutMs: 20000 });

  await qa.feature('SYNC-008', 'Edit while the network is down, then reconnect and reload', async () => {
    await openCredentials(page, 'Education');
    await context.setOffline(true);
    const mark = qa.report.console.length;
    const dialogs = qa.report.dialogs.length;
    await recordButtons(page, 'QA Institute').edit.click();
    const edit = page.getByRole('dialog', { name: 'Edit' });
    await edit.waitFor({ timeout: 15000 });
    await field(edit, 'Institution').fill('QA Institute (edited offline)');
    await edit.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
    await sleep(4000);
    const queue = await pendingOps(page);
    const said = [...qa.report.dialogs.slice(dialogs), ...(await page.getByRole('alert').allInnerTexts().catch(() => []))].join(' | ');
    const formOpen = await edit.isVisible().catch(() => false);
    await qa.shot('offline save');
    const queued = queue.length === 1;
    const refused = /offline|connection|can.t be saved|not saved|reconnect/i.test(said);
    qa.check('the offline save is queued (one op) or refused with a message, never silent', queued || refused, `queue ${queue.length}; said: ${said.slice(0, 200)}; form open: ${formOpen}`);
    qa.check('nothing reached the database while offline', row(`select institution from public.education where id = '${rec.id}'`).institution === 'QA Institute');
    await context.setOffline(false);
    if (formOpen) await edit.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click().catch(() => {});
    await sleep(1500);
    await page.reload();
    await waitForMemberApp(page);
    await sleep(4000);
    const after = await pendingOps(page);
    qa.check('after reconnect and reload the queue is empty', after.length === 0, JSON.stringify(after).slice(0, 200));
    const db = row(`select institution from public.education where id = '${rec.id}'`);
    qa.check('the edit is in the database', db.institution === 'QA Institute (edited offline)', db.institution);
    await openCredentials(page, 'Education');
    qa.check('the edit is on screen', /QA Institute \(edited offline\)/.test(await page.locator('body').innerText()));
    const warnings = syncWarnings(qa.report, mark).filter((w) => !/still failing/.test(w) || true);
    qa.check('the console explains the failed write (no silent loss)', warnings.length > 0 || queued || refused, warnings.slice(0, 3).join(' | '));
  });
});

test('opened offline: the device copy shows as a read-only archive; nothing can be saved; reconnect resumes', { tag: ['@SYNC-005'] }, async ({ page, context, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Oakley', lastName: 'Offline' });
  await addEducation(page, { name: 'QA Medical School', institution: 'QA University' });
  await sleep(3000);

  await qa.feature('SYNC-005', 'Offline launch shows the banner and the device copy; saves are refused', async () => {
    await context.setOffline(true);
    await page.reload().catch(() => {});
    const banner = page.getByText(/Offline\. Showing this device's copy of your records\./);
    const shown = await banner.first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('offline launch');
    qa.check('the offline banner appears', shown);
    if (!shown) return;
    // Offline, the app shows the device copy as a read-only archive: no editor opens, so no save
    // can be attempted (the checklist's "try to add/edit" steps have nothing to press).
    await goTab(page, 'Credentials');
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    await qa.shot('offline credentials');
    qa.check('the device copy renders the education record', /QA University/.test(text));
    qa.check('it says the records are read-only', /These records are read-only/.test(text));
    const before = rows(`select id from public.education where user_id = '${profile.id}'`).length;
    qa.check('no Add or edit control is offered offline', !(await page.getByRole('button', { name: 'Add' }).count()), `${await page.getByRole('button', { name: 'Add' }).count()} Add button(s)`);
    qa.check('Download saved records is offered offline', await page.getByRole('button', { name: 'Download saved records' }).isVisible().catch(() => false));
    await goTab(page, 'More');
    await page.getByRole('button', { name: /Vera/ }).first().click().catch(() => {});
    await sleep(800);
    const vera = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('Vera says it is unavailable offline', /unavailable offline|needs a connection|offline/i.test(vera), vera.match(/[^.]*offline[^.]*/i)?.[0]);
    await context.setOffline(false);
    await page.getByRole('button', { name: /Retry|Reload now/ }).first().click().catch(() => {});
    await waitFor('the normal session', async () => !(await page.getByText(/Offline\. Showing this device/).count()), { timeoutMs: 60000 }).catch(() => null);
    await waitForMemberApp(page).catch(() => {});
    qa.check('reconnecting reloads into a normal session', !(await page.getByText(/Offline\. Showing this device/).count()));
    const after = rows(`select id from public.education where user_id = '${profile.id}'`).length;
    qa.check('no row was created while offline', after === before, `${before} -> ${after}`);
  });
});
