// Setup's Protected tier, done the way a new member does it: About you, the
// registry import in "Your licenses" (the lab serves a synthetic registry
// answer inside the browser; nothing reaches NLM or NPPES), a license added by
// hand through the deep link, the Expiration dates strip (a card read by the
// mock AI, a date typed on the keyboard, the full record opened and closed),
// the DEA drawer and the Reminders drawer. Each deep link out of Setup must
// come back to the same drawer, at desk width and on a phone.
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, base64Marker, chooseFiles, field, landing, newMember, openCredentials, profileOf, recordButtons, row, rows, scriptAi, signIn, sleep, stamp,
  syntheticPdf, waitFor,
} from './support/lab.mjs';
import {
  openSettings, openSetupPage, phoneBrowser, reloadApp, serveSyntheticRegistry, stripCounts,
} from './support/settings-auth-helpers.mjs';

/** One row of the Expiration dates strip (DateRow), by the license's state. */
const dateRow = (page, state) => page.locator('div').filter({ has: page.locator(`input[aria-label^="Expiration date for ${state}"]`) }).filter({ has: page.getByRole('button', { name: 'Choose a file instead' }) }).last();

test('setup: licenses from the registry and by hand, expiration dates, DEA, reminders; deep links come back', {
  tag: ['@SETTINGS-003', '@SETTINGS-010', '@SETTINGS-004', '@SETTINGS-018'],
}, async ({ page, qa, browser }) => {
  test.setTimeout(10 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Lena', lastName: 'Licenser' });
  const npi = `19990${String(Date.now()).slice(-5)}`;
  const registry = await serveSyntheticRegistry(page, {
    npi, first: 'LENA', last: 'LICENSER', credential: 'M.D.', state: 'CO',
    licenses: [{ state: 'CO', number: `QACO${npi.slice(-4)}` }, { state: 'NM', number: `QANM${npi.slice(-4)}` }],
  });

  await qa.feature('SETTINGS-003', 'About you, then "Your licenses": the registry lookup imports every license it lists', async () => {
    await openSetupPage(page);
    await page.locator('button').filter({ hasText: 'About you' }).first().click();
    await page.getByRole('button', { name: 'MD', exact: true }).click();
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'Choose a state' }) }).first().selectOption('CO');
    await page.locator('button').filter({ hasText: 'Your licenses' }).first().click();
    await page.getByPlaceholder('Blank searches by name').fill(npi);
    await page.getByRole('button', { name: 'Look up' }).click();
    const importBtn = page.getByRole('button', { name: /^Import 2 licenses$/ });
    const found = await importBtn.waitFor({ timeout: 30000 }).then(() => true, () => false);
    await qa.shot('registry answer');
    qa.check('the lookup finds the synthetic physician and offers both licenses', found, (await page.locator('body').innerText()).match(/Import \d+ licenses?|No provider found[^.]*/)?.[0]);
    qa.check('the lookup was answered by the lab stand-in (nothing left this machine)', registry.count >= 1, `${registry.count} lookup(s)`);
    if (!found) return;
    await importBtn.click();
    const imported = await waitFor('the imported licenses', async () => {
      const r = rows(`select state, license_number, npi_imported, expiration_date from public.licenses where user_id = '${profile.id}' and npi_imported`);
      return r.length === 2 ? r : null;
    }, { timeoutMs: 30000 }).catch(() => rows(`select state, license_number, npi_imported, expiration_date from public.licenses where user_id = '${profile.id}'`));
    qa.check('two licenses rows, marked npi_imported, with no expiration date', imported.length === 2 && imported.every((l) => l.npi_imported && !l.expiration_date), JSON.stringify(imported));
    const note = await page.getByText(/2 licenses imported/).first().isVisible().catch(() => false);
    qa.check('the drawer turns into the date strip ("2 licenses imported" and the undated rows)', note && await page.getByRole('textbox', { name: /Expiration date for/ }).count() >= 0);
    const p = await waitFor('npi on the profile', async () => { const x = profileOf(user.id); return x?.npi === npi ? x : null; }, { timeoutMs: 15000 }).catch(() => profileOf(user.id));
    qa.check('profiles.npi, degree and primary state saved', p.npi === npi && p.degree_type === 'MD' && p.primary_state === 'CO', JSON.stringify({ npi: p.npi, degree: p.degree_type, primary: p.primary_state }));
  }, { soft: true });

  await qa.feature('SETTINGS-018', '"Add a license by hand" opens the Licenses add form, and closing it comes back to the drawer', async () => {
    await openSetupPage(page);
    await page.locator('button').filter({ hasText: 'Your licenses' }).first().click();
    await page.getByRole('button', { name: 'Add a license by hand' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    const opened = await dlg.waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('the Licenses add form opens', opened);
    if (!opened) return;
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'License #').fill('QA-HAND-WA1');
    await field(dlg, 'State').selectOption('WA');
    // The form requires an expiration date (or "not yet known"), as the physician is told.
    await field(dlg, /^Expires/).fill('2029-01-31');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    const back = await page.getByRole('heading', { name: /^Setup$/ }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    await qa.shot('back from add by hand');
    qa.check('saving the form returns to More > Setup', back);
    qa.check('the "Your licenses" drawer is the one open', back && await page.getByRole('button', { name: 'Add a license by hand' }).isVisible().catch(() => false));
    const lic = await waitFor('the hand-added license', async () => row(`select state from public.licenses where user_id = '${profile.id}' and license_number = 'QA-HAND-WA1'`), { timeoutMs: 15000 }).catch(() => null);
    qa.check('licenses row for the license added by hand', lic?.state === 'WA');
  }, { soft: true });

  await qa.feature('SETTINGS-010', 'Expiration dates: a card read from a file dates the license and links the copy', async () => {
    await openSetupPage(page);
    await page.locator('button').filter({ hasText: 'Expiration dates' }).first().click();
    const coNumber = `QACO${npi.slice(-4)}`;
    const pdf = syntheticPdf(`QA synthetic Colorado license card ${coNumber} ${Date.now()}`);
    await scriptAi('gemini', { json: { documentType: 'license', confidence: 'high', extracted: {
      type: 'State Medical License', licenseNumber: coNumber, state: 'CO', issuedDate: '2024-04-01', expirationDate: '2028-03-31',
    } } }, base64Marker(pdf));
    const coRow = dateRow(page, 'CO');
    const choose = coRow.getByRole('button', { name: 'Choose a file instead' }).first();
    await chooseFiles(page, choose, [{ name: 'qa-co-license-card.pdf', mimeType: 'application/pdf', buffer: pdf }]);
    // Once dated, the row leaves the strip (the strip lists only undated licenses): that is the confirmation.
    const closed = await page.locator('input[aria-label^="Expiration date for CO"]').waitFor({ state: 'detached', timeout: 45000 }).then(() => true, () => false);
    await qa.shot('dated from the card');
    qa.check('the CO row closes once the card is read', closed, (await page.locator('body').innerText()).match(/(Attached[^.]*\.|That file could not[^.]*\.)/)?.[0] || '');
    const lic = await waitFor('the CO date', async () => { const r = row(`select id, expiration_date from public.licenses where user_id = '${profile.id}' and license_number = '${coNumber}'`); return r?.expiration_date ? r : null; }, { timeoutMs: 20000 }).catch(() => null);
    qa.check('licenses.expiration_date read off the card (2028-03-31)', lic?.expiration_date === '2028-03-31', JSON.stringify(lic));
    const doc = lic ? await waitFor('the linked copy', async () => row(`select name, linked_to, storage_path from public.documents where user_id = '${profile.id}' and linked_to = 'licenses:${lic.id}'`), { timeoutMs: 20000 }).catch(() => null) : null;
    qa.check('the copy is stored and linked to that license', !!doc?.storage_path, JSON.stringify(doc));
  }, { soft: true });

  await qa.feature('SETTINGS-018', '"Open the full record" from Expiration dates, then close: back on the same drawer', async () => {
    await openSetupPage(page);
    await page.locator('button').filter({ hasText: 'Expiration dates' }).first().click();
    const nmRow = dateRow(page, 'NM');
    await nmRow.getByRole('button', { name: /Open the full record/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Edit' });
    const opened = await dlg.waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('the NM license opens in its edit form', opened);
    if (!opened) return;
    await sleep(1500);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-fkey') || document.activeElement?.tagName);
    qa.check('the form lands on the expiration date', focused === 'expirationDate', focused);
    await dlg.getByRole('button', { name: 'Close dialog' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    const back = await page.getByRole('heading', { name: /^Setup$/ }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    await qa.shot('back from full record');
    qa.check('closing the form returns to More > Setup', back);
    qa.check('the "Expiration dates" drawer is open again', back && await page.locator('input[aria-label^="Expiration date for NM"]').isVisible().catch(() => false));
  }, { soft: true });

  await qa.feature('SETTINGS-010', 'A date typed on the keyboard into the strip is saved once, whole', async () => {
    // Desk browsers fire a change for every digit of the year, the way a physician types it.
    const nm = page.locator('input[aria-label^="Expiration date for NM"]');
    await nm.focus();
    await page.keyboard.type('05012027', { delay: 120 });
    await page.keyboard.press('Tab');
    await sleep(3000);
    const saved = row(`select expiration_date from public.licenses where user_id = '${profile.id}' and state = 'NM'`);
    await qa.shot('typed date');
    qa.check('licenses.expiration_date is 2027-05-01', saved?.expiration_date === '2027-05-01', JSON.stringify(saved));
    if (saved?.expiration_date !== '2027-05-01') {
      qa.bug({
        title: 'Setup > Expiration dates: typing a year saves a partial year (the license reads as expired in year 2) and the row disappears mid-typing',
        step: 'More > Setup > Expiration dates; click the NM row\'s date field and type 05/01/2027 on the keyboard',
        expected: 'The license is saved once with 2027-05-01',
        actual: `licenses.expiration_date = ${saved?.expiration_date}. DateRow's date input saves on every change (src/components/features/setup/DateFixList.jsx:52-55 setDate -> editItem, wired to the input's onChange at line 141); desktop Chrome fires a change for each year digit (0002-05-01, 0020-05-01, ...), the first one dates the license in year 2, the Dates task treats it as dated, and the row unmounts before the rest of the year can be typed`,
        severity: 'high',
      });
    }
    const nmFix = page.locator('input[aria-label^="Expiration date for NM"]');
    if (await nmFix.count()) { await nmFix.fill('2027-05-01'); await sleep(2000); }
    if (saved?.expiration_date !== '2027-05-01') {
      // Put the date right the way the physician would: Credentials > Licenses, edit, whole date.
      await openCredentials(page, 'Licenses');
      await recordButtons(page, `QANM${npi.slice(-4)}`).edit.click();
      const dlg = page.getByRole('dialog', { name: 'Edit' });
      await field(dlg, /^Expires/).fill('2027-05-01');
      await dlg.getByRole('button', { name: /^Save/ }).click();
      await dlg.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
      await sleep(2000);
    }
  }, { soft: true });

  await qa.feature('SETTINGS-003', 'DEA: number and expiry, "Add my DEA" completes the task', async () => {
    await openSetupPage(page);
    await page.locator('button').filter({ hasText: 'DEA registration' }).first().click();
    // The drawer's own form (a Next card above it may carry the same "Add my DEA" verb).
    const box = page.locator('div').filter({ has: page.getByPlaceholder('e.g. BW1234563') }).filter({ has: page.getByRole('button', { name: 'I do not hold a DEA registration' }) }).last();
    await box.getByPlaceholder('e.g. BW1234563').fill('QB0000017');
    await box.locator('input[type="date"]').first().fill('2027-11-30');
    await box.getByRole('button', { name: 'Add my DEA' }).click();
    const dea = await waitFor('the DEA row', async () => row(`select type, license_number, state, expiration_date from public.licenses where user_id = '${profile.id}' and type = 'DEA Registration'`), { timeoutMs: 20000 }).catch(() => null);
    await qa.shot('dea added');
    qa.check('licenses row "DEA Registration" with its number, state and expiry', dea?.expiration_date === '2027-11-30' && dea.state === 'CO', JSON.stringify(dea));
    qa.check('the drawer now says it is on file', await page.getByText(/^On file\. The expiration date is what the reminders count down from/).first().isVisible().catch(() => false));
    await reloadApp(page);
    await openSetupPage(page);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('after a reload the DEA row is done', /DEA registration (Dated|On file|Dated\. Proof)/.test(text) || !/DEA registration Nothing on file yet/.test(text), text.match(/DEA registration [^.]*\./)?.[0]);
  }, { soft: true });

  await qa.feature('SETTINGS-004', 'Reminders: an address, email on, a lead time; saved and the task completes', async () => {
    // Start from a profile with no contact address (a member who cleared it in Settings).
    await openSettings(page);
    const emailBox = page.locator('input[name="email"]');
    await emailBox.fill('');
    await emailBox.blur();
    await sleep(2500);
    qa.check('the profile address is blank before the drawer is used', !profileOf(user.id).email, profileOf(user.id).email);
    await openSetupPage(page);
    await page.locator('button').filter({ hasText: 'Reminders' }).first().click();
    // 40cf5bad: the field shows only the saved address; the sign-in address is its placeholder,
    // with a one-tap "Use <address>" that saves it (it used to be pre-filled and never saved).
    const where = page.getByRole('textbox', { name: 'Where the warning goes', exact: true });
    const shown = await where.inputValue();
    const hint = await where.getAttribute('placeholder');
    const useIt = page.getByRole('button', { name: `Use ${user.email}`, exact: true });
    qa.check('with no address on file the field is empty, the sign-in address only its placeholder, with "Use <address>"', shown === '' && hint === user.email && await useIt.isVisible().catch(() => false), JSON.stringify({ value: shown, placeholder: hint }));
    // The physician turns email on (it is on) and picks a lead time, without touching the address field.
    const toggle = page.getByRole('button', { name: 'Email reminders' });
    await page.getByRole('button', { name: '60 days' }).click();
    await sleep(2500);
    await reloadApp(page);
    await openSetupPage(page);
    const p1 = profileOf(user.id);
    const text1 = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const saysNoAddress = /Reminders No address on file to warn/.test(text1);
    qa.check('nothing unsaved passes for an address on file: the profile address is still blank and the task says so', !p1.email && saysNoAddress, JSON.stringify({ shownInField: shown, onFile: p1.email, task: text1.match(/Reminders [^.]*\./)?.[0] }));
    // "Use <address>" saves the sign-in address.
    await page.locator('button').filter({ hasText: 'Reminders' }).first().click();
    await useIt.click();
    const used = await waitFor('the sign-in address saved', async () => (profileOf(user.id).email === user.email ? true : null), { timeoutMs: 10000, intervalMs: 400 }).catch(() => false);
    qa.check('"Use <address>" saves the sign-in address as the reminder address', used === true && (await where.inputValue()) === user.email, JSON.stringify({ onFile: profileOf(user.id).email, field: await where.inputValue().catch(() => null) }));
    // Now use it fully: type the address, turn email off and on, pick 60 days.
    const address = `rem-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
    if (!(await where.isVisible().catch(() => false))) await page.locator('button').filter({ hasText: 'Reminders' }).first().click();
    await where.fill(address);
    await where.blur();
    await toggle.click();
    await sleep(1500);
    const off = profileOf(user.id);
    qa.check('turning email reminders off saves notify_email = false', off.notify_email === false, String(off.notify_email));
    await toggle.click();
    const on = await waitFor('notify_email back on', async () => (profileOf(user.id).notify_email === true ? true : null), { timeoutMs: 8000, intervalMs: 400 }).catch(() => false);
    qa.check('turning email reminders back on saves notify_email = true', on === true, String(profileOf(user.id).notify_email));
    await page.getByRole('button', { name: '60 days' }).click();
    await sleep(2500);
    await reloadApp(page);
    const p = profileOf(user.id);
    qa.check('profiles.email, notify_email, reminder_lead_days saved', p.email === address && p.notify_email === true && p.reminder_lead_days === 60, JSON.stringify({ email: p.email, notify: p.notify_email, lead: p.reminder_lead_days }));
    await openSetupPage(page);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('the Reminders row is done after a reload', !/Reminders (No address on file|No channel is on)/.test(text), text.match(/Reminders [^.]*\./)?.[0]);
    await page.locator('button').filter({ hasText: 'Reminders' }).first().click();
    qa.check('the drawer shows 60 days picked', (await page.getByRole('button', { name: '60 days' }).evaluate((b) => getComputedStyle(b).borderColor)) !== (await page.getByRole('button', { name: '30 days' }).evaluate((b) => getComputedStyle(b).borderColor)));
  }, { soft: true });

  await qa.feature('SETTINGS-018', 'On a phone: a packet row\'s add button, then close, comes back to that open drawer', async () => {
    const phone = await phoneBrowser(browser, qa.report);
    try {
      await signIn(phone.page, user);
      await landing(phone.page);
      await phone.page.getByRole('button', { name: /^More$/ }).last().click();
      await phone.page.getByRole('button', { name: /Setup Get everything on file/ }).click();
      await phone.page.getByRole('heading', { name: /^Setup$/ }).first().waitFor({ timeout: 20000 });
      const strip = await stripCounts(phone.page);
      // Open the packet section, then the work row, then its add button.
      const packetHeader = phone.page.getByRole('button', { name: /items · \d+ done/ }).first();
      if (await packetHeader.isVisible().catch(() => false) && !(await phone.page.getByText('Your current position').first().isVisible().catch(() => false))) await packetHeader.click();
      await phone.page.locator('[data-task-row="work"] button').first().click();
      await phone.page.getByRole('button', { name: 'Add my position' }).click();
      const dlg = phone.page.getByRole('dialog', { name: 'Add' });
      const opened = await dlg.waitFor({ timeout: 15000 }).then(() => true, () => false);
      qa.check('the Work History add form opens', opened);
      if (!opened) return;
      await dlg.getByRole('button', { name: 'Close dialog' }).click();
      await dlg.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
      const back = await phone.page.getByRole('heading', { name: /^Setup$/ }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
      await sleep(800);
      await phone.page.screenshot({ path: (await qa.shot('phone back from packet add')).replace(/\.png$/, '-phone.png'), fullPage: true });
      const drawerOpen = await phone.page.getByRole('button', { name: 'Add my position' }).isVisible().catch(() => false);
      const header = phone.page.getByRole('button', { name: /items · \d+ done/ }).first();
      await header.scrollIntoViewIfNeeded().catch(() => {});
      const folded = /›\s*$/.test((await header.innerText().catch(() => '')).trim());
      await phone.page.screenshot({ path: (await qa.shot('phone packet header on return')).replace(/\.png$/, '-phone.png') });
      qa.check('closing returns to More > Setup', back);
      qa.check('the "Your current position" drawer is open on return (packet unfolded)', drawerOpen && !folded, `drawer ${drawerOpen ? 'open' : 'not shown'}, packet ${folded ? 'folded' : 'open'}; Tier 1 ${JSON.stringify(strip)}`);
      if (back && (!drawerOpen || folded)) {
        qa.bug({
          title: 'Phone: back from a Setup packet row\'s add form, the packet is folded and the row\'s drawer is hidden',
          step: 'Phone width, Tier 1 unfinished: More > Setup > open the packet > "Your current position" > "Add my position"; close the form',
          expected: 'Back on More > Setup with the packet unfolded and the "Your current position" drawer open',
          actual: 'Setup comes back with the packet folded ("n items · m done ›") and no drawer showing. The return remounts SetupPage with initialTask = "work", but seeded starts equal to initialTask (src/components/features/SetupPage.jsx:767 useState(initialTask)), so the render-time branch that unfolds the packet (lines 775-780) never runs; packetOpen stays null and the packet is collapsed while Tier 1 is unfinished (line 960)',
          severity: 'medium',
        });
      }
    } finally { await phone.context.close(); }
  }, { soft: true });
});
