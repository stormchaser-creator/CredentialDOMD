// Practice > To do, Invoices and Contracts, the way a locum physician uses
// them between calls: catch interrupted work as a note, time it, finish it
// into the Work tab and bill it; share an invoice PDF again and resend an
// older text-only invoice (the lab stands in for the phone's share sheet and
// mail composer and reads what they were handed); open an agreement's summary
// and its signed file, archive and unarchive it, delete one with no work.
import { randomUUID } from 'node:crypto';
import { test } from './support/fixtures.mjs';
import {
  base64Marker, goTab, newMember, restAs, row, rows, scriptAi, sleep, syntheticPdf, tombstones, waitFor, waitForMemberApp,
} from './support/lab.mjs';
import {
  addAgreement, appOrigin, installShareStandIn, localDay, logPastTime, opened, pdfText, shared, subTab, timeText,
} from './support/practice-helpers.mjs';

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/[ \t]+/g, ' ');
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test('practice to do: capture, edit, time and finish a task into the Work tab, bill it; done, no charge; delete', {
  tag: ['@PRAC-020'],
}, async ({ page, qa, context }) => {
  const { profile } = await newMember(page, { firstName: 'Tobi', lastName: 'Todo' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin() });
  await goTab(page, 'Practice');
  await addAgreement(page, { facility: 'QA Summit Hospital', workState: 'CO', hourlyRate: 240, incrementMinutes: 15, minCallMinutes: 15 });
  await waitFor('the agreement', async () => row(`select id from public.locum_contracts where user_id = '${profile.id}'`), { timeoutMs: 20000 });

  await qa.feature('PRAC-020', 'To do: capture, edit, time, finish into Work, bill; done, no charge; delete; show done', async () => {
    await subTab(page, 'To do');
    const capture = page.getByPlaceholder(/call back Dr\. Nguyen/);
    for (const t of ['QA call back ICU consult', 'QA review outside films', 'QA sign discharge summary', 'QA note to delete']) {
      await capture.fill(t);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await sleep(300);
    }
    const notes = await waitFor('four notes', async () => { const r = rows(`select * from public.task_notes where user_id = '${profile.id}'`); return r.length === 4 ? r : null; }, { timeoutMs: 20000 }).catch(() => rows(`select * from public.task_notes where user_id = '${profile.id}'`));
    qa.check('four task_notes rows, each with its capture time and the one agreement', notes.length === 4 && notes.every((n) => n.captured_at && n.contract_id), notes.map((n) => n.text));

    // Tap the words to fix them.
    await page.getByRole('button', { name: 'QA call back ICU consult', exact: true }).click();
    const ed = page.getByRole('dialog', { name: 'Edit note' });
    await ed.locator('textarea').fill('QA call back ICU consult re: drain');
    await ed.getByRole('button', { name: 'Save', exact: true }).click();
    await ed.waitFor({ state: 'detached' });
    const renamed = await waitFor('the edit', async () => row(`select * from public.task_notes where user_id = '${profile.id}' and text = 'QA call back ICU consult re: drain'`), { timeoutMs: 15000 }).catch(() => null);
    qa.check('the edited words are saved', !!renamed);

    // Start timing, then finish it into the Work tab.
    const card = (text) => page.locator('div').filter({ has: page.getByRole('button', { name: text, exact: true }) }).filter({ has: page.getByRole('button', { name: 'Done, no charge' }) }).last();
    await card('QA call back ICU consult re: drain').getByRole('button', { name: 'Start timing' }).click();
    const started = await waitFor('started_at', async () => row(`select started_at from public.task_notes where id = '${renamed.id}'`)?.started_at || null, { timeoutMs: 15000 }).catch(() => null);
    qa.check('Start timing stamps the task', !!started);
    qa.check('the card says it is being worked', /working \d+m/.test(await card('QA call back ICU consult re: drain').innerText()));
    await card('QA call back ICU consult re: drain').getByRole('button', { name: 'Finish & log time' }).click();
    const fin = page.getByRole('dialog', { name: 'Finish and log the time' });
    await fin.waitFor();
    await fin.getByRole('button', { name: 'Consult', exact: true }).click();
    await fin.locator('input[type="date"]').fill(localDay(-1));
    await fin.locator('label', { hasText: 'Begin' }).locator('xpath=..').locator('input').first().fill(timeText('14:00'));
    await fin.locator('label', { hasText: 'End' }).locator('xpath=..').locator('input').first().fill(timeText('14:30'));
    // d53c7a1e: the old "Notes (for the invoice)" was the device-only private note and is now
    // labelled so, beside a "Billing note (shows on the invoice)" prefilled with the task's words.
    const billingNote = fin.getByRole('textbox', { name: 'Billing note (shows on the invoice)', exact: true });
    const privateField = fin.getByRole('textbox', { name: 'Private note (this device only)', exact: true });
    qa.check('Finish offers the billing note (the task\'s words) and a device-only private note', (await billingNote.inputValue().catch(() => '')) === 'QA call back ICU consult re: drain' && (await privateField.count()) === 1, await billingNote.inputValue().catch(() => 'no billing note field'));
    const privateNote = 'QA private note: reviewed imaging with the ICU team';
    await privateField.fill(privateNote);
    await qa.shot('finish task');
    await fin.getByRole('button', { name: 'Log it to the Work tab' }).click();
    const work = page.getByRole('dialog', { name: 'Log past time' });
    const opened1 = await work.waitFor({ timeout: 15000 }).then(() => true, () => false);
    qa.check('Finish opens the Work tab\'s Log past time', opened1);
    const vals = await work.locator('input, textarea').evaluateAll((els) => els.map((e) => e.value));
    await qa.shot('work form from task');
    qa.check('prefilled: 2:00 PM to 2:30 PM, the task words as the billing note', vals.some((v) => /^2:00\s?PM$/i.test(v)) && vals.some((v) => /^2:30\s?PM$/i.test(v)) && vals.includes('QA call back ICU consult re: drain'), vals);
    qa.check('the private note typed at Finish is the Work form\'s private note', vals.includes(privateNote), `field values: ${JSON.stringify(vals)}`);
    await work.getByRole('button', { name: 'Log it' }).click();
    const yes = page.getByRole('button', { name: 'Yes, log it here' });
    if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.click();
    await work.waitFor({ state: 'detached', timeout: 15000 });
    const entry = await waitFor('the work entry', async () => row(`select * from public.work_log where user_id = '${profile.id}' and description = 'QA call back ICU consult re: drain'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('a work_log row: Consult, yesterday 14:00-14:30, 30 minutes', entry?.type === 'Consult' && entry.date === localDay(-1) && entry.duration_min === 30, entry && `${entry.type} ${entry.date} ${entry.duration_min}`);
    const done = row(`select completed_at, notes from public.task_notes where id = '${renamed.id}'`);
    qa.check('the task is marked done', !!done?.completed_at, done);

    // Build an invoice with that entry and read its line.
    await page.getByRole('button', { name: /Invoice 1 unbilled entry/ }).click();
    await page.getByRole('button', { name: /^Invoice \d+ day/ }).click();
    const preview = page.getByRole('dialog', { name: 'Invoice preview' });
    await preview.waitFor();
    const lineText = (await preview.innerText()).replace(/\s+/g, ' ');
    await qa.shot('invoice line from task');
    qa.check('the invoice line carries the task\'s words', /QA call back ICU consult re: drain/.test(lineText), lineText.slice(0, 400));
    qa.check('the private note stays off the invoice and off the server', !lineText.includes(privateNote) && !entry?.private_note, `work_log.private_note ${JSON.stringify(entry?.private_note)}; ${lineText.slice(0, 200)}`);
    await preview.getByRole('button', { name: 'Copy', exact: true }).click();
    await waitFor('the invoice', async () => row(`select id from public.invoices where user_id = '${profile.id}'`), { timeoutMs: 20000 }).catch(() => null);
    await preview.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});

    // Finish another, then cancel on the Work form: nothing was billed.
    await subTab(page, 'To do');
    await card('QA review outside films').getByRole('button', { name: 'Finish & log time' }).click();
    await fin.waitFor();
    await fin.locator('label', { hasText: 'Begin' }).locator('xpath=..').locator('input').first().fill(timeText('15:00'));
    await fin.locator('label', { hasText: 'End' }).locator('xpath=..').locator('input').first().fill(timeText('15:20'));
    await fin.getByRole('button', { name: 'Log it to the Work tab' }).click();
    await work.waitFor({ timeout: 15000 });
    await work.getByRole('button', { name: 'Cancel', exact: true }).click();
    await work.waitFor({ state: 'detached' });
    await sleep(1500);
    const films = row(`select * from public.task_notes where user_id = '${profile.id}' and text = 'QA review outside films'`);
    const filmsWork = row(`select id from public.work_log where user_id = '${profile.id}' and description = 'QA review outside films'`);
    await subTab(page, 'To do');
    const stillOpen = await page.getByRole('button', { name: 'QA review outside films', exact: true }).isVisible().catch(() => false);
    if (!qa.check('cancelled on the Work form: no work entry, and the task is still open', !filmsWork && !films?.completed_at && stillOpen, { completed_at: films?.completed_at, work: !!filmsWork, stillOpen })) {
      qa.bug({
        title: 'To do: a task is marked done (and reads "billed") when its Work entry is cancelled',
        step: 'Practice > To do > Finish & log time: fill the times, Log it to the Work tab, then Cancel on the Log past time form',
        expected: 'Nothing was logged, so the task stays open to finish later',
        actual: 'The task is completed (completed_at set) and listed under finished as "billed", with no work entry: submitFinish stamps completedAt before the Work form even opens (src/components/features/locum/TaskNotes.jsx:99)',
        severity: 'medium',
      });
    }

    // Done, no charge; delete another; show done.
    await card('QA sign discharge summary').getByRole('button', { name: 'Done, no charge' }).click();
    const closed = await waitFor('closed without billing', async () => row(`select completed_at, notes from public.task_notes where user_id = '${profile.id}' and text = 'QA sign discharge summary' and completed_at is not null`), { timeoutMs: 15000 }).catch(() => null);
    qa.check('"Done, no charge" completes it as closed without billing', closed?.notes === 'closed without billing', closed);
    const del = rows(`select id from public.task_notes where user_id = '${profile.id}' and text = 'QA note to delete'`)[0];
    await page.getByRole('button', { name: 'QA note to delete', exact: true }).click();
    await ed.getByRole('button', { name: 'Delete', exact: true }).click();
    await ed.waitFor({ state: 'detached' });
    await sleep(1500);
    qa.check('the deleted note is gone and tombstoned', !row(`select id from public.task_notes where id = '${del?.id}'`) && tombstones(profile.id).some((t) => t.item_id === del?.id));
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Practice');
    await subTab(page, 'To do');
    await page.getByRole('button', { name: /^Show finished \(\d+\)$/ }).click();
    const list = await bodyText(page);
    await qa.shot('finished tasks');
    qa.check('after a reload, finished tasks list the billed one and the one closed without billing', /QA call back ICU consult re: drain[\s\S]*· billed/.test(list) && /QA sign discharge summary[\s\S]*closed, not billed/.test(list), list.slice(list.indexOf('Hide finished'), list.indexOf('Hide finished') + 600));
    qa.check('the deleted note stays gone', !/QA note to delete/.test(list));
  }, { soft: true });
});

test('practice invoices and agreements: share the PDF again, resend a text-only invoice; summary, attached file, archive, delete', {
  tag: ['@PRAC-016', '@PRAC-017'],
}, async ({ page, qa, context }) => {
  const { user, profile } = await newMember(page, { firstName: 'Ivy', lastName: 'Invoices' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin() });
  await goTab(page, 'Practice');
  const pdf = syntheticPdf(`QA synthetic locum agreement ${Date.now()}`);
  await scriptAi('gemini', { json: { confidence: 'high', extracted: { notes: 'QA synthetic terms: 30-day cancellation, travel reimbursed.' } } }, base64Marker(pdf));
  await addAgreement(page, {
    facility: 'QA Summit Hospital', agency: 'QA Locum Partners', workState: 'CO', location: 'Aurora, CO', hourlyRate: 240,
    blocks: [{ start: localDay(-20), end: localDay(10) }], attach: [{ name: 'qa-summit-agreement.pdf', mimeType: 'application/pdf', buffer: pdf }],
  });
  const contract = await waitFor('the agreement', async () => row(`select * from public.locum_contracts where user_id = '${profile.id}' and facility = 'QA Summit Hospital'`), { timeoutMs: 20000 });
  const agreementDoc = await waitFor('the attached agreement', async () => row(`select * from public.documents where user_id = '${profile.id}' and name = 'qa-summit-agreement.pdf' and storage_path is not null`), { timeoutMs: 30000 }).catch(() => null);
  // A second agreement with its own signed file, never worked.
  const pdf2 = syntheticPdf(`QA synthetic short visit agreement ${Date.now()}`);
  await scriptAi('gemini', { json: { confidence: 'high', extracted: { notes: 'QA synthetic one-week cover.' } } }, base64Marker(pdf2));
  await addAgreement(page, { facility: 'QA Short Visit Hospital', hourlyRate: 200, attach: [{ name: 'qa-short-visit-agreement.pdf', mimeType: 'application/pdf', buffer: pdf2 }] });
  const shortVisit = await waitFor('the second agreement', async () => row(`select * from public.locum_contracts where user_id = '${profile.id}' and facility = 'QA Short Visit Hospital'`), { timeoutMs: 20000 });
  const shortDoc = await waitFor('its file', async () => row(`select * from public.documents where user_id = '${profile.id}' and name = 'qa-short-visit-agreement.pdf'`), { timeoutMs: 30000 }).catch(() => null);

  // Work to bill: two consults on the Summit agreement, invoiced with the PDF.
  await subTab(page, 'Work');
  await logPastTime(page, { type: 'Consult', day: 'Yesterday', start: '09:00', end: '10:00', note: 'QA consult one' });
  await logPastTime(page, { type: 'Procedure', day: 'Yesterday', start: '11:00', end: '11:45', note: 'QA procedure two' });
  await installShareStandIn(page);
  await page.getByRole('button', { name: /Invoice 2 unbilled entries/ }).click();
  await page.getByRole('button', { name: /^Invoice \d+ day/ }).click();
  await page.getByRole('dialog', { name: 'Invoice preview' }).getByRole('button', { name: 'Send invoice…' }).click();
  await page.getByRole('button', { name: /PDF Polished invoice/ }).click();
  const invoice = await waitFor('the invoice', async () => row(`select * from public.invoices where user_id = '${profile.id}'`), { timeoutMs: 20000 });

  await qa.feature('PRAC-016', 'Share the invoice PDF again; resend an older text-only invoice', async () => {
    qa.check('the invoice is $420.00 (60 + 45 minutes at $240/hr)', Number(invoice.total_amount) === 420, `${invoice.number} $${invoice.total_amount}`);
    await subTab(page, 'Invoices');
    await installShareStandIn(page);
    await page.getByRole('row').filter({ hasText: invoice.number }).getByRole('button', { name: 'Open invoice' }).click();
    const view = page.getByRole('dialog').filter({ hasText: invoice.number }).last();
    await view.getByRole('button', { name: 'Share PDF' }).click();
    await page.getByRole('button', { name: /PDF Polished invoice/ }).click();
    const got = await waitFor('the shared PDF', async () => { const s = await shared(page); return s.length ? s : null; }, { timeoutMs: 20000 }).catch(() => []);
    const file = got.flatMap((s) => s.files).find((f) => /pdf/.test(f.type));
    await qa.shot('share pdf');
    qa.check('Share PDF hands the share sheet one PDF named for the invoice', !!file && file.name.includes(invoice.number), got.map((s) => s.files.map((f) => `${f.name} ${f.type} ${f.size}`)));
    if (file) {
      const text = await pdfText(file.base64);
      qa.check('the PDF carries the original number, facility, both lines and the $420.00 total', text.includes(invoice.number) && /QA Summit Hospital/.test(text) && /QA consult one/.test(text) && /QA procedure two/.test(text) && /\$420\.00/.test(text), text.slice(0, 600));
    }
    qa.check('the share text states the total due', got.some((s) => /\$420\.00/.test(s.text)), got.map((s) => s.text));

    // An older invoice saved as text only (no line items), as earlier versions of the app wrote them.
    const legacy = (n, total, lines) => ({ id: randomUUID(), user_id: profile.id, number: n, contract_id: contract.id, period_start: '2025-03-10', period_end: '2025-03-12', total_amount: total, total_minutes: 180, sent_at: '2025-03-13T15:00:00Z', method: 'clipboard', entry_ids: [],
      text: [`INVOICE ${n}`, 'From: Ivy Invoices, MD', 'To: QA Summit Hospital (QA Locum Partners)', 'Period: Mar 10 - Mar 12, 2025', ...lines, `TOTAL DUE: ${money(total)}`].join('\n') });
    const short = legacy('INV-20250313-01', 750, ['Mar 10  Consult 60 min  $250.00', 'Mar 11  Consult 60 min  $250.00', 'Mar 12  Consult 60 min  $250.00']);
    const long = legacy('INV-20250314-01', 3375, Array.from({ length: 27 }, (_, i) => `Mar ${String(10 + (i % 3)).padStart(2, '0')}  QA follow-up visit number ${i + 1} with a longer billing description line  $125.00`));
    for (const inv of [short, long]) {
      const r = await restAs(user, 'invoices', { method: 'POST', body: inv });
      qa.check(`the older invoice ${inv.number} is stored as the member (setup)`, r.status === 201, r.status);
    }
    qa.check('the long one is longer than a mail link carries (1,800 characters)', long.text.length > 1800, long.text.length);
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Practice');
    await subTab(page, 'Invoices');
    await installShareStandIn(page);
    await page.getByRole('row').filter({ hasText: short.number }).getByRole('button', { name: 'Resend invoice' }).click();
    const composer = await waitFor('the mail composer', async () => (await opened(page)).find((u) => /^mailto:/.test(u)) || null, { timeoutMs: 10000 }).catch(() => null);
    const mailBody = composer ? decodeURIComponent((/[?&]body=([^&]*)/.exec(composer) || [])[1] || '') : '';
    qa.check('Resend on a short text-only invoice opens the mail composer with the invoice text', !!composer && mailBody.includes('INV-20250313-01') && mailBody.includes('$750.00'), mailBody.slice(0, 300) || composer);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    qa.check('the full text is also on the clipboard', clip.includes('INV-20250313-01') && clip.includes('TOTAL DUE: $750.00'), clip.slice(0, 200));
    await page.getByRole('row').filter({ hasText: long.number }).getByRole('button', { name: 'Resend invoice' }).click();
    const longShare = await waitFor('the long invoice PDF', async () => (await shared(page)).find((s) => s.files.some((f) => /pdf/.test(f.type))) || null, { timeoutMs: 15000 }).catch(() => null);
    const longPdf = longShare?.files.find((f) => /pdf/.test(f.type));
    const longText = longPdf ? await pdfText(longPdf.base64) : '';
    await qa.shot('resend text-only');
    qa.check('Resend on a long text-only invoice shares a PDF of it with the original number and total', longText.includes('INV-20250314-01') && /\$3,375\.00/.test(longText), longText.slice(0, 300) || JSON.stringify(await shared(page)).slice(0, 300));
  }, { soft: true });

  await qa.feature('PRAC-017', 'Agreement summary and its file; archive and unarchive; delete one with no work', async () => {
    await subTab(page, 'Contracts');
    await page.getByText('QA Summit Hospital', { exact: true }).first().click();
    const sum = page.getByRole('dialog', { name: 'QA Summit Hospital' });
    await sum.waitFor();
    const text = (await sum.innerText()).replace(/\s+/g, ' ');
    await qa.shot('agreement summary');
    // Billed: the $420.00 invoice plus the two older ones ($750.00 and $3,375.00), all on this agreement.
    qa.check('the summary adds up what it billed and collected, the days worked and the hours logged', /Billed \$4,545\.00/i.test(text) && /Collected \$0\.00/i.test(text) && /Outstanding \$4,545\.00/i.test(text) && /Days worked 1/i.test(text) && /Hours logged 1\.8/i.test(text) && /Invoices \(3\)/i.test(text), text.slice(0, 400));
    qa.check('the terms: $240/hr, 15-minute increments, the key terms read from the agreement', /\$240\/hr/.test(text) && /15-min increments/.test(text), text.match(/Terms.{0,200}/)?.[0]);
    qa.check('the agency, location and coverage block', /QA Locum Partners/.test(text) && /Aurora, CO/.test(text), text.slice(0, 200));
    qa.check('the agreement document is listed', /Agreement documents \(1\)/i.test(text) && /qa-summit-agreement\.pdf/.test(text), text.match(/Agreement documents.{0,120}/i)?.[0]);
    qa.check('the stored agreement is linked to the contract', agreementDoc?.linked_to === `locumContracts:${contract.id}`, agreementDoc?.linked_to);
    // Open it, on the member's next visit (the device holds the file's row; its bytes live in storage).
    await page.keyboard.press('Escape');
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Practice');
    await subTab(page, 'Contracts');
    await page.getByText('QA Summit Hospital', { exact: true }).first().click();
    await sum.waitFor();
    const docBtn = sum.getByRole('button', { name: /qa-summit-agreement\.pdf/ });
    await sleep(3000);
    const label = (await docBtn.innerText().catch(() => '')).replace(/\s+/g, ' ');
    const popup = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
    await docBtn.click();
    const win = await popup;
    await qa.shot('open agreement file');
    if (!qa.check('tapping the agreement opens the signed file', !!win, `row reads "${label}"`)) {
      qa.bug({
        title: 'Agreement summary: the attached agreement does not open after a reload ("syncing…" forever)',
        step: 'Practice > Contracts: add an agreement with its signed PDF; reload; tap the agreement name; tap the PDF under Agreement documents',
        expected: 'The signed agreement opens',
        actual: `Nothing opens; the row reads "${label}". The viewer only opens a document whose bytes are on the device (onOpenDoc returns when !doc.data, src/components/features/locum/Contracts.jsx:385; openPdfDoc line 195), and a stored document's bytes live in account storage, not the device copy; the row calls that "syncing…" (ContractSummary.jsx:137)`,
        severity: 'medium',
      });
    }
    if (win) await win.close().catch(() => {});
    await page.keyboard.press('Escape');

    // Archive: hidden from the list; Archived (1) shows it; unarchive.
    const cardOf = (f) => page.locator('div').filter({ hasText: f }).filter({ has: page.getByRole('button', { name: /^(Archive|Unarchive)$/ }) }).last();
    await cardOf('QA Summit Hospital').getByRole('button', { name: 'Archive', exact: true }).click();
    const archived = await waitFor('archivedAt', async () => row(`select custom_fields->>'archivedAt' as a from public.locum_contracts where id = '${contract.id}'`)?.a || null, { timeoutMs: 15000 }).catch(() => null);
    qa.check('archiving stamps custom_fields.archivedAt', !!archived, archived);
    qa.check('an archived agreement is hidden from the list', !(await page.getByText('QA Summit Hospital', { exact: true }).isVisible().catch(() => false)));
    await page.getByRole('button', { name: 'Archived (1)' }).click();
    qa.check('"Archived (1)" lists it', await page.getByText('QA Summit Hospital', { exact: true }).isVisible());
    await cardOf('QA Summit Hospital').getByRole('button', { name: 'Unarchive' }).click();
    const back = await waitFor('unarchived', async () => { const r = row(`select custom_fields->>'archivedAt' as a from public.locum_contracts where id = '${contract.id}'`); return r && !r.a ? r : null; }, { timeoutMs: 15000 }).catch(() => null);
    qa.check('unarchiving clears archivedAt', !!back);
    await page.getByRole('button', { name: 'Back to active' }).click();
    qa.check('it is back in the active list', await page.getByText('QA Summit Hospital', { exact: true }).isVisible());

    // Delete an agreement with no work, confirmed.
    await cardOf('QA Short Visit Hospital').getByRole('button', { name: 'Delete agreement', exact: true }).click();
    await sleep(2000);
    const asked = qa.report.dialogs.filter((d) => /Delete this agreement/.test(d)).at(-1) || '';
    qa.check('the delete confirm says work entries keep their data', /Work log entries keep their data/.test(asked), asked);
    qa.check('the agreement is deleted and tombstoned', !row(`select id from public.locum_contracts where id = '${shortVisit.id}'`) && tombstones(profile.id).some((t) => t.item_id === shortVisit.id));
    const fileAfter = shortDoc ? row(`select id, linked_to from public.documents where id = '${shortDoc.id}'`) : null;
    if (shortDoc && !fileAfter && !/file|document|agreement pdf|signed/i.test(asked.replace(/Delete this agreement\?/, ''))) {
      qa.check('the confirm says the signed file is deleted with it', false, `confirm: "${asked}"; qa-short-visit-agreement.pdf deleted: ${!fileAfter}`);
      qa.bug({
        title: 'Deleting an agreement also deletes its signed agreement file, but the confirm does not say so',
        step: 'Practice > Contracts: an agreement with its signed PDF attached; Delete; OK',
        expected: 'The confirm names the file that goes with it (or the file stays in Documents, unlinked)',
        actual: `The confirm reads "${asked.replace(/^confirm: /, '')}"; the documents row and its stored file are deleted with the agreement (AppContext deleteItem cascades to linked documents). Contracts.jsx:372`,
        severity: 'low',
      });
    } else if (shortDoc) {
      // The confirm names the files that go with the record (f18c7a1f, 57892be3: deleteConfirmText).
      const expected = `Delete this agreement and its 1 attached file (${shortDoc.name})? The file will be removed from Files too. Work log entries keep their data. This cannot be undone.`;
      qa.check('the confirm names the signed file, which is deleted with the agreement', asked.replace(/^confirm: /, '') === expected && !fileAfter, fileAfter ? `kept, linked_to ${fileAfter.linked_to}; confirm "${asked}"` : `deleted; confirm "${asked}"`);
    }
  }, { soft: true });
});
