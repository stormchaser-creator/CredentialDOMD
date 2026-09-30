// The Setup board (More > Setup), used the way a new member works through it:
// the task list and its "…" menu (skip, not applicable, put it back), the
// declared negatives ("I do not hold a DEA registration", "I would rather type
// it in"), the narration when the board's total changes, and the counts the
// Home card, the More tile and the Credentials rail print for the same board.
// Every stretch reloads to prove what was stored (profiles.setup_state).
import { test } from './support/fixtures.mjs';
import {
  field, goTab, labExec, newMember, openCredentials, profileOf, recordButtons, restAs, row, sleep, waitFor,
} from './support/lab.mjs';
import {
  openSetupPage, reloadApp, setupCountsEverywhere, setupStateOf, stripCounts, taskMenu, waitForSetupState,
} from './support/settings-auth-helpers.mjs';

const TIER1 = ['Start from your CV', 'About you', 'Your licenses', 'Expiration dates', 'DEA registration', 'Reminders'];

test('setup board: task menu, skip and not-applicable persist, put back, declared negatives, narration, counts agree', {
  tag: ['@SETTINGS-001', '@SETTINGS-003'],
}, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { user, profile } = await newMember(page, { firstName: 'Sasha', lastName: 'Setupboard' });

  await qa.feature('SETTINGS-001', 'Setup lists the Protected tier, then the packet; each row opens its drawer', async () => {
    await openSetupPage(page);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const positions = TIER1.map((l) => text.indexOf(l));
    qa.check('the six Protected tasks are listed in order', positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), JSON.stringify(Object.fromEntries(TIER1.map((l, i) => [l, positions[i]]))));
    const packetAt = text.indexOf('Copies of your license and DEA');
    qa.check('the packet tasks follow the Protected tier', packetAt > positions[5], `packet row at ${packetAt}, Reminders at ${positions[5]}`);
    const strip = await stripCounts(page);
    qa.check('the strip counts the Protected tier ("Protected: n of 6 done")', strip?.label === 'Protected' && strip.total === 6, JSON.stringify(strip));
    await qa.shot('setup board');
    for (const label of ['About you', 'Your licenses', 'Reminders', 'Headshot']) {
      await page.locator('button').filter({ hasText: label }).first().click();
      const opened = await page.getByRole('heading', { name: label, exact: true }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
      qa.check(`opening "${label}" shows its drawer`, opened);
    }
    const counts = await setupCountsEverywhere(page);
    const want = `${strip?.done} of ${strip?.total}`;
    qa.check('Home card, More tile and Credentials rail print the same count as the Setup strip', counts.home === want && counts.more === want && counts.rail === want, JSON.stringify({ strip: want, ...counts }));
  }, { soft: true });

  await qa.feature('SETTINGS-001', '"…" menu: Skip for now and Does not apply persist across a reload; Put it back restores', async () => {
    await openSetupPage(page);
    await taskMenu(page, 'Expiration dates', 'Skip for now');
    await taskMenu(page, 'About you', 'Does not apply to me');
    await sleep(500);
    const shown = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('the skipped and not-applicable rows leave the list and sit in their groups', /Skipped \(1\)/.test(shown) && /Does not apply \(1\)/.test(shown), shown.match(/(Skipped|Does not apply) \(\d+\)/g)?.join(', '));
    const strip = await stripCounts(page);
    qa.check('the strip says one is skipped', strip?.skipped === 1, JSON.stringify(strip));
    const stored = await waitForSetupState(profile.id, (s) => s.tasks?.dates?.s === 'skipped' && s.tasks?.identity?.s === 'na');
    qa.check('profiles.setup_state records the skip and the not-applicable', stored?.tasks?.dates?.s === 'skipped' && stored?.tasks?.identity?.s === 'na', JSON.stringify(stored?.tasks));
    await reloadApp(page);
    await openSetupPage(page);
    const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('after a reload both are still set aside', /Skipped \(1\)/.test(after) && /Does not apply \(1\)/.test(after));
    await page.getByRole('button', { name: /^Skipped \(1\)/ }).click();
    await page.getByRole('button', { name: /^Does not apply \(1\)/ }).click();
    await qa.shot('groups expanded');
    const putBack = page.getByRole('button', { name: 'Put it back' });
    qa.check('each set-aside row offers "Put it back"', (await putBack.count()) === 2, `${await putBack.count()} buttons`);
    await putBack.first().click();
    await sleep(300);
    await page.getByRole('button', { name: 'Put it back' }).first().click();
    const restored = await waitForSetupState(profile.id, (s) => !s.tasks?.dates && !s.tasks?.identity);
    qa.check('Put it back clears both from profiles.setup_state', !restored?.tasks?.dates && !restored?.tasks?.identity, JSON.stringify(restored?.tasks));
    const back = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('both rows are back in the list', !/Skipped \(\d+\)/.test(back) && !/Does not apply \(\d+\)/.test(back));
    // "Do it now" opens that row's drawer.
    await taskMenu(page, 'Your licenses', 'Do it now');
    qa.check('"Do it now" opens the drawer', await page.getByRole('button', { name: 'Add a license by hand' }).first().isVisible().catch(() => false));
  }, { soft: true });

  await qa.feature('SETTINGS-001', 'Protected finished, then the CV row comes undone: Home, More, the rail and the strip still agree', async () => {
    // Education and a position on file (they satisfy "Start from your CV"), written as the app writes them.
    await restAs(user, 'education', { method: 'POST', body: { user_id: profile.id, type: 'Doctor of Medicine (MD)', name: 'MD Diploma, QA Medical School', institution: 'QA Medical School', graduation_date: '2012-05-20' } });
    const work = await restAs(user, 'work_history', { method: 'POST', body: { user_id: profile.id, type: 'Full-Time Employed', position: 'Attending Neurosurgeon', employer: 'QA Undone Hospital', state: 'CO', start_date: '2019-07-01' } });
    await reloadApp(page);
    await openSetupPage(page);
    await page.locator('button').filter({ hasText: 'About you' }).first().click();
    await page.getByRole('button', { name: 'MD', exact: true }).click();
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'Choose a state' }) }).first().selectOption('CO');
    await page.locator('button').filter({ hasText: 'Your licenses' }).first().click();
    await page.getByRole('button', { name: 'Add a license by hand' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add' });
    await field(dlg, 'Type').selectOption('State Medical License');
    await field(dlg, 'License #').fill('QA-BOARD-CO1');
    await field(dlg, 'State').selectOption('CO');
    await field(dlg, /^Expires/).fill('2029-02-28');
    await dlg.getByRole('button', { name: 'Add' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 15000 });
    await openSetupPage(page);
    await page.locator('button').filter({ hasText: 'DEA registration' }).first().click();
    // The drawer's own form (the Next card above it carries the same "Add my DEA" verb).
    const deaForm = page.locator('div').filter({ has: page.getByPlaceholder('e.g. BW1234563') }).filter({ has: page.getByRole('button', { name: 'I do not hold a DEA registration' }) }).last();
    await deaForm.getByPlaceholder('e.g. BW1234563').fill('QB0000025');
    await deaForm.locator('input[type="date"]').first().fill('2027-09-30');
    await deaForm.getByRole('button', { name: 'Add my DEA' }).click();
    await sleep(2500);
    await openSetupPage(page);
    const strip = await stripCounts(page);
    // Once Protected is finished the strip carries on over the packet ("Packet ready: n of m done").
    qa.check('the Protected tier is finished (the strip moves on to the packet)', strip && (strip.label !== 'Protected' || strip.left === 0), JSON.stringify(strip));
    await goTab(page, 'Home');
    const moment = page.getByText('Protected.', { exact: true });
    const sawMoment = await moment.waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('Home marks the moment ("Protected.")', sawMoment);
    if (sawMoment) await page.getByRole('button', { name: 'Back to Home' }).click();
    const stamped = await waitForSetupState(profile.id, (st) => !!st.tier1DoneAt);
    qa.check('profiles.setup_state.tier1DoneAt is stamped', !!stamped?.tier1DoneAt);
    // The physician removes the position: "Start from your CV" is no longer satisfied.
    await openCredentials(page, 'Work History');
    await recordButtons(page, 'QA Undone Hospital').remove.click();
    await page.getByRole('dialog').getByRole('button', { name: /^Delete/ }).last().click().catch(() => {});
    await waitFor('the position to be deleted', async () => !row(`select 1 as x from public.work_history where user_id = '${profile.id}' and employer = 'QA Undone Hospital'`), { timeoutMs: 20000 }).catch(() => null);
    await reloadApp(page);
    await goTab(page, 'Home');
    await sleep(1500);
    const homeLine = ((await page.locator('body').innerText()).replace(/\s+/g, ' ').match(/Setup[:·][^›]{0,80}/) || [])[0] || null;
    const counts = await setupCountsEverywhere(page);
    await openSetupPage(page);
    const after = await stripCounts(page);
    const want = after ? `${after.done} of ${after.total}` : null;
    await qa.shot('counts after cv undone');
    qa.check('Home line, More tile, Credentials rail and the Setup strip print the same count', counts.home === want && counts.more === want && counts.rail === want, JSON.stringify({ strip: want, home: counts.home, homeLine, more: counts.more, rail: counts.rail, work: work.status }));
    // Leave DEA unanswered again for the declared-negative stretch that follows.
    await openCredentials(page, 'Licenses');
    await recordButtons(page, 'QB0000025').remove.click();
    await page.getByRole('dialog').getByRole('button', { name: /^Delete/ }).last().click().catch(() => {});
    await waitFor('the DEA to be deleted', async () => !row(`select 1 as x from public.licenses where user_id = '${profile.id}' and license_number = 'QB0000025'`), { timeoutMs: 20000 }).catch(() => null);
    if (counts.home && counts.home !== want) {
      qa.bug({
        title: 'Setup counts disagree once Protected is finished and the CV row comes undone: Home counts the whole board, the rail and More count the Protected tier',
        step: 'Finish the Protected tier (CV satisfied by education and a position); Home stamps it. Delete the position; reload; compare Home, More > Setup, the Credentials rail and the Setup strip',
        expected: 'The same count everywhere',
        actual: `Home "${homeLine}", More "${counts.more}", rail "${counts.rail}", strip "${want}". Home's Form D prints boardCounts(setup) (src/components/features/SetupCard.jsx:102 and 115) whenever the undone row has no regressionLine (the CV has none, src/utils/setupTasks.js TASK_DEFS "cv"), while App's rail and More tile print the Protected tier until it is complete again (src/App.jsx:649-651)`,
        severity: 'low',
      });
    }
  }, { soft: true });

  await qa.feature('SETTINGS-003', 'Declared negatives close their rows: no DEA, no CV to upload', async () => {
    await openSetupPage(page);
    await page.locator('button').filter({ hasText: 'DEA registration' }).first().click();
    await page.getByRole('button', { name: 'I do not hold a DEA registration' }).click();
    await page.locator('button').filter({ hasText: 'Start from your CV' }).first().click();
    await page.getByRole('button', { name: 'I would rather type it in' }).click();
    const stored = await waitForSetupState(profile.id, (s) => s.declared?.noDea === true && s.declared?.noCv === true);
    qa.check('profiles.setup_state records both declarations', stored?.declared?.noDea === true && stored?.declared?.noCv === true, JSON.stringify(stored?.declared));
    await reloadApp(page);
    await openSetupPage(page);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    qa.check('both rows now read "Does not apply" after a reload', /Does not apply \(2\)/.test(text), text.match(/Does not apply \(\d+\)/)?.[0]);
    const progress = await waitForSetupState(profile.id, (st) => st.progress?.t1?.total === 4);
    qa.check('the declared rows no longer count against the Protected total (6 less 2)', progress?.progress?.t1?.total === 4, JSON.stringify(progress?.progress?.t1));
  }, { soft: true });

  await qa.feature('SETTINGS-001', 'Put it back on a declared negative brings the row back', async () => {
    await page.getByRole('button', { name: /^Does not apply \(2\)/ }).click();
    const group = page.locator('div').filter({ has: page.getByRole('button', { name: /^Does not apply \(2\)/ }) }).last();
    await group.locator('div').filter({ hasText: 'DEA registration' }).getByRole('button', { name: 'Put it back' }).first().click();
    const stored = await waitForSetupState(profile.id, (s) => !s.declared?.noDea, 6000);
    await reloadApp(page);
    await openSetupPage(page);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const back = !/Does not apply \(2\)/.test(text);
    await qa.shot('after put back on declared negative');
    qa.check('the DEA row is back on the list after Put it back (and a reload)', back && stored?.declared?.noDea !== true, `${text.match(/Does not apply \(\d+\)/)?.[0] || 'no group'}; declared ${JSON.stringify(stored?.declared)}`);
    if (!back || stored?.declared?.noDea === true) {
      qa.bug({
        title: 'Setup: "Put it back" does not restore a row closed by "I do not hold a DEA registration" (or "I would rather type it in")',
        step: 'More > Setup > DEA registration > "I do not hold a DEA registration"; expand "Does not apply"; tap "Put it back"',
        expected: 'The DEA row returns to the list as pending (the declaration is withdrawn)',
        actual: `The row stays under "Does not apply"; profiles.setup_state.declared.noDea stays true. restore() calls withTask(st, id, null) (src/components/features/setup/useSetupState.js:102), and withTask (src/utils/setupTasks.js:966-971) deletes only tasks[id]; the declaredNa key that closed the row is never cleared, so the page has no way to take the declaration back`,
        severity: 'medium',
      });
    }
  }, { soft: true });

  await qa.feature('SETTINGS-001', 'Narration when the total changes: "Got it" records it and it does not come back', async () => {
    // The board's total changes under a physician when Pro rows join or leave it (a tier
    // resolving, the free beta ending). Stand that in by recording an older total (0 Pro rows).
    const before = setupStateOf(profile.id);
    labExec(`update public.profiles set setup_state = jsonb_set(coalesce(setup_state, '{}'::jsonb), '{proCounted}', '0'::jsonb) where id = '${profile.id}'`);
    await reloadApp(page);
    await openSetupPage(page);
    const narration = page.getByText(/Pro added \d+ items? to your board\.|left your total/).first();
    const shown = await narration.waitFor({ timeout: 20000 }).then(() => true, () => false);
    await qa.shot('narration');
    qa.check('the board says why its total changed', shown, await narration.innerText().catch(() => `none (stored proCounted was ${before?.proCounted})`));
    if (!shown) return;
    await page.getByRole('button', { name: 'Got it' }).click();
    const acked = await waitForSetupState(profile.id, (s) => typeof s.proCounted === 'number' && s.proCounted > 0);
    qa.check('"Got it" records the new total (setup_state.proCounted)', acked?.proCounted > 0, JSON.stringify({ proCounted: acked?.proCounted }));
    await reloadApp(page);
    await openSetupPage(page);
    await sleep(1500);
    qa.check('after a reload the narration is gone', !(await page.getByText(/Pro added \d+ items? to your board\./).count()));
    const counts = await setupCountsEverywhere(page);
    await openSetupPage(page);
    const strip = await stripCounts(page);
    const want = `${strip?.done} of ${strip?.total}`;
    qa.check('Home card, More tile and Credentials rail still agree with the strip (Protected is finished here, so Home shows its one-line form)', counts.home === want && counts.more === want && counts.rail === want, JSON.stringify({ strip: want, ...counts }));
    qa.check('profiles row unchanged apart from the board', profileOf(profile.auth_user_id)?.id === profile.id);
  }, { soft: true });

});
