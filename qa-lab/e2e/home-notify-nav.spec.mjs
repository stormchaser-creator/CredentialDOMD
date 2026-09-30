// Getting around the app and following what it hands off, as a member does
// at both widths: the desk sidebar and the Credentials rail, the top bar
// (avatar, bell and its count, the theme switch), the desk keyboard keys and
// the phone's bottom tab bar; then Home search handing a question to Vera,
// the To do widget, the cases the RVU log leaves to complete, the reminder and
// state-guide emails read link by link, the More menu for a member and for
// the owner, and the links emails carry (#support, #backups, #requests).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, emailBody, emails, goTab, lab, labExec, lit, makeAdmin, openCredentials, openMore, profileOf, row, rows, scriptAi, sleep, stamp, waitFor,
} from './support/lab.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import {
  bodyText, day, eventually, hasBackButton, home, mailShot, memberWithPlace, pageTitle, phoneBar, reloadApp, runHook, seed, setWidth, topBarAvatar, topBarIcons,
} from './support/home-notify-helpers.mjs';

/** The page's background colour, as rgb numbers (the first opaque layer behind the content). */
async function appBackground(page) {
  return page.evaluate(() => {
    let el = document.querySelector('.cmd-content-area') || document.body;
    while (el) {
      const c = getComputedStyle(el).backgroundColor;
      const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(c);
      if (m && (m[4] === undefined || Number(m[4]) > 0.5)) return { rgb: c, lum: (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 };
      el = el.parentElement;
    }
    return { rgb: 'none', lum: NaN };
  });
}

const sidebar = (page) => page.locator('nav.cmd-sidebar');

/** The reply-to address each email function names in its own source (the owner's mailbox). */
const replyToIn = (fn) => (readFileSync(path.join(REPO_ROOT, 'supabase', 'functions', fn, 'index.ts'), 'utf8').match(/reply_to: "([^"]+)"/) || [])[1] || null;
const OWNER_REPLY_TO = replyToIn('send-reminders');
const GUIDE_REPLY_TO = replyToIn('send-guide');

/** The support sheet (not a dialog element) is open on its "Your tickets" tab. */
async function supportSheetOnTickets(page) {
  const tabBtn = page.getByRole('button', { name: 'Your tickets', exact: true });
  if (!(await tabBtn.waitFor({ timeout: 10000 }).then(() => true, () => false))) return false;
  const active = await tabBtn.evaluate((el) => !!el.style.boxShadow && el.style.boxShadow !== 'none');
  // The list loads after the sheet opens.
  const list = await page.getByText(/No tickets yet\. Anything you send from New ticket shows up here\./).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  return active && list;
}
const rail = (page) => page.getByRole('navigation').filter({ hasText: 'Active Credentials' });
const railEntry = (page, label) => rail(page).getByRole('button', { name: new RegExp(`^(\\S+ )?${label}\\b`) }).first();

test('desk and phone: sidebar, rail, top bar, keys, tab bar', {
  tag: ['@HOME-006', '@HOME-005', '@HOME-019', '@HOME-004'],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { user, profile } = await memberWithPlace(page, { firstName: 'Nadia', lastName: 'Navigate' });
  // One license due in 20 days (an alert), one far off, one CME entry.
  await seed(user, profile.id, 'licenses', [
    { type: 'State Medical License', name: 'QA Nav Texas License', license_number: 'QA-NAV-TX', state: 'TX', expiration_date: day(20) },
    { type: 'DEA Registration', name: 'QA Nav DEA', license_number: 'QA-NAV-DEA', state: 'TX', expiration_date: day(500) },
  ]);
  await seed(user, profile.id, 'cme', [{ title: 'QA Nav grand rounds', category: 'AMA PRA Category 1', hours: 2, date: day(-30) }]);
  await reloadApp(page);

  await qa.feature('HOME-006', 'Top bar: avatar opens settings, bell count matches the alerts (9+ cap), theme flips and persists', async () => {
    await home(page);
    await topBarAvatar(page).click();
    await sleep(800);
    // A More subpage replaces the title with Back.
    qa.check('the avatar opens More > Profile & settings', await hasBackButton(page) && /Profile & settings/.test(await bodyText(page)) && /board specialties/i.test(await bodyText(page)), (await bodyText(page)).slice(0, 160));
    await home(page);
    let icons = await topBarIcons(page);
    qa.check('the bell shows a count of 1 for the one license due in 20 days', icons.bellBadge === '1', `badge "${icons.bellBadge}"`);
    await icons.bell.click();
    const center = page.getByRole('dialog', { name: 'Notification Center' });
    const opened = await center.waitFor({ timeout: 10000 }).then(() => true, () => false);
    const centerText = (await center.innerText().catch(() => '')).replace(/\s+/g, ' ');
    qa.check('the bell opens the Notification Center listing the license', opened && /QA Nav Texas License|Texas|TX/.test(centerText) && /1 expiring within 90 days/.test(centerText), centerText.slice(0, 200));
    await page.keyboard.press('Escape');
    await center.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

    // Theme: the switch flips the page and the choice is kept (profiles.theme).
    const t0 = profileOf(user.id).theme;
    const b0 = await appBackground(page);
    await (await topBarIcons(page)).theme.click();
    await sleep(1500);
    const t1 = profileOf(user.id).theme;
    const b1 = await appBackground(page);
    await qa.shot('after first theme tap');
    const flipped = b1.rgb !== b0.rgb;
    qa.check('the first tap on the theme switch changes how the page looks', flipped, `${t0} ${b0.rgb} -> ${t1} ${b1.rgb}`);
    if (!flipped) {
      qa.bug({
        title: 'A new member\'s first tap on the theme switch does nothing visible: the profile starts at theme "arctic", which renders as dark, and the tap only stores "dark"',
        step: 'A new member (profiles.theme is the column default "arctic") taps the sun/moon button in the top bar (or "Dark Mode" in the desk sidebar)',
        expected: 'The theme flips on the first tap (dark to light), and the switch offers the opposite of what is shown',
        actual: `profiles.theme ${t0} -> ${t1}, page background unchanged (${b0.rgb}); the top bar shows the moon and the sidebar says "Dark Mode" while the page is already dark. AppContext.jsx:648 renders an unknown theme as dark, but toggleTheme (AppContext.jsx:655) and the icons (App.jsx:2918, SideNav.jsx:19) test theme === "dark", so "arctic" reads as light. Fixed on fix/qa-cred-home 0cb8af15 (and fix/qa-auth-bill-settings c81c5e85, SETTINGS-014)`,
        severity: 'low',
      });
    }
    // Whatever the first tap did, the next taps must alternate and persist.
    const tA = profileOf(user.id).theme;
    await (await topBarIcons(page)).theme.click();
    await sleep(1500);
    const tB = profileOf(user.id).theme;
    const bB = await appBackground(page);
    qa.check('the next tap flips dark and light and saves profiles.theme', tA !== tB && ['dark', 'light'].includes(tB), `${tA} -> ${tB}`);
    await reloadApp(page);
    const bR = await appBackground(page);
    qa.check('the theme persists across a reload', profileOf(user.id).theme === tB && bR.rgb === bB.rgb, `${tB} ${bB.rgb} after reload ${bR.rgb}`);

    // 9+ cap: ten alerts.
    await seed(user, profile.id, 'licenses', ['AZ', 'NM', 'CO', 'UT', 'NV', 'OR', 'WA', 'ID', 'MT'].map((st, i) => (
      { type: 'State Medical License', name: `QA Nav ${st} License`, license_number: `QA-NAV-${st}`, state: st, expiration_date: day(25 + i) })));
    await reloadApp(page);
    await home(page);
    icons = await topBarIcons(page);
    qa.check('with ten alerts the bell badge reads "9+"', icons.bellBadge === '9+', `badge "${icons.bellBadge}"`);
    await icons.bell.click();
    const c2 = (await page.getByRole('dialog', { name: 'Notification Center' }).innerText().catch(() => '')).replace(/\s+/g, ' ');
    qa.check('the Notification Center counts the same ten', /10 expiring within 90 days/.test(c2), c2.slice(0, 160));
    await page.keyboard.press('Escape');
  }, { soft: true });

  await qa.feature('HOME-005', 'Desk sidebar highlights the tab; the rail swaps the pane; counts match the phone list; sidebar theme', async () => {
    const expectTitle = { Home: 'Dashboard', Credentials: 'Credentials', Documents: 'Documents', Practice: 'Practice', More: 'More' };
    for (const [label, title] of Object.entries(expectTitle)) {
      await sidebar(page).getByRole('button', { name: new RegExp(`^(\\S+ )?${label}$`) }).click();
      await sleep(700);
      const active = await sidebar(page).locator('button.cmd-nav-item-active').allInnerTexts();
      qa.check(`sidebar ${label}: the page opens and only ${label} is highlighted`, (await pageTitle(page)) === title && active.length === 1 && active[0].includes(label), `${await pageTitle(page)} / active: ${active.join('|')}`);
    }
    await sidebar(page).getByRole('button', { name: /^Credentials$/ }).click();
    await sleep(800);
    const railText = (await rail(page).innerText()).replace(/\s+/g, ' ');
    const text = await bodyText(page);
    qa.check('Licenses is the default pane (the license list and the registry import)', /Import from the NPI registry/.test(text) && /QA-NAV-TX/.test(text));
    qa.check('no Back button beside the rail', !(await hasBackButton(page)));
    const panes = [
      ['Favorites', /Nothing starred yet|starred/],
      ['Privileges', /Privileges|Pro Feature/],
      ['Insurance', /Insurance|Pro Feature/],
      ['CME Credits', /QA Nav grand rounds/],
      ['Health Records', /Health Records/],
      ['Find CME', /CME|provider/i],
      ['Licenses', /QA-NAV-TX/],
    ];
    const locked = (railText.match(/🔒 ?([A-Za-z ]+?) Pro/g) || []);
    for (const [label, expect] of panes) {
      await railEntry(page, label).click();
      await sleep(700);
      const t = await bodyText(page);
      qa.check(`rail ${label}: the pane changes, no Back button`, expect.test(t) && !(await hasBackButton(page)), t.slice(0, 120));
    }
    qa.check('rail entries that are locked for this member say so (founding members see none locked)', locked.length === 0 || /Pro Feature/.test(await bodyText(page)), locked.join(', '));
    // Counts and red badges, desk rail vs the phone list.
    const deskLic = (await railEntry(page, 'Licenses').innerText()).replace(/\s+/g, ' ');
    const deskCme = (await railEntry(page, 'CME Credits').innerText()).replace(/\s+/g, ' ');
    await qa.shot('desk rail');
    await setWidth(page, 375);
    await page.getByRole('button', { name: /^Credentials$/ }).last().click();
    await sleep(800);
    const phoneLic = (await page.getByRole('button', { name: /^(\S+ )?Licenses\b/ }).first().innerText()).replace(/\s+/g, ' ');
    const phoneCme = (await page.getByRole('button', { name: /^(\S+ )?CME Credits\b/ }).first().innerText()).replace(/\s+/g, ' ');
    await qa.shot('phone credentials list');
    const badge = (s) => (/(\d+)\s*›?$/.exec(s.replace(/\d+ items?/, '')) || [])[1];
    qa.check('the red urgent badge on Licenses is the same on the rail and the phone list (the 10 due within 90 days)', badge(deskLic) === '10' && badge(phoneLic) === '10', `desk "${deskLic}" phone "${phoneLic}"`);
    qa.check('the phone list counts 11 licenses; the rail shows the badge instead of the count', /11 items/.test(phoneLic), phoneLic);
    qa.check('CME Credits: 1 on the rail and "1 item" on the phone list', /CME Credits 1$/.test(deskCme) && /1 item\b/.test(phoneCme), `desk "${deskCme}" phone "${phoneCme}"`);
    await setWidth(page, 1280);

    // The same person's initials in the sidebar and the top bar.
    const sideInitials = await sidebar(page).locator('div[style*="border-radius: 16px"]').first().innerText().catch(() => '');
    const topInitials = await topBarAvatar(page).innerText().catch(() => '');
    qa.check('the sidebar avatar shows the same initials as the top bar', sideInitials.trim() === topInitials.trim(), `sidebar "${sideInitials.trim()}", top bar "${topInitials.trim()}"`);
    if (sideInitials.trim() !== topInitials.trim()) {
      await qa.shot('sidebar and top bar initials');
      qa.bug({
        title: 'Desk sidebar avatar shows the first two letters of the name ("NA" for Nadia Navigate) while the top bar shows the initials ("NN")',
        step: 'A member named Nadia Navigate at desk width: look at the sidebar\'s avatar and the top bar\'s',
        expected: 'One set of initials for the member everywhere',
        actual: `Sidebar "${sideInitials.trim()}", top bar "${topInitials.trim()}". SideNav.jsx:20 takes (name || email).slice(0, 2); App.jsx:2878 takes the first letter of each word`,
        severity: 'low',
      });
    }

    // The sidebar's theme switch.
    const label0 = (await sidebar(page).getByRole('button', { name: /Mode$/ }).innerText()).trim();
    const th0 = profileOf(user.id).theme;
    const bg0 = await appBackground(page);
    await sidebar(page).getByRole('button', { name: /Mode$/ }).click();
    await sleep(1500);
    const label1 = (await sidebar(page).getByRole('button', { name: /Mode$/ }).innerText()).trim();
    const bg1 = await appBackground(page);
    qa.check('the sidebar theme switch flips the page and its own label, and saves profiles.theme', bg1.rgb !== bg0.rgb && label1 !== label0 && profileOf(user.id).theme !== th0, `${label0} ${th0} ${bg0.rgb} -> ${label1} ${profileOf(user.id).theme} ${bg1.rgb}`);
    // The dark label must match what is shown: "Light Mode" offered while dark.
    const dark = bg1.lum < 0.35;
    qa.check('the sidebar offers the opposite of the theme shown', dark ? /Light Mode/.test(label1) : /Dark Mode/.test(label1), `${label1} with background luminance ${bg1.lum.toFixed(2)}`);
  }, { soft: true });

  await qa.feature('HOME-019', 'Desk keys: n opens Add, Esc closes only the top modal, / focuses search or goes Home, nothing fires while typing', async () => {
    await openCredentials(page, 'Licenses');
    await page.locator('body').click({ position: { x: 700, y: 12 } }).catch(() => {});
    await page.keyboard.press('n');
    const add = page.getByRole('dialog', { name: 'Add' });
    qa.check('"n" on Licenses opens the Add form', await add.waitFor({ timeout: 5000 }).then(() => true, () => false));
    await page.keyboard.press('Escape');
    qa.check('Esc closes it', await add.waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false));

    // Typing: a field keeps the "n".
    const npiBox = page.getByRole('textbox').first();
    await npiBox.click();
    await page.keyboard.type('n');
    await sleep(500);
    const stillTyping = await page.evaluate(() => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName));
    qa.check('"n" typed in a field (the registry lookup box on Licenses) opens nothing and the field keeps focus', (await add.count()) === 0 && stillTyping, `dialogs ${await add.count()}, focus kept ${stillTyping}`);
    await npiBox.fill('').catch(() => {});

    // "/" on a screen with no search field goes Home and focuses Home's search.
    await page.locator('body').click({ position: { x: 700, y: 12 } }).catch(() => {});
    await page.keyboard.press('/');
    await sleep(800);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('placeholder') || document.activeElement?.tagName);
    qa.check('"/" on Licenses (no search field) goes Home and focuses its search box', (await pageTitle(page)) === 'Dashboard' && focused === 'Search everything, or ask Vera', `${await pageTitle(page)} / focus ${focused}`);
    // "/" on a screen with its own search field focuses that one.
    await openMore(page, 'CPT Lookup');
    await sleep(800);
    await page.locator('body').click({ position: { x: 700, y: 12 } }).catch(() => {});
    await page.keyboard.press('/');
    await sleep(500);
    const f2 = await page.evaluate(() => ({ ph: document.activeElement?.getAttribute('placeholder') || '', desk: document.activeElement?.hasAttribute('data-desk-search') }));
    qa.check('"/" on CPT Lookup focuses its own search field and stays there', await hasBackButton(page) && f2.desk === true && /61343/.test(f2.ph), JSON.stringify(f2));

    // Esc peels one modal at a time: the rule-change report over the CME math.
    await home(page);
    await page.getByText(/^TX$/).first().click();
    const math = page.getByRole('dialog', { name: 'TX CME — the math' });
    await math.waitFor({ timeout: 10000 });
    await math.getByRole('button', { name: 'Rules changed?' }).click();
    const report = page.getByRole('dialog', { name: /^Report a rule change/ });
    await report.waitFor({ timeout: 10000 });
    await page.locator('h2', { hasText: /^Report a rule change/ }).click();
    await page.keyboard.press('Escape');
    await sleep(600);
    qa.check('Esc closes the top modal (the report) and leaves the CME math open', (await report.count()) === 0 && (await math.count()) === 1);
    await page.keyboard.press('n');
    await sleep(500);
    qa.check('"n" does nothing while a modal is open', (await page.getByRole('dialog', { name: 'Add' }).count()) === 0);
    await page.keyboard.press('Escape');
    qa.check('a second Esc closes the CME math', await math.waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false));
  }, { soft: true });

  // A long CME list to scroll on the phone.
  await seed(user, profile.id, 'cme', Array.from({ length: 30 }, (_, i) => ({ title: `QA Phone CME ${String(i + 1).padStart(2, '0')}`, category: 'AMA PRA Category 1', hours: 1, date: day(-(i + 1) * 5) })));
  await reloadApp(page);
  await setWidth(page, 375);

  await qa.feature('HOME-004', 'Bottom bar: each tab with its dot, + opens Documents, Back to the section menu, the bar stays put', async () => {
    let bar = await phoneBar(page);
    const labels = bar.buttons.map((b) => b.label);
    await qa.shot('phone bar');
    const plain = labels.map((l) => l.replace(/^\S+\s+(?=Practice|Team)/u, ''));
    qa.check('the bar holds Home, Credentials, +, Practice, More (slot 4 is Practice, never Team)', JSON.stringify(plain) === JSON.stringify(['Home', 'Credentials', '', 'Practice', 'More']), JSON.stringify(labels));
    const titles = { Home: 'Dashboard', Credentials: 'Credentials', Practice: 'Practice', More: 'More' };
    for (const [label, title] of Object.entries(titles)) {
      await page.getByRole('button', { name: new RegExp(`^(\\S+\\s+)?${label}$`) }).last().click();
      await sleep(700);
      bar = await phoneBar(page);
      const dots = bar.buttons.filter((b) => b.dot).map((b) => b.label);
      qa.check(`${label}: the page opens and only ${label} carries the active dot`, (await pageTitle(page)) === title && dots.length === 1 && dots[0].endsWith(label), `${await pageTitle(page)} dots ${JSON.stringify(dots)}`);
    }
    bar = await phoneBar(page);
    await bar.buttons.find((b) => b.label === '').b.click();
    await sleep(800);
    qa.check('the green + opens Documents', (await pageTitle(page)) === 'Documents', await pageTitle(page));

    await page.getByRole('button', { name: /^Credentials$/ }).last().click();
    await sleep(600);
    await page.getByRole('button', { name: /^(\S+ )?Licenses\b/ }).first().click();
    await sleep(700);
    qa.check('Credentials > Licenses opens with a Back button', await hasBackButton(page) && /Licenses/.test(await bodyText(page)));
    await page.getByRole('button', { name: /^Back$/ }).click();
    await sleep(600);
    qa.check('Back returns to the Credentials section menu', (await page.getByRole('heading', { name: /^Credentials$/ }).count()) > 0 && /Active Credentials/i.test(await bodyText(page)));

    // A long list: CME Credits with 30 entries.
    await page.getByRole('button', { name: /^(\S+ )?CME Credits\b/ }).first().click();
    await sleep(900);
    const homeBtn = page.getByRole('button', { name: /^Home$/ }).last();
    const before = await homeBtn.boundingBox();
    await page.mouse.move(187, 400);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 600); await sleep(120); }
    await sleep(600);
    const after = await homeBtn.boundingBox();
    const scroll = await page.evaluate(() => {
      const scrollers = [...document.querySelectorAll('div')].filter((d) => d.scrollTop > 0);
      return { doc: document.scrollingElement.scrollTop, inner: Math.max(0, ...scrollers.map((d) => d.scrollTop)) };
    });
    await qa.shot('phone after scrolling');
    qa.check('the list scrolled inside the app (the document itself never scrolls)', scroll.inner > 300 && scroll.doc === 0, JSON.stringify(scroll));
    qa.check('the bar stays fixed at the bottom while the list scrolls', !!before && !!after && Math.abs(before.y - after.y) < 1 && after.y + after.height <= 812 && after.y > 700, `${before?.y} -> ${after?.y}`);
  }, { soft: true });
});

test('hand-offs, reminder and guide emails, More, email links', {
  tag: ['@HOME-009', '@HOME-021', '@HOME-022', '@NOTIFY-007', '@HOME-007', '@NOTIFY-005'],
}, async ({ page, context, qa }) => {
  test.setTimeout(12 * 60 * 1000);
  const { user, profile } = await memberWithPlace(page, { firstName: 'Morgan', lastName: 'Menu' });

  await qa.feature('HOME-009', 'A question with no matches: Ask Vera opens More > Vera and sends it once; Back returns to More', async () => {
    const q = 'QA when does my DEA expire, lab question';
    await scriptAi('gemini', { json: { reply: 'QA lab answer: there is no DEA registration on file yet.', actions: [] } }, 'QA when does my DEA expire');
    const usageBefore = rows(`select id from public.ai_usage where user_id = '${profile.id}'`).length;
    await home(page);
    await page.getByRole('textbox', { name: 'Search everything, or ask Vera' }).fill(q);
    await sleep(600);
    qa.check('nothing in the records matches, and the Ask Vera row is offered', /Nothing in your records matches/.test(await bodyText(page)) && await page.getByText(`Ask Vera: "${q}"`).isVisible().catch(() => false));
    await page.getByText(`Ask Vera: "${q}"`).click();
    const answered = await page.getByText('QA lab answer: there is no DEA registration on file yet.').first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('vera from home search');
    qa.check('More > Vera opens and answers', answered && await hasBackButton(page));
    await sleep(3000);
    const sentCount = await page.getByText(q, { exact: true }).count();
    const usage = rows(`select path, ok from public.ai_usage where user_id = '${profile.id}'`).length - usageBefore;
    qa.check('the question is sent once (one message, one metered call)', sentCount === 1 && usage === 1, `messages ${sentCount}, ai_usage +${usage}`);
    await page.getByRole('button', { name: /^Back$/ }).click();
    await sleep(700);
    qa.check('Back returns to the More menu', (await page.getByRole('heading', { name: /^More$/ }).count()) > 0);
    await goTab(page, 'More');
    await page.getByRole('button', { name: /^(\S+ )?Vera/ }).first().click();
    await sleep(2500);
    qa.check('reopening Vera does not send the question again', (await page.getByText(q, { exact: true }).count()) === 1 && rows(`select id from public.ai_usage where user_id = '${profile.id}'`).length - usageBefore === 1);
  }, { soft: true });

  await qa.feature('HOME-021', 'To do on Home: View All and a task row both open Practice > To do', async () => {
    await goTab(page, 'Practice');
    await page.getByRole('button', { name: 'To do', exact: true }).first().click();
    const box = page.getByPlaceholder('e.g. call back Dr. Nguyen about the ICU consult');
    await box.fill('QA call back the credentialing office');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await sleep(2500);
    const task = row(`select text, completed_at from public.task_notes where user_id = '${profile.id}'`);
    qa.check('task_notes row saved', task?.text === 'QA call back the credentialing office' && !task.completed_at, task);
    await home(page);
    const todo = page.getByRole('heading', { name: 'To do' }).locator('xpath=../..');
    qa.check('Home\'s To do lists the task', /QA call back the credentialing office/.test(await todo.innerText().catch(() => '')));
    await todo.getByRole('button', { name: 'View All' }).click();
    await sleep(900);
    const onTodo = async () => (await pageTitle(page)) === 'Practice' && /Catch it now, finish it later/.test(await bodyText(page));
    qa.check('View All opens Practice > To do', await onTodo());
    await home(page);
    await page.getByText('QA call back the credentialing office').first().click();
    await sleep(900);
    qa.check('a task row opens Practice > To do', await onTodo());
  }, { soft: true });

  await qa.feature('HOME-022', 'Cases to complete: an operative code from the RVU log lands without a role; Home opens its edit form; saving clears it', async () => {
    await goTab(page, 'Practice');
    await page.getByRole('button', { name: 'RVUs', exact: true }).first().click();
    await page.getByPlaceholder('Type a CPT code (e.g. 61312) or name to add it').fill('61312');
    await page.getByRole('button', { name: /^61312\b/ }).first().click();
    await page.getByRole('button', { name: /^Save — / }).click();
    await sleep(2500);
    const c = await eventually('the case', async () => row(`select id, role, category, source, cpt_codes from public.case_logs where user_id = '${profile.id}'`), 15000);
    qa.check('the operative code went to the case log with no role (source RVU log)', !!c && !c.role && c.source === 'RVU log' && /61312/.test(c.cpt_codes || ''), c);
    await home(page);
    const section = page.getByRole('heading', { name: /^Cases to complete \(\d+\)$/ });
    const listed = await section.isVisible().catch(() => false);
    const st = listed ? (await section.locator('xpath=..').innerText()).replace(/\s+/g, ' ') : '';
    await qa.shot('cases to complete');
    qa.check('Home lists it under "Cases to complete (1)" with what is missing', /Cases to complete \(1\)/.test(st) && /missing role/.test(st), st.slice(0, 200));
    if (!listed) return;
    await section.locator('xpath=..').getByText(/missing/).first().click();
    const edit = page.getByRole('dialog', { name: 'Edit' });
    const opened = await edit.waitFor({ timeout: 10000 }).then(() => true, () => false);
    qa.check('it opens the Case Logs edit form', opened && (await pageTitle(page)) === 'Credentials');
    if (!opened) return;
    const fieldSel = (label) => edit.locator('label', { hasText: label }).first().locator('xpath=..').locator('select').first();
    await fieldSel('Role').selectOption('Primary Surgeon');
    const cat = fieldSel('Category');
    if (!(await cat.inputValue().catch(() => ''))) await cat.selectOption({ index: 1 });
    await edit.getByRole('button', { name: /^(Save|Update)$/ }).last().click();
    await edit.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    await sleep(2500);
    const after = row(`select role, category from public.case_logs where id = '${c.id}'`);
    qa.check('case_logs.role and category are set', after?.role === 'Primary Surgeon' && !!after.category, after);
    await home(page);
    qa.check('the case leaves "Cases to complete"', !(await page.getByRole('heading', { name: /^Cases to complete/ }).count()));
  }, { soft: true });

  // Due soon: a license, a DEA, and a record in the member's own category.
  await seed(user, profile.id, 'licenses', [
    { type: 'State Medical License', name: 'QA Remind Texas', license_number: 'QA-REM-TX', state: 'TX', expiration_date: day(20) },
    { type: 'DEA Registration', name: 'QA Remind DEA', license_number: 'QA-REM-DEA', state: 'TX', expiration_date: day(25) },
  ]);
  const [catId] = await seed(user, profile.id, 'custom_categories', [{ name: 'QA Permits', slug: 'qa permits', icon: '🪪', fields: [], origin: 'user', aliases: [] }]);
  await seed(user, profile.id, 'custom_records', [{ category_id: catId, category_name: 'QA Permits', name: 'QA fluoroscopy permit', number: 'QA-REM-PERMIT', expiration_date: day(15), field_labels: {}, field_values: {} }]);

  await qa.feature('NOTIFY-007', 'The reminder email: its links open the app and the renewal pages; it says how to change or stop it; the guide email: its links, the stop line, the reply address', async () => {
    // The member's app alerts on all three.
    await reloadApp(page);
    await home(page);
    const homeText = await bodyText(page);
    qa.check('Home alerts on the license, the DEA and the permit', /State Medical License — TX/.test(homeText) && /DEA Registration — TX/.test(homeText) && /QA fluoroscopy permit/.test(homeText));

    const run = await runHook('send-reminders', { profile_id: profile.id });
    qa.check('send-reminders sent this member one email', run.status === 200 && run.data?.results?.[0]?.sent === true, JSON.stringify(run.data).slice(0, 200));
    const msg = await waitFor('the reminder email', async () => (await emails({ to: user.email })).find((m) => /^Credential check/.test(m.subject)) || null, { timeoutMs: 30000, intervalMs: 1000 }).catch(() => null);
    const full = msg ? await emailBody(msg.id) : {};
    const text = full.text || '';
    qa.check('one reminder email, subject "Credential check: ..."', !!msg, msg?.subject);
    qa.check('it names the license and the DEA with their dates', /QA-REM-TX|State Medical License|Texas/.test(text) && /DEA/.test(text), text.slice(0, 300));
    const permitNamed = /QA fluoroscopy permit|QA-REM-PERMIT/.test(text);
    qa.check('it names the record in the member\'s own category that Home alerts on', permitNamed, text.slice(0, 400));
    if (!permitNamed) {
      const inboxShot = await mailShot(context, msg?.id, user.email, 'reminder email without the permit');
      qa.bug({
        screenshot: inboxShot,
        title: 'The daily reminder email never names a record in the member\'s own category, although Home and the bell alert on it',
        step: 'A custom-category record (QA Permits) expiring in 15 days, a license and a DEA due within 30 days; run the daily reminder (send-reminders for this member)',
        expected: 'The digest lists every dated record the app alerts on, the custom-category one included (App.jsx:548-550: records in the physician\'s own categories "warn like any credential")',
        actual: 'The email lists the license and the DEA only. send-reminders/index.ts:37-45 (TABLES) reads licenses, privileges, insurance, health_records, screenings, professional_memberships and travel_docs; custom_records is not read, so a permit or badge tracked in its own category gets in-app alerts and never an email',
        severity: 'medium',
      });
    }
    const urls = [...new Set(text.match(/https?:\/\/[^\s)]+/g) || [])];
    qa.check('it links to the app and to the renewal pages (Texas board portal, DEA renewal)', urls.includes('https://credentialdomd.com/app/') && urls.some((u) => /deadiversion\.usdoj\.gov/.test(u)) && urls.some((u) => /tmb|texas/i.test(u)), urls.join(' | '));
    qa.check('it says how to change the lead time or turn it off', /email reminders are on in Settings\. Change the lead time or turn it off there/.test(text));
    qa.check('no link points at a waitlist or carries a price', !/waitlist|\$\d/i.test(`${text} ${full.html || ''}`));
    // The app link, opened as the lab's app (credentialdomd.com is the lab app here).
    const appLink = urls.find((u) => u === 'https://credentialdomd.com/app/');
    if (appLink) {
      const p = await context.newPage();
      await p.goto(appLink.replace('https://credentialdomd.com/app/', lab().urls.app), { waitUntil: 'domcontentloaded' });
      await p.getByRole('button', { name: /^Credentials$/ }).first().waitFor({ timeout: 60000 });
      await sleep(1200);
      qa.check('the app link opens the member\'s Home, where the alerts are', (await pageTitle(p)) === 'Dashboard' && /Action Required/.test(await bodyText(p)));
      await p.close();
    }
    // The owner's mailbox is the reply-to the function itself names (read from its source, not repeated here).
    qa.check('replies to the reminder go to the owner (the function\'s own reply-to, not the member)', !!OWNER_REPLY_TO && (full.reply_to || []).includes(OWNER_REPLY_TO) && !(full.reply_to || []).includes(user.email), `${(full.reply_to || []).length} reply-to address(es)`);
    const log = rows(`select method, alert_count from public.notification_log where user_id = '${profile.id}'`);
    qa.check('notification_log records the email', log.some((l) => l.method === 'email'), log);

    // The state guide, requested as a visitor on /states/texas (the page's own relay call).
    const visitor = `guide-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
    const r = await fetch(`${lab().urls.appOrigin}/api/waitlist`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_email: visitor, p_name: null, p_source: '/states/texas', p_note: 'guide-email TX inline', p_stage: 'guide', p_waitlist: false }),
    });
    const lead = await eventually('the lead', async () => row(`select id, note, source, guide_sent_at from public.early_access_leads where email = '${visitor}'`), 15000);
    qa.check('the guide request is recorded as a lead with its marker', r.status < 300 && lead?.note === 'guide-email TX inline', JSON.stringify({ status: r.status, lead }));
    if (!lead) return;
    const g = await runHook('send-guide', { lead_id: lead.id });
    qa.check('send-guide sends it', g.status === 200 && g.data?.sent === 1, JSON.stringify(g.data).slice(0, 200));
    const gm = await waitFor('the guide email', async () => (await emails({ to: visitor }))[0] || null, { timeoutMs: 30000, intervalMs: 1000 }).catch(() => null);
    const gf = gm ? await emailBody(gm.id) : {};
    const html = gf.html || '';
    const gt = gf.text || '';
    qa.check('the guide email arrives: "Texas medical license renewal: fees, deadline, portal link"', /Texas medical license renewal/.test(gm?.subject || ''), gm?.subject);
    const hrefs = [...new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&')))];
    qa.check('every link is https', hrefs.length > 0 && hrefs.every((h) => h.startsWith('https://')), hrefs.filter((h) => !h.startsWith('https://')).join(' | ') || `${hrefs.length} links`);
    const own = hrefs.filter((h) => /^https:\/\/credentialdomd\.com/.test(h));
    const pages = own.map((h) => new URL(h).pathname.replace(/\/$/, ''));
    const missingPages = pages.filter((pth) => pth.startsWith('/states/') && !existsSync(path.join(REPO_ROOT, 'landing', `${pth}.html`)));
    qa.check('its own links point at state pages that exist (and the home page)', own.length > 0 && missingPages.length === 0 && pages.includes('/states/texas'), `${pages.join(', ')}${missingPages.length ? ` missing: ${missingPages.join(', ')}` : ''}`);
    qa.check('no link or line points at a waitlist or states a price', !/waitlist|\$\s?\d+\s?(\/|per)\s?(yr|year|month)|founding|\$99|\$149/i.test(`${html} ${gt}`), (`${gt}`.match(/.{0,40}(waitlist|\$\d+|founding).{0,40}/i) || [''])[0]);
    qa.check('it tells the visitor to reply "stop" to hear nothing further', /reply with the word stop/.test(gt));
    qa.check('a reply goes to the owner\'s mailbox (the stop is handled by hand)', !!GUIDE_REPLY_TO && (gf.reply_to || []).includes(GUIDE_REPLY_TO) && GUIDE_REPLY_TO === OWNER_REPLY_TO, `${(gf.reply_to || []).length} reply-to address(es)`);
    const after = row(`select note, guide_sent_at from public.early_access_leads where id = '${lead.id}'`);
    qa.check('early_access_leads: guide_sent_at stamped, the note unchanged (no automatic stop handling)', !!after?.guide_sent_at && after.note === 'guide-email TX inline', after);
  }, { soft: true });

  await qa.feature('HOME-007', 'More lists its rows; each opens its page; Admin only for an owner; Cancel only for a recurring plan', async () => {
    await goTab(page, 'More');
    await sleep(800);
    qa.check('with nothing waiting, Requests carries no badge', /Requests ›/.test(await bodyText(page)), (await bodyText(page)).match(/Requests[^A-Z]{0,12}/)?.[0]);
    // An open document request, as email-inbound files one when a credentialing office's
    // request is forwarded to docs@ (that server step, written straight to the LOCAL database).
    labExec(`insert into public.document_requests (user_id, from_addr, from_name, subject, body_text, forwarded_by) values (${lit(profile.id)}, 'credentialing@qa.credentialdomd.test', 'QA Credentialing Office', 'QA synthetic request: current license copy', 'QA synthetic request. Please send a copy of the current license.', ${lit(user.email)})`);
    await reloadApp(page);
    await goTab(page, 'More');
    await sleep(1500);
    const text = await bodyText(page);
    qa.check('Requests carries a badge for the open request', /Requests 1 ›/.test(text), text.match(/Requests[^A-Z]{0,12}/)?.[0]);
    await qa.shot('more as member');
    const rowsExpected = ['Vera', 'Profile & settings', 'Setup', 'Requests', 'Generate CV', 'CPT Lookup', 'Finance', 'Data & Backup', 'Support', 'Help & FAQ', 'Privacy', 'Terms', 'Data Rights', 'Sign Out'];
    const missing = rowsExpected.filter((r) => !text.includes(r));
    qa.check('every row the checklist names is there', missing.length === 0, missing.join(', ') || 'all present');
    qa.check('Setup shows its progress (X of Y)', /Setup Get everything on file \d+ of \d+/.test(text), (text.match(/Setup Get everything on file[^›]*/) || [])[0]);
    qa.check('the version line names the signed-in address', new RegExp(`CredentialDOMD v[\\d.]+ · Signed in as ${user.email.replace(/[.]/g, '\\.')}`).test(text));
    qa.check('no Admin row for a member', !/\bAdmin Tickets, feedback, signups/.test(text));
    // The lab offers the administrator share to every active account (qa-lab/lib/functions-env.mjs,
    // CREDENTIAL_PORTAL_OWNER_PROFILES='*'); production offers it to the owner's profile only.
    qa.check('the Administrator access row is shown when credential-portal offers it (every lab account)', /Administrator access View-only links for medical staff offices/.test(text));
    const sub = row(`select status, period_end, cancel_at_period_end from public.billing_subscriptions where profile_id = '${profile.id}' and livemode`);
    qa.check('Cancel Subscription is offered to a member on the renewing founding plan', !!sub && /Cancel Subscription/.test(text), JSON.stringify(sub));

    // Tap each row and come back.
    const destinations = [
      ['Vera', async () => (await page.getByRole('textbox', { name: /Ask Vera anything/ }).count()) > 0],
      ['Profile & settings', async () => /board specialties/i.test(await bodyText(page))],
      ['Administrator access', async () => /medical staff office|view-only/i.test(await bodyText(page))],
      ['Setup', async () => (await page.getByRole('heading', { name: /^Setup$/ }).count()) > 0],
      ['Requests', async () => (await page.getByRole('heading', { name: 'Requests' }).count()) > 0],
      ['Generate CV', async () => /CV|curriculum/i.test(await bodyText(page))],
      ['CPT Lookup', async () => (await page.locator('[data-desk-search]').count()) > 0],
      ['Finance', async () => /Deduction|Expense|1099/i.test(await bodyText(page))],
      ['Data & Backup', async () => (await page.getByRole('heading', { name: 'Data & Backup' }).count()) > 0],
      ['Help & FAQ', async () => (await page.locator('[data-desk-search]').count()) > 0 && /FAQ|question/i.test(await bodyText(page))],
      ['Privacy', async () => /Privacy/i.test(await bodyText(page))],
      ['Terms', async () => /Terms/i.test(await bodyText(page))],
      ['Data Rights', async () => /Data Rights|delete/i.test(await bodyText(page))],
      ['Cancel Subscription', async () => /cancel/i.test(await bodyText(page))],
    ];
    for (const [label, arrived] of destinations) {
      await goTab(page, 'More');
      await sleep(400);
      await page.getByRole('button', { name: new RegExp(`^(\\S+ )?${label.replace(/[&]/g, '\\&')}`) }).first().click();
      await sleep(900);
      const ok = await arrived();
      const back = await hasBackButton(page);
      qa.check(`${label} opens its page with a Back button`, ok && back, (await bodyText(page)).slice(0, 100));
      if (back) { await page.getByRole('button', { name: /^Back$/ }).click(); await sleep(500); }
      qa.check(`Back from ${label} returns to the More menu`, (await page.getByRole('heading', { name: /^More$/ }).count()) > 0 || /Data & Backup Export, import/.test(await bodyText(page)));
    }
    await goTab(page, 'More');
    await page.getByRole('button', { name: /^(\S+ )?Support/ }).first().click();
    qa.check('Support opens the support sheet on Your tickets', await supportSheetOnTickets(page));
    await page.mouse.click(640, 20);
    await sleep(500);

    // The owner.
    await makeAdmin(user);
    const adminRow = row(`select 1 as ok from public.app_admins where profile_id = '${profile.id}'`);
    qa.check('app_admins holds the owner', !!adminRow);
    await page.reload();
    await page.getByRole('button', { name: /^Credentials$/ }).first().waitFor({ timeout: 60000 });
    await goTab(page, 'More');
    const shown = await eventually('the Admin row', async () => /Admin Tickets, feedback, signups/.test(await bodyText(page)), 20000);
    await qa.shot('more as owner');
    qa.check('the owner sees the Admin row (from ai-proxy\'s status answer)', !!shown);
    if (shown) {
      await page.getByRole('button', { name: /^(\S+ )?Admin Tickets/ }).click();
      await sleep(1500);
      qa.check('Admin opens the admin dashboard', /Tickets|Accounts|Signups|Waitlist/i.test(await bodyText(page)) && await hasBackButton(page));
    }
  }, { soft: true });

  await qa.feature('NOTIFY-005', 'Email links open Support on Your tickets, Data & Backup, and Requests; the hash is removed', async () => {
    const base = lab().urls.app;
    const openLink = async (hash) => {
      // An email link opens a new tab on the app.
      const p = await context.newPage();
      await p.goto(`${base}${hash}`, { waitUntil: 'domcontentloaded' });
      await p.getByRole('button', { name: /^Credentials$/ }).first().waitFor({ timeout: 60000 });
      await sleep(1500);
      return p;
    };
    let p = await openLink('#support');
    qa.check('#support opens the support sheet on "Your tickets"', await supportSheetOnTickets(p), (await bodyText(p)).slice(-200));
    qa.check('#support: the hash is removed from the address', !new URL(p.url()).hash, p.url());
    await p.close();

    p = await openLink('#backups');
    qa.check('#backups opens More > Data & Backup', (await p.getByRole('heading', { name: 'Data & Backup' }).count()) > 0, (await bodyText(p)).slice(0, 120));
    qa.check('#backups: the hash is removed', !new URL(p.url()).hash, p.url());
    await p.close();

    p = await openLink('#requests');
    qa.check('#requests opens More > Requests', (await p.getByRole('heading', { name: 'Requests' }).count()) > 0, (await bodyText(p)).slice(0, 120));
    qa.check('#requests: the hash is removed', !new URL(p.url()).hash, p.url());
    await qa.shot('requests deep link');
    await p.close();
  }, { soft: true });

  await qa.feature('HOME-007', 'Sign Out, the last row, ends the session', async () => {
    await goTab(page, 'More');
    await page.getByRole('button', { name: 'Sign Out', exact: true }).click();
    const back = await page.locator('[data-testid="qa-signin-as"]').first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    qa.check('Sign Out returns to the sign-in page', back);
  }, { soft: true });
});
