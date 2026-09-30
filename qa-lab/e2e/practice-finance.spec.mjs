// More > Finance, the way a 1099 locum physician keeps the money side: the
// tax estimate from a filing profile and paid invoices, estimated payments
// recorded, edited and removed; the deduction ledger with manual lines, a
// year filter, the CSV for the CPA and the printed memo; and a card statement
// imported (a billed-to-agency row, a re-import of the same file, and a file
// whose columns name patients). Every file is synthetic.
import { readFileSync } from 'node:fs';
import { test } from './support/fixtures.mjs';
import { chooseFiles, field, goTab, newMember, openMore, row, rows, sleep, tombstones, waitFor, waitForMemberApp, syncWarnings } from './support/lab.mjs';
import { addAgreement, localDay, logPastTime, subTab, utcDay } from './support/practice-helpers.mjs';

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/[ \t]+/g, ' ');
const YEAR = String(new Date().getFullYear());

async function openFinance(page, tab) {
  await openMore(page, 'Finance');
  await page.getByRole('button', { name: tab, exact: true }).click();
}

test('practice tax prep: filing profile and assumptions drive the estimate; estimated payments recorded, edited, removed', {
  tag: ['@PRAC-027'],
}, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Tess', lastName: 'Taxes' });
  // Income on a cash basis: a paid invoice for work in Colorado.
  await goTab(page, 'Practice');
  await addAgreement(page, { facility: 'QA Front Range Hospital', workState: 'CO', hourlyRate: 250, incrementMinutes: 15, minCallMinutes: 15 });
  await subTab(page, 'Work');
  for (const [start, end] of [['08:00', '12:00'], ['13:00', '17:00']]) await logPastTime(page, { type: 'Procedure', day: 'Yesterday', start, end, note: `QA procedure block ${start}` });
  await page.getByRole('button', { name: /Invoice 2 unbilled entries/ }).click();
  await page.getByRole('button', { name: /^Invoice \d+ day/ }).click();
  await page.getByRole('dialog', { name: 'Invoice preview' }).getByRole('button', { name: 'Copy', exact: true }).click();
  const inv = await waitFor('the invoice', async () => row(`select * from public.invoices where user_id = '${profile.id}'`), { timeoutMs: 20000 });
  await sleep(1600);
  await subTab(page, 'Invoices');
  await page.getByRole('button', { name: 'Record payment' }).first().click();
  const pay = page.getByRole('dialog').last();
  const amt = pay.locator('input[type="number"], input[inputmode="decimal"]').first();
  if (await amt.count()) await amt.fill(String(inv.total_amount));
  await pay.getByRole('button', { name: /^(Record|Save|Record payment|Mark paid)/ }).last().click();
  await waitFor('the payment', async () => row(`select paid_at from public.invoices where id = '${inv.id}'`)?.paid_at || null, { timeoutMs: 15000 });

  await qa.feature('PRAC-027', 'Tax prep: profile and assumptions; estimated payments', async () => {
    await openFinance(page, 'Tax Prep');
    const estimate = async () => Number(((/Estimated \d{4} tax, all jurisdictions\s*\$([\d,]+)/i.exec(await bodyText(page)) || [])[1] || 'NaN').replace(/,/g, ''));
    qa.check('with no filing profile it asks for one', /Set your resident state and filing status to see estimates/.test(await bodyText(page)));
    await field(page, 'Resident state').selectOption('CO');
    await field(page, 'Filing status').selectOption({ index: 1 });
    await field(page, 'Entity').selectOption('scorp');
    await field(page, 'S-corp W-2 salary ($/yr)').fill('1000');
    await field(page, 'Other household taxable income ($/yr)').fill('0');
    await field(page, `Total ${Number(YEAR) - 1} tax (for safe harbor)`).fill('40000');
    await sleep(1500);
    const e1 = await estimate();
    await qa.shot('tax estimate');
    qa.check('an estimate appears once the profile is set', Number.isFinite(e1) && e1 > 0, e1);
    await field(page, 'Other household taxable income ($/yr)').fill('300000');
    await sleep(1200);
    const e2 = await estimate();
    qa.check('more household income raises the estimate', e2 > e1, `${e1} -> ${e2}`);
    await field(page, 'Entity').selectOption('soleprop');
    await sleep(1200);
    const e3 = await estimate();
    qa.check('switching to sole proprietor recalculates it', Number.isFinite(e3) && e3 !== e2, `${e2} -> ${e3}`);
    const text = await bodyText(page);
    qa.check('the safe harbor is 110% of the prior-year tax ($44,000)', /safe harbor for the year: \$44,000/.test(text), text.match(/safe harbor[^\n]*/)?.[0]);
    qa.check('gross collected is the paid invoice', new RegExp(`Gross collected\\s*\\$${Number(inv.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`).test(text), text.match(/Gross collected[^\n]*/)?.[0]);
    const tp = await waitFor('the profile', async () => { const r = row(`select tax_prep from public.profiles where id = '${profile.id}'`)?.tax_prep; return r?.otherIncome === '300000' && r?.entity === 'soleprop' ? r : null; }, { timeoutMs: 15000 }).catch(() => row(`select tax_prep from public.profiles where id = '${profile.id}'`)?.tax_prep);
    qa.check('profiles.tax_prep holds the profile and assumptions', tp?.residentState === 'CO' && !!tp.filingStatus && tp.entity === 'soleprop' && tp.otherIncome === '300000' && tp.priorYearTax === '40000', tp);

    // Record a payment to the IRS.
    const recordFederal = () => page.getByRole('row').filter({ hasText: 'Federal (IRS)' }).first().getByRole('button', { name: 'Record', exact: true }).click();
    await recordFederal();
    const d = page.getByRole('dialog', { name: 'Record payment, Federal (IRS)' });
    await d.waitFor();
    const defaultDate = await field(d, 'Date').inputValue();
    if (!qa.check('the payment date starts at today on the physician\'s calendar', defaultDate === localDay(0), `form ${defaultDate}; local ${localDay(0)}; UTC ${utcDay()}`)) {
      qa.bug({
        title: 'Tax Prep: an estimated payment recorded in the US evening defaults to tomorrow\'s date',
        step: 'More > Finance > Tax Prep > Record (Federal) after 5 PM Pacific',
        expected: `The date field starts at ${localDay(0)}, today where the physician is`,
        actual: `It starts at ${defaultDate}: TaxPrep's today is new Date().toISOString().slice(0, 10), the UTC day (src/components/features/locum/TaxPrep.jsx:66), also used to pick the next due date`,
        severity: 'low',
      });
    }
    await field(d, 'Amount ($)').fill('5000');
    await field(d, 'Date').fill(localDay(-2));
    await field(d, 'Note').fill('QA Q3 1040-ES');
    await d.getByRole('button', { name: 'Save payment' }).click();
    await d.waitFor({ state: 'detached' });
    const p1 = await waitFor('the payment row', async () => row(`select id, jurisdiction, date::text as date, amount, tax_year, note from public.tax_payments where user_id = '${profile.id}'`), { timeoutMs: 15000 }).catch(() => null);
    qa.check('a tax_payments row: federal, the date, $5,000, this tax year, the note', p1?.jurisdiction === 'federal' && p1.date === localDay(-2) && Number(p1.amount) === 5000 && p1.tax_year === YEAR && p1.note === 'QA Q3 1040-ES', p1);
    qa.check('the ledger shows $5,000 paid', /\$5,000 paid/.test(await bodyText(page)));
    // Edit it.
    await page.getByRole('row').filter({ hasText: 'QA Q3 1040-ES' }).getByRole('button', { name: 'Edit payment' }).click();
    const e = page.getByRole('dialog', { name: 'Edit payment, Federal (IRS)' });
    await e.waitFor();
    await field(e, 'Amount ($)').fill('5500');
    await e.getByRole('button', { name: 'Save changes' }).click();
    await e.waitFor({ state: 'detached' });
    const p2 = await waitFor('the edit', async () => { const r = row(`select amount from public.tax_payments where id = '${p1.id}'`); return Number(r?.amount) === 5500 ? r : null; }, { timeoutMs: 15000 }).catch(() => null);
    qa.check('the edit saves $5,500', !!p2);
    // A second payment to delete.
    await recordFederal();
    await d.waitFor();
    await field(d, 'Amount ($)').fill('750');
    await field(d, 'Note').fill('QA payment to remove');
    await d.getByRole('button', { name: 'Save payment' }).click();
    await d.waitFor({ state: 'detached' });
    const p3 = await waitFor('the second payment', async () => row(`select id from public.tax_payments where user_id = '${profile.id}' and note = 'QA payment to remove'`), { timeoutMs: 15000 }).catch(() => null);
    await page.getByRole('row').filter({ hasText: 'QA payment to remove' }).getByRole('button', { name: 'Delete payment' }).click();
    await sleep(1500);
    qa.check('removing asks "Remove this payment record?"', qa.report.dialogs.some((x) => /Remove this payment record\?/.test(x)));
    qa.check('the removed payment is gone and tombstoned', !!p3 && !row(`select id from public.tax_payments where id = '${p3.id}'`) && tombstones(profile.id).some((t) => t.item_id === p3.id));
    // Reload: all of it stays.
    await page.reload();
    await waitForMemberApp(page);
    await openFinance(page, 'Tax Prep');
    const after = await bodyText(page);
    await qa.shot('tax prep after reload');
    qa.check('after a reload the profile, the estimate and the $5,500 payment are there', /Colorado resident/i.test(after) && /sole proprietor/i.test(after) && /\$5,500 paid/.test(after) && Math.abs((await estimate()) - e3) < 1, after.match(/Estimated[\s\S]{0,200}/)?.[0]);
  }, { soft: true });
});

test('practice deductions and card statements: manual lines, year filter, CSV and memo; import, re-import, a patient file refused', {
  tag: ['@PRAC-028', '@PRAC-029'],
}, async ({ page, qa }) => {
  const { profile } = await newMember(page, { firstName: 'Dev', lastName: 'Deductions' });
  await goTab(page, 'Practice');
  await addAgreement(page, { facility: 'QA Import Hospital', agency: 'QA Import Agency', workState: 'CO', hourlyRate: 250, blocks: [{ start: `${YEAR}-08-01`, end: `${YEAR}-12-31` }] });
  const ledger = () => rows(`select id, category, description, amount, tax_year, source, date from public.deductibles where user_id = '${profile.id}' order by created_at`);
  const warnStart = qa.report.console.length;

  await qa.feature('PRAC-028', 'Deductions ledger: manual lines, year filter, CSV, memo, remove', async () => {
    await openFinance(page, 'Deductions');
    const add = async ({ category, description, amount, year, date }) => {
      await page.getByRole('button', { name: '+ Add line item' }).click();
      const form = page.locator('div').filter({ hasText: /^New deduction line/ }).filter({ has: page.locator('select') }).last();
      await form.locator('select').selectOption(category);
      await form.getByPlaceholder('Description (e.g., Texas medical license app fee)').fill(description);
      if (date) await form.locator('input[type="date"]').fill(date);
      await form.getByPlaceholder('Amount (2499.00)').fill(amount);
      await form.getByPlaceholder('Year').fill(year);
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      await sleep(800);
    };
    await add({ category: 'Equipment (computer, capitalize or Section 179)', description: 'QA laptop for charting', amount: '2499.00', year: YEAR, date: `${YEAR}-09-15` });
    await add({ category: 'License application fee', description: 'QA Texas license application', amount: '400', year: YEAR, date: `${YEAR}-08-20` });
    await add({ category: 'Board certification / MOC', description: 'QA board MOC fee', amount: '350.00', year: String(Number(YEAR) - 1), date: `${Number(YEAR) - 1}-11-02` });
    await sleep(2000);
    const shown = await bodyText(page);
    await qa.shot('deductions ledger');
    qa.check('the saved message and the lines show', /QA Texas license application/.test(shown) || /QA board MOC fee/.test(shown), shown.match(/Line items[\s\S]{0,300}/)?.[0]);
    const lines = ledger();
    const synced = qa.check('each manual line reaches the cloud (deductibles rows)', lines.length === 3, { rows: lines.length, warnings: syncWarnings(qa.report, warnStart).slice(0, 3) });
    if (!synced) {
      qa.bug({
        title: 'Deductions: a manual line is never saved to the account (its id is not a uuid)',
        step: 'More > Finance > Deductions > + Add line item; Add; reload or open on another device',
        expected: 'A deductibles row for each line, as the ledger and the tax estimate read',
        actual: `No row reaches the database (${lines.length} of 3) and the console reports ${JSON.stringify(syncWarnings(qa.report, warnStart).slice(0, 1))}: DeductionMemo gives manual lines ids like "ded-<time>-<random>" (src/components/features/locum/DeductionMemo.jsx:26-28, used at line 100) and deductibles.id is a uuid column, so the insert is refused; the line lives only on this device`,
        severity: 'high',
      });
    }
    // Year filter.
    const yearSel = page.locator('select').filter({ has: page.locator(`option[value="${YEAR}"]`) }).first();
    await yearSel.selectOption(String(Number(YEAR) - 1));
    const prev = await bodyText(page);
    qa.check(`${Number(YEAR) - 1} shows only its line and its total ($350.00)`, /QA board MOC fee/.test(prev) && !/QA laptop for charting/.test(prev) && /Tax year \d{4} total\s*\$350\.00/.test(prev), prev.match(/Tax year[\s\S]{0,80}/)?.[0]);
    await yearSel.selectOption(YEAR);
    const cur = await bodyText(page);
    qa.check(`${YEAR} shows its two lines, $2,899.00`, /QA laptop for charting/.test(cur) && /QA Texas license application/.test(cur) && /Tax year \d{4} total\s*\$2,899\.00/.test(cur), cur.match(/Tax year[\s\S]{0,80}/)?.[0]);
    // CSV for the CPA.
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: 'Export CSV' }).click()]);
    const csv = readFileSync(await download.path(), 'utf8').replace(/^\uFEFF/, '');
    const parse = (line) => { const out = []; let f = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(f); f = ''; } else f += ch; } out.push(f); return out; };
    const table = csv.trim().split(/\r?\n/).map(parse);
    const head = table[0];
    const bad = table.slice(1).filter((r) => r.length !== head.length);
    const sum = table.slice(1).reduce((t, r) => t + (Number(r[head.indexOf('Amount')]) || 0), 0);
    qa.check('the CSV is named for the year', download.suggestedFilename() === `credentialdomd-deductions-${YEAR}.csv`, download.suggestedFilename());
    if (!qa.check('every CSV row has the header\'s five columns (a category with a comma stays one cell)', head.join() === 'Date,Category,Description,Amount,Source' && bad.length === 0, { head, bad })) {
      qa.bug({
        title: 'Deductions CSV: a category containing a comma splits into extra columns in the CPA\'s spreadsheet',
        step: 'More > Finance > Deductions: a line in "Equipment (computer, capitalize or Section 179)"; Export CSV; open it',
        expected: 'Five columns per row: Date, Category, Description, Amount, Source',
        actual: `The row reads ${JSON.stringify(bad[0])}: exportCSV quotes only the description (src/components/features/locum/DeductionMemo.jsx:118-123), so the category's comma shifts Description, Amount and Source one column right`,
        severity: 'medium',
      });
    }
    qa.check('the CSV\'s amounts add up to the year\'s ledger ($2,899.00)', Math.abs(sum - 2899) < 0.005 || bad.length > 0, sum);
    // The printed memo.
    await page.evaluate(() => { window.__qaPrinted = 0; window.print = () => { window.__qaPrinted += 1; }; });
    await page.getByRole('button', { name: 'Print', exact: true }).click();
    qa.check('Print opens the print dialog for the memo', (await page.evaluate(() => window.__qaPrinted)) === 1);
    // Remove a line.
    // The ✕ is named for its line (43341dc1).
    await page.getByRole('button', { name: 'Remove QA Texas license application', exact: true }).click();
    await sleep(1500);
    qa.check('removing asks "Remove this deduction line?"', qa.report.dialogs.some((x) => /Remove this deduction line\?/.test(x)));
    qa.check('the line leaves the ledger', !/QA Texas license application/.test(await bodyText(page)));
    await page.reload();
    await waitForMemberApp(page);
    await openFinance(page, 'Deductions');
    const reloaded = await bodyText(page);
    qa.check('after a reload the kept line is there and the removed one is not', /QA laptop for charting/.test(reloaded) && !/QA Texas license application/.test(reloaded), reloaded.match(/Line items[\s\S]{0,300}/)?.[0]);
  }, { soft: true });

  await qa.feature('PRAC-029', 'Import a card statement: agency on a row; the same file again; a patient-identifier CSV', async () => {
    await openFinance(page, 'Deductions');
    const before = ledger().filter((r) => r.source === 'card import').length;
    const statement = Buffer.from([
      'Transaction Date,Description,Amount',
      `09/02/${YEAR},QA SUITES HOTEL DENVER,-189.00`,
      `09/05/${YEAR},QA CODE HOSTING GITHUB,-12.00`,
      `09/07/${YEAR},QA PARKING GARAGE AURORA,-24.00`,
      `09/10/${YEAR},PAYMENT THANK YOU,450.00`,
    ].join('\n'));
    const importFile = async (name, buffer) => {
      await page.getByRole('button', { name: 'Import statement' }).click();
      const m = page.getByRole('dialog', { name: 'Import card statement' });
      await m.waitFor();
      await chooseFiles(page, m.getByRole('button', { name: /Choose statement file/ }), [{ name, mimeType: 'text/csv', buffer }]);
      await sleep(2500);
      return m;
    };
    let m = await importFile('qa-card-statement.csv', statement);
    let text = (await m.innerText()).replace(/\s+/g, ' ');
    await qa.shot('statement review');
    qa.check('three charges selected, the payment left out: 3 of 4, $225.00', /3 of 4 lines selected · \$225\.00/.test(text), text.slice(0, 200));
    // The row option and the done line name Practice > Expenses since 2dc41002.
    const BILL = 'Bill to agency instead (Practice > Expenses)';
    const hotel = m.locator('div').filter({ hasText: /^QA SUITES HOTEL DENVER/ }).filter({ has: page.getByText(BILL) }).last();
    await hotel.locator('label', { hasText: BILL }).locator('input').check();
    const agency = await hotel.getByPlaceholder('Agency name').inputValue();
    qa.check('billing to the agency fills the agency of the agreement in force that day', agency === 'QA Import Agency', agency);
    await m.getByRole('button', { name: /^Save 3 lines, \$225\.00$/ }).click();
    const done = await m.getByText(/Added 2 deduction lines to the ledger/).waitFor({ timeout: 10000 }).then(() => true, () => false);
    const doneText = (await m.innerText()).replace(/\s+/g, ' ');
    qa.check('the import says 2 deduction lines and 1 row to Practice > Expenses', done && /1 row was sent to Practice > Expenses/.test(doneText), doneText.match(/Added \d+ deduction[^]{0,240}/)?.[0]);
    await page.keyboard.press('Escape');
    const imported = await waitFor('the imported lines', async () => { const r = ledger().filter((x) => x.source === 'card import'); return r.length >= before + 2 ? r : null; }, { timeoutMs: 15000 }).catch(() => ledger().filter((x) => x.source === 'card import'));
    qa.check('deductibles rows with source "card import": the code hosting and the parking', imported.length === before + 2 && imported.some((x) => /GITHUB/.test(x.description) && Number(x.amount) === 12) && imported.some((x) => /PARKING/.test(x.description) && Number(x.amount) === 24), imported);
    const exp = rows(`select vendor, amount, agency, notes from public.travel_expenses where user_id = '${profile.id}'`);
    qa.check('the hotel became an expense (Practice > Expenses) billable to the agency, not a deduction', exp.length === 1 && Number(exp[0].amount) === 189 && exp[0].agency === 'QA Import Agency' && !imported.some((x) => /HOTEL/.test(x.description)), exp);

    // The same file again.
    m = await importFile('qa-card-statement.csv', statement);
    text = (await m.innerText()).replace(/\s+/g, ' ');
    await qa.shot('statement re-import');
    // The duplicate badge reads "already recorded" and covers a row recorded as a Work expense too
    // (StatementImport.jsx: "rows already recorded (as a deduction or a work expense) are flagged").
    const flagged = (text.match(/already recorded/gi) || []).length;
    qa.check('the three recorded rows (two deductions, the hotel as a Work expense) are flagged "already recorded"', flagged === 3, text.slice(0, 400));
    if (!qa.check('nothing is selected the second time (the hotel was already recorded as a Work expense)', /0 of 4 lines selected/.test(text), text.match(/\d+ of \d+ lines selected[^A-Z]*/)?.[0])) {
      qa.bug({
        title: 'Statement import: a row billed to the agency on an earlier import is ticked again on re-import',
        step: 'Finance > Deductions > Import statement: import a CSV, bill the hotel row to the agency, save; import the same file again',
        expected: 'Every row already recorded is flagged and unticked, so the same charge is not recorded twice',
        actual: `The review reads "${text.match(/\d+ of \d+ lines selected[^A-Z]*/)?.[0]}": the hotel row is ticked again. The duplicate check only looks at deductibles (src/components/features/locum/StatementImport.jsx:197), and a billed row was saved as a travel expense; saving would deduct a reimbursed $189.00`,
        severity: 'medium',
      });
    }
    await m.getByRole('button', { name: 'Back', exact: true }).click();
    await page.keyboard.press('Escape');

    // A file whose columns name patients.
    const patients = Buffer.from([
      'Patient Name,MRN,Date,Amount',
      `QA Patient Alpha,QA0001,09/03/${YEAR},-150.00`,
      `QA Patient Beta,QA0002,09/04/${YEAR},-275.00`,
    ].join('\n'));
    m = await importFile('qa-patient-list.csv', patients);
    text = (await m.innerText()).replace(/\s+/g, ' ');
    await qa.shot('patient csv');
    const reviewed = /lines selected/.test(text);
    if (!qa.check('a CSV with a patient-identifier header is refused, naming the column; no row is offered', !reviewed && /patient|identifier|MRN/i.test(text), text.slice(0, 300))) {
      qa.bug({
        title: 'Statement import reads a patient list: "Patient Name, MRN" rows become deduction lines named after patients',
        step: 'Finance > Deductions > Import statement: choose a CSV headed "Patient Name,MRN,Date,Amount"',
        expected: 'Refused before any row is read, naming the identifier column (the rule every other upload follows: spreadsheetGuard)',
        actual: `The review offers ${text.match(/\d+ of \d+ lines selected[^A-Z]*/)?.[0]} with each patient name as the merchant, ready to save to deductibles: CSV and Excel files skip the identifier guard (src/components/features/locum/StatementImport.jsx:236-243, "the spreadsheet guard ... does not run here") and parseGrid reads "Patient Name" as the description column (line 149)`,
        severity: 'high',
      });
      await m.getByRole('button', { name: 'Back', exact: true }).click().catch(() => {});
    }
    await page.keyboard.press('Escape');
    const after = ledger();
    qa.check('rows are created once, with their source recorded (select count(*) ... source is not null)', after.filter((x) => x.source === 'card import').length === before + 2 && !after.some((x) => /Patient/i.test(x.description)), after.map((x) => `${x.source}: ${x.description}`));

    // The CSV names the source.
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: 'Export CSV' }).click()]);
    const csv = readFileSync(await download.path(), 'utf8');
    const gitLine = csv.split(/\r?\n/).find((l) => /GITHUB/.test(l)) || '';
    if (!qa.check('the CSV\'s Source column says the line came from the card import', /card import/i.test(gitLine), gitLine)) {
      qa.bug({
        title: 'Deductions: lines imported from a card statement are listed and exported as "manual"',
        step: 'Finance > Deductions: import a card statement; Export CSV',
        expected: 'Source "card import" (what deductibles.source holds), so the CPA can tell typed lines from statement lines',
        actual: `The CSV line reads "${gitLine}": DeductionMemo relabels every ledger row as manual (src/components/features/locum/DeductionMemo.jsx:80, all = [...auto, ...manual.map(m => ({ ...m, source: "manual" }))])`,
        severity: 'low',
      });
    }
    // Tax Prep opens the same importer.
    await page.getByRole('button', { name: 'Tax Prep', exact: true }).click();
    await page.getByRole('button', { name: 'Upload card statement, import deductions' }).first().click();
    qa.check('Tax Prep\'s "Upload card statement, import deductions" opens the same importer', await page.getByRole('dialog', { name: 'Import card statement' }).isVisible());
    await page.keyboard.press('Escape');
  }, { soft: true });
});
