// P0 journey: Practice, the way a locum physician bills a facility. Add an
// agreement with an hourly rate, log past time, invoice the unbilled work,
// email the invoice to the facility's billing office (captured by the mock
// Resend, with the PDF attached and a copy to the physician), record the
// payment, then delete an invoice and see its entries return to unbilled.
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, emailBody, emails, goTab, newMember, row, rows, sleep, stamp, waitFor,
} from './support/lab.mjs';

const tab = (page, name) => page.getByRole('button', { name, exact: true }).first().click();

async function logPastTime(page, { type = 'Consult', minutes = 60, note }) {
  await tab(page, 'Work');
  await page.getByRole('button', { name: 'Log past time' }).click();
  const d = page.getByRole('dialog', { name: 'Log past time' });
  await d.getByRole('button', { name: type, exact: true }).click();
  await d.getByRole('button', { name: 'Yesterday' }).click();
  await d.getByPlaceholder('e.g. 60').fill(String(minutes));
  await d.getByPlaceholder('e.g. ED consult — head CT review').fill(note);
  await d.getByRole('button', { name: 'Log it' }).click();
  // A day outside the agreement's coverage blocks asks once.
  const yes = page.getByRole('button', { name: 'Yes, log it here' });
  if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.click();
  await d.waitFor({ state: 'detached', timeout: 15000 });
}

test('practice: agreement, logged time, invoice, email to billing, payment, delete returns entries', {
  tag: ['@PRAC-001', '@PRAC-009', '@PRAC-002', '@PRAC-004', '@PRAC-005', '@PRAC-006', '@PRAC-015'],
}, async ({ page, qa }) => {
  const { user, profile } = await newMember(page, { firstName: 'Logan', lastName: 'Locum' });
  const billing = `billing-${stamp().toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
  let contract;

  await qa.feature('PRAC-001', 'Add an agreement with billing terms', async () => {
    await goTab(page, 'Practice');
    await tab(page, 'Contracts');
    await page.getByRole('button', { name: 'Add Agreement' }).first().click();
    const d = page.getByRole('dialog', { name: 'Add Agreement' });
    await d.getByPlaceholder('e.g. Riverside Community Hospital').fill('QA Mercy Hospital');
    await d.getByPlaceholder('e.g. ANMG').fill('QAMH');
    await d.locator('select').first().selectOption({ label: 'CO, Colorado' });
    await d.getByPlaceholder('billing@hospital.org').fill(billing);
    await d.getByPlaceholder('250').fill('240');
    await d.getByRole('button', { name: 'Add', exact: true }).click();
    await d.waitFor({ state: 'detached', timeout: 15000 });
    contract = await waitFor('the contract row', async () => row(`select * from public.locum_contracts where user_id = '${profile.id}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('locum_contracts row with facility, rate, state and billing address', contract?.facility === 'QA Mercy Hospital' && Number(contract.hourly_rate) === 240 && contract.work_state === 'CO' && contract.bill_to === billing, contract ? `${contract.facility} $${contract.hourly_rate} ${contract.work_state} ${contract.bill_to}` : 'none');
    qa.check('the agreement is listed', /QA Mercy Hospital/.test(await page.locator('body').innerText()));
    await page.reload();
    await goTab(page, 'Practice');
    await tab(page, 'Contracts');
    qa.check('the agreement survives a reload', /QA Mercy Hospital/.test(await page.locator('body').innerText()));
  });

  await qa.feature('PRAC-009', 'Log past time (two entries)', async () => {
    await logPastTime(page, { minutes: 60, note: 'QA consult one' });
    await logPastTime(page, { type: 'Procedure', minutes: 50, note: 'QA procedure two' });
    await sleep(1500);
    const entries = rows(`select type, duration_min, billed_min, invoice_id from public.work_log where user_id = '${profile.id}' order by created_at`);
    qa.check('two work_log rows, not invoiced', entries.length === 2 && entries.every((e) => !e.invoice_id), entries);
    qa.check('50 minutes bill as 60 (15-minute increments round up)', entries[1]?.billed_min === 60, entries[1]);
    await qa.shot('work log');
  });

  let invoice;
  await qa.feature('PRAC-002', 'Invoice the unbilled work', async () => {
    const btn = page.getByRole('button', { name: /Invoice 2 unbilled entries \$480\.00/ });
    qa.check('"Invoice 2 unbilled entries $480.00" is offered', await btn.isVisible());
    await btn.click();
    await page.getByRole('button', { name: /^Invoice \d+ day/ }).click();
    const preview = page.getByRole('dialog', { name: 'Invoice preview' });
    await preview.waitFor();
    const text = await preview.innerText();
    qa.check('the preview totals $480.00', /TOTAL DUE\s+\$480\.00/.test(text), text.match(/TOTAL DUE[^\n]*\n?[^\n]*/)?.[0]);
    await preview.getByRole('button', { name: 'Send invoice…' }).click();
    await page.getByRole('button', { name: /PDF Polished invoice/ }).click();
    invoice = await waitFor('the invoice row', async () => row(`select * from public.invoices where user_id = '${profile.id}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('an invoices row for $480 covering both entries', !!invoice && Number(invoice.total_amount) === 480 && (invoice.entry_ids || []).length === 2, invoice ? `${invoice.number} $${invoice.total_amount}` : 'none');
    const billed = rows(`select invoice_id from public.work_log where user_id = '${profile.id}'`);
    qa.check('both entries now point at the invoice', billed.every((e) => e.invoice_id === invoice?.id));
  });

  await qa.feature('PRAC-004', 'Email the invoice to the billing office', async () => {
    await tab(page, 'Invoices');
    await page.getByRole('button', { name: 'Open invoice' }).first().click();
    await page.getByRole('button', { name: 'Send by email' }).click();
    const d = page.getByRole('dialog', { name: /Email invoice/ });
    await d.waitFor();
    // The preview fills in once the PDF is built.
    await d.getByText(`${invoice.number}.pdf`).first().waitFor({ timeout: 30000 }).catch(() => {});
    const preview = (await d.innerText()).replace(/\s+/g, ' ');
    const to = await d.getByRole('textbox').first().inputValue();
    qa.check('the To field is the agreement\'s billing address', to === billing, to);
    qa.check('the preview attaches the invoice PDF', new RegExp(`${invoice.number}\\.pdf`).test(preview));
    await d.getByRole('button', { name: new RegExp(`^Send to ${billing.replace(/[.]/g, '\\.')}`) }).click();
    const mail = await waitFor('the invoice email', async () => (await emails({ to: billing }))[0] || null, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => null);
    await qa.shot('invoice emailed');
    qa.check('one email to the billing office', !!mail, mail?.subject || 'none');
    if (mail) {
      const full = await emailBody(mail.id);
      qa.check('subject names the invoice and facility', full.subject.includes(invoice.number) && full.subject.includes('QA Mercy Hospital'), full.subject);
      qa.check('the PDF is attached', full.attachments.some((a) => a.filename === `${invoice.number}.pdf` && (a.content_type || '').includes('pdf') && a.size > 1000), JSON.stringify(full.attachments.map((a) => [a.filename, a.size])));
      qa.check('a copy goes to the physician', full.cc.includes(user.email) || full.bcc.includes(user.email), `cc ${full.cc} bcc ${full.bcc}`);
      qa.check('replies go to the physician', full.reply_to.includes(user.email), full.reply_to.join(','));
      qa.check('the body states the total due', /\$480\.00/.test(full.text || full.html || ''));
    }
    const send = row(`select status, attachment_count from public.invoice_email_sends where invoice_id = '${invoice.id}'`);
    qa.check('invoice_email_sends records the send', send?.status === 'sent' && send.attachment_count >= 1, send);
    const inv = row(`select last_emailed_to from public.invoices where id = '${invoice.id}'`);
    qa.check('the invoice remembers where it was emailed', inv?.last_emailed_to === billing, inv?.last_emailed_to);
  });

  await qa.feature('PRAC-005', 'Record a payment', async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await page.getByRole('button', { name: 'Record payment' }).first().click();
    const d = page.getByRole('dialog').last();
    await d.waitFor();
    await qa.shot('payment modal');
    const amount = d.locator('input[type="number"], input[inputmode="decimal"]').first();
    if (await amount.count()) await amount.fill('480');
    await d.getByRole('button', { name: /^(Record|Save|Record payment|Mark paid)/ }).last().click();
    await sleep(1500);
    const inv = row(`select paid_at, payments from public.invoices where id = '${invoice.id}'`);
    const payments = Array.isArray(inv?.payments) ? inv.payments : [];
    qa.check('the payment is stored and the invoice is paid', !!inv?.paid_at && payments.length >= 1, inv);
    await tab(page, 'Invoices');
    qa.check('the invoice list shows it paid', /paid/i.test(await page.getByRole('row').filter({ hasText: invoice.number }).first().innerText().catch(() => '')));
  });

  await qa.feature('PRAC-006', 'Delete an invoice: its entries return to unbilled', async () => {
    // A second invoice to delete.
    await logPastTime(page, { minutes: 30, note: 'QA consult three' });
    await page.getByRole('button', { name: /Invoice 1 unbilled entry/ }).click();
    await page.getByRole('button', { name: /^Invoice \d+ day/ }).click();
    await page.getByRole('dialog', { name: 'Invoice preview' }).getByRole('button', { name: 'Send invoice…' }).click();
    await page.getByRole('button', { name: /PDF Polished invoice/ }).click();
    const second = await waitFor('the second invoice', async () => row(`select * from public.invoices where user_id = '${profile.id}' and id <> '${invoice.id}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('a second invoice was created', !!second);
    await tab(page, 'Invoices');
    await page.getByRole('row').filter({ hasText: second.number }).getByRole('button', { name: 'Delete invoice' }).click();
    const confirm = page.getByRole('dialog').last();
    if (await confirm.getByRole('button', { name: /Delete/ }).count()) await confirm.getByRole('button', { name: /Delete/ }).last().click();
    await sleep(2000);
    qa.check('the invoice row is gone', !row(`select id from public.invoices where id = '${second.id}'`));
    const entry = row(`select invoice_id from public.work_log where user_id = '${profile.id}' and description = 'QA consult three'`);
    qa.check('its entry is unbilled again', entry && !entry.invoice_id, entry);
    const tomb = rows(`select collection from public.deleted_items where item_id = '${second.id}'`);
    qa.check('the deleted invoice is tombstoned', tomb.length === 1, tomb);
    await tab(page, 'Work');
    qa.check('Work offers to invoice the returned entry again', await page.getByRole('button', { name: /Invoice 1 unbilled entry/ }).isVisible());
  });

  await qa.feature('PRAC-015', 'Invoice list and summaries', async () => {
    await tab(page, 'Invoices');
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    await qa.shot('invoice summaries');
    qa.check('Total billed shows $480.00 with $480.00 paid', /Total billed \$480\.00 paid \$480\.00/i.test(text), text.match(/Total billed[^›]*/i)?.[0]);
    qa.check('Paid shows 1 invoice', /Paid \$480\.00 1 invoice/i.test(text), text.match(/Paid \$[\d.,]+ \d+ invoices?/i)?.[0]);
  });
});
