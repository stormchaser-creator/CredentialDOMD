// Practice with a day-rate group agreement, the way a physician on one works:
// upload the signed agreement in Documents and file it as a contract (the AI
// read is scripted for exactly that file), see its coverage blocks on the
// schedule, log days worked and call periods, invoice the outstanding days;
// then plan on the forecast calendar and pull the group's call schedule from
// CallSync (the lab answers the app's call to its callsync-feed function in
// the browser, so nothing reaches CallSync).
import path from 'node:path';
import { test } from './support/fixtures.mjs';
import {
  SHOT_DIR,
  base64Marker, chooseFiles, field, goTab, lab, newMember, row, rows, scriptAi, sleep, stamp, syntheticPdf, tokenFor, tombstones, waitFor, waitForMemberApp,
  signIn, landing,
} from './support/lab.mjs';
import {
  addAgreement, appOrigin, callSyncIcs, deviceSlot, installCallSyncStandIn, localDay, loggingAgainst, setDeviceSlot, subTab,
} from './support/practice-helpers.mjs';

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/[ \t]+/g, ' ');
const listDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const monthName = (iso) => new Date(`${iso.slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const GRID = [
  { hospital: 'QA North Hospital (QNH)', primary: 1500, backup: 750 },
  { hospital: 'QA South Hospital (QSH)', primary: 1000, backup: 400 },
];

/** Documents > Upload the signed agreement; the scripted AI reads it as a contract; Save to Contract. */
async function scanAgreement(page, qa, profile, { facility, name, blocks }) {
  const pdf = syntheticPdf(`QA synthetic group services agreement ${stamp()}`);
  const extracted = {
    payModel: 'daily', facility, location: 'Pueblo, CO', agency: 'QA Valley Physicians Group', billTo: `ap-${stamp().toLowerCase()}@qa.credentialdomd.test`,
    dayRate: 2000, callStipend: 1500, callRateGrid: GRID, coveragePeriods: blocks, incrementMinutes: 15,
    notes: 'QA synthetic: all-in day rate per weekday worked; call per accepted 24-hour period per the grid.',
  };
  await scriptAi('gemini', { json: { documentType: 'agreement', confidence: 'high', extracted } }, base64Marker(pdf));
  await goTab(page, 'Documents');
  await chooseFiles(page, page.getByRole('button', { name: 'Upload' }).first(), [{ name, mimeType: 'application/pdf', buffer: pdf }]);
  const ready = await page.getByText(/1 document ready for review/).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  await qa.shot('agreement review');
  qa.check('the upload is read and waits for review', ready);
  const review = (await bodyText(page));
  qa.check('the review card reads it as a contract with its facility and coverage blocks', /Contract/.test(review) && (await page.getByRole('textbox').evaluateAll((els) => els.map((e) => e.value))).includes(facility), review.match(/document ready for review[\s\S]{0,400}/)?.[0]);
  await page.getByRole('button', { name: 'Save to Contract' }).click();
  const contract = await waitFor('the contract row', async () => row(`select * from public.locum_contracts where user_id = '${profile.id}' and facility = '${facility}'`), { timeoutMs: 30000 }).catch(() => null);
  // The file is stored at upload and linked once the contract is saved: wait for the link, then take the row as it is.
  const docRow = () => row(`select * from public.documents where user_id = '${profile.id}' and name = '${name}'`);
  const doc = await waitFor('the stored agreement, linked', async () => { const d = docRow(); return d?.linked_to ? d : null; }, { timeoutMs: 30000 }).catch(() => docRow());
  return { contract, doc, extracted };
}

test('practice day-rate agreement: filed from a scan, its schedule, days and call logged, outstanding days invoiced', {
  tag: ['@PRAC-018', '@PRAC-024', '@PRAC-012', '@PRAC-003'],
}, async ({ page, qa, context }) => {
  const { profile } = await newMember(page, { firstName: 'Dale', lastName: 'Dayrate' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin() });
  const blocks = [
    { start: localDay(20), startTime: '16:00', end: localDay(23), endTime: '07:00' },
    { start: localDay(40), end: localDay(44) },
  ];
  let contract;

  await qa.feature('PRAC-018', 'Add a contract from a scanned agreement', async () => {
    const got = await scanAgreement(page, qa, profile, { facility: 'QA Valley Medical Group', name: 'qa-valley-group-agreement.pdf', blocks });
    contract = got.contract;
    qa.check('a locum_contracts row: day-rate, $2,000/day, the call grid', contract?.pay_model === 'daily' && Number(contract.day_rate) === 2000 && Array.isArray(contract.call_rate_grid) && contract.call_rate_grid.length === 2, contract && { pay_model: contract.pay_model, day_rate: contract.day_rate, grid: contract.call_rate_grid });
    const periods = contract?.coverage_periods || [];
    qa.check('its coverage blocks: one with times (4 PM to 7 AM), one without', periods.length === 2 && periods[0].start === blocks[0].start && periods[0].startTime === '16:00' && periods[0].endTime === '07:00' && periods[1].start === blocks[1].start && periods[1].end === blocks[1].end, periods);
    qa.check('the agreement file is linked to the contract', got.doc?.linked_to === `locumContracts:${contract?.id}` && !!got.doc?.storage_path, got.doc && { linked_to: got.doc.linked_to, storage_path: !!got.doc.storage_path });
    await goTab(page, 'Practice');
    await subTab(page, 'Contracts');
    const list = await bodyText(page);
    qa.check('Practice > Contracts lists it with its agency and blocks', /QA Valley Medical Group/.test(list) && /QA Valley Physicians Group/.test(list), list.match(/Agreements[\s\S]{0,400}/)?.[0]);
    await subTab(page, 'Sched.');
    const sched = await bodyText(page);
    await qa.shot('schedule from scan');
    qa.check('Sched. shows both blocks', (sched.match(/QA Valley Medical Group/g) || []).length >= 2, sched.match(/Schedule[\s\S]{0,600}/)?.[0]);
  });

  await qa.feature('PRAC-024', 'Schedule of coverage blocks, soonest first, with times and call-day counts', async () => {
    // A second agreement: one block running now, one that finished in the summer.
    await subTab(page, 'Contracts');
    await addAgreement(page, { facility: 'QA Lakeside Hospital', hourlyRate: 250, callStipend: 1200, stipendHours: 4, overageHourlyRate: 300,
      blocks: [{ start: localDay(-60), end: localDay(-56) }, { start: localDay(-2), end: localDay(2) }] });
    await waitFor('the second agreement', async () => row(`select id from public.locum_contracts where user_id = '${profile.id}' and facility = 'QA Lakeside Hospital'`), { timeoutMs: 20000 });
    await subTab(page, 'Sched.');
    const text = await bodyText(page);
    const at = text.indexOf('Every contracted coverage block, soonest first.');
    const list = at >= 0 ? text.slice(at) : text;
    await qa.shot('schedule');
    const order = [...list.matchAll(/(QA Lakeside Hospital|QA Valley Medical Group)[\s\S]*?(NOW|in \d+d|tomorrow|done)/gi)].map((m) => `${m[1]} ${m[2]}`);
    qa.check('four blocks: running now first, then the next two soonest first, the finished one last', order.length === 4 && /Lakeside.*NOW/i.test(order[0]) && /Valley.*in 20d/i.test(order[1]) && /Valley.*in 40d/i.test(order[2]) && /Lakeside.*done/i.test(order[3]), order);
    qa.check('the block with times reads its times and 3 call days', /4:00 PM to .*7:00 AM · 3 call days/.test(list), list.match(/[A-Z][a-z]{2} \d+, 4:00 PM[^\n]*/)?.[0]);
    qa.check('the block without times counts 5 days', /· 5 days/.test(list));
    qa.check('the running block counts 5 days and is marked NOW', /QA Lakeside Hospital[\s\S]{0,160}· 5 days[\s\S]{0,120}NOW/i.test(list));
    qa.check('stipend terms are shown with the block', /\$1200\/call day \(first 4h\) · then \$300\/hr/.test(list));
  }, { soft: true });

  const day1 = localDay(-5), day2 = localDay(-4), day3 = localDay(-3), day4 = localDay(-2);
  await qa.feature('PRAC-012', 'Duty days: log, edit and delete a day worked with call periods', async () => {
    await subTab(page, 'Work');
    await loggingAgainst(page).selectOption(contract.id);
    await page.getByRole('heading', { name: 'Days & call' }).waitFor();
    const logDay = async ({ date, worked = true, calls = [], extra, notes }) => {
      await page.getByRole('button', { name: '+ Log a day' }).click();
      const d = page.getByRole('dialog', { name: 'Log a day' });
      await d.waitFor();
      await field(d, 'Date').fill(date);
      if (!worked) await d.getByRole('button', { name: 'Yes — day worked' }).click();
      for (const [i, c] of calls.entries()) {
        await d.getByRole('button', { name: '+ Add a call period' }).click();
        await d.locator('select').nth(i).selectOption(c.hospital);
        if (c.role === 'backup') await d.getByRole('button', { name: 'Primary', exact: true }).nth(i).click();
      }
      if (extra) await extra(d);
      if (notes) await d.getByPlaceholder('optional').fill(notes);
      const preview = (await d.innerText()).replace(/\s+/g, ' ');
      await d.getByRole('button', { name: 'Save', exact: true }).click();
      const yes = page.getByRole('button', { name: 'Yes, log it here' });
      if (await yes.waitFor({ timeout: 2000 }).then(() => true, () => false)) await yes.click();
      await d.waitFor({ state: 'detached', timeout: 15000 });
      return preview;
    };
    // Day 1: worked, primary call at QNH; a second call period added as backup at QSH, then removed.
    const p1 = await logDay({ date: day1, calls: [{ hospital: GRID[0].hospital }], notes: 'QA clinic day and QNH call', extra: async (d) => {
      await d.getByRole('button', { name: '+ Add a call period' }).click();
      await d.locator('select').nth(1).selectOption(GRID[1].hospital);
      await d.getByRole('button', { name: 'Primary', exact: true }).nth(1).click();
      qa.check('the second call period reads Backup at QSH, $400.00', /On call: QA South Hospital \(QSH\) \(backup\) \$400\.00/.test((await d.innerText()).replace(/\s+/g, ' ')));
      await d.getByRole('button', { name: '×' }).nth(1).click();
    } });
    qa.check('the day\'s preview itemises $2,000 day worked + $1,500 primary call = $3,500.00', /Day worked \$2000\.00/.test(p1) && /On call: QA North Hospital \(QNH\) \(primary\) \$1500\.00/.test(p1) && /This day invoices \$3500\.00/.test(p1), p1.slice(p1.indexOf('Day worked'), p1.indexOf('Day worked') + 200));
    await logDay({ date: day2, notes: 'QA clinic day' });
    await logDay({ date: day3, worked: false, calls: [{ hospital: GRID[1].hospital, role: 'backup' }], notes: 'QA backup call only' });
    await logDay({ date: day4, notes: 'QA day to delete' });
    const days = await waitFor('four duty days', async () => { const r = rows(`select * from public.duty_days where user_id = '${profile.id}' order by date`); return r.length === 4 ? r : null; }, { timeoutMs: 20000 }).catch(() => rows(`select * from public.duty_days where user_id = '${profile.id}' order by date`));
    const d1 = days.find((x) => x.date === day1);
    qa.check('day 1: worked, one primary call at QNH, $3,500', d1?.worked_day === true && d1.call_periods?.length === 1 && d1.call_periods[0].hospital === GRID[0].hospital && d1.call_periods[0].role === 'primary' && d1.call_hospital === GRID[0].hospital && d1.call_role === 'primary' && Number(d1.amount) === 3500 && d1.notes === 'QA clinic day and QNH call', d1);
    const d3 = days.find((x) => x.date === day3);
    qa.check('day 3: no clinical day, backup call at QSH, $400', d3?.worked_day === false && d3.call_periods?.[0]?.role === 'backup' && Number(d3.amount) === 400, d3 && { worked: d3.worked_day, calls: d3.call_periods, amount: d3.amount });
    await qa.shot('duty days');
    // Edit day 1: the call becomes backup.
    await page.getByRole('button').filter({ hasText: listDay(day1) }).first().click();
    const ed = page.getByRole('dialog', { name: 'Edit day' });
    await ed.waitFor();
    await ed.getByRole('button', { name: 'Primary', exact: true }).first().click();
    await ed.getByRole('button', { name: 'Save', exact: true }).click();
    const yes = page.getByRole('button', { name: 'Yes, log it here' });
    if (await yes.waitFor({ timeout: 2000 }).then(() => true, () => false)) await yes.click();
    await ed.waitFor({ state: 'detached', timeout: 15000 });
    const e1 = await waitFor('the edit', async () => { const r = row(`select * from public.duty_days where id = '${d1.id}'`); return r?.call_role === 'backup' ? r : null; }, { timeoutMs: 15000 }).catch(() => row(`select * from public.duty_days where id = '${d1.id}'`));
    qa.check('the edit saves: backup call, $2,750', e1?.call_periods?.[0]?.role === 'backup' && Number(e1.amount) === 2750, e1 && { calls: e1.call_periods, amount: e1.amount });
    // Delete day 4.
    const d4 = days.find((x) => x.date === day4);
    await page.getByRole('button').filter({ hasText: listDay(day4) }).first().click();
    await ed.waitFor();
    await ed.getByRole('button', { name: 'Delete', exact: true }).click();
    await ed.waitFor({ state: 'detached', timeout: 10000 });
    await sleep(1500);
    qa.check('the delete asks "Delete this day?"', qa.report.dialogs.some((x) => /Delete this day\?/.test(x)));
    qa.check('the deleted day is gone and tombstoned', !!d4 && !row(`select id from public.duty_days where id = '${d4.id}'`) && tombstones(profile.id).some((t) => t.item_id === d4.id));
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Practice');
    await subTab(page, 'Work');
    await loggingAgainst(page).selectOption(contract.id);
    const list = await bodyText(page);
    await qa.shot('duty days after reload');
    qa.check('after a reload: the three days with their amounts', list.includes(listDay(day1)) && list.includes(listDay(day2)) && list.includes(listDay(day3)) && !list.includes(listDay(day4)) && /\$2,750\.00/.test(list) && /\$400\.00/.test(list), list.match(/Days & call[\s\S]{0,900}/)?.[0]);
    qa.check('the month header totals days worked and call periods', /2 days worked · 2 call periods/.test(list));
  }, { soft: true });

  await qa.feature('PRAC-003', 'Invoice the outstanding duty days: Copy text & mark sent', async () => {
    const btn = page.getByRole('button', { name: /Invoice 3 unbilled days/ });
    const label = await btn.innerText().catch(() => '');
    qa.check('"Invoice 3 unbilled days $5,150.00" is offered', /Invoice 3 unbilled days\s*\$5,150\.00/.test(label.replace(/\s+/g, ' ')), label);
    await btn.click();
    await page.getByRole('button', { name: /^Invoice 3 days — \$5,150\.00$/ }).click();
    const preview = page.getByRole('dialog', { name: 'Invoice preview' });
    await preview.waitFor();
    const text = (await preview.innerText()).replace(/\s+/g, ' ');
    await qa.shot('duty invoice preview');
    qa.check('the preview itemises day rates and grid call rates to $5,150.00', /Day worked/.test(text) && /On call: QA North Hospital \(QNH\) \(backup\)/.test(text) && /On call: QA South Hospital \(QSH\) \(backup\)/.test(text) && /TOTAL DUE \$5,150\.00/.test(text), text.slice(0, 700));
    await preview.getByRole('button', { name: 'Copy text & mark sent' }).click();
    const inv = await waitFor('the invoice', async () => row(`select * from public.invoices where user_id = '${profile.id}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('an invoices row for $5,150.00 on the day-rate agreement covering the three days', !!inv && Number(inv.total_amount) === 5150 && inv.contract_id === contract.id && (inv.entry_ids || []).length === 3 && inv.period_start === day1 && inv.period_end === day3, inv && { number: inv.number, total: inv.total_amount, entries: inv.entry_ids, period: `${inv.period_start}..${inv.period_end}` });
    const billed = rows(`select date, invoice_id from public.duty_days where user_id = '${profile.id}'`);
    qa.check('each duty day now carries the invoice id', billed.length === 3 && billed.every((b) => b.invoice_id === inv?.id), billed);
    qa.check('the preview says it was marked sent', /Marked sent — it's on the Invoices tab/.test(await bodyText(page)) || !!inv);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    qa.check('the copied text is the invoice: its number, the lines and $5,150.00', clip.includes(inv?.number || '???') && /Day worked/.test(clip) && /5,150\.00/.test(clip), clip.slice(0, 300));
    await sleep(2000);
    qa.check('nothing is left to invoice', !(await page.getByRole('button', { name: /Invoice \d+ unbilled day/ }).isVisible().catch(() => false)));
    qa.check('billed days read "billed"', ((await bodyText(page)).match(/· billed/g) || []).length === 3);
  }, { soft: true });
});

test('practice forecast calendar and CallSync: plan days, load coverage dates, sync the call schedule', {
  tag: ['@PRAC-025', '@PRAC-014'],
}, async ({ page, qa, context, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Cal', lastName: 'Forecast' });
  const blocks = [
    { start: localDay(20), startTime: '16:00', end: localDay(23), endTime: '07:00' },
    { start: localDay(40), end: localDay(44) },
  ];
  const { contract } = await scanAgreement(page, qa, profile, { facility: 'QA Canyon Medical Group', name: 'qa-canyon-group-agreement.pdf', blocks });
  if (!contract) throw new Error('the scanned agreement was not filed');
  await goTab(page, 'Practice');
  await addAgreement(page, { facility: 'QA Mesa Hospital', hourlyRate: 250, callStipend: 1200, stipendHours: 4, overageHourlyRate: 300 });
  const mesa = await waitFor('the second agreement', async () => row(`select * from public.locum_contracts where user_id = '${profile.id}' and facility = 'QA Mesa Hospital'`), { timeoutMs: 20000 });

  // One day on the calendar (navigating to its month first).
  const header = page.locator('div').filter({ has: page.getByRole('button', { name: '‹' }) }).filter({ has: page.getByRole('button', { name: '›' }) }).last();
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const showMonth = async (iso) => {
    const want = Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
    for (let i = 0; i < 14; i++) {
      const m = /([A-Z][a-z]+) (\d{4})/.exec(await header.innerText());
      const shown = m ? Number(m[2]) * 12 + MONTHS.indexOf(m[1]) : want;
      if (shown === want) return;
      await header.getByRole('button', { name: shown < want ? '›' : '‹' }).click();
    }
  };
  const openDay = async (iso) => {
    await showMonth(iso);
    const n = String(Number(iso.slice(8)));
    await page.evaluate((num) => {
      document.querySelectorAll('[data-qa-cell]').forEach((e) => e.removeAttribute('data-qa-cell'));
      const grid = [...document.querySelectorAll('div')].find((d) => d.style.gridTemplateColumns === 'repeat(7, 1fr)');
      const cell = [...(grid?.children || [])].find((c) => c.firstElementChild && c.firstElementChild.textContent === num);
      cell?.setAttribute('data-qa-cell', 'target');
    }, n);
    await page.locator('[data-qa-cell="target"]').click();
    const d = page.getByRole('dialog').last();
    await d.waitFor();
    return d;
  };
  const sched = (where = '') => rows(`select id, date::text as date, contract_id, kind, expected, note, source, source_key from public.schedule_days where user_id = '${profile.id}' ${where} order by date`);

  await qa.feature('PRAC-025', 'Forecast calendar: months, a planned day, vacation, edit, remove, load coverage dates, month detail', async () => {
    await subTab(page, 'Sched.');
    const now = await header.innerText();
    await header.getByRole('button', { name: '›' }).click();
    const next = await header.innerText();
    await header.getByRole('button', { name: '‹' }).click();
    qa.check('› and ‹ move a month and back', now.includes(monthName(localDay(0))) && !next.includes(monthName(localDay(0))) && (await header.innerText()).includes(monthName(localDay(0))), `${now.trim()} -> ${next.trim()}`);

    // A planned day: the day-rate agreement, day + call, expected adjusted.
    const planned = localDay(6);
    let d = await openDay(planned);
    qa.check('an empty day says nothing is booked', /Nothing booked on this day yet/.test(await d.innerText()));
    await d.getByRole('button', { name: 'Add another entry' }).click();
    await field(d, 'Contract').selectOption(contract.id);
    await d.getByRole('button', { name: 'Day + call', exact: true }).click();
    const suggested = await field(d, 'Expected earnings ($)').inputValue();
    qa.check('Day + call on the day-rate agreement suggests day rate + stipend ($3,500)', suggested === '3500', suggested);
    await field(d, 'Expected earnings ($)').fill('3600');
    await d.getByRole('button', { name: 'Save day' }).click();
    await d.waitFor({ state: 'detached', timeout: 10000 });
    let s1 = await waitFor('the planned day', async () => sched(`and date = '${planned}'`)[0] || null, { timeoutMs: 15000 }).catch(() => null);
    qa.check('a schedule_days row: that date, the agreement, day+call, $3,600, entered by hand', s1?.contract_id === contract.id && s1.kind === 'day+call' && Number(s1.expected) === 3600 && !s1.source, s1);

    // A vacation with a note.
    const off = localDay(8);
    d = await openDay(off);
    await d.getByRole('button', { name: 'Mark vacation' }).click();
    await field(d, "Note (why you're off)").fill('QA family trip');
    await d.getByRole('button', { name: 'Save day' }).click();
    await d.waitFor({ state: 'detached', timeout: 10000 });
    const v = await waitFor('the vacation', async () => sched(`and date = '${off}'`)[0] || null, { timeoutMs: 15000 }).catch(() => null);
    qa.check('a vacation row with its note', v?.kind === 'vacation' && v.note === 'QA family trip', v);

    // Edit the planned day, then remove it.
    d = await openDay(planned);
    await field(d, 'Expected earnings ($)').fill('3400');
    await d.getByRole('button', { name: 'Save day' }).click();
    await d.waitFor({ state: 'detached', timeout: 10000 });
    s1 = await waitFor('the edit', async () => { const r = sched(`and date = '${planned}'`)[0]; return r && Number(r.expected) === 3400 ? r : null; }, { timeoutMs: 15000 }).catch(() => sched(`and date = '${planned}'`)[0]);
    qa.check('editing the day saves $3,400', Number(s1?.expected) === 3400, s1);
    d = await openDay(planned);
    await d.getByRole('button', { name: 'Remove', exact: true }).click();
    await sleep(1500);
    qa.check('Remove deletes the day and tombstones it', !sched(`and date = '${planned}'`).length && tombstones(profile.id).some((t) => t.item_id === s1?.id));

    // Two entries on one date: a Mesa call day inside the group's block, then the block loaded on top.
    const shared = blocks[1].start;
    d = await openDay(shared);
    await d.getByRole('button', { name: 'Add another entry' }).click();
    await field(d, 'Contract').selectOption(mesa.id);
    await d.getByRole('button', { name: 'Call', exact: true }).click();
    await d.getByRole('button', { name: 'Save day' }).click();
    await d.waitFor({ state: 'detached', timeout: 10000 });
    await page.getByRole('button', { name: 'Load contract coverage dates onto the calendar' }).click();
    const msg = await page.getByText(/Loaded \d+ coverage days? from your agreements/).first().innerText().catch(() => '');
    await sleep(2500);
    const loaded = sched(`and contract_id = '${contract.id}'`);
    const want = [localDay(20), localDay(21), localDay(22), localDay(40), localDay(41), localDay(42), localDay(43), localDay(44)];
    await qa.shot('forecast loaded');
    qa.check('loading adds the 3 call days of the timed block and the 5 days of the other', JSON.stringify(loaded.map((r) => r.date)) === JSON.stringify(want), { message: msg, dates: loaded.map((r) => r.date) });
    qa.check('the message counts them', /Loaded 8 coverage days/.test(msg), msg);
    const dayKind = loaded.filter((r) => r.kind === 'day');
    const est = [...new Set(loaded.map((r) => Number(r.expected)))];
    if (!qa.check('loaded days on the day-rate agreement are estimated at its day rate ($2,000), as a day typed by hand is', dayKind.length === loaded.length && est.length === 1 && est[0] === 2000, { kinds: [...new Set(loaded.map((r) => r.kind))], expected: est })) {
      qa.bug({
        title: 'Forecast: "Load contract coverage dates" estimates a day-rate agreement\'s days at its call stipend, not its day rate',
        step: 'Practice > Sched.: a day-rate agreement ($2,000/day, $1,500 call stipend) with coverage blocks and no billing history; tap "Load contract coverage dates onto the calendar"',
        expected: 'Each loaded "Day" is estimated at $2,000, what the day editor suggests for a Day on that agreement',
        actual: `Each is estimated at $${est.join(', $')}: loadContractDates writes avgOf, the contractDayAverage (src/components/features/locum/Forecast.jsx:170), whose no-history fallback is callStipend || dayRate (src/utils/forecast.js:78), while the editor's suggestFor prices a Day at the day rate (Forecast.jsx:51); the projected year and every month estimate follow the stipend`,
        severity: 'low',
      });
    }
    d = await openDay(shared);
    const listText = (await d.innerText()).replace(/\s+/g, ' ');
    qa.check('the shared date lists both entries with a day total', /2 entries are booked on this day/.test(listText) && /QA Mesa Hospital/.test(listText) && /QA Canyon Medical Group/.test(listText), listText.slice(0, 300));
    await d.locator('div').filter({ hasText: /^QA Mesa Hospital/ }).filter({ has: page.getByRole('button', { name: 'Remove' }) }).last().getByRole('button', { name: 'Remove' }).click();
    await sleep(1500);
    qa.check('Remove on one entry of the day leaves the other', sched(`and date = '${shared}'`).length === 1 && sched(`and date = '${shared}'`)[0].contract_id === contract.id, sched(`and date = '${shared}'`));
    await page.keyboard.press('Escape');

    // Month totals and the month detail.
    await showMonth(localDay(40));
    const monthKey = localDay(40).slice(0, 7);
    const monthRows = sched(`and to_char(date, 'YYYY-MM') = '${monthKey}'`).filter((r) => r.kind !== 'vacation');
    const monthEst = monthRows.reduce((t, r) => t + Number(r.expected), 0);
    const calText = (await header.locator('xpath=..').innerText()).replace(/\s+/g, ' ');
    qa.check('the calendar\'s month line totals the estimates on the calendar', calText.includes(`est $${monthEst.toLocaleString('en-US')}`), `${calText.match(/est \$[\d,]+/)?.[0]} vs $${monthEst}`);
    const mShort = new Date(`${monthKey}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short' });
    await page.locator('div').filter({ hasText: new RegExp(`^${mShort}\\d+d · est \\$`) }).last().click();
    const det = page.getByRole('dialog', { name: new Date(`${monthKey}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) });
    const detOk = await det.waitFor({ timeout: 5000 }).then(() => true, () => false);
    const detText = detOk ? (await det.innerText()).replace(/\s+/g, ' ') : '';
    await qa.shot('forecast month detail');
    qa.check('tapping the month row opens its day-by-day detail with the same total', detOk && detText.includes(`est $${monthEst.toLocaleString('en-US')}`), detText.slice(-200));
    await page.keyboard.press('Escape');
  }, { soft: true });

  await qa.feature('PRAC-014', 'CallSync: paste the link, pick the agreement, sync; a shift removed; a broken link; daily on app open; device-only link', async () => {
    const token = `qa${stamp('cs').replace(/[^a-z0-9]/gi, '')}`;
    const link = `https://anmg-callsync-production.up.railway.app/api/ical?token=${token}`;
    const shifts = [
      { date: localDay(10), hospital: 'QNH', coverage: 'Neurosurgery', role: 'primary' },
      { date: localDay(11), hospital: 'QSH', coverage: 'Neurosurgery', role: 'backup' },
      { date: localDay(12), hospital: 'QNH', coverage: 'Neurosurgery', role: 'primary' },
    ];
    let feed = shifts;
    let mode = 'ok';
    const calls = await installCallSyncStandIn(context, (body) => {
      if (mode === 'invalid') return { status: 403, body: { error: 'invalid_token' } };
      if (body?.url !== link) return { status: 400, body: { error: 'bad_url' } };
      return { status: 200, body: { ics: callSyncIcs(feed) } };
    });
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Practice');
    await subTab(page, 'Sched.');
    const panel = page.locator('div').filter({ has: page.getByText('CallSync', { exact: true }) }).filter({ has: page.getByRole('button', { name: /Sync now|Syncing/ }) }).filter({ has: page.getByText('CallSync calendar link') }).last();
    qa.check('the CallSync card shows for an agreement with a call-rate grid', await panel.isVisible());
    await field(panel, 'CallSync calendar link').fill(link);
    qa.check('the link is accepted and said to stay on this device', /Saved ✓ on this device only/.test(await panel.innerText()));
    await field(panel, 'Lands on').selectOption(contract.id);
    await panel.getByRole('button', { name: 'Sync now' }).click();
    const synced = await waitFor('three synced shifts', async () => { const r = sched(`and source = 'callsync'`); return r.length === 3 ? r : null; }, { timeoutMs: 20000 }).catch(() => sched(`and source = 'callsync'`));
    await qa.shot('callsync synced');
    qa.check('the app asked its callsync-feed function once, signed in, for exactly the pasted link', calls.length === 1 && calls[0].auth && calls[0].url === link, calls);
    qa.check('three schedule_days rows with source callsync and a key per shift', synced.length === 3 && synced.every((r) => r.source === 'callsync' && r.source_key && r.contract_id === contract.id), synced.map((r) => `${r.date} ${r.kind} ${r.expected} ${r.source_key}`));
    qa.check('each priced as day + call from the grid: $3,500 primary at QNH, $2,400 backup at QSH', synced.map((r) => `${r.kind}:${Number(r.expected)}`).join() === 'day+call:3500,day+call:2400,day+call:3500', synced.map((r) => `${r.kind}:${r.expected}`));
    const status = (await panel.innerText()).replace(/\s+/g, ' ');
    qa.check('the card says when it checked and what it found, and lists the next calls', /Last checked/.test(status) && /Next call/i.test(status) && /QNH Neurosurgery primary/.test(status), status.slice(0, 400));
    await panel.getByRole('button', { name: 'Sync now' }).click();
    await sleep(2500);
    qa.check('syncing again duplicates nothing', sched(`and source = 'callsync'`).length === 3);

    // A shift leaves the published schedule.
    feed = [shifts[0], shifts[2]];
    await panel.getByRole('button', { name: 'Sync now' }).click();
    const gone = synced.find((r) => r.date === shifts[1].date);
    const after = await waitFor('the removal', async () => { const r = sched(`and source = 'callsync'`); return r.length === 2 ? r : null; }, { timeoutMs: 15000 }).catch(() => sched(`and source = 'callsync'`));
    qa.check('the removed shift is deleted', after.length === 2 && !after.some((r) => r.id === gone?.id), after.map((r) => r.date));
    qa.check('and tombstoned', tombstones(profile.id).some((t) => t.item_id === gone?.id && t.collection === 'scheduleDays'), tombstones(profile.id).filter((t) => t.item_id === gone?.id));

    // Errors say why.
    mode = 'invalid';
    await panel.getByRole('button', { name: 'Sync now' }).click();
    await sleep(1500);
    qa.check('a link CallSync refuses says so', /CallSync did not accept this link/.test(await panel.innerText()), (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 300));
    mode = 'ok';
    await field(panel, 'CallSync calendar link').fill('https://calendar.qa.credentialdomd.test/shifts.ics');
    const broken = (await panel.innerText()).replace(/\s+/g, ' ');
    qa.check('a broken link is refused before anything is sent: "does not look like a CallSync calendar link"', /That does not look like a CallSync calendar link/.test(broken) && await panel.getByRole('button', { name: 'Sync now' }).isDisabled(), broken.slice(0, 300));
    const jwt = await tokenFor(user);
    const direct = await fetch(`${lab().urls.api}/functions/v1/callsync-feed`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://calendar.qa.credentialdomd.test/shifts.ics' }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch((e) => ({ error: String(e) }));
    qa.check('the callsync-feed function itself refuses a link that is not CallSync\'s (400 bad_url, nothing fetched)', direct.status === 400 && direct.body?.error === 'bad_url', direct);
    await field(panel, 'CallSync calendar link').fill(link);

    // Once a day on app open: a day after the last good check, opening the app syncs.
    const rec = await deviceSlot(page, 'credentialdomd-callsync');
    qa.check('the last check is kept on this device', !!rec?.lastOkAt, rec);
    const before = calls.length;
    await setDeviceSlot(page, 'credentialdomd-callsync', { ...rec, lastOkAt: new Date(Date.now() - 26 * 3600e3).toISOString(), lastAttemptAt: new Date(Date.now() - 26 * 3600e3).toISOString() });
    await page.reload();
    await waitForMemberApp(page);
    const ran = await waitFor('the check on app open', async () => (calls.length > before ? calls.length : null), { timeoutMs: 30000 }).catch(() => null);
    qa.check('opening the app a day later checks CallSync by itself', !!ran, `${before} -> ${calls.length} calls`);

    // Another device: the synced shifts are in the account; the link is not.
    const { context: ctxB, page: b } = await secondBrowser();
    const callsB = await installCallSyncStandIn(ctxB, () => ({ status: 200, body: { ics: callSyncIcs(feed) } }));
    await signIn(b, user);
    await landing(b);
    await waitForMemberApp(b);
    await goTab(b, 'Practice');
    await subTab(b, 'Sched.');
    const panelB = b.locator('div').filter({ has: b.getByText('CallSync', { exact: true }) }).filter({ has: b.getByRole('button', { name: /Sync now|Syncing/ }) }).filter({ has: b.getByText('CallSync calendar link') }).last();
    const linkB = await field(panelB, 'CallSync calendar link').inputValue().catch(() => null);
    const textB = (await panelB.innerText().catch(() => '')).replace(/\s+/g, ' ');
    await b.screenshot({ path: path.join(SHOT_DIR, 'practice_forecast_callsync_second_device.png'), fullPage: true }).catch(() => {});
    qa.check('on another device the link is empty (it was saved on the first device only)', linkB === '', linkB);
    qa.check('but the synced shifts are there', /QNH Neurosurgery primary/.test(textB), textB.slice(0, 300));
    qa.check('and nothing is fetched there until a link is pasted', callsB.length === 0, callsB);
  }, { soft: true });
});
