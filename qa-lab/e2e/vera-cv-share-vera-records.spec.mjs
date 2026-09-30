// Vera changing records, only after the physician approves: a document handed
// to her filed as a record with its file (one card approved, one dismissed, an
// invalid one without Approve), records created and updated from typed facts
// (the right columns, not custom fields), a category for something with no
// section, a record opened on request, a document renamed and linked, and an
// Excel export of the last 12 months of case logs.
//
// Vera's model is the lab's mock AI: each question queues the answer a model
// following Vera's contract would give (reply + actions), matched on the
// question text, so what is tested is everything the app does with it.
import XLSX from 'xlsx';
import { test } from './support/fixtures.mjs';
import {
  base64Marker, chooseFiles, goTab, newMember, openCredentials, pendingOps, row, rows, scriptAi, sleep, syncWarnings, syntheticPdf,
  waitFor, waitForMemberApp,
} from './support/lab.mjs';
import {
  actionCard, addRecord, askVera, cardDone, day, openVera, runTag, syntheticDocx, waitForDocument,
} from './support/vera-cv-share-helpers.mjs';

test('Vera files a document, creates and updates records, opens one, renames a document, exports case logs', {
  tag: ['@VERA-002', '@VERA-004', '@VERA-005', '@VERA-011', '@VERA-007'],
}, async ({ page, qa }) => {
  test.setTimeout(9 * 60 * 1000);
  const { profile } = await newMember(page, { firstName: 'Vera', lastName: 'Recordkeeper' });
  const pid = profile.id;
  const tag = runTag();

  // ── VERA-002: a document handed to Vera ──────────────────────────────────
  await qa.feature('VERA-002', 'Attach a document; approve one card, dismiss another; an invalid card has no Approve', async () => {
    await openVera(page);
    const pdf = syntheticPdf(`QA synthetic TB screening result ${tag}`);
    await scriptAi('gemini', { json: {
      reply: `QA ${tag}: this is a TB screening result. I can file it under Health Records, or start a new category for it.`,
      actions: [
        { kind: 'create_record', section: 'healthRecords', summary: `QA TB screen ${tag}`,
          fields: { category: 'TB Test', type: 'QuantiFERON', name: `QA TB screen ${tag}`, dateAdministered: day(-10), result: 'Negative' },
          customFields: { 'Ordering clinic': 'QA Occupational Health' } },
        { kind: 'create_category', summary: `New category QA Screening Letters ${tag}`,
          category: { name: `QA Screening Letters ${tag}`, icon: '📄', description: 'Screening letters', fields: [{ label: 'Clinic', type: 'text' }] },
          records: [{ name: `QA screening letter ${tag}`, values: { Clinic: 'QA Occupational Health' } }] },
        { kind: 'create_record', section: 'caseLogs', summary: `QA case log from the letter ${tag}`, fields: { title: 'Should never be offered' } },
      ],
    } }, base64Marker(pdf));
    const answered = await askVera(page, `QA ${tag} please file this document`, null, {
      attach: { name: `qa-tb-screen-${tag}.pdf`, mimeType: 'application/pdf', buffer: pdf }, expectText: `QA ${tag}: this is a TB screening result`,
    });
    // askVera typed the question after attaching; the answer is waited for here.
    const shown = answered || await page.getByText(`QA ${tag}: this is a TB screening result`).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    await qa.shot('vera document cards');
    qa.check('Vera answers the attached document with proposal cards', shown);
    const health = actionCard(page, `QA TB screen ${tag}`);
    const category = actionCard(page, `New category QA Screening Letters ${tag}`);
    const invalidCard = page.locator('div').filter({ hasText: `QA case log from the letter ${tag}` }).filter({ hasText: /can't save to Case Logs/ }).last();
    qa.check('the invalid card (a section Vera cannot write) says why', await invalidCard.isVisible().catch(() => false));
    qa.check('the invalid card has no Approve button', (await invalidCard.getByRole('button', { name: 'Approve', exact: true }).count()) === 0);
    qa.check('nothing was written before approval', !row(`select id from public.health_records where user_id = '${pid}'`) && !row(`select id from public.custom_categories where user_id = '${pid}'`));

    const mark = qa.report.console.length;
    await health.approve.click();
    qa.check('the approved card turns done', await cardDone(page, 'New record → healthRecords'));
    await category.dismiss.click();
    await sleep(3000);
    const rec = await waitFor('the health record', async () => row(`select * from public.health_records where user_id = '${pid}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('the approved record is in health_records with its columns', rec?.name === `QA TB screen ${tag}` && rec?.result === 'Negative' && rec?.date_administered === day(-10), rec ? JSON.stringify({ name: rec.name, result: rec.result, date: rec.date_administered, custom: rec.custom_fields }) : 'none');
    qa.check('only the true extra went to custom_fields', JSON.stringify(rec?.custom_fields || {}) === JSON.stringify({ 'Ordering clinic': 'QA Occupational Health' }), JSON.stringify(rec?.custom_fields));
    const doc = rec ? await waitForDocument(pid, `qa-tb-screen-${tag}.pdf`, { linked: rec.id }) : null;
    qa.check('the attached file is stored and linked to the new record', !!doc, doc ? `${doc.linked_to} ${doc.storage_path}` : 'no linked documents row');
    qa.check('the dismissed category card created nothing', !row(`select id from public.custom_categories where user_id = '${pid}'`) && !row(`select id from public.custom_records where user_id = '${pid}'`));
    qa.check('the dismissed card is gone from the chat', !(await page.getByText(`New category QA Screening Letters ${tag}`).isVisible().catch(() => false)));
    qa.check('no sync warning and nothing queued', syncWarnings(qa.report, mark).length === 0 && (await pendingOps(page)).length === 0, syncWarnings(qa.report, mark).join(' | '));

    // The same with a Word document: Vera reads its text; the approved record keeps the file.
    const marker = `QA synthetic BLS card ${tag}`;
    const docx = await syntheticDocx(`${marker}. Basic Life Support provider. Expires ${day(600)}.`);
    await scriptAi('gemini', { json: {
      reply: `QA ${tag}: a BLS provider card. Here it is as a certification.`,
      actions: [{ kind: 'create_record', section: 'licenses', summary: `QA BLS card ${tag}`,
        fields: { type: 'BLS', name: `QA BLS card ${tag}`, licenseNumber: `BLS-${tag.slice(-5)}`, expirationDate: day(600) } }],
    } }, marker);
    await askVera(page, `QA ${tag} file this Word document too`, null, {
      attach: { name: `qa-bls-${tag}.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx },
      expectText: `QA ${tag}: a BLS provider card`,
    });
    await actionCard(page, `QA BLS card ${tag}`).approve.click();
    const bls = await waitFor('the BLS record', async () => row(`select id from public.licenses where user_id = '${pid}' and license_number = 'BLS-${tag.slice(-5)}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('a Word document: the approved record is created', !!bls);
    const wordDoc = bls ? await waitForDocument(pid, `qa-bls-${tag}.docx`, { linked: bls.id, timeoutMs: 15000 }) : null;
    qa.check('a Word document: the file is stored and linked to the record', !!wordDoc, wordDoc ? wordDoc.linked_to : JSON.stringify(rows(`select name, linked_to from public.documents where user_id = '${pid}'`)));
    if (bls && !wordDoc) {
      qa.bug({
        title: 'Vera: a Word (.docx) document handed to her is dropped when its record is approved (the record has no file)',
        step: 'More > Vera: attach a .docx certificate, send; Approve the proposed record',
        expected: 'The record is created and the .docx is stored in Documents, linked to it (as a PDF or photo is)',
        actual: 'The record exists but no documents row: the file is gone. The composer turns an Office file into its extracted text only (AssistantSection.jsx handleFile, ~line 540: { text, name, kind: "office" }), and send() keeps the source file only when the attachment has a dataUrl (~line 241), so saveSourceDoc has nothing to save. Fixed on fix/qa-docs-vera-intake and release/qa1 (a6448f6f)',
        severity: 'medium',
      });
    }
  }, { soft: true });

  // ── VERA-004: create and update records from typed facts ─────────────────
  let license;
  await qa.feature('VERA-004', 'Records created and updated through Vera land in their sections and columns', async () => {
    // Set up, as a physician would, a membership and a position to update.
    await addRecord(page, 'Professional Organizations', { Organization: `QA Society of Neurosurgeons ${tag}`, 'Membership Type': 'Member' });
    // Position Type is filled: the form lets it be blank, the database refuses that (a known
    // SYNC-002 bug, fixed on fix/qa-cloud-writes 074d3ff6), and this journey is about Vera.
    await addRecord(page, 'Work History', { 'Position Type': 'Full-Time Employed', 'Position/Title': `QA Attending ${tag}`, 'Employer/Organization': 'QA Mercy Hospital', 'Start Date': '2019-07-01', 'End Date': '2024-06-30' });
    const membership = row(`select * from public.professional_memberships where user_id = '${pid}'`);
    const job = row(`select * from public.work_history where user_id = '${pid}'`);
    qa.check('the membership and the position to update are saved', !!membership && !!job);
    await openVera(page);

    // 1. Add a license from typed facts.
    const number = `QA-OH-${tag.slice(-6)}`;
    await askVera(page, `QA ${tag} add my Ohio medical license ${number}, expires ${day(300)}, board contact is the QA desk`, {
      reply: `QA ${tag}: here is the Ohio license to add.`,
      actions: [{ kind: 'create_record', section: 'licenses', summary: `Add Ohio Medical License ${number}`,
        fields: { type: 'State Medical License', name: 'QA Ohio Medical License', licenseNumber: number, state: 'OH', expirationDate: day(300) },
        customFields: { 'Board contact': 'QA desk' } }],
    });
    await actionCard(page, `Add Ohio Medical License ${number}`).approve.click();
    license = await waitFor('the license', async () => row(`select * from public.licenses where user_id = '${pid}' and license_number = '${number}'`), { timeoutMs: 20000 }).catch(() => null);
    qa.check('1. the new license is in licenses with its columns', license?.state === 'OH' && license?.expiration_date === day(300) && license?.type === 'State Medical License', license ? `${license.state} ${license.expiration_date} ${license.type}` : 'none');
    qa.check('1. only the extra detail is in custom_fields', JSON.stringify(license?.custom_fields || {}) === JSON.stringify({ 'Board contact': 'QA desk' }), JSON.stringify(license?.custom_fields));

    // 2. Change its expiration.
    if (license) {
      await askVera(page, `QA ${tag} my Ohio license now expires ${day(700)}`, {
        reply: `QA ${tag}: updating the Ohio license expiration.`,
        actions: [{ kind: 'update_record', section: 'licenses', id: license.id, summary: `Ohio license expires ${day(700)}`, fields: { expirationDate: day(700) } }],
      });
      await actionCard(page, `Ohio license expires ${day(700)}`).approve.click();
      const updated = await waitFor('the new expiration', async () => { const l = row(`select expiration_date, custom_fields from public.licenses where id = '${license.id}'`); return l?.expiration_date === day(700) ? l : null; }, { timeoutMs: 20000 }).catch(() => null);
      qa.check('2. licenses.expiration_date changed', !!updated, JSON.stringify(row(`select expiration_date, custom_fields from public.licenses where id = '${license.id}'`)));
      qa.check('2. custom_fields unchanged', JSON.stringify(updated?.custom_fields || {}) === JSON.stringify({ 'Board contact': 'QA desk' }), JSON.stringify(updated?.custom_fields));
    }

    // 3. Membership dues and renewal date.
    if (membership) {
      await askVera(page, `QA ${tag} my society dues are 310 dollars and it renews ${day(120)}`, {
        reply: `QA ${tag}: updating the society dues and renewal date.`,
        actions: [{ kind: 'update_record', section: 'memberships', id: membership.id, summary: `Society dues 310, renews ${day(120)}`, fields: { cost: 310, expirationDate: day(120) } }],
      });
      await actionCard(page, `Society dues 310, renews ${day(120)}`).approve.click();
      await sleep(3000);
      const m = row(`select cost, expiration_date, custom_fields from public.professional_memberships where id = '${membership.id}'`);
      const ok = Number(m?.cost) === 310 && m?.expiration_date === day(120);
      qa.check('3. professional_memberships.cost and expiration_date hold the new values', ok, JSON.stringify(m));
      qa.check('3. nothing went to custom_fields', !m?.custom_fields || Object.keys(m.custom_fields).length === 0, JSON.stringify(m?.custom_fields));
      if (!ok) {
        await qa.shot('membership update in custom fields');
        qa.bug({
          title: 'Vera: an approved membership dues / renewal update is saved as custom fields, not in the dues and renewal columns',
          step: 'Credentials > Professional Organizations: add a membership; ask Vera to set its dues and renewal date; Approve',
          expected: 'professional_memberships.cost = 310 and expiration_date = the new date (the form\'s Annual Dues and Renewal Due, used by the CV and the dues deduction)',
          actual: `cost ${m?.cost ?? 'null'}, expiration_date ${m?.expiration_date ?? 'null'}, custom_fields ${JSON.stringify(m?.custom_fields)}. splitFields (src/utils/assistant.js:~660) keeps only SECTION_FIELDS keys, and SECTION_FIELDS.memberships (src/utils/sectionFields.js:18) lists neither cost nor expirationDate, so both become custom fields while the form keeps the old values. Fixed on fix/qa-docs-vera-intake and release/qa1 (57e76533, 8c2158ec)`,
          severity: 'medium',
        });
      }
    }

    // 4. Work history reason for leaving.
    if (job) {
      await askVera(page, `QA ${tag} I left the QA Mercy job to relocate for family`, {
        reply: `QA ${tag}: updating the reason for leaving.`,
        actions: [{ kind: 'update_record', section: 'workHistory', id: job.id, summary: 'Reason for leaving: relocated for family', fields: { reasonForLeaving: 'Relocated for family' } }],
      });
      await actionCard(page, 'Reason for leaving: relocated for family').approve.click();
      await sleep(3000);
      const w = row(`select reason_for_leaving, custom_fields from public.work_history where id = '${job.id}'`);
      const ok = w?.reason_for_leaving === 'Relocated for family';
      qa.check('4. work_history.reason_for_leaving holds it', ok, JSON.stringify(w));
      if (!ok) {
        qa.bug({
          title: 'Vera: an approved work-history "reason for leaving" is saved as a custom field, not in the Reason for Leaving column',
          step: 'Credentials > Work History: add a position; ask Vera to record why you left; Approve',
          expected: 'work_history.reason_for_leaving = "Relocated for family" (the form field and what applications ask for)',
          actual: `reason_for_leaving ${w?.reason_for_leaving ?? 'null'}, custom_fields ${JSON.stringify(w?.custom_fields)}. SECTION_FIELDS.workHistory (src/utils/sectionFields.js:15) has no reasonForLeaving, so splitFields files it under custom fields and the Work History form still shows the field empty. Fixed on fix/qa-docs-vera-intake and release/qa1 (57e76533)`,
          severity: 'medium',
        });
      }
    }

    // 5. Something with no section: a category, with the record in it.
    await askVera(page, `QA ${tag} I have a hospital parking permit P-${tag.slice(-4)} valid until ${day(200)}`, {
      reply: `QA ${tag}: there is no section for parking permits, so here is a new category with it filed.`,
      actions: [{ kind: 'create_category', summary: `New category QA Parking Permits ${tag}, with this permit`,
        category: { name: `QA Parking Permits ${tag}`, icon: '🅿️', description: 'Hospital parking permits', fields: [{ label: 'Lot', type: 'text' }] },
        records: [{ name: `QA permit P-${tag.slice(-4)}`, number: `P-${tag.slice(-4)}`, expirationDate: day(200), values: { Lot: 'QA Garage B' } }] }],
    });
    await actionCard(page, `New category QA Parking Permits ${tag}`).approve.click();
    const cat = await waitFor('the category', async () => row(`select * from public.custom_categories where user_id = '${pid}' and name = 'QA Parking Permits ${tag}'`), { timeoutMs: 20000 }).catch(() => null);
    const recs = cat ? rows(`select id, name, number, expiration_date, category_id from public.custom_records where user_id = '${pid}' and category_id = '${cat.id}'`) : [];
    qa.check('5. custom_categories row created', !!cat);
    qa.check('5. the permit is a custom_records row in it with its number and expiry', recs.length === 1 && recs[0].number === `P-${tag.slice(-4)}` && recs[0].expiration_date === day(200), JSON.stringify(recs));
    await page.reload();
    await waitForMemberApp(page);
    await openCredentials(page, `QA Parking Permits ${tag}`);
    qa.check('5. the category and its record survive a reload', (await page.locator('body').innerText()).includes(`QA permit P-${tag.slice(-4)}`));
    qa.check('no queued writes', (await pendingOps(page)).length === 0, JSON.stringify(await pendingOps(page)).slice(0, 300));
  }, { soft: true });

  // ── VERA-005: take me to a record ─────────────────────────────────────────
  await qa.feature('VERA-005', 'Vera opens a record', async () => {
    if (!license) throw new Error('no license from VERA-004 to open');
    await openVera(page);
    await askVera(page, `QA ${tag} take me to my Ohio license`, {
      reply: `QA ${tag}: opening your Ohio license.`,
      actions: [{ kind: 'open_record', section: 'licenses', id: license.id, summary: 'Open Ohio Medical License' }],
    }, { expectText: 'Ohio' });
    const detail = page.getByRole('dialog').filter({ hasText: license.license_number }).first();
    const opened = await detail.waitFor({ timeout: 15000 }).then(() => true, () => false);
    await qa.shot('vera opened the license');
    const heading = await page.getByRole('heading', { name: /Licenses/ }).first().isVisible().catch(() => false);
    qa.check('the app is on Credentials > Licenses', heading || /Licenses/.test(await page.locator('main, body').first().innerText()));
    qa.check('the license\'s detail opens at once', opened, (await page.locator('body').innerText()).slice(0, 300));
    await page.keyboard.press('Escape').catch(() => {});
    await openVera(page);
    await sleep(1000);
    await qa.shot('vera chat after the navigation');
    const chat = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const replyKept = chat.includes(`QA ${tag}: opening your Ohio license.`);
    const notSent = /take me to my Ohio license Not sent/.test(chat) || (await page.getByRole('button', { name: 'Try again' }).count()) > 0;
    qa.check('back in Vera, the reply and a done Navigation card are in the chat', replyKept && /Opened Licenses/.test(chat), chat.slice(-400));
    qa.check('the question is not shown as "Not sent"', !notSent, chat.slice(-400));
    if (!replyKept || notSent) {
      qa.bug({
        title: 'Vera: after "take me to my license" opens the record, the chat loses Vera\'s reply and shows the question as "Not sent" with Try again',
        step: 'More > Vera: "take me to my Ohio license" (Vera opens it); then go back to More > Vera',
        expected: 'The reply and a done "Navigation · Opened Licenses" card under the question',
        actual: `No reply and no card; the question is marked "Not sent" with a Try again button (${notSent ? 'seen' : 'reply missing'}). AssistantSection.jsx send() calls navigate() for open_record (~line 229) before setMsgs() adds the reply (~line 245); navigating unmounts the Vera screen, so the reply is dropped, and on the next mount the trailing user message with no reply is marked failed (~line 50). Try again would ask the model a second time`,
        severity: 'low',
      });
    }
  }, { soft: true });

  // ── VERA-011: rename and link a document ──────────────────────────────────
  await qa.feature('VERA-011', 'Vera renames an unlinked document and links it to a license', async () => {
    if (!license) throw new Error('no license from VERA-004');
    const loose = syntheticPdf(`QA synthetic loose scan ${tag}`);
    await scriptAi('gemini', { json: { documentType: 'unknown' } }, base64Marker(loose));
    await goTab(page, 'Documents');
    await chooseFiles(page, page.getByRole('button', { name: 'Upload' }).first(), [{ name: `IMG_${tag}.pdf`, mimeType: 'application/pdf', buffer: loose }]);
    const doc = await waitForDocument(pid, `IMG_${tag}.pdf`, { timeoutMs: 45000 });
    qa.check('the loose document is stored unlinked', !!doc && !doc.linked_to, doc ? `linked_to ${doc.linked_to}` : 'none');
    if (!doc) return;
    await openVera(page);
    await askVera(page, `QA ${tag} the file IMG_${tag}.pdf is my Ohio license copy, please file it`, {
      reply: `QA ${tag}: renaming it and attaching it to the Ohio license.`,
      actions: [{ kind: 'update_document', id: doc.id, summary: 'Rename to Ohio license copy and attach it', name: `QA Ohio license copy ${tag}.pdf`, linkedTo: `licenses:${license.id}` }],
    });
    await actionCard(page, 'Rename to Ohio license copy and attach it').approve.click();
    const after = await waitFor('the renamed document', async () => { const d = row(`select name, linked_to, type from public.documents where id = '${doc.id}'`); return d?.name === `QA Ohio license copy ${tag}.pdf` ? d : null; }, { timeoutMs: 20000 }).catch(() => null);
    qa.check('documents.name is the new name', !!after, JSON.stringify(row(`select name, linked_to from public.documents where id = '${doc.id}'`)));
    qa.check('documents.linked_to is the license', (after?.linked_to || '').includes(license.id), after?.linked_to);
    await page.reload();
    await waitForMemberApp(page);
    await goTab(page, 'Documents');
    qa.check('Documents shows the new name after a reload', (await page.locator('body').innerText()).includes(`QA Ohio license copy ${tag}.pdf`));
  }, { soft: true });

  // ── VERA-007: export the last 12 months of case logs ─────────────────────
  await qa.feature('VERA-007', 'Vera exports the last 12 months of case logs as Excel', async () => {
    for (const [title, date] of [[`QA recent craniotomy ${tag}`, day(-30)], [`QA old laminectomy ${tag}`, day(-500)]]) {
      await openCredentials(page, 'Case Logs');
      const d = page.getByRole('dialog').last();
      for (let attempt = 0; attempt < 3 && !(await d.isVisible().catch(() => false)); attempt++) {
        if (!(await page.getByRole('dialog').count())) await page.getByRole('button', { name: /^(\+ )?Add$/ }).first().click();
        await d.waitFor({ timeout: 10000 }).catch(() => {});
      }
      // Category is filled for the same reason as Position Type above (case_logs.category is NOT NULL).
      await d.locator('label', { hasText: 'Category' }).first().locator('xpath=..').locator('select').first().selectOption({ index: 1 });
      await d.locator('label', { hasText: 'Description' }).first().locator('xpath=..').locator('input, textarea').first().fill(title);
      await d.locator('label', { hasText: /^Date/ }).first().locator('xpath=..').locator('input').first().fill(date);
      await d.getByRole('button', { name: /^(Add|Save)$/ }).last().click();
      await d.waitFor({ state: 'detached', timeout: 20000 });
      await sleep(1500);
    }
    const cases = rows(`select title, date from public.case_logs where user_id = '${pid}'`);
    qa.check('two case logs on file, one older than 12 months', cases.length === 2, JSON.stringify(cases));
    await openVera(page);
    await askVera(page, `QA ${tag} export my last 12 months of case logs to Excel`, {
      reply: `QA ${tag}: here is the export of your case logs from the last 12 months.`,
      actions: [{ kind: 'export_data', summary: 'Excel of the last 12 months of case logs', section: 'caseLogs', format: 'xlsx', dateFrom: day(-365), dateTo: day(0) }],
    });
    // This desk browser has no file share sheet, so the app downloads the file.
    await page.evaluate(() => { Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }); });
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
      actionCard(page, 'Excel of the last 12 months of case logs').approve.click(),
    ]);
    qa.check('approving downloads a spreadsheet', !!dl, dl ? dl.suggestedFilename() : 'no download');
    if (!dl) return;
    qa.check('the file is an .xlsx named for the section and range', /^Case-log-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    const wb = XLSX.readFile(await dl.path());
    const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    qa.check('it holds only the case from the last 12 months', sheetRows.length === 1 && sheetRows[0].Description === `QA recent craniotomy ${tag}`, JSON.stringify(sheetRows));
    const header = (await page.getByText(/Excel of the last 12 months of case logs/).last().locator('xpath=preceding-sibling::div[1]').innerText().catch(() => '')).trim();
    qa.check('the card turns done', /✓ done/i.test(header), header);
    qa.check('the card is labelled as an export, not as a new record', !/New record/i.test(header), header);
    if (/New record/i.test(header)) {
      qa.bug({
        title: 'Vera: the export card is headed "New record → caseLogs"',
        step: 'Ask Vera for an Excel of the last 12 months of case logs',
        expected: 'A card headed as an export (like "Navigation", "Send packet", "Feedback for the developer")',
        actual: `"${header}". AssistantSection.jsx (the card header chain, ~line 640) has no export_data case, so it falls through to \`New record → ${'${a.section}'}\`: the physician is told a record will be created`,
        severity: 'low',
      });
    }
  }, { soft: true });
});
