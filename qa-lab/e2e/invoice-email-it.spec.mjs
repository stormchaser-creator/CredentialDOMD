// Practice: "Email it for me" from the invoice preview on Days & call, Work log and Expenses
// (release/goal2 8bcb1c49, 71a103c0, e726714e), on a phone (390 x 844, touch, an iPhone user
// agent; WebKit as the installed app with -c qa-lab/e2e/webkit.config.mjs).
//
// The owner's report: an invoice sent from the iPhone through the share sheet did not show as
// sent, and what went out was badly formatted. "Email it for me" sends the invoice from the
// server (send-invoice-email) instead, so the outcome is known and the letter keeps its
// paragraphs. Each journey seeds one screen's unbilled items (SYNTHETIC values only, an
// agreement whose invoice email is a reserved qa.credentialdomd.test address), builds the
// invoice, taps "Email it for me", sends it and checks, from the mock Resend capture and the
// lab database:
//   * exactly one email to the billing address, its subject naming the invoice number, a text
//     part with paragraphs and an HTML part, a copy and replies to the physician;
//   * the attachment named "Invoice <number> from <physician>.pdf" (a PDF, not empty); on
//     Expenses the receipt goes out by what it is ("<category>, <vendor>, <physician>.png"),
//     not the camera's "image.png";
//   * the invoice recorded once, as emailed, with every previewed item on it and the item left
//     out still unbilled; one confirmed row in invoice_email_sends; the Emailed stamp on the row
//     (20261002040000);
//   * the screen showing the items billed with no "Did it go out?" and no "not recorded", and
//     a reload sending nothing again and keeping one invoice.
import { randomUUID } from 'node:crypto';
import { test } from './support/fixtures.mjs';
import {
  chooseFiles, emailBody, emails, lab, labExec, lit, row, rows, sleep, syntheticPng, waitFor, waitForMemberApp,
} from './support/lab.mjs';
import { localDay, subTab } from './support/practice-helpers.mjs';
import { newPhoneMember, phoneTab, phoneUse } from './support/phone-helpers.mjs';
import { iosModelInitScript } from './support/ios.mjs';

const TZ = 'America/Chicago';
const addDays = (day, n) => new Date(Date.UTC(...day.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0))) + n * 864e5).toISOString().slice(0, 10);
const INV_NUMBER = /(?:INV|EXP)-\d{8}-\d+(?:-[A-Z0-9]{3})?/;

/** The UTC ISO moment of wall-clock `hhmm` on local day `day` in America/Chicago. */
function chicago(day, hhmm) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess - (shown - guess)).toISOString();
}

/** A day-rate agreement billed to `billing`: 12 past worked days (4 with primary call), 1 two days ahead. */
function seedDays(pid, tag, billing) {
  const contractId = randomUUID();
  const hospital = 'QA Synthetic Valley Hospital (QSV)';
  const cover = JSON.stringify([{ start: localDay(-40), end: localDay(20) }]);
  const grid = JSON.stringify([{ hospital, primary: 1200, backup: 600 }]);
  labExec(`insert into public.locum_contracts (id, user_id, facility, short_name, agency, bill_to, start_date, end_date, pay_model, day_rate, call_rate_grid, work_state, coverage_periods)
    values (${lit(contractId)}, ${lit(pid)}, ${lit(`QA Synthetic Valley Group ${tag}`)}, 'QSVG', 'QA Synthetic Staffing', ${lit(billing)}, ${lit(localDay(-40))}, ${lit(localDay(20))}, 'daily', 1850, ${lit(grid)}::jsonb, 'CO', ${lit(cover)}::jsonb);`);
  const billed = [];
  const values = [];
  for (let i = 0; i < 12; i++) {
    const id = randomUUID();
    billed.push(id);
    const calls = i % 3 === 0 ? JSON.stringify([{ hospital, role: 'primary' }]) : '[]';
    values.push(`(${lit(id)}, ${lit(pid)}, ${lit(contractId)}, ${lit(localDay(-30 + 2 * i))}, true, ${lit(calls)}::jsonb, ${i % 3 === 0 ? 3050 : 1850}, ${lit(`QA synthetic day ${i + 1}`)}, true)`);
  }
  const later = randomUUID();
  values.push(`(${lit(later)}, ${lit(pid)}, ${lit(contractId)}, ${lit(localDay(2))}, true, '[]'::jsonb, 1850, 'QA synthetic later day', true)`);
  labExec(`insert into public.duty_days (id, user_id, contract_id, date, worked_day, call_periods, amount, notes, placement_ok) values ${values.join(',\n')};`);
  return { contractId, billed, left: [later], table: 'duty_days', total: 12 * 1850 + 4 * 1200 };
}

/** An hourly agreement billed to `billing` with six procedure entries over three past days (2 h each at $200). */
function seedWork(pid, tag, billing) {
  const start = localDay(-14);
  const contractId = randomUUID();
  const coverage = [{ tz: TZ, start, end: addDays(start, 30), startTime: '07:00', endTime: '19:00' }];
  labExec(`insert into public.locum_contracts (id, user_id, facility, agency, bill_to, start_date, end_date, pay_model, hourly_rate, call_hourly_rate, increment_minutes, min_call_minutes, day_start_hour, split_at_day_start, work_state, coverage_periods)
    values (${lit(contractId)}, ${lit(pid)}, ${lit(`QA Synthetic Ridge Hospital ${tag}`)}, 'QA Synthetic Staffing', ${lit(billing)}, ${lit(start)}, ${lit(addDays(start, 30))}, 'hourly', 200, 0, 15, 15, 7, false, 'CO', ${lit(JSON.stringify(coverage))}::jsonb);`);
  const billed = [];
  const values = [];
  for (let d = 0; d < 3; d++) {
    for (const hhmm of ['08:00', '13:00']) {
      const id = randomUUID();
      billed.push(id);
      const day = addDays(start, d);
      const startAt = chicago(day, hhmm);
      const endAt = new Date(Date.parse(startAt) + 120 * 60000).toISOString();
      values.push(`(${lit(id)}, ${lit(pid)}, ${lit(contractId)}, 'Procedure', ${lit(day)}, ${lit(day)}, ${lit(startAt)}, ${lit(endAt)}, 120, 120, ${lit(`QA synthetic procedure ${billed.length}`)}, ${lit(new Date(Date.parse(endAt) + 60000).toISOString())})`);
    }
  }
  labExec(`insert into public.work_log (id, user_id, contract_id, type, date, call_day, start_time, end_time, duration_min, billed_min, description, created_at) values ${values.join(',\n')};`);
  return { contractId, billed, left: [], table: 'work_log', total: 6 * 2 * 200 };
}

/** Four expenses to one agency (the invoice; the agency's agreement holds `billing`), one to another agency (left out). */
function seedExpenses(pid, tag, billing) {
  const agency = `QA Synthetic Staffing ${tag}`;
  labExec(`insert into public.locum_contracts (id, user_id, facility, agency, bill_to, start_date, end_date, pay_model, day_rate, work_state)
    values (${lit(randomUUID())}, ${lit(pid)}, ${lit(`QA Synthetic Lake Clinic ${tag}`)}, ${lit(agency)}, ${lit(billing)}, ${lit(localDay(-40))}, ${lit(localDay(20))}, 'daily', 1500, 'CO');`);
  const shape = [['Flight', 'QA Synthetic Air', 412.6, -12], ['Hotel', 'QA Synthetic Inn', 689.25, -10], ['Rental car', 'QA Synthetic Cars', 301.4, -9], ['Meals', 'QA Synthetic Diner', 58.75, -8]];
  const billed = [];
  const values = shape.map(([category, vendor, amount, day]) => {
    const id = randomUUID();
    billed.push(id);
    return `(${lit(id)}, ${lit(pid)}, ${lit(localDay(day))}, ${lit(category)}, ${lit(vendor)}, ${amount}, ${lit(agency)}, ${lit(`QA synthetic ${category.toLowerCase()}`)})`;
  });
  const other = randomUUID();
  values.push(`(${lit(other)}, ${lit(pid)}, ${lit(localDay(-20))}, 'Parking', 'QA Synthetic Garage', 24.5, ${lit(`QA Synthetic Other Agency ${tag}`)}, 'QA synthetic parking')`);
  labExec(`insert into public.travel_expenses (id, user_id, date, category, vendor, amount, agency, notes) values ${values.join(',\n')};`);
  return { contractId: null, billed, left: [other], table: 'travel_expenses', agency, total: 412.6 + 689.25 + 301.4 + 58.75 };
}

/** Reads the invoice number shown in a preview, waiting for the reservation to finish. */
async function previewNumber(sheet) {
  await sheet.getByText('Reserving the invoice number…').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
  return ((await sheet.innerText()).match(INV_NUMBER) || [null])[0];
}

const SCREENS = [
  {
    key: 'days', label: 'Days & call', seed: seedDays, what: 'days',
    async open(page) {
      await phoneTab(page, 'Practice');
      await subTab(page, 'Work');
      await page.getByRole('heading', { name: 'Days & call' }).waitFor({ timeout: 30000 });
    },
    cta: (page) => page.getByRole('button', { name: /Invoice \d+ unbilled days?/ }),
    async build(page, qa) {
      await this.cta(page).first().waitFor({ timeout: 60000 });
      await this.cta(page).first().tap();
      const picker = page.getByRole('dialog', { name: 'Which days go on this invoice?' });
      await picker.waitFor();
      const build = picker.getByRole('button', { name: /^Invoice \d+ days?/ });
      const label = (await build.innerText()).replace(/\s+/g, ' ');
      qa.check('the day picker checks the 12 past days (the later one left out)', /^Invoice 12 days: \$[\d,]+\.\d\d$/.test(label), label);
      await build.tap();
      const sheet = page.getByRole('dialog', { name: 'Invoice preview' });
      await sheet.waitFor();
      return { sheet, number: await previewNumber(sheet) };
    },
  },
  {
    key: 'work', label: 'Work log', seed: seedWork, what: 'entries',
    async open(page) {
      await phoneTab(page, 'Practice');
      await subTab(page, 'Work');
    },
    cta: (page) => page.getByRole('button', { name: /Invoice \d+ unbilled entr/ }),
    async build(page, qa) {
      const cta = page.getByRole('button', { name: /Invoice 6 unbilled entries/ });
      await cta.waitFor({ timeout: 60000 });
      await cta.tap();
      const picker = page.getByRole('dialog', { name: 'Which days go on this invoice?' });
      await picker.waitFor();
      const build = picker.getByRole('button', { name: /^Invoice \d+ days?/ });
      const label = (await build.innerText()).replace(/\s+/g, ' ');
      qa.check('the day picker offers the three days', /^Invoice 3 days: \$[\d,]+\.\d\d$/.test(label), label);
      await build.tap();
      const sheet = page.getByRole('dialog', { name: 'Invoice preview' });
      await sheet.waitFor();
      return { sheet, number: await previewNumber(sheet) };
    },
  },
  {
    key: 'expenses', label: 'Expenses', seed: seedExpenses, what: 'expenses',
    async open(page) {
      await phoneTab(page, 'Practice');
      await subTab(page, 'Exp.');
      await page.getByText('Travel expenses', { exact: true }).waitFor({ timeout: 30000 });
    },
    cta: (page) => page.getByRole('button', { name: /^Invoice \d+ expenses?:/ }),
    // A fifth expense to the same agency, logged on the phone with a camera receipt named
    // "image.png" (what an iPhone photo arrives as).
    async prepare(page, qa, seed, pid) {
      await page.getByRole('button', { name: '+ Expense' }).first().click();
      const d = page.getByRole('dialog', { name: 'New expense' });
      await d.waitFor();
      await d.getByRole('spinbutton', { name: '$ amount' }).fill('75.00');
      await d.getByRole('button', { name: 'Hotel', exact: true }).click();
      await d.getByPlaceholder('Vendor (e.g. United, Marriott, Hertz)').fill('QA Synthetic Lodge');
      await d.getByRole('textbox', { name: 'Bill to agency', exact: true }).fill(seed.agency);
      await chooseFiles(page, d.getByRole('button', { name: 'Upload' }), [{ name: 'image.png', mimeType: 'image/png', buffer: syntheticPng() }]);
      await sleep(1500);
      await d.getByRole('button', { name: 'Add expense' }).click();
      await d.waitFor({ state: 'detached', timeout: 20000 });
      const added = await waitFor('the fifth expense and its receipt on the server', async () => {
        const e = row(`select id from public.travel_expenses where user_id = ${lit(pid)} and vendor = 'QA Synthetic Lodge'`);
        const doc = e && row(`select id, name, storage_path from public.documents where user_id = ${lit(pid)} and linked_to like ${lit(`%${e.id}%`)}`);
        return e && doc?.storage_path ? { e, doc } : null;
      }, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => null);
      qa.check('lab setup: the expense and its receipt (image.png) are stored', !!added, added);
      if (added) { seed.billed.push(added.e.id); seed.total += 75; seed.receipt = added.doc; }
    },
    async build(page, qa, { pid, seed }) {
      const cta = this.cta(page).first();
      await cta.waitFor({ timeout: 60000 });
      await cta.tap();
      const sheet = page.getByRole('dialog', { name: 'Invoice expenses' });
      await sheet.waitFor();
      await sheet.getByRole('button', { name: 'Create & send with receipts' }).waitFor({ timeout: 60000 });
      const text = (await sheet.innerText()).replace(/\s+/g, ' ');
      const total = Number(((text.match(/Total \$([\d,]+\.\d\d)/) || [0, '0'])[1]).replace(/,/g, ''));
      qa.check('the sheet checks the five expenses to the agency', Math.abs(total - seed.total) < 0.005, `Total ${total}, expected ${seed.total}`);
      await sleep(1500);
      const number = row(`select number from public.invoice_number_reservations where user_id = ${lit(pid)} and number like 'EXP-%' order by reserved_at desc limit 1`)?.number || null;
      return { sheet, number };
    },
  },
];

test.describe('Email it for me from the invoice preview (phone 390x844)', () => {
  test.use(phoneUse(390));
  test.beforeEach(async ({ context }) => { await context.addInitScript(iosModelInitScript); });

  for (const screen of SCREENS) {
    test(`${screen.label}: Email it for me sends one formatted email with the named PDF and records the invoice once as emailed`, {
      tag: ['@PRAC-004', '@PRAC-002', '@phone'],
    }, async ({ page, qa }) => {
      test.setTimeout(10 * 60 * 1000);
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const billing = `billing-${screen.key}-${tag.toLowerCase()}@qa.credentialdomd.test`;
      const { user, profile } = await newPhoneMember(page, { firstName: 'Emmy', lastName: `Mailer ${screen.key}` });
      const pid = profile.id;
      const seed = screen.seed(pid, tag, billing);
      const reopen = async () => {
        await page.goto(lab().urls.app, { waitUntil: 'domcontentloaded' });
        await waitForMemberApp(page);
        await screen.open(page);
      };
      await reopen();
      if (screen.prepare) await screen.prepare(page, qa, seed, pid);
      let number = null;
      let mail = null;

      await qa.feature('PRAC-004', `${screen.label}: Email it for me (${screen.key})`, async () => {
        const built = await screen.build(page, qa, { pid, seed });
        number = built.number;
        qa.check('the preview holds a reserved invoice number', !!number, number);
        const emailIt = built.sheet.getByRole('button', { name: 'Email it for me' });
        await emailIt.waitFor({ timeout: 30000 });
        await waitFor('Email it for me enabled', async () => (await emailIt.isEnabled()) || null, { timeoutMs: 60000, intervalMs: 500 });
        await qa.shot(`${screen.key} preview with Email it for me`);
        await emailIt.tap();
        const d = page.getByRole('dialog', { name: /^Email invoice/ });
        await d.waitFor({ timeout: 30000 });
        const send = d.getByRole('button', { name: `Send to ${billing}` });
        await send.waitFor({ timeout: 60000 }).catch(() => {});
        const to = await d.getByRole('textbox').first().inputValue().catch(() => '');
        qa.check('To is the agreement\'s invoice email', to === billing, to);
        const dtext = (await d.innerText()).replace(/\s+/g, ' ');
        qa.check('the screen says it is recorded as emailed once sent', /goes on the Invoices tab as emailed/.test(dtext), dtext.slice(0, 300));
        qa.check('the preview lists the PDF as "Invoice <number> from <physician>.pdf"', new RegExp(`Invoice ${number} from Emmy [^.]*\\.pdf`).test(dtext), (dtext.match(/Attachments.{0,240}/) || [''])[0]);
        if (screen.key === 'expenses') {
          qa.check('the preview lists the receipt by what it is, not image.png', /Lodge[^]*\.png/.test(dtext) && !/\bimage\.png\b/.test(dtext), (dtext.match(/Attachments.{0,300}/) || [''])[0]);
        }
        await qa.shot(`${screen.key} email preview`);
        await waitFor('Send enabled', async () => (await send.isEnabled().catch(() => false)) || null, { timeoutMs: 60000, intervalMs: 500 });
        const sentFrom = new Date(Date.now() - 1000).toISOString();
        await send.tap();
        mail = await waitFor('the invoice email in the mock Resend', async () => (await emails({ to: billing, since: sentFrom }))[0] || null, { timeoutMs: 90000, intervalMs: 1000 }).catch(() => null);
        qa.check('the email went to the billing address', !!mail, mail?.subject || 'none');
        await d.waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
        await qa.shot(`${screen.key} after Email it`);
        if (mail) {
          const full = await emailBody(mail.id);
          const text = full.text || '';
          const html = full.html || '';
          qa.check('subject names the invoice number', full.subject.includes(number), full.subject);
          qa.check('the text part keeps paragraphs (blank lines between them)', (text.match(/\n\s*\n/g) || []).length >= 2, JSON.stringify(text.slice(0, 400)));
          qa.check('the HTML part is paragraphs, not one run', (html.match(/<p[\s>]/g) || []).length >= 2, html.slice(0, 300));
          qa.check('no em dash in the letter', !/—/.test(text) && !/—|&mdash;/.test(html));
          qa.check('a copy goes to the physician', full.cc.includes(user.email) || full.bcc.includes(user.email), `cc ${full.cc} bcc ${full.bcc}`);
          qa.check('replies go to the physician', full.reply_to.includes(user.email), full.reply_to.join(','));
          const pdf = full.attachments[0] || {};
          qa.check('the PDF is "Invoice <number> from <physician>.pdf"', new RegExp(`^Invoice ${number} from Emmy [^/\\\\]*[^.]\\.pdf$`).test(pdf.filename || '') && !/Physician/.test(pdf.filename || ''), pdf.filename);
          qa.check('the PDF is a PDF and not empty', /pdf/.test(pdf.content_type || '') && pdf.size > 1000, `${pdf.content_type} ${pdf.size}`);
          if (screen.key === 'expenses') {
            const rec = full.attachments.slice(1);
            qa.check('the receipt goes out by what it is ("<category>, <vendor>, <physician>.png"), not image.png', rec.length === 1 && /Lodge/.test(rec[0].filename || '') && /Emmy/.test(rec[0].filename || '') && /\.png$/.test(rec[0].filename || '') && rec[0].size > 0,
              JSON.stringify(rec.map((a) => [a.filename, a.size])));
          } else {
            qa.check('only the invoice PDF is attached', full.attachments.length === 1, full.attachments.map((a) => a.filename));
          }
        }
      });

      await qa.feature('PRAC-002', `${screen.label}: the emailed invoice is recorded once (${screen.key})`, async () => {
        const inv = await waitFor('the invoice row', async () => {
          const r = row(`select id, number, method, sent_at, total_amount, last_emailed_to, last_emailed_at from public.invoices where user_id = ${lit(pid)} and number = ${lit(number)}`);
          if (!r) return null;
          const items = rows(`select id, invoice_id from public.${seed.table} where user_id = ${lit(pid)}`);
          return seed.billed.every((id) => items.find((x) => x.id === id)?.invoice_id === r.id) ? { ...r, items } : null;
        }, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => null);
        qa.check('the invoice is recorded under the previewed number', !!inv, number);
        if (!inv) return;
        qa.check('recorded as emailed', inv.method === 'emailed', inv.method);
        qa.check(`the total is the previewed ${seed.total.toFixed(2)}`, Math.abs(Number(inv.total_amount) - seed.total) < 0.005, inv.total_amount);
        qa.check(`every previewed ${screen.what} item carries the invoice, the one left out does not`, seed.left.every((id) => !inv.items.find((x) => x.id === id)?.invoice_id), inv.items.filter((x) => seed.left.includes(x.id)));
        const stamped = await waitFor('the Emailed stamp', async () => {
          const r = row(`select last_emailed_to, last_emailed_at from public.invoices where id = ${lit(inv.id)}`);
          return r?.last_emailed_to ? r : null;
        }, { timeoutMs: 20000, intervalMs: 1000 }).catch(() => null);
        qa.check('the row has its Emailed stamp to the billing address', stamped?.last_emailed_to === billing, stamped);
        const sends = rows(`select status, recipient, attachment_count from public.invoice_email_sends where user_id = ${lit(pid)} and invoice_id = ${lit(inv.id)}`);
        qa.check('one confirmed send in the ledger', sends.length === 1 && sends[0].status === 'sent', sends);

        const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
        qa.check('no "Did it go out?" and no "not recorded" on the screen', !text.includes(`Did ${number} go out?`) && !/is not recorded/.test(text), text.match(/.{0,80}(go out\?|not recorded).{0,80}/)?.[0] || 'none');
        qa.check('no native alert or question during the send', !qa.report.dialogs.length, qa.report.dialogs);

        await reopen();
        await sleep(10000);
        const after = rows(`select id from public.invoices where user_id = ${lit(pid)} and number = ${lit(number)}`);
        const mails = await emails({ to: billing });
        qa.check('after a reload: still one invoice under the number and one email sent', after.length === 1 && mails.length === 1, `${after.length} invoices, ${mails.length} emails`);
        const text2 = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
        qa.check('after a reload: no "Did it go out?" and no "not recorded"', !text2.includes(`Did ${number} go out?`) && !/is not recorded/.test(text2));
        const cta = (await screen.cta(page).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
        const expectCta = screen.key === 'days' ? /Invoice 1 unbilled day\b/ : screen.key === 'expenses' ? /^Invoice 1 expense:/ : /^$/;
        qa.check('after a reload: only the item left out is still to invoice', expectCta.test(cta), cta || 'no invoice button');
        await qa.shot(`${screen.key} after reload`);
      });
    });
  }
});
