// Real browser module-map failure, before the root workspace has mounted.
// Requests are aborted only on the first document; a new document can load.
import { test, expect } from './support/fixtures.mjs';
import { newMember, signIn, clerkId } from './support/lab.mjs';

test('root module fetch failure recovers with one fresh document before opening the workspace', { tag: ['@AUTH-001'] }, async ({ page, secondBrowser, qa }) => {
  const member = await newMember(page, { firstName: 'Boot', lastName: 'Recovery' });
  // This scenario faults a network load, not the offline cache. Block the
  // service worker in this context so it cannot satisfy the intercepted load
  // or reload the document during its first installation.
  const device = await secondBrowser({ serviceWorkers: 'block' });
  let documents = 0, blocked = 0;
  device.page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === device.page.mainFrame() && new URL(request.url()).pathname === '/app/') documents++;
  });
  await device.page.route(/\/assets\/App-[^/]+\.js(?:\?.*)?$/, async route => {
    if (documents === 1) { blocked++; await route.abort('failed'); }
    else await route.continue();
  });
  await qa.feature('AUTH-001', 'A failed startup module cannot strand a signed-in member', async () => {
    await signIn(device.page, member.user);
    await expect(device.page.getByRole('navigation').first().getByRole('button', { name: 'Credentials', exact: true })).toBeVisible({ timeout: 20000 });
    expect(blocked, 'the browser actually encountered the injected module failure').toBeGreaterThan(0);
    expect(documents, 'one automatic reload, without a reload loop').toBe(2);
    expect(await clerkId(device.page)).toBe(member.user.id);
    await device.page.getByRole('navigation').first().getByRole('button', { name: 'Credentials', exact: true }).click();
    await expect(device.page.getByRole('button', { name: /Licenses/ }).first()).toBeVisible();
    await qa.shot('startup module recovered to the correct account', device.page);
  });
});
