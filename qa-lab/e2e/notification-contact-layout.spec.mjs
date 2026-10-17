import { test } from './support/fixtures.mjs';
import { newMember, waitForMemberApp } from './support/lab.mjs';
import { seed } from './support/home-notify-helpers.mjs';

test('notification contact labels fit narrow dialogs without clipping the verified email', { tag: ['@NOTIFY-002', '@phone'] }, async ({ page, qa }) => {
  // A long uninterrupted local part is intentional: shorter, hyphenated
  // addresses can wrap even in the old anonymous flex text item.
  const email = `notificationlayout${crypto.randomUUID().replaceAll('-', '')}@qa.credentialdomd.test`;
  const { user, profile } = await newMember(page, { firstName: 'Synthetic', lastName: 'Notification Layout', email, profession: 'MD' });
  const expires = new Date(); expires.setDate(expires.getDate() + 30);
  await seed(user, profile.id, 'licenses', [{ type: 'State Medical License', license_number: 'QA-LAYOUT-ONLY', state: 'CO', expiration_date: expires.toISOString().slice(0, 10) }]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMemberApp(page);
  // Only the external mail-app handoff is replaced: retain the real component,
  // persisted notification log, dialog lifecycle, and member context.
  await page.evaluate(() => {
    const originalOpen = window.open.bind(window);
    window.open = (url, ...args) => String(url).startsWith('mailto:') ? null : originalOpen(url, ...args);
  });
  await qa.feature('NOTIFY-002', 'The real notification dialog retains its complete email label on narrow screens', async () => {
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole('button', { name: /^Notifications(?:,|$)/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Notification Center' });
      await dialog.waitFor();
      await dialog.evaluate(el => Promise.allSettled(el.getAnimations().map(a => a.finished)));
      const action = dialog.getByRole('button', { name: `Email to ${email}`, exact: true });
      qa.check(`${width}px: the complete email remains in the button name`, await action.isVisible());
      const geometry = await action.evaluate(button => {
        const label = button.querySelector('span:last-child');
        const icon = button.querySelector('svg');
        const body = button.closest('[role="dialog"]').querySelector('[data-modal-body]');
        return { bodyWidth: body.clientWidth, bodyScroll: body.scrollWidth, labelWidth: label?.clientWidth, labelScroll: label?.scrollWidth, iconWidth: icon?.getBoundingClientRect().width };
      });
      qa.check(`${width}px: no horizontal overflow`, geometry.bodyScroll <= geometry.bodyWidth + 1 && geometry.labelScroll <= geometry.labelWidth + 1, geometry);
      qa.check(`${width}px: the action icon remains readable`, geometry.iconWidth >= 17, geometry);
      await qa.shot(`notification contact ${width}px`);
      await action.click();
      await dialog.getByRole('status').filter({ hasText: 'Your email app should open' }).waitFor();
      qa.check(`${width}px: composing does not claim delivery`, await dialog.getByText('Notification sent!', { exact: true }).count() === 0);
      await dialog.getByRole('button', { name: 'Close dialog' }).click();
      await page.getByRole('button', { name: /^Notifications(?:,|$)/ }).click();
      await action.waitFor();
      qa.check(`${width}px: reopening allows another composition`, await action.isVisible());
      await dialog.getByRole('button', { name: 'Close dialog' }).click();
    }
  });
});
