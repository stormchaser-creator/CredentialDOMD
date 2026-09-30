// Phone layouts, part 4: More, Profile & settings, Setup, text size, Support
// and the owner's Admin screens on a phone (375 x 812 and 390 x 844, touch).
// A member types profile fields (reload, database, a second phone), flips a
// reminder switch, checks Setup and its drawers, switches the text size to XL
// and XXL and checks Home and a form at each, opens Support; then, made the
// lab's owner, opens every Admin section, searches Accounts, opens (and
// cancels) the Pause dialog, and gives free lifetime access to an unpaid test
// account from the phone (an audit row). Every screen and dialog gets the
// phone layout audit.
import { test } from './support/fixtures.mjs';
import {
  accessSnapshot, createPhysician, field, letters, makeAdmin, profileOf, row, sleep, waitFor,
} from './support/lab.mjs';
import {
  PHONES, anyOf, auditDialog, auditScreen, backButton, closeDialog, exceptChrome, fileBugOnce, fileLayoutBugs, layoutAudit, phoneCredentials, phoneMore, phoneTab, phoneUse,
  reloadPhone, secondPhone, signInPhone, tapTarget,
  newPhoneMember,
} from './support/phone-helpers.mjs';

const BUGS = [
  {
    key: 'settings-switches', feature: 'SETTINGS-014', kind: 'small', severity: 'low',
    match: /^button\[role=switch\]|^button "(Daily|3 Days|Weekly|Biweekly|Monthly|Test)"$|^button \(no text; empty\)$/,
    title: 'Phone Profile & settings: the on/off switches (44 x 24), the theme switch (48 x 28), the reminder-frequency chips (26 px) and "Test" (29 px) are under 32 px tall',
    step: 'More > Profile & settings on a phone',
    expected: 'Every switch and chip at least 32 px tall',
    actual: 'ToggleRow.jsx:18 draws each switch as a 44 x 24 button (Credentials list on Home, Email reminders, Text Notifications, Acknowledge requests automatically); SettingsSection.jsx:554-557 the theme switch 48 x 28 with no label; :690-695 the Daily / 3 Days / Weekly / Biweekly / Monthly chips padding 6px 2px, font 11 (58 x 26); :721 "Test" padding 6px 14px, font 12 (29 px).',
  },
  {
    key: 'setup-menu', feature: 'SETTINGS-001', kind: 'small', severity: 'low',
    match: /^button "More for |^button "Packet ready|^button "(Skip for now|Does not apply to me|Do it now)"$/,
    title: 'Phone Setup: each task\'s "…" menu button is 26 x 21 px; "Skip for now" and "Does not apply to me" are 16 px text links',
    step: 'More > Setup on a phone',
    expected: 'Each at least 32 x 32 px',
    actual: 'SetupPage.jsx:693-696: the "More for <task>" button is an 18 px "…" with padding 0 4px (26 x 21), right beside the task row that opens its drawer; its menu (MenuBtn, SetupPage.jsx:711-717, padding 7px 12px) offers Do it now / Skip for now / Does not apply to me at 31 px; an open drawer\'s footer (SetupPage.jsx:812-823) has "Skip for now" and "Does not apply to me" as padding-0 underlined text, 16 px tall; the Tier 2 "Packet ready" header row is a 19 px text button.',
  },
  {
    key: 'admin-accounts', feature: 'ADMIN-001', kind: 'small', severity: 'low',
    match: /^button "(Pause access|Give free lifetime access|View as member|Approve|Refresh section|(show|hide) \d+ empty account records?)"$|^input\[type=search\] "(Search loaded accounts|Name, email, NPI or state)"$|^select "All access states/,
    title: 'Phone Admin > Accounts: the row actions are 24 px tall, the search and filter 24 px, "Refresh section" an unstyled 20 px browser button',
    step: 'More > Admin > Accounts on a phone (the owner)',
    expected: 'Each control at least 32 px tall (Pause access, a consequential action, sits beside Give free lifetime access and View as member)',
    actual: 'AdminDashboard.jsx:880-882 (chip: padding 4px 9px, font 11) and :981-984 (View as member, same style) make the row actions 24 px tall and 4 px apart; :929 and :653 give the search box and the access filter only font-size 16 (no padding): 24 px; :933 "show N empty account records" is an 11 px text button (14 px); :437 renders "Refresh section" as a bare <button style={{ marginTop: 8 }}>, the browser\'s default grey button, 20 px.',
  },
  {
    key: 'admin-tickets', feature: 'ADMIN-002', kind: 'small', severity: 'low',
    match: /^input\[type=search\] "Subject, email or details"$|^select "(all unresolved|all urgent|All tickets)/,
    title: 'Phone Admin > Tickets: the search box and the three filters are 24 px tall',
    step: 'More > Admin > Tickets on a phone',
    expected: 'Each at least 32 px tall',
    actual: 'AdminDashboard.jsx:653 (FORM_CONTROL is only { fontSize: 16 }) and :664-668 give the ticket search and status / priority / approval selects no padding: 24 px tall.',
  },
  {
    key: 'admin-history', feature: 'ADMIN-004', kind: 'small', severity: 'low', only: ['Admin Control history', 'Admin Emails'],
    match: /^button "(Refresh history|Previous|Next|Refresh support views)"$|^summary "(Record details|Approval history)"$/,
    title: 'Phone Admin > Control history and Emails: unstyled 20 px browser buttons and 23 px disclosures',
    step: 'More > Admin > Control history / Emails on a phone',
    expected: 'Each control at least 32 px tall',
    actual: 'AdminControlHistory.jsx:30 renders "Refresh history" (and Previous / Next / Refresh support views) as bare <button>s, the browser\'s default grey buttons, 20 px; each entry\'s "Record details" and Emails\' "Approval history" <summary> is 23 px.',
  },
  {
    key: 'admin-ops', feature: 'ADMIN-003', kind: 'small', severity: 'low', only: ['Admin Errors', 'Admin Waitlist', 'Admin Fields', 'Admin AI'],
    match: /^button "(Load more [a-z ]+|refresh|dismiss|Approve|Dismiss)"$|^button "Delete (other-build|listed) reports|^button "(Show|Hide) guide-only requests/,
    title: 'Phone Admin > Errors, Waitlist, Fields and AI: controls 14 to 31 px tall, "Load more" an unstyled 20 px browser button',
    step: 'More > Admin > Errors / Waitlist / Fields / AI on a phone',
    expected: 'Each control at least 32 px tall',
    actual: 'AdminDashboard.jsx:434 renders "Load more <records>" as a bare <button style={{ marginLeft: 8 }}> (20 px); AdminErrorReports.jsx:87-90 gives "Delete other-build reports" / "Delete listed reports" padding 7px 10px, font 12 (31 px); Waitlist\'s "Show guide-only requests" (AdminDashboard.jsx:1095, 28 px) and each attempt\'s "dismiss" (:1182, padding 4px 8px, font 11: 22 px); Fields\' Approve / Dismiss (:1228-1237, padding 7px: 31 px); AI\'s "refresh" (:1436, an 11 px text button, 14 px).',
  },
  {
    key: 'admin-traffic', feature: 'ADMIN-008', kind: 'small', severity: 'low', only: 'Admin Traffic history',
    match: /^button "Refresh"$/,
    title: 'Phone Admin > Traffic history: "Refresh" is 28 px tall',
    step: 'More > Admin > Traffic history on a phone',
    expected: 'At least 32 px tall',
    actual: 'AdminDashboard.jsx:785-791 styles it padding 6px 12px, font 12: 66 x 28 px.',
  },
];

/** A filed bug's pattern, to leave it out of another screen's sweep. */
const matchOf = (key) => BUGS.find((b) => b.key === key).match;

for (const width of [375, 390]) {
  const P = PHONES[width];
  test.describe(`phone ${P.name}`, () => {
    test.use(phoneUse(width));

    test(`settings and admin ${width}: More, profile, switches, Setup, text size, Support, Admin`, {
      tag: ['@phone', '@HOME-007', '@SETTINGS-007', '@BILL-007', '@SETTINGS-014', '@NOTIFY-004', '@SETTINGS-001', '@SETTINGS-013', '@SUPPORT-001', '@ADMIN-001', '@ADMIN-002', '@ADMIN-003', '@ADMIN-004', '@ADMIN-005', '@ADMIN-008'],
    }, async ({ page, qa, browser }) => {
      test.setTimeout(15 * 60 * 1000);
      const file = (audit, screen = '') => fileLayoutBugs(qa, audit, BUGS.filter((b) => !b.only || [].concat(b.only).includes(screen)), P.name);
      const { user } = await newPhoneMember(page, { firstName: 'Sam', lastName: `Settings ${width}` });

      await qa.feature('HOME-007', 'More menu on a phone', async () => {
        await phoneTab(page, 'More');
        await sleep(500);
        file(await auditScreen(qa, page, 'More', {
          allowSmall: exceptChrome(),
          primary: [
            ['Profile & settings', page.getByRole('button', { name: /^\S+ Profile & settings/ })],
            ['Setup', page.getByRole('button', { name: /^\S+ Setup/ })],
            ['Sign Out', page.getByRole('button', { name: 'Sign Out' })],
          ],
        }));
      }, { soft: true });

      await qa.feature('SETTINGS-007', 'Profile fields typed on a phone persist (reload, database, second phone)', async () => {
        await phoneMore(page, 'Profile & settings');
        await sleep(800);
        const type = async (placeholder, value) => {
          const box = page.getByPlaceholder(placeholder).first();
          await box.scrollIntoViewIfNeeded();
          await box.tap();
          await box.fill('');
          await page.keyboard.type(value);
          await box.blur();
          await sleep(300);
        };
        await type('(555) 123-4567', '(555) 010-0175');
        await type('Street, City, ST ZIP', `${width} QA Way, Denver, CO 80202`);
        await type('Languages beyond English', 'Spanish');
        const shownBefore = await page.getByPlaceholder('Languages beyond English').inputValue();
        const md = page.getByRole('button', { name: /^MD Doctor of Medicine$/ });
        await md.scrollIntoViewIfNeeded();
        await md.tap();
        await sleep(3000);
        await reloadPhone(page);
        const p = profileOf(user.id);
        await phoneMore(page, 'Profile & settings');
        await sleep(800);
        const shownAfter = await page.getByPlaceholder('Languages beyond English').inputValue();
        qa.check('Languages, typed on the phone keyboard, reads the same after a reload', shownAfter === 'Spanish', `before reload "${shownBefore}", after "${shownAfter}", profiles.languages "${p.languages}"`);
        if (shownBefore === 'Spanish' && p.languages !== 'Spanish') {
          await qa.shot('languages after reload');
          fileBugOnce(qa, 'settings-keystroke-race', {
            feature: 'SETTINGS-007', severity: 'medium',
            title: 'Profile & settings: a field typed on the keyboard can be saved without its last letters (one unordered save per keystroke)',
            step: `Phone ${P.name}: More > Profile & settings > Languages, type "Spanish" on the keyboard, tap MD, reload`,
            expected: 'profiles.languages is "Spanish" and the field reads "Spanish" after the reload',
            actual: `The field read "${shownBefore}" before the reload; profiles.languages holds "${p.languages}" and the field reads "${shownAfter}" after it (address typed "${width} QA Way, Denver, CO 80202", stored "${p.address}"). SettingsSection.jsx:418 calls update("languages", value) on every keystroke; updateSettings (AppContext.jsx:666-676) fires sbSaveSettings for each without waiting or ordering; saveSettings (supabase.js:956-980) sends each as its own PATCH of profiles with updated_at = now(), so whichever request lands last wins, and a slower earlier keystroke ("Spanis") can overwrite the full word. The same per-keystroke save serves Name (:260), NPI (:283), phone (:407), address (:411), website (:414), Professional Summary (:419) and CV Highlight Line (:420). Only Email (2e6d3ec8) and lead time (ea6e5e58) were moved to save-once on the fix branches; this field is not fixed there.`,
          }, P.name);
        }
        qa.check('phone, address, languages and degree are in profiles', p.phone === '(555) 010-0175' && p.address === `${width} QA Way, Denver, CO 80202` && p.languages === 'Spanish' && p.degree_type === 'MD',
          JSON.stringify({ phone: p.phone, address: p.address, languages: p.languages, degree: p.degree_type }));
        const other = await secondPhone(browser, qa.report, width === 375 ? 390 : 375);
        try {
          await signInPhone(other.page, user);
          await phoneMore(other.page, 'Profile & settings');
          await sleep(800);
          qa.check('the second phone shows the typed address', (await other.page.getByPlaceholder('Street, City, ST ZIP').inputValue()) === `${width} QA Way, Denver, CO 80202`);
        } finally { await other.context.close().catch(() => {}); }
      }, { soft: true });

      await qa.feature('SETTINGS-007', 'A phone network that delivers one keystroke\'s save late: the field must still keep the whole word', async () => {
        // Mobile networks do not keep requests in order. Here the first keystroke's save is held
        // 1.5 s (the others go straight through), as a slow cell hop would. Since 5f4290ef one
        // profile's saves go out one at a time and a waiting save whose fields a later save also
        // carries is skipped, so the partial values in between may never be sent at all: the hold
        // is on whichever cv_highlights PATCH goes out first. Were the saves still sent side by side,
        // that held first letter would land last and overwrite the whole line.
        const final = 'QA phone highlight';
        let held = 0;
        const sent = [];
        const handler = async (route) => {
          const r = route.request();
          let body = null;
          if (r.method() === 'PATCH') { try { body = JSON.parse(r.postData() || 'null'); } catch { body = null; } }
          if (body && typeof body === 'object' && Object.hasOwn(body, 'cv_highlights')) {
            sent.push(body.cv_highlights);
            if (sent.length === 1) { held += 1; await sleep(1500); }
          }
          return route.fallback();
        };
        await page.route('**/rest/v1/profiles*', handler);
        try {
          await phoneMore(page, 'Profile & settings');
          const box = page.getByPlaceholder('e.g. Author of two books').first();
          await box.scrollIntoViewIfNeeded();
          await box.tap();
          await page.keyboard.type(final);
          await box.blur();
          await sleep(4000);
        } finally { await page.unroute('**/rest/v1/profiles*', handler); }
        const stored = profileOf(user.id).cv_highlights;
        await reloadPhone(page);
        await phoneMore(page, 'Profile & settings');
        await sleep(800);
        const shown = await page.getByPlaceholder('e.g. Author of two books').first().inputValue();
        const saves = `${sent.length} save(s) sent: ${JSON.stringify(sent.length > 4 ? [...sent.slice(0, 2), '...', ...sent.slice(-2)] : sent)}`;
        qa.check('the first keystroke\'s save was delivered late', held >= 1, `${held} held; ${saves}`);
        qa.check('the last save sent carries the whole typed text', sent.at(-1) === final, saves);
        qa.check('profiles.cv_highlights keeps the whole typed text', stored === final, `typed "${final}", stored "${stored}"; ${saves}`);
        qa.check('the field reads the whole typed text after a reload', shown === final, `shown after reload "${shown}"`);
        if (held >= 1 && (stored !== final || shown !== final)) {
          await qa.shot('highlight after reload');
          fileBugOnce(qa, 'settings-keystroke-race', {
            feature: 'SETTINGS-007', severity: 'medium',
            title: 'Profile & settings: a field typed on the keyboard loses letters when an earlier keystroke\'s save arrives late',
            step: `Phone ${P.name}: More > Profile & settings > CV Highlight Line, type "${final}" on the keyboard (the first keystroke's save held 1.5 s, as a slow mobile network would), reload`,
            expected: `profiles.cv_highlights is "${final}" and the field reads so after the reload`,
            actual: `profiles.cv_highlights holds "${stored}" and the field reads "${shown}" after the reload (${saves}). SettingsSection calls update(key, value) on every keystroke; saveSettings (src/lib/supabase.js, inProfileOrder since 5f4290ef) is meant to send one profile's saves one at a time, in order, so a late earlier save can never land after a later one.`,
          }, P.name);
        }
      }, { soft: true });

      await qa.feature('BILL-007', 'Membership card at the top of Profile & settings', async () => {
        await phoneMore(page, 'Profile & settings');
        await sleep(800);
        const manage = page.getByRole('button', { name: 'Manage paid subscription' });
        const t = await tapTarget(manage);
        qa.check('"Manage paid subscription" can be reached', t.ok, `${t.size} ${t.why}`);
      }, { soft: true });

      await qa.feature('SETTINGS-014', 'Profile & settings on a phone: the whole page', async () => {
        file(await auditScreen(qa, page, 'Profile & settings', { allowSmall: exceptChrome() }));
      }, { soft: true });

      await qa.feature('NOTIFY-004', 'A reminder switch tapped on a phone persists', async () => {
        const sw = page.getByRole('switch', { name: 'Text Notifications' });
        await sw.scrollIntoViewIfNeeded();
        const before = await sw.getAttribute('aria-checked');
        const t = await tapTarget(sw);
        qa.check('the switch can be reached', t.onScreen && !t.covered, `${t.size} ${t.why}`);
        await sw.tap();
        await sleep(2500);
        const after = await sw.getAttribute('aria-checked');
        qa.check('a tap flips the switch', after !== before, `${before} -> ${after}`);
        await reloadPhone(page);
        await phoneMore(page, 'Profile & settings');
        await sleep(800);
        qa.check('it stays flipped after a reload', (await page.getByRole('switch', { name: 'Text Notifications' }).getAttribute('aria-checked')) === after);
        await page.getByRole('switch', { name: 'Text Notifications' }).tap();
        await sleep(1500);
      }, { soft: true });

      await qa.feature('SETTINGS-001', 'Setup on a phone: the task list and a drawer', async () => {
        await backButton(page).tap();
        await phoneMore(page, 'Setup');
        await sleep(800);
        file(await auditScreen(qa, page, 'Setup', { allowSmall: exceptChrome() }));
        const task = page.getByRole('button', { name: /^About you/ }).first();
        await task.tap();
        await sleep(800);
        file(await auditScreen(qa, page, 'Setup with About you open', { allowSmall: anyOf(exceptChrome(), matchOf('setup-menu')) }));
        const more = page.getByRole('button', { name: /^More for / }).first();
        await more.tap();
        await sleep(400);
        file(await auditScreen(qa, page, 'Setup with a task menu open', { allowSmall: anyOf(exceptChrome(), matchOf('setup-menu')) }));
      }, { soft: true });

      await qa.feature('SETTINGS-013', 'Text size XL and XXL on a phone: Home and a form still fit', async () => {
        for (const size of ['XL', 'XXL']) {
          await phoneMore(page, 'Profile & settings');
          const b = page.getByRole('button', { name: new RegExp(`^Aa ${size}$`) });
          await b.scrollIntoViewIfNeeded();
          await b.tap();
          await sleep(1500);
          qa.check(`profiles.font_size is ${size}`, profileOf(user.id).font_size === size, profileOf(user.id).font_size);
          await phoneTab(page, 'Home');
          await sleep(800);
          file(await auditScreen(qa, page, `Home at text size ${size}`, { allowSmall: anyOf(exceptChrome(), /^button "(Not now|Open setup ›|View All|Snooze|Follow up|Acknowledge|Find CME)"$|^input\[type=text\] "Search everything, or ask Vera"$/) }));
          const bar = await page.evaluate(() => { const s = [...document.querySelectorAll('#root div')].find((d) => getComputedStyle(d).position === 'sticky'); return s ? s.getBoundingClientRect().top : null; });
          qa.check(`at ${size} the top bar stays at the top`, bar !== null && Math.abs(bar) < 2, `top ${bar}`);
          await phoneCredentials(page, 'Licenses');
          await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().tap();
          const dlg = page.getByRole('dialog', { name: 'Add' });
          await dlg.waitFor();
          await auditDialog(qa, page, `license form at ${size}`, dlg, { actions: [['Type', field(dlg, 'Type')], ['Add', dlg.getByRole('button', { name: 'Add', exact: true }).last()]] });
          await closeDialog(qa, `license form at ${size}`, dlg);
          await backButton(page).tap();
        }
        await phoneMore(page, 'Profile & settings');
        const m = page.getByRole('button', { name: /^Aa M$/ });
        await m.scrollIntoViewIfNeeded();
        await m.tap();
        await sleep(1500);
        qa.check('the text size choice is saved to profiles.font_size (back to M)', profileOf(user.id).font_size === 'M', profileOf(user.id).font_size);
      }, { soft: true });

      await qa.feature('SUPPORT-001', 'Support on a phone: the bottom sheet fits and closes', async () => {
        await backButton(page).tap();
        await phoneMore(page, 'Support');
        const tabNew = page.getByRole('button', { name: 'New ticket', exact: true });
        const opened = await tabNew.waitFor({ timeout: 10000 }).then(() => true, () => false);
        qa.check('More > Support opens the support sheet', opened);
        if (!opened) return;
        await tabNew.tap();
        await sleep(600);
        // SupportModal is its own bottom sheet (no role="dialog", no close button): find the sheet itself.
        const box = await tabNew.evaluate((b) => {
          let n = b;
          while (n && !(getComputedStyle(n).borderTopLeftRadius === '20px' && getComputedStyle(n).overflowY === 'auto')) n = n.parentElement;
          if (!n) return null;
          n.setAttribute('data-qa-phone-sheet', '1');
          const r = n.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height, sw: n.scrollWidth, cw: n.clientWidth };
        });
        const vp = page.viewportSize();
        qa.check('the sheet fits the screen', !!box && box.x >= -1 && box.y >= -1 && box.x + box.w <= vp.width + 1 && box.y + box.h <= vp.height + 1, JSON.stringify(box));
        qa.check('the sheet does not scroll sideways', !!box && box.sw <= box.cw + 1, box ? `${box.sw}/${box.cw}` : '');
        const audit = await layoutAudit(page, { scope: '[data-qa-phone-sheet="1"]' });
        qa.check('every control in the sheet at least 32x32px', !audit.error && audit.small.length === 0, audit.small?.map((x) => `${x.el} ${x.size}`).join(' | '));
        qa.check('no text cut off in the sheet', !audit.error && audit.clipped.length === 0, audit.clipped?.map((x) => x.el).join(' | '));
        file(audit);
        await qa.shot('support sheet');
        const send = page.getByRole('button', { name: /^(Send|Submit)/ }).first();
        const t = await tapTarget(send);
        qa.check('the sheet\'s Send can be reached', t.onScreen && !t.covered, `${t.size} ${t.why}`);
        // No close button: the sheet closes by a tap on the dimmed strip above it.
        const top = box ? Math.max(4, box.y - 20) : 20;
        qa.check('there is a dimmed strip above the sheet to tap (at least 32 px)', !!box && box.y >= 32, box ? `${Math.round(box.y)} px above the sheet` : '');
        await page.touchscreen.tap(vp.width / 2, top);
        await sleep(800);
        qa.check('a tap above the sheet closes it', !(await tabNew.isVisible().catch(() => false)));
      }, { soft: true });

      // The owner's screens.
      await makeAdmin(user);
      await reloadPhone(page);
      const openAdmin = async (section) => {
        await phoneMore(page, 'Admin');
        const b = page.getByRole('navigation', { name: 'Administration sections' }).getByRole('button', { name: new RegExp(`^${section}`) }).first();
        await b.scrollIntoViewIfNeeded();
        await b.tap();
        await sleep(1500);
      };
      const pending = await createPhysician({ firstName: 'Quincy', lastName: `Unpaid ${letters()}` });

      await qa.feature('ADMIN-001', 'Admin > Accounts on a phone: search, Pause dialog (cancelled), lifetime access for an unpaid account', async () => {
        await openAdmin('Accounts');
        const search = page.getByRole('searchbox', { name: 'Search loaded accounts' });
        await search.tap();
        await page.keyboard.type(`Quincy ${pending.lastName}`);
        await sleep(800);
        const give = page.getByRole('button', { name: 'Give free lifetime access' }).first();
        file(await auditScreen(qa, page, 'Admin Accounts', { allowSmall: exceptChrome(), primary: [['search', search], ['Give free lifetime access', give]] }));
        // Lifetime access for the unpaid account, from the phone.
        await search.fill('');
        await search.tap();
        await page.keyboard.type(`Quincy ${pending.lastName}`);
        await sleep(800);
        await page.getByRole('button', { name: 'Give free lifetime access' }).first().tap();
        const d = page.getByRole('dialog', { name: 'Give free lifetime access' });
        await d.waitFor();
        const grant = d.getByRole('button', { name: 'Give free lifetime access' });
        await auditDialog(qa, page, 'Give free lifetime access', d, { actions: [['reason', d.getByRole('textbox').first()], ['confirm box', d.getByRole('checkbox').first()], ['Give free lifetime access', grant]] });
        await d.getByRole('textbox').first().tap();
        await page.keyboard.type('QA phone checklist: lifetime grant');
        await d.getByRole('checkbox').first().tap();
        await grant.tap();
        const done = d.getByRole('button', { name: 'Done' });
        if (await done.waitFor({ timeout: 20000 }).then(() => true, () => false)) await done.tap();
        const audit = await waitFor('the lifetime audit', async () => row(`select reason from public.admin_lifetime_audit where target_subject = '${pending.id}'`), { timeoutMs: 30000 }).catch(() => null);
        qa.check('admin_lifetime_audit row with the typed reason', audit?.reason === 'QA phone checklist: lifetime grant', audit);
        const snap = accessSnapshot(pending.id);
        qa.check('the account now has lifetime Credential and Practice', snap?.lifetime?.credential === true && snap?.lifetime?.practice === true, snap?.lifetime);
        // The now-active account's Pause dialog, opened and closed without confirming (a confirmed
        // pause is admin-controls.spec.mjs's, and hangs on the known ADMIN-001 bug).
        await sleep(1000);
        const pause = page.getByRole('button', { name: 'Pause access' }).first();
        if (await pause.isVisible().catch(() => false)) {
          await pause.tap();
          const pd = page.getByRole('dialog', { name: 'Pause app access' });
          if (await pd.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
            file((await auditDialog(qa, page, 'Pause app access', pd, { actions: [['reason', pd.getByRole('textbox', { name: 'Reason for this change' })], ['Confirm', pd.getByRole('button', { name: /^Confirm/ })]] })).audit);
            await closeDialog(qa, 'Pause app access', pd);
          } else qa.check('Pause access opens its dialog', false);
        } else qa.check('the granted account shows Pause access', false, 'no Pause access button on the row');
      }, { soft: true });

      await qa.feature('ADMIN-002', 'Admin > Tickets on a phone', async () => {
        await openAdmin('Tickets');
        file(await auditScreen(qa, page, 'Admin Tickets', { allowSmall: anyOf(exceptChrome(), matchOf('admin-accounts')) }));
      }, { soft: true });

      await qa.feature('ADMIN-005', 'Admin > Messages on a phone: the New message form fits', async () => {
        await openAdmin('Messages');
        const add = page.getByRole('button', { name: '+ New message' });
        file(await auditScreen(qa, page, 'Admin Messages', { allowSmall: anyOf(exceptChrome(), matchOf('admin-accounts')), primary: [['+ New message', add]] }));
        await add.tap();
        const d = page.getByRole('dialog', { name: 'New message' });
        if (await d.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
          const a = await auditDialog(qa, page, 'New message', d, { actions: [['Send', d.getByRole('button', { name: /^Send/ }).last()]] });
          file(a.audit);
          await closeDialog(qa, 'New message', d);
        } else qa.check('+ New message opens its form', false);
      }, { soft: true });

      await qa.feature('ADMIN-003', 'Admin > Errors, Waitlist, Fields and AI on a phone', async () => {
        for (const s of ['Errors', 'Waitlist', 'Fields', 'AI']) {
          await openAdmin(s);
          file(await auditScreen(qa, page, `Admin ${s}`, { allowSmall: anyOf(exceptChrome(), matchOf('admin-accounts')) }), `Admin ${s}`);
        }
      }, { soft: true });

      await qa.feature('ADMIN-008', 'Admin > Traffic history on a phone', async () => {
        await openAdmin('Traffic history');
        file(await auditScreen(qa, page, 'Admin Traffic history', { allowSmall: anyOf(exceptChrome(), matchOf('admin-accounts')) }), 'Admin Traffic history');
      }, { soft: true });

      await qa.feature('ADMIN-004', 'Admin > Overview & reports, Emails and Control history on a phone', async () => {
        for (const s of ['Overview & reports', 'Emails', 'Control history']) {
          await openAdmin(s);
          file(await auditScreen(qa, page, `Admin ${s}`, { allowSmall: anyOf(exceptChrome(), matchOf('admin-accounts')) }), `Admin ${s}`);
        }
        const nav = page.getByRole('navigation', { name: 'Administration sections' });
        const scroll = await nav.evaluate((n) => ({ sw: n.scrollWidth, cw: n.clientWidth, x: getComputedStyle(n).overflowX }));
        qa.check('the section strip scrolls sideways inside itself (not the page)', scroll.x === 'auto' || scroll.x === 'scroll', JSON.stringify(scroll));
      }, { soft: true });
    });
  });
}
