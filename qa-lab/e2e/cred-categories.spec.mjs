// The physician's own categories and the paused Answer Bank: rename a
// category, add a field, hide it (its records move to Unsorted records), move
// an unsorted record into another category, and the Answer Bank's paused,
// device-only screen with a record this browser already held.
import { randomUUID } from 'node:crypto';
import { test } from './support/fixtures.mjs';
import { readDeviceJSON, writeDeviceText } from './support/device-store.mjs';
import {
  clerkId, field, newMember, openCredentials, recordButtons, row, sleep, waitForMemberApp,
} from './support/lab.mjs';
import { fillForm, saveDialog } from './support/cred-helpers.mjs';

const rail = (page) => page.getByRole('navigation').filter({ hasText: 'Active Credentials' });

async function createCategory(page, name, icon, fields) {
  await openCredentials(page, 'New category');
  await page.getByPlaceholder('e.g. Hospital ID Badges').fill(name);
  await page.getByPlaceholder('One emoji').fill(icon);
  await page.getByPlaceholder('Badge number, Facility, Access level').fill(fields);
  await page.getByRole('button', { name: 'Create category' }).click();
  await page.getByRole('heading', { name: new RegExp(name) }).waitFor({ timeout: 15000 });
}

async function openCategoryAdd(page) {
  const d = page.getByRole('dialog', { name: 'Add' });
  for (let attempt = 0; attempt < 3 && !(await d.isVisible().catch(() => false)); attempt++) {
    if (!(await page.getByRole('dialog').count())) await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await d.waitFor({ timeout: 10000 }).catch(() => {});
  }
  await d.waitFor({ timeout: 5000 });
  return d;
}

test('custom categories: rename, add a field, hide, unsorted records moved; the paused Answer Bank', {
  tag: ['@CRED-047', '@CRED-048', '@CRED-046'],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Kit', lastName: 'Categories' });
  const pid = profile.id;
  const cat = (name) => row(`select id, name, slug, aliases, fields, archived_at, updated_at from public.custom_categories where user_id = '${pid}' and name = '${name}'`);

  // A category with one record (starred), and a second category to move records into.
  await createCategory(page, 'QA Parking Permits', '🅿️', 'Permit number, Lot');
  let d = await openCategoryAdd(page);
  await fillForm(d, [[/^Name/, 'QA Garage Permit'], ['Permit number', 'QA-PARK-12'], ['Lot', 'B']]);
  let r = await saveDialog(d);
  qa.check('setup: a record in QA Parking Permits', r.closed, r.refusal);
  await sleep(2000);
  const rec = row(`select id, category_id from public.custom_records where user_id = '${pid}' and name = 'QA Garage Permit'`);
  qa.check('setup: custom_records row', !!rec, rec);
  await recordButtons(page, 'QA Garage Permit').star.click();
  await sleep(1500);
  await createCategory(page, 'QA Locker Keys', '🔑', 'Locker number');
  const parking = cat('QA Parking Permits');
  const locker = cat('QA Locker Keys');

  await qa.feature('CRED-047', 'Rename a category, add a field, hide it', async () => {
    await rail(page).getByRole('button', { name: /QA Parking Permits/ }).click();
    await page.getByRole('heading', { name: /QA Parking Permits/ }).waitFor();
    // Rename.
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByPlaceholder('Category name').fill('QA Parking Passes');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await sleep(2000);
    const renamed = row(`select name, slug, aliases, updated_at from public.custom_categories where id = '${parking.id}'`);
    qa.check('custom_categories.name is the new name (old name kept as an alias), updated_at moved', renamed?.name === 'QA Parking Passes' && (renamed.aliases || []).includes('QA Parking Permits') && renamed.updated_at !== parking.updated_at, renamed);
    qa.check('the heading shows the new name', await page.getByRole('heading', { name: /QA Parking Passes/ }).isVisible().catch(() => false));
    qa.check('the Credentials menu shows the new name', (await rail(page).getByRole('button', { name: /QA Parking Passes/ }).count()) === 1 && !(await rail(page).getByRole('button', { name: /QA Parking Permits/ }).count()));
    await openCredentials(page, 'Favorites');
    const fav = (await page.locator('main, body').first().innerText()).match(/QA Garage Permit[^\n]*\n?[^\n]*/)?.[0] || '';
    await qa.shot('favorites after rename');
    qa.check('Favorites lists the starred record under the new name', /QA Parking Passes/.test(fav), fav);
    if (/QA Parking Permits/.test(fav)) {
      qa.bug({
        title: 'Custom categories: after a rename, Favorites still names the old category under a starred record',
        step: 'Create category "QA Parking Permits" with a record; star it; Rename the category to "QA Parking Passes"; open Favorites',
        expected: 'The starred record is listed under "QA Parking Passes", as in the menu and heading',
        actual: `Favorites reads "${fav.replace(/\n/g, ' / ')}": it prints record.categoryName, the name copied onto each record when it was filed (src/App.jsx:2242), and a rename updates only the category row (CustomCategorySection.jsx:94-102). Fixed on fix/qa-cred-home (4565a595)`,
        severity: 'low',
      });
    }
    // Add a field.
    await rail(page).getByRole('button', { name: /QA Parking Passes/ }).click();
    await page.getByRole('button', { name: 'Add a field', exact: true }).click();
    await page.getByPlaceholder('Field name, e.g. Badge number').fill('Valid through');
    await page.locator('select').filter({ has: page.locator('option[value="date"]') }).first().selectOption('date');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await sleep(2000);
    const withField = row(`select fields from public.custom_categories where id = '${parking.id}'`);
    const added = (withField?.fields || []).find((f) => f.label === 'Valid through');
    qa.check('custom_categories.fields gains the new field with its type', added?.type === 'date', withField?.fields);
    d = await openCategoryAdd(page);
    const labels = await d.locator('label').allTextContents();
    const input = await field(d, 'Valid through').getAttribute('type').catch(() => null);
    qa.check('the new field appears in the record form (a date input)', labels.some((l) => /Valid through/i.test(l)) && input === 'date', { labels, input });
    await d.getByRole('button', { name: 'Cancel' }).click();
    // Hide.
    const dialogsBefore = qa.report.dialogs.length;
    await page.getByRole('button', { name: 'Hide category', exact: true }).click();
    await sleep(2000);
    const asked = qa.report.dialogs.slice(dialogsBefore).join(' | ');
    qa.check('hiding asks first and says the record is kept under Unsorted records', /Hide "QA Parking Passes"\? Its 1 record and their files are kept, under Unsorted records\./.test(asked), asked);
    const hidden = row(`select archived_at from public.custom_categories where id = '${parking.id}'`);
    qa.check('custom_categories.archived_at is set', !!hidden?.archived_at, hidden);
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page);
    qa.check('after a reload the hidden category is gone from the menu', !(await rail(page).getByRole('button', { name: /QA Parking Passes/ }).count()));
    qa.check('its record is still in the database, in the hidden category', row(`select category_id from public.custom_records where id = '${rec.id}'`)?.category_id === parking.id);
  }, { soft: true });

  await qa.feature('CRED-048', 'Unsorted records: the tile counts the hidden category\'s record; moving it empties the tile', async () => {
    await openCredentials(page);
    const tile = rail(page).getByRole('button', { name: /Unsorted records/ });
    const tileText = await tile.innerText().catch(() => '');
    qa.check('Credentials shows "Unsorted records" with 1', /Unsorted records\s*1$/.test(tileText.trim()), tileText);
    await tile.click();
    await page.getByRole('heading', { name: /Unsorted records/ }).waitFor({ timeout: 10000 });
    const body = await page.locator('main, body').first().innerText();
    await qa.shot('unsorted records');
    qa.check('the record is listed with a note to move it', /QA Garage Permit/.test(body) && /belong to a category that was hidden or removed/.test(body));
    await page.getByRole('button', { name: 'Move to another category' }).first().click();
    const sel = page.locator('select').filter({ has: page.locator('option', { hasText: 'Move to...' }) }).first();
    await sel.waitFor({ timeout: 5000 });
    const opts = await sel.locator('option').allInnerTexts();
    qa.check('the move list offers the active categories only', opts.some((o) => /QA Locker Keys/.test(o)) && !opts.some((o) => /QA Parking/.test(o)), opts);
    await sel.selectOption({ label: opts.find((o) => /QA Locker Keys/.test(o)) });
    await page.getByText('Moved to QA Locker Keys.').waitFor({ timeout: 10000 }).catch(() => {});
    await sleep(2000);
    const moved = row(`select category_id, category_name, row_to_json(r)::text as j from public.custom_records r where id = '${rec.id}'`);
    qa.check('custom_records.category_id is the chosen category', moved?.category_id === locker.id && moved.category_name === 'QA Locker Keys', moved && { category_id: moved.category_id, category_name: moved.category_name });
    qa.check('the record keeps its permit number (as a detail)', /QA-PARK-12/.test(moved?.j || ''), moved?.j.slice(0, 300));
    await openCredentials(page);
    qa.check('back on Credentials the Unsorted records tile is gone', !(await rail(page).getByRole('button', { name: /Unsorted records/ }).count()));
    await rail(page).getByRole('button', { name: /QA Locker Keys/ }).click();
    qa.check('the record is in QA Locker Keys', await page.getByText('QA Garage Permit').first().isVisible().catch(() => false));
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page);
    qa.check('and stays there after a reload (no Unsorted tile)', !(await rail(page).getByRole('button', { name: /Unsorted records/ }).count()) && /QA Locker Keys\s*1$/.test((await rail(page).getByRole('button', { name: /QA Locker Keys/ }).innerText()).trim()));
  }, { soft: true });

  await qa.feature('CRED-046', 'Answer Bank: paused, device-only; a record this browser already held is kept across loads and never sent', async () => {
    const sent = [];
    const onRequest = (req) => { if ((req.postData() || '').includes('QA synthetic answer bank reply')) sent.push(`${req.method()} ${new URL(req.url()).pathname}`); };
    page.on('request', onRequest);
    await openCredentials(page, 'Answer Bank');
    await page.getByRole('heading', { name: 'Answer Bank' }).waitFor({ timeout: 10000 });
    let body = await page.locator('main, body').first().innerText();
    qa.check('the paused notice is shown', /New entries, edits and sharing are paused/.test(body) && /kept only in this browser/.test(body));
    const pane = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Answer Bank' }) });
    qa.check('no Add, Edit, star or Send on the Answer Bank screen (the pane has no controls at all)', (await pane.count()) === 1 && (await pane.getByRole('button').count()) === 0 && !(await page.getByRole('button', { name: /^(\+ )?Add$/ }).count()), `${await pane.getByRole('button').count()} buttons in the pane`);
    qa.check('with nothing saved it gives no record count', !/This browser has \d+ saved/.test(body));
    // A record from before the pause, as this browser would hold it (lab setup: written into
    // this account's device cache, where the app keeps it).
    const id = await clerkId(page);
    // Where the app keeps it: the offline copy in IndexedDB (support/device-store.mjs).
    const deviceKey = `credentialdomd-data:${id}`;
    const blob = (await readDeviceJSON(page, deviceKey)).value;
    blob.answerBank = [{ id: randomUUID(), question: 'QA synthetic question: hospital affiliations', answer: 'QA synthetic answer bank reply', createdAt: new Date().toISOString() }];
    await writeDeviceText(page, deviceKey, JSON.stringify(blob));
    const seeded = Object.keys(blob).length;
    qa.check('lab setup: one Answer Bank record written to this account\'s device cache', seeded > 0);
    for (let i = 1; i <= 2; i++) {
      await page.reload();
      await waitForMemberApp(page);
      await sleep(2000);
      await openCredentials(page, 'Answer Bank');
      body = await page.locator('main, body').first().innerText();
      qa.check(`after load ${i} the screen counts the 1 record this browser holds, with backup guidance`, /This browser has 1 saved record\./.test(body) && /Keep a full JSON backup/.test(body), body.match(/This browser has[^\n]*/)?.[0]);
    }
    await qa.shot('answer bank paused');
    const kept = ((await readDeviceJSON(page, deviceKey)).value.answerBank || []).length;
    qa.check('the device copy is still there', kept === 1, kept);
    const table = row(`select to_regclass('public.answer_bank')::text as t, to_regclass('public.answerbank')::text as u`);
    qa.check('the database has no answer bank table', !table?.t && !table?.u, table);
    qa.check('nothing carrying the record was sent', sent.length === 0, sent);
    page.off('request', onRequest);
  }, { soft: true });
});
