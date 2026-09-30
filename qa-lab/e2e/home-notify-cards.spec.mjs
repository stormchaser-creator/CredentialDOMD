// The Home cards and alerts a member works from: browser notifications and
// their test, the needs-action lines under the ring, the Action Required
// cards (a license and a record in the member's own category) and the
// follow-ups logged on them, the notification banner (an address set up
// inline, the quick email and text digests, Details, Snooze), the "missing an expiration
// date" and "resolve missing information" cards, the state-without-a-license
// warning, the finish-your-profile banner, the Credentials preview and the
// all-clear banner. Each tap is followed to where it lands, and the
// database is read after every save.
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, field, homeTiles, openCredentials, openMore, profileOf, row, rows, sleep, stamp,
} from './support/lab.mjs';
import {
  bodyText, day, eventually, focusedFieldKey, hasBackButton, home, installNotificationStandIn, memberWithPlace, opened, pageTitle, recordOpens, reloadApp, restAsPatch, runHook, seed, setWidth,
} from './support/home-notify-helpers.mjs';

/** An Action Required card (it carries Follow up and Acknowledge) whose text matches. */
const actionCard = (page, text) => page.locator('div')
  .filter({ has: page.getByRole('button', { name: 'Follow up', exact: true }) })
  .filter({ hasText: text }).last();

/** The needs-action lines under the ring (buttons ending "N days left", "no expiration date", ...). */
const needsLine = (page, text) => page.getByRole('button').filter({ hasText: text })
  .filter({ hasText: /days? left|expires today|expired \d+ days? ago|no expiration date|review records|review rule/ }).first();

/** A Home card or banner: the parent of its title line. */
const cardByTitle = (page, title) => page.getByText(title).first().locator('xpath=..');

/** A valid synthetic NPI (Luhn over 80840 + the first nine digits), never a real provider's lookup. */
function syntheticNpi(base9 = '199000731') {
  const digits = `80840${base9}`.split('').map(Number);
  let sum = 0;
  for (let i = digits.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let d = digits[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return `${base9}${(10 - (sum % 10)) % 10}`;
}

test('alerts and cards: notifications, needs-action, Action Required, banner', {
  tag: ['@NOTIFY-006', '@HOME-010', '@HOME-014', '@HOME-020', '@NOTIFY-003'],
}, async ({ page, context, qa }) => {
  test.setTimeout(12 * 60 * 1000);
  await installNotificationStandIn(context);
  const { user, profile } = await memberWithPlace(page, { firstName: 'Carmen', lastName: 'Cards' });
  // Seeded after the first notification test (nothing due): a DEA due in 20 days, a Texas
  // license due in 40 (so TX CME is due too), a TB test due in 20, a permit in the member's
  // own category due in 30.
  let txId, tbId;
  const seedCards = async () => {
    await seed(user, profile.id, 'licenses', [{ type: 'DEA Registration', name: 'QA Cards DEA', license_number: 'QA-CARD-DEA', state: 'TX', expiration_date: day(20) }]);
    // A Texas license due in 40 days (so TX CME is due too), and a record in the member's own category.
    [txId] = await seed(user, profile.id, 'licenses', [
      { type: 'State Medical License', name: 'QA Cards Texas License', license_number: 'QA-CARD-TX', state: 'TX', expiration_date: day(40) },
    ]);
    const [catId] = await seed(user, profile.id, 'custom_categories', [
      { name: 'QA Permits', slug: 'qa permits', icon: '🪪', fields: [{ key: 'site', type: 'text', label: 'Site' }], origin: 'user', aliases: [] },
    ]);
    await seed(user, profile.id, 'custom_records', [
      { category_id: catId, category_name: 'QA Permits', name: 'QA fluoroscopy permit', number: 'QA-PERMIT-9', expiration_date: day(30), field_labels: { site: 'Site' }, field_values: { site: 'QA Mercy' } },
    ]);
    [tbId] = await seed(user, profile.id, 'health_records', [
      { category: 'TB Test', type: 'QuantiFERON-TB Gold', name: 'QA TB annual', date_administered: day(-340), expiration_date: day(20) },
    ]);
  };

  await qa.feature('NOTIFY-006', 'Enable asks the browser and turns the switch on; frequency saves; Test shows a notification (and composes the email)', async () => {
    await openMore(page, 'Profile & settings');
    const enable = page.getByRole('button', { name: 'Enable', exact: true });
    qa.check('Browser Notifications offers Enable on a browser never asked', await enable.isVisible().catch(() => false) && /Click to enable/.test(await bodyText(page)));
    await enable.click();
    await sleep(2500);
    const sw = page.getByRole('switch', { name: 'Browser Notifications' });
    const asks = await page.evaluate(() => (window.__qaPermissionAsks || []).length);
    qa.check('the browser was asked once and the switch is on', asks === 1 && (await sw.getAttribute('aria-checked').catch(() => null)) === 'true', `asks ${asks}`);
    qa.check('profiles.notify_browser is on', profileOf(user.id).notify_browser === true, String(profileOf(user.id).notify_browser));
    await page.getByRole('button', { name: '3 Days', exact: true }).click();
    await sleep(2500);
    qa.check('profiles.notify_freq_days is 3', profileOf(user.id).notify_freq_days === 3, String(profileOf(user.id).notify_freq_days));

    // Test with nothing due.
    await recordOpens(page);
    const before = qa.report.dialogs.length;
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await sleep(1500);
    const shownEmpty = await page.evaluate(() => (window.__qaNotifications || []).filter((n) => /Test/.test(n.title)));
    const said = qa.report.dialogs.slice(before).join(' | ');
    qa.check('Test with nothing due still shows a test notification', shownEmpty.length === 1, said || JSON.stringify(shownEmpty));
    if (!shownEmpty.length) {
      await qa.shot('test notification with nothing due');
      qa.bug({
        title: 'Settings "Send Test Notification" does nothing but say "No active alerts to send." when nothing is due, so a member cannot check that notifications work',
        step: 'Profile & settings > Notifications: Enable browser notifications, then tap Test with no credential due',
        expected: 'A test notification appears (and an email composes when email reminders are on)',
        actual: `A browser alert: "${said.replace(/^alert: /, '')}". SettingsSection.jsx:709-710 returns when generateAlerts(data) is null, before any notification or email. Fixed on fix/qa-auth-bill-settings 51fe875a`,
        severity: 'low',
      });
    }

    // Four due within 90 days (a DEA, a TB test, a permit, a license): the load itself pops an alert, and Test shows one and composes the email.
    await seedCards();
    await reloadApp(page);
    const auto = await eventually('the alert notification on load', async () => {
      const n = await page.evaluate(() => (window.__qaNotifications || []).filter((x) => x.title === 'CredentialDOMD Alert'));
      return n.length ? n : null;
    }, 12000);
    qa.check('opening the app with something due pops a browser alert', !!auto && /4 expiring soon/.test(auto[0].body), JSON.stringify(auto));
    await openMore(page, 'Profile & settings');
    qa.check('the switch is still on after a reload', (await page.getByRole('switch', { name: 'Browser Notifications' }).getAttribute('aria-checked').catch(() => null)) === 'true');
    qa.check('3 Days is still the chosen frequency', await page.getByRole('button', { name: '3 Days', exact: true }).evaluate((el) => getComputedStyle(el).color === 'rgb(255, 255, 255)'));
    await recordOpens(page);
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await sleep(1500);
    const shown = await page.evaluate(() => (window.__qaNotifications || []).filter((n) => n.title === 'CredentialDOMD Test'));
    const mail = (await opened(page)).map((o) => o.url).find((u) => u.startsWith('mailto:'));
    await qa.shot('after test');
    qa.check('Test shows a notification with the alert summary', shown.length === 1 && /4 expiring soon/.test(shown[0].body), JSON.stringify(shown));
    qa.check('...and composes the reminder email to the member (email reminders are on)', !!mail && decodeURIComponent(mail).includes(user.email), mail?.slice(0, 120));
  }, { soft: true });

  await qa.feature('HOME-010', 'Needs-action lines: a license opens its edit form on Expires, a CME line opens the math', async () => {
    await home(page);
    const lic = needsLine(page, 'State Medical License — TX');
    const cme = needsLine(page, /^TX CME/);
    await qa.shot('needs action list');
    qa.check('the license is listed under the ring with its days left', await lic.isVisible().catch(() => false), (await lic.innerText().catch(() => '')).replace(/\s+/g, ' '));
    qa.check('the TX CME shortfall is listed under the ring', await cme.isVisible().catch(() => false), (await cme.innerText().catch(() => '')).replace(/\s+/g, ' '));
    if (await lic.isVisible().catch(() => false)) {
      await lic.click();
      const edit = page.getByRole('dialog', { name: 'Edit' });
      const opened = await edit.waitFor({ timeout: 10000 }).then(() => true, () => false);
      await sleep(900);
      const focus = await focusedFieldKey(page);
      qa.check('it opens Credentials > Licenses with that license\'s edit form', opened && (await field(edit, 'License #').inputValue().catch(() => '')) === 'QA-CARD-TX');
      qa.check('the cursor is on Expires', focus === 'expirationDate', `focused: ${focus}`);
      await edit.getByRole('button', { name: 'Cancel' }).click().catch(() => page.keyboard.press('Escape'));
      await edit.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
    await home(page);
    if (await cme.isVisible().catch(() => false)) {
      await cme.click();
      const math = page.getByRole('dialog', { name: 'TX CME — the math' });
      qa.check('the CME line opens "TX CME — the math"', await math.waitFor({ timeout: 10000 }).then(() => true, () => false));
      await page.keyboard.press('Escape');
    }
  }, { soft: true });

  await qa.feature('HOME-014', 'Action Required: a card opens the record\'s edit form on its date, in its section or custom category', async () => {
    await home(page);
    const txCard = actionCard(page, 'State Medical License — TX');
    const permitCard = actionCard(page, 'QA fluoroscopy permit');
    qa.check('Action Required lists the license and the custom-category record', await txCard.isVisible().catch(() => false) && await permitCard.isVisible().catch(() => false), (await bodyText(page)).match(/Action Required.{0,300}/)?.[0]);
    await txCard.getByText('State Medical License — TX').click();
    let edit = page.getByRole('dialog', { name: 'Edit' });
    let ok = await edit.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await sleep(900);
    qa.check('the license card opens its edit form in Licenses, on Expires', ok && (await field(edit, 'License #').inputValue().catch(() => '')) === 'QA-CARD-TX' && (await focusedFieldKey(page)) === 'expirationDate', `focused ${await focusedFieldKey(page)}`);
    await page.keyboard.press('Escape');
    await edit.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

    // The custom-category record, at phone width where the cards snap-scroll sideways.
    await setWidth(page, 375);
    await page.getByRole('button', { name: /^Home$/ }).last().click();
    await sleep(900);
    const snap = await page.locator('.cmd-snap-scroll').count();
    qa.check('on a phone the Action Required cards sit in a sideways snap-scroll row', snap === 1);
    await actionCard(page, 'QA fluoroscopy permit').getByText('QA fluoroscopy permit').click();
    await sleep(1200);
    const dlg = page.getByRole('dialog', { name: /^Edit/ }).first();
    ok = await dlg.waitFor({ timeout: 10000 }).then(() => true, () => false);
    const values = ok ? await dlg.locator('input, textarea').evaluateAll((els) => els.map((e) => e.value)) : [];
    const text = await bodyText(page);
    const focus = await focusedFieldKey(page);
    await qa.shot('custom record opened from home');
    qa.check('the custom-category card opens that record\'s edit form inside QA Permits', ok && values.includes('QA-PERMIT-9') && values.includes('QA fluoroscopy permit') && /QA Permits/.test(text), JSON.stringify(values).slice(0, 200));
    qa.check('...with the cursor on the expiration date', focus === 'expirationDate', `focused ${focus}`);
    await page.keyboard.press('Escape');
    await setWidth(page, 1280);
  }, { soft: true });

  await qa.feature('HOME-020', 'Follow up: log a note, then email & log; history newest first, on the record too', async () => {
    const office = `credentialing-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
    await home(page);
    await recordOpens(page);
    await actionCard(page, 'State Medical License — TX').getByRole('button', { name: 'Follow up' }).click();
    let dlg = page.getByRole('dialog', { name: 'Log a follow-up' });
    await dlg.waitFor({ timeout: 10000 });
    await dlg.getByPlaceholder('e.g. Kyle, credentialing office').fill('QA credentialing office');
    await dlg.getByPlaceholder('e.g. reminded him to update these privileges').fill('QA called about the renewal');
    await dlg.getByRole('button', { name: 'Log it' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 5000 });
    await sleep(1500);
    await actionCard(page, 'State Medical License — TX').getByRole('button', { name: 'Follow up' }).click();
    dlg = page.getByRole('dialog', { name: 'Log a follow-up' });
    await dlg.waitFor({ timeout: 10000 });
    qa.check('reopening shows the logged note in History', /History.*Note · QA credentialing office.*QA called about the renewal/.test((await dlg.innerText()).replace(/\s+/g, ' ')));
    await dlg.getByPlaceholder('e.g. Kyle, credentialing office').fill(office);
    await dlg.getByPlaceholder('e.g. reminded him to update these privileges').fill('QA emailed the office');
    await dlg.getByRole('button', { name: 'Email & log' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 5000 });
    await sleep(2000);
    const mail = (await opened(page)).map((o) => o.url).find((u) => u.startsWith('mailto:'));
    qa.check('"Email & log" opens mail with the address in To:', !!mail && decodeURIComponent(mail.slice(7).split('?')[0]) === office, mail?.slice(0, 160));
    qa.check('the address is not used as a greeting', !!mail && !decodeURIComponent(mail).includes(`Hi ${office}`));
    const ups = rows(`select item_id, item_name, recipient, note, emailed from public.follow_ups where user_id = '${profile.id}' order by created_at desc limit 2`);
    qa.check('follow_ups holds both, newest first, the second marked emailed', ups.length === 2 && ups[0].emailed === true && ups[0].recipient === office && ups[1].emailed === false && ups[1].recipient === 'QA credentialing office' && ups.every((u) => u.item_id === txId), ups);
    await actionCard(page, 'State Medical License — TX').getByRole('button', { name: 'Follow up' }).click();
    dlg = page.getByRole('dialog', { name: 'Log a follow-up' });
    await dlg.waitFor({ timeout: 10000 });
    const hist = (await dlg.innerText()).replace(/\s+/g, ' ');
    qa.check('History lists both, newest (the email) first', hist.indexOf('Emailed') > -1 && hist.indexOf('Emailed') < hist.indexOf('Note ·'), hist.slice(0, 300));
    await dlg.getByRole('button', { name: 'Cancel' }).click();

    // The record's own detail view, after a reload.
    await reloadApp(page);
    await openCredentials(page, 'Licenses');
    await page.getByRole('row').filter({ hasText: 'QA-CARD-TX' }).first().click();
    const view = page.getByRole('dialog').first();
    await view.waitFor({ timeout: 10000 });
    const vt = (await view.innerText()).replace(/\s+/g, ' ');
    await qa.shot('record view follow-ups');
    qa.check('the license\'s detail view shows the same follow-up history, newest first', /Follow-up history/i.test(vt) && vt.indexOf('Emailed') > -1 && vt.indexOf('Emailed') < vt.indexOf('Note ·'), vt.slice(0, 300));
    await page.keyboard.press('Escape');

    // The same on a health record's alert (a TB test due in 20 days).
    await home(page);
    await actionCard(page, 'QA TB annual').getByRole('button', { name: 'Follow up' }).click();
    dlg = page.getByRole('dialog', { name: 'Log a follow-up' });
    await dlg.waitFor({ timeout: 10000 });
    await dlg.getByPlaceholder('e.g. Kyle, credentialing office').fill('QA employee health');
    await dlg.getByPlaceholder('e.g. reminded him to update these privileges').fill('QA booked the TB test');
    await dlg.getByRole('button', { name: 'Log it' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 5000 });
    await sleep(2000);
    qa.check('follow_ups row for the TB test', !!row(`select 1 as ok from public.follow_ups where user_id = '${profile.id}' and item_id = '${tbId}'`));
    await openCredentials(page, 'Health Records');
    await page.getByText('QA TB annual').first().click();
    await sleep(1200);
    const hv = (await page.getByRole('dialog').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    const hasHistory = /Follow-up history/i.test(hv) && /QA employee health/.test(hv);
    await qa.shot('health record view follow-ups');
    qa.check('the TB test\'s detail view shows its follow-up history too', hasHistory, hv.slice(0, 240));
    if (!hasHistory) {
      qa.bug({
        title: 'A follow-up logged on a health record\'s alert (TB or fit test) never shows on that record',
        step: 'Home, Action Required, a TB test due in 20 days: Follow up, Log it; then Credentials > Health Records, open the TB test',
        expected: 'The record\'s detail view shows the same follow-up history as the Home modal',
        actual: 'follow_ups holds the row, but the Health Records detail view has no follow-up history: only CrudSection renders it (CrudSection.jsx:133-156); HealthRecordsSection never reads data.followUps. Fixed on fix/qa-cred-home b948c521',
        severity: 'low',
      });
    }
    await page.keyboard.press('Escape');
  }, { soft: true });

  await qa.feature('NOTIFY-003', 'Inline setup saves; quick email and text open the digest; Details opens the center; Snooze hides it', async () => {
    // A member with no address on file: the sign-up address cleared in Settings.
    await openMore(page, 'Profile & settings');
    const emailBox = page.locator('input[name="email"]');
    await emailBox.fill('');
    await emailBox.blur();
    await sleep(2500);
    await reloadApp(page);
    const p0 = profileOf(user.id);
    qa.check('the member has no email or phone on file', !p0.email && !p0.phone, JSON.stringify({ email: p0.email, phone: p0.phone }));
    await home(page);
    const setUp = page.getByRole('button', { name: 'Set Up', exact: true });
    const shown = await setUp.isVisible().catch(() => false);
    await qa.shot('banner without contact');
    qa.check('the banner names the alert and offers Set Up', shown && /\d+ Expiring/.test(await bodyText(page)) && /Get notified by email or text/.test(await bodyText(page)));
    if (!shown) return;
    await setUp.click();
    const addr = `alerts-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
    await page.getByPlaceholder('Email address').fill(addr);
    await page.getByPlaceholder('Phone number').fill('(555) 010-0142');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await sleep(2500);
    let p = profileOf(user.id);
    qa.check('Save stores the email and phone (profiles.email, profiles.phone)', p.email === addr && p.phone === '(555) 010-0142', JSON.stringify({ email: p.email, phone: p.phone }));
    qa.check('the banner now offers Email, Text and Details', await page.getByRole('button', { name: 'Email', exact: true }).isVisible().catch(() => false) && await page.getByRole('button', { name: 'Text', exact: true }).isVisible().catch(() => false) && await page.getByRole('button', { name: 'Details', exact: true }).isVisible().catch(() => false));

    await recordOpens(page);
    await page.getByRole('button', { name: 'Email', exact: true }).click();
    await sleep(1500);
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await sleep(2500);
    const opens = (await opened(page)).map((o) => o.url);
    const mail = opens.find((u) => u.startsWith('mailto:'));
    const sms = opens.find((u) => u.startsWith('sms:'));
    const mailBody = mail ? decodeURIComponent(mail) : '';
    qa.check('Email opens mail to the member\'s own address with the digest', !!mail && mail.slice(7).split('?')[0].replace('%40', '@') === addr && /CredentialDOMD Alert: 4 expiring soon/.test(mailBody) && /EXPIRING SOON \(4\)/.test(mailBody) && /TX/.test(mailBody), mailBody.slice(0, 240));
    qa.check('Text opens Messages to the member\'s phone with the digest', !!sms && /^sms:5550100142\?body=/.test(sms) && /CredentialDOMD Alert/.test(decodeURIComponent(sms)), sms?.slice(0, 160));
    const log = rows(`select method, alert_count from public.notification_log where user_id = '${profile.id}' order by created_at`);
    qa.check('notification_log records both sends', log.some((l) => l.method === 'email' && l.alert_count === 4) && log.some((l) => l.method === 'text'), log);
    p = profileOf(user.id);
    qa.check('profiles.last_notified is stamped', !!p.last_notified, p.last_notified);

    await page.getByRole('button', { name: 'Details', exact: true }).click();
    const center = page.getByRole('dialog', { name: 'Notification Center' });
    qa.check('Details opens the Notification Center', await center.waitFor({ timeout: 10000 }).then(() => true, () => false));
    await page.keyboard.press('Escape');
    await center.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

    await page.getByRole('button', { name: 'Snooze', exact: true }).click();
    await sleep(2500);
    p = profileOf(user.id);
    const days = p.snoozed_until ? (Date.parse(p.snoozed_until) - Date.now()) / 86400000 : NaN;
    const snoozedText = (await bodyText(page)).match(/\d+ alerts? snoozed · next check in \d+d/)?.[0];
    await qa.shot('banner snoozed');
    qa.check('Snooze hides the alert banner behind a one-line "snoozed" note', !!snoozedText && !(await page.getByRole('button', { name: 'Snooze', exact: true }).count()), snoozedText || (await bodyText(page)).slice(0, 200));
    qa.check('profiles.snoozed_until is set for the escalated cadence (3 days with a license due in 20)', days > 2.9 && days < 3.1, `${p.snoozed_until} (${days.toFixed(2)} days)`);
    await reloadApp(page);
    await home(page);
    qa.check('the snooze holds across a reload', /4 alerts snoozed · next check in \d+d/.test(await bodyText(page)));
    await page.getByRole('button', { name: 'View', exact: true }).click();
    qa.check('View opens the Notification Center', await page.getByRole('dialog', { name: 'Notification Center' }).waitFor({ timeout: 10000 }).then(() => true, () => false));
    await page.keyboard.press('Escape');
  }, { soft: true });
});

test('cards: missing dates, resolve, no license, profile, preview, all clear', {
  tag: ['@HOME-012', '@HOME-013', '@HOME-025', '@HOME-011', '@HOME-023', '@HOME-026'],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { user, profile } = await memberWithPlace(page, { firstName: 'Rowan', lastName: 'Resolve' });

  // Setup Tier 1, done the way a member finishes it: training and a position
  // on file (what the CV read would fill), a dated New Mexico license and DEA,
  // the degree and primary state set in Settings, reminders on (the default).
  await seed(user, profile.id, 'education', [{ type: 'Doctor of Medicine (MD)', name: 'QA MD diploma', institution: 'QA School of Medicine', graduation_date: '2010-05-15' }]);
  await seed(user, profile.id, 'work_history', [{ type: 'Full-Time Employed', position: 'QA Attending', employer: 'QA Mercy Hospital', start_date: '2015-07-01' }]);
  await seed(user, profile.id, 'licenses', [
    { type: 'State Medical License', name: 'QA NM License', license_number: 'QA-NM-7', state: 'NM', expiration_date: day(400) },
    { type: 'DEA Registration', name: 'QA NM DEA', license_number: 'QA-DEA-NM', state: 'NM', expiration_date: day(500) },
  ]);
  await reloadApp(page);
  await openMore(page, 'Profile & settings');
  await page.getByRole('button', { name: /^MD Doctor of Medicine$/ }).click();
  await page.getByRole('button', { name: 'Set Primary' }).first().click();
  await sleep(2500);
  await home(page);
  const tier1 = await eventually('Tier 1 stamped', async () => profileOf(user.id).setup_state?.tier1DoneAt || null, 20000);

  await qa.feature('HOME-012', 'Records missing an expiration date: listed, Add date opens the form on the date, saving clears it', async () => {
    qa.check('Setup Tier 1 is complete (setup_state.tier1DoneAt)', !!tier1, JSON.stringify(profileOf(user.id).setup_state || {}).slice(0, 160));
    // The Health Records form refuses a TB test without its expiration date.
    await openCredentials(page, 'Health Records');
    await page.getByRole('button', { name: 'Add' }).first().click();
    const add = page.getByRole('dialog', { name: 'Add Health Record' });
    await add.waitFor();
    await field(add, 'Category').selectOption('TB Test');
    await field(add, 'Display Name').fill('QA TB from the form');
    await field(add, 'Date Administered').fill(day(-10));
    await add.getByRole('button', { name: /^(Save|Add)$/ }).last().click();
    await sleep(800);
    const refusal = (await add.innerText().catch(() => '')).match(/TB Tests expire[^\n]*/)?.[0] || '';
    qa.check('the form refuses a TB test with no expiration and says why (so an undated one only arrives another way)', /enter the expiration date/.test(refusal), refusal);
    await add.getByRole('button', { name: 'Cancel' }).click().catch(() => page.keyboard.press('Escape'));
    // An undated TB test and an undated license that arrived another way (a lab report import, the NPI registry import).
    const [tbId] = await seed(user, profile.id, 'health_records', [{ category: 'TB Test', type: 'QuantiFERON-TB Gold', name: 'QA TB test 2026', date_administered: day(-10) }]);
    await seed(user, profile.id, 'licenses', [{ type: 'State Medical License', name: 'QA AZ from the registry', license_number: 'QA-AZ-UNDATED', state: 'AZ', npi_imported: true }]);
    // A professional malpractice policy with Expires blank: the form refuses it, so that checklist step is skipped.
    await openCredentials(page, 'Insurance');
    await page.getByRole('button', { name: 'Add' }).first().click();
    const ins = page.getByRole('dialog', { name: 'Add' });
    await ins.waitFor();
    await field(ins, 'Type').selectOption('Medical Malpractice (Claims-Made)');
    await field(ins, 'Carrier').fill('QA Mutual');
    await field(ins, 'Policy #').fill('QA-MAL-1');
    await ins.getByRole('button', { name: 'Add' }).click();
    await sleep(800);
    const insRefusal = (await ins.innerText().catch(() => '')).match(/Required:[^\n]*/)?.[0] || '';
    qa.check('the Insurance form refuses a malpractice policy without Expires ("Required: Expires"), so it cannot reach the banner from the form', /Required: .*Expires/.test(insRefusal) && !row(`select 1 as ok from public.insurance where user_id = '${profile.id}'`), insRefusal);
    await ins.getByRole('button', { name: 'Cancel' }).click().catch(() => page.keyboard.press('Escape'));
    await reloadApp(page);
    await home(page);
    const banner = cardByTitle(page, /^⚠️ \d+ records? missing an expiration date/);
    const bt = (await banner.innerText().catch(() => '')).replace(/\s+/g, ' ');
    await qa.shot('missing dates banner');
    qa.check('the banner lists the TB test and the undated license', /2 records missing an expiration date/.test(bt) && /Health record: .*QA TB test 2026/.test(bt) && /License: State Medical License — AZ/.test(bt), bt.slice(0, 300));
    await banner.getByRole('button').filter({ hasText: 'QA TB test 2026' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit Health Record' });
    const opened = await edit.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await sleep(900);
    const focus = await page.evaluate(() => document.activeElement?.closest('label, div')?.innerText?.slice(0, 40) || document.activeElement?.tagName);
    const onDate = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el.tagName !== 'INPUT' || el.type !== 'date') return false;
      const label = el.parentElement?.querySelector('label')?.textContent || '';
      return /Expiration/i.test(label);
    });
    qa.check('"Add date" opens the TB test\'s edit form', opened);
    qa.check('...with the cursor on the expiration field', onDate, `focused: ${focus}`);
    if (opened && !onDate) {
      qa.bug({
        title: 'Home "Add date →" on a TB or fit test opens the Health Record form without putting the cursor on its expiration date',
        step: 'Home, "N records missing an expiration date", tap "Add date →" on an undated TB test',
        expected: 'The edit form opens on the expiration field, as it does for a license (CrudSection focuses data-fkey="expirationDate")',
        actual: 'The Edit Health Record form opens with nothing focused on the date. App.jsx:1158 passes focus "expirationDate", crudTarget returns it as autoFocusField, but HealthRecordsSection (HealthRecordsSection.jsx:16, 125-129) does not take autoFocusField and its date input carries no data-fkey. Fixed on fix/qa-cred-home b948c521',
        severity: 'low',
      });
    }
    await field(edit, 'Expiration Date').fill(day(300));
    await edit.getByRole('button', { name: /^(Save|Update)$/ }).last().click();
    await edit.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    await sleep(2500);
    const tb = row(`select expiration_date from public.health_records where id = '${tbId}'`);
    qa.check('health_records.expiration_date saved', tb?.expiration_date === day(300), tb);
    await home(page);
    const bt2 = (await bodyText(page)).match(/⚠️ \d+ records? missing an expiration date.{0,200}/)?.[0] || '';
    qa.check('the TB test leaves the banner; the license stays', /1 record missing an expiration date/.test(bt2) && !/QA TB test 2026/.test(bt2), bt2);
  }, { soft: true });

  await qa.feature('HOME-013', 'Resolve missing information: listed with its source, opens the edit on the date, never in the ring or a reminder', async () => {
    await home(page);
    const before = await homeTiles(page);
    // A license whose date is not known yet, and one awaiting confirmation with a date inside the reminder window.
    await openCredentials(page, 'Licenses');
    await page.getByRole('button', { name: 'Add' }).first().click();
    let dlg = page.getByRole('dialog', { name: 'Add' });
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'Display Name').fill('QA CO pending date');
    await field(dlg, 'License #').fill('QA-CO-UNKNOWN');
    await field(dlg, 'State').selectOption('CO');
    await dlg.getByRole('checkbox', { name: 'Expiration date not yet known' }).check();
    await field(dlg, 'Status source').fill('QA Colorado board email 9/29');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 });
    await page.getByRole('button', { name: 'Add' }).first().click();
    dlg = page.getByRole('dialog', { name: 'Add' });
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'Display Name').fill('QA UT awaiting confirmation');
    await field(dlg, 'License #').fill('QA-UT-PENDING');
    await field(dlg, 'State').selectOption('UT');
    await field(dlg, /^Expires/).fill(day(20));
    await dlg.getByRole('button', { name: 'Pending confirmation', exact: true }).click().catch(async () => { await field(dlg, 'Status').selectOption({ label: 'Pending confirmation' }); });
    await field(dlg, 'Status source').fill('QA Utah licensing letter');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 });
    await sleep(2500);
    const co = row(`select id, date_unknown, lifecycle_status, status_source, expiration_date from public.licenses where user_id = '${profile.id}' and license_number = 'QA-CO-UNKNOWN'`);
    const ut = row(`select id, date_unknown, lifecycle_status, status_source, expiration_date from public.licenses where user_id = '${profile.id}' and license_number = 'QA-UT-PENDING'`);
    qa.check('licenses rows: date_unknown true (CO) and pending_confirmation with its date (UT), each with its source', co?.date_unknown === true && co.status_source === 'QA Colorado board email 9/29' && ut?.lifecycle_status === 'pending_confirmation' && ut.expiration_date === day(20), { co, ut });
    await home(page);
    const card = cardByTitle(page, /^Resolve missing information \(\d+\)/);
    const ct = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
    await qa.shot('resolve card');
    qa.check('the card lists both with their sources', /Resolve missing information \(2\)/.test(ct) && /Expiration date not yet known · Source: QA Colorado board email 9\/29/.test(ct) && /Pending confirmation · Source: QA Utah licensing letter/.test(ct), ct.slice(0, 400));
    const after = await homeTiles(page);
    const cmeLines = (await page.getByRole('button').filter({ hasText: /^(CO|UT) CME/ }).allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
    const ringSame = after.percent === before.percent && after.expiring === before.expiring && after.noDate === before.noDate;
    qa.check('neither counts in the ring or its tiles', ringSame && !cmeLines.length, JSON.stringify({ before, after, cmeLines }));
    if (!ringSame || cmeLines.length) {
      qa.bug({
        title: 'A license saved as "date not yet known" or "Pending confirmation" still lowers the ring: its state joins CME tracking and "<ST> CME review records" is listed as needing action',
        step: 'Add a Colorado license with "Expiration date not yet known" and a Utah license marked Pending confirmation (both with a status source); view Home',
        expected: 'Neither counts in the ring (the Resolve card lists them; "never an alert, never in the ring")',
        actual: `The ring went ${before.percent}% -> ${after.percent}% and the needs-action lines under it gained ${cmeLines.join(', ') || 'CME lines'}. compliance.js:457-463 trackedStates adds the state of any medical license that is not historical or superseded (pending and date-unknown included); findStateLicense (compliance.js:440-443) finds no alertable dated license there, so daysLeft is null, and standingScore (compliance.js:525) counts a null daysLeft as due`,
        severity: 'medium',
      });
    }
    qa.check('the pending license due in 20 days is not in Action Required', !(await actionCard(page, 'State Medical License — UT').count()));
    const dry = await runHook('send-reminders', { profile_id: profile.id, dry_run: true });
    const res = (dry.data?.results || [])[0] || {};
    qa.check('the daily reminder run names neither (dry run for this member)', dry.status === 200 && !/QA-UT|QA-CO|Utah|Colorado| UT| CO/.test(res.text || '') , JSON.stringify(res).slice(0, 300));
    await card.getByRole('button').filter({ hasText: 'State Medical License — CO' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit' });
    const opened = await edit.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await sleep(900);
    qa.check('"Resolve ›" opens that license\'s edit form on Expires', opened && (await field(edit, 'License #').inputValue().catch(() => '')) === 'QA-CO-UNKNOWN' && (await focusedFieldKey(page)) === 'expirationDate', `focused ${await focusedFieldKey(page)}`);
    await page.keyboard.press('Escape');
  }, { soft: true });

  await qa.feature('HOME-025', 'A state with a DEA but no medical license: warned on Home, the warning opens Licenses', async () => {
    await openCredentials(page, 'Licenses');
    await page.getByRole('button', { name: 'Add' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    await field(dlg, 'Type').selectOption('DEA Registration');
    await field(dlg, 'License #').fill('QA-DEA-WY');
    await field(dlg, 'State').selectOption('WY');
    await field(dlg, /^Expires/).fill(day(600));
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 });
    await sleep(2000);
    await home(page);
    const warn = page.getByRole('button', { name: /^WY: no medical license on file/ });
    const shown = await warn.isVisible().catch(() => false);
    await qa.shot('no license warning');
    qa.check('"WY: no medical license on file" appears under CME Progress', shown);
    qa.check('no warning for NM, where the medical license is on file', !(await page.getByRole('button', { name: /^NM: no medical license on file/ }).count()));
    if (shown) {
      await warn.click();
      await sleep(900);
      qa.check('the warning opens Credentials > Licenses', (await pageTitle(page)) === 'Credentials' && /Import from the NPI registry/.test(await bodyText(page)));
    }
  }, { soft: true });

  await qa.feature('HOME-011', 'Finish your profile: lists what is missing, opens Settings, disappears once filled', async () => {
    await home(page);
    const banner = cardByTitle(page, /^⚠️ Finish your profile/);
    const bt = (await banner.innerText().catch(() => '')).replace(/\s+/g, ' ');
    qa.check('with Tier 1 done and no specialty or NPI the banner lists exactly those', /Finish your profile — 2 things missing/.test(bt) && /Missing: board specialty .* · NPI\./.test(bt), bt.slice(0, 240));
    await banner.click();
    await sleep(900);
    qa.check('tapping it opens More > Profile & settings', await hasBackButton(page) && /board specialties/i.test(await bodyText(page)));
    await page.getByRole('button', { name: /^(\d+ certifications? selected|Select board certifications\.\.\.)/ }).click();
    await page.getByPlaceholder('Search boards, subspecialties...').fill('Neurological Surgery');
    await page.getByRole('button', { name: /^Neurological Surgery ABMS · ABNS/ }).first().click();
    await sleep(2500);
    // An NPI is saved only through the registry lookup (Settings "Find My NPI", or the number typed
    // on Licenses, NpiPanel.jsx:48-56 saves it once NPPES confirms it). The lab never calls the real
    // NPPES registry, so the journey saves the NPI through PostgREST, as the lookup would.
    const npi = syntheticNpi();
    const patched = await restAsPatch(user, `profiles?id=eq.${profile.id}`, { npi });
    qa.check('the NPI is saved (as the lookup would save it)', patched.status < 300, JSON.stringify(patched.data).slice(0, 160));
    await reloadApp(page);
    await home(page);
    const p = profileOf(user.id);
    qa.check('profiles.specialties and npi are filled', JSON.stringify(p.specialties || []).includes('ABMS:ABNS') && p.npi === npi, JSON.stringify({ specialties: p.specialties, npi: p.npi }));
    qa.check('the banner is gone', !/Finish your profile/.test(await bodyText(page)));
  }, { soft: true });

  await qa.feature('HOME-023', 'Credentials preview: toggle in Settings, up to 5 licenses with dot and days, row opens the detail, View All opens Credentials', async () => {
    await openMore(page, 'Profile & settings');
    const toggle = page.getByRole('switch', { name: 'Credentials list on Home' });
    await toggle.click();
    await sleep(2500);
    qa.check('profiles.show_dashboard_credentials is on', profileOf(user.id).show_dashboard_credentials === true);
    await reloadApp(page);
    await home(page);
    // The preview: its heading row (Credentials, View All) and the list under it.
    const section = page.getByRole('heading', { name: 'Credentials', exact: true }).locator('xpath=../..');
    const st = (await section.innerText().catch(() => '')).replace(/\s+/g, ' ');
    const licenseCount = rows(`select id from public.licenses where user_id = '${profile.id}'`).length;
    const shownRows = (st.match(/›/g) || []).length;
    await qa.shot('credentials preview');
    qa.check(`the preview lists 5 of the ${licenseCount} licenses`, licenseCount > 5 && shownRows === 5, st.slice(0, 400));
    qa.check('a dated license shows its expiry and days left', /Exp [A-Z][a-z]{2} \d{1,2}, \d{4} · \d[\d,]*d/.test(st), st.slice(0, 200));
    // The first row (the list keeps the records' order, retired ones last).
    const first = section.locator('div[style*="cursor: pointer"]').first();
    const firstText = (await first.innerText().catch(() => '')).replace(/\s+/g, ' ');
    const firstRow = rows(`select license_number, type, state from public.licenses where user_id = '${profile.id}'`).find((l) => firstText.startsWith(`${l.type} — ${l.state}`));
    await first.click();
    await sleep(1200);
    const view = page.getByRole('dialog').first();
    const vt = (await view.innerText().catch(() => '')).replace(/\s+/g, ' ');
    qa.check('a row opens that license\'s detail view (not the edit form)', !!firstRow && vt.includes(firstRow.license_number) && (await pageTitle(page)) !== 'Dashboard' && !(await page.getByRole('dialog', { name: 'Edit' }).count()), `${firstText.slice(0, 60)} -> ${vt.slice(0, 160)}`);
    await page.keyboard.press('Escape');
    await home(page);
    await section.getByRole('button', { name: 'View All' }).click();
    await sleep(900);
    qa.check('View All opens Credentials', (await pageTitle(page)) === 'Credentials');
  }, { soft: true });

  await qa.feature('HOME-026', 'All clear only when nothing is urgent; with an alert set aside it says so and when it returns', async () => {
    await home(page);
    let text = await bodyText(page);
    const needs = await page.getByRole('button').filter({ hasText: /no expiration date|days? left|review records/ }).allInnerTexts();
    const clear = /All Clear No renewals are due/.test(text);
    await qa.shot('all clear state');
    qa.check('nothing is due: the all-clear banner shows', clear, text.slice(-300));
    qa.check('the all-clear banner is not shown while the ring lists something that needs action', !(clear && needs.length), needs.map((n) => n.replace(/\s+/g, ' ')).join(' | '));
    if (clear && needs.length) {
      qa.bug({
        title: 'Home says "All Clear" while the ring beside it lists a record that needs action (a license with no expiration date)',
        step: 'A member with Tier 1 done and one undated license (from the registry import), nothing expiring: view Home',
        expected: 'All-clear only when nothing needs action',
        actual: `The ring lists "${needs[0].replace(/\s+/g, ' ')}" and the bottom banner says "All Clear. No renewals are due, and nothing is set aside." App.jsx:1940 shows allClear whenever urgent is empty; urgent counts only dated alerts, not standing.needsAction. Fixed on fix/qa-cred-home cf43aeba`,
        severity: 'low',
      });
    }
    // Something due: the banner goes. Acknowledge it: the banner names the set-aside item's return date.
    await seed(user, profile.id, 'licenses', [{ type: 'State Medical License', name: 'QA NV soon', license_number: 'QA-NV-25', state: 'NV', expiration_date: day(25) }]);
    await reloadApp(page);
    await home(page);
    qa.check('with a license due in 25 days the all-clear banner is gone', !/All Clear|Nothing to do today/.test(await bodyText(page)));
    await actionCard(page, 'State Medical License — NV').getByRole('button', { name: 'Acknowledge', exact: true }).click();
    const m = page.getByRole('dialog', { name: 'Acknowledge this alert' });
    await m.getByRole('button', { name: '2 weeks' }).click();
    await m.getByRole('button', { name: 'Acknowledge', exact: true }).click();
    await sleep(2500);
    const until = row(`select until from public.alert_acks where user_id = '${profile.id}' order by created_at desc limit 1`)?.until;
    await reloadApp(page);
    await home(page);
    text = await bodyText(page);
    const human = until ? new Date(`${until}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'none';
    await qa.shot('set aside banner');
    qa.check('with the alert set aside the banner says so and when it comes back', /Nothing to do today 1 item you set aside, back on/.test(text) && text.includes(human), (text.match(/Nothing to do today[^.]*\./) || [text.slice(-200)])[0]);
    // By design the banner names the count and the return date, not the record (utils/clearState.js).
    qa.check('it is not labelled All Clear while something is only set aside', !/All Clear/.test(text));
  }, { soft: true });
});
