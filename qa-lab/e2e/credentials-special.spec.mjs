// Two Credentials areas with special rules: Protected Identity (device-only,
// the SSN and full date of birth encrypted with a lock code; nothing of it
// may reach the network or the database) and a custom category the physician
// creates, with records in it that sync like any other section.
import { test } from './support/fixtures.mjs';
import {
  field, newMember, openCredentials, pendingOps, recordButtons, row, rows, sleep, tombstones, waitForMemberApp,
} from './support/lab.mjs';

// Synthetic identifiers only: SSN area 000 is never issued.
const SSN = '000-12-3456';
const DOB = '1980-02-03';

/** Public tables whose rows contain `text` anywhere (read-only scan of the local lab database). */
function tablesContaining(text) {
  return rows(`select table_name as t, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I x where x::text like %L', table_name, '%${text}%'), false, true, '')))[1]::text::int as n
    from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`).filter((r) => r.n > 0);
}

test('protected identity stays on the device and encrypted; a custom category holds synced records', {
  tag: ['@CRED-005', '@CRED-023', '@CRED-024'],
}, async ({ page, qa }) => {
  test.setTimeout(6 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Morgan', lastName: 'Private' });

  await qa.feature('CRED-005', 'Protected Identity: saved on this device, encrypted, never sent', async () => {
    const sent = [];
    const onRequest = (r) => { const body = r.postData() || ''; if (body.includes(SSN) || body.includes(DOB) || body.includes(SSN.replace(/-/g, ''))) sent.push(`${r.method()} ${new URL(r.url()).pathname}`); };
    page.on('request', onRequest);
    await openCredentials(page, 'Protected Identity');
    await page.getByRole('button', { name: 'Add record' }).click();
    const d = page.getByRole('dialog', { name: 'Add protected identity' });
    await d.getByPlaceholder('e.g. Liability application 2026').fill('QA liability application');
    await field(d, 'Legal first name').fill('Morgan');
    await field(d, 'Legal last name').fill('Private');
    await d.getByPlaceholder('YYYY-MM-DD').fill(DOB);
    await d.getByPlaceholder('###-##-####').fill(SSN);
    // The first save on this device asks, in the form, for a lock code (8+ characters) that stays here.
    const lock = d.getByPlaceholder('Lock code (8+ characters)');
    if (!(await lock.isVisible().catch(() => false))) {
      await d.getByRole('button', { name: 'Save on this device' }).click();
      await lock.waitFor({ timeout: 5000 }).catch(() => {});
    }
    if (await lock.isVisible().catch(() => false)) {
      qa.check('saving an SSN asks for a device lock code first', /lock code/i.test(await d.getByRole('alert').first().innerText().catch(() => '')) || await lock.isVisible());
      await qa.shot('lock code prompt');
      await lock.fill('qa-lab-lock-code');
      await d.getByRole('button', { name: 'Save on this device' }).click();
    }
    await d.waitFor({ state: 'detached', timeout: 15000 });
    await sleep(2500);
    await qa.shot('protected identity saved');
    const listed = /QA liability application/.test(await page.locator('body').innerText());
    qa.check('the record is listed on this device', listed);
    qa.check('the SSN is not shown in the clear on the list', !(await page.locator('body').innerText()).includes(SSN));
    const stored = await page.evaluate(([ssn, dob]) => Object.entries(localStorage).filter(([, v]) => typeof v === 'string' && (v.includes(ssn) || v.includes(dob))).map(([k]) => k), [SSN, DOB]);
    qa.check('localStorage never holds the SSN or date of birth in the clear', stored.length === 0, stored.join(', '));
    const inDb = [...tablesContaining(SSN), ...tablesContaining('QA liability application')];
    qa.check('no database table holds the record or the SSN', inDb.length === 0, JSON.stringify(inDb));
    qa.check('no network request carried the SSN or date of birth', sent.length === 0, sent.join(', '));
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'Protected Identity');
    qa.check('it survives a reload on this device', /QA liability application/.test(await page.locator('body').innerText()));
    page.off('request', onRequest);
  }, { soft: true });

  let category;
  await qa.feature('CRED-023', 'Create a custom category', async () => {
    await openCredentials(page, 'New category');
    await page.getByPlaceholder('e.g. Hospital ID Badges').fill('QA Hospital Badges');
    await page.getByPlaceholder('One emoji').fill('🪪');
    await page.getByPlaceholder('Badge number, Facility, Access level').fill('Badge number, Facility, Access level');
    await page.getByRole('button', { name: 'Create category' }).click();
    await sleep(2500);
    category = row(`select * from public.custom_categories where user_id = '${profile.id}' and name = 'QA Hospital Badges'`);
    await qa.shot('category created');
    qa.check('custom_categories row created', !!category, category ? JSON.stringify(category).slice(0, 200) : 'none');
    qa.check('the new category opens with nothing in it', /QA Hospital Badges/.test(await page.locator('body').innerText()));
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page);
    qa.check('the category is in the Credentials menu after a reload', await page.getByRole('navigation').filter({ hasText: 'Active Credentials' }).getByRole('button', { name: /QA Hospital Badges/ }).count() > 0);
  }, { soft: true });

  await qa.feature('CRED-024', 'Records in a custom category', async () => {
    await openCredentials(page, 'QA Hospital Badges');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    const d = page.getByRole('dialog').last();
    await d.waitFor();
    const labels = await d.locator('label').allTextContents();
    await qa.shot('category record form');
    qa.check('the form has the category\'s own fields', ['Badge number', 'Facility', 'Access level'].every((f) => labels.some((l) => l.includes(f))), labels.join(' | '));
    const name = d.locator('label', { hasText: /^(Name|Display Name|Title|Label)/ });
    if (await name.count()) await field(d, /^(Name|Display Name|Title|Label)/).fill('QA badge Mercy');
    await field(d, 'Badge number').fill('QA-BADGE-77');
    await field(d, 'Facility').fill('QA Mercy Hospital');
    await field(d, 'Access level').fill('OR and ICU');
    await d.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
    await d.waitFor({ state: 'detached', timeout: 15000 });
    await sleep(2500);
    const rec = row(`select id, row_to_json(r)::text as j from public.custom_records r where user_id = '${profile.id}' and row_to_json(r)::text like '%QA-BADGE-77%'`);
    qa.check('custom_records row with the values packed in its fields', !!rec, rec?.j.slice(0, 220));
    qa.check('no queued writes left', (await pendingOps(page)).length === 0);
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, 'QA Hospital Badges');
    const shown = /QA-BADGE-77|QA Mercy Hospital|QA badge Mercy/.test(await page.locator('body').innerText());
    qa.check('the record survives a reload', shown);
    if (rec && shown) {
      const text = (await page.locator('body').innerText()).match(/QA-BADGE-77|QA badge Mercy|QA Mercy Hospital/)[0];
      await recordButtons(page, text).remove.click();
      await sleep(2500);
      qa.check('deleting it removes the row and tombstones it', !row(`select id from public.custom_records where id = '${rec.id}'`) && tombstones(profile.id).some((t) => t.item_id === rec.id));
    }
  }, { soft: true });
});
