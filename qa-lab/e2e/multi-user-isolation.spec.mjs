// Separate physicians, not merely two devices logged into the same account.
// Uses the real local RLS boundary and normal UI writes; all people are synthetic.
import { randomUUID } from 'node:crypto';
import { test, expect } from './support/fixtures.mjs';
import { field, lit, newMember, openCredentials, openMore, restAs, row, signIn, stamp, waitFor, waitForMemberApp } from './support/lab.mjs';
import { observeSignOut } from './support/signout-observer.mjs';

const signOutObservations = new WeakMap();
test.beforeEach(async ({ page }) => {
  if (process.env.QA_SIGNOUT_OBSERVE === '1') signOutObservations.set(page, await observeSignOut(page));
});
test.afterEach(async ({ page }, info) => {
  if (process.env.QA_SIGNOUT_OBSERVE !== '1') return;
  const observations = signOutObservations.get(page) || [];
  await info.attach('signout-pointer-and-storage-observations', {
    body: JSON.stringify(observations, null, 2), contentType: 'application/json',
  });
});

async function addPublication(page, label) {
  await openCredentials(page, 'Publications');
  await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
  const dialog = page.getByRole('dialog').last();
  await field(dialog, 'Short Label').fill(label);
  await field(dialog, 'Full Citation (as it should read on the CV)').fill(`${label}. Synthetic QA journal. 2026;1:1.`);
  await field(dialog, 'Year').fill('2026');
  await dialog.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
  await dialog.waitFor({ state: 'detached' });
}

test('two physicians remain isolated during concurrent work and a shared-device account switch', {
  tag: ['@MULTI-001', '@MULTI-002'],
}, async ({ page, secondBrowser, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const second = await secondBrowser();
  const a = await newMember(page, { firstName: 'Morgan', lastName: 'Isolation' });
  const b = await newMember(second.page, { firstName: 'Jordan', lastName: 'Isolation' });
  const labels = [stamp('Physician-A'), stamp('Physician-B')];
  let records;

  await qa.feature('MULTI-001', 'Two paid physicians write concurrently and cannot cross the ownership boundary', async () => {
    await Promise.all([addPublication(page, labels[0]), addPublication(second.page, labels[1])]);
    records = await Promise.all([a, b].map(({ profile }, index) => waitFor('publication persisted', async () =>
      row(`select id, user_id, name, citation from public.publications where user_id = ${lit(profile.id)} and name = ${lit(labels[index])}`))));
    qa.check('distinct records belong to distinct physicians', records[0].id !== records[1].id && records[0].user_id !== records[1].user_id);
    for (const [index, member] of [a, b].entries()) {
      const own = records[index], other = records[1 - index];
      const positive = await restAs(member.user, `publications?id=eq.${own.id}&select=id,user_id`);
      qa.check(`physician ${index + 1} can read their own record`, positive.status === 200 && positive.data?.[0]?.id === own.id);
      const read = await restAs(member.user, `publications?id=eq.${other.id}&select=id,user_id,citation`);
      qa.check(`physician ${index + 1} cannot read the other record`, read.status === 200 && Array.isArray(read.data) && read.data.length === 0);
      const patch = await restAs(member.user, `publications?id=eq.${other.id}`, { method: 'PATCH', body: { citation: 'Unauthorized overwrite' } });
      qa.check(`physician ${index + 1} cannot update the other record`, patch.status === 200 && Array.isArray(patch.data) && patch.data.length === 0);
      const remove = await restAs(member.user, `publications?id=eq.${other.id}`, { method: 'DELETE' });
      qa.check(`physician ${index + 1} cannot delete the other record`, remove.status === 200 && Array.isArray(remove.data) && remove.data.length === 0);
      const forgedId = randomUUID();
      const insert = await restAs(member.user, 'publications', { method: 'POST', body: { id: forgedId, user_id: other.user_id, name: 'Forged owner', citation: 'Synthetic unauthorized record', year: '2026' } });
      qa.check(`physician ${index + 1} cannot create a record owned by the other`, insert.status === 403 && insert.data?.code === '42501' && !row(`select id from public.publications where id = '${forgedId}'`));
      const disposableId = randomUUID();
      const created = await restAs(member.user, 'publications', { method: 'POST', body: { id: disposableId, user_id: own.user_id, name: 'Own permission control', citation: 'Before', year: '2026' } });
      qa.check(`physician ${index + 1} can create an owned record`, created.status === 201 && created.data?.[0]?.id === disposableId);
      const updated = await restAs(member.user, `publications?id=eq.${disposableId}`, { method: 'PATCH', body: { citation: 'After' } });
      qa.check(`physician ${index + 1} can update an owned record`, updated.status === 200 && updated.data?.[0]?.citation === 'After' && row(`select citation from public.publications where id = '${disposableId}'`)?.citation === 'After');
      const deleted = await restAs(member.user, `publications?id=eq.${disposableId}`, { method: 'DELETE' });
      qa.check(`physician ${index + 1} can delete an owned record`, deleted.status === 200 && deleted.data?.[0]?.id === disposableId && !row(`select id from public.publications where id = '${disposableId}'`));
    }
    for (const [index, device] of [page, second.page].entries()) {
      await device.reload();
      await waitForMemberApp(device);
      await openCredentials(device, 'Publications');
      await expect(device.getByText(labels[index], { exact: true }).first()).toBeVisible();
      qa.check(`physician ${index + 1}'s screen excludes the other account`, !(await device.locator('body').innerText()).includes(labels[1 - index]));
      const stored = row(`select id, user_id, name, citation from public.publications where id = '${records[index].id}'`);
      qa.check(`physician ${index + 1}'s original data is unchanged`, JSON.stringify(stored) === JSON.stringify(records[index]));
    }
    await qa.shot('physician A isolated record');
  });

  await qa.feature('MULTI-002', 'A signs out and B signs in on the same device', async () => {
    await openMore(page, 'Sign Out');
    await page.getByTestId('qa-signin').waitFor();
    await signIn(page, b.user);
    await waitForMemberApp(page);
    for (const reload of [false, true]) {
      if (reload) { await page.reload(); await waitForMemberApp(page); }
      await openCredentials(page, 'Publications');
      await expect(page.getByText(labels[1], { exact: true }).first()).toBeVisible();
      qa.check(`B sees no A data${reload ? ' after reload' : ''}`, !(await page.locator('body').innerText()).includes(labels[0]));
    }
    qa.check('both server records remain unchanged after the switch', records.every(record =>
      JSON.stringify(row(`select id, user_id, name, citation from public.publications where id = '${record.id}'`)) === JSON.stringify(record)));
    await qa.shot('shared device shows only physician B');
  });
});
