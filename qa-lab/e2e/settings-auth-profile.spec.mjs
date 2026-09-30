// Profile & settings, used the way a member tunes their account: the birth
// month and day the CME Passport card hands to a CME provider, the licensed
// states behind Home's CME cards and the Multi-State Matrix, the CME
// requirements and their "Find" links, the AI choices and own keys (which must
// stay on the device), the sign-in card, then appearance, dashboard and
// notification preferences across a reload and a second browser, and the five
// text sizes against the desk layout. Server effects are read from the local
// profiles row; nothing leaves this machine.
import { test } from './support/fixtures.mjs';
import {
  field, goTab, landing, lab, newMember, openCredentials, openMore, profileOf, restAs, rows, signIn, sleep,
} from './support/lab.mjs';
import { openSettings, reloadApp, settingsCard } from './support/settings-auth-helpers.mjs';

const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

async function passportFields(page) {
  await openCredentials(page, 'CME Credits');
  const header = page.getByRole('button', { name: /ACCME CME Passport/ });
  await header.waitFor({ timeout: 20000 });
  const summary = (await header.innerText()).replace(/\s+/g, ' ');
  if (/Open$/.test(summary.trim())) await header.click();
  const birthday = await page.locator('div').filter({ has: page.getByText('Birth month and day', { exact: true }) }).last().innerText().catch(() => '');
  return { summary, birthday: birthday.replace(/\s+/g, ' ').replace('Birth month and day', '').trim() };
}

test('settings: birth month and day, licensed states, CME requirements, AI keys stay on the device, sign-in card', {
  tag: ['@SETTINGS-008', '@SETTINGS-009', '@SETTINGS-016', '@SETTINGS-015', '@AUTH-010', '@AUTH-012'],
}, async ({ page, qa, secondBrowser }) => {
  test.setTimeout(10 * 60 * 1000);
  const { user } = await newMember(page, { firstName: 'Bea', lastName: 'Birthday' });

  await qa.feature('SETTINGS-008', 'Birth month and day: "July 25" is read, survives a reload, and the CME Passport card shows it', async () => {
    await openSettings(page);
    const box = page.locator('input[name="birthMonthDay"]');
    await box.fill('July 25');
    const read = await page.getByText('Read as July 25. The year is not stored.').isVisible().catch(() => false);
    qa.check('the field confirms "Read as July 25"', read);
    await box.blur();
    await sleep(2500);
    const before = await passportFields(page);
    qa.check('before a reload the Passport card shows it', /July 25/.test(before.birthday), JSON.stringify(before));
    await reloadApp(page);
    await openSettings(page);
    const kept = await page.locator('input[name="birthMonthDay"]').inputValue();
    const after = await passportFields(page);
    await qa.shot('passport after reload');
    const cols = rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name like '%birth%'`);
    qa.check('after an online reload Settings still shows July 25', kept === 'July 25', `field reads "${kept}"`);
    qa.check('after an online reload the Passport card still has the birthday', /July 25/.test(after.birthday), JSON.stringify(after));
    if (kept !== 'July 25' || !/July 25/.test(after.birthday)) {
      qa.bug({
        title: 'Birth month and day is lost on the next online load; the CME Passport card then says it is missing',
        step: 'Profile & settings > Birth Month and Day: "July 25" ("Read as July 25"); reload the app online; reopen Settings and CME Credits > ACCME CME Passport',
        expected: 'The field still reads July 25 and the Passport card shows it',
        actual: `Settings shows "${kept}", the Passport card reads "${after.birthday}" (${after.summary}). birthMonthDay is only in DEFAULT_SETTINGS (src/constants/defaults.js:15) and SettingsSection; it is not in SETTINGS_TO_PROFILE (src/lib/supabase.js:274), there is no profiles column (${cols.length ? cols.map((c) => c.column_name).join(', ') : 'no *birth* column'}), and it is not in LOCAL_ONLY_SETTINGS (src/lib/supabase.js:392), so every online load rebuilds settings without it`,
        severity: 'medium',
      });
    }
  }, { soft: true });

  await qa.feature('SETTINGS-009', 'Licensed states: add two, Set Primary, remove one; Home CME cards and the Matrix follow and it persists', async () => {
    // A license in NV, so one tracked state comes from a license rather than the list.
    await openCredentials(page, 'Licenses');
    await page.getByRole('button', { name: 'Add' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'License #').fill('QA-STATES-NV1');
    await field(dlg, 'State').selectOption('NV');
    await field(dlg, /^Expires/).fill('2028-12-31');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 });
    await openSettings(page);
    const card = settingsCard(page, 'Licensed States');
    await page.getByRole('button', { name: 'MD Doctor of Medicine', exact: true }).click();
    for (const st of ['FL', 'TX']) {
      await card.locator('select').selectOption(st);
      await card.getByRole('button', { name: 'Add', exact: true }).click();
      await sleep(600);
    }
    const stateRow = (st) => card.locator('div').filter({ has: page.locator('span', { hasText: new RegExp(`^${st}$`) }) }).filter({ has: page.getByRole('button') }).last();
    await stateRow('FL').getByRole('button', { name: 'Set Primary' }).click();
    await sleep(800);
    // The ✕ is named for its state (43341dc1).
    await stateRow('TX').getByRole('button', { name: 'Stop tracking TX', exact: true }).click();
    await sleep(2500);
    const p = profileOf(user.id);
    qa.check('profiles.primary_state FL; TX removed from additional_states', p.primary_state === 'FL' && !(p.additional_states || []).includes('TX'), JSON.stringify({ primary: p.primary_state, additional: p.additional_states }));
    // The license-held state: its ✕ must remove it or not be offered.
    const nvRemove = stateRow('NV').getByRole('button', { name: 'Stop tracking NV', exact: true });
    if (await nvRemove.count()) {
      await nvRemove.click();
      await sleep(1500);
      const still = await stateRow('NV').count();
      qa.check('a ✕ that is offered removes the state (NV, held by a license)', !still, still ? 'NV is still listed after ✕' : 'removed');
      if (still) {
        qa.bug({
          title: 'Licensed States: the ✕ beside a state that comes from a license does nothing',
          step: 'Credentials: add a NV medical license. Profile & settings > Licensed States: tap ✕ on NV',
          expected: 'Either NV is removed, or no ✕ is offered and the row says why it is tracked',
          actual: 'NV stays listed and nothing is said. removeState only edits additionalStates (src/components/pages/SettingsSection.jsx:147-156), and allTrackedStates re-adds every state a current license carries, so the button can never work; it is rendered for every row when more than one state is tracked (line 519)',
          severity: 'low',
        });
      }
    } else qa.check('no ✕ is offered on a license-held state', true);
    await reloadApp(page);
    await openSettings(page);
    const statesCard = settingsCard(page, 'Licensed States');
    const listed = (await statesCard.innerText()).replace(/\s+/g, ' ').replace(/Add a state\.\.\..*$/, '');
    const shownStates = await statesCard.locator('span').filter({ hasText: /^[A-Z]{2}$/ }).allInnerTexts();
    qa.check('after a reload: FL is primary, NV tracked, TX gone', /FL Primary/i.test(listed) && shownStates.includes('NV') && !shownStates.includes('TX'), `${shownStates.join(', ')}: ${listed.slice(0, 160)}`);
    await goTab(page, 'Home');
    await sleep(1500);
    const home = await text(page);
    qa.check('Home has CME cards for FL and NV and none for TX', await page.locator('span', { hasText: /^FL$/ }).count() > 0 && await page.locator('span', { hasText: /^NV$/ }).count() > 0 && !(await page.locator('span', { hasText: /^TX$/ }).count()), home.match(/CME Progress.{0,200}/)?.[0]);
    await openCredentials(page, 'Multi-State Matrix');
    await sleep(1000);
    const matrix = await text(page);
    await qa.shot('matrix');
    qa.check('the Multi-State Matrix lists FL and NV, not TX', /\bFL\b/.test(matrix) && /\bNV\b/.test(matrix) && !/\bTX\b/.test(matrix), matrix.slice(0, 240));
  }, { soft: true });

  await qa.feature('SETTINGS-016', 'CME Requirements: per-state rules; "Find" on a mandatory topic opens Find CME filtered to it', async () => {
    await openSettings(page);
    const req = settingsCard(page, 'CME Requirements (MD)');
    await req.waitFor({ timeout: 15000 });
    const body = (await req.innerText()).replace(/\s+/g, ' ');
    qa.check('the requirements show each tracked state with hours and its mandatory topics', /FL PRIMARY/.test(body) && /Mandatory Topics/i.test(body) && /HIV\/AIDS/.test(body), body.slice(0, 200));
    const topicRow = req.locator('div').filter({ has: page.getByText('HIV/AIDS', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Find' }) }).last();
    await topicRow.getByRole('button', { name: 'Find' }).click();
    await page.getByRole('heading', { name: 'Find CME Courses' }).waitFor({ timeout: 15000 });
    const filtered = await text(page);
    const count = Number((/(\d+) providers?/.exec(filtered) || [])[1]);
    const chip = page.getByRole('button', { name: 'HIV/AIDS', exact: true }).first();
    const chipOn = await chip.evaluate((b) => getComputedStyle(b).color === 'rgb(255, 255, 255)').catch(() => false);
    await qa.shot('find cme filtered');
    qa.check('Find CME opens with the HIV/AIDS topic selected and providers listed', chipOn && count > 0 && !/No providers match/.test(filtered), `${count} providers, chip ${chipOn ? 'selected' : 'not selected'}`);
    // A topic no listed provider carries (PA's Organ and Tissue Donation).
    await openSettings(page);
    const lic = settingsCard(page, 'Licensed States');
    await lic.locator('select').selectOption('PA');
    await lic.getByRole('button', { name: 'Add', exact: true }).click();
    await sleep(800);
    const req2 = settingsCard(page, 'CME Requirements (MD)');
    const organ = req2.locator('div').filter({ has: page.getByText('Organ and Tissue Donation', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Find' }) }).last();
    if (await organ.count()) {
      await organ.getByRole('button', { name: 'Find' }).click();
      await page.getByRole('heading', { name: 'Find CME Courses' }).waitFor({ timeout: 15000 });
      const empty = await text(page);
      await qa.shot('find cme no provider');
      const deadEnd = /No providers match your filters/.test(empty) && !/board|Board/.test(empty.match(/No providers match[^]*$/)?.[0]?.slice(0, 300) || '');
      qa.check('a topic no listed provider carries still leads somewhere (not only "No providers match your filters")', !deadEnd, empty.match(/No providers match[^.]*\./)?.[0] || 'providers or a board link shown');
      if (deadEnd) {
        qa.bug({
          title: 'Find on a mandatory topic no listed provider carries opens an empty list ("No providers match your filters") with no way to meet the requirement',
          step: 'Profile & settings: track PA (MD). CME Requirements > PA > Organ and Tissue Donation > Find',
          expected: 'Find CME filtered to the topic, and for a topic no provider carries, where to get it (the board page)',
          actual: 'Find CME Courses, 0 providers, "No providers match your filters. Try adjusting your search or filters." The filter is the topic itself (src/components/features/CMEResourcesSection.jsx:98-99), and 13 MD topics across PA, CT, IL, KY, MA, MO, NV, IA, LA and DE have no provider in src/constants/cmeProviders.js',
          severity: 'low',
        });
      }
    }
  }, { soft: true });

  await qa.feature('SETTINGS-015', 'AI: model choices and own keys persist on this device only; keys never reach the profile', async () => {
    const sent = [];
    page.on('request', (r) => { const b = r.postData() || ''; if (/QAsynth/.test(b) || /QAsynth/.test(r.url())) sent.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await openSettings(page);
    const coder = page.locator('label', { hasText: 'Code RVUs with' }).locator('xpath=..').locator('select');
    const vera = page.locator('label', { hasText: 'Vera answers with' }).locator('xpath=..').locator('select');
    await coder.selectOption('gemini');
    await vera.selectOption('opus');
    const gem = page.getByPlaceholder('AIza... or AQ....');
    const ant = page.getByPlaceholder('sk-ant-...');
    await gem.fill('AIzaQAsynth-lab-01');
    await ant.fill('sk-ant-QAsynth1');
    await sleep(2500);
    qa.check('the Gemini key hint says it is saved on this device only', await page.getByText(/Saved ✓ on this device only\. Your calls run on this key/).isVisible().catch(() => false));
    await reloadApp(page);
    await openSettings(page);
    const kept = { coder: await coder.inputValue(), vera: await vera.inputValue(), gem: await gem.inputValue(), ant: await ant.inputValue() };
    qa.check('after a reload the choices and keys are still there on this device', kept.coder === 'gemini' && kept.vera === 'opus' && kept.gem === 'AIzaQAsynth-lab-01' && kept.ant === 'sk-ant-QAsynth1', JSON.stringify({ ...kept, gem: kept.gem.slice(0, 10), ant: kept.ant.slice(0, 10) }));
    const p = profileOf(user.id);
    qa.check('profiles.api_key and anthropic_api_key stay null', p.api_key === null && p.anthropic_api_key === null, JSON.stringify({ api_key: p.api_key ? 'set' : null, anthropic_api_key: p.anthropic_api_key ? 'set' : null }));
    qa.check('no request carried either key', sent.length === 0, sent.join(', '));
    const other = await secondBrowser();
    await signIn(other.page, user);
    await landing(other.page);
    await openSettings(other.page);
    const there = { gem: await other.page.getByPlaceholder('AIza... or AQ....').inputValue(), ant: await other.page.getByPlaceholder('sk-ant-...').inputValue() };
    qa.check('another browser has no keys (device-only)', !there.gem && !there.ant, JSON.stringify(there));
    await other.context.close();
    await gem.fill('');
    await ant.fill('');
    await sleep(2000);
    await reloadApp(page);
    await openSettings(page);
    qa.check('cleared keys stay cleared after a reload', !(await gem.inputValue()) && !(await ant.inputValue()));
    const slot = await page.evaluate((id) => localStorage.getItem(`credentialdomd-device-keys:${id}`), user.id);
    qa.check('the device slot holds no key any more', !/QAsynth/.test(slot || ''), (slot || 'empty').slice(0, 80));
  }, { soft: true });

  await qa.feature('AUTH-010', 'Sign-in methods card: shown only when SMS sign-in is enabled (off in the production build)', async () => {
    await openSettings(page);
    const heading = await page.getByRole('heading', { name: 'Sign-in methods' }).count();
    const manage = await page.getByRole('button', { name: 'Manage sign-in methods' }).count();
    qa.check('the production switches (VITE_SMS_SIGN_IN_ENABLED unset) hide the card', heading === 0 && manage === 0, `${heading} heading(s), ${manage} button(s)`);
  }, { soft: true });

  await qa.feature('AUTH-012', 'A member can change their password or sign-in email from the app, or Help says how', async () => {
    await openSettings(page);
    const settingsText = await text(page);
    const controls = await page.getByRole('button', { name: /password|sign-in|sign in|account security|manage account/i }).count();
    const links = await page.getByRole('link', { name: /password|sign-in|account security|manage account/i }).count();
    qa.check('Settings offers a way to change the password or sign-in email', controls + links > 0, `${controls} button(s), ${links} link(s); Settings mentions: ${(settingsText.match(/[^.]*(password|sign-in)[^.]*\./gi) || []).slice(0, 2).join(' | ') || 'neither word'}`);
    // The Password and sign-in email card (d2bf73b0): its button opens Clerk's own account
    // screen (openUserProfile). The lab's Clerk stand-in has no such screen and says so in an
    // alert, which is how the journey sees that the tap reached it.
    const change = page.getByRole('button', { name: 'Change password or sign-in email', exact: true });
    if (await change.count()) {
      const seen = qa.report.dialogs.length;
      await change.click();
      await sleep(1000);
      const opened = qa.report.dialogs.slice(seen);
      qa.check('"Change password or sign-in email" opens the account screen (Clerk openUserProfile)', opened.some((d) => /no Clerk account screen/.test(d)) && !(await page.getByRole('alert').filter({ hasText: /could not open|sign-in changed/i }).count()), opened.join(' | ') || 'nothing opened');
    }
    await openMore(page, 'Help & FAQ');
    await sleep(800);
    const faq = await text(page);
    const faqSays = /password|sign-in email|change (your|the) (sign-in )?email/i.test(faq);
    await qa.shot('help faq');
    // The checklist asks for a control OR a Help answer: Help must say how only when Settings offers no way.
    if (controls + links === 0) qa.check('Help & FAQ says how to change them (Settings offers no way)', faqSays, faqSays ? '' : 'no mention of a password or the sign-in email');
    if (controls + links === 0 && !faqSays) {
      qa.bug({
        title: 'No way to change the password or the sign-in email from inside the app, and Help does not say how',
        step: 'More > Profile & settings (whole page) and More > Help & FAQ, as a full member',
        expected: 'A control that opens the account screen (password, sign-in email), or Help that says exactly how',
        actual: 'Neither: SignInMethodsCard returns null unless VITE_SMS_SIGN_IN_ENABLED is "true" (src/components/pages/SignInMethodsCard.jsx:35; src/utils/signInMethods.js:3), which the production deploy does not set (.github/workflows/deploy-gh-pages.yml), and no other component calls openUserProfile or renders a Clerk account button. The profile Email field is only a contact address. FAQ has no sign-in answer',
        severity: 'medium',
      });
    }
  }, { soft: true });
});

test('settings: appearance, dashboard, notifications follow the account; text sizes and the desk layout', {
  tag: ['@SETTINGS-014', '@SETTINGS-013'],
}, async ({ page, context, qa, secondBrowser }) => {
  test.setTimeout(10 * 60 * 1000);
  await context.grantPermissions(['notifications'], { origin: lab().urls.appOrigin });
  const { user, profile } = await newMember(page, { firstName: 'Theo', lastName: 'Theme' });
  const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('#root > div') || document.body).backgroundColor);

  await qa.feature('SETTINGS-014', 'Theme, text size, Home credentials list, notification switches and frequency: applied at once and saved', async () => {
    // A license so Home has a credentials list to show.
    await restAs(user, 'licenses', { method: 'POST', body: { user_id: profile.id, type: 'State Medical License', name: 'AZ Medical License', license_number: 'QA-THEME-AZ1', state: 'AZ', expiration_date: '2028-06-30' } });
    await reloadApp(page);
    await openSettings(page);
    const appearance = settingsCard(page, 'Appearance');
    const storedTheme = profileOf(user.id).theme;
    const label0 = (await appearance.innerText()).match(/(Dark|Light) Mode/)?.[0];
    const bg0 = await bg();
    const themeSwitch = appearance.locator('button').first();
    await themeSwitch.click();
    await sleep(1500);
    const bg1 = await bg();
    const theme1 = profileOf(user.id).theme;
    await qa.shot('after first theme tap');
    qa.check('the first tap on the theme switch changes the screen at once', bg1 !== bg0, JSON.stringify({ storedBefore: storedTheme, labelBefore: label0, bgBefore: bg0, bgAfter: bg1, storedAfter: theme1 }));
    if (bg1 === bg0) {
      qa.bug({
        title: 'A new account\'s first tap on the theme switch changes nothing on screen (the profile starts as theme "arctic")',
        step: 'New member: Profile & settings > Appearance; tap the theme switch once',
        expected: 'The theme flips at once (dark to light)',
        actual: `The page stays dark; profiles.theme goes from "${storedTheme}" to "${theme1}". New profiles get the column default 'arctic' (profiles.theme default), which THEMES does not have, so the app renders dark (src/context/AppContext.jsx:648), but Settings shows "${label0}" with the switch off because it tests theme === "dark" (src/components/pages/SettingsSection.jsx:552-556), and toggleTheme computes 'arctic' === 'dark' ? 'light' : 'dark' and saves "dark" (src/context/AppContext.jsx:655)`,
        severity: 'low',
      });
      await themeSwitch.click();
      await sleep(1500);
    }
    const bgLight = await bg();
    qa.check('the theme is now light and saved', profileOf(user.id).theme === 'light', `${profileOf(user.id).theme}, background ${bgLight}`);
    await page.getByRole('button', { name: 'Aa L', exact: true }).click();
    const zoom = await page.evaluate(() => [...document.querySelectorAll('div')].map((d) => d.style.zoom).find((z) => z && z !== '1'));
    qa.check('text size L applies at once (content zoom 1.1)', zoom === '1.1', `zoom ${zoom}`);
    const dash = page.getByRole('switch', { name: 'Credentials list on Home' });
    await dash.click();
    const email = page.getByRole('switch', { name: 'Email reminders' });
    const textSw = page.getByRole('switch', { name: 'Text Notifications' });
    const browserSw = page.getByRole('switch', { name: 'Browser Notifications' });
    await email.click();
    const textBefore = await textSw.getAttribute('aria-checked');
    await textSw.click();
    const enable = page.getByRole('button', { name: 'Enable', exact: true });
    const browserState = await page.evaluate(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
    if (!(await browserSw.count()) && await enable.count()) { await enable.click(); await sleep(1000); }
    const hasBrowser = await browserSw.count();
    if (hasBrowser) await browserSw.click();
    if (browserState === 'denied') {
      // Headless Chromium answers "denied" whatever the context grants; the app must then say so rather than offer a dead switch.
      qa.check('with notifications blocked by the browser, the row says how to allow them', /Blocked\. Allow notifications/.test(await page.locator('body').innerText()), 'permission denied in the lab browser');
    } else qa.check('Browser Notifications offers a switch once the browser allows notifications', hasBrowser > 0, `permission ${browserState}`);
    await page.getByRole('button', { name: 'Biweekly', exact: true }).click();
    await sleep(3000);
    const p = profileOf(user.id);
    qa.check('profiles: theme light, font_size L, show_dashboard_credentials true, notify_email false, notify_text flipped, notify_browser off, notify_freq_days 14',
      p.theme === 'light' && p.font_size === 'L' && p.show_dashboard_credentials === true && p.notify_email === false && String(p.notify_text) !== String(textBefore === 'true') && (!hasBrowser || p.notify_browser === false) && p.notify_freq_days === 14,
      JSON.stringify({ theme: p.theme, font: p.font_size, dash: p.show_dashboard_credentials, email: p.notify_email, text: p.notify_text, textBefore, browser: p.notify_browser, browserSwitch: hasBrowser, freq: p.notify_freq_days }));
    await goTab(page, 'Home');
    qa.check('Home shows the credentials list at once', await page.getByRole('button', { name: 'View All' }).first().isVisible().catch(() => false));
  }, { soft: true });

  await qa.feature('SETTINGS-014', 'They survive a reload and follow the account to a second browser', async () => {
    const want = profileOf(user.id);
    const check = async (pg, where) => {
      await openSettings(pg);
      const appearance = (await settingsCard(pg, 'Appearance').innerText()).replace(/\s+/g, ' ');
      const zoom = await pg.evaluate(() => [...document.querySelectorAll('div')].map((d) => d.style.zoom).find((z) => z && z !== '1'));
      const sw = async (name) => pg.getByRole('switch', { name }).getAttribute('aria-checked').catch(() => null);
      const freqOn = await pg.getByRole('button', { name: 'Biweekly', exact: true }).evaluate((b) => getComputedStyle(b).color === 'rgb(255, 255, 255)').catch(() => false);
      const got = { mode: appearance.match(/(Dark|Light) Mode/)?.[0], zoom, dash: await sw('Credentials list on Home'), email: await sw('Email reminders'), text: await sw('Text Notifications'), freqBiweekly: freqOn };
      qa.check(`${where}: light mode, text size L, Home list on, email off, text as saved, Biweekly`,
        got.mode === 'Light Mode' && got.zoom === '1.1' && got.dash === 'true' && got.email === 'false' && got.text === String(want.notify_text === true) && got.freqBiweekly, JSON.stringify(got));
    };
    await reloadApp(page);
    await check(page, 'after a reload');
    const other = await secondBrowser();
    await signIn(other.page, user);
    await landing(other.page);
    await check(other.page, 'in a second browser');
    await other.page.screenshot({ path: (await qa.shot('second browser settings')).replace(/\.png$/, '-second.png'), fullPage: false });
    await other.context.close();
  }, { soft: true });

  await qa.feature('SETTINGS-013', 'Text sizes S to XXL: Home, the Licenses desk table (sticky header under the top bar) and a form all fit', async () => {
    // Enough licenses for the desk table to scroll under the top bar.
    const many = Array.from({ length: 24 }, (_, i) => ({ user_id: profile.id, type: 'State Medical License', name: `QA Zoom License ${i + 1}`, license_number: `QA-ZOOM-${String(i + 1).padStart(2, '0')}`, state: ['CO', 'NM', 'UT', 'OR', 'WA', 'ID'][i % 6], expiration_date: `2029-0${(i % 9) + 1}-15` }));
    const ins = await restAs(user, 'licenses', { method: 'POST', body: many });
    qa.check('24 licenses on file for the table', ins.status === 201, `${ins.status}`);
    await reloadApp(page);
    const problems = [];
    const stickyGeo = {};
    for (const size of ['S', 'M', 'L', 'XL', 'XXL']) {
      await openSettings(page);
      await page.getByRole('button', { name: `Aa ${size}`, exact: true }).click();
      await sleep(600);
      await goTab(page, 'Home');
      await sleep(800);
      const homeOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (homeOverflow > 1) problems.push(`${size} Home scrolls sideways by ${homeOverflow}px`);
      await openCredentials(page, 'Licenses');
      await page.getByRole('row').filter({ hasText: 'QA-ZOOM-24' }).first().waitFor({ timeout: 15000 });
      await page.evaluate(() => window.scrollTo(0, 900));
      await sleep(500);
      const geo = await page.evaluate(() => {
        // The top bar (Back, bell, theme) is the sticky div at top 0; the desk table's header row hangs under it.
        const bar = [...document.querySelectorAll('div')].find((d) => getComputedStyle(d).position === 'sticky' && getComputedStyle(d).top === '0px' && d.getBoundingClientRect().height >= 50);
        const th = document.querySelector('th');
        const b = bar?.getBoundingClientRect(); const t = th?.getBoundingClientRect();
        const clipper = (() => { for (let e = bar?.parentElement; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.overflowX !== 'visible' && s.overflowX !== 'clip') return `${e.className || e.tagName} overflow-x:${s.overflowX}`; } return null; })();
        // The first license row: are its number and its expiration date cut short?
        const heads = [...document.querySelectorAll('th')].map((h) => h.textContent.trim());
        const first = [...document.querySelectorAll('tbody tr')].find((r) => r.cells.length === heads.length);
        const cell = (label) => { const i = heads.findIndex((h) => h.startsWith(label)); const c = i >= 0 && first ? first.cells[i] : null; return c ? { text: c.textContent.trim(), cut: c.scrollWidth > c.clientWidth + 1, width: Math.round(c.getBoundingClientRect().width) } : null; };
        return { barTop: b ? Math.round(b.top) : null, barBottom: b ? Math.round(b.bottom) : null, thTop: t ? Math.round(t.top) : null, scrolled: Math.round(window.scrollY), overflowX: document.documentElement.scrollWidth - window.innerWidth, clipper,
          number: cell('Number'), expires: cell('Expires'), type: cell('Type') };
      });
      if (geo.barTop !== 0) problems.push(`${size} the top bar scrolled away (top ${geo.barTop}px after scrolling ${geo.scrolled}px)`);
      const headerOk = geo.thTop != null && (geo.barTop === 0 ? Math.abs(geo.thTop - geo.barBottom) <= 2 : false);
      if (!headerOk) problems.push(`${size} table header at ${geo.thTop}px, not under the top bar (bar ${geo.barTop}..${geo.barBottom}px)`);
      stickyGeo[size] = geo;
      for (const [name, c] of [['license number', geo.number], ['expiration date', geo.expires]]) {
        if (c?.cut) problems.push(`${size} the ${name} "${c.text}" is cut short in a ${c.width}px column`);
      }
      if (geo.overflowX > 1) problems.push(`${size} Licenses scrolls sideways by ${geo.overflowX}px`);
      // What the physician sees after scrolling (a full-page capture would hide the scroll).
      const viewShot = (await qa.shot(`${size} licenses`)).replace(/\.png$/, '-scrolled.png');
      await page.screenshot({ path: viewShot, fullPage: false });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole('button', { name: 'Add' }).first().click();
      const dlg = page.getByRole('dialog', { name: 'Add' });
      await dlg.waitFor({ timeout: 10000 });
      await sleep(400);
      const fit = await dlg.evaluate((d) => { const r = d.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, vh: window.innerHeight }; });
      const addBtn = dlg.getByRole('button', { name: 'Add', exact: true });
      await addBtn.scrollIntoViewIfNeeded().catch(() => {});
      const btn = await addBtn.boundingBox();
      const titleBox = await dlg.getByRole('heading').first().boundingBox().catch(() => null);
      if (fit.top < 0 || fit.bottom > fit.vh + 1 || fit.left < 0 || fit.right > fit.vw + 1) problems.push(`${size} form spills outside the window ${JSON.stringify(fit)}`);
      if (!btn || btn.y < 0 || btn.y + btn.height > fit.vh + 1) problems.push(`${size} form's Add button cannot be brought into view ${JSON.stringify(btn)}`);
      if (titleBox && (titleBox.y < 0)) problems.push(`${size} form title is clipped`);
      await dlg.getByRole('button', { name: 'Close dialog' }).click();
      await dlg.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    }
    qa.check('at every size nothing overlaps or clips (header under the bar, no sideways scroll, form fits)', problems.length === 0, problems.join(' | '));
    const cut = Object.entries(stickyGeo).filter(([, g]) => g.number?.cut || g.expires?.cut);
    if (cut.length) {
      const [k, g] = cut.find(([size]) => size === 'M') || cut[0];
      qa.bug({
        title: 'Desk width (1280 px): the Licenses table cuts the license number and the expiration date short, even at the default text size',
        step: 'Desk width 1280 x 900, Text Size M (and each other size): Credentials > Licenses',
        expected: 'The number and the full expiration date (with its year) readable in the table',
        actual: `At ${k}: ${[g.number?.cut && `the number "${g.number.text}" in a ${g.number.width}px column`, g.expires?.cut && `the expiration "${g.expires.text}" in a ${g.expires.width}px column`].filter(Boolean).join(' and ')} ellipsized (cut at sizes ${cut.map(([size]) => `${size} (number ${cut.find(([x]) => x === size)[1].number?.width}px)`).join(', ')}). The desk columns (src/App.jsx:2273-2284) give State 9%, Issued 12%, Expires 13%, Status 12%, Cost 9% plus a 122 px actions column, so Type and Number share what is left of a table that sits beside the 240 px side nav and the Credentials rail; DeskTable's fixed layout then ellipsizes (src/components/shared/DeskTable.jsx:57-60, td style)`,
        severity: 'medium',
      });
    }
    const lost = Object.entries(stickyGeo).filter(([, g]) => g.barTop !== 0).map(([k]) => k);
    if (lost.length) {
      qa.bug({
        title: 'Desk width: the top bar, the desk table\'s header row and the Credentials rail are not sticky; they scroll away with the page',
        step: 'Desk width (1280 x 900), any text size: Credentials > Licenses with about 25 licenses; scroll down',
        expected: 'The top bar (Back, bell, theme) stays at the top and the table header hangs under it (DeskTable.jsx:61-64 says it does)',
        actual: `After scrolling, the top bar is at ${stickyGeo[lost[0]].barTop}px and the header row at ${stickyGeo[lost[0]].thTop}px, off screen, at sizes ${lost.join(', ')}. The sticky elements (App.jsx:2851 top bar, DeskTable.jsx:128 th, App.jsx:2395 rail) sit inside .cmd-content-area, which has overflow-x: hidden (src/styles/base.css:453; #root and body were already moved to overflow-x: clip for this very reason, base.css:16-39); that makes it a scroll container (overflow-y computes to auto) that never scrolls itself, so position: sticky pins to it instead of the window (${stickyGeo[lost[0]].clipper}). Checked in the lab browser: with .cmd-content-area set to overflow-x: clip the bar stays at 0 px and the header row at 56 px after the same scroll`,
        severity: 'medium',
      });
    }
    await openSettings(page);
    await page.getByRole('button', { name: 'Aa M', exact: true }).click();
    await sleep(1500);
    qa.check('the last choice is saved (font_size M)', profileOf(user.id).font_size === 'M');
  }, { soft: true });
});
