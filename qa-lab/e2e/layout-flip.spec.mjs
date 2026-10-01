// An open form, panel or drawer keeps what the member typed when the desk/phone
// layout flag changes under it.
//
// In the 2026-09-30 release run, CRED-024's custom category Add form closed
// 0.1 s after it opened and CRED-014's NPI panel reset with no request in
// flight. The cause was this journey's own full-page screenshots: Chromium
// takes one by briefly resizing the page, and a resize event can read
// innerWidth 1 for about 15 ms. AppContext flipped isDesktop on every resize,
// and the Credentials tab and Setup built a different tree at each width, so
// the section (and the open Setup drawer) was unmounted and remounted. A member
// crosses 1024 px for real by turning an iPad, narrowing a window or zooming.
//
// Fixed by fix/second-load-reset: the flag follows a settled, real width only
// (src/utils/deskBreakpoint.js), a selected Credentials section sits at one
// place in the tree at both widths (App.jsx renderCredentials), and Setup's
// drawer renders once and moves between the layouts
// (src/components/shared/KeptPanel.jsx).
//
// Each case opens something, types into it, then: one resize reading
// innerWidth 1 and one back (the screenshot's sequence), a full-page
// screenshot, and a real crossing to a 900 px window and back.
import { test } from './support/fixtures.mjs';
import { field, newMember, openCredentials, openMore, sleep } from './support/lab.mjs';

const DESK = { width: 1280, height: 900 };
const NARROW = { width: 900, height: 900 };

/** The capture's sequence: one resize at innerWidth 1, the real width 15 ms later. */
async function degenerateResize(page) {
  await page.evaluate(async () => {
    const real = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => 1 });
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 15));
    if (real) Object.defineProperty(window, 'innerWidth', real); else delete window.innerWidth;
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 400));
  });
}

/** Mark an element so a remount (a new element in its place) shows. */
const mark = (locator) => locator.evaluate((el) => { el.dataset.layoutFlipMark = '1'; });
// Short waits: on a build with the defect the element is gone, and each read
// would otherwise wait out the 30 s action timeout.
const marked = (locator) => locator.evaluate((el) => el.isConnected && el.dataset.layoutFlipMark === '1', null, { timeout: 1500 }).catch(() => false);
const value = (locator) => locator.inputValue({ timeout: 1500 }).catch(() => null);

/** Runs each disturbance in turn and checks after each one. */
async function disturb(page, qa, what, check) {
  await degenerateResize(page);
  await check(`${what} after one resize reading innerWidth 1`);
  await page.screenshot({ fullPage: true });
  await sleep(400);
  await check(`${what} after a full-page screenshot`);
  await page.setViewportSize(NARROW);
  await sleep(600);
  await check(`${what} at a 900 px window (phone layout)`);
  await page.setViewportSize(DESK);
  await sleep(600);
  await check(`${what} back at 1280 px`);
}

test('an open form, panel or drawer survives a change of the desk/phone layout', {
  tag: ['@CRED-024', '@CRED-014', '@SETTINGS-003'],
}, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  await newMember(page, { firstName: 'Layout', lastName: 'Flip' });

  await qa.feature('CRED-024', 'A custom category Add form and Rename keep what was typed through a layout change', async () => {
    await openCredentials(page, 'New category');
    await page.getByPlaceholder('e.g. Hospital ID Badges').fill('QA Flip Badges');
    await page.getByPlaceholder('One emoji').fill('🪪');
    await page.getByPlaceholder('Badge number, Facility, Access level').fill('Badge number, Facility');
    await page.getByRole('button', { name: 'Create category' }).click();
    await page.getByRole('heading', { name: /QA Flip Badges/ }).waitFor();

    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Badge number' });
    await dialog.waitFor();
    const badge = field(dialog, 'Badge number');
    await badge.fill('FLIP-1');
    await mark(dialog);
    await disturb(page, qa, 'the Add form', async (when) => {
      qa.check(`the same Add form is open ${when}`, await marked(dialog));
      qa.check(`what was typed is kept ${when}`, (await value(badge)) === 'FLIP-1');
    });
    await page.keyboard.press('Escape');
    await sleep(300);

    await page.getByRole('button', { name: 'Rename' }).click();
    const name = page.getByLabel('Category name');
    await name.fill('QA Flip Renamed');
    await mark(name);
    await disturb(page, qa, 'the Rename editor', async (when) => {
      qa.check(`the same Rename editor ${when}`, await marked(name));
      qa.check(`the name typed is kept ${when}`, (await value(name)) === 'QA Flip Renamed');
    });
    await page.keyboard.press('Escape');
    await sleep(300);
  });

  await qa.feature('CRED-014', 'The Licenses NPI panel and Add form keep what was typed through a layout change', async () => {
    await openCredentials(page, 'Licenses');
    const panel = page.locator('div').filter({ hasText: /^Import from the NPI registry/ }).filter({ has: page.getByRole('button', { name: /Look up/ }) }).last();
    const npi = panel.getByPlaceholder('Blank searches by name');
    const state = panel.locator('select').first();
    await npi.fill('12345');
    await state.selectOption('CO');
    await mark(npi);
    await disturb(page, qa, 'the NPI panel', async (when) => {
      qa.check(`the same NPI panel ${when}`, await marked(npi));
      qa.check(`the number and state are kept ${when}`, (await value(npi)) === '12345' && (await value(state)) === 'CO');
    });

    await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add' });
    await dialog.waitFor();
    const number = field(dialog, 'License #');
    await number.fill('FLIP-LIC');
    await mark(number);
    await disturb(page, qa, 'the license Add form', async (when) => {
      qa.check(`the same license number input ${when}`, await marked(number));
      qa.check(`the license number is kept ${when}`, (await value(number)) === 'FLIP-LIC');
    });
    await page.keyboard.press('Escape');
    await sleep(300);
  });

  await qa.feature('SETTINGS-003', 'The open Setup "Your licenses" drawer keeps what was typed through a layout change', async () => {
    await openMore(page, 'Setup');
    await page.getByRole('button', { name: /Your licenses/ }).first().click();
    const npi = page.getByPlaceholder('Blank searches by name').first();
    await npi.waitFor();
    await npi.fill('54321');
    await mark(npi);
    await disturb(page, qa, 'the Your licenses drawer', async (when) => {
      qa.check(`the same drawer ${when}`, await marked(npi));
      qa.check(`the NPI typed is kept ${when}`, (await value(npi)) === '54321');
    });
  });
});
