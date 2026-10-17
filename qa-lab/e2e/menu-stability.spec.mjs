import { test, expect } from './support/fixtures.mjs';
import { newMember, goTab } from './support/lab.mjs';

test('More controls stay in place when administrator availability arrives', async ({ page }) => {
  test.setTimeout(180000);
  await newMember(page, { firstName: 'Morgan', lastName: 'Stablemenu' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let heldResolve;
  const held = new Promise(resolve => { heldResolve = resolve; });
  await page.route('**/functions/v1/credential-portal', async route => {
    if (route.request().postDataJSON()?.action !== 'status') return route.continue();
    heldResolve();
    await gate;
    await route.continue();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await goTab(page, 'More');
  await held;
  const setup = page.getByRole('button', { name: /^\S+ Setup Get everything on file/ });
  await setup.waitFor();
  const before = await setup.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  release();
  await page.getByRole('button', { name: /Administrator access View-only links/ }).waitFor();
  const after = await setup.boundingBox();
  expect(after.y, 'server capability answer must not move Setup under a pointer').toBe(before.y);
  await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
  await expect(page.getByRole('heading', { name: 'Setup', exact: true })).toBeVisible();
});
