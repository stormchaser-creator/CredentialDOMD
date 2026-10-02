// Phone layouts, part 3: Documents and Practice on a phone (375 x 812 and
// 390 x 844, touch). A member uploads a license PDF from the + tab (the mock
// AI reads it), files it from the review card, opens the camera capture,
// and deletes a stored document; then adds an agreement, logs past time,
// invoices it (day picker, preview, format chooser), opens the invoice,
// emails it to the facility's billing office (captured by the mock Resend),
// records the payment, and checks Expenses and To do. A second phone signed
// in to the same account sees the invoice. Every screen and dialog gets the
// phone layout audit.
import { test } from './support/fixtures.mjs';
import {
  LAB_EMAIL_DOMAIN, base64Marker, emailBody, emails, row, rows, scriptAi, sleep, stamp, syntheticPdf, tombstones, waitFor,
} from './support/lab.mjs';
import {
  CHROME, PHONES, anyOf, auditDialog, auditScreen, closeDialog, exceptChrome, fileLayoutBugs, phoneTab, phoneUse, reloadPhone, secondPhone,
  signInPhone, smallByDesign, tapTarget,
  newPhoneMember,
} from './support/phone-helpers.mjs';

// Practice's sub-tab strip (LocumDashboard.jsx:53-72, seven 45 x 30 px buttons) was filed as a bug and
// verified not to be one (2026-09-30): see smallByDesign on Practice > Work. Its cut labels are PRAC-015.
const TABS_VERDICT = 'Verified not a bug (2026-09-30): the 32 px floor is these journeys\' own; WCAG 2.2 (2.5.8) asks for 24 px, which the 45 x 30 px sub-tabs meet with 4 px gutters. Each is a plain tab switch, so a missed tap opens the neighbouring tab and nothing is lost or sent. A polish item (minHeight 32), not a product bug; the cut "Invoi…" and "Cont…" labels are a real bug (PRAC-015).';

const BUGS = [
  {
    key: 'practice-tab-labels', feature: 'PRAC-015', kind: 'clipped', match: /^button "(Invoices|Contracts)" label cut to an ellipsis$/, severity: 'medium',
    title: 'Phone Practice: the "Invoices" and "Contracts" sub-tabs read "Invoi…" and "Cont…"',
    step: 'Practice on a phone',
    expected: 'Every sub-tab label readable (the strip already abbreviates "Sched." and "Exp." to fit)',
    actual: 'LocumDashboard.jsx:23-31 labels them "Invoices" and "Contracts" while the buttons (LocumDashboard.jsx:58-67: flex 1, min-width 0, white-space nowrap, text-overflow ellipsis) get 45 px each, so both are cut to an ellipsis. The physician has to guess which tab holds invoices and which holds agreements.',
  },
  {
    key: 'work-entry-icons', feature: 'PRAC-011', kind: 'small', match: /^button "(Edit entry|Delete entry)"$|^button \(no text; icon\)$/, only: 'Work with an entry', severity: 'low',
    title: 'Phone work log: each entry\'s edit and delete buttons are about 30 x 26 px, 8 px apart',
    step: 'Practice > Work on a phone with a logged entry',
    expected: 'Each at least 32 x 32 px',
    actual: 'WorkLog.jsx:1799-1807 styles them padding 5px 7px around a 14-16 px icon: 30 x 26 (edit) and 28 x 24 (delete).',
  },
  {
    key: 'contract-card', feature: 'PRAC-017', kind: 'small', match: /^button "(Archive|Unarchive|Edit|Delete agreement)"$|^button \(no text; icon\)$/, only: 'Contracts with an agreement', severity: 'low',
    title: 'Phone agreement card: edit, Archive and delete are 29 px tall',
    step: 'Practice > Contracts on a phone with an agreement',
    expected: 'Each at least 32 px tall',
    actual: 'Contracts.jsx:367-372 styles them padding 6px 8px / 6px 10px with a 16 px icon or 12 px text: 32 x 29, 67 x 29, 30 x 29.',
  },
  {
    key: 'day-picker', feature: 'PRAC-002', kind: 'small', match: /^button "(All days|None)"$/, severity: 'low',
    title: 'Phone invoice day picker: "All days" and "None" are 31 px tall',
    step: 'Practice > Work > Invoice N unbilled entries, on a phone',
    expected: 'Each at least 32 px tall',
    actual: 'InvoiceDayPicker.jsx:77-85 styles them padding 7px 12px, font 12: 31 px tall.',
  },
  {
    key: 'review-chips', feature: 'DOCS-002', kind: 'small', match: /^button "(License|CME|Hospital|Insurance|Health|Education|Contract|ID|Expense|Other)"$/, severity: 'low',
    title: 'Phone Smart Scan review card: the "Not right?" type chips are 22 px tall',
    step: 'Documents > Upload a license on a phone; the review card',
    expected: 'Each type chip at least 32 px tall (a wrong type is fixed by tapping one)',
    actual: 'ScanReviewCard.jsx:237-243 styles them padding 4px 10px, font 11: 22 px tall, 4 px apart.',
  },
  {
    key: 'doc-card', feature: 'DOCS-009', kind: 'small', match: /^button "(Select to send|File with AI|Delete [^"]+\.[A-Za-z0-9]+)"$|^button \(no text; icon\)$/, only: 'Documents with a stored document', severity: 'low',
    title: 'Phone Documents: a stored document\'s delete button (30 x 26), "File with AI" and "Select to send" (30 px) are under 32 px',
    step: 'Documents on a phone with a stored document',
    expected: 'Each at least 32 x 32 px',
    actual: 'DocumentsSection.jsx:577 (delete: padding 6px 8px around the trash icon), :585-590 ("File with AI": padding 7px 12px, font 13) and :766-772 ("Select to send": padding 6px 14px).',
  },
  {
    key: 'agreement-form', feature: 'PRAC-001', kind: 'small', only: 'Add Agreement', severity: 'low',
    match: /^button "(Use a document already uploaded|Hide documents in Files)"$|^input\[type=checkbox\]/,
    title: 'Phone Add Agreement form: "Use a document already uploaded" is a 16 px text link and the split-calls checkbox row 21 px',
    step: 'Practice > Contracts > Add Agreement, on a phone',
    expected: 'Each at least 32 px tall',
    actual: 'DocAttach.jsx:196-201 renders "Use a document already uploaded" with padding 0, font 13 (16 px tall; the same control sits under every record form\'s Upload / Camera); Contracts.jsx:299-302 wraps the "Split calls that cross the start of the call day" checkbox in a label with no padding, 21 px tall.',
  },
  {
    key: 'todo-row', feature: 'PRAC-020', kind: 'small', match: /^div\[role=button\]/, only: 'To do with a task', severity: 'low',
    title: 'Phone To do: a task\'s text, the tap-to-edit target, is a 20 px line',
    step: 'Practice > To do on a phone with a task',
    expected: 'The tap-to-edit target at least 32 px tall',
    actual: 'TaskNotes.jsx:118-126 makes the task text itself the edit button (role="button", no padding, font 14.5): one line is about 20 px tall.',
  },
];

/** A filed bug's pattern, to leave it out of another screen's sweep. */
const matchOf = (key) => BUGS.find((b) => b.key === key).match;

for (const width of [375, 390]) {
  const P = PHONES[width];
  test.describe(`phone ${P.name}`, () => {
    test.use(phoneUse(width));

    test(`documents and practice ${width}: upload, review, camera, agreement, time, invoice, email, payment`, {
      tag: ['@phone', '@DOCS-001', '@DOCS-002', '@DOCS-005', '@DOCS-009', '@PRAC-001', '@PRAC-009', '@PRAC-011', '@PRAC-002', '@PRAC-015', '@PRAC-004', '@PRAC-005', '@PRAC-017', '@PRAC-019', '@PRAC-020'],
    }, async ({ page, qa, browser }) => {
      test.setTimeout(15 * 60 * 1000);
      const file = (audit, screen = '') => fileLayoutBugs(qa, audit, BUGS.filter((b) => !b.only || [].concat(b.only).includes(screen)), P.name);
      // Controls owned by another screen's check (the top bar's Back, the Practice sub-tab strip, the
      // chips filed below) are left out of each screen's sweep; the strip's cut labels are checked on
      // Invoices (PRAC-015) and its size on Work (PRAC-009, by design).
      const known = anyOf(exceptChrome(), ...BUGS.filter((b) => b.kind === 'small' && !b.only).map((b) => b.match));
      // The same, less one filed bug: on the screen that owns it, its own check must still fail.
      const knownBut = (key) => anyOf(exceptChrome(), ...BUGS.filter((b) => b.kind === 'small' && !b.only && b.key !== key).map((b) => b.match));
      const tabsCut = CHROME.practiceTabs;
      const { user, profile } = await newPhoneMember(page, { firstName: 'Drew', lastName: `Docs ${width}` });
      const tag = `${Date.now()}`;
      const number = `QA-PHSCAN-${tag.slice(-5)}`;
      const sub = (name) => page.getByRole('button', { name, exact: true }).first();

      await qa.feature('DOCS-001', 'Documents on a phone: Upload from the + tab, the AI reads it', async () => {
        await phoneTab(page, '+');
        await sleep(500);
        const upload = page.getByRole('button', { name: 'Upload' }).first();
        file(await auditScreen(qa, page, 'Documents (empty)', { allowSmall: known, primary: [['Upload', upload], ['Camera', page.getByRole('button', { name: 'Camera', exact: true }).first()]] }));
        const pdf = syntheticPdf(`QA synthetic phone license ${tag}`);
        await scriptAi('gemini', { json: { documentType: 'license', confidence: 'high', extracted: {
          type: 'State Medical License', name: 'CO Medical License', licenseNumber: number, state: 'CO', issuedDate: '2024-06-01', expirationDate: '2028-05-31',
        } } }, base64Marker(pdf));
        const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), upload.tap()]);
        await chooser.setFiles([{ name: 'qa-phone-license.pdf', mimeType: 'application/pdf', buffer: pdf }]);
        const ready = await page.getByText(/1 document ready for review/).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
        qa.check('"1 document ready for review"', ready);
        const doc = await waitFor('the stored document', async () => row(`select id, storage_path from public.documents where user_id = '${profile.id}' and name = 'qa-phone-license.pdf'`), { timeoutMs: 30000 }).catch(() => null);
        qa.check('a documents row with its file in Storage', !!doc?.storage_path, doc?.storage_path);
      }, { soft: true });

      await qa.feature('DOCS-002', 'The review card on a phone: fields, type chips, Save', async () => {
        const save = page.getByRole('button', { name: 'Save to License' });
        file(await auditScreen(qa, page, 'Documents review card', {
          allowSmall: anyOf(knownBut('review-chips'), matchOf('doc-card')),
          // The card's other actions since b9e593af: keep the file unfiled, or delete it (asked).
          primary: [['Save to License', save], ['Keep as plain document', page.getByRole('button', { name: 'Keep as plain document', exact: true }).first()], ['Delete this file', page.getByRole('button', { name: 'Delete this file', exact: true }).first()]],
        }));
        const values = await page.getByRole('textbox').evaluateAll((els) => els.map((e) => e.value));
        qa.check('the review card shows the read license number', values.includes(number), values.filter(Boolean).slice(0, 5).join(' | '));
        await save.tap();
        const lic = await waitFor('the license row', async () => row(`select id, state, expiration_date from public.licenses where user_id = '${profile.id}' and license_number = '${number}'`), { timeoutMs: 30000 }).catch(() => null);
        qa.check('a license row with the scanned fields', lic?.state === 'CO' && lic.expiration_date === '2028-05-31', lic);
        await sleep(1500);
        file(await auditScreen(qa, page, 'Documents with a stored document', { allowSmall: anyOf(known, BUGS.find((b) => b.key === 'doc-card').match) }), 'Documents with a stored document');
      }, { soft: true });

      await qa.feature('DOCS-005', 'Camera on a phone opens the device camera (a capture file picker)', async () => {
        await phoneTab(page, '+');
        // Exact: a stored photo's delete button is named "Delete camera-<time>.jpg" (43341dc1).
        const camera = page.getByRole('button', { name: 'Camera', exact: true }).first();
        const chooser = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), camera.tap()]).then(([c]) => c, () => null);
        qa.check('a tap on Camera opens a file chooser (the phone\'s camera sheet)', !!chooser);
        if (chooser) {
          const attrs = await chooser.element().evaluate((e) => ({ accept: e.accept, capture: e.getAttribute('capture') }));
          qa.check('it asks for an image from the rear camera', attrs.accept === 'image/*' && attrs.capture === 'environment', JSON.stringify(attrs));
          await chooser.setFiles([]);
        }
        qa.check('no in-page camera overlay on a phone', !(await page.getByRole('dialog').count()));
      }, { soft: true });

      await qa.feature('DOCS-009', 'Delete a stored document from its phone card', async () => {
        // A second, unrelated document to delete (the license's file stays with the license).
        const other = syntheticPdf(`QA synthetic phone letter ${tag}`);
        await scriptAi('gemini', { json: { documentType: 'unknown' } }, base64Marker(other));
        const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), page.getByRole('button', { name: 'Upload' }).first().tap()]);
        await chooser.setFiles([{ name: 'qa-phone-letter.pdf', mimeType: 'application/pdf', buffer: other }]);
        const loose = await waitFor('the letter', async () => row(`select id, storage_path from public.documents where user_id = '${profile.id}' and name = 'qa-phone-letter.pdf'`), { timeoutMs: 45000 }).catch(() => null);
        qa.check('the letter is stored', !!loose);
        if (!loose) return;
        await reloadPhone(page);
        await phoneTab(page, '+');
        await sleep(1000);
        const card = page.locator('div').filter({ hasText: 'qa-phone-letter.pdf' }).filter({ has: page.getByRole('button', { name: /View PDF/ }) }).last();
        const trash = card.getByRole('button', { name: 'Delete qa-phone-letter.pdf', exact: true });
        file(await auditScreen(qa, page, 'Documents with a stored document', { allowSmall: known, primary: [['document delete', trash]] }), 'Documents with a stored document');
        const dialogs = qa.report.dialogs.length;
        await trash.tap();
        await sleep(2500);
        qa.check('a confirmation was asked', qa.report.dialogs.length > dialogs);
        qa.check('the documents row is gone and tombstoned', !row(`select id from public.documents where id = '${loose.id}'`) && tombstones(profile.id).some((t) => t.item_id === loose.id));
      }, { soft: true });

      const billing = `billing-${stamp('ph').toLowerCase()}@${LAB_EMAIL_DOMAIN}`;
      await qa.feature('PRAC-001', 'Add an agreement on a phone', async () => {
        await phoneTab(page, 'Practice');
        await sub('Contracts').tap();
        await sleep(500);
        const add = page.getByRole('button', { name: 'Add Agreement' }).first();
        file(await auditScreen(qa, page, 'Contracts (empty)', { allowClipped: tabsCut, allowSmall: known, primary: [['Add Agreement', add]] }));
        await add.tap();
        const d = page.getByRole('dialog', { name: 'Add Agreement' });
        await d.waitFor();
        const a = await auditDialog(qa, page, 'Add Agreement', d, {
          actions: [['Add', d.getByRole('button', { name: 'Add', exact: true })], ['Cancel', d.getByRole('button', { name: 'Cancel', exact: true })]],
        });
        file(a.audit, 'Add Agreement');
        await d.getByPlaceholder('e.g. Riverside Community Hospital').tap();
        await page.keyboard.type('QA Phone Mercy Hospital');
        await d.getByPlaceholder('e.g. ANMG').tap();
        await page.keyboard.type('QAPM');
        await d.locator('select').first().selectOption({ label: 'CO, Colorado' });
        await d.getByPlaceholder('billing@hospital.org').tap();
        await page.keyboard.type(billing);
        await d.getByPlaceholder('250').fill('240');
        await d.getByRole('button', { name: 'Add', exact: true }).tap();
        const closed = await d.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
        qa.check('the agreement saves from the phone', closed);
        const contract = await waitFor('the contract row', async () => row(`select facility, hourly_rate, bill_to from public.locum_contracts where user_id = '${profile.id}'`), { timeoutMs: 20000 }).catch(() => null);
        qa.check('locum_contracts row with the typed facility, rate and billing address', contract?.facility === 'QA Phone Mercy Hospital' && Number(contract.hourly_rate) === 240 && contract.bill_to === billing, contract);
      }, { soft: true });

      await qa.feature('PRAC-017', 'The agreement card on a phone', async () => {
        await sleep(800);
        file(await auditScreen(qa, page, 'Contracts with an agreement', { allowClipped: tabsCut, allowSmall: known }), 'Contracts with an agreement');
      }, { soft: true });

      await qa.feature('PRAC-009', 'Practice > Work and Log past time on a phone', async () => {
        await sub('Work').tap();
        await sleep(600);
        const log = page.getByRole('button', { name: 'Log past time' });
        const work = await auditScreen(qa, page, 'Practice Work', { allowSmall: exceptChrome(), allowClipped: tabsCut, primary: [['Log past time', log], ['start timer', page.getByRole('button', { name: /Got a call\? Start the timer/ })]] });
        file(work);
        smallByDesign(qa, work, { id: 'PRAC-009', match: CHROME.practiceTabs, what: 'the Practice sub-tab strip\'s seven buttons', why: TABS_VERDICT });
        await log.tap();
        const d = page.getByRole('dialog', { name: 'Log past time' });
        await d.waitFor();
        await auditDialog(qa, page, 'Log past time', d, { actions: [['Log it', d.getByRole('button', { name: 'Log it' })], ['Cancel', d.getByRole('button', { name: 'Cancel' })]] });
        await d.getByRole('button', { name: 'Consult', exact: true }).tap();
        await d.getByRole('button', { name: 'Yesterday' }).tap();
        await d.getByPlaceholder('e.g. 60').fill('60');
        await d.getByRole('textbox', { name: 'Billing note (optional)', exact: true }).tap();
        await page.keyboard.type('QA phone consult');
        await d.getByRole('button', { name: 'Log it' }).tap();
        const yes = page.getByRole('button', { name: 'Yes, log it here' });
        if (await yes.waitFor({ timeout: 3000 }).then(() => true, () => false)) await yes.tap();
        const closed = await d.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
        qa.check('the entry saves from the phone', closed);
        await sleep(1500);
        const entry = row(`select description, duration_min, invoice_id from public.work_log where user_id = '${profile.id}'`);
        qa.check('a work_log row with the typed billing note', entry?.description === 'QA phone consult' && entry.duration_min === 60 && !entry.invoice_id, entry);
      }, { soft: true });

      await qa.feature('PRAC-011', 'The logged entry on a phone', async () => {
        await reloadPhone(page);
        await phoneTab(page, 'Practice');
        await sleep(800);
        qa.check('the entry is listed after a reload', await page.getByText('QA phone consult').first().isVisible().catch(() => false));
        file(await auditScreen(qa, page, 'Work with an entry', { allowClipped: tabsCut, allowSmall: known }), 'Work with an entry');
      }, { soft: true });

      let invoice;
      await qa.feature('PRAC-002', 'Invoice the entry on a phone: day picker, preview, format chooser', async () => {
        const btn = page.getByRole('button', { name: /Invoice 1 unbilled entry/ });
        const t = await tapTarget(btn);
        qa.check('"Invoice 1 unbilled entry" can be reached', t.ok, `${t.size} ${t.why}`);
        await btn.tap();
        const picker = page.getByRole('dialog', { name: /Which days/ });
        await picker.waitFor();
        const p = await auditDialog(qa, page, 'invoice day picker', picker, { actions: [['Invoice 1 day', picker.getByRole('button', { name: /^Invoice \d+ day/ })]] });
        file(p.audit);
        await picker.getByRole('button', { name: /^Invoice \d+ day/ }).tap();
        const preview = page.getByRole('dialog', { name: 'Invoice preview' });
        await preview.waitFor();
        await auditDialog(qa, page, 'Invoice preview', preview, { actions: [['Send invoice…', preview.getByRole('button', { name: 'Send invoice…' })], ['Copy', preview.getByRole('button', { name: 'Copy' })]] });
        qa.check('the preview totals $240.00', /TOTAL DUE\s+\$240\.00/.test(await preview.innerText()));
        await preview.getByRole('button', { name: 'Send invoice…' }).tap();
        const formats = page.getByRole('dialog', { name: /Send invoice as/ });
        await formats.waitFor();
        await auditDialog(qa, page, 'invoice format chooser', formats, { actions: [['PDF', formats.getByRole('button', { name: /PDF Polished invoice/ })]] });
        await formats.getByRole('button', { name: /PDF Polished invoice/ }).tap();
        invoice = await waitFor('the invoice row', async () => row(`select * from public.invoices where user_id = '${profile.id}'`), { timeoutMs: 20000 }).catch(() => null);
        qa.check('an invoices row for $240', !!invoice && Number(invoice.total_amount) === 240, invoice ? `${invoice.number} $${invoice.total_amount}` : 'none');
      }, { soft: true });

      await qa.feature('PRAC-015', 'Invoices list on a phone; a second phone sees the invoice', async () => {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(400);
        await sub('Invoices').tap();
        await sleep(800);
        const card = page.getByText(/^INV-/).first();
        file(await auditScreen(qa, page, 'Invoices', {
          allowSmall: known,
          primary: [['Record payment', page.getByRole('button', { name: /Record payment/ }).first()], ['Resend', page.getByRole('button', { name: /Resend/ }).first()], ['invoice card', card]],
        }));
        const other = await secondPhone(browser, qa.report, width === 375 ? 390 : 375);
        try {
          await signInPhone(other.page, user);
          await phoneTab(other.page, 'Practice');
          await other.page.getByRole('button', { name: 'Invoices', exact: true }).first().tap();
          await sleep(1500);
          qa.check('the second phone lists the invoice', !!invoice && await other.page.getByText(new RegExp(invoice.number.slice(0, 12))).first().isVisible().catch(() => false));
        } finally { await other.context.close().catch(() => {}); }
      }, { soft: true });

      await qa.feature('PRAC-004', 'Open the invoice and email it from a phone', async () => {
        if (!invoice) { qa.check('an invoice exists', false); return; }
        await page.getByText(/^INV-/).first().tap();
        const detail = page.getByRole('dialog', { name: invoice.number });
        const opened = await detail.waitFor({ timeout: 10000 }).then(() => true, () => false);
        qa.check('a tap on the invoice card opens the invoice', opened);
        if (!opened) return;
        await auditDialog(qa, page, 'invoice detail', detail, { actions: [['Send by email', detail.getByRole('button', { name: 'Send by email' })], ['Share PDF', detail.getByRole('button', { name: 'Share PDF' })]] });
        await detail.getByRole('button', { name: 'Send by email' }).tap();
        const d = page.getByRole('dialog', { name: /Email invoice/ });
        await d.waitFor();
        await d.getByText(new RegExp(`Invoice ${invoice.number}\\b[^\\n]*\\.pdf`)).first().waitFor({ timeout: 30000 }).catch(() => {});
        const send = d.getByRole('button', { name: /^Send to / });
        await auditDialog(qa, page, 'Email invoice', d, { actions: [['Send to …', send]] });
        await send.tap();
        const mail = await waitFor('the invoice email', async () => (await emails({ to: billing }))[0] || null, { timeoutMs: 60000, intervalMs: 1000 }).catch(() => null);
        qa.check('one email to the billing office, captured by the mock Resend', !!mail, mail?.subject || 'none');
        if (mail) {
          const full = await emailBody(mail.id);
          qa.check('the invoice PDF is attached', full.attachments.some((x) => x.filename.startsWith(`Invoice ${invoice.number}`) && x.filename.endsWith('.pdf')), JSON.stringify(full.attachments.map((x) => x.filename)));
        }
        await page.keyboard.press('Escape').catch(() => {});
      }, { soft: true });

      await qa.feature('PRAC-005', 'Record the payment from a phone', async () => {
        if (!invoice) { qa.check('an invoice exists', false); return; }
        await sleep(500);
        for (let i = 0; i < 2 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /Record payment/ }).first().tap();
        const d = page.getByRole('dialog', { name: /^Payment on/ });
        await d.waitFor();
        const record = d.getByRole('button', { name: /^Record/ }).first();
        await auditDialog(qa, page, 'Payment', d, { actions: [['Record', record]] });
        await record.tap();
        await sleep(2000);
        const inv = row(`select paid_at, payments from public.invoices where id = '${invoice.id}'`);
        qa.check('the invoice is paid in the database', !!inv?.paid_at, inv);
        file(await auditScreen(qa, page, 'Invoices after payment', { allowClipped: tabsCut, allowSmall: known }));
      }, { soft: true });

      await qa.feature('PRAC-019', 'Expenses on a phone: the + Expense form fits', async () => {
        await sub('Exp.').tap();
        await sleep(500);
        const add = page.getByRole('button', { name: '+ Expense' });
        file(await auditScreen(qa, page, 'Expenses', { allowClipped: tabsCut, allowSmall: known, primary: [['+ Expense', add]] }));
        await add.tap();
        const d = page.getByRole('dialog').last();
        if (await d.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
          const a = await auditDialog(qa, page, 'Expense form', d);
          file(a.audit);
          await closeDialog(qa, 'Expense form', d);
        } else qa.check('+ Expense opens a form', false);
      }, { soft: true });

      await qa.feature('PRAC-020', 'To do on a phone: type a task and add it', async () => {
        await sub('To do').tap();
        await sleep(500);
        const box = page.getByPlaceholder('e.g. call back Dr. Nguyen about the ICU consult');
        await box.tap();
        await page.keyboard.type('QA phone task: review the synthetic chart');
        await page.getByRole('button', { name: 'Add', exact: true }).first().tap();
        await sleep(1500);
        const task = rows(`select id from public.task_notes where user_id = '${profile.id}'`);
        qa.check('the task is saved (task_notes row)', task.length === 1, `${task.length} row(s)`);
        file(await auditScreen(qa, page, 'To do with a task', { allowClipped: tabsCut, allowSmall: known }), 'To do with a task');
      }, { soft: true });
    });
  });
}
