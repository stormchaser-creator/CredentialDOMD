// P0 journey: a full member keeps their licenses. Add (every kind the
// checklist names), view, edit (including lifecycle status), star, attach a
// file, delete (with its file, tombstoned), and after each write the
// checklist's write-evidence protocol (SYNC-001): no sync warning in the
// console, an empty pending-ops queue, the change survives a reload, and the
// database row matches the screen. Home's ring and tiles follow the records,
// and a second, clean browser shows the same records (SYNC-003).
import { test } from './support/fixtures.mjs';
import {
  chooseFiles, field, homeTiles, newMember, openCredentials, pendingOps, profileOf, row, rows, signIn, sleep,
  syncWarnings, syntheticPdf, tableRow, tombstones, waitFor, waitForMemberApp, landing, goTab,
} from './support/lab.mjs';

const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

test('full member: licenses added, edited, starred, attached, deleted; Home and a second browser agree', {
  tag: ['@CRED-001', '@CRED-002', '@CRED-003', '@CRED-016', '@CRED-025', '@SYNC-001', '@SYNC-003', '@HOME-003'],
}, async ({ page, qa, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Riley', lastName: 'Records' });
  const pid = profile.id;
  const licenses = () => rows(`select * from public.licenses where user_id = '${pid}' order by created_at`);
  const byNumber = (n) => licenses().find((l) => l.license_number === n);

  // The write-evidence protocol after one write; every run is summarised under SYNC-001 at the end.
  const protocol = [];
  const evidence = async (what, dbCheck) => {
    const mark = qa.report.console.length;
    await sleep(3000);
    const warnings = syncWarnings(qa.report, mark);
    qa.check(`${what}: no sync warning in the console`, warnings.length === 0, warnings.join(' | '));
    const queue = await pendingOps(page);
    qa.check(`${what}: pending-ops queue is empty`, queue.length === 0, JSON.stringify(queue).slice(0, 200));
    await page.reload();
    await waitForMemberApp(page);
    const ok = await dbCheck();
    qa.check(`${what}: survives a reload and the database matches`, ok);
    protocol.push({ what, warnings: warnings.length, queue: queue.length, persisted: !!ok });
  };

  const addDialog = () => page.getByRole('dialog', { name: 'Add' });
  const openAdd = async () => {
    await openCredentials(page, 'Licenses');
    await page.getByRole('button', { name: 'Add' }).first().click();
    await addDialog().waitFor();
    return addDialog();
  };

  // A license that expires in 30 days, for Home.
  const soonNumber = 'QA-SOON-30';
  const tilesBefore = await homeTiles(page);

  await qa.feature('CRED-001', 'Add licenses: medical, DEA refusal, board certification (no expiry), date unknown', async () => {
    // Medical license, State left blank first.
    let dlg = await openAdd();
    await field(dlg, 'Type').selectOption('State Medical License');
    await dlg.getByRole('button', { name: 'Add' }).click();
    const blank = (await dlg.innerText()).match(/Required:[^\n]*/)?.[0] || '';
    qa.check('saving with the state blank says what is required', /Required:.*State/.test(blank), blank);
    await field(dlg, 'Display Name').fill('QA Texas Medical License');
    await field(dlg, 'License #').fill('QA-TX-1001');
    await field(dlg, 'State').selectOption('TX');
    await field(dlg, 'Issued').fill('2024-01-15');
    await field(dlg, /^Expires/).fill(day(400));
    await field(dlg, /Renewal Cost/).fill('450');
    const cycle = field(dlg, /CME Cycle Start/);
    if (await cycle.count()) await cycle.fill('2025-01-01');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 });
    await evidence('medical license added', () => {
      const l = byNumber('QA-TX-1001');
      return !!l && l.state === 'TX' && l.expiration_date === day(400) && Number(l.renewal_cost) === 450 && l.lifecycle_status === 'active';
    });
    qa.check('the new license shows in the table', await tableRow(page, 'QA-TX-1001').isVisible().catch(() => false) || (await openCredentials(page, 'Licenses'), await tableRow(page, 'QA-TX-1001').isVisible()));

    // DEA without State or Expires is refused.
    dlg = await openAdd();
    await field(dlg, 'Type').selectOption('DEA Registration');
    await field(dlg, 'License #').fill('QA-DEA-0001');
    await dlg.getByRole('button', { name: 'Add' }).click();
    const dea = (await dlg.innerText()).match(/Required:[^\n]*/)?.[0] || '';
    qa.check('a DEA without State or Expires is refused with "Required: State, Expires"', /Required: State, Expires/.test(dea), dea);
    qa.check('the refused DEA was not saved', !byNumber('QA-DEA-0001'));
    await dlg.getByRole('button', { name: 'Cancel' }).click();

    // Board certification that does not expire.
    dlg = await openAdd();
    await field(dlg, 'Type').selectOption('Board Certification (ABMS)');
    await field(dlg, 'Display Name').fill('QA Board Certification');
    await field(dlg, 'License #').fill('QA-ABMS-77');
    await dlg.getByRole('checkbox', { name: 'This certificate does not expire' }).check();
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 });
    await evidence('non-expiring board certification added', () => { const l = byNumber('QA-ABMS-77'); return !!l && l.no_expiration === true && !l.expiration_date; });
    await openCredentials(page, 'Licenses');
    qa.check('the card says "Does not expire"', /Does not expire/i.test(await tableRow(page, 'QA-ABMS-77').innerText().catch(() => '')) || /Does not expire/i.test(await page.locator('body').innerText()));

    // A license whose expiration date is not yet known.
    dlg = await openAdd();
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'Display Name').fill('QA Colorado License');
    await field(dlg, 'License #').fill('QA-CO-2002');
    await field(dlg, 'State').selectOption('CO');
    await dlg.getByRole('checkbox', { name: 'Expiration date not yet known' }).check();
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 });
    await evidence('date-unknown license added', () => { const l = byNumber('QA-CO-2002'); return !!l && l.date_unknown === true && !l.expiration_date; });
    await openCredentials(page, 'Licenses');
    qa.check('the date-unknown license shows as "Not yet known"', /not yet known/i.test(await page.locator('body').innerText()));

    // One that expires in 30 days (Home).
    dlg = await openAdd();
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'Display Name').fill('QA Soon License');
    await field(dlg, 'License #').fill(soonNumber);
    await field(dlg, 'State').selectOption('NM');
    await field(dlg, /^Expires/).fill(day(30));
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 });
    await evidence('license expiring in 30 days added', () => !!byNumber(soonNumber));
    qa.check('four licenses saved in the database', licenses().length === 4, licenses().map((l) => l.license_number).join(', '));
    await qa.shot('licenses table');
  });

  await qa.feature('HOME-003', 'Compliance ring and stat tiles follow the records', async () => {
    const tiles = await homeTiles(page);
    await qa.shot('home tiles');
    qa.check('before any record the ring reads 100% with nothing active', tilesBefore.active === 0 || Number.isNaN(tilesBefore.active), tilesBefore);
    qa.check('one license expiring within 90 days counts as Expiring', tiles.expiring === 1, tiles);
    qa.check('the far-off license counts as Active', tiles.active >= 1, tiles);
    qa.check('the non-expiring certification is not counted in any tile', tiles.active + tiles.expiring + tiles.expired <= 3, tiles);
    qa.check('the ring drops below 100% with a license expiring soon', tiles.percent < 100, tiles);
  });

  await qa.feature('CRED-002', 'View and edit a license, then mark it superseded', async () => {
    await openCredentials(page, 'Licenses');
    await tableRow(page, 'QA-TX-1001').click();
    const view = page.getByRole('dialog').first();
    await view.waitFor();
    const text = await view.innerText();
    qa.check('the detail view shows the number, state and dates', /QA-TX-1001/.test(text) && /TX/.test(text), text.slice(0, 200));
    await page.keyboard.press('Escape');
    await view.waitFor({ state: 'detached', timeout: 5000 }).catch(async () => { await view.getByRole('button', { name: 'Close dialog' }).click().catch(() => {}); });
    const before = byNumber('QA-TX-1001');
    const actions = tableRow(page, 'QA-TX-1001').getByRole('cell').last().getByRole('button');
    await actions.nth(2).click(); // star, share, EDIT, delete
    const edit = page.getByRole('dialog', { name: 'Edit' });
    await edit.waitFor();
    await field(edit, 'License #').fill('QA-TX-1001B');
    await field(edit, /^Expires/).fill(day(500));
    await edit.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
    await edit.waitFor({ state: 'detached', timeout: 15000 });
    await evidence('license edited', () => { const l = byNumber('QA-TX-1001B'); return !!l && l.id === before.id && l.expiration_date === day(500); });
    // Superseded by the Colorado license.
    await openCredentials(page, 'Licenses');
    await tableRow(page, 'QA-TX-1001B').getByRole('cell').last().getByRole('button').nth(2).click();
    await edit.waitFor();
    await field(edit, 'Status').selectOption({ label: 'Superseded' });
    await sleep(300);
    const replacement = field(edit, /Replaced by|Superseded by|Replacement/i);
    if (await replacement.count()) {
      const opts = await replacement.locator('option').allInnerTexts();
      const pick = opts.find((o) => /QA-CO-2002|Colorado/.test(o));
      if (pick) await replacement.selectOption({ label: pick });
    }
    await edit.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
    await edit.waitFor({ state: 'detached', timeout: 15000 });
    await evidence('license marked superseded', () => { const l = byNumber('QA-TX-1001B'); return l?.lifecycle_status === 'superseded'; });
    await openCredentials(page, 'Licenses');
    const body = await page.locator('body').innerText();
    qa.check('superseded records are grouped as "Historical and superseded"', /Historical and superseded/i.test(body));
    const tiles = await homeTiles(page);
    qa.check('the superseded license no longer counts as Active', tiles.active === 0, tiles);
  });

  await qa.feature('CRED-025', 'Star a license; Favorites lists it; the star does not stamp updated_at', async () => {
    await openCredentials(page, 'Licenses');
    const before = byNumber(soonNumber);
    await tableRow(page, soonNumber).getByRole('button', { name: 'Add to Favorites' }).click();
    await tableRow(page, soonNumber).getByRole('button', { name: 'Remove from Favorites' }).waitFor({ timeout: 10000 });
    await evidence('license starred', () => byNumber(soonNumber)?.favorite === true);
    const after = byNumber(soonNumber);
    qa.check('starring did not change updated_at (a star must not beat real edits)', after.updated_at === before.updated_at, `${before.updated_at} -> ${after.updated_at}`);
    await openCredentials(page, 'Favorites');
    const fav = await page.locator('body').innerText();
    qa.check('Favorites lists the starred license (1 starred record, the NM license)', /1 starred record/.test(fav) && /State Medical License — NM/.test(fav), fav.match(/\d+ starred record[^\n]*/)?.[0]);
  });

  let docId = null;
  await qa.feature('CRED-016', 'Attach a file to a license', async () => {
    await openCredentials(page, 'Licenses');
    await tableRow(page, 'QA-CO-2002').getByRole('cell').last().getByRole('button').nth(2).click();
    const edit = page.getByRole('dialog', { name: 'Edit' });
    await edit.waitFor();
    await chooseFiles(page, edit.getByRole('button', { name: 'Upload' }), [{ name: 'qa-colorado-license.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('QA synthetic Colorado license') }]);
    await edit.getByText(/qa-colorado-license\.pdf/).first().waitFor({ timeout: 30000 });
    await sleep(1500);
    await edit.getByRole('button', { name: /^(Save|Update|Save changes)$/ }).click();
    await edit.waitFor({ state: 'detached', timeout: 20000 });
    const lic = byNumber('QA-CO-2002');
    const doc = await waitFor('the attached document row', async () => rows(`select * from public.documents where user_id = '${pid}' and linked_to like '%${lic.id}%'`)[0] || null, { timeoutMs: 30000 }).catch(() => null);
    docId = doc?.id;
    qa.check('a documents row linked to the license', !!doc, doc ? `${doc.name} -> ${doc.linked_to}` : 'none');
    qa.check('the file bytes are in Storage', !!doc?.storage_path && !!row(`select 1 as x from storage.objects where bucket_id = 'documents' and name = '${doc?.storage_path}'`), doc?.storage_path);
    await evidence('file attached', () => !!rows(`select id from public.documents where id = '${docId}'`)[0]);
    await goTab(page, 'Documents');
    qa.check('Documents lists the attached file', /qa-colorado-license/.test(await page.locator('body').innerText()));
  });

  await qa.feature('CRED-003', 'Delete a license and its attached file (tombstoned)', async () => {
    const lic = byNumber('QA-CO-2002');
    const doc = docId ? row(`select * from public.documents where id = '${docId}'`) : null;
    await openCredentials(page, 'Licenses');
    const dialogsBefore = qa.report.dialogs.length;
    await tableRow(page, 'QA-CO-2002').getByRole('cell').last().getByRole('button').last().click();
    await sleep(500);
    const asked = qa.report.dialogs.slice(dialogsBefore).join(' | ');
    qa.check('the native confirm asks "Delete this item? This cannot be undone."', /Delete this item\? This cannot be undone\./.test(asked), asked);
    if (doc && !/document|file|attach/i.test(asked)) {
      qa.bug({ title: 'Deleting a license silently deletes its attached files too; the confirm does not say so',
        step: 'Credentials > Licenses > trash on a license with an attached PDF', expected: 'The confirmation names the attached file(s) that will be deleted with the record',
        actual: `Confirm text: "${asked.replace(/^confirm: /, '')}"; the attached document is deleted as well`, severity: 'low' });
    }
    await evidence('license deleted', () => !byNumber('QA-CO-2002'));
    const tomb = tombstones(pid);
    qa.check('the license is tombstoned in deleted_items (collection licenses)', tomb.some((t) => t.item_id === lic.id && t.collection === 'licenses'), tomb);
    if (doc) {
      qa.check('its attached document row is deleted', !row(`select id from public.documents where id = '${doc.id}'`));
      qa.check('its attached document is tombstoned', tomb.some((t) => t.item_id === doc.id), tomb.map((t) => `${t.collection}:${t.item_id}`).join(', '));
      const obj = await waitFor('the storage object to go', async () => !row(`select 1 as x from storage.objects where bucket_id = 'documents' and name = '${doc.storage_path}'`), { timeoutMs: 20000 }).catch(() => false);
      qa.check('its Storage object is removed', obj, doc.storage_path);
      await goTab(page, 'Documents');
      qa.check('Documents no longer lists the file', !/qa-colorado-license/.test(await page.locator('body').innerText()));
    }
  });

  await qa.feature('SYNC-001', 'Write-evidence protocol after every write in this journey', async () => {
    qa.check(`the protocol ran after ${protocol.length} writes`, protocol.length >= 8, protocol.map((p) => p.what).join('; '));
    const bad = protocol.filter((p) => p.warnings || p.queue || !p.persisted);
    qa.check('no write left a sync warning, a queued op or a mismatch after reload', bad.length === 0, JSON.stringify(bad));
  });

  await qa.feature('SYNC-003', 'A second, clean browser shows the same records', async () => {
    const other = await secondBrowser();
    await signIn(other.page, user);
    const where = await landing(other.page);
    qa.check('the second browser opens the member app', where === 'member', where);
    await openCredentials(other.page, 'Licenses');
    const text = await other.page.locator('body').innerText();
    const expected = licenses().map((l) => l.license_number);
    qa.check('every license in the database shows on the second browser', expected.every((n) => text.includes(n)), `db: ${expected.join(', ')}`);
    qa.check('the deleted license does not come back', !text.includes('QA-CO-2002'));
    qa.check('no "Account records" error screen', !/could not be loaded|Account records/i.test(text));
    await other.page.screenshot({ path: await qa.shot('second browser licenses').then((p) => p.replace(/\.png$/, '-b.png')) });
  });
});
