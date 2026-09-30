// Invoice numbers, the way they reach a billing office: a work invoice, a
// day-rate invoice and two expense invoices sent on one day; an invoice
// deleted and the next one sent; and the same physician invoicing from two
// browsers at once (neither reloaded). The billing office keys on the number,
// so no two may match and a number that went out may not come back.
import { test } from './support/fixtures.mjs';
import { field, goTab, landing, newMember, row, rows, signIn, sleep, waitFor, waitForMemberApp } from './support/lab.mjs';
import { addAgreement, appOrigin, installShareStandIn, localDay, loggingAgainst, logPastTime, subTab, utcDay } from './support/practice-helpers.mjs';

const listDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

test('practice invoice numbers: work, day-rate and expense invoices on one day; a deleted number; two browsers at once', {
  tag: ['@PRAC-030'],
}, async ({ page, qa, context, secondBrowser }) => {
  const { user, profile } = await newMember(page, { firstName: 'Nia', lastName: 'Numbers' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin() });
  await goTab(page, 'Practice');
  await addAgreement(page, { facility: 'QA Numbers Clinic', workState: 'CO', hourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15 });
  await addAgreement(page, { facility: 'QA Numbers Group', dayRate: 1800 });
  const cs = await waitFor('two agreements', async () => { const r = rows(`select id, facility, pay_model from public.locum_contracts where user_id = '${profile.id}'`); return r.length === 2 ? r : null; }, { timeoutMs: 20000 });
  const clinic = cs.find((c) => c.facility === 'QA Numbers Clinic');
  const group = cs.find((c) => c.facility === 'QA Numbers Group');
  const invoices = () => rows(`select id, number, kind, total_amount, created_at from public.invoices where user_id = '${profile.id}' order by created_at`);
  const newest = async (label, count) => waitFor(label, async () => { const r = invoices(); return r.length >= count ? r[r.length - 1] : null; }, { timeoutMs: 20000 }).catch(() => null);

  const workInvoice = async (p, { dayKey } = {}) => {
    await p.getByRole('button', { name: /^Invoice \d+ unbilled entr/ }).click();
    if (dayKey) {
      await p.getByRole('button', { name: 'None', exact: true }).click();
      await p.getByRole('button').filter({ hasText: listDay(dayKey) }).first().click();
    }
    await p.getByRole('button', { name: /^Invoice 1 day/ }).click();
    const preview = p.getByRole('dialog', { name: 'Invoice preview' });
    await preview.waitFor();
    return { preview, number: (/(?:INV|EXP)-\d{8}-\d{2}/.exec(await preview.innerText()) || [])[0] };
  };
  const expenseInvoice = async (amount, vendor) => {
    await page.getByRole('button', { name: '+ Expense' }).click();
    const d = page.getByRole('dialog', { name: 'New expense' });
    await d.getByRole('spinbutton', { name: '$ amount' }).fill(amount);
    await d.getByRole('button', { name: 'Airfare', exact: true }).click();
    await d.getByPlaceholder('Vendor (e.g. United, Marriott, Hertz)').fill(vendor);
    await d.getByRole('textbox', { name: 'Bill to agency', exact: true }).fill('QA Numbers Agency');
    await d.getByRole('button', { name: 'Add expense' }).click();
    await d.waitFor({ state: 'detached', timeout: 20000 });
    await installShareStandIn(page);
    await page.getByRole('button', { name: /^Invoice 1 expense/ }).click();
    const inv = page.getByRole('dialog', { name: 'Invoice expenses' });
    await inv.waitFor();
    await inv.getByRole('button', { name: 'Create & send with receipts' }).click();
    await inv.waitFor({ state: 'detached', timeout: 20000 });
  };

  await qa.feature('PRAC-030', 'Invoice numbers stay unique across invoice kinds, deletes and devices', async () => {
    // 1. A work invoice.
    await subTab(page, 'Work');
    await loggingAgainst(page).selectOption(clinic.id);
    await logPastTime(page, { type: 'Consult', day: localDay(-3), start: '09:00', end: '10:00', note: 'QA numbers consult one' });
    let w = await workInvoice(page);
    await w.preview.getByRole('button', { name: 'Copy', exact: true }).click();
    const n1 = await newest('the work invoice', 1);
    // 2. A day-rate invoice.
    await sleep(1600);
    await loggingAgainst(page).selectOption(group.id);
    await page.getByRole('button', { name: '+ Log a day' }).click();
    const dd = page.getByRole('dialog', { name: 'Log a day' });
    await field(dd, 'Date').fill(localDay(-3));
    await dd.getByRole('button', { name: 'Save', exact: true }).click();
    const yes = page.getByRole('button', { name: 'Yes, log it here' });
    if (await yes.waitFor({ timeout: 2000 }).then(() => true, () => false)) await yes.click();
    await dd.waitFor({ state: 'detached', timeout: 15000 });
    await page.getByRole('button', { name: /Invoice 1 unbilled day/ }).click();
    await page.getByRole('button', { name: /^Invoice 1 day/ }).click();
    const dp = page.getByRole('dialog', { name: 'Invoice preview' });
    await dp.getByRole('button', { name: 'Copy text & mark sent' }).click();
    const n2 = await newest('the day-rate invoice', 2);
    // 3 and 4. Two expense invoices.
    await subTab(page, 'Exp.');
    await expenseInvoice('45.00', 'QA Air One');
    const n3 = await newest('the first expense invoice', 3);
    await expenseInvoice('30.00', 'QA Air Two');
    const n4 = await newest('the second expense invoice', 4);
    const four = [n1, n2, n3, n4].map((x) => x?.number);
    await qa.shot('four invoices');
    qa.check('four invoices were recorded: work, day-rate and two expense', [n1, n2, n3, n4].every(Boolean) && n3?.kind === 'expenses' && n4?.kind === 'expenses', four);
    const dup1 = new Set(four).size !== four.length;
    if (!qa.check('the four numbers are all different', !dup1, four)) {
      qa.bug({
        title: 'Two expense invoices sent on the same day get the same number',
        step: 'Practice > Exp.: invoice one expense to the agency, then another the same day (with a work and a day-rate invoice already sent that day)',
        expected: 'Each invoice gets its own number',
        actual: `Numbers issued: ${four.join(', ')}. Expenses.jsx:223 takes nextInvoiceNumber(invoices) and renames INV- to EXP- after it checked uniqueness among INV numbers only (src/utils/helpers.js:514-523 counts INV-<day> invoices), so every expense invoice that day is EXP-<day>-<INV count + 1>`,
        severity: 'medium',
      });
    }
    const stamp = (n) => (/-(\d{8})-/.exec(n || '') || [])[1];
    const localStamp = localDay(0).replaceAll('-', '');
    if (!qa.check('the date in each number is the physician\'s day', four.every((n) => stamp(n) === localStamp), `${four.join(', ')}; local day ${localDay(0)}, UTC ${utcDay()}`)) {
      qa.bug({
        title: 'Invoice numbers carry the UTC date: an invoice sent at 7 PM Pacific is numbered with tomorrow\'s date',
        step: 'Practice: send any invoice after 5 PM Pacific (4 PM in summer)',
        expected: `INV-${localStamp}-NN, the physician's own date (as the invoice's Issued line reads)`,
        actual: `${four[0]}: nextInvoiceNumber (src/utils/helpers.js:515) takes the date from new Date().toISOString(), the UTC day`,
        severity: 'low',
      });
    }

    // 5. Delete the middle one; send another.
    await goTab(page, 'Practice');
    await subTab(page, 'Invoices');
    await page.getByRole('row').filter({ hasText: n2.number }).getByRole('button', { name: 'Delete invoice' }).click();
    const confirm = page.getByRole('dialog').last();
    if (await confirm.getByRole('button', { name: /Delete/ }).count()) await confirm.getByRole('button', { name: /Delete/ }).last().click();
    await waitFor('the deleted invoice', async () => (!row(`select id from public.invoices where id = '${n2.id}'`) ? true : null), { timeoutMs: 15000 }).catch(() => null);
    await subTab(page, 'Work');
    await loggingAgainst(page).selectOption(clinic.id);
    await logPastTime(page, { type: 'Consult', day: localDay(-2), start: '09:00', end: '10:00', note: 'QA numbers consult two' });
    w = await workInvoice(page);
    await w.preview.getByRole('button', { name: 'Copy', exact: true }).click();
    const n5 = await newest('the next invoice', 4);
    const issued = [...four, n5?.number];
    if (!qa.check('the next invoice does not reuse the deleted invoice\'s number', n5?.number && n5.number !== n2.number && !four.includes(n5.number), `deleted ${n2.number}; next ${n5?.number}`)) {
      qa.bug({
        title: 'A deleted invoice\'s number is issued again to the next invoice',
        step: 'Practice: send a work invoice, a day-rate invoice and an expense invoice on one day; delete the day-rate one in Invoices; send another work invoice',
        expected: 'A new number; the billing office already holds the deleted one',
        actual: `The deleted invoice was ${n2.number} and the next one is ${n5?.number}: nextInvoiceNumber (src/utils/helpers.js:516) starts from the count of that day's INV invoices on the device, so a deleted INV (or the EXP invoices, which it does not count) makes it land on a number already sent`,
        severity: 'medium',
      });
    }

    // 6. Two browsers, neither reloaded, invoicing at the same time.
    await logPastTime(page, { type: 'Consult', day: localDay(-1), start: '09:00', end: '10:00', note: 'QA numbers consult on A' });
    const { page: b, context: ctxB } = await secondBrowser();
    await ctxB.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin() });
    await signIn(b, user);
    await landing(b);
    await waitForMemberApp(b);
    await goTab(b, 'Practice');
    await subTab(b, 'Work');
    await loggingAgainst(b).selectOption(clinic.id);
    await logPastTime(b, { type: 'Consult', day: localDay(-6), start: '09:00', end: '10:00', note: 'QA numbers consult on B' });
    const pb = await workInvoice(b, { dayKey: localDay(-6) });
    const pa = await workInvoice(page);
    await pa.preview.getByRole('button', { name: 'Copy', exact: true }).click();
    await pb.preview.getByRole('button', { name: 'Copy', exact: true }).click();
    await sleep(3000);
    const all = invoices();
    const counts = rows(`select number, count(*)::int as n from public.invoices where user_id = '${profile.id}' group by 1 having count(*) > 1`);
    await qa.shot('two browsers invoiced');
    qa.check('both browsers recorded their invoice', all.length === 6, all.map((x) => x.number));
    if (!qa.check('no two invoices share a number (select number, count(*) ... having count(*) > 1 is empty)', counts.length === 0, { previews: { a: pa.number, b: pb.number }, duplicates: counts })) {
      qa.bug({
        title: 'Two devices invoicing at the same time issue the same invoice number',
        step: 'Sign in on two browsers; on each, invoice a different day\'s work (neither reloaded after the other\'s invoice)',
        expected: 'Two different numbers',
        actual: `Both invoices are ${counts.map((c) => `${c.number} (x${c.n})`).join(', ')}: the number is worked out on each device from its own copy of the invoices (nextInvoiceNumber, src/utils/helpers.js:514, called at WorkLog.jsx:937 when the preview is built); nothing on the server makes it unique`,
        severity: 'medium',
      });
    }
    qa.check('every number issued is recorded once, the deleted one aside', issued.every(Boolean), issued);
  }, { soft: true });
});
