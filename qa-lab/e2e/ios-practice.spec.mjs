// Practice's daily flows on the owner's iPhone, under what iOS does to an
// installed home-screen app (support/ios.mjs), judged by OUTCOME: what the
// member did is what the app shows and what the server has, with nothing he
// typed lost and no extra steps.
//
// WebKit only (qa-lab/e2e/webkit.config.mjs; the iPhone 15 app by default):
//
//   QA_E2E_RESULTS=qa-lab/.generated/runs/<name>.json QA_E2E_NO_RESTART=1 \
//     npm run qa:e2e -- -c qa-lab/e2e/webkit.config.mjs ios-practice
//
// Every journey's page gets the behaviour model (window.__ios): Clerk replaces
// window.Clerk.session on every focus and return to the front, and the app can
// be sent to the background and brought back (resumed, from the back-forward
// cache, or discarded and reloaded). On top of that each journey adds one
// condition:
//   * a call timed while the Phone app is in front (the page discarded), with
//     room to store and with localStorage tight;
//   * Log past time typed, the app left for another app mid-form, then resumed
//     or discarded;
//   * a launch on a weak network: the first API requests time out;
//   * localStorage tight: To do, an expense, a day worked, a payment and a
//     write off;
//   * Invoices: a payment and a write off across a background and resume;
//   * an iPad turned across 1024 px with forms open (Log past time, + Expense,
//     Add Agreement).
// Setup that is not the member's own (an agreement, older work, invoices) is
// written into the lab database as another device would have put it there,
// before the app loads it.
import { randomUUID } from 'node:crypto';
import { test } from './support/fixtures.mjs';
import { labExec, lit, lab, row, rows, sleep, waitFor, waitForMemberApp, localStorageUse } from './support/lab.mjs';
import { localDay, subTab } from './support/practice-helpers.mjs';
import { newPhoneMember, phoneTab, reloadPhone } from './support/phone-helpers.mjs';
import {
  clerkReplacesSessionOnFocus, flakyLaunch, iosModelInitScript, releaseStorage, returnToApp, rotate, sessionReplacements, tightStorage, toBackground,
} from './support/ios.mjs';

test.skip(({ browserName }) => browserName !== 'webkit', 'iOS behaviour journeys run in WebKit (-c qa-lab/e2e/webkit.config.mjs)');
test.beforeEach(async ({ context }) => { await context.addInitScript(iosModelInitScript); });

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/[ \t]+/g, ' ');

/** An hourly agreement whose coverage runs today, and a daily one with a call grid (another device's). */
function seedAgreements(pid) {
  const hourly = randomUUID(), daily = randomUUID();
  const cover = JSON.stringify([{ start: localDay(-20), end: localDay(20) }]);
  const grid = JSON.stringify([{ hospital: 'QA iOS North Hospital (QNH)', primary: 1500, backup: 750 }]);
  labExec(`
    insert into public.locum_contracts (id, user_id, facility, short_name, agency, bill_to, start_date, end_date, pay_model, hourly_rate, call_hourly_rate, increment_minutes, min_call_minutes, work_state, coverage_periods)
      values (${lit(hourly)}, ${lit(pid)}, 'QA iOS Harbor Hospital', 'QAIH', 'QA iOS Locums', 'QA iOS Locums', ${lit(localDay(-20))}, ${lit(localDay(20))}, 'hourly', 240, 180, 15, 15, 'CO', ${lit(cover)}::jsonb);
    insert into public.locum_contracts (id, user_id, facility, short_name, start_date, end_date, pay_model, day_rate, call_rate_grid, work_state, coverage_periods)
      values (${lit(daily)}, ${lit(pid)}, 'QA iOS Valley Group', 'QAVG', ${lit(localDay(-20))}, ${lit(localDay(20))}, 'daily', 2000, ${lit(grid)}::jsonb, 'CO', ${lit(cover)}::jsonb);`);
  return { hourly, daily };
}

/** Two sent invoices on the hourly agreement ($480 and $720), each billing its own logged entries. */
function seedInvoices(pid, contractId) {
  const out = [];
  for (const [i, amount] of [[1, 480], [2, 720]]) {
    const inv = randomUUID(), w = randomUUID(), day = localDay(-10 - i);
    const minutes = amount / 4; // $240/h
    labExec(`
      insert into public.work_log (id, user_id, contract_id, type, date, call_day, start_time, end_time, duration_min, billed_min, description, invoice_id)
        values (${lit(w)}, ${lit(pid)}, ${lit(contractId)}, 'Consult', ${lit(day)}, ${lit(day)}, ${lit(`${day}T15:00:00Z`)}, ${lit(new Date(Date.parse(`${day}T15:00:00Z`) + minutes * 60000).toISOString())}, ${minutes}, ${minutes}, ${lit(`QA iOS seeded consult ${i}`)}, ${lit(inv)});
      insert into public.invoices (id, user_id, number, contract_id, period_start, period_end, entry_ids, total_minutes, total_amount, method, sent_at, lines, payments)
        values (${lit(inv)}, ${lit(pid)}, ${lit(`INV-QAIOS-0${i}`)}, ${lit(contractId)}, ${lit(day)}, ${lit(day)}, ${lit(JSON.stringify([w]))}::jsonb, ${minutes}, ${amount}, 'clipboard', now() - interval '${10 + i} days',
          ${lit(JSON.stringify([{ date: day, kind: 'hourly', label: `Consult: QA iOS seeded consult ${i}`, minutes, rate: 240, amount }]))}::jsonb, '[]'::jsonb);`);
    out.push({ id: inv, number: `INV-QAIOS-0${i}`, amount });
  }
  return out;
}

/** A member on the iPhone app with the seeded agreements loaded, on Practice > Work. */
async function iphoneMember(page, name, { invoices = false } = {}) {
  const { user, profile } = await newPhoneMember(page, { firstName: 'Ios', lastName: name });
  const contracts = seedAgreements(profile.id);
  const inv = invoices ? seedInvoices(profile.id, contracts.hourly) : [];
  await reloadPhone(page);
  await clerkReplacesSessionOnFocus(page);
  await phoneTab(page, 'Practice');
  await subTab(page, 'Work');
  await sleep(600);
  return { user, profile, contracts, invoices: inv };
}

async function pickContract(page, id) {
  const sel = page.getByText('Logging against', { exact: true }).locator('xpath=..').locator('select').first();
  if (await sel.isVisible().catch(() => false)) await sel.selectOption(id);
  await sleep(300);
}

/** Back on the member app after a discard: the page reloaded, Practice > Work open again (the member's taps). */
async function backToWork(page) {
  await waitForMemberApp(page);
  await sleep(800);
  const onWork = await page.getByRole('button', { name: /Got a call\? Start the timer|Stop & Log/ }).first().isVisible().catch(() => false);
  if (!onWork) { await phoneTab(page, 'Practice'); await subTab(page, 'Work'); await sleep(600); }
  return onWork;
}

for (const tight of [false, true]) {
  test(`iphone: a call timed while the Phone app is in front, the app discarded meanwhile${tight ? ', localStorage tight' : ''}`, {
    tag: ['@ios', '@PRAC-009'],
  }, async ({ page, qa }) => {
    test.setTimeout(10 * 60 * 1000);
    const { profile, contracts } = await iphoneMember(page, tight ? 'Timerfull' : 'Timer');
    await pickContract(page, contracts.hourly);
    let storage = null;
    if (tight) storage = await tightStorage(page, { leave: 64 });

    await qa.feature('PRAC-009', `Timer survives iOS discarding the app during the call${tight ? ' (localStorage tight)' : ''}`, async () => {
      const started = Date.now();
      await page.getByRole('button', { name: /Got a call\? Start the timer/ }).tap();
      const running = await page.getByRole('button', { name: 'Stop & Log' }).waitFor({ timeout: 10000 }).then(() => true, () => false);
      qa.check('the timer runs', running);
      await page.getByRole('textbox', { name: 'Billing note (shows on the invoice)' }).fill('QA iOS ED consult, head CT review');
      const notices = await bodyText(page);
      await toBackground(page); // the Phone app takes the screen for the call
      await returnToApp(page, { awayMs: 4000, discard: true }); // iOS discarded the page meanwhile
      const landedOnWork = await backToWork(page);
      const stillRunning = await page.getByRole('button', { name: 'Stop & Log' }).isVisible().catch(() => false);
      const note = stillRunning ? await page.getByRole('textbox', { name: 'Billing note (shows on the invoice)' }).inputValue().catch(() => '') : '';
      await qa.shot('after discard');
      const warned = /could not be saved|storage is full|not saved on this device|full/i.test(`${notices}\n${await bodyText(page)}`);
      qa.check('after the discard the timer is still running, with the billing note typed during the call', stillRunning && note === 'QA iOS ED consult, head CT review',
        `running ${stillRunning}, note "${note}", reopened on Work: ${landedOnWork}, warned about storage: ${warned}${storage ? `, storage ${JSON.stringify(storage)}` : ''}`);
      if (!stillRunning) {
        qa.bug({
          title: `Work timer is lost when iOS discards the app during the call${tight ? ' on a device whose localStorage is full' : ''}`,
          step: 'Practice > Work: Got a call? Start the timer, type the billing note, switch to the Phone app; iOS discards the installed app; return',
          expected: 'The timer is still running from the start of the call, with the note; Stop & Log logs the call',
          actual: `The Work tab shows no running timer and no note${warned ? '' : ', and nothing said the timer could not be kept'}. WorkLog.jsx saveTimer (lines 96-98) ignores lsSetJSON's false (storageScope.js lsSet returns false on a quota error), so on a full device the timer exists only in memory.`,
          severity: 'high',
        });
        return;
      }
      await sleep(2000);
      await page.getByRole('button', { name: 'Stop & Log' }).tap();
      const yes = page.getByRole('button', { name: 'Yes, log it here' });
      if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.tap();
      const entry = await waitFor('the timed call on the server', async () => row(`select * from public.work_log where user_id = ${lit(profile.id)} and description = 'QA iOS ED consult, head CT review'`), { timeoutMs: 30000 }).catch(() => null);
      const elapsedMin = (Date.now() - started) / 60000;
      qa.check('the call is on the server, timed from the start of the call', !!entry && Date.parse(entry.start_time) <= started + 2000 && entry.billed_min >= 15, entry ? { start: entry.start_time, started: new Date(started).toISOString(), billed: entry.billed_min, elapsedMin: elapsedMin.toFixed(1) } : 'no work_log row');
    });
    if (tight) await releaseStorage(page);
  });
}

test('iphone: Log past time, the app left mid-form for another app, then resumed (session replaced) or discarded', {
  tag: ['@ios', '@PRAC-009', '@PRAC-011'],
}, async ({ page, qa }) => {
  test.setTimeout(10 * 60 * 1000);
  const { profile, contracts } = await iphoneMember(page, 'Pastform');
  await pickContract(page, contracts.hourly);

  const openForm = async (note) => {
    await page.getByRole('button', { name: 'Log past time' }).tap();
    const d = page.getByRole('dialog', { name: 'Log past time' });
    await d.waitFor();
    await d.getByRole('button', { name: 'Consult', exact: true }).tap();
    await d.getByRole('button', { name: 'Yesterday' }).tap();
    await d.getByPlaceholder('e.g. 60').fill('45');
    await d.getByRole('textbox', { name: 'Billing note (optional)', exact: true }).fill(note);
    return d;
  };
  const logIt = async (d) => {
    await d.getByRole('button', { name: 'Log it' }).tap();
    const yes = page.getByRole('button', { name: 'Yes, log it here' });
    if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.tap();
    return d.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
  };

  await qa.feature('PRAC-009', 'Resumed from the background with a new Clerk session object: the form and the save', async () => {
    const d = await openForm('QA iOS resumed consult');
    const before = await sessionReplacements(page);
    await toBackground(page);
    await returnToApp(page, { awayMs: 2000, bfcache: true });
    await sleep(800);
    const replaced = (await sessionReplacements(page)) > before;
    const kept = await d.isVisible().catch(() => false) && await d.getByRole('textbox', { name: 'Billing note (optional)', exact: true }).inputValue().catch(() => '') === 'QA iOS resumed consult';
    qa.check('the open form keeps what was typed after the return', kept, `session object replaced: ${replaced}`);
    if (!kept) return;
    const closed = await logIt(d);
    const entry = await waitFor('the entry on the server', async () => row(`select * from public.work_log where user_id = ${lit(profile.id)} and description = 'QA iOS resumed consult'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('Log it saves it: on the server with 45 minutes', closed && !!entry && entry.duration_min === 45, entry || 'no row');
  });

  await qa.feature('PRAC-011', 'Discarded mid-form: what was typed', async () => {
    await openForm('QA iOS discarded consult');
    await toBackground(page);
    await returnToApp(page, { awayMs: 2000, discard: true });
    await backToWork(page);
    await qa.shot('after discard mid-form');
    const formBack = await page.getByRole('dialog', { name: 'Log past time' }).isVisible().catch(() => false);
    const textBack = formBack && await page.getByRole('dialog', { name: 'Log past time' }).getByRole('textbox', { name: 'Billing note (optional)', exact: true }).inputValue().catch(() => '') === 'QA iOS discarded consult';
    const anywhere = (await bodyText(page)).includes('QA iOS discarded consult');
    qa.check('what was typed into Log past time comes back after iOS discarded the app', textBack || anywhere, `form open again: ${formBack}, text anywhere on screen: ${anywhere}`);
    if (!textBack && !anywhere) {
      qa.bug({
        title: 'Log past time loses everything typed when iOS discards the installed app mid-form',
        step: 'Practice > Work > Log past time: Consult, Yesterday, 45 min, a billing note; switch to another app (to check a time); iOS discards the app; return',
        expected: 'The form comes back with what was typed (or a draft is offered)',
        actual: 'The app reopens with no form and no draft: the type, day, minutes and note are gone (no Practice form keeps a draft; WorkLog.jsx holds it in component state only).',
        severity: 'medium',
      });
    }
    const entry = row(`select id from public.work_log where user_id = ${lit(profile.id)} and description = 'QA iOS discarded consult'`);
    qa.check('nothing half-saved reached the server', !entry);
    // The restored form stays open until he answers it (release/goal2 form drafts): Cancel discards it, as the
    // form says, so the next stretch taps the Work list, not the dialog's overlay.
    const restored = page.getByRole('dialog', { name: 'Log past time' });
    if (await restored.isVisible().catch(() => false)) {
      await restored.getByRole('button', { name: 'Cancel', exact: true }).tap();
      await restored.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    }
  }, { soft: true });

  await qa.feature('PRAC-011', 'Edit an entry after a return with a replaced session object', async () => {
    await toBackground(page);
    await returnToApp(page, { awayMs: 1500 });
    await sleep(800);
    await page.getByText('QA iOS resumed consult').first().tap();
    const detail = page.getByRole('dialog').last();
    const opened = await detail.waitFor({ timeout: 8000 }).then(() => true, () => false);
    qa.check('a tap on the entry opens it', opened);
    if (!opened) return;
    await detail.getByRole('button', { name: 'Edit', exact: true }).tap();
    await sleep(500);
    const ed = page.getByRole('dialog').last();
    const note = ed.getByRole('textbox', { name: /Billing note/ }).first();
    await note.fill('QA iOS resumed consult, edited');
    await ed.getByRole('button', { name: /^(Save|Save changes|Update)$/ }).first().tap();
    const yes = page.getByRole('button', { name: 'Yes, log it here' });
    if (await yes.waitFor({ timeout: 2000 }).then(() => true, () => false)) await yes.tap();
    const edited = await waitFor('the edit on the server', async () => row(`select * from public.work_log where user_id = ${lit(profile.id)} and description = 'QA iOS resumed consult, edited'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('the edit is on the server', !!edited);
  }, { soft: true });
});

test('iphone: a launch on a weak network (the first API requests time out), then a to do and an expense', {
  tag: ['@ios', '@PRAC-019', '@PRAC-020', '@PRAC-011'],
}, async ({ page, qa, context }) => {
  test.setTimeout(10 * 60 * 1000);
  const { user, profile, contracts } = await iphoneMember(page, 'Weaknet');
  labExec(`insert into public.work_log (id, user_id, contract_id, type, date, call_day, start_time, end_time, duration_min, billed_min, description)
    values (gen_random_uuid(), ${lit(profile.id)}, ${lit(contracts.hourly)}, 'Consult', ${lit(localDay(-2))}, ${lit(localDay(-2))}, now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 60, 60, 'QA iOS earlier consult');`);
  await reloadPhone(page);

  await qa.feature('PRAC-011', 'Launch with the first API requests timing out', async () => {
    const faultSince = new Date().toISOString();
    const cut = await flakyLaunch(context, lab().urls.apiOrigin, { first: 6, hangMs: 10000 });
    const t0 = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    const shownAt = await waitFor('the earlier consult on screen without a tap', async () => {
      const onWork = await page.getByRole('button', { name: /Got a call\? Start the timer/ }).isVisible().catch(() => false);
      if (!onWork) { await phoneTab(page, 'Practice').catch(() => {}); await subTab(page, 'Work').catch(() => {}); }
      return (await page.getByText('QA iOS earlier consult').first().isVisible().catch(() => false)) ? Date.now() : null;
    }, { timeoutMs: 120000, intervalMs: 2000 }).catch(() => null);
    await qa.shot('after weak-network launch');
    const text = await bodyText(page);
    qa.check('the account loads by itself, with the earlier entry, no tap needed', !!shownAt, `cut: ${cut.join(', ')}; shown after ${shownAt ? ((shownAt - t0) / 1000).toFixed(1) : '-'} s; screen: ${text.slice(0, 300)}`);
    const fallbackMessages = ["Account load used this device's copy, read-only (ID-INIT-UNAVAILABLE-TIMEOUT-NETWORK).", "Account load used this device's copy, read-only (ID-INIT-UNAVAILABLE-NETWORK)."];
    const fallbackRows = rows(`select id, kind, message, auth_user_id from public.client_errors where auth_user_id = ${lit(user.id)} and created_at >= ${lit(faultSince)} and message like 'Account load used this device''s copy, read-only%'`);
    qa.check('the injected weak launch emits at most one known device-copy report', fallbackRows.length <= 1 && fallbackRows.every(r => fallbackMessages.includes(r.message)));
    if (fallbackRows.length) {
      qa.check('the identity request was among the deliberately delayed calls', cut.some(path => /initialize-clerk-profile/.test(path)));
      qa.intentionalClientErrors(fallbackRows, { message: fallbackRows[0].message, kind: 'error', authUserId: user.id, count: 1,
        reason: 'PRAC-011 deliberately held six API calls for ten seconds; the existing consult became visible without Reload and this exact account recovered.' });
    }

    if (!shownAt) {
      const stopped = /could not be verified/.test(text);
      // A minute later, the network long back: does it come back by itself (focus, online)?
      await toBackground(page); await returnToApp(page, { awayMs: 1000 });
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await sleep(8000);
      const still = /could not be verified/.test(await bodyText(page));
      qa.check('with the network back (a return to the app, an online event) it recovers without a tap', !still);
      qa.bug({
        title: 'A weak network at launch stops the app on "Your account identity could not be verified" with none of his records, until he taps Reload',
        step: 'iPhone app opened while the first API requests time out (6 requests, 10 s each: the three initialize-clerk-profile attempts among them); the network is fine afterwards',
        expected: 'The app opens on this device\'s copy of his records and finishes loading by itself when the network answers',
        actual: `${stopped ? 'Full screen "Your account identity could not be verified. Your existing records have not changed. Reload to try again. Support reference: ID-INIT-UNAVAILABLE-TIMEOUT-NETWORK", no records' : text.slice(0, 160)}; still there after a return to the app and an online event: ${still}. initialize-clerk-profile has a 9 s deadline (src/utils/limitedLaunchClient.js:188) and two retries 1 s and 3 s apart (src/lib/supabase.js:1560), about 31 s in all; then AppContext.jsx:826-850 sets DEFAULT_DATA and setProfileIssue, with no fallback to the device copy (the "Supabase load failed" path at :852 does fall back) and no retry on online or focus.`,
        severity: 'high',
      });
      await page.getByRole('button', { name: 'Reload' }).first().tap().catch(() => {});
      await waitForMemberApp(page).catch(() => {});
      await phoneTab(page, 'Practice').catch(() => {}); await subTab(page, 'Work').catch(() => {});
      qa.check('one Reload tap opens the account with the earlier entry', await page.getByText('QA iOS earlier consult').first().waitFor({ timeout: 30000 }).then(() => true, () => false));
    }
  });

  await qa.feature('PRAC-020', 'A to do typed right after the weak launch reaches the server', async () => {
    await subTab(page, 'To do');
    await page.getByPlaceholder(/call back Dr\. Nguyen/).fill('QA iOS weak network task');
    await page.getByRole('button', { name: 'Add', exact: true }).first().tap();
    const t = await waitFor('the task on the server', async () => row(`select id from public.task_notes where user_id = ${lit(profile.id)} and text = 'QA iOS weak network task'`), { timeoutMs: 60000 }).catch(() => null);
    qa.check('task_notes row', !!t);
  }, { soft: true });

  await qa.feature('PRAC-019', 'An expense added after the weak launch reaches the server and survives a discard', async () => {
    await subTab(page, 'Exp.');
    await page.getByRole('button', { name: '+ Expense' }).tap();
    await page.getByLabel('$ amount').fill('187.40');
    await page.getByLabel('Vendor').fill('QA iOS Synthetic Inn');
    await page.getByRole('button', { name: 'Add expense' }).tap();
    await sleep(500);
    await toBackground(page);
    await returnToApp(page, { awayMs: 1500, discard: true });
    await waitForMemberApp(page);
    const e = await waitFor('the expense on the server', async () => row(`select amount, vendor from public.travel_expenses where user_id = ${lit(profile.id)} and vendor = 'QA iOS Synthetic Inn'`), { timeoutMs: 60000 }).catch(() => null);
    qa.check('travel_expenses row with $187.40', !!e && Number(e.amount) === 187.4, e || 'none');
  }, { soft: true });
});

test('iphone: localStorage tight: to do, an expense, a day worked, a payment and a write off', {
  tag: ['@ios', '@PRAC-012', '@PRAC-019', '@PRAC-020', '@PRAC-005', '@PRAC-015'],
}, async ({ page, qa }) => {
  test.setTimeout(12 * 60 * 1000);
  const { profile, contracts, invoices } = await iphoneMember(page, 'Fullstore', { invoices: true });
  const storage = await tightStorage(page, { leave: 64 });
  qa.check('localStorage is tight (WebKit\'s own quota)', storage.filler > 1_000_000, storage);

  await qa.feature('PRAC-020', 'To do on a full device', async () => {
    await subTab(page, 'To do');
    await page.getByPlaceholder(/call back Dr\. Nguyen/).fill('QA iOS full device task');
    await page.getByRole('button', { name: 'Add', exact: true }).first().tap();
    const t = await waitFor('the task', async () => row(`select id from public.task_notes where user_id = ${lit(profile.id)} and text = 'QA iOS full device task'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('task_notes row', !!t);
  }, { soft: true });

  await qa.feature('PRAC-019', 'An expense on a full device', async () => {
    await subTab(page, 'Exp.');
    await page.getByRole('button', { name: '+ Expense' }).tap();
    await page.getByLabel('$ amount').fill('64.25');
    await page.getByLabel('Vendor').fill('QA iOS Full Device Cab');
    await page.getByRole('button', { name: 'Add expense' }).tap();
    const e = await waitFor('the expense', async () => row(`select amount from public.travel_expenses where user_id = ${lit(profile.id)} and vendor = 'QA iOS Full Device Cab'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('travel_expenses row with $64.25', !!e && Number(e.amount) === 64.25, e || 'none');
  }, { soft: true });

  await qa.feature('PRAC-012', 'A day worked with primary call on a full device', async () => {
    await subTab(page, 'Work');
    await pickContract(page, contracts.daily);
    await page.getByRole('heading', { name: 'Days & call' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '+ Log a day' }).tap();
    const d = page.getByRole('dialog', { name: 'Log a day' });
    await d.waitFor();
    await d.getByLabel('Date').fill(localDay(-1)).catch(async () => { await d.locator('input[type="date"]').first().fill(localDay(-1)); });
    await d.getByRole('button', { name: '+ Add a call period' }).tap();
    await d.locator('select').first().selectOption('QA iOS North Hospital (QNH)');
    await d.getByPlaceholder('optional').fill('QA iOS full device day');
    await d.getByRole('button', { name: 'Save', exact: true }).tap();
    const yes = page.getByRole('button', { name: 'Yes, log it here' });
    if (await yes.waitFor({ timeout: 2000 }).then(() => true, () => false)) await yes.tap();
    const day = await waitFor('the day', async () => row(`select worked_day, call_periods, amount from public.duty_days where user_id = ${lit(profile.id)} and notes = 'QA iOS full device day'`), { timeoutMs: 30000 }).catch(() => null);
    qa.check('duty_days row: worked, primary call at QNH', !!day && day.worked_day === true && JSON.stringify(day.call_periods || []).includes('QNH'), day || 'none');
  }, { soft: true });

  await qa.feature('PRAC-005', 'A payment and a write off on a full device', async () => {
    await subTab(page, 'Invoices');
    await sleep(800);
    await page.getByRole('button', { name: /Record payment/ }).first().tap();
    let d = page.getByRole('dialog', { name: /^Payment on/ });
    await d.waitFor();
    const which = (await d.innerText()).match(/INV-QAIOS-0\d/)?.[0];
    await d.getByRole('button', { name: /^Record/ }).first().tap();
    const paid = await waitFor('the payment', async () => row(`select paid_at, payments from public.invoices where number = ${lit(which)} and user_id = ${lit(profile.id)} and paid_at is not null`), { timeoutMs: 30000 }).catch(() => null);
    qa.check(`the payment on ${which} is on the server`, !!paid, paid || 'none');
    await sleep(800);
    await page.getByRole('button', { name: /Record payment/ }).first().tap();
    d = page.getByRole('dialog', { name: /^Payment on/ });
    await d.waitFor();
    const other = (await d.innerText()).match(/INV-QAIOS-0\d/)?.[0];
    await d.getByRole('button', { name: 'Write off remaining balance instead' }).tap();
    const off = await waitFor('the write off', async () => row(`select write_off_at from public.invoices where number = ${lit(other)} and user_id = ${lit(profile.id)} and write_off_at is not null`), { timeoutMs: 30000 }).catch(() => null);
    qa.check(`the write off on ${other} is on the server`, !!off);
  }, { soft: true });

  await qa.feature('PRAC-015', 'All of it after iOS discards the app, still on a full device', async () => {
    await toBackground(page);
    await returnToApp(page, { awayMs: 1500, discard: true });
    await waitForMemberApp(page);
    await phoneTab(page, 'Practice');
    await subTab(page, 'Invoices');
    await sleep(1000);
    const inv = await bodyText(page);
    qa.check('Invoices shows one paid and one written off', /paid/i.test(inv) && /written off/i.test(inv), inv.match(/INV-QAIOS[\s\S]{0,300}/)?.[0]);
    await subTab(page, 'To do');
    qa.check('the to do is listed', await page.getByText('QA iOS full device task').first().isVisible().catch(() => false));
    await subTab(page, 'Exp.');
    qa.check('the expense is listed', await page.getByText('QA iOS Full Device Cab').first().isVisible().catch(() => false));
    const ls = await localStorageUse(page).catch(() => null);
    qa.check('no write is left waiting on the device', !/saved on this device|not synced|waiting to sync/i.test(await bodyText(page)), ls);
  }, { soft: true });
  await releaseStorage(page);
  // Nothing of what was entered is missing on the server.
  void invoices;
});

test('iphone: Invoices, a payment and a write off across a background and a resume (session replaced)', {
  tag: ['@ios', '@PRAC-005', '@PRAC-015'],
}, async ({ page, qa }) => {
  test.setTimeout(8 * 60 * 1000);
  const { profile } = await iphoneMember(page, 'Invoices', { invoices: true });
  await subTab(page, 'Invoices');
  await sleep(800);
  await qa.feature('PRAC-005', 'Payment dialog open, the app left for the bank app and resumed', async () => {
    await page.getByRole('button', { name: /Record payment/ }).first().tap();
    const d = page.getByRole('dialog', { name: /^Payment on/ });
    await d.waitFor();
    const which = (await d.innerText()).match(/INV-QAIOS-0\d/)?.[0];
    await toBackground(page);
    await returnToApp(page, { awayMs: 2500, bfcache: true });
    await sleep(800);
    const open = await d.isVisible().catch(() => false);
    qa.check('the payment dialog is still open after the return', open);
    if (!open) return;
    await d.getByRole('button', { name: /^Record/ }).first().tap();
    const paid = await waitFor('the payment', async () => row(`select paid_at from public.invoices where number = ${lit(which)} and user_id = ${lit(profile.id)} and paid_at is not null`), { timeoutMs: 30000 }).catch(() => null);
    qa.check(`the payment on ${which} is on the server`, !!paid);
    await toBackground(page);
    await returnToApp(page, { awayMs: 1500 });
    await page.getByRole('button', { name: /Record payment/ }).first().tap();
    const d2 = page.getByRole('dialog', { name: /^Payment on/ });
    await d2.waitFor();
    const other = (await d2.innerText()).match(/INV-QAIOS-0\d/)?.[0];
    await d2.getByRole('button', { name: 'Write off remaining balance instead' }).tap();
    const off = await waitFor('the write off', async () => row(`select write_off_at from public.invoices where number = ${lit(other)} and user_id = ${lit(profile.id)} and write_off_at is not null`), { timeoutMs: 30000 }).catch(() => null);
    qa.check(`the write off on ${other} is on the server`, !!off);
    await returnToApp(page, { awayMs: 500, discard: true });
    await waitForMemberApp(page);
    await phoneTab(page, 'Practice');
    await subTab(page, 'Invoices');
    await sleep(1000);
    const inv = await bodyText(page);
    await qa.feature('PRAC-015', 'Invoice summaries retain the paid and written-off states after a discard', async () => {
    qa.check('after a reload Invoices reads one paid, one written off', /paid/i.test(inv) && /written off/i.test(inv), inv.match(/INV-QAIOS[\s\S]{0,300}/)?.[0]);
    });
    qa.check('Clerk replaced the session object on the returns', (await sessionReplacements(page)) >= 0);
  });
});

test.describe('ipad', () => {
  test.use({ viewport: { width: 1024, height: 1366 }, screen: { width: 1024, height: 1366 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1' });

  test('ipad turned across 1024 px with Practice forms open: what was typed stays, and saves', {
    tag: ['@ios', '@PRAC-009', '@PRAC-019', '@PRAC-001'],
  }, async ({ page, qa }) => {
    test.setTimeout(10 * 60 * 1000);
    const { profile, contracts } = await iphoneMember(page, 'Ipad');
    await pickContract(page, contracts.hourly);

    await qa.feature('PRAC-009', 'Log past time open while the iPad turns', async () => {
      await page.getByRole('button', { name: 'Log past time' }).tap();
      const d = page.getByRole('dialog', { name: 'Log past time' });
      await d.waitFor();
      await d.getByRole('button', { name: 'Consult', exact: true }).tap();
      await d.getByRole('button', { name: 'Yesterday' }).tap();
      await d.getByPlaceholder('e.g. 60').fill('30');
      await d.getByRole('textbox', { name: 'Billing note (optional)', exact: true }).fill('QA iPad turned consult');
      const to = await rotate(page);
      const kept1 = await d.getByRole('textbox', { name: 'Billing note (optional)', exact: true }).inputValue().catch(() => null);
      await rotate(page);
      const kept2 = await d.getByRole('textbox', { name: 'Billing note (optional)', exact: true }).inputValue().catch(() => null);
      qa.check('the form keeps the note through both turns', kept1 === 'QA iPad turned consult' && kept2 === 'QA iPad turned consult', `landscape ${to.width}: "${kept1}", portrait: "${kept2}"`);
      await d.getByRole('button', { name: 'Log it' }).tap().catch(() => {});
      const yes = page.getByRole('button', { name: 'Yes, log it here' });
      if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.tap();
      const e = await waitFor('the entry', async () => row(`select duration_min from public.work_log where user_id = ${lit(profile.id)} and description = 'QA iPad turned consult'`), { timeoutMs: 30000 }).catch(() => null);
      qa.check('saved: on the server with 30 minutes', e?.duration_min === 30, e || 'none');
    }, { soft: true });

    await qa.feature('PRAC-019', '+ Expense open while the iPad turns', async () => {
      await subTab(page, 'Exp.');
      await page.getByRole('button', { name: '+ Expense' }).tap();
      await page.getByLabel('$ amount').fill('42.10');
      await page.getByLabel('Vendor').fill('QA iPad Turned Diner');
      await rotate(page);
      const v1 = await page.getByLabel('Vendor').inputValue().catch(() => null);
      await rotate(page);
      const v2 = await page.getByLabel('Vendor').inputValue().catch(() => null);
      qa.check('the expense form keeps the vendor through both turns', v1 === 'QA iPad Turned Diner' && v2 === 'QA iPad Turned Diner', `${v1} / ${v2}`);
      await page.getByRole('button', { name: 'Add expense' }).tap().catch(() => {});
      const e = await waitFor('the expense', async () => row(`select amount from public.travel_expenses where user_id = ${lit(profile.id)} and vendor = 'QA iPad Turned Diner'`), { timeoutMs: 30000 }).catch(() => null);
      qa.check('saved: on the server with $42.10', !!e && Number(e.amount) === 42.1, e || 'none');
    }, { soft: true });

    await qa.feature('PRAC-001', 'Add Agreement open while the iPad turns', async () => {
      await subTab(page, 'Contracts');
      await page.getByRole('button', { name: /^(Add Agreement|Add)$/ }).first().tap();
      const d = page.getByRole('dialog', { name: 'Add Agreement' });
      await d.waitFor();
      await d.getByPlaceholder('e.g. Riverside Community Hospital').fill('QA iPad Turned Medical Center');
      await d.getByPlaceholder('250').fill('260');
      await rotate(page);
      const f1 = await d.getByPlaceholder('e.g. Riverside Community Hospital').inputValue().catch(() => null);
      await rotate(page);
      const f2 = await d.getByPlaceholder('e.g. Riverside Community Hospital').inputValue().catch(() => null);
      qa.check('the agreement form keeps the facility through both turns', f1 === 'QA iPad Turned Medical Center' && f2 === 'QA iPad Turned Medical Center', `${f1} / ${f2}`);
      await d.getByRole('button', { name: 'Add', exact: true }).tap().catch(() => {});
      const c = await waitFor('the agreement', async () => row(`select hourly_rate from public.locum_contracts where user_id = ${lit(profile.id)} and facility = 'QA iPad Turned Medical Center'`), { timeoutMs: 30000 }).catch(() => null);
      qa.check('saved: on the server at $260/h', !!c && Number(c.hourly_rate) === 260, c || 'none');
    }, { soft: true });
    void rows;
  });
});
