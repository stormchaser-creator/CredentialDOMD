// Phone layouts, part 1: a new physician on a phone (375 x 812 and 390 x 844,
// touch, iPhone user agent) meets the membership gate, reviews the offer and
// pays on the Checkout stand-in, then uses Home and the bottom tab bar with
// taps: every tab, the + button, Back from a subpage, a long scroll under the
// fixed bar, Get Started on the empty account, the Setup card's Not now
// (reload and database), a license added from the phone form, the ring and
// counts compared with a desk browser, an alert acknowledged, the bell and the
// theme switch. Every screen and dialog gets the phone layout audit
// (support/phone-helpers.mjs): no sideways scroll, nothing past the edges, no
// text cut off, controls at least 32 x 32 px, primary controls reachable and
// not covered, dialogs inside the screen and closable.
import { test } from './support/fixtures.mjs';
import { guardContext, watchPage } from './support/fixtures.mjs';
import {
  createPhysician, dismissInterruptions, field, homeTiles, lab, profileOf, row, rows, signIn, sleep, waitForMemberApp, waitForProfile,
} from './support/lab.mjs';
import {
  CHROME, PHONES, anyOf, auditDialog, auditScreen, backButton, barState, bottomBar, closeDialog, credentialsRow, exceptChrome, fileBugOnce,
  fileLayoutBugs, phoneCredentials, phoneTab, phoneUse, landOnGate, reloadPhone, reviewOffer, scrollContent, tapTarget,
} from './support/phone-helpers.mjs';

const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

// Layout bugs this journey files (once per run), each with the code behind it.
const BUGS = [
  {
    key: 'gate-buttons', feature: 'AUTH-003', kind: 'small', match: /^button "(Check access again|Sign out)"$/, severity: 'low',
    title: 'Phone: the membership gate\'s "Check access again" and "Sign out" are unstyled browser buttons 20 px tall',
    step: 'Sign in as a new (unpaid) physician; the "Your membership" gate',
    expected: 'Both at least 32 px tall and styled like the gate\'s other buttons: they are the unpaid physician\'s only ways to re-check access or leave',
    actual: 'App.jsx:832-833 renders both as bare <button style={{ marginTop: 20 }}> (and margin 20px 0 0 12px) with no padding, font or theme, so they draw as the browser\'s default grey buttons on the dark card, 20 px tall. The same bare pattern renders "Try again" when the membership check fails (App.jsx:846, seen in the lab when initialize-clerk-profile answered 503 under load) and "Manage an existing subscription" on Access paused (App.jsx:852), by reading the code.',
  },
  {
    key: 'back', feature: 'HOME-004', kind: 'small', match: CHROME.back, severity: 'low',
    title: 'Phone: the top bar\'s Back button is a 60 x 20 px tap target',
    step: 'Credentials > Licenses (or any More subpage); tap "Back" in the top bar',
    expected: 'Back, the only way out of every Credentials and More subpage on a phone, is at least 32 px (Apple asks 44) tall',
    actual: 'App.jsx:2862-2866 styles it with padding 0 and font-size 15, so the button is only the text line (about 60 x 20 px) inside the 56 px bar. (In the lab, Chromium\'s touch adjustment still sent a tap 8 px above the word to Back, so the miss is not total; the target itself is below the floor.)',
  },
  {
    key: 'setup-card', feature: 'HOME-001', kind: 'small', match: /^button "(Not now|Open setup ›)"$/, severity: 'low',
    title: 'Phone Home: the Setup card\'s "Not now" (48 x 15 px) and "Open setup ›" (82 x 16 px) are text-only tap targets',
    step: 'Home on a phone for a new member (the Setup card is shown)',
    expected: 'Both at least 32 x 32 px',
    actual: '"Not now" (SetupCard.jsx:155-158) has no padding and font 12; "Open setup ›" (SetupCard.jsx:194-197) has padding 0 and font 13, so each is only its text line.',
  },
  {
    key: 'home-small', feature: 'HOME-003', kind: 'small', severity: 'low',
    match: /^button "(View All|Snooze|Follow up|Acknowledge|Find CME|🔕 \d+ acknowledged ▾)"$|^button "[^"]*\d+ days? (left|overdue|ago)"$|^input\[type=text\] "Search everything, or ask Vera"$/,
    title: 'Phone Home: the banner, ring list, Action Required and widget controls are 15 to 29 px tall',
    step: 'Home on a phone with a license expiring in 30 days (banner, ring, Action Required, To do widget)',
    expected: 'Every control on Home at least 32 x 32 px',
    actual: 'The notification banner\'s "Snooze" (NotificationBanner.jsx:157, padding 2px 8px, font 11: 56 x 18); the ring\'s needs-action rows ("State Medical License, CO 30 days left", 16 px text buttons) and "Find CME" (16 px); Action Required "Follow up" and "Acknowledge" (App.jsx:1240-1248, 26 px); the acknowledged list toggle "🔕 1 acknowledged ▾" (29 px); To do "View All" (App.jsx:1316-1320, padding 0, 16 px); and the search <input>, 20 px tall inside a 46 px box whose padding is on a plain div (HomeSearch.jsx:157-175; in the lab a tap on the box edge still focused it through Chromium\'s touch adjustment).',
  },
];

/** A filed bug's pattern, to leave it out of another screen's sweep. */
const matchOf = (key) => BUGS.find((b) => b.key === key).match;

for (const width of [375, 390]) {
  const P = PHONES[width];
  test.describe(`phone ${P.name}`, () => {
    test.use(phoneUse(width));

    test(`home ${width}: gate, offer, Home, bottom bar, setup card, ring vs desk`, {
      tag: ['@phone', '@AUTH-003', '@BILL-001', '@HOME-004', '@HOME-002', '@HOME-001', '@HOME-003', '@HOME-015', '@NOTIFY-002', '@HOME-006'],
    }, async ({ page, qa, browser }) => {
      test.setTimeout(12 * 60 * 1000);
      const file = (audit) => fileLayoutBugs(qa, audit, BUGS, P.name);
      const topTitle = () => page.evaluate(() => {
        const bar = [...document.querySelectorAll('#root div')].find((d) => getComputedStyle(d).position === 'sticky');
        return bar ? bar.innerText.replace(/\s+/g, ' ').trim() : '';
      });
      const user = await createPhysician({ firstName: 'Paige', lastName: `Phone ${width}` });

      await qa.feature('AUTH-003', 'Membership gate on a phone: layout, Check access again, Sign out', async () => {
        await signIn(page, user);
        const first = await landOnGate(page);
        qa.check('a new physician lands on the membership gate', first.where === 'gate', first.seen.join(', '));
        const audit = await auditScreen(qa, page, 'gate', {
          primary: [
            ['Review Credential offer', page.getByRole('button', { name: /Review .* offer/ }).first()],
            ['Check access again', page.getByRole('button', { name: 'Check access again' })],
            ['Sign out', page.getByRole('button', { name: 'Sign out' })],
          ],
        });
        file(audit);
        await page.getByRole('button', { name: 'Check access again' }).tap();
        await sleep(2500);
        qa.check('after "Check access again" the gate stays, with no error', await page.getByRole('region', { name: 'Membership' }).isVisible()
          && !(await page.getByRole('alert').filter({ hasText: /could not|failed|error/i }).count()));
        await page.getByRole('button', { name: 'Sign out' }).tap();
        const out = await page.getByTestId('qa-signin').waitFor({ timeout: 60000 }).then(() => true, () => false);
        qa.check('a tap on "Sign out" returns to the sign-in card', out);
        await signIn(page, user);
        const back = await landOnGate(page);
        qa.check('signing back in returns to the gate', back.where === 'gate', back.seen.length ? `after the lab's edge runtime answered ${back.seen.join(', ')} (a busy shared lab) and Try again` : '');
        const p = profileOf(user.id);
        qa.check('the account is still pending (no write from the gate)', p?.access_status === 'pending', p?.access_status);
      }, { soft: true });

      await qa.feature('BILL-001', 'Offer review on a phone: terms, Continue, Checkout', async () => {
        await reviewOffer(page);
        const proceed = page.getByRole('button', { name: 'Continue to secure payment' });
        const terms = page.getByRole('checkbox', { name: /agree to the payment and renewal terms/ });
        await auditScreen(qa, page, 'offer review', {
          primary: [['terms checkbox (with its label)', terms], ['Continue to secure payment', proceed], ['Refresh offer', page.getByRole('button', { name: 'Refresh offer' })]],
          allowSmall: /^button "(Check access again|Sign out)"$/,
        });
        qa.check('Continue is disabled before the terms are agreed', await proceed.isDisabled());
        await terms.tap();
        qa.check('a tap on the terms checkbox ticks it', await terms.isChecked());
        qa.check('Continue is enabled once the terms are agreed', await proceed.isEnabled());
        await proceed.tap();
        const pay = page.getByTestId('qa-stripe-pay');
        await pay.waitFor({ timeout: 60000 });
        qa.check('Continue opens Checkout (the lab stand-in on the app\'s origin)', new URL(page.url()).origin === lab().urls.appOrigin, page.url().slice(0, 80));
        const quotes = rows(`select annual_cents, consented_at from public.limited_billing_quotes where clerk_subject = '${user.id}'`);
        qa.check('one consented quote recorded', quotes.length === 1 && !!quotes[0].consented_at, quotes);
        await pay.tap();
        await page.waitForURL((u) => u.origin === lab().urls.appOrigin && u.searchParams.get('billing') === 'complete', { timeout: 120000 });
        const active = await waitForProfile(user.id, (p) => p.access_status === 'active', 90000).then(() => true, () => false);
        qa.check('the membership becomes active', active);
        await waitForMemberApp(page);
        await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
        await waitForMemberApp(page);
        await dismissInterruptions(page);
      });

      const profile = profileOf(user.id);

      await qa.feature('HOME-004', 'Bottom tab bar: every tab, +, Back from a subpage, a long scroll', async () => {
        const bar = bottomBar(page);
        for (const [name, title] of [['Home', 'Dashboard'], ['Credentials', 'Credentials'], ['Practice', 'Practice'], ['More', 'More']]) {
          const button = bar.getByRole('button', { name: new RegExp(`^(\\S+ )?${name}$`) }).first();
          const t = await tapTarget(button);
          qa.check(`the "${name}" tab is on screen, ${t.size}, not covered`, t.ok, t.why);
          await button.tap();
          await sleep(500);
          const st = await barState(page);
          qa.check(`"${name}" opens its screen and carries the active dot`, (await topTitle()).includes(title) && (st.active || '').endsWith(name), `title "${(await topTitle()).slice(0, 30)}", dot on ${st.active}`);
        }
        const plus = bar.locator('button').nth(2);
        const tp = await tapTarget(plus);
        qa.check('the green + is on screen, 32 px or larger, not covered', tp.ok, `${tp.size} ${tp.why}`);
        await plus.tap();
        await sleep(600);
        qa.check('+ opens Documents', (await topTitle()).includes('Documents') && await page.getByRole('button', { name: 'Upload' }).first().isVisible(), await topTitle());
        await qa.shot('documents from plus');
        // Back from a subpage.
        await phoneCredentials(page, 'Licenses');
        const back = backButton(page);
        const tb = await tapTarget(back);
        qa.check(`Back is on screen, 32 px or larger and not covered (${tb.size})`, tb.ok, tb.why);
        if (!tb.bigEnough) file({ small: [{ el: 'button "Back"', size: tb.size }] });
        // A tap on the bar just above the word "Back" (still inside the 56 px bar, where a thumb lands).
        const bb = await back.boundingBox();
        await page.touchscreen.tap(bb.x + bb.width / 2, Math.max(bb.y - 8, 2));
        await sleep(500);
        const stillLicenses = await page.getByRole('heading', { name: 'Licenses' }).first().isVisible().catch(() => false);
        qa.check('a tap 8 px above the word "Back" (inside the top bar) also goes back', !stillLicenses, stillLicenses ? 'still on Licenses: the tap missed' : 'went back');
        if (stillLicenses) await back.tap();
        await sleep(500);
        qa.check('Back returns to the Credentials menu', await credentialsRow(page, 'Licenses').isVisible());
        // A long scroll under the fixed bar (the Credentials menu is about three screens long).
        const before = await barState(page);
        const scrolled = await scrollContent(page, 1400);
        const after = await barState(page);
        await qa.shot('credentials menu scrolled');
        qa.check('the menu scrolls', scrolled > 200, `scrollTop ${scrolled}`);
        qa.check('the bar stays fixed at the bottom while the content scrolls', before.top === after.top && after.bottom === after.vh, `bar ${before.top}-${before.bottom} -> ${after.top}-${after.bottom}, screen ${after.vh}`);
        const audit = await auditScreen(qa, page, 'credentials menu (scrolled)', { allowSmall: exceptChrome() });
        file(audit);
      }, { soft: true });

      await qa.feature('HOME-002', 'Get Started on the empty account opens Licenses with the Add form; closing leaves Licenses', async () => {
        await phoneTab(page, 'Home');
        const card = page.getByText('Get Started', { exact: true }).locator('xpath=..');
        const t = await tapTarget(card);
        qa.check('the Get Started card is on screen and not covered', t.ok, `${t.size} ${t.why}`);
        await card.tap();
        const dlg = page.getByRole('dialog', { name: 'Add' });
        const opened = await dlg.waitFor({ timeout: 10000 }).then(() => true, () => false);
        qa.check('the tap opens the license Add form', opened);
        if (!opened) return;
        await auditDialog(qa, page, 'license Add form', dlg, {
          actions: [['Type', field(dlg, 'Type')], ['Add', dlg.getByRole('button', { name: 'Add', exact: true }).last()], ['Cancel', dlg.getByRole('button', { name: 'Cancel' }).last()]],
        });
        await closeDialog(qa, 'license Add form', dlg);
        qa.check('closing leaves the physician on Credentials > Licenses', (await topTitle()).includes('Back') && await page.getByRole('heading', { name: 'Licenses' }).first().isVisible());
      }, { soft: true });

      await qa.feature('HOME-001', 'Setup card on a phone: layout, the search field, Not now across a reload', async () => {
        await phoneTab(page, 'Home');
        const heading = page.getByRole('heading', { name: /^Setup · \d of \d$/ });
        qa.check('Home shows the Setup card', await heading.isVisible());
        const audit = await auditScreen(qa, page, 'Home with the Setup card', {
          allowSmall: exceptChrome(),
          primary: [
            ['search field', page.getByPlaceholder('Search everything, or ask Vera')],
            ['Setup card main button', page.getByRole('button', { name: /^(Upload my CV|Add|Open|Start|Set)/ }).first()],
            ['Open setup ›', page.getByRole('button', { name: 'Open setup ›' })],
            ['Not now', page.getByRole('button', { name: 'Not now' })],
          ],
        });
        file(audit);
        // The search field's visible box: a tap on its upper edge should focus it.
        const input = page.getByPlaceholder('Search everything, or ask Vera');
        const boxEl = input.locator('xpath=..');
        const b = await boxEl.boundingBox();
        await page.touchscreen.tap(b.x + b.width / 2, b.y + 5);
        await sleep(300);
        const focused = await input.evaluate((el) => document.activeElement === el);
        qa.check('a tap on the search box\'s upper edge (inside its border) focuses the field', focused, `box ${Math.round(b.width)}x${Math.round(b.height)}, input ${(await input.boundingBox()).height}px tall`);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Not now' }).tap();
        await sleep(1500);
        qa.check('"Not now" hides the card', !(await heading.count()));
        await reloadPhone(page);
        await phoneTab(page, 'Home');
        await sleep(800);
        qa.check('it stays hidden after a reload', !(await page.getByRole('heading', { name: /^Setup · / }).count()));
        const state = profileOf(user.id).setup_state;
        qa.check('profiles.setup_state records the snooze', !!state && /snooze|notNow|hidden|until/i.test(JSON.stringify(state)), JSON.stringify(state)?.slice(0, 160));
      }, { soft: true });

      await qa.feature('HOME-003', 'A license added from the phone form; the phone ring and counts match a desk browser', async () => {
        await phoneCredentials(page, 'Licenses');
        await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().tap();
        const dlg = page.getByRole('dialog', { name: 'Add' });
        await dlg.waitFor();
        await field(dlg, 'Type').selectOption({ label: 'State Medical License' });
        await field(dlg, 'License #').tap();
        await page.keyboard.type(`QA-PH-${width}1`);
        await field(dlg, 'State').selectOption({ label: 'CO' });
        await field(dlg, /^Expires/).fill(day(30));
        await dlg.getByRole('button', { name: 'Add', exact: true }).last().tap();
        const saved = await dlg.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
        qa.check('the form saves from the phone', saved);
        await sleep(2000);
        const lic = row(`select license_number, state, expiration_date from public.licenses where user_id = '${profile.id}'`);
        qa.check('a licenses row with the typed number', lic?.license_number === `QA-PH-${width}1` && lic.state === 'CO', lic);
        await reloadPhone(page);
        await phoneTab(page, 'Home');
        await sleep(1500);
        const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
        const n = (label) => Number((new RegExp(`(\\d+) ${label}`).exec(text) || [])[1] ?? 0);
        const ring = page.getByRole('progressbar', { name: 'Tracked standing' });
        const phone = { percent: Number(await ring.getAttribute('aria-valuenow').catch(() => NaN)), active: n('Active'), expiring: n('Expiring'), expired: n('Expired') };
        qa.check('the phone hero shows 1 Expiring', phone.expiring === 1, JSON.stringify(phone));
        const audit = await auditScreen(qa, page, 'Home with an expiring license', {
          allowSmall: exceptChrome(),
          primary: [['compliance ring', ring]],
        });
        file(audit);
        // The same account on a desk browser.
        const deskContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        try {
          await guardContext(deskContext, qa.report);
          const desk = await deskContext.newPage();
          watchPage(desk, qa.report);
          await signIn(desk, user);
          await waitForMemberApp(desk);
          const tiles = await homeTiles(desk);
          qa.check('phone and desk show the same ring percent and counts', tiles.percent === phone.percent && tiles.expiring === phone.expiring && tiles.active === phone.active && tiles.expired === phone.expired,
            `phone ${JSON.stringify(phone)} desk ${JSON.stringify(tiles)}`);
        } finally { await deskContext.close().catch(() => {}); }
      }, { soft: true });

      await qa.feature('HOME-015', 'Acknowledge the alert from the phone: the dialog fits; the Expiring count stays', async () => {
        await phoneTab(page, 'Home');
        const ack = page.getByRole('button', { name: 'Acknowledge', exact: true }).first();
        const has = await ack.waitFor({ timeout: 10000 }).then(() => true, () => false);
        qa.check('Home offers "Acknowledge" on the expiring license', has);
        if (!has) return;
        const t = await tapTarget(ack);
        qa.check('"Acknowledge" can be reached', t.onScreen && !t.covered, `${t.size} ${t.why}`);
        await ack.tap();
        const m = page.getByRole('dialog', { name: 'Acknowledge this alert' });
        await m.waitFor();
        await auditDialog(qa, page, 'Acknowledge this alert', m, {
          actions: [['note', m.getByPlaceholder('e.g. waiting on the board to extend')], ['Acknowledge', m.getByRole('button', { name: 'Acknowledge', exact: true })]],
        });
        await m.getByPlaceholder('e.g. waiting on the board to extend').tap();
        await page.keyboard.type('QA phone: renewal submitted');
        await m.getByRole('button', { name: 'Acknowledge', exact: true }).tap();
        await sleep(2500);
        const acks = rows(`select note from public.alert_acks where user_id = '${profile.id}'`);
        qa.check('alert_acks row with the typed note', acks.some((a) => a.note === 'QA phone: renewal submitted'), acks);
        await reloadPhone(page);
        await phoneTab(page, 'Home');
        await sleep(1000);
        const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
        qa.check('the Expiring count is unchanged after acknowledging', /\b1 Expiring\b/.test(text), text.match(/\d+ Expiring/)?.[0]);
        await qa.shot('home after acknowledge');
      }, { soft: true });

      await qa.feature('NOTIFY-002', 'The bell opens the Notification Center; it fits and closes', async () => {
        const buttons = await page.getByRole('button').all();
        let bellButton = null;
        for (const b of buttons) {
          const box = await b.boundingBox().catch(() => null);
          if (box && box.y < 50 && box.x > width - 110 && box.x < width - 50) { bellButton = b; break; }
        }
        qa.check('the bell sits in the top bar', !!bellButton);
        if (!bellButton) return;
        const t = await tapTarget(bellButton);
        qa.check('the bell is 32 px or larger and not covered', t.ok, `${t.size} ${t.why}`);
        await bellButton.tap();
        const center = page.getByRole('dialog', { name: 'Notification Center' });
        const opened = await center.waitFor({ timeout: 10000 }).then(() => true, () => false);
        qa.check('the Notification Center opens', opened);
        if (!opened) return;
        await auditDialog(qa, page, 'Notification Center', center);
        await closeDialog(qa, 'Notification Center', center);
      }, { soft: true });

      await qa.feature('HOME-006', 'Top bar: avatar opens Profile & settings; theme switch flips and persists', async () => {
        await phoneTab(page, 'Home');
        const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('#root > div') || document.body).backgroundColor);
        const buttons = await page.getByRole('button').all();
        let theme = null;
        for (const b of buttons) {
          const box = await b.boundingBox().catch(() => null);
          if (box && box.y < 50 && box.x > width - 60) { theme = b; break; }
        }
        qa.check('the theme switch sits in the top bar', !!theme);
        if (theme) {
          const t = await tapTarget(theme);
          qa.check('the theme switch is 32 px or larger and not covered', t.ok, `${t.size} ${t.why}`);
          const before = await bg();
          await theme.tap();
          await sleep(800);
          let flipped = await bg();
          const firstTap = flipped !== before;
          qa.check('the first tap switches the theme', firstTap, `${before} -> ${flipped}${firstTap ? '' : ': a new profile stores theme "arctic" (the column default), which renders dark; toggleTheme (AppContext.jsx:655) turns anything but "dark" into "dark", so the first tap saves "dark" and nothing changes on screen'}`);
          if (!firstTap) {
            fileBugOnce(qa, 'theme-first-tap', {
              feature: 'HOME-006', severity: 'low',
              title: 'The top bar\'s theme switch does nothing on the first tap for a new account (theme "arctic")',
              step: `Phone ${P.name}: new member, Home, tap the moon icon in the top bar`,
              expected: 'The theme switches to light on the first tap',
              actual: 'Nothing changes; the second tap switches. profiles.theme defaults to "arctic", which AppContext renders as dark (AppContext.jsx:648), while toggleTheme (AppContext.jsx:655) computes theme === "dark" ? "light" : "dark" and saves "dark". Already fixed on fix/qa-auth-bill-settings (c81c5e85, SETTINGS-014) and fix/qa-cred-home (0cb8af15), both in release/qa1.',
            }, P.name);
            await theme.tap();
            await sleep(800);
            flipped = await bg();
            qa.check('a second tap switches the theme', flipped !== before, `${before} -> ${flipped}`);
          }
          await sleep(1500);
          await reloadPhone(page);
          qa.check('the theme survives a reload', (await bg()) === flipped, `${flipped} -> ${await bg()}`);
          await qa.shot('other theme');
          const audit = await auditScreen(qa, page, 'Home in the other theme', { allowSmall: anyOf(exceptChrome(), matchOf('setup-card'), matchOf('home-small')) });
          file(audit);
        }
        // The avatar (36 px, top left) opens Profile & settings.
        const avatar = page.locator('#root div').filter({ hasText: /^[A-Z]{2}$/ }).first();
        const box = await avatar.boundingBox().catch(() => null);
        qa.check('the avatar sits top left, 32 px or larger', !!box && box.x < 40 && box.width >= 32 && box.height >= 32, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'not found');
        if (box) {
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
          await sleep(800);
          qa.check('a tap on the avatar opens Profile & settings', /Physician Profile|Profile & settings|Membership/i.test(await page.locator('body').innerText()));
        }
        if (theme) { const again = (await page.getByRole('button').all()); for (const b of again) { const bx = await b.boundingBox().catch(() => null); if (bx && bx.y < 50 && bx.x > width - 60) { await b.tap(); break; } } }
      }, { soft: true });
    });
  });
}
