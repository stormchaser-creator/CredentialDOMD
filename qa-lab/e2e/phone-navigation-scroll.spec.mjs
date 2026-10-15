import { test } from './support/fixtures.mjs';
import { newPhoneMember, phoneMore, phoneTab, phoneUse } from './support/phone-helpers.mjs';

test.use(phoneUse(375));
test('phone navigation starts the destination at its heading after a long profile page @HOME-004', async ({ page, qa }) => {
  await newPhoneMember(page, { firstName: 'Native', lastName: 'Navigation' });
  await qa.feature('HOME-004', 'Switching phone sections does not inherit the preceding section scroll', async () => {
    await phoneMore(page, 'Profile & settings');
    const scroller = page.locator('div[style*="height: 100%"][style*="overflow-y: auto"]');
    qa.check('one actual phone content scroller is present', await scroller.count() === 1);
    const birthday = page.locator('input[name="birthMonthDay"]');
    await birthday.scrollIntoViewIfNeeded();
    await birthday.focus();
    const editingTop = await scroller.evaluate(el => el.scrollTop);
    await birthday.fill('7/14');
    const updatedTop = await scroller.evaluate(async el => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return el.scrollTop;
    });
    qa.check('editing a setting preserves the existing page scroll', editingTop > 0 && updatedTop === editingTop, { editingTop, updatedTop });
    const before = await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; return { top: el.scrollTop, height: el.clientHeight }; });
    qa.check('the long profile has been scrolled beyond its first screen', before.top > before.height, before);
    await phoneTab(page, 'Credentials');
    const after = await scroller.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight }));
    const heading = await page.getByRole('heading', { name: 'Credentials', exact: true }).boundingBox();
    const top = await scroller.boundingBox();
    const visible = !!heading && !!top && heading.y >= top.y && heading.y + heading.height <= top.y + top.height - 64;
    qa.check('destination begins at its top', after.top === 0, after);
    qa.check('Credentials heading is visible above the bottom navigation', visible, { heading, scroller: top });
    if (after.top !== 0 || !visible) qa.bug({ title: 'Phone section navigation inherits unrelated prior-page scroll', severity: 'medium', step: 'Scroll Profile & settings to its lower sections, then tap Credentials', expected: 'Credentials begins at its heading', actual: `Destination scrollTop=${after.top}; heading visible=${visible}` });
    await qa.shot('phone credentials destination scroll');
  });
});
