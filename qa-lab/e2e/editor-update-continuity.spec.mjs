// Real application editor and updater. This controlled version response tests
// deferral; separate native two-build evidence proves an actual artifact swap.
import { test, expect } from './support/fixtures.mjs';
import { clerkId, field, lab, lit, newMember, openCredentials, row, stamp, waitForMemberApp } from './support/lab.mjs';

test.use({ serviceWorkers: 'block' });

test('a new version waits while a record editor is open, then updates deliberately after Cancel', {
  tag: ['@OPS-007'],
}, async ({ page, qa }) => {
  const member = await newMember(page, { firstName: 'Editor', lastName: 'Update' });
  await openCredentials(page, 'Publications');
  await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
  const dialog = page.getByRole('dialog').last();
  const name = stamp('Uninterrupted-draft');
  await field(dialog, 'Short Label').fill(name);
  await field(dialog, 'Full Citation (as it should read on the CV)').fill('Synthetic unsaved citation remains in this editor.');
  await field(dialog, 'Year').fill('2026');
  const origin = new URL(lab().urls.app).origin;
  const current = await (await fetch(`${origin}/app/version.json`)).json();
  const pattern = '**/app/version.json*';
  const version = route => new URL(route.request().url()).origin !== origin
    ? route.fallback()
    : route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ build: `${current.build}-editor-control` }) });
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  await page.route(pattern, version);
  const update = page.locator('[aria-label="Update app to the new version"]');
  await qa.feature('OPS-007', 'A deployment cannot interrupt an active record editor', async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(update).toBeAttached();
    // The old updater schedules a 600 ms reload. Observe beyond that boundary.
    await page.waitForTimeout(1000);
    await expect(field(dialog, 'Short Label')).toHaveValue(name);
    await expect(field(dialog, 'Full Citation (as it should read on the CV)')).toHaveValue('Synthetic unsaved citation remains in this editor.');
    await expect(field(dialog, 'Year')).toHaveValue('2026');
    qa.check('no navigation while the editor is active', navigations === 0, navigations);
    qa.check('the correct account remains signed in', await clerkId(page) === member.user.id);
    await qa.shot('record editor remains open during the new-version check');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    qa.check('Cancel writes no record', !row(`select id from public.publications where user_id = ${lit(member.profile.id)} and name = ${lit(name)}`));
    await expect(update).toBeVisible();
    await qa.shot('manual update remains available after closing the editor');
    // This fixture does not serve a second artifact. Restore the real version
    // before the manual reload so its new document does not see a fake deploy.
    await page.unroute(pattern, version);
    await Promise.all([page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() }), update.click()]);
    await waitForMemberApp(page);
    qa.check('the deliberate update reloads once', navigations === 1, navigations);
    qa.check('the deliberate update keeps the same account', await clerkId(page) === member.user.id);
  });
});
