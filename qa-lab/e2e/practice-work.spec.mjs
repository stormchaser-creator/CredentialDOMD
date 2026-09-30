// Practice > Work, the way a locum physician logs time: pick the agreement
// being logged (an ended one only on request, and remembered), run the call
// timer with a billing note and a private note (it survives a reload; a stray
// tap asks before billing an increment; a timer started by mistake is
// discarded), dictate an entry (the lab stands in for the microphone), log a
// call that crosses the start of the call day on a contract that splits it,
// edit and delete entries, and meet an entry that is already on an invoice.
import { test } from './support/fixtures.mjs';
import { goTab, lit, newMember, row, rows, scriptAi, sleep, stamp, tombstones, waitFor, waitForMemberApp } from './support/lab.mjs';
import {
  addAgreement, appOrigin, deviceSlot, installSpeechStandIn, localDay, loggingAgainst, logPastTime, setDeviceSlot, subTab, timeText, utcDay, watchAiRequests,
} from './support/practice-helpers.mjs';

const TIMER = 'credentialdomd-live-timer';
const VAULT = 'credentialdomd-private-vault';
const LAST_CONTRACT = 'credentialdomd-last-contract';
const bodyText = async (page) => (await page.locator('body').innerText()).replace(/[ \t]+/g, ' ');
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// Save changes on the entry form; an entry outside every coverage block is asked about again.
async function saveEntryEdit(page, dialog) {
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  const yes = page.getByRole('button', { name: 'Yes, log it here' });
  if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
}

async function openWork(page, facility) {
  await goTab(page, 'Practice');
  await subTab(page, 'Work');
  if (facility) {
    const sel = loggingAgainst(page);
    const opt = await sel.locator('option', { hasText: facility }).first().getAttribute('value');
    await sel.selectOption(opt);
  }
}

test('practice work: contract picker with an ended agreement, the call timer, dictating an entry', {
  tag: ['@PRAC-021', '@PRAC-008', '@PRAC-022'],
}, async ({ page, qa, context }) => {
  const { profile } = await newMember(page, { firstName: 'Tara', lastName: 'Timer' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin() });
  await goTab(page, 'Practice');
  await addAgreement(page, { facility: 'QA Hourly Clinic', workState: 'CO', hourlyRate: 200, callHourlyRate: 180, incrementMinutes: 15, minCallMinutes: 15 });
  await addAgreement(page, { facility: 'QA Riverside Locum', hourlyRate: 220, blocks: [{ start: localDay(-10), end: localDay(20) }] });
  await addAgreement(page, { facility: 'QA Ended Locum', hourlyRate: 150, blocks: [{ start: localDay(-130), end: localDay(-100) }] });
  const contracts = await waitFor('three agreements', async () => { const r = rows(`select id, facility from public.locum_contracts where user_id = '${profile.id}'`); return r.length === 3 ? r : null; }, { timeoutMs: 20000 });
  const idOf = (f) => contracts.find((c) => c.facility === f)?.id;

  await qa.feature('PRAC-021', 'Pick the contract being logged; an ended one only on request; the choice is remembered', async () => {
    await subTab(page, 'Work');
    const sel = loggingAgainst(page);
    const labels = await sel.locator('option').allInnerTexts();
    await qa.shot('logging against');
    qa.check('the current agreements are offered', labels.some((l) => /QA Hourly Clinic/.test(l)) && labels.some((l) => /QA Riverside Locum/.test(l)), labels);
    qa.check('the agreement that ended 100 days ago is not offered', !labels.some((l) => /QA Ended Locum/.test(l)), labels);
    qa.check('"Show ended contracts (1)" is offered', labels.includes('Show ended contracts (1)'), labels);
    await sel.selectOption('__show_ended__');
    const after = await sel.locator('option').allInnerTexts();
    qa.check('after "Show ended contracts" the ended agreement is listed', after.some((l) => /QA Ended Locum/.test(l)) && !after.some((l) => /Show ended/.test(l)), after);
    await sel.selectOption(idOf('QA Ended Locum'));
    await sleep(500);
    qa.check('the timer card names the chosen agreement', /QA Ended Locum · 15-min increments/.test(await bodyText(page)));
    qa.check('the choice is kept on this device', (await page.evaluate((b) => localStorage.getItem(`${b}:${window.Clerk?.user?.id}`), LAST_CONTRACT)) === idOf('QA Ended Locum'));
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Practice');
    await subTab(page, 'Work');
    const kept = await loggingAgainst(page).inputValue();
    qa.check('after a reload the ended agreement is still the one being logged', kept === idOf('QA Ended Locum'), kept);
    const afterReload = await loggingAgainst(page).locator('option').allInnerTexts();
    qa.check('after the reload the other ended agreements stay hidden behind the option (the chosen one is listed)', afterReload.some((l) => /QA Ended Locum/.test(l)), afterReload);
    await loggingAgainst(page).selectOption(idOf('QA Hourly Clinic'));
  });

  await qa.feature('PRAC-008', 'Call timer: live clock, notes, reload, Stop & Log, discard, a stray tap', async () => {
    await openWork(page, 'QA Hourly Clinic');
    await page.getByRole('button', { name: /Got a call\? Start the timer/ }).click();
    const card = page.locator('div').filter({ has: page.getByRole('button', { name: 'Stop & Log' }) }).last();
    await card.waitFor();
    const read = async () => {
      const t = (await card.innerText()).replace(/[ \t]+/g, ' ');
      const m = /(?:(\d+):)?(\d{2}):(\d{2})\s*\n?\s*Will bill as (\d+) min/.exec(t);
      return { text: t, sec: m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : NaN, billed: m ? Number(m[4]) : NaN };
    };
    const atTap = await read();
    await sleep(1500);
    const first = await read();
    await sleep(2500);
    const second = await read();
    if (!qa.check('the clock starts at zero, never negative', /\b00:0\d\b/.test(atTap.text) && !/-\d/.test(atTap.text.split('Will bill')[0]), atTap.text.slice(0, 80))) {
      qa.bug({
        title: 'The call timer shows a negative clock ("-1:-1:-1") for its first second',
        step: 'Practice > Work: open the Work tab, wait a moment, tap "Got a call? Start the timer"',
        expected: 'The clock reads 00:00 and counts up',
        actual: `It reads "${(/[-\d:]+(?=\s*\n?\s*Will bill)/.exec(atTap.text) || [''])[0]}" until the first tick: WorkLog keeps the time it last ticked in \`now\` (src/components/features/locum/WorkLog.jsx:138, only ticking while a timer runs, lines 178-182), and the elapsed time (line 1088) is \`now\` minus a start time taken later, so it is negative by however long the tab was open; fmtClock prints each negative part`,
        severity: 'low',
      });
    }
    qa.check('the card says a Call is in progress at QA Hourly Clinic', /call in progress/i.test(first.text) && /QA Hourly Clinic/.test(first.text), first.text.slice(0, 120));
    qa.check('the clock runs', second.sec > first.sec, `${first.sec}s then ${second.sec}s`);
    qa.check('it will bill as 15 min (the call minimum)', second.billed === 15, second.text.match(/Will bill as[^\n]*/)?.[0]);
    const billingNote = `QA timer billing note ${stamp('t')}`;
    await card.getByRole('textbox', { name: 'Billing note (shows on the invoice)', exact: true }).fill(billingNote);
    await card.getByRole('textbox', { name: 'Private note (only you see this)', exact: true }).fill('QA private reminder bed twelve');
    await qa.shot('timer running');
    await page.reload();
    await waitForMemberApp(page);
    await openWork(page);
    const card2 = page.locator('div').filter({ has: page.getByRole('button', { name: 'Stop & Log' }) }).last();
    const survived = await card2.waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('the running timer survives a reload on this device', survived);
    if (survived) {
      qa.check('with both notes', await card2.getByRole('textbox', { name: 'Billing note (shows on the invoice)', exact: true }).inputValue() === billingNote && await card2.getByRole('textbox', { name: 'Private note (only you see this)', exact: true }).inputValue() === 'QA private reminder bed twelve');
    }
    const stored = await deviceSlot(page, TIMER);
    qa.check('the timer lives in this device\'s storage, not the cloud', stored?.type === 'Call' && !!stored?.startedAt, stored);
    // Two and a half minutes on the clock: the lab moves the timer's start back instead of waiting.
    await setDeviceSlot(page, TIMER, { ...stored, startedAt: new Date(Date.now() - 150000).toISOString() });
    await page.reload();
    await waitForMemberApp(page);
    await openWork(page);
    const aged = await page.locator('div').filter({ has: page.getByRole('button', { name: 'Stop & Log' }) }).last().innerText();
    qa.check('the clock reads past 2:30 after the reload', /\b02:[3-5]\d\b/.test(aged), aged.slice(0, 120));
    const before = rows(`select id from public.work_log where user_id = '${profile.id}'`).length;
    await page.getByRole('button', { name: 'Stop & Log' }).click();
    const entry = await waitFor('the timed entry', async () => row(`select * from public.work_log where user_id = '${profile.id}' and description = ${lit(billingNote)}`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('Stop & Log (over 2 minutes) asks nothing', !qa.report.dialogs.some((d) => /seconds on the clock/.test(d)));
    qa.check('one work_log row: a Call on today\'s date, 3 minutes logged, billed 15 (15-minute increment)', entry?.type === 'Call' && entry.duration_min === 3 && entry.billed_min === 15 && entry.date === localDay(0), entry && `${entry.type} ${entry.date} ${entry.duration_min}/${entry.billed_min}`);
    qa.check('the billing note is the entry\'s description and the private note is not uploaded', entry?.description === billingNote && !entry?.private_note, entry && { description: entry.description, private_note: entry.private_note });
    qa.check('the private note is kept on this device for that entry', (await deviceSlot(page, VAULT))?.[`workLog:${entry?.id}`] === 'QA private reminder bed twelve', await deviceSlot(page, VAULT));
    qa.check('the timer is gone from the device', !(await deviceSlot(page, TIMER)));
    qa.check('the list shows the entry with its private note marked', await page.getByRole('row').filter({ hasText: billingNote }).first().isVisible().catch(() => false));
    await qa.shot('timer logged');

    // Started by mistake: discard, confirmed.
    await page.getByRole('button', { name: 'Procedure', exact: true }).first().click();
    await page.getByRole('button', { name: /Discard \(started by mistake\)/ }).click();
    await sleep(1000);
    qa.check('Discard asks first', qa.report.dialogs.some((d) => /Discard this timer without logging any time/.test(d)));
    qa.check('a discarded timer logs nothing', rows(`select id from public.work_log where user_id = '${profile.id}'`).length === before + 1);
    qa.check('and the timer is gone', !(await page.getByRole('button', { name: 'Stop & Log' }).isVisible().catch(() => false)));

    // A stray tap: stopped within seconds, the app asks; Cancel keeps it running.
    await page.getByRole('button', { name: 'Rounding', exact: true }).first().click();
    await sleep(1500);
    qa.onDialog((d) => (/seconds on the clock/.test(d.message()) ? 'dismiss' : 'accept'));
    await page.getByRole('button', { name: 'Stop & Log' }).click();
    await sleep(800);
    const asked = qa.report.dialogs.filter((d) => /seconds on the clock/.test(d)).at(-1) || '';
    qa.check('stopping within 2 minutes asks, naming the seconds and the 15 minutes it would bill', /Only \d+ seconds on the clock, and logging bills 15 min/.test(asked), asked);
    qa.check('Cancel keeps the timer running and logs nothing', await page.getByRole('button', { name: 'Stop & Log' }).isVisible() && rows(`select id from public.work_log where user_id = '${profile.id}'`).length === before + 1);
    qa.onDialog(null);
    await page.getByRole('button', { name: 'Stop & Log' }).click();
    const stray = await waitFor('the confirmed short entry', async () => row(`select * from public.work_log where user_id = '${profile.id}' and type = 'Rounding'`), { timeoutMs: 15000 }).catch(() => null);
    qa.check('confirmed, it logs one Rounding entry billed at the 15-minute increment', stray?.billed_min === 15 && stray.duration_min === 1, stray && `${stray.duration_min}/${stray.billed_min}`);
  }, { soft: true });

  await qa.feature('PRAC-022', 'Dictate a work entry: Log past time opens prefilled', async () => {
    await openWork(page, 'QA Hourly Clinic');
    const tag = stamp('dict');
    const words = `Transfer call last night from eight fifteen to eight twenty five PM about an acute subdural, reference ${tag}, remind me it was bed twelve`;
    await scriptAi('gemini', { json: {
      type: 'Transfer call', date: localDay(-1), start: '20:15', end: '20:25', durationMin: null,
      billingNote: `Transfer call, acute subdural (${tag})`, privateNote: 'bed twelve',
    } }, tag);
    const sent = watchAiRequests(page);
    const usageBefore = rows(`select id from public.ai_usage where user_id = '${profile.id}'`).length;
    await installSpeechStandIn(page, words);
    await page.getByRole('button', { name: /Dictate an entry: say what you did/ }).click();
    await page.getByText(new RegExp(tag)).first().waitFor({ timeout: 10000 });
    await qa.shot('dictating');
    await page.getByRole('button', { name: /Done, build the entry/ }).click();
    const d = page.getByRole('dialog', { name: 'Log past time' });
    const opened = await d.waitFor({ timeout: 45000 }).then(() => true, () => false);
    qa.check('"Done, build the entry" opens Log past time', opened);
    if (!opened) return;
    await qa.shot('dictated entry prefilled');
    const vals = await d.locator('input, textarea').evaluateAll((els) => els.map((e) => e.value));
    const typeOn = await d.getByRole('button', { name: 'Transfer call', exact: true }).evaluate((b) => getComputedStyle(b).color === 'rgb(255, 255, 255)');
    qa.check('the type is Transfer call', typeOn);
    qa.check('start 8:15 PM and end 8:25 PM', vals.some((v) => /^8:15\s?PM$/i.test(v)) && vals.some((v) => /^8:25\s?PM$/i.test(v)), vals);
    qa.check('the billing note is filled and the private note holds the reminder', vals.includes(`Transfer call, acute subdural (${tag})`) && vals.includes('bed twelve'), vals);
    const yesterdayOn = await d.getByRole('button', { name: 'Yesterday', exact: true }).evaluate((b) => getComputedStyle(b).color === 'rgb(255, 255, 255)');
    qa.check('the day is yesterday', yesterdayOn);
    const body = sent.find((b) => b.includes(tag)) || '';
    qa.check('the words went to the AI through ai-proxy', !!body, `${sent.length} ai-proxy requests`);
    const today = /TODAY is (\d{4}-\d{2}-\d{2})/.exec(body)?.[1];
    const ok = qa.check('the AI is told today\'s date on the physician\'s calendar', today === localDay(0), `sent ${today}, local ${localDay(0)}, UTC ${utcDay()}`);
    if (!ok) {
      qa.bug({
        title: 'Work dictation tells the AI the UTC date as "today" in the US evening',
        step: 'Practice > Work > Dictate an entry after 5 PM Pacific; the words say "last night" or give no date',
        expected: `TODAY is ${localDay(0)} (the physician's day), so "last night" is ${localDay(-1)} and an undated entry is dated today`,
        actual: `TODAY is ${today}: parseWorkDictation (src/utils/workDictation.js:54) uses new Date().toISOString().slice(0, 10), the UTC day; "last night" is read as the wrong day and an undated entry falls back to tomorrow (the same line), which Log it then questions as future time`,
        severity: 'medium',
      });
    }
    await d.getByRole('button', { name: 'Log it' }).click();
    const yes = page.getByRole('button', { name: 'Yes, log it here' });
    if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.click();
    await d.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
    const saved = await waitFor('the dictated entry', async () => row(`select * from public.work_log where user_id = '${profile.id}' and description like '%${tag}%'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('saved as a Transfer call yesterday 20:15 to 20:25, billed at the 15-minute minimum', saved?.type === 'Transfer call' && saved.date === localDay(-1) && hhmm(saved.start_time) === '20:15' && hhmm(saved.end_time) === '20:25' && saved.billed_min === 15, saved && `${saved.type} ${saved.date} ${hhmm(saved.start_time)}-${hhmm(saved.end_time)} ${saved.billed_min}`);
    qa.check('the private reminder stays on the device', !saved?.private_note && (await deviceSlot(page, VAULT))?.[`workLog:${saved?.id}`] === 'bed twelve');
    const usage = await waitFor('an ai_usage row', async () => { const r = rows(`select provider, path, ok from public.ai_usage where user_id = '${profile.id}'`); return r.length > usageBefore ? r : null; }, { timeoutMs: 15000 }).catch(() => []);
    qa.check('the AI call is metered (ai_usage)', usage.length > usageBefore, usage.slice(-1));
  }, { soft: true });
});

test('practice work: a call split at the start of the call day, edit and delete entries, a billed entry', {
  tag: ['@PRAC-010', '@PRAC-011'],
}, async ({ page, qa, context }) => {
  const { profile } = await newMember(page, { firstName: 'Sam', lastName: 'Splitter' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin() });
  await goTab(page, 'Practice');
  await addAgreement(page, { facility: 'QA Split Stipend Hospital', workState: 'CO', callStipend: 1500, stipendHours: 4, overageHourlyRate: 300, splitAtDayStart: true });
  await addAgreement(page, { facility: 'QA Hourly Clinic', workState: 'CO', hourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15 });
  const split = await waitFor('the split contract', async () => row(`select * from public.locum_contracts where user_id = '${profile.id}' and facility = 'QA Split Stipend Hospital'`), { timeoutMs: 20000 });

  await qa.feature('PRAC-010', 'A call from 8 PM to 9 AM is split at the 7 AM start of the call day; edited whole; deleted whole', async () => {
    qa.check('the agreement saved with split at day start, 7 AM', split.split_at_day_start === true && (split.day_start_hour ?? 7) === 7, split && `${split.split_at_day_start} ${split.day_start_hour}`);
    await openWork(page, 'QA Split Stipend Hospital');
    const first = await logPastTime(page, { type: 'Call', day: 'Yesterday', start: '20:00', end: '09:00', note: 'QA overnight call', placement: 'back' });
    qa.check('with no coverage block on file, the app asks before logging', first.asked);
    await sleep(800);
    qa.check('"Go back" saves nothing and keeps the form', rows(`select id from public.work_log where user_id = '${profile.id}'`).length === 0 && await first.dialog.isVisible());
    await first.dialog.getByRole('button', { name: 'Log it' }).click();
    await page.getByRole('button', { name: 'Yes, log it here' }).click();
    await first.dialog.waitFor({ state: 'detached', timeout: 15000 });
    const pieces = await waitFor('two pieces', async () => { const r = rows(`select * from public.work_log where user_id = '${profile.id}' and description = 'QA overnight call' order by start_time`); return r.length >= 2 ? r : null; }, { timeoutMs: 20000 }).catch(() => rows(`select * from public.work_log where user_id = '${profile.id}' order by start_time`));
    await qa.shot('split call');
    qa.check('two work_log rows sharing one split_group_id', pieces.length === 2 && !!pieces[0].split_group_id && pieces[0].split_group_id === pieces[1].split_group_id, pieces.map((p) => p.split_group_id));
    qa.check('8:00 PM to 7:00 AM on yesterday\'s call day, 7:00 AM to 9:00 AM on today\'s', pieces.length === 2 && hhmm(pieces[0].start_time) === '20:00' && hhmm(pieces[0].end_time) === '07:00' && hhmm(pieces[1].start_time) === '07:00' && hhmm(pieces[1].end_time) === '09:00' && pieces[0].call_day === localDay(-1) && pieces[1].call_day === localDay(0), pieces.map((p) => `${hhmm(p.start_time)}-${hhmm(p.end_time)} ${p.call_day} ${p.billed_min}`));
    qa.check('the minutes add up to the whole call (780 logged, 780 billed)', pieces.reduce((t, p) => t + p.duration_min, 0) === 780 && pieces.reduce((t, p) => t + p.billed_min, 0) === 780, pieces.map((p) => `${p.duration_min}/${p.billed_min}`));
    qa.check('the notice says where each piece counts', /crossed the 7:00 AM start of the call day, so it is split/.test(await bodyText(page)));

    // Edit it as a whole: the form opens with the whole call.
    await page.getByRole('row').filter({ hasText: 'QA overnight call' }).first().getByRole('button', { name: 'Edit entry' }).click();
    const ed = page.getByRole('dialog', { name: 'Edit entry' });
    await ed.waitFor();
    const vals = await ed.locator('input').evaluateAll((els) => els.map((e) => e.value));
    qa.check('the edit form holds the whole call: 8:00 PM to 9:00 AM', vals.some((v) => /^8:00\s?PM$/i.test(v)) && vals.some((v) => /^9:00\s?AM$/i.test(v)), vals);
    await ed.locator('label', { hasText: 'End time' }).locator('xpath=..').locator('input').first().fill(timeText('10:00'));
    await saveEntryEdit(page, ed);
    await sleep(2000);
    const edited = rows(`select * from public.work_log where user_id = '${profile.id}' and description = 'QA overnight call' order by start_time`);
    qa.check('after the edit: still two pieces sharing one group, the second now ends at 10:00 AM', edited.length === 2 && edited[0].split_group_id === edited[1].split_group_id && hhmm(edited[1].end_time) === '10:00' && hhmm(edited[0].start_time) === '20:00', edited.map((p) => `${hhmm(p.start_time)}-${hhmm(p.end_time)} ${p.split_group_id}`));
    qa.check('the pieces kept their ids', edited.map((p) => p.id).sort().join() === pieces.map((p) => p.id).sort().join());

    // Delete it: both pieces go.
    await page.getByRole('row').filter({ hasText: 'QA overnight call' }).first().getByRole('button', { name: 'Delete entry' }).click();
    await sleep(1500);
    qa.check('the delete asks "Delete all 2?"', qa.report.dialogs.some((d) => /split at the start of the call day into 2 parts\. Delete all 2\?/.test(d)), qa.report.dialogs.slice(-1));
    const left = rows(`select id from public.work_log where user_id = '${profile.id}' and description = 'QA overnight call'`);
    qa.check('both pieces are deleted', left.length === 0, left);
    const tombs = tombstones(profile.id).filter((t) => edited.some((p) => p.id === t.item_id));
    qa.check('both pieces are tombstoned', tombs.length === 2, tombs);
  }, { soft: true });

  await qa.feature('PRAC-011', 'View, edit and delete work entries; a billed entry', async () => {
    await openWork(page, 'QA Hourly Clinic');
    await logPastTime(page, { type: 'Consult', day: 'Yesterday', start: '10:00', end: '11:00', note: 'QA consult to edit', privateNote: 'QA reminder consult' });
    await logPastTime(page, { type: 'Procedure', day: 'Yesterday', start: '13:00', end: '13:45', note: 'QA procedure to delete', privateNote: 'QA reminder procedure' });
    const consult = await waitFor('the consult', async () => row(`select * from public.work_log where user_id = '${profile.id}' and description = 'QA consult to edit'`), { timeoutMs: 20000 });
    const proc = await waitFor('the procedure', async () => row(`select * from public.work_log where user_id = '${profile.id}' and description = 'QA procedure to delete'`), { timeoutMs: 20000 });

    // Tap the entry: its detail; Edit; change the end time; save; reload.
    await page.getByRole('row').filter({ hasText: 'QA consult to edit' }).first().click();
    const view = page.getByRole('dialog', { name: 'Consult' });
    await view.waitFor();
    const viewText = (await view.innerText()).replace(/\s+/g, ' ');
    await qa.shot('entry detail');
    qa.check('the detail shows the billing note, the private note and "not yet invoiced"', /QA consult to edit/.test(viewText) && /QA reminder consult/.test(viewText) && /not yet invoiced/.test(viewText), viewText.slice(0, 300));
    await view.getByRole('button', { name: 'Edit', exact: true }).click();
    const ed = page.getByRole('dialog', { name: 'Edit entry' });
    await ed.waitFor();
    await ed.locator('label', { hasText: 'End time' }).locator('xpath=..').locator('input').first().fill(timeText('11:30'));
    await saveEntryEdit(page, ed);
    const changed = await waitFor('the edit', async () => { const r = row(`select * from public.work_log where id = '${consult.id}'`); return r && hhmm(r.end_time) === '11:30' ? r : null; }, { timeoutMs: 20000 }).catch(() => row(`select * from public.work_log where id = '${consult.id}'`));
    qa.check('the edit reaches the cloud: ends 11:30, 90 minutes, still unbilled', hhmm(changed.end_time) === '11:30' && changed.duration_min === 90 && changed.billed_min === 90 && !changed.invoice_id, `${hhmm(changed.end_time)} ${changed.duration_min}/${changed.billed_min}`);
    await page.reload();
    await waitForMemberApp(page);
    await openWork(page);
    qa.check('after a reload the list shows 90 minutes for the consult', /90/.test(await page.getByRole('row').filter({ hasText: 'QA consult to edit' }).first().innerText()));

    // Delete an unbilled entry, confirmed.
    await page.getByRole('row').filter({ hasText: 'QA procedure to delete' }).first().getByRole('button', { name: 'Delete entry' }).click();
    await sleep(1500);
    qa.check('the delete asks "Delete this entry?"', qa.report.dialogs.some((d) => /^confirm: Delete this entry\?$/.test(d)));
    qa.check('the entry is deleted and tombstoned', !row(`select id from public.work_log where id = '${proc.id}'`) && tombstones(profile.id).some((t) => t.item_id === proc.id));
    const vault = (await deviceSlot(page, VAULT)) || {};
    if (!qa.check('its private note leaves this device with it', !vault[`workLog:${proc.id}`], vault)) {
      qa.bug({
        title: 'Deleting a work entry leaves its private (patient-identifying) note in the device vault',
        step: 'Practice > Work: log an entry with a private note; delete the entry (Delete this entry? OK)',
        expected: 'The note leaves the device with the entry, as a split entry\'s delete and the day-rate list\'s delete already do',
        actual: 'The note stays in credentialdomd-private-vault on the device (and in its private-notes export) with no entry to show it: WorkLog deleteEntry (src/components/features/locum/WorkLog.jsx:1039) calls deleteItem without removePrivate',
        severity: 'low',
      });
    }

    // Bill the consult, then try to change it.
    await page.getByRole('button', { name: /Invoice 1 unbilled entry/ }).click();
    await page.getByRole('button', { name: /^Invoice \d+ day/ }).click();
    const preview = page.getByRole('dialog', { name: 'Invoice preview' });
    await preview.waitFor();
    await preview.getByRole('button', { name: 'Copy', exact: true }).click();
    const billed = await waitFor('the billed consult', async () => { const r = row(`select * from public.work_log where id = '${consult.id}'`); return r?.invoice_id ? r : null; }, { timeoutMs: 20000 }).catch(() => null);
    const inv = billed ? row(`select * from public.invoices where id = '${billed.invoice_id}'`) : null;
    qa.check('the consult is on an invoice for $300.00 (90 minutes at $200/hr)', !!inv && Number(inv.total_amount) === 300, inv && `${inv.number} $${inv.total_amount}`);
    await preview.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    const billedRow = page.getByRole('row').filter({ hasText: 'QA consult to edit' }).first();
    qa.check('a billed entry has no Delete', (await billedRow.getByRole('button', { name: 'Delete entry' }).count()) === 0);
    await billedRow.getByRole('button', { name: 'Edit entry' }).click();
    const ed2 = page.getByRole('dialog', { name: 'Edit entry' });
    await ed2.waitFor();
    await ed2.locator('label', { hasText: 'End time' }).locator('xpath=..').locator('input').first().fill(timeText('12:00'));
    qa.onDialog((d) => (/already billed/.test(d.message()) ? 'dismiss' : 'accept'));
    await ed2.getByRole('button', { name: 'Save changes' }).click();
    const yes2 = page.getByRole('button', { name: 'Yes, log it here' });
    if (await yes2.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes2.click();
    await sleep(1200);
    const warned = qa.report.dialogs.filter((d) => /already billed/.test(d)).at(-1) || '';
    await qa.shot('billed entry edit');
    qa.check('changing a billed entry is questioned, naming the invoice and saying to delete the invoice to change it', warned.includes(inv?.number || 'INV-') && /delete it in the Invoices tab/.test(warned), warned);
    qa.check('declined: the billed entry is unchanged', hhmm(row(`select end_time from public.work_log where id = '${consult.id}'`).end_time) === '11:30');
    qa.onDialog(null);
    await page.keyboard.press('Escape');
    await ed2.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    // The design: after the warning the record can be edited; the sent invoice stays as it went.
    await page.getByRole('row').filter({ hasText: 'QA consult to edit' }).first().getByRole('button', { name: 'Edit entry' }).click();
    await ed2.waitFor();
    await ed2.locator('label', { hasText: 'End time' }).locator('xpath=..').locator('input').first().fill(timeText('12:00'));
    await saveEntryEdit(page, ed2).catch(() => {});
    await sleep(2000);
    const after = row(`select end_time, duration_min, invoice_id from public.work_log where id = '${consult.id}'`);
    const invAfter = inv ? row(`select total_amount from public.invoices where id = '${inv.id}'`) : null;
    qa.check('accepted: the record changes (by design, per the warning) and the invoice that went out keeps its $300.00', !!after && hhmm(after.end_time) === '12:00' && Number(invAfter?.total_amount) === 300 && after.invoice_id === inv?.id, { entry: after && `${hhmm(after.end_time)} ${after.duration_min}`, invoice: invAfter });
  }, { soft: true });
});
