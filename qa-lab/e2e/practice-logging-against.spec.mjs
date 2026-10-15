// Practice > Work, "Logging against" with a schedule (ticket 292fcbce): a
// locum with two time-priced agreements, A and B, who last logged time on A
// and is booked on B for the call day in progress (a day entered on Sched.'s
// calendar), opens Work and finds B already chosen, with no pick needed
// (AC-1). He can still switch to A, and A stays chosen after leaving Work for
// Sched. and coming back, and after a reload (AC-2). Invoices' "Needs
// invoicing" on A opens Work on A even though the schedule shows B. With
// nothing on the schedule, Work opens on the contract last used, as before.
//
// "Today" is the call day in progress: before 7 AM the physician is still on
// the previous day's call (billing.js currentCallDay, the default 7 AM rule;
// neither agreement names another hour), so the booked day is that one. Time
// is logged for earlier days only, so "the contract last used" moves without
// ever making a pick for today (utils/scheduledContract.js: time logged for
// another call day is the contract last used only).
import { test } from './support/fixtures.mjs';
import { field, goTab, newMember, rows, sleep, waitFor, waitForMemberApp } from './support/lab.mjs';
import { addAgreement, localDay, loggingAgainst, logPastTime, subTab } from './support/practice-helpers.mjs';

const LAST_CONTRACT = 'credentialdomd-last-contract';
const CONTRACT_PICK = 'credentialdomd-contract-pick';
const A = 'QA Alder Clinic';
const B = 'QA Birch Hospital';

/** The call day in progress under the default 7 AM rule, as a local YYYY-MM-DD. */
const callDayNow = () => (new Date().getHours() < 7 ? localDay(-1) : localDay(0));
/** A local calendar day `n` days before `iso`. */
const daysBefore = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return localDay(0, new Date(y, m - 1, d - n));
};

/** A device-only slot of the signed-in member, exactly as stored (null when absent). */
const rawSlot = (page, base) => page.evaluate((b) => localStorage.getItem(`${b}:${window.Clerk?.user?.id}`), base);

/** The text right under the "Logging against" picker (the schedule note), or "". */
const pickerNote = async (page) => {
  const box = page.getByText('Logging against', { exact: true }).locator('xpath=..');
  return (await box.innerText()).replace(/\s+/g, ' ');
};

test('practice work: "Logging against" opens on the contract the schedule shows today, a pick holds, Needs invoicing opens its contract', {
  tag: ['@PRAC-021', '@PRAC-025', '@PRAC-015'],
}, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Sasha', lastName: 'Schedule' });
  await goTab(page, 'Practice');
  await addAgreement(page, { facility: A, workState: 'CO', hourlyRate: 200, callHourlyRate: 180, incrementMinutes: 15 });
  await addAgreement(page, { facility: B, workState: 'CO', hourlyRate: 240, callHourlyRate: 200, incrementMinutes: 15 });
  const contracts = await waitFor('two agreements', async () => {
    const r = rows(`select id, facility from public.locum_contracts where user_id = '${profile.id}'`);
    return r.length === 2 ? r : null;
  }, { timeoutMs: 20000 });
  const idA = contracts.find((c) => c.facility === A)?.id;
  const idB = contracts.find((c) => c.facility === B)?.id;
  const today = callDayNow();
  const openWork = async () => { await subTab(page, 'Work'); await loggingAgainst(page).waitFor(); await sleep(500); };
  const shown = async () => loggingAgainst(page).inputValue();
  const leaveAndReturn = async () => { await subTab(page, 'Sched.'); await sleep(500); await openWork(); };
  const reloadWork = async () => {
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Practice');
    await openWork();
  };
  const name = (id) => (id === idA ? A : id === idB ? B : id || '(none)');

  await qa.feature('PRAC-021', 'No schedule for today: Work opens on the contract last used', async () => {
    await openWork();
    // A on an earlier day, then B on a day before that: B is the contract last
    // used, while the most recent entry (the fallback after it) is A's.
    await logPastTime(page, { contract: A, type: 'Consult', day: daysBefore(today, 2), start: '09:00', end: '10:00', note: 'QA Alder consult' });
    await logPastTime(page, { contract: B, type: 'Consult', day: daysBefore(today, 3), start: '09:00', end: '10:00', note: 'QA Birch consult' });
    const logged = await waitFor('two entries', async () => {
      const r = rows(`select contract_id, date::text as date from public.work_log where user_id = '${profile.id}' order by date`);
      return r.length === 2 ? r : null;
    }, { timeoutMs: 20000 }).catch(() => []);
    qa.check('two work_log rows: B three days back, A two days back', logged[0]?.contract_id === idB && logged[0]?.date === daysBefore(today, 3) && logged[1]?.contract_id === idA && logged[1]?.date === daysBefore(today, 2), logged);
    qa.check('nothing is on the schedule', !rows(`select id from public.schedule_days where user_id = '${profile.id}'`).length);
    qa.check('the contract last used is B, a bare id', (await rawSlot(page, LAST_CONTRACT)) === idB, await rawSlot(page, LAST_CONTRACT));
    qa.check('time logged for earlier days makes no pick for today', !(await rawSlot(page, CONTRACT_PICK)), await rawSlot(page, CONTRACT_PICK));
    await leaveAndReturn();
    qa.check('back on Work, "Logging against" shows B, the contract last used (not A, whose entry is newest)', (await shown()) === idB, name(await shown()));
    qa.check('with no "On your schedule today" note', !/On your schedule today/.test(await pickerNote(page)), await pickerNote(page));
    await reloadWork();
    qa.check('after a reload it is still B', (await shown()) === idB, name(await shown()));
    await qa.shot('no schedule last used');

    // Time on A for an earlier day again: A becomes the contract last used, still no pick.
    await logPastTime(page, { contract: A, type: 'Consult', day: daysBefore(today, 4), start: '13:00', end: '14:00', note: 'QA Alder follow-up' });
    await waitFor('the third entry', async () => rows(`select id from public.work_log where user_id = '${profile.id}'`).length === 3 || null, { timeoutMs: 20000 }).catch(() => null);
    qa.check('the contract last used is now A', (await rawSlot(page, LAST_CONTRACT)) === idA, await rawSlot(page, LAST_CONTRACT));
    qa.check('and still no pick for today', !(await rawSlot(page, CONTRACT_PICK)), await rawSlot(page, CONTRACT_PICK));
    await leaveAndReturn();
    qa.check('Work now opens on A, the contract last used', (await shown()) === idA, name(await shown()));
  }, { soft: true });

  // The call day in progress booked on B, on Sched.'s calendar.
  await qa.feature('PRAC-025', 'Book the call day in progress on B on the calendar', async () => {
    await subTab(page, 'Sched.');
    const PREV = { name: 'Previous month', exact: true };
    const NEXT = { name: 'Next month', exact: true };
    const header = page.locator('div').filter({ has: page.getByRole('button', PREV) }).filter({ has: page.getByRole('button', NEXT) }).last();
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const want = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
    for (let i = 0; i < 3; i++) {
      const m = /([A-Z][a-z]+) (\d{4})/.exec(await header.innerText());
      const at = m ? Number(m[2]) * 12 + MONTHS.indexOf(m[1]) : want;
      if (at === want) break;
      await header.getByRole('button', at < want ? NEXT : PREV).click();
    }
    const n = String(Number(today.slice(8)));
    await page.evaluate((num) => {
      document.querySelectorAll('[data-qa-cell]').forEach((e) => e.removeAttribute('data-qa-cell'));
      const grid = [...document.querySelectorAll('div')].find((d) => d.style.gridTemplateColumns === 'repeat(7, 1fr)');
      const cell = [...(grid?.children || [])].find((c) => c.firstElementChild && c.firstElementChild.textContent === num);
      cell?.setAttribute('data-qa-cell', 'target');
    }, n);
    await page.locator('[data-qa-cell="target"]').click();
    const d = page.getByRole('dialog').last();
    await d.waitFor();
    await d.getByRole('button', { name: 'Add another entry' }).click();
    await field(d, 'Contract').selectOption(idB);
    await d.getByRole('button', { name: 'Call', exact: true }).click();
    await d.getByRole('button', { name: 'Save day' }).click();
    await d.waitFor({ state: 'detached', timeout: 10000 });
    const booked = await waitFor('the booked day', async () => rows(`select date::text as date, contract_id, kind from public.schedule_days where user_id = '${profile.id}'`)[0] || null, { timeoutMs: 15000 }).catch(() => null);
    qa.check('one schedule_days row: the call day in progress, B, call', booked?.date === today && booked?.contract_id === idB && booked?.kind === 'call', booked);
  });

  await qa.feature('PRAC-021', 'AC-1: booked on B today, last used A: Work opens on B with no pick', async () => {
    await openWork();
    qa.check('"Logging against" shows B, the contract on the schedule, not A (last used)', (await shown()) === idB, name(await shown()));
    qa.check('under it: "On your schedule today"', /On your schedule today/.test(await pickerNote(page)), await pickerNote(page));
    qa.check('no pick was made: the device holds no pick for today', !(await rawSlot(page, CONTRACT_PICK)), await rawSlot(page, CONTRACT_PICK));
    qa.check('the contract last used is still A', (await rawSlot(page, LAST_CONTRACT)) === idA, await rawSlot(page, LAST_CONTRACT));
    await qa.shot('AC-1 scheduled contract');
    await reloadWork();
    qa.check('after a reload (the schedule loads from the cloud) it is still B', (await shown()) === idB, name(await shown()));
  }, { soft: true });

  await qa.feature('PRAC-015', 'Needs invoicing on A opens Work on A, on a day the schedule shows B', async () => {
    await subTab(page, 'Invoices');
    const card = page.getByText('Needs invoicing', { exact: true }).locator('xpath=..');
    await card.waitFor();
    const text = (await card.innerText()).replace(/\s+/g, ' ');
    qa.check('Needs invoicing lists A (2 unbilled entries) and B (1)', /QA Alder Clinic 2 unbilled entries/.test(text) && /QA Birch Hospital 1 unbilled entry/.test(text), text.slice(0, 300));
    await card.getByRole('button', { name: new RegExp(A) }).click();
    await loggingAgainst(page).waitFor();
    await sleep(500);
    qa.check('Work opens with "Logging against" on A', (await shown()) === idA, name(await shown()));
    qa.check('A is on screen with its unbilled work to invoice', await page.getByRole('button', { name: /Invoice 2 unbilled entries/ }).isVisible().catch(() => false));
    qa.check('the open is not a pick for today (the device holds none)', !(await rawSlot(page, CONTRACT_PICK)), await rawSlot(page, CONTRACT_PICK));
    await qa.shot('needs invoicing opens A');
    // The open is for that visit (WorkLog: "that one for this visit only"): the next visit follows the schedule again.
    await leaveAndReturn();
    qa.check('leaving Work and coming back, the schedule\'s B is shown again', (await shown()) === idB, name(await shown()));
  }, { soft: true });

  await qa.feature('PRAC-021', 'AC-2: switch to A; the pick holds after Sched. and back, and after a reload', async () => {
    await openWork();
    qa.check('Work starts on B (scheduled)', (await shown()) === idB, name(await shown()));
    await loggingAgainst(page).selectOption(idA);
    await sleep(500);
    qa.check('"Logging against" now shows A', (await shown()) === idA, name(await shown()));
    qa.check('A is not the scheduled one, so no "On your schedule today" under it', !/On your schedule today/.test(await pickerNote(page)), await pickerNote(page));
    const pick = await rawSlot(page, CONTRACT_PICK);
    let parsed = null;
    try { parsed = JSON.parse(pick); } catch { parsed = null; }
    qa.check('the device keeps the pick with its call day: A for the call day in progress', parsed?.contractId === idA && parsed?.callDay === today, pick);
    qa.check('the contract last used is A, a bare id', (await rawSlot(page, LAST_CONTRACT)) === idA, await rawSlot(page, LAST_CONTRACT));
    await leaveAndReturn();
    qa.check('after Sched. and back, "Logging against" is still A', (await shown()) === idA, name(await shown()));
    await reloadWork();
    qa.check('after a reload it is still A', (await shown()) === idA, name(await shown()));
    await qa.shot('AC-2 pick holds');
    qa.check('the schedule itself is unchanged: B booked for the call day in progress', rows(`select contract_id from public.schedule_days where user_id = '${profile.id}' and date = '${today}'`).map((r) => r.contract_id).join() === idB);
  }, { soft: true });
});
